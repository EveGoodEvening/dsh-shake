import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import * as shake from '../src/index.js'
import { parseShakeConfig } from '../src/config.js'
import { readShakeState } from '../src/state.js'
import { renderShakeMessage } from '../src/regions.js'
import { executePendingShake } from '../src/execute.js'

interface Host {
  ctx: Context
  agent: Agent
  requests: Message[][]
  close(): Promise<void>
}
// Deliberately load the separate pinned published-package consumer fixture.
const fixturePath = new URL('../.verification/contracts/published-contract.mjs', import.meta.url).href
const fixture = await import(fixturePath) as {
  createContractHost(options?: { assistantText?: string, usageAnchor?: boolean }): Promise<Host>
  prepareToolHistory(host: Host): Promise<SessionEvent<'tool/result'>>
}
const hosts: Host[] = []
afterEach(async () => { for (const host of hosts.splice(0)) await host.close() })
async function history(usageAnchor = false) {
  const host = await fixture.createContractHost({ assistantText: 'before\n```ts\n' + 'x'.repeat(8000) + '\n```\nafter', usageAnchor })
  hosts.push(host)
  await host.ctx.plugin(shake, parseShakeConfig({ protectedTokens: 0 }))
  const original = await fixture.prepareToolHistory(host)
  return { host, original }
}
async function schedule(host: Host) {
  const before = host.requests.length
  const outcome = await host.ctx.commands.execute(host.agent, '/shake', [], new AbortController().signal)
  if (!outcome) throw new Error('Missing shake command outcome')
  expect(outcome.result.kind).toBe('success')
  expect(host.requests.length).toBe(before)
  const request = readShakeState(host.ctx.sessionProjections, host.agent.session).current
  expect(request).not.toBeNull()
  if (!request) throw new Error('Missing pending request')
  return request
}
function errorLeaves(error: unknown, ancestors = new Set<unknown>(), depth = 0, budget = { remaining: 128 }): unknown[] {
  if (--budget.remaining < 0 || depth >= 32 || ancestors.has(error)) throw new Error('Expected error chain is cyclic or too large')
  const nested = error instanceof AggregateError ? [...error.errors] as unknown[] : []
  if (error instanceof Error && error.cause !== undefined) nested.push(error.cause)
  if (!nested.length) return [error]
  if (nested.length > 32) throw new Error('Expected error chain has too many branches')
  const next = new Set(ancestors).add(error)
  return nested.flatMap(child => errorLeaves(child, next, depth + 1, budget))
}
async function followup(host: Host, expectedError?: Error) {
  const errors: unknown[] = []
  const remove = host.ctx.on('agent/error', ({ agent, error }) => {
    if (agent === host.agent) errors.push(error)
  })
  try {
    host.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue naturally.' }], source: { kind: 'user' } }))
    await host.agent.whenIdle()
    if (expectedError === undefined && errors.length) throw new AggregateError(errors, 'Natural followup failed')
    if (expectedError !== undefined) {
      expect(errors).toHaveLength(1)
      const leaves = errorLeaves(errors[0])
      expect(leaves.length).toBeGreaterThan(0)
      for (const error of leaves) expect(error).toBe(expectedError)
    }
  } finally { remove() }
}

describe('durable replacements in the real next request', () => {
  it('does not execute at command time and consumes the frozen selection before the next request', async () => {
    const { host, original } = await history()
    const request = await schedule(host)
    expect((await host.ctx.sessionQuery.readSurface(host.agent.session.id)).events.some(event => event.seq === original.seq)).toBe(true)
    await followup(host)
    expect(host.requests.length).toBe(3)
    const sent = host.requests.at(-1)!
    const tool = sent.find(message => message.role === 'tool')
    expect(tool?.content).not.toEqual(original.data.message.content)
    expect(tool?.role === 'tool' && tool.toolCallId).toBe(original.data.message.toolCallId)
    const excerpt = sent.find(message => message.role === 'user' && message.source.kind === 'dsh-shake-excerpt')
    expect(excerpt?.content).toEqual([{ type: 'text', text:
      '[Historical assistant excerpt; removed text is available through shake_read.]\nbefore\n'
      + `[Removed text; shake_read ref="shake:1:${request.operationId}:${request.requestSeq}:1"]\nafter` }])
    const state = readShakeState(host.ctx.sessionProjections, host.agent.session)
    expect(state.current).toBeNull()
    expect(state.lastResult).toMatchObject({ status: 'completed', removedRegions: request.regions.length, skippedRegions: 0 })
    expect(state.lastResult!.estimatedTokensSaved).toBeGreaterThan(0)
    expect((await host.ctx.sessionQuery.readEvent({ sessionId: host.agent.session.id, seq: original.seq })).target).toEqual(original)
  }, 30000)

  it('skips another operation’s replacement without chasing or restoring its text', async () => {
    const { host, original } = await history()
    const request = await schedule(host)
    let replacementSeq: number | undefined
    const remove = host.ctx.on('agent/pre-step', (payload, next) => {
      if (payload.agent === host.agent && replacementSeq === undefined) {
        const event = host.agent.session.append('tool/result', { ...original.data,
          message: { ...original.data.message, content: [{ type: 'text', text: 'Other operation’s retained result' }] } },
        { surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq }, sourceEventSeqs: [original.seq] })
        replacementSeq = event.seq
      }
      return next()
    }, { prepend: true })
    try { await followup(host) } finally { remove() }
    const sent = host.requests.at(-1)!
    expect(sent.find(message => message.role === 'tool')?.content).toEqual([{ type: 'text', text: 'Other operation’s retained result' }])
    expect(readShakeState(host.ctx.sessionProjections, host.agent.session).lastResult).toMatchObject({
      status: 'completed', removedRegions: request.regions.length - 1, skippedRegions: 1,
    })
    expect((await host.ctx.sessionQuery.traceEvent({ sessionId: host.agent.session.id, seq: original.seq })).replacedBy).toBe(replacementSeq)
  }, 30000)

  it('counts an already-landed replacement from its actual log trace without submitting it again', async () => {
    const { host, original } = await history()
    const request = await schedule(host)
    let landedSeq: number | undefined
    const remove = host.ctx.on('agent/pre-step', (payload, next) => {
      if (payload.agent === host.agent && landedSeq === undefined) {
        const selections = request.regions.map((region, regionIndex) => ({ region, regionIndex }))
          .filter(selection => selection.region.eventSeq === original.seq)
        const rendered = renderShakeMessage(original.data.message, original.seq, selections, request, host.ctx.tokenMeter)
        if (!rendered || rendered.message.role !== 'tool') throw new Error('Unprofitable interrupted fixture')
        host.agent.session.append('compaction/prune', {
          shadowedRange: { start: original.seq, end: original.seq }, shadowedSeqs: [original.seq],
          shadowedTokenCount: host.ctx.tokenMeter.estimateMessage(original.data.message),
        })
        const event = host.agent.session.append('tool/result', { ...original.data, message: rendered.message },
          { surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq },
            sourceEventSeqs: [original.seq, SessionSeq(request.requestSeq)] })
        landedSeq = event.seq
      }
      return next()
    }, { prepend: true })
    try { await followup(host) } finally { remove() }
    const log = await host.ctx.sessionQuery.readSession(host.agent.session.id)
    const replacements = log.events.filter(event => event.type === 'tool/result'
      && event.sourceEventSeqs?.some(seq => Number(seq) === request.requestSeq))
    expect(replacements.map(event => Number(event.seq))).toEqual([landedSeq])
    expect(readShakeState(host.ctx.sessionProjections, host.agent.session).lastResult).toMatchObject({
      status: 'completed', removedRegions: request.regions.length, skippedRegions: 0,
    })
  }, 30000)

  it('blocks request visibility and records failure when the durability checkpoint rejects', async () => {
    const { host } = await history()
    await schedule(host)
    const before = host.requests.length
    const expectedError = new Error('Injected durability failure')
    const remove = host.ctx.on('session/flush', () => { throw expectedError })
    try { await followup(host, expectedError) } finally { remove() }
    expect(host.requests.length).toBe(before)
    const state = readShakeState(host.ctx.sessionProjections, host.agent.session)
    expect(state.current).not.toBeNull()
    expect(state.lastResult).toMatchObject({ status: 'failed', removedRegions: 0 })
  }, 30000)

  it('reduces the public pressure projection when replacing an occupied assistant message', async () => {
    const { host } = await history(true)
    const surface = await host.ctx.sessionQuery.readSurface(host.agent.session.id)
    const assistant = surface.events.find(event => event.type === 'assistant/message'
      && event.data.message.content.some(block => block.type === 'text' && block.text.startsWith('before')))! 
    if (assistant.type !== 'assistant/message') throw new Error('Missing assistant history')
    await followup(host)
    const anchored = await host.ctx.sessionQuery.readSurface(host.agent.session.id)
    expect(anchored.events.find(event => event.type === 'assistant/message'
      && event.data.message.content.some(block => block.type === 'text' && block.text === 'Usage anchor.')))
      .toMatchObject({ data: { usage: { inputTokens: 10000, outputTokens: 1 } } })
    await schedule(host)
    const prices: { removed: number, occupied: number }[] = []
    const remove = host.ctx.on('session/flush', () => {
      const state = readShakeState(host.ctx.sessionProjections, host.agent.session)
      const pressure = host.ctx.sessionProjections.stateOf(host.agent.session, 'contextPressure')!
      if (state.lastResult?.status === 'executing') prices.push({ removed: state.lastResult.removedRegions,
        occupied: pressure.pressureTokens! + pressure.surfaceTokens - pressure.sampledSurfaceTokens! })
    })
    try { await followup(host) } finally { remove() }
    expect(prices.map(price => price.removed)).toEqual([0, 1, 2])
    expect(prices[2]!.occupied).toBeLessThan(prices[1]!.occupied - 1000)
    const log = await host.ctx.sessionQuery.readSession(host.agent.session.id)
    const replacement = log.events.findIndex(event => event.type === 'user/message'
      && event.data.source.kind === 'dsh-shake-excerpt')
    expect(log.events[replacement - 1]).toMatchObject({ type: 'compaction/prune', data: {
      shadowedSeqs: [assistant.seq], shadowedTokenCount: host.ctx.tokenMeter.estimateMessage(assistant.data.message),
    } })
  }, 30000)

  it.each([false, true])('recovers an aborted rejected completion checkpoint (clear=%s)', async clear => {
    const { host } = await history()
    const request = await schedule(host)
    const before = host.requests.length
    // Drain existing persistence before installing the deferred checkpoint.
    await host.ctx.sessions.flush(host.agent.session)
    let reached!: () => void
    const checkpoint = new Promise<void>(resolve => { reached = resolve })
    let reject!: (error: Error) => void
    const held = new Promise<void>((_resolve, fail) => { reject = fail })
    let intercepted = false
    const remove = host.ctx.on('session/flush', session => {
      const state = readShakeState(host.ctx.sessionProjections, host.agent.session)
      if (session === host.agent.session && !intercepted
        && state.lastResult?.operationId === request.operationId
        && state.lastResult.requestSeq === request.requestSeq
        && state.lastResult.status === 'completed' && (state.current === null) === clear) {
        intercepted = true
        reached()
        return held
      }
    })
    let settle!: (error: unknown) => void
    const outcome = new Promise<unknown>(resolve => { settle = resolve })
    const intercept = host.ctx.on('agent/pre-step', async (payload, next) => {
      if (payload.agent !== host.agent) return next()
      expect(payload.step).toBe(1)
      expect(host.ctx.sessionProjections.stateOf(host.agent.session, 'turnBoundary')!.lastTurn).toBe(payload.turn)
      try { await executePendingShake(host.ctx, payload.agent, payload.signal) }
      catch (error) { settle(error); return { kind: 'reject' } }
      throw new Error('Expected canceled checkpoint rejection')
    }, { prepend: true })
    host.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Start cancellable recovery.' }], source: { kind: 'user' } }))
    await checkpoint
    host.agent.cancel({ kind: 'user' })
    const atAbort = (await host.ctx.sessionQuery.readSession(host.agent.session.id)).events.length
    reject(new Error('Rejected deferred completion flush'))
    expect(await outcome).toMatchObject({ message: 'Rejected deferred completion flush' })
    remove()
    await host.agent.whenIdle()
    intercept()
    expect((await host.ctx.sessionQuery.readSession(host.agent.session.id)).events.slice(atAbort)
      .every(event => event.type === 'turn/end')).toBe(true)
    expect((await host.ctx.sessionQuery.readSession(host.agent.session.id)).events.at(-1))
      .toMatchObject({ type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
    expect(host.requests.length).toBe(before)
    const state = readShakeState(host.ctx.sessionProjections, host.agent.session)
    expect(state.lastResult?.status).toBe('completed')
    expect(state.current === null).toBe(clear)
    if (clear) {
      const expectedError = new Error('Clear remains unconfirmed')
      const block = host.ctx.on('session/flush', () => { throw expectedError })
      try { await followup(host, expectedError) } finally { block() }
      expect(host.requests.length).toBe(before)
    }
    await followup(host)
    expect(host.requests.length).toBe(before + 1)
    expect(readShakeState(host.ctx.sessionProjections, host.agent.session).current).toBeNull()
  }, 30000)
})
