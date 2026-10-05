import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as shake from '../../src/index.js'
import { parseShakeConfig } from '../../src/config.js'
import { partialRestart } from './recovery.js'
import { readShakeState, formatShakeRef } from '../../src/state.js'

interface Host { ctx: Context; agent: Agent; requests: Message[][]; close(): Promise<void> }
// Runtime URL preserves the isolated published consumer resolution boundary;
// static bundling would resolve host services from this project's scope.
const fixtureUrl = new URL('../../.verification/contracts/published-contract.mjs', import.meta.url).href
const fixture = await import(fixtureUrl) as {
  createContractHost(options?: Record<string, unknown>): Promise<Host>
  prepareToolHistory(host: Host): Promise<unknown>
  installRecoveryCoexistence(host: Host, options?: Record<string, unknown>): Promise<unknown>
}
const policy = parseShakeConfig({ protectedTokens: 0 })
const assistantText = 'Before\n```ts\n' + 'const retained = 123;\n'.repeat(800) + '```\nAfter'
const signal = () => new AbortController().signal
const state = (h: Host) => readShakeState(h.ctx.sessionProjections, h.agent.session)
const command = (h: Host, line = '/shake', s = signal()) => h.ctx.commands.execute(h.agent, line, [], s)
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function scoped<T>(run: (open: (options?: Record<string, unknown>) => Promise<Host>) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), 'shake-c10-'))
  const hosts: Host[] = []
  try { return await run(async options => {
    const h = await fixture.createContractHost({ directory, assistantText, laterResponseCount: 12, ...options })
    hosts.push(h)
    return h
  }) } finally {
    for (const h of hosts.reverse()) await h.close()
    await rm(directory, { recursive: true, force: true })
  }
}
async function natural(h: Host, text = 'Continue naturally.') {
  h.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await h.agent.whenIdle()
}
function absent(h: Host) {
  assert.equal(h.ctx.commands.find(h.agent, 'shake'), undefined)
  assert.throws(() => state(h))
}
async function schedule(h: Host) {
  const before = h.requests.length
  assert.equal((await command(h))?.result.kind, 'success')
  assert.equal(h.requests.length, before)
  const request = state(h).current
  assert.ok(request)
  return structuredClone(request)
}

export async function commandAcceptance() {
  return scoped(async open => {
    const h = await open()
    await h.ctx.plugin(shake, policy)
    assert.equal((await command(h, '/shake cancel'))?.result.kind, 'success')
    assert.equal((await command(h))?.result.kind, 'success')
    assert.equal(state(h).current, null)
    assert.equal(h.requests.length, 0)
    for (const line of ['/shake invalid', '/shake cancel extra']) assert.equal((await command(h, line))?.result.kind, 'error')
    const attachment = await h.ctx.commands.execute(h.agent, '/shake', [{ type: 'file', receiptId: 'not-admitted' }], signal())
    assert.equal(attachment?.result.kind, 'error')
    const aborted = new AbortController(); aborted.abort(new Error('UI cancelled'))
    await assert.rejects(command(h, '/shake', aborted.signal))
    await fixture.prepareToolHistory(h)
    const request = await schedule(h)
    assert.equal((await command(h))?.result.kind, 'error')
    assert.deepEqual(state(h).current, request)
    const gate = deferred(), entered = deferred()
    const maintenance = h.agent.runMaintenance(async () => { entered.resolve(); await gate.promise })
    await entered.promise
    try {
      for (const line of ['/shake', '/shake cancel']) assert.equal((await command(h, line))?.result.kind, 'error')
      assert.deepEqual(state(h).current, request)
    } finally { gate.resolve(); await maintenance }
    assert.equal((await command(h, '/shake cancel'))?.result.kind, 'success')
    assert.equal(state(h).current, null)
    assert.equal(state(h).lastResult?.status, 'cancelled')
    assert.equal(h.requests.length, 2)
    return { commandAddedRequests: 0, frozenRepeatedRequest: true, idleCancelAddedRequests: 0 }
  })
}

export async function maintenanceInboxOrdering() {
  return scoped(async open => {
    const h = await open(); await h.ctx.plugin(shake, policy); await fixture.prepareToolHistory(h)
    const entered = deferred(), gate = deferred()
    const remove = h.ctx.on('session/flush', async session => {
      if (session === h.agent.session) { entered.resolve(); await gate.promise }
    })
    const before = h.requests.length
    const task = command(h)
    await entered.promise
    const frozen = structuredClone(state(h).current)
    assert.ok(frozen)
    try {
      for (const text of ['inbox-first', 'inbox-second']) h.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      assert.equal(h.requests.length, before, 'plugin-owned maintenance must defer model requests')
      assert.deepEqual(state(h).current, frozen, 'queued inputs must not expand frozen selection')
      gate.resolve()
      assert.equal((await task)?.result.kind, 'success')
      await h.agent.whenIdle()
    } finally { gate.resolve(); remove() }
    const requestTexts = h.requests.slice(before).map(request => request
      .filter(m => m.role === 'user')
      .flatMap(m => m.content.filter(b => b.type === 'text').map(b => b.text)))
    const diagnostic = JSON.stringify(requestTexts)
    const firstRequest = requestTexts.findIndex(texts => texts.includes('inbox-first'))
    const secondRequest = requestTexts.findIndex(texts => texts.includes('inbox-second'))
    assert.ok(firstRequest >= 0, `first queued input must reach a natural request: ${diagnostic}`)
    assert.ok(secondRequest >= firstRequest, `second queued input must follow first: ${diagnostic}`)
    for (const texts of requestTexts) {
      const first = texts.indexOf('inbox-first'), second = texts.indexOf('inbox-second')
      if (first >= 0 && second >= 0) assert.ok(second > first, `coalesced input order: ${diagnostic}`)
    }
    assert.equal(state(h).current, null)
    assert.equal(state(h).lastResult?.removedRegions, frozen.regions.length)
    assert.ok(frozen.regions.every(region => frozen.cutoffSeq !== null && region.eventSeq <= frozen.cutoffSeq))
    return { maintenanceInboxOrdered: true, requestTexts }
  })
}

export async function pendingUnloadReload() {
  return scoped(async open => {
    const h = await open(); const fork = h.ctx.plugin(shake, policy); await fork
    await fixture.prepareToolHistory(h); const request = await schedule(h)
    const before = h.requests.length
    await fork.dispose(); absent(h)
    const missing = await h.ctx.tools.execute({ callId: ToolCallId('unloaded-read'), name: 'shake_read', arguments: { ref: 'invalid' }, agent: h.agent, signal: signal() })
    assert.equal(missing.isError, true)
    assert.equal(h.requests.length, before)
    const id = h.agent.session.id
    await h.close()
    const reopened = await open({ resumeId: id }); const loaded = reopened.ctx.plugin(shake, policy); await loaded
    assert.deepEqual(state(reopened).current, request)
    assert.equal(reopened.requests.length, 0)
    await natural(reopened)
    assert.equal(state(reopened).current, null)
    assert.equal(state(reopened).lastResult?.removedRegions, request.regions.length)
    await loaded.dispose(); absent(reopened)
    const noPluginBefore = reopened.requests.length
    await natural(reopened, 'Continue without the plugin interpreter.')
    assert.equal(reopened.requests.length, noPluginBefore + 1)
    return { pendingUnloadRequests: 0, reloadCompletedRegions: request.regions.length, hostWorksWithoutPlugin: true }
  })
}

export async function activeUnload(kind: 'command' | 'execution' | 'read') {
  return scoped(async open => {
    const h = await open(); const fork = h.ctx.plugin(shake, policy); await fork
    await fixture.prepareToolHistory(h)
    const entered = deferred(), gate = deferred()
    let request = kind === 'command' ? null : await schedule(h)
    if (kind === 'read') await natural(h)
    let restore: () => void
    if (kind === 'read') {
      const original = h.ctx.sessionQuery.readEvent.bind(h.ctx.sessionQuery)
      h.ctx.sessionQuery.readEvent = async (...args) => { entered.resolve(); await gate.promise; return original(...args) }
      restore = () => { h.ctx.sessionQuery.readEvent = original }
    } else {
      restore = h.ctx.on('session/flush', async session => {
        if (session === h.agent.session) { entered.resolve(); await gate.promise }
      })
    }
    const before = h.requests.length
    const operation = kind === 'command' ? command(h).then(() => undefined, () => undefined)
      : kind === 'execution' ? natural(h)
      : h.ctx.tools.execute({ callId: ToolCallId('unload-active-read'), name: 'shake_read',
        arguments: { ref: formatShakeRef({ version: 1, operationId: request!.operationId, requestSeq: request!.requestSeq, regionIndex: 0 }), limit: 17 },
        agent: h.agent, signal: signal() }).then(result => { assert.equal(result.isError, true) })
    await entered.promise
    if (kind === 'execution') {
      for (const line of ['/shake', '/shake', '/shake cancel']) {
        assert.equal((await command(h, line))?.result.kind, 'error')
        assert.deepEqual(state(h).current, request, 'busy commands cannot mutate frozen executing selection')
        assert.equal(h.requests.length, before)
      }
    }
    const stopping = fork.dispose()
    await Promise.resolve()
    assert.equal(h.ctx.commands.find(h.agent, 'shake'), undefined, 'unregister before draining blocked operations')
    let drained = false; void stopping.then(() => { drained = true })
    await Promise.resolve(); assert.equal(drained, false, 'dispose must await in-flight work')
    const events = await h.ctx.sessionQuery.readSession(h.agent.session.id)
    const ownBefore = events.events.filter(e => e.type === 'user/message' && e.data.source.kind === 'dsh-shake-control').length
    gate.resolve()
    try { await Promise.all([operation, stopping]) } finally { restore() }
    absent(h)
    assert.equal(h.requests.length, before, 'aborted plugin pre-step must not release a model request')
    const after = await h.ctx.sessionQuery.readSession(h.agent.session.id)
    assert.equal(after.events.filter(e => e.type === 'user/message' && e.data.source.kind === 'dsh-shake-control').length, ownBefore, 'no plugin append after disposal begins')
    const reloaded = h.ctx.plugin(shake, policy); await reloaded
    if (kind !== 'read') {
      request = state(h).current
      assert.ok(request)
      await natural(h)
      assert.equal(state(h).current, null)
      assert.equal(state(h).lastResult?.status, 'completed')
    }
    await reloaded.dispose()
    return { kind, drained: true, afterUnloadRequests: 0, afterUnloadControlAppends: 0 }
  })
}

export async function persistenceFailuresAndConflicts() {
  return scoped(async open => {
    // Cordis drains disposal and reports cleanup errors through public exporters;
    // its logger expands AggregateError into the underlying durability failures.
    const disposeDiagnostics = async (host: Host, fork: { dispose(): Promise<void> }) => {
      const errors: string[] = []
      const remove = host.ctx.logger.exporter({ export(message) {
        if (message.type === 'error') errors.push(message.args.map(arg => arg instanceof Error ? arg.stack ?? arg.message : String(arg)).join(' '))
      } })
      try { await fork.dispose() } finally { remove() }
      return errors
    }
    const h = await open({ persistence: false }); const unsupported = h.ctx.plugin(shake, policy); await unsupported
    await fixture.prepareToolHistory(h)
    assert.equal((await command(h))?.result.kind, 'error')
    assert.equal(h.requests.length, 2)
    const unsupportedDiagnostics = await disposeDiagnostics(h, unsupported)
    assert.ok(unsupportedDiagnostics.some(error => error.includes('没有会话保存监听器')), JSON.stringify(unsupportedDiagnostics))
    absent(h)
    const durable = await open({ sessionId: 'flush-failure' }); const failing = durable.ctx.plugin(shake, policy); await failing
    await fixture.prepareToolHistory(durable)
    let flushAttempts = 0
    let flushDiagnostics: string[] = []
    const remove = durable.ctx.on('session/flush', () => { flushAttempts++; throw new Error('deliberate persistence failure') })
    try {
      assert.equal((await command(durable))?.result.kind, 'error')
      const beforeUnload = flushAttempts
      flushDiagnostics = await disposeDiagnostics(durable, failing)
      assert.ok(flushDiagnostics.some(error => error.includes('deliberate persistence failure')), JSON.stringify(flushDiagnostics))
      assert.equal(flushAttempts, beforeUnload + 1, 'unload makes exactly one bounded unresolved durability attempt')
      absent(durable)
    } finally { remove() }
    assert.equal(durable.requests.length, 2)
    for (const conflict of ['command', 'tool'] as const) {
      const host = await open({ sessionId: 'conflict-' + conflict })
      const unregister = conflict === 'command'
        ? host.ctx.commands.register({ name: 'shake', description: 'existing owner', handler: () => ({ kind: 'success', text: 'existing' }) })
        : host.ctx.tools.register(defineTool({ name: 'shake_read', description: 'existing owner', parameters: {},
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'existing' }))
      const failed = host.ctx.plugin(shake, policy)
      try { await assert.rejects(Promise.resolve(failed)) } finally { await failed.dispose(); unregister() }
      assert.equal(host.ctx.commands.find(host.agent, 'shake'), undefined)
      const clean = host.ctx.plugin(shake, policy); await clean; await clean.dispose(); absent(host)
    }
    return { missingPersistenceCommandRejected: true, failedFlushCommandRejected: true, disposalRejects: false,
      unsupportedDiagnostics, flushDiagnostics, conflictsRejected: 2 }
  })
}

export async function concurrentSessions() {
  return scoped(async open => {
    const a = await open({ sessionId: 'concurrent-a' })
    await a.ctx.plugin(shake, policy)
    await fixture.prepareToolHistory(a)
    const seed = (await a.ctx.sessionQuery.readSession(a.agent.session.id)).events
    const handle = await a.ctx.agents.create({ sessionId: SessionId('concurrent-b'),
      meta: { isSeeded: true, parentSession: a.agent.session.id }, seed, inheritedEventCount: SessionLogOffset(seed.length),
      agentOptions: { provider: 'contract-replay', model: 'contract-model' } })
    const b: Host = { ...a, agent: handle.agent, close: () => handle.dispose() }
    try {
      const [ra, rb] = await Promise.all([schedule(a), schedule(b)])
      assert.notEqual(ra.operationId, rb.operationId)
      await command(a, '/shake cancel')
      assert.deepEqual(state(b).current, rb)
      await Promise.all([natural(a), natural(b)])
      assert.equal(state(a).lastResult?.status, 'cancelled')
      assert.equal(state(b).lastResult?.status, 'completed')
      assert.equal(state(b).lastResult?.removedRegions, rb.regions.length)
      return { isolatedConcurrentSessions: 2, sharedRuntime: true }
    } finally { await handle.dispose() }
  })
}

export async function automaticCompaction() {
  return scoped(async open => {
    const h = await open({ usageAnchor: true }); await h.ctx.plugin(shake, policy)
    await fixture.prepareToolHistory(h)
    await natural(h, 'Protected user evidence remains after shake.\n'.repeat(600))
    await fixture.installRecoveryCoexistence(h, { thresholdRatio: 0.01 })
    const request = await schedule(h)
    const before = (await h.ctx.sessionQuery.readSession(h.agent.session.id)).events
    await natural(h, 'Trigger the public automatic compaction request path.')
    const after = (await h.ctx.sessionQuery.readSession(h.agent.session.id)).events
    assert.equal(state(h).current, null)
    assert.equal(state(h).lastResult?.status, 'completed')
    assert.ok(after.filter(e => e.type === 'compaction/summary').length > before.filter(e => e.type === 'compaction/summary').length, 'natural request must trigger host automatic compaction')
    assert.equal(state(h).lastResult?.removedRegions, request.regions.length)
    const region = request.regions[0]!
    const original = (await h.ctx.sessionQuery.readEvent({ sessionId: h.agent.session.id,
      seq: region.eventSeq as never, before: 0, after: 0 })).target
    const block = h.agent.session.deriveEventMessage(original)!.content[region.blockIndex]!
    assert.equal(block.type, 'text')
    assert.ok(block.type === 'text')
    const expected = Array.from(block.text.slice(region.start, region.end)).slice(0, 37).join('')
    const ref = formatShakeRef({ version: 1, operationId: request.operationId, requestSeq: request.requestSeq, regionIndex: 0 })
    const readPage = async (host: Host) => {
      const outcome = await host.ctx.tools.execute({ callId: ToolCallId('automatic-compaction-read'), name: 'shake_read',
        arguments: { ref, limit: 37 }, agent: host.agent, signal: signal() })
      assert.equal(outcome.isError, false)
      assert.ok(!outcome.isError)
      const page = outcome.value as { text: string }
      assert.equal(page.text, expected)
      return outcome.value
    }
    const page = await readPage(h)
    const derived = h.agent.session.deriveMessages()
    const replacements = after.filter(event => (event.type === 'tool/result' || event.type === 'user/message')
      && event.sourceEventSeqs?.includes(request.requestSeq as never)).map(event => event.seq)
    assert.equal(await h.ctx.sessions.flush(h.agent.session), true)
    const id = h.agent.session.id
    await h.close()
    const reopened = await open({ resumeId: id }); await reopened.ctx.plugin(shake, policy)
    assert.equal(reopened.requests.length, 0)
    assert.deepEqual(reopened.agent.session.deriveMessages(), derived)
    assert.deepEqual(await readPage(reopened), page)
    const reopenedLog = await reopened.ctx.sessionQuery.readSession(reopened.agent.session.id)
    assert.deepEqual(reopenedLog.events.filter(event => (event.type === 'tool/result' || event.type === 'user/message')
      && event.sourceEventSeqs?.includes(request.requestSeq as never)).map(event => event.seq), replacements)
    assert.equal(reopened.requests.length, 0)
    return { automaticCompactionNaturalPath: true, automaticCompactionReadExact: true, automaticCompactionReopenRequests: 0 }
  })
}

export async function cancellationSignals() {
  return scoped(async open => {
    const h = await open(); await h.ctx.plugin(shake, policy); await fixture.prepareToolHistory(h)
    for (const owner of ['ui', 'agent'] as const) {
      const entered = deferred(), gate = deferred(), ui = new AbortController()
      const remove = h.ctx.on('session/flush', async session => {
        if (session === h.agent.session) { entered.resolve(); await gate.promise }
      })
      const operation = command(h, '/shake', ui.signal).then(value => value?.result.kind, () => 'error')
      await entered.promise
      const frozen = structuredClone(state(h).current)
      const ownBefore = (await h.ctx.sessionQuery.readSession(h.agent.session.id)).events
        .filter(e => e.type === 'user/message' && e.data.source.kind === 'dsh-shake-control').length
      if (owner === 'ui') ui.abort(new Error('UI cancels command during flush'))
      else h.agent.cancel({ kind: 'user' }, { keepInbox: true })
      gate.resolve()
      try { assert.equal(await operation, 'error') } finally { remove() }
      await h.agent.whenIdle()
      assert.deepEqual(state(h).current, frozen)
      assert.equal((await h.ctx.sessionQuery.readSession(h.agent.session.id)).events
        .filter(e => e.type === 'user/message' && e.data.source.kind === 'dsh-shake-control').length, ownBefore)
      assert.equal(h.requests.length, 2)
      await command(h, '/shake cancel')
      assert.equal(state(h).current, null)
    }
    const request = await schedule(h); await natural(h)
    const entered = deferred(), gate = deferred(), abort = new AbortController()
    const original = h.ctx.sessionQuery.readEvent.bind(h.ctx.sessionQuery)
    h.ctx.sessionQuery.readEvent = async (...args) => { entered.resolve(); await gate.promise; return original(...args) }
    const operation = h.ctx.tools.execute({ callId: ToolCallId('caller-cancel-read'), name: 'shake_read',
      arguments: { ref: formatShakeRef({ version: 1, operationId: request.operationId, requestSeq: request.requestSeq, regionIndex: 0 }) },
      agent: h.agent, signal: abort.signal })
    await entered.promise; abort.abort(new Error('Tool caller cancels read')); gate.resolve()
    try { assert.equal((await operation).isError, true) } finally { h.ctx.sessionQuery.readEvent = original }
    return { uiCommandCancelled: true, agentMaintenanceCancelled: true, toolCallerCancelled: true }
  })
}

export async function runLifecycleSmoke() {
  return {
    commands: await commandAcceptance(), inbox: await maintenanceInboxOrdering(), pending: await pendingUnloadReload(),
    activeCommand: await activeUnload('command'), activeExecution: await activeUnload('execution'), activeRead: await activeUnload('read'),
    persistenceAndConflicts: await persistenceFailuresAndConflicts(), concurrent: await concurrentSessions(), compaction: await automaticCompaction(),
    signals: await cancellationSignals(),
    betweenWriteAgentCancellation: await partialRestart(),
  }
}
