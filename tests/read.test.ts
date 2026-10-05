import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { buildForkSeed, SessionId, SessionLogOffset, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { setTimeout as delay } from 'node:timers/promises'
import * as shake from '../src/index.js'
import { parseShakeConfig } from '../src/config.js'
import { formatShakeRef, readShakeState, type ShakeRequest } from '../src/state.js'
import { readShakeText, type ShakeReadArgs, type ShakeReadServices } from '../src/read.js'
import { executePendingShake } from '../src/execute.js'

interface Host { ctx: Context; agent: Agent; requests: unknown[][]; close(): Promise<void> }
const fixturePath = new URL('../.verification/contracts/published-contract.mjs', import.meta.url).href
// Deliberately exercise the separately pinned published-package consumer boundary;
// its JavaScript fixture has no declaration file for a static TypeScript import.
const fixture = await import(fixturePath) as {
  createContractHost(options?: { assistantText?: string }): Promise<Host>
  prepareToolHistory(host: Host): Promise<SessionEvent<'tool/result'>>
}
const closers: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close() })
const policy = parseShakeConfig({ protectedTokens: 0 })
const signal = () => new AbortController().signal
const refFor = (request: ShakeRequest, regionIndex = 0) => formatShakeRef({ version: 1, operationId: request.operationId, requestSeq: request.requestSeq, regionIndex })
async function history() {
  const host = await fixture.createContractHost({ assistantText: 'private prefix\n```ts\n' + 'α😀𠮷e\u0301\n'.repeat(1000) + '```\nprivate suffix' })
  closers.push(host.close)
  await host.ctx.plugin(shake, policy)
  const original = await fixture.prepareToolHistory(host)
  const before = host.requests.length
  const outcome = await host.ctx.commands.execute(host.agent, '/shake', [], signal())
  expect(outcome?.result.kind).toBe('success')
  expect(host.requests.length).toBe(before)
  const request = readShakeState(host.ctx.sessionProjections, host.agent.session).current!
  return { host, original, request, ref: refFor(request) }
}
async function land(host: Host) {
  const errors: unknown[] = []
  const remove = host.ctx.on('agent/error', payload => { if (payload.agent === host.agent) errors.push(payload.error) })
  try {
    host.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue.' }], source: { kind: 'user' } }))
    await host.agent.whenIdle()
    if (errors.length) throw new AggregateError(errors)
  } finally { remove() }
}
async function dispatch(host: Host, args: unknown, agent = host.agent, abortSignal = signal()) {
  return host.ctx.tools.execute({ callId: ToolCallId('read-validation'), name: 'shake_read', arguments: args, agent, signal: abortSignal })
}
function read(host: Host, args: ShakeReadArgs, services: ShakeReadServices = host.ctx, abortSignal = signal()) {
  return readShakeText(services, host.agent, args, abortSignal, policy)
}
async function child(host: Host, name: string, boundary?: number) {
  const events = boundary === undefined ? [] : (await host.ctx.sessionQuery.readSession(host.agent.session.id)).events
  const handle = await host.ctx.agents.create({ sessionId: SessionId(name),
    meta: { parentSession: host.agent.session.id, isSeeded: boundary !== undefined },
    ...(boundary === undefined ? {} : { seed: buildForkSeed(events, SessionSeq(boundary)), inheritedEventCount: SessionLogOffset(boundary + 1) }),
    agentOptions: { provider: 'contract-replay', model: 'contract-model' },
  })
  closers.push(() => handle.dispose())
  return handle.agent
}

describe('shake_read authorization and code-point pagination', () => {
  it('denies pending, forged and unrelated references, then returns exact landed Unicode fragments', async () => {
    const { host, request, ref } = await history()
    expect((await dispatch(host, { ref })).isError).toBe(true)
    await land(host)
    for (const forged of ['shake:1:forged:' + request.requestSeq + ':0', refFor(request, request.regions.length),
      'shake:1:' + request.operationId + ':999999:0', 'shake:2:x:0:0', ref + ':extra', ref.replace(':1:', ':01:')]) {
      expect((await dispatch(host, { ref: forged })).isError).toBe(true)
    }
    const sibling = await child(host, 'read-unrelated')
    expect((await dispatch(host, { ref }, sibling)).isError).toBe(true)
    for (let regionIndex = 0; regionIndex < request.regions.length; regionIndex++) {
      const region = request.regions[regionIndex]!
      const event = (await host.ctx.sessionQuery.readEvent({ sessionId: host.agent.session.id, seq: SessionSeq(region.eventSeq) })).target
      const message = host.agent.session.deriveEventMessage(event)!
      const block = message.content[region.blockIndex]!
      if (block.type !== 'text') throw new Error('Expected original text')
      const expected = block.text.slice(region.start, region.end)
      let joined = ''; let offset = 0
      for (;;) {
        const result = await dispatch(host, { ref: refFor(request, regionIndex), offset, limit: 127 })
        expect(result.isError).toBe(false)
        if (result.isError) throw new Error('Unexpected authorization failure')
        const page = result.value as { text: string; offset: number; nextOffset: number | null; done: boolean; totalLength: number }
        expect(page.offset).toBe(offset)
        expect(page.totalLength).toBe(Array.from(expected).length)
        expect(page.text).toBe(Array.from(expected).slice(offset, offset + 127).join(''))
        joined += page.text
        if (page.nextOffset === null) { expect(page.done).toBe(true); break }
        expect(page.done).toBe(false); offset = page.nextOffset
      }
      expect(joined).toBe(expected)
      const end = await read(host, { ref: refFor(request, regionIndex), offset: Array.from(expected).length })
      expect(end).toEqual({ text: '', offset: Array.from(expected).length, totalLength: Array.from(expected).length, nextOffset: null, done: true })
      await expect(read(host, { ref: refFor(request, regionIndex), offset: end.totalLength + 1 })).rejects.toThrow('offset')
    }
  }, 30000)

  it('rejects invalid pagination and honors configured defaults and maximums', async () => {
    const { host, ref } = await history(); await land(host)
    for (const args of [{ offset: -1 }, { offset: 0.5 }, { offset: Number.MAX_SAFE_INTEGER + 1 }, { limit: 0 }, { limit: -1 }, { limit: 1.5 }, { limit: 4097 }]) {
      expect((await dispatch(host, { ref, ...args })).isError).toBe(true)
    }
    expect(Array.from((await read(host, { ref })).text).length).toBe(2048)
    expect(Array.from((await read(host, { ref, limit: 4096 })).text).length).toBe(4096)
    const small = parseShakeConfig({ readDefaultLimit: 3, readMaxLimit: 5 })
    expect(Array.from((await readShakeText(host.ctx, host.agent, { ref }, signal(), small)).text).length).toBe(3)
    await expect(readShakeText(host.ctx, host.agent, { ref, limit: 6 }, signal(), small)).rejects.toThrow('pagination')
  }, 30000)

  it('requires the original, request and landed replacement in the actual inherited prefix', async () => {
    const { host, request, ref } = await history()
    const pending = await child(host, 'read-pending-fork', request.requestSeq)
    await land(host)
    expect((await dispatch(host, { ref }, pending)).isError).toBe(true)
    const metadataOnly = await child(host, 'read-parent-pointer-only')
    expect((await dispatch(host, { ref }, metadataOnly)).isError).toBe(true)
    const fork = await child(host, 'read-landed-fork', host.agent.session.seq - 1)
    const parent = await read(host, { ref, limit: 17 })
    const result = await dispatch(host, { ref, limit: 17 }, fork)
    expect(result.isError).toBe(false)
    if (!result.isError) expect(result.value).toEqual(parent)
  }, 30000)

  it('uses old request events rather than the bounded latest outcome, and fails closed on missing or altered evidence', async () => {
    const { host, original, request, ref } = await history(); await land(host)
    const older = await read(host, { ref, limit: 9 })
    host.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Another turn.' }], source: { kind: 'user' } }))
    await host.agent.whenIdle()
    // A later durable control changes bounded state without removing old log evidence.
    const seq = host.agent.session.seq
    host.agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Later cancellation.' }], source: {
      kind: 'dsh-shake-control', schemaVersion: 1, operationId: 'later-operation', sessionId: host.agent.session.id, current: null,
      lastResult: { operationId: 'later-operation', sessionId: host.agent.session.id, requestSeq: seq - 1,
        status: 'cancelled', removedRegions: 0, skippedRegions: 0, estimatedTokensSaved: 0 },
    } }), { surfaceOp: 'append' })
    expect(readShakeState(host.ctx.sessionProjections, host.agent.session).lastResult?.operationId).toBe('later-operation')
    expect(await read(host, { ref, limit: 9 })).toEqual(older)
    const query = host.ctx.sessionQuery
    const services = (alter: (event: SessionEvent) => SessionEvent): ShakeReadServices => ({ tokenMeter: host.ctx.tokenMeter,
      sessionQuery: { traceEvent: args => query.traceEvent(args), readEvent: async args => {
        const value = await query.readEvent(args); return { ...value, target: alter(structuredClone(value.target)) }
      } },
    })
    const replacementContent: readonly ContentBlock[] = [{ type: 'text', text: 'changed original' }]
    await expect(read(host, { ref }, services((event): SessionEvent => {
      if (event.seq === original.seq && event.type === 'tool/result') return {
        ...event,
        data: { ...event.data, message: { ...event.data.message, content: replacementContent } },
      }
      return event
    }))).rejects.toThrow()
    await expect(read(host, { ref }, { tokenMeter: host.ctx.tokenMeter, sessionQuery: {
      traceEvent: args => query.traceEvent(args), readEvent: async args => {
        if (args.seq === original.seq) throw new Error('Original log pruned')
        return query.readEvent(args)
      },
    } })).rejects.toThrow('pruned')
    await expect(read(host, { ref }, { tokenMeter: host.ctx.tokenMeter, sessionQuery: {
      readEvent: args => query.readEvent(args), traceEvent: async args => {
        const value = await query.traceEvent(args)
        return args.seq === original.seq ? { ...value, replacedBy: undefined } : value
      },
    } })).rejects.toThrow('authorized')
    await expect(read(host, { ref }, services(event => {
      if (event.seq === request.requestSeq && event.type === 'user/message' && event.data.source.kind === 'dsh-shake-control' && event.data.source.current) {
        event.data.source.current.regions[0]!.kind = 'assistant-code'
      }
      return event
    }))).rejects.toThrow()
  }, 30000)

  it('keeps landed partial fragments readable after cancellation while denying unlanded selections', async () => {
    const { host, request, ref } = await history()
    const abort = new AbortController()
    const reason = new Error('Stop after first real replacement')
    let executionError: unknown
    const stop = host.ctx.on('session/flush', session => {
      const result = readShakeState(host.ctx.sessionProjections, session).lastResult
      if (session === host.agent.session && result?.operationId === request.operationId && result.removedRegions === 1) abort.abort(reason)
    })
    const intercept = host.ctx.on('agent/pre-step', async (payload, next) => {
      if (payload.agent !== host.agent) return next()
      try { await executePendingShake(host.ctx, host.agent, abort.signal) } catch (error) { executionError = error }
      return { kind: 'reject' }
    }, { prepend: true })
    const before = host.requests.length
    try { await land(host) } finally { intercept(); stop() }
    expect(executionError).toBe(reason)
    expect(host.requests.length).toBe(before)
    expect((await dispatch(host, { ref, limit: 7 })).isError).toBe(false)
    expect((await dispatch(host, { ref: refFor(request, 1) })).isError).toBe(true)
  }, 30000)

  it('does not hang or leak if aborted during a cancellable public query observation', async () => {
    const { host, ref } = await history(); await land(host)
    const abort = new AbortController()
    const pending = read(host, { ref }, { tokenMeter: host.ctx.tokenMeter,
      sessionQuery: { readEvent: async (args, querySignal) => {
        expect(querySignal).toBe(abort.signal)
        await delay(60000, undefined, { signal: querySignal })
        return host.ctx.sessionQuery.readEvent(args, querySignal)
      }, traceEvent: (args, querySignal) => host.ctx.sessionQuery.traceEvent(args, querySignal) } }, abort.signal)
    const reason = new Error('read cancelled')
    abort.abort(reason)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError', cause: reason })
    const preAborted = new AbortController(); preAborted.abort(reason)
    await expect(read(host, { ref }, host.ctx, preAborted.signal)).rejects.toBe(reason)
  }, 30000)
})
