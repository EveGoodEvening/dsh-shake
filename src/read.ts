import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { scanTextForBlockRanges } from './blocks.js'
import { parseShakeConfig, type ShakeConfig } from './config.js'
import { renderShakeMessage } from './regions.js'
import { checksumShakeText, parseShakeRef, ShakeControlSchema, ShakeExcerptSchema } from './state.js'
import { ShakeLifecycle } from './lifecycle.js'

export interface ShakeReadArgs { ref: string; offset?: number; limit?: number }
export interface ShakeReadPage { text: string; offset: number; totalLength: number; nextOffset: number | null; done: boolean }
export interface ShakeReadServices {
  sessionQuery: Pick<SessionQueryEngine, 'readEvent' | 'traceEvent'>
  tokenMeter: Pick<TokenMeter, 'estimateMessage'>
}

/** The reference is only a locator. All evidence must exist in the captured current session. */
export async function readShakeText(services: ShakeReadServices, agent: Agent | undefined,
  args: ShakeReadArgs, signal: AbortSignal, config: ShakeConfig): Promise<ShakeReadPage> {
  const policy = parseShakeConfig(config)
  const offset = args.offset ?? 0
  const limit = args.limit ?? policy.readDefaultLimit
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > policy.readMaxLimit) {
    throw new Error('Invalid shake_read pagination')
  }
  const ref = parseShakeRef(args.ref)
  if (!agent) throw new Error('shake_read requires a current agent session')
  const session = agent.session
  const check = () => {
    signal.throwIfAborted()
    if (agent.session !== session) throw new Error('shake_read session changed')
  }
  const denied = (): never => { throw new Error('Shake reference is not authorized by the current session log') }
  const read = async (seq: number) => {
    check()
    const window = await services.sessionQuery.readEvent({ sessionId: session.id, seq: SessionSeq(seq), before: 0, after: 0 }, signal)
    check()
    if (window.session.id !== session.id || window.target.seq !== seq
      || window.inheritedEventCount !== session.inheritedEventCount) denied()
    return window.target
  }
  const trace = async (seq: number) => {
    check()
    const value = await services.sessionQuery.traceEvent({ sessionId: session.id, seq: SessionSeq(seq) }, signal)
    check()
    if (value.target.sessionId !== session.id || value.target.seq !== seq) denied()
    return value
  }
  check()
  const requestEvent = await read(ref.requestSeq)
  if (requestEvent.type !== 'user/message') return denied()
  const control = ShakeControlSchema.parse(requestEvent.data.source)
  const request = control.current
  if (!request || control.operationId !== ref.operationId || request.operationId !== ref.operationId
    || request.requestSeq !== ref.requestSeq || control.sessionId !== request.sessionId
    || control.lastResult?.operationId === ref.operationId) return denied()
  const requestTrace = await trace(ref.requestSeq)
  if (requestTrace.replacedEventSeqs.length || requestTrace.sourceEventSeqs.length) return denied()
  // A foreign origin is valid only inside a real inherited prefix. Parent metadata
  // alone is never authority; no query here ever follows a parent or sibling id.
  const inherited = ref.requestSeq < session.inheritedEventCount
  if (inherited ? !session.header.isSeeded || !session.header.parentSession
    : request.sessionId !== session.id) return denied()
  const region = request.regions[ref.regionIndex]
  if (!region) return denied()
  const original = await read(region.eventSeq)
  const originalTrace = await trace(region.eventSeq)
  // A positional replacer is mutable context, never a new original-text source.
  if (originalTrace.replacedEventSeqs.length || originalTrace.replacedBy === undefined) return denied()
  const replacementSeq = originalTrace.replacedBy
  if (replacementSeq <= ref.requestSeq || (inherited && replacementSeq >= session.inheritedEventCount)) return denied()
  const replacement = await read(replacementSeq)
  const replacementTrace = await trace(replacementSeq)
  if (replacementTrace.replacedEventSeqs.length !== 1 || replacementTrace.replacedEventSeqs[0] !== original.seq
    || replacementTrace.sourceEventSeqs.length !== 2
    || replacementTrace.sourceEventSeqs[0] !== original.seq || replacementTrace.sourceEventSeqs[1] !== requestEvent.seq
    || replacement.sourceEventSeqs?.length !== 2 || replacement.sourceEventSeqs[0] !== original.seq
    || replacement.sourceEventSeqs[1] !== requestEvent.seq) return denied()
  const message = session.deriveEventMessage(original)
  if (!message || (original.type !== 'tool/result' && original.type !== 'assistant/message')
    || (original.type === 'tool/result' ? message.role !== 'tool' : message.role !== 'assistant')) return denied()
  const selections = request.regions.map((value, regionIndex) => ({ region: value, regionIndex }))
    .filter(value => value.region.eventSeq === original.seq)
  for (const { region: selected } of selections) {
    const block = message.content[selected.blockIndex]
    if (message.id !== selected.messageId || !block || block.type !== 'text'
      || selected.end > block.text.length || checksumShakeText(block.text.slice(selected.start, selected.end)) !== selected.checksum) return denied()
    if (message.role === 'tool') {
      if (selected.kind !== 'tool-text' || selected.start !== 0 || selected.end !== block.text.length || message.isError) return denied()
    } else if (!scanTextForBlockRanges(block.text).some(range => range.start === selected.start && range.end === selected.end
      && selected.kind === (range.kind === 'fence' ? 'assistant-code' : 'assistant-xml'))) return denied()
  }
  const rendered = renderShakeMessage(message, original.seq, selections, request, services.tokenMeter)
  if (!rendered || (original.type === 'tool/result' ? replacement.type !== 'tool/result' : replacement.type !== 'user/message')
    || JSON.stringify(session.deriveEventMessage(replacement)) !== JSON.stringify(rendered.message)) return denied()
  if (replacement.type === 'user/message') {
    const excerpt = ShakeExcerptSchema.parse(replacement.data.source)
    if (excerpt.operationId !== request.operationId || excerpt.requestSeq !== request.requestSeq
      || excerpt.sessionId !== request.sessionId || excerpt.originalEventSeq !== original.seq
      || !excerpt.regionIndices.includes(ref.regionIndex)) return denied()
  }
  const block = message.content[region.blockIndex]
  if (!block || block.type !== 'text') return denied()
  const text = block.text.slice(region.start, region.end)
  // Iterate without materializing the entire fragment as a code-point array.
  let totalLength = 0
  let page = ''
  for (const point of text) {
    if (totalLength >= offset && totalLength - offset < limit) page += point
    totalLength++
  }
  if (offset > totalLength) throw new Error('shake_read offset exceeds fragment length')
  check()
  const next = offset + Array.from(page).length
  const done = next === totalLength
  return { text: page, offset, totalLength, nextOffset: done ? null : next, done }
}

export function registerShakeRead(ctx: Context, config: ShakeConfig, lifecycle = new ShakeLifecycle()): () => void {
  return ctx.tools.register(defineTool({
    name: 'shake_read',
    description: 'Read only an actually removed fragment inherited by the current session. Offsets and lengths are Unicode code points; no session IDs, files or paths are accepted.',
    parameters: {
      ref: { type: 'string', required: true, description: 'Canonical shake reference from a removed-text placeholder.' },
      offset: { type: 'integer', description: 'Nonnegative code-point offset.', default: 0 },
      limit: { type: 'integer', description: `Positive page length, at most ${config.readMaxLimit}.`, default: config.readDefaultLimit },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        text: { type: 'string', required: true }, offset: { type: 'integer', required: true },
        totalLength: { type: 'integer', required: true },
        nextOffset: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
        done: { type: 'boolean', required: true },
      } },
      render: (_args, page) => [{ type: 'text', text: JSON.stringify(page) }],
    },
    // The published host has no invented permission/readOnly fields. This is its
    // supported declaration for non-mutating calls that can safely overlap.
    isConcurrencySafe: () => true,
    execute: (args, exec) => lifecycle.run(exec.signal,
      signal => readShakeText(ctx, exec.agent, args, signal, config)),
  }))
}
