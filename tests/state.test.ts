import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { DEFAULT_SHAKE_CONFIG, parseShakeConfig } from '../src/config.js'
import {
  applyShakeEvent, checksumShakeText, formatShakeRef, parseShakeRef,
  ShakeControlSchema, ShakeRequestSchema, ShakeStateSchema, shakeProjection,
  type ShakeControl,
} from '../src/state.js'

function fixture(session: Session): ShakeControl {
  const original = session.append('user/message', {
    id: MessageId('original'), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'A😀Z' }],
  }, { surfaceOp: 'append' })
  return {
    kind: 'dsh-shake-control', schemaVersion: 1, operationId: 'operation_1', sessionId: session.id,
    current: {
      operationId: 'operation_1', sessionId: session.id, requestSeq: session.seq,
      cutoffSeq: session.seq - 1, policy: { ...DEFAULT_SHAKE_CONFIG },
      regions: [{ eventSeq: original.seq, messageId: 'original', kind: 'assistant-code', blockIndex: 0,
        start: 1, end: 3, checksum: checksumShakeText('😀') }],
    }, lastResult: null,
  }
}
function controlEvent(session: Session, source: ShakeControl) {
  return session.append('user/message', {
    id: MessageId(`control-${session.seq}`), role: 'user', content: [{ type: 'text', text: 'Shake scheduled' }], source,
  }, { surfaceOp: 'append' })
}

describe('durable shake consumer boundaries', () => {
  it('rejects protection switches and invalid read limits', () => {
    expect(() => parseShakeConfig({ protectUsers: false })).toThrow()
    expect(() => parseShakeConfig({ readMaxLimit: 4097 })).toThrow()
    expect(() => parseShakeConfig({ readDefaultLimit: 3000, readMaxLimit: 2000 })).toThrow()
  })
  it('preserves exact references and rejects ambiguous or unsafe identities', () => {
    const ref = { version: 1 as const, operationId: 'op_1', requestSeq: 5, regionIndex: 0 }
    expect(parseShakeRef(formatShakeRef(ref))).toEqual(ref)
    for (const invalid of ['shake:2:op_1:5:0', 'shake:1:op_1:05:0', 'shake:1:op_1:5:-1',
      'shake:1:op_1:9007199254740992:0', 'shake:1:op_1:5:0:extra']) {
      expect(() => parseShakeRef(invalid)).toThrow()
    }
  })
  it.each(['\n', '\r', '\r\n', '\u2028', '\u2029'])('rejects trailing line terminator %j in canonical values', terminator => {
    const session = Session.create(SessionId('canonical-test'))
    const request = fixture(session).current!
    const ref = { version: 1 as const, operationId: request.operationId, requestSeq: request.requestSeq, regionIndex: 0 }
    const formatted = formatShakeRef(ref)
    expect(parseShakeRef(formatted)).toEqual(ref)
    expect(() => formatShakeRef({ ...ref, operationId: ref.operationId + terminator })).toThrow()
    expect(() => ShakeRequestSchema.parse({ ...request, operationId: request.operationId + terminator })).toThrow()
    expect(() => ShakeRequestSchema.parse({ ...request,
      regions: [{ ...request.regions[0], checksum: request.regions[0].checksum + terminator }],
    })).toThrow()
    expect(() => parseShakeRef(formatted + terminator)).toThrow()
  })
  it('requires original nonoverlapping ranges at or before the cutoff without text copies', () => {
    const session = Session.create(SessionId('range-test'))
    const control = fixture(session)
    const request = control.current!
    expect(ShakeRequestSchema.parse(request)).toEqual(request)
    expect(() => ShakeRequestSchema.parse({ ...request, regions: [{ ...request.regions[0], end: 1 }] })).toThrow()
    expect(() => ShakeRequestSchema.parse({ ...request, regions: [request.regions[0], request.regions[0]] })).toThrow()
    expect(() => ShakeRequestSchema.parse({ ...request, regions: [{ ...request.regions[0], originalText: 'secret' }] })).toThrow()
    expect(() => ShakeRequestSchema.parse({ ...request, regions: [{ ...request.regions[0], eventSeq: request.requestSeq }] })).toThrow()
  })
  it('restores whole pending state, keeps unrelated reference, and suppresses parent intent', () => {
    const parent = Session.create(SessionId('parent'))
    const source = fixture(parent)
    const event = controlEvent(parent, source)
    const initial = shakeProjection.init(parent.header, parent.inheritedEventCount)
    const pending = applyShakeEvent(initial, event)
    expect(pending.current).toEqual(source.current)
    const unrelated = parent.append('user/message', {
      id: MessageId('unrelated'), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Unrelated' }],
    }, { surfaceOp: 'append' })
    expect(applyShakeEvent(pending, unrelated)).toBe(pending)
    const child = Session.create(SessionId('child'))
    const inherited = applyShakeEvent(shakeProjection.init(child.header, child.inheritedEventCount), event)
    expect(inherited.current).toBeNull()
    expect(() => ShakeStateSchema.parse({ ...pending, sessionId: child.id })).toThrow()
  })
  it('replaces current state with the bounded last result and rejects unknown schemas', () => {
    const session = Session.create(SessionId('outcome-test'))
    const source = fixture(session)
    const pending = applyShakeEvent(shakeProjection.init(session.header, session.inheritedEventCount), controlEvent(session, source))
    const result = { operationId: source.operationId, sessionId: session.id,
      requestSeq: source.current!.requestSeq, status: 'cancelled' as const,
      removedRegions: 0, skippedRegions: 0, estimatedTokensSaved: 0 }
    const completed = applyShakeEvent(pending, controlEvent(session, { ...source, current: null, lastResult: result }))
    expect(completed.current).toBeNull()
    expect(completed.lastResult).toEqual(result)
    expect(() => ShakeControlSchema.parse({ ...source, schemaVersion: 2 })).toThrow()
    expect(() => ShakeControlSchema.parse({ ...source, sessionId: 'other' })).toThrow()
  })
})
