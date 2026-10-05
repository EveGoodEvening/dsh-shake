import { describe, expect, it, vi } from 'vitest'
import type { Message } from '@deepseek-ai/dsh-llm'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { planShakeRegions, renderShakeMessage, SHAKE_EXCERPT_PREFIX, type ShakePlannerServices } from '../src/regions.js'
import { parseShakeConfig } from '../src/config.js'
import { checksumShakeText, ShakeExcerptSchema } from '../src/state.js'

function fixture(messages: Message[], prices = messages.map(() => 100), processed = false, tracedName = 'read') {
  const events = messages.map((message, seq): SessionEvent => {
    const envelope = { seq: SessionSeq(seq), time: 0, surfaceOp: 'append' as const }
    switch (message.role) {
      case 'user': return { ...envelope, type: 'user/message', data: message }
      case 'developer': return { ...envelope, type: 'developer/message', data: { turn: 0, step: 0, message } }
      case 'system': return { ...envelope, type: 'system/message', data: { turn: 0, step: 0, message } }
      case 'assistant': return { ...envelope, type: 'assistant/message', data: { turn: 0, step: 0, message, stream: [] } }
      case 'tool': return { ...envelope, type: 'tool/result', data: { turn: 0, step: 0, message } }
    }
  })
  const estimateMessage = (message: Message) => 4 + message.content.reduce((sum, b) => sum + (b.type === 'text' ? Math.ceil(b.text.length / 4) + 4 : 20), 0)
  const services = {
    sessionQuery: {
      readSurface: vi.fn(async () => ({ events, capturedThroughSeq: events.length - 1 })),
      traceEvent: vi.fn(async () => ({ sourceEventSeqs: processed ? [90] : [] })),
      readEvent: vi.fn(async ({ seq }: { seq: number }) => seq === 90 ? { target: { type: 'user/message', data: { source: { kind: 'dsh-shake-control' } } } }
        : { events: [{ type: 'tool/call', data: { callId: 'call', name: tracedName } }] }),
    },
    tokenMeter: { measure: vi.fn(() => ({ nodes: prices.map((tokens, seq) => ({ seq, tokens })) })), estimateMessage },
  } as unknown as ShakePlannerServices
  const session = Session.create(SessionId('test'))
  return { session, services }
}
function message(role: Message['role'], text: string, extra: { content?: Message['content']; isError?: boolean } = {}): Message {
  const base = { id: MessageId(`message-${role}`), content: extra.content ?? [{ type: 'text' as const, text }] }
  switch (role) {
    case 'tool': return { ...base, role, source: { kind: 'tool', callId: ToolCallId('call') }, toolCallId: ToolCallId('call'), ...(extra.isError === undefined ? {} : { isError: extra.isError }) }
    case 'assistant': return { ...base, role, source: { kind: 'model', provider: 'test', model: 'test' } }
    case 'system': return { ...base, role, source: { kind: 'system-prompt' } }
    case 'developer': return { ...base, role, source: { kind: 'user' } }
    case 'user': return { ...base, role, source: { kind: 'user' } }
  }
}
const options = { operationId: 'operation', requestSeq: 100, policy: parseShakeConfig({ protectedTokens: 0 }) }
const fence = '```ts\n' + 'x'.repeat(1590) + '\n```'

describe('protected profitable regions', () => {
  it('protects the whole crossing message at >=4000 and reads surface/meter once', async () => {
    const f = fixture([message('tool', 'x'.repeat(4000)), message('tool', 'x'.repeat(4000)), message('user', 'recent')], [1000, 3900, 100])
    const plan = await planShakeRegions(f.session, f.services, { ...options, policy: parseShakeConfig() })
    expect(plan.regions.map(r => r.eventSeq)).toEqual([0])
    expect(plan.protectedEventSeqs).toEqual([2, 1])
    expect(f.services.sessionQuery.readSurface).toHaveBeenCalledTimes(1)
    expect(f.services.tokenMeter.measure).toHaveBeenCalledTimes(1)
  })
  it('preserves the entire recent message when accumulation overshoots the default window', async () => {
    const crossing = message('assistant', 'before\n' + fence + '\nafter')
    const f = fixture([message('tool', 'x'.repeat(4000)), crossing, message('user', 'recent')], [1000, 3950, 100])
    const plan = await planShakeRegions(f.session, f.services, { ...options, policy: parseShakeConfig() })
    expect(plan.protectedEventSeqs).toEqual([2, 1])
    expect(plan.regions.map(region => region.eventSeq)).toEqual([0])
    expect(renderShakeMessage(crossing, 1, [], { ...options, sessionId: 'test' }, f.services.tokenMeter)).toBeNull()
    expect(plan.savedTokens).toBeGreaterThan(0)
  })
  it.each(['dsh-shake-control', 'dsh-shake-excerpt'] as const)('hard-excludes %s provenance even with zero thresholds', async kind => {
    const owned = { ...message('user', fence), source: { kind, schemaVersion: 1, sessionId: 'test', operationId: 'operation', requestSeq: 100 } } as Message
    const f = fixture([owned, message('tool', 'x'.repeat(4000))])
    const provenance: SessionEvent = { type: 'user/message', seq: SessionSeq(90), time: 0, surfaceOp: 'append', data: owned as Extract<Message, { role: 'user' }> }
    f.services.sessionQuery.traceEvent = vi.fn<typeof f.services.sessionQuery.traceEvent>(async ({ seq }) => ({
      session: f.session.header,
      target: { sessionId: f.session.id, seq, type: seq === 0 ? 'user/message' : 'tool/result', time: 0, surface: 'current' },
      replacementChain: [], replacedEventSeqs: [], sourceEventSeqs: [SessionSeq(90)], derivedEventSeqs: [],
    }))
    f.services.sessionQuery.readEvent = vi.fn<typeof f.services.sessionQuery.readEvent>(async () => ({
      session: f.session.header, inheritedEventCount: f.session.inheritedEventCount,
      target: provenance, events: [provenance], startSeq: provenance.seq, endSeq: provenance.seq,
    }))
    const plan = await planShakeRegions(f.session, f.services, { ...options, policy: parseShakeConfig({ protectedTokens: 0, toolTextMinTokens: 0, assistantBlockMinTokens: 0 }) })
    expect(plan.regions).toEqual([])
    expect(plan.savedTokens).toBe(0)
  })
  it.each(['user', 'system', 'developer'] as const)('protects every %s message', async role => {
    const f = fixture([message(role, fence)])
    expect((await planShakeRegions(f.session, f.services, options)).regions).toEqual([])
  })
  it('uses host error identity, not words, and protects traced shake_read and processed sources', async () => {
    for (const [extra, processed, name, selected] of [[{}, false, 'read', true], [{}, false, 'skill', true], [{}, false, 'plan', true], [{}, false, 'useless', true], [{ isError: true }, false, 'read', false], [{}, false, 'shake_read', false], [{}, true, 'read', false]] as const) {
      const f = fixture([message('tool', 'error skill useless plan\n' + 'x'.repeat(4000), extra)], undefined, processed, name)
      expect((await planShakeRegions(f.session, f.services, options)).regions.length > 0).toBe(selected)
    }
  })
  it('sums tool text at exact 1000, selects whole blocks and preserves nontext', async () => {
    const nontext = { type: 'reasoning' as const, text: 'preserved reasoning' }
    const original = message('tool', '', { content: [{ type: 'text', text: '😀'.repeat(1000) }, nontext, { type: 'text', text: 'z'.repeat(2000) }] })
    const f = fixture([original])
    const plan = await planShakeRegions(f.session, f.services, options)
    expect(plan.regions.map(r => [r.blockIndex, r.start, r.end])).toEqual([[0, 0, 2000], [2, 0, 2000]])
    const rendered = renderShakeMessage(original, 0, plan.regions.map((region, regionIndex) => ({ region, regionIndex })), { ...options, sessionId: 'test' }, f.services.tokenMeter)!
    expect(rendered.message.content[1]).toBe(nontext)
    expect(rendered.savedTokens).toBeGreaterThan(0)
    const below = fixture([message('tool', 'x'.repeat(3996))])
    expect((await planShakeRegions(below.session, below.services, options)).regions).toEqual([])
  })
  it('scans only complete assistant blocks at 400, retaining Unicode surrounding prose', async () => {
    const text = '😀 intro\n' + fence + '\nend 𠮷'
    const f = fixture([message('assistant', text)])
    const plan = await planShakeRegions(f.session, f.services, options)
    expect(plan.regions).toEqual([{ eventSeq: 0, messageId: 'message-assistant', kind: 'assistant-code', blockIndex: 0, start: 9, end: 9 + fence.length, checksum: checksumShakeText(fence) }])
    const rendered = renderShakeMessage(message('assistant', text), 0, [{ region: plan.regions[0]!, regionIndex: 0 }], { ...options, sessionId: 'test' }, f.services.tokenMeter)!
    expect(rendered.message.role).toBe('user')
    expect(rendered.message.content[0]).toEqual({ type: 'text', text: SHAKE_EXCERPT_PREFIX + '😀 intro\n[Removed text; shake_read ref="shake:1:operation:100:0"]\nend 𠮷' })
    expect(ShakeExcerptSchema.parse(rendered.message.source)).toEqual({ kind: 'dsh-shake-excerpt', schemaVersion: 1,
      operationId: options.operationId, requestSeq: options.requestSeq, sessionId: 'test', originalEventSeq: 0, regionIndices: [0] })
  })
  it.each([
    'x'.repeat(5000), '```\n' + 'x'.repeat(5000), '```\n' + 'x'.repeat(1587) + '\n```',
  ])('rejects ordinary, incomplete and below-threshold assistant content', async text => {
    const f = fixture([message('assistant', text)])
    expect((await planShakeRegions(f.session, f.services, options)).regions).toEqual([])
  })
  it('skips mixed assistant blocks rather than scanning tool-call arguments', async () => {
    const f = fixture([message('assistant', fence, { content: [{ type: 'text', text: fence }, { type: 'tool-call', id: ToolCallId('call'), name: 'read', arguments: fence }] })])
    expect((await planShakeRegions(f.session, f.services, options)).regions).toEqual([])
  })
  it('selects independent closed XML blocks without spanning content blocks', async () => {
    const xml = '<data>\n' + 'α'.repeat(1600) + '\n</data>'
    const original = message('assistant', '', { content: [{ type: 'text', text: xml }, { type: 'text', text: fence }] })
    const f = fixture([original])
    const plan = await planShakeRegions(f.session, f.services, options)
    expect(plan.regions.map(r => [r.kind, r.blockIndex])).toEqual([['assistant-xml', 0], ['assistant-code', 1]])
    expect(plan.regions.map(r => r.checksum)).toEqual([checksumShakeText(xml), checksumShakeText(fence)])
  })
  it('selects multiple threshold-sized blocks and outer nested XML while preserving ordinary text', async () => {
    const nested = '<outer>\n<inner>\n' + 'n'.repeat(1566) + '\n</inner>\n</outer>'
    const below = '```\n' + 'b'.repeat(1588) + '\n```'
    const second = '~~~\n' + 'z'.repeat(1592) + '\n~~~'
    const text = 'ordinary 😀\n' + fence + '\nbetween\n' + below + '\n' + nested + '\n' + second + '\nordinary end 𠮷'
    const original = message('assistant', text)
    const f = fixture([original])
    const plan = await planShakeRegions(f.session, f.services, options)
    expect(plan.regions.map(region => [region.kind, text.slice(region.start, region.end)])).toEqual([
      ['assistant-code', fence], ['assistant-xml', nested], ['assistant-code', second],
    ])
    const rendered = renderShakeMessage(original, 0, plan.regions.map((region, regionIndex) => ({ region, regionIndex })), { ...options, sessionId: 'test' }, f.services.tokenMeter)!
    expect(rendered.message.content).toEqual([{ type: 'text', text: SHAKE_EXCERPT_PREFIX + 'ordinary 😀\n[Removed text; shake_read ref="shake:1:operation:100:0"]\nbetween\n' + below + '\n[Removed text; shake_read ref="shake:1:operation:100:1"]\n[Removed text; shake_read ref="shake:1:operation:100:2"]\nordinary end 𠮷' }])
    expect(rendered.savedTokens).toBeGreaterThan(0)
  })
  it.each([['tool', 3996, false], ['tool', 4000, true], ['assistant', 1596, false], ['assistant', 1600, true]] as const)('enforces the exact %s boundary at %i characters', async (role, length, selected) => {
    const text = role === 'tool' ? 'x'.repeat(length) : '```\n' + 'x'.repeat(length - 8) + '\n```'
    const f = fixture([message(role, text)])
    const plan = await planShakeRegions(f.session, f.services, options)
    expect(plan.regions).toHaveLength(selected ? 1 : 0)
    if (selected) expect(plan.regions[0]).toMatchObject({ start: 0, end: text.length, checksum: checksumShakeText(text) })
  })
  it('does not trim rendered assistant excerpts with qualifying text left behind', async () => {
    const original = message('assistant', fence + '\nkeep this\n' + fence)
    const f = fixture([original])
    const first = await planShakeRegions(f.session, f.services, options)
    expect(first.regions).toHaveLength(2)
    const rendered = renderShakeMessage(original, 0, [{ region: first.regions[0]!, regionIndex: 0 }], { ...options, sessionId: 'test' }, f.services.tokenMeter)!
    expect(rendered.message.source).toMatchObject({ kind: 'dsh-shake-excerpt', originalEventSeq: 0, regionIndices: [0] })
    expect(rendered.message.content).toEqual([{ type: 'text', text: SHAKE_EXCERPT_PREFIX + '[Removed text; shake_read ref="shake:1:operation:100:0"]\nkeep this\n' + fence }])
    const next = fixture([rendered.message])
    const repeated = await planShakeRegions(next.session, next.services, { ...options, operationId: 'next' })
    expect(repeated.regions).toEqual([])
    expect(repeated.savedTokens).toBe(0)
  })
  it('protects a rendered tool result through real control provenance despite remaining eligible text', async () => {
    const original = message('tool', '', { content: [{ type: 'text', text: 'x'.repeat(4000) }, { type: 'text', text: 'remaining'.repeat(500) }] })
    const f = fixture([original])
    const first = await planShakeRegions(f.session, f.services, options)
    expect(first.regions).toHaveLength(2)
    const rendered = renderShakeMessage(original, 0, [{ region: first.regions[0]!, regionIndex: 0 }], { ...options, sessionId: 'test' }, f.services.tokenMeter)!
    const next = fixture([rendered.message])
    expect((await planShakeRegions(next.session, next.services, options)).regions.map(region => region.blockIndex)).toEqual([0, 1])
    const control = { ...message('user', 'shake request'), source: { kind: 'dsh-shake-control', schemaVersion: 1, operationId: 'operation', sessionId: 'test', current: { ...options, sessionId: 'test', cutoffSeq: 0, regions: first.regions }, lastResult: null } } as Extract<Message, { role: 'user' }>
    const provenance: SessionEvent = { type: 'user/message', seq: SessionSeq(90), time: 0, surfaceOp: 'append', data: control }
    next.services.sessionQuery.traceEvent = vi.fn<typeof next.services.sessionQuery.traceEvent>(async ({ seq }) => ({
      session: next.session.header,
      target: { sessionId: next.session.id, seq, type: 'tool/result', time: 0, surface: 'current' },
      replacementChain: [], replacedEventSeqs: [], sourceEventSeqs: [SessionSeq(90)], derivedEventSeqs: [],
    }))
    next.services.sessionQuery.readEvent = vi.fn<typeof next.services.sessionQuery.readEvent>(async () => ({
      session: next.session.header, inheritedEventCount: next.session.inheritedEventCount,
      target: provenance, events: [provenance], startSeq: provenance.seq, endSeq: provenance.seq,
    }))
    const repeated = await planShakeRegions(next.session, next.services, { ...options, operationId: 'next' })
    expect(repeated.regions).toEqual([])
    expect(repeated.savedTokens).toBe(0)
    expect(rendered.message.content[1]).toEqual(original.content[1])
  })
  it('rejects no Unicode profit and recalculates actual estimates/refs', async () => {
    const original = message('tool', '😀'.repeat(40))
    const f = fixture([original])
    const low = { ...options, operationId: 'a', requestSeq: 1, policy: parseShakeConfig({ protectedTokens: 0, toolTextMinTokens: 0 }) }
    expect((await planShakeRegions(f.session, f.services, low)).regions).toEqual([])
    const large = fixture([message('tool', 'x'.repeat(4000))])
    const plan = await planShakeRegions(large.session, large.services, options)
    const selections = plan.regions.map((region, regionIndex) => ({ region, regionIndex }))
    expect(renderShakeMessage(message('tool', 'x'.repeat(4000)), 0, selections, { operationId: 'a'.repeat(128), requestSeq: Number.MAX_SAFE_INTEGER, sessionId: 'test' }, { estimateMessage: () => 100 })).toBeNull()
    expect(renderShakeMessage(message('tool', 'changed'), 0, selections, { ...options, sessionId: 'test' }, large.services.tokenMeter)).toBeNull()
    expect(await planShakeRegions(large.session, large.services, options)).toEqual(plan)
  })
})
