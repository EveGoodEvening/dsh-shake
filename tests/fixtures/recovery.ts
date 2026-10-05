import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as shake from '../../src/index.js'
import { parseShakeConfig } from '../../src/config.js'
import { readShakeState, formatShakeRef } from '../../src/state.js'
import type { ShakeRequest } from '../../src/state.js'
import { readShakeText } from '../../src/read.js'

interface Host {
  ctx: Context; agent: Agent; requests: Message[][]; directory: string; close(): Promise<void>
}
// Keep this fixture in its isolated published-package consumer resolution scope;
// bundling it would change host dependency resolution.
const fixtureUrl = new URL('../../.verification/contracts/published-contract.mjs', import.meta.url).href
const fixture = await import(fixtureUrl) as {
  createContractHost(options?: Record<string, unknown>): Promise<Host>
  prepareToolHistory(host: Host): Promise<SessionEvent<'tool/result'>>
  installRecoveryCoexistence(host: Host): Promise<{ prune(): Promise<{ pruned: { originalSeq: number; replacementSeq: number }[] }>; compact(): Promise<unknown> }>
}
const policy = parseShakeConfig({ protectedTokens: 0 })
const assistantText = 'Retained before\n```ts\n' + 'const evidence = 123;\n'.repeat(800) + '```\nRetained after'
const state = (host: Host) => readShakeState(host.ctx.sessionProjections, host.agent.session)
const log = (host: Host) => host.ctx.sessionQuery.readSession(host.agent.session.id)
async function attach(host: Host) { await host.ctx.plugin(shake, policy); return host }
async function schedule(host: Host) {
  const before = host.requests.length
  const outcome = await host.ctx.commands.execute(host.agent, '/shake', [], new AbortController().signal)
  assert.equal(outcome?.result.kind, 'success')
  assert.equal(host.requests.length, before)
  const request = state(host).current
  assert.ok(request)
  return structuredClone(request)
}
async function natural(host: Host, allowError = false) {
  const errors: unknown[] = []
  const remove = host.ctx.on('agent/error', ({ agent, error }) => { if (agent === host.agent) errors.push(error) })
  try {
    host.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue naturally after recovery.' }], source: { kind: 'user' } }))
    await host.agent.whenIdle()
    if (!allowError && errors.length) throw new AggregateError(errors, 'Natural recovery failed')
    return errors
  } finally { remove() }
}
function replacements(events: readonly SessionEvent[], request: ShakeRequest) {
  return events.filter(event => (event.type === 'tool/result' || event.type === 'user/message')
    && event.sourceEventSeqs?.includes(request.requestSeq as never))
}
async function page(host: Host, request: ShakeRequest, regionIndex = 0) {
  return readShakeText(host.ctx, host.agent, { ref: formatShakeRef({ version: 1,
    operationId: request.operationId, requestSeq: request.requestSeq, regionIndex }), limit: 37 }, new AbortController().signal, policy)
}
async function scoped<T>(run: (open: (options?: Record<string, unknown>) => Promise<Host>) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), 'shake-c09-'))
  const hosts: Host[] = []
  try {
    return await run(async options => {
      const host = await fixture.createContractHost({ directory, assistantText, ...options })
      hosts.push(host)
      return attach(host)
    })
  } finally {
    for (const host of hosts.reverse()) await host.close()
    await rm(directory, { recursive: true, force: true })
  }
}

export async function pendingRestart() {
  return scoped(async open => {
    const parent = await open()
    await fixture.prepareToolHistory(parent)
    const request = await schedule(parent)
    const before = parent.agent.session.deriveMessages()
    const id = parent.agent.session.id
    await parent.close()
    const resumed = await open({ resumeId: id })
    assert.deepEqual(state(resumed).current, request)
    assert.equal(resumed.requests.length, 0, 'reopen must not execute pending intent')
    assert.deepEqual(resumed.agent.session.deriveMessages(), before)
    await natural(resumed)
    assert.ok(resumed.requests.length > 0)
    assert.deepEqual(state(resumed).lastResult && { status: state(resumed).lastResult!.status,
      removed: state(resumed).lastResult!.removedRegions }, { status: 'completed', removed: request.regions.length })
    assert.equal(state(resumed).current, null)
    const landed = replacements((await log(resumed)).events, request)
    assert.equal(landed.length, new Set(request.regions.map(region => region.eventSeq)).size)
    const original = (await resumed.ctx.sessionQuery.readEvent({ sessionId: resumed.agent.session.id,
      seq: request.regions[0]!.eventSeq as never, before: 0, after: 0 })).target
    const text = resumed.agent.session.deriveEventMessage(original)!.content[0]!
    assert.ok(text.type === 'text')
    assert.equal((await page(resumed, request)).text, Array.from(text.text).slice(0, 37).join(''))
    return { pendingReopenRequests: 0, completedRegions: request.regions.length }
  })
}

export async function partialRestart() {
  return scoped(async open => {
    const parent = await open()
    const original = await fixture.prepareToolHistory(parent)
    const request = await schedule(parent)
    let landedSeq: number | undefined
    const remove = parent.ctx.on('session/event', (session, event) => {
      if (session === parent.agent.session && event.type === 'tool/result'
        && event.sourceEventSeqs?.includes(request.requestSeq as never)) {
        landedSeq = Number(event.seq)
        parent.agent.cancel({ kind: 'user' }, { keepInbox: true })
      }
    })
    try { await natural(parent, true) } finally { remove() }
    assert.ok(landedSeq !== undefined, 'interrupt only after a genuine engine replacement commits')
    assert.equal(parent.requests.length, 2, 'interrupted pre-step must not reach LLM')
    assert.equal(state(parent).lastResult?.status, 'executing')
    assert.equal(state(parent).lastResult?.removedRegions, 0, 'replacement lands before progress control is appended')
    assert.equal((await parent.ctx.sessionQuery.traceEvent({ sessionId: parent.agent.session.id, seq: original.seq })).replacedBy, landedSeq)
    assert.equal(await parent.ctx.sessions.flush(parent.agent.session), true)
    const id = parent.agent.session.id
    await parent.close()
    const resumed = await open({ resumeId: id })
    assert.deepEqual(state(resumed).current, request, 'frozen policy, cutoff, identities and selections survive')
    assert.equal(resumed.requests.length, 0)
    await natural(resumed)
    const rows = replacements((await log(resumed)).events, request)
    assert.equal(rows.filter(event => event.type === 'tool/result').length, 1)
    assert.equal(rows.find(event => event.type === 'tool/result')?.seq, landedSeq)
    assert.equal(state(resumed).lastResult?.removedRegions, request.regions.length)
    assert.equal(state(resumed).lastResult?.skippedRegions, 0)
    await page(resumed, request)
    return { interruptedAt: landedSeq, duplicateToolReplacements: 0, completedRegions: request.regions.length }
  })
}

export async function failedRestart() {
  return scoped(async open => {
    const parent = await open()
    await fixture.prepareToolHistory(parent)
    const request = await schedule(parent)
    const failure = new Error('C09 durability boundary failure')
    let fail = true
    const remove = parent.ctx.on('session/flush', session => {
      if (fail && session === parent.agent.session && state(parent).lastResult?.status === 'executing') {
        fail = false
        throw failure
      }
    })
    try { assert.ok((await natural(parent, true)).length > 0) } finally { remove() }
    assert.equal(state(parent).lastResult?.status, 'failed')
    assert.equal(parent.requests.length, 2)
    const id = parent.agent.session.id
    await parent.close()
    const resumed = await open({ resumeId: id })
    const before = replacements((await log(resumed)).events, request)
    assert.ok((await natural(resumed, true)).length > 0)
    assert.equal(resumed.requests.length, 0, 'durable failed operation is never automatically retried')
    assert.deepEqual(replacements((await log(resumed)).events, request), before)
    assert.equal(state(resumed).lastResult?.status, 'failed')
    return { failedAutomaticRequests: 0, failedAutomaticReplacements: 0 }
  })
}

export async function forkRecovery() {
  return scoped(async open => {
    const parent = await open()
    await fixture.prepareToolHistory(parent)
    const request = await schedule(parent)
    const prefix = (await log(parent)).events
    const child = await open({ seed: prefix, parentSessionId: parent.agent.session.id, sessionId: 'c09-pending-child' })
    assert.equal(state(child).current, null)
    assert.equal(child.requests.length, 0)
    const cancel = await child.ctx.commands.execute(child.agent, '/shake cancel', [], new AbortController().signal)
    assert.equal(cancel?.result.kind, 'success')
    assert.equal(state(child).current, null)
    const own = await schedule(child)
    assert.equal(own.sessionId, child.agent.session.id)
    assert.deepEqual(own.regions, request.regions, 'child may select eligible originals from its inherited scope')
    await natural(child)
    assert.equal(state(child).lastResult?.operationId, own.operationId)
    assert.deepEqual(state(parent).current, request, 'child must never execute or clear parent intent')
    assert.equal(parent.requests.length, 2)
    await assert.rejects(page(child, request))
    await page(child, own)
    await natural(parent)
    const completePrefix = (await log(parent)).events
    const inherited = await open({ seed: completePrefix, parentSessionId: parent.agent.session.id, sessionId: 'c09-completed-child' })
    const readEvent = inherited.ctx.sessionQuery.readEvent.bind(inherited.ctx.sessionQuery)
    const traceEvent = inherited.ctx.sessionQuery.traceEvent.bind(inherited.ctx.sessionQuery)
    const queries: string[] = []
    const services = { tokenMeter: inherited.ctx.tokenMeter, sessionQuery: {
      readEvent: ((query: Parameters<typeof readEvent>[0], signal?: AbortSignal) => {
        queries.push(query.sessionId); assert.equal(query.sessionId, inherited.agent.session.id)
        assert.equal(query.before, 0); assert.equal(query.after, 0)
        return readEvent(query, signal)
      }) as typeof readEvent,
      traceEvent: ((query: Parameters<typeof traceEvent>[0], signal?: AbortSignal) => {
        queries.push(query.sessionId); assert.equal(query.sessionId, inherited.agent.session.id)
        return traceEvent(query, signal)
      }) as typeof traceEvent,
    } }
    const inheritedPage = await readShakeText(services, inherited.agent, { ref: formatShakeRef({ version: 1,
      operationId: request.operationId, requestSeq: request.requestSeq, regionIndex: 0 }), limit: 37 }, new AbortController().signal, policy)
    assert.equal(inheritedPage.text, (await page(parent, request)).text)
    assert.equal(queries.length, 6)
    const unrelated = await open({ sessionId: 'c09-unrelated-owner' })
    await assert.rejects(page(unrelated, request))
    assert.equal(unrelated.requests.length, 0)
    return { inheritedPendingExecuted: false, parentUnaffectedByChild: true, inheritedReadQueries: queries.length, crossOwnerDenied: true }
  })
}

export async function completionRestart(clear: boolean) {
  return scoped(async open => {
    const parent = await open()
    await fixture.prepareToolHistory(parent)
    const request = await schedule(parent)
    let interrupted = false
    const remove = parent.ctx.on('session/event', (session, event) => {
      if (session === parent.agent.session && event.type === 'user/message'
        && event.data.source.kind === 'dsh-shake-control'
        && event.data.source.lastResult?.status === 'completed'
        && (event.data.source.current === null) === clear) {
        interrupted = true
        parent.agent.cancel({ kind: 'user' }, { keepInbox: true })
      }
    })
    try { await natural(parent, true) } finally { remove() }
    assert.equal(interrupted, true)
    assert.equal(parent.requests.length, 2)
    const landed = replacements((await log(parent)).events, request)
    await parent.ctx.sessions.flush(parent.agent.session)
    const id = parent.agent.session.id
    await parent.close()
    const resumed = await open({ resumeId: id })
    assert.equal(resumed.requests.length, 0)
    await natural(resumed)
    assert.equal(state(resumed).current, null)
    assert.equal(state(resumed).lastResult?.status, 'completed')
    assert.deepEqual(replacements((await log(resumed)).events, request), landed)
    return { boundary: clear ? 'clear' : 'staged', duplicateReplacements: 0 }
  })
}

export async function coexistence(kind: 'prune' | 'compact', afterPlan: boolean) {
  return scoped(async open => {
    const host = await open({ laterResponseCount: 2 })
    const original = await fixture.prepareToolHistory(host)
    const operations = await fixture.installRecoveryCoexistence(host)
    const requestBefore = afterPlan ? await schedule(host) : null
    let pruningReplacementSeq: number | null = null
    if (kind === 'prune') {
      const result = await operations.prune()
      const replacement = result.pruned.find(entry => entry.originalSeq === original.seq)
      assert.ok(replacement)
      pruningReplacementSeq = replacement.replacementSeq
      const event = (await log(host)).events.find(event => event.seq === replacement.replacementSeq)
      assert.equal(event?.type, 'tool/result')
      assert.deepEqual(event?.sourceEventSeqs, [original.seq])
    } else {
      assert.ok(await operations.compact(), 'public idle compaction must commit a useful summary')
    }
    const externalSurface = (await host.ctx.sessionQuery.readSurface(host.agent.session.id)).events
    assert.equal(externalSurface.some(event => event.seq === original.seq), false)
    let request = requestBefore
    if (!request) {
      const outcome = await host.ctx.commands.execute(host.agent, '/shake', [], new AbortController().signal)
      assert.equal(outcome?.result.kind, 'success')
      request = state(host).current
    }
    if (!afterPlan && request) assert.equal(request.regions.some(region => region.eventSeq === original.seq), false)
    await natural(host)
    const current = (await host.ctx.sessionQuery.readSurface(host.agent.session.id)).events
    assert.equal(current.some(event => event.seq === original.seq), false, 'shake must not resurrect a removed original')
    const landed = request ? replacements((await log(host)).events, request) : []
    assert.equal(landed.some(event => event.sourceEventSeqs?.includes(original.seq)), false)
    if (afterPlan) assert.ok((state(host).lastResult?.skippedRegions ?? 0) > 0)
    const messages = host.agent.session.deriveMessages()
    assert.equal(new Set(messages.map(message => message.id)).size, messages.length, 'no duplicate prefix messages')
    const id = host.agent.session.id
    await host.close()
    const resumed = await open({ resumeId: id })
    assert.deepEqual(resumed.agent.session.deriveMessages(), messages)
    return { kind, afterPlan, pruningReplacementSeq, resurrectedOriginals: 0, duplicatePrefixMessages: 0 }
  })
}

export async function compactedAuthorization() {
  return scoped(async open => {
    const host = await open()
    const original = await fixture.prepareToolHistory(host)
    const request = await schedule(host)
    await natural(host)
    const expected = await page(host, request)
    const operations = await fixture.installRecoveryCoexistence(host)
    assert.ok(await operations.compact(), 'full idle compaction must commit')
    const compacted = await host.ctx.sessionQuery.readSurface(host.agent.session.id)
    assert.equal(compacted.events.some(event => event.seq === request.requestSeq), false)
    assert.deepEqual(await page(host, request), expected, 'raw-log authority survives full surface compaction')
    const seed = (await log(host)).events.map(event => event.seq === original.seq && event.type === 'tool/result'
      ? { ...event, data: { ...event.data, message: { ...event.data.message,
        content: event.data.message.content.map((block, index) => index === 0 && block.type === 'text'
          ? { ...block, text: '!' + block.text.slice(1) } : block) } } } : event)
    const corrupt = await open({ seed, parentSessionId: host.agent.session.id, sessionId: 'c09-checksum-corrupt' })
    await assert.rejects(page(corrupt, request), /not authorized/)
    const absent = await open({ sessionId: 'c09-missing-original' })
    await assert.rejects(page(absent, request))
    const messages = host.agent.session.deriveMessages()
    const id = host.agent.session.id
    await host.close()
    const resumed = await open({ resumeId: id })
    assert.deepEqual(resumed.agent.session.deriveMessages(), messages)
    assert.deepEqual(await page(resumed, request), expected)
    assert.equal(resumed.requests.length, 0)
    return { controlOffSurface: true, compactedReopenRead: true, corruptChecksumDenied: true, missingLogDenied: true }
  })
}

export async function runRecoverySmoke() {
  const evidence = { pending: await pendingRestart(), partial: await partialRestart(), failed: await failedRestart(),
    fork: await forkRecovery(), completion: [await completionRestart(false), await completionRestart(true)],
    coexistence: [await coexistence('prune', false), await coexistence('prune', true),
      await coexistence('compact', false), await coexistence('compact', true)],
    authorization: await compactedAuthorization() }
  return evidence
}
