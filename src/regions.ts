import type { Message, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { scanTextForBlockRanges } from './blocks.js'
import { parseShakeConfig, type ShakeConfig } from './config.js'
import { checksumShakeText, formatShakeRef, SHAKE_CONTROL_KIND, SHAKE_EXCERPT_KIND, type ShakeRegion } from './state.js'

export interface ShakePlannerServices {
  sessionQuery: Pick<SessionQueryEngine, 'readSurface' | 'traceEvent' | 'readEvent'>
  tokenMeter: Pick<TokenMeter, 'measure' | 'estimateMessage'>
}
export interface ShakePlanOptions {
  operationId: string
  requestSeq: number
  policy?: ShakeConfig
}
export interface ShakePlan {
  cutoffSeq: number | null
  regions: ShakeRegion[]
  protectedEventSeqs: number[]
  savedTokens: number
}
export interface IndexedShakeRegion { region: ShakeRegion; regionIndex: number }
export interface RenderedShakeMessage { message: Message; savedTokens: number }
export const SHAKE_EXCERPT_PREFIX = '[Historical assistant excerpt; removed text is available through shake_read.]\n'

function textLength(message: Message): number {
  let length = 0
  for (const block of message.content) if (block.type === 'text') length += Array.from(block.text).length
  return length
}
function owned(event: SessionEvent): boolean {
  const source = event.type === 'user/message' ? event.data.source
    : event.type === 'developer/message' ? event.data.message.source : null
  if (source) return source.kind === SHAKE_CONTROL_KIND || source.kind === SHAKE_EXCERPT_KIND
  return false
}
function textTokens(message: Message, text: string, meter: Pick<TokenMeter, 'estimateMessage'>): number {
  const base = { ...message, content: [{ type: 'text' as const, text: '' }] } as Message
  return meter.estimateMessage({ ...base, content: [{ type: 'text', text }] } as Message) - meter.estimateMessage(base)
}

/** Render original ranges with actual canonical references; null means stale or unprofitable.
 * C07 must call this again immediately before appending a replacement.
 */
export function renderShakeMessage(
  original: Message, eventSeq: number, selections: readonly IndexedShakeRegion[],
  reference: { operationId: string; requestSeq: number; sessionId: string }, meter: Pick<TokenMeter, 'estimateMessage'>,
): RenderedShakeMessage | null {
  if (!selections.length || (original.role !== 'tool' && original.role !== 'assistant')) return null
  if (original.role === 'tool' && original.isError === true) return null
  if (original.role === 'assistant' && original.content.some(block => block.type !== 'text')) return null
  const byBlock = new Map<number, IndexedShakeRegion[]>()
  for (const selection of selections) {
    const r = selection.region
    const block = original.content[r.blockIndex]
    if (r.eventSeq !== eventSeq || r.messageId !== original.id || !block || block.type !== 'text'
      || r.start < 0 || r.end > block.text.length || r.start >= r.end
      || checksumShakeText(block.text.slice(r.start, r.end)) !== r.checksum
      || (original.role === 'tool' ? r.kind !== 'tool-text' || r.start !== 0 || r.end !== block.text.length : r.kind === 'tool-text')) return null
    const ranges = byBlock.get(r.blockIndex) ?? []
    if (ranges.some(other => r.start < other.region.end && other.region.start < r.end)) return null
    ranges.push(selection)
    byBlock.set(r.blockIndex, ranges)
  }
  const content = original.content.map((block, index) => {
    const ranges = byBlock.get(index)
    if (!ranges || block.type !== 'text') return block
    let text = block.text
    for (const { region, regionIndex } of [...ranges].sort((a, b) => b.region.start - a.region.start)) {
      const ref = formatShakeRef({ version: 1, operationId: reference.operationId, requestSeq: reference.requestSeq, regionIndex })
      text = text.slice(0, region.start) + `[Removed text; shake_read ref="${ref}"]` + text.slice(region.end)
    }
    return { ...block, text }
  })
  let message: Message
  if (original.role === 'assistant') {
    const first = content.findIndex(block => block.type === 'text')
    const block = content[first]
    if (!block || block.type !== 'text') return null
    content[first] = { ...block, text: SHAKE_EXCERPT_PREFIX + block.text }
    message = { id: original.id, role: 'user', content, source: {
      kind: SHAKE_EXCERPT_KIND, schemaVersion: 1,
      operationId: reference.operationId, requestSeq: reference.requestSeq, sessionId: reference.sessionId,
      originalEventSeq: eventSeq, regionIndices: selections.map(value => value.regionIndex),
    } } as UserMessage
  } else message = { ...original, content }
  const savedTokens = meter.estimateMessage(original) - meter.estimateMessage(message)
  return savedTokens > 0 && textLength(message) < textLength(original) ? { message, savedTokens } : null
}

/** One surface read and one measurement. Other public reads only resolve provenance/call identity. */
export async function planShakeRegions(
  session: Session, services: ShakePlannerServices, options: ShakePlanOptions,
): Promise<ShakePlan> {
  formatShakeRef({ version: 1, operationId: options.operationId, requestSeq: options.requestSeq, regionIndex: 0 })
  const policy = parseShakeConfig(options.policy)
  const surface = await services.sessionQuery.readSurface(session.id)
  const measurement = services.tokenMeter.measure(session)
  if (surface.capturedThroughSeq !== null && options.requestSeq <= surface.capturedThroughSeq) throw new Error('Request must follow captured history')
  const prices = new Map(measurement.nodes.map(node => [Number(node.seq), node.tokens]))
  const messages = surface.events.map(event => ({ event, message: session.deriveEventMessage(event) }))
  const protectedEventSeqs: number[] = []
  let recentTokens = 0
  for (let i = messages.length - 1; i >= 0 && recentTokens < policy.protectedTokens; i--) {
    const item = messages[i]!
    const price = prices.get(item.event.seq)
    if (price === undefined) throw new Error('Surface and measurement disagree')
    recentTokens += price
    protectedEventSeqs.push(item.event.seq)
  }
  const protectedSeqs = new Set(protectedEventSeqs)
  const calls = new Map<string, string>()
  for (const { message } of messages) if (message) for (const block of message.content) {
    if (block.type === 'tool-call') calls.set(block.id, block.name)
  }
  const regions: ShakeRegion[] = []
  let savedTokens = 0
  for (const { event, message } of messages) {
    if (!message || protectedSeqs.has(event.seq) || owned(event) || (message.role !== 'assistant' && message.role !== 'tool')) continue
    if (message.role === 'tool' && message.isError === true) continue
    if (message.role === 'assistant' && message.content.some(block => block.type !== 'text')) continue
    const trace = await services.sessionQuery.traceEvent({ sessionId: session.id, seq: event.seq })
    let processed = false
    const sources = [...trace.sourceEventSeqs]
    const seen = new Set<number>()
    while (sources.length) {
      const seq = sources.pop()!
      if (seen.has(seq)) continue
      seen.add(seq)
      const source = (await services.sessionQuery.readEvent({ sessionId: session.id, seq })).target
      if (owned(source)) { processed = true; break }
      sources.push(...(source.sourceEventSeqs ?? []))
    }
    if (processed) continue
    if (message.role === 'tool') {
      let name = calls.get(message.toolCallId)
      if (name === undefined) {
        // Public raw windows recover identity even when the caller was shadowed.
        let cursor = Number(event.seq)
        while (name === undefined && cursor >= 0) {
          const context = await services.sessionQuery.readEvent({ sessionId: session.id, seq: SessionSeq(cursor), before: Math.min(cursor, 50) })
          for (let i = context.events.length - 1; i >= 0; i--) {
            const row = context.events[i]!
            if (row.type === 'tool/call' && row.data.callId === message.toolCallId) {
              name = row.data.name
              break
            }
          }
          if (context.startSeq === 0 || name !== undefined) break
          cursor = Number(context.startSeq) - 1
        }
      }
      if (name === undefined || name === 'shake_read') continue
      const total = message.content.reduce((sum, block) => sum + (block.type === 'text' ? textTokens(message, block.text, services.tokenMeter) : 0), 0)
      if (total < policy.toolTextMinTokens) continue
    }
    const candidates: ShakeRegion[] = []
    message.content.forEach((block, blockIndex) => {
      if (block.type !== 'text' || !block.text.length) return
      const ranges = message.role === 'tool' ? [{ start: 0, end: block.text.length, kind: 'tool-text' as const }]
        : scanTextForBlockRanges(block.text).filter(range => textTokens(message, block.text.slice(range.start, range.end), services.tokenMeter) >= policy.assistantBlockMinTokens)
          .map(range => ({ ...range, kind: range.kind === 'fence' ? 'assistant-code' as const : 'assistant-xml' as const }))
      for (const range of ranges) candidates.push({ eventSeq: event.seq, messageId: message.id, blockIndex,
        ...range, checksum: checksumShakeText(block.text.slice(range.start, range.end)) })
    })
    const rendered = renderShakeMessage(message, event.seq, candidates.map((region, index) => ({ region, regionIndex: regions.length + index })), { operationId: options.operationId, requestSeq: options.requestSeq, sessionId: session.id }, services.tokenMeter)
    if (rendered) { regions.push(...candidates); savedTokens += rendered.savedTokens }
  }
  return { cutoffSeq: surface.capturedThroughSeq, regions, protectedEventSeqs, savedTokens }
}
