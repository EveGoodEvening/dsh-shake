import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { CommandRuntime, parseCommand } from '@deepseek-ai/dsh-commands'
import { toolPairingBalancedBefore, toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction'
import { z } from 'zod'

// Temporary published-package consumer. The host module owns actual persistence,
// invariants, adapter composition and teardown; no private path is imported here.
export async function runInterfaces({ ctx, agent, evidence = [] }) {
  const session = agent.session
  assert.ok(session instanceof Session)
  assert.ok(ctx.sessionQuery instanceof SessionQueryEngine)
  assert.ok(ctx.sessionProjections instanceof SessionProjectionRegistry)
  assert.ok(ctx.tokenMeter instanceof TokenMeter)
  assert.ok(ctx.commands instanceof CommandRuntime)
  const query = ctx.sessionQuery
  const record = (name, value) => evidence.push({ name, value })
  const log = () => query.readSession(session.id)
  const disposers = []
  try {
    let maintenanceSignal
    let finishMaintenance
    const maintenanceGate = new Promise(resolve => { finishMaintenance = resolve })
    const heldMaintenance = agent.runMaintenance(async signal => { maintenanceSignal = signal; await maintenanceGate; return 'released' })
    try {
      assert.ok(maintenanceSignal instanceof AbortSignal, 'Maintenance task must start synchronously')
      assert.throws(() => agent.runMaintenance(async () => 'must not enter'))
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      assert.equal(maintenanceSignal.aborted, true)
    } finally { finishMaintenance(); assert.equal(await heldMaintenance, 'released'); await agent.whenIdle() }
    record('maintenance-atomic-ownership', { cancelled: maintenanceSignal.aborted, status: agent.status })
    assert.deepEqual(parseCommand('/contract_probe \t cancel'), { name: 'contract_probe', rawInput: ' \t cancel' })
    assert.equal(parseCommand(' /contract_probe'), undefined)
    let calls = 0
    let invocation
    disposers.push(ctx.commands.register({
      name: 'contract_probe', description: 'Published interface contract probe', recordInput: false,
      handler(value) { calls++; invocation = value; return { kind: 'success', text: 'direct result' } },
    }))
    assert.throws(() => ctx.commands.register({ name: 'contract_probe', description: 'duplicate', handler() {} }))
    const beforeMessages = session.deriveMessages()
    const result = await ctx.commands.execute(agent, '/contract_probe \t cancel', [], new AbortController().signal)
    assert.equal(result.result.kind, 'success')
    assert.equal(invocation.rawInput, ' \t cancel')
    assert.ok(Object.isFrozen(invocation.attachments))
    assert.equal(calls, 1)
    assert.deepEqual(session.deriveMessages(), beforeMessages)
    const rejected = await ctx.commands.execute(agent, '/contract_probe', [{ type: 'file', receiptId: 'not-admitted' }], new AbortController().signal)
    assert.equal(rejected.result.kind, 'error')
    assert.equal(calls, 1)
    const commandRows = (await log()).events.filter(e => e.data.commandId === result.commandId || e.data.commandId === rejected.commandId)
    assert.deepEqual(commandRows.map(e => e.type), ['command/run', 'command/done', 'command/run', 'command/done'])
    assert.ok(commandRows.filter(e => e.type === 'command/run').every(e => !Object.hasOwn(e.data, 'args')))
    record('command-input-attachments-lifecycle', commandRows)

    let entered
    let release
    const enteredPromise = new Promise(resolve => { entered = resolve })
    const releasePromise = new Promise(resolve => { release = resolve })
    let sideEffectFinished = false
    disposers.push(ctx.commands.register({ name: 'contract_abort', description: 'Cancellation contract', async handler({ signal }) {
      entered(signal); await releasePromise; sideEffectFinished = true
      return { kind: 'success', text: 'handler eventually returned' }
    } }))
    const controller = new AbortController()
    const pending = ctx.commands.execute(agent, '/contract_abort', [], controller.signal)
    const handlerSignal = await enteredPromise
    const reason = new Error('interface probe cancellation')
    controller.abort(reason)
    try { await assert.rejects(pending, error => error === reason); assert.equal(handlerSignal.aborted, true); assert.equal(sideEffectFinished, false) }
    finally { release(); await releasePromise; await Promise.resolve() }
    const cancelRows = (await log()).events.filter(e => e.type.startsWith('command/') && (e.data.name === 'contract_abort' || e.data.text === reason.message))
    assert.deepEqual(cancelRows.map(e => e.type), ['command/run', 'command/done'])
    assert.equal(cancelRows[1].data.kind, 'error')
    record('cooperative-command-cancellation', cancelRows)

    const key = 'contract-interface-state'
    const schema = z.object({ status: z.enum(['none', 'pending', 'cancelled']), requestSeq: z.number().int().nonnegative().nullable() }).strict()
    const definition = { key, stateSchema: schema, stateVersion: 1,
      init: () => ({ status: 'none', requestSeq: null }),
      apply: (state, event) => event.type === 'user/message' && event.data.source.kind === 'contract-control'
        ? schema.parse({ status: event.data.source.status, requestSeq: event.data.source.requestSeq }) : state,
    }
    disposers.push(ctx.sessionProjections.register(definition))
    assert.throws(() => ctx.sessionProjections.register({ ...definition, stateVersion: 2 }))
    assert.throws(() => ctx.sessionProjections.register({ ...definition, key: 'invalid-version', stateVersion: -1 }))
    const requestSeq = SessionSeq(session.seq)
    const control = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'contract request pending' }], source: { kind: 'contract-control', status: 'pending', requestSeq } }), { surfaceOp: 'append' })
    assert.deepEqual(ctx.sessionProjections.stateOf(session, key), { status: 'pending', requestSeq })
    assert.equal(Object.hasOwn(ctx.sessionProjections.snapshot(session).values, key), false)
    assert.equal(ctx.sessionProjections.checkpoint(session)[key].ver, 1)
    const stateReference = ctx.sessionProjections.stateOf(session, key)
    assert.equal(definition.apply(stateReference, { type: 'command/done' }), stateReference)

    const surfaceBefore = await query.readSurface(session.id)
    const target = surfaceBefore.events.find(e => e.type === 'tool/result' && e.data.message.isError !== true && toolPairingBalancedAfter(session, e.seq))
    assert.ok(target, 'Host must prepare a real completed tool-result history before running interfaces')
    const originalWindow = await query.readEvent({ sessionId: session.id, seq: target.seq })
    const originalMessage = session.deriveEventMessage(target)
    const beforeMeasurement = ctx.tokenMeter.measure(session)
    assert.equal(beforeMeasurement.surfaceTokens, beforeMeasurement.nodes.reduce((sum, node) => sum + node.tokens, 0))
    assert.ok(Object.isFrozen(beforeMeasurement) && Object.isFrozen(beforeMeasurement.nodes))
    const price = ctx.tokenMeter.estimateMessage(originalMessage)
    assert.ok(Number.isFinite(price) && price > 0)
    const range = { op: 'replace', startSeq: target.seq, endSeq: target.seq }
    const rewrittenData = { ...target.data, message: { ...originalMessage, content: originalMessage.content.map(block => block.type === 'text' ? { ...block, text: '[contract pruned]' } : block) } }
    const order = []
    let replacement
    const tail = ctx.on('agent/pre-step', async (payload, next) => {
      if (payload.agent !== agent) return next()
      order.push('tail'); return { kind: 'reject' }
    })
    disposers.push(tail)
    disposers.push(ctx.on('agent/pre-step', async (payload, next) => {
      if (payload.agent !== agent) return next()
      order.push('prepend')
      const current = (await log()).events
      const turnStart = current.findLast(e => e.type === 'turn/start')
      assert.ok(turnStart)
      assert.equal(turnStart.data.turn, payload.turn)
      assert.ok(!current.some(e => e.type === 'step/start' && e.data.turn === payload.turn))
      const revision = session.seq
      assert.throws(() => session.append('tool/result', { ...rewrittenData, message: { ...rewrittenData.message, id: 'changed-identity' } }, { surfaceOp: range, sourceEventSeqs: [target.seq, control.seq] }))
      assert.throws(() => session.append('tool/result', rewrittenData, { surfaceOp: range, sourceEventSeqs: [control.seq] }))
      assert.throws(() => session.append('tool/result', rewrittenData, { surfaceOp: range, sourceEventSeqs: [target.seq, target.seq, control.seq] }))
      assert.equal(session.seq, revision)
      session.append('compaction/prune', { shadowedRange: { start: target.seq, end: target.seq }, shadowedSeqs: [target.seq], shadowedTokenCount: price })
      replacement = session.append('tool/result', rewrittenData, { surfaceOp: range, sourceEventSeqs: [target.seq, control.seq] })
      assert.equal(await ctx.sessions.flush(session), true, 'Actual persistence listener required')
      const decision = await next()
      assert.deepEqual(decision, { kind: 'reject' })
      return decision
    }, { prepend: true }))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'probe pre-step ordering without model dispatch' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    assert.deepEqual(order, ['prepend', 'tail'])
    assert.ok(replacement)
    const rows = (await log()).events
    assert.equal(rows[replacement.seq - 1].type, 'compaction/prune')
    assert.deepEqual((await query.readEvent({ sessionId: session.id, seq: target.seq })).target, originalWindow.target)
    assert.equal(replacement.data.message.id, originalMessage.id)
    assert.equal(replacement.data.message.toolCallId, originalMessage.toolCallId)
    assert.deepEqual(replacement.data.message.source, originalMessage.source)
    assert.deepEqual(replacement.data.meta, target.data.meta)
    assert.deepEqual(replacement.data.error, target.data.error)
    assert.deepEqual(replacement.data.message.content.filter(block => block.type !== 'text'), originalMessage.content.filter(block => block.type !== 'text'))
    const trace = await query.traceEvent({ sessionId: session.id, seq: replacement.seq })
    assert.deepEqual(trace.sourceEventSeqs, [target.seq, control.seq])
    assert.deepEqual(trace.replacedEventSeqs, [target.seq])
    const originalTrace = await query.traceEvent({ sessionId: session.id, seq: target.seq })
    assert.equal(originalTrace.replacedBy, replacement.seq)
    assert.ok((await query.readSurface(session.id)).events.some(e => e.seq === replacement.seq))
    assert.ok(!(await query.readSurface(session.id)).events.some(e => e.seq === target.seq))
    assert.equal(toolPairingBalancedBefore(session, replacement.seq), false)
    assert.equal(toolPairingBalancedAfter(session, replacement.seq), true)
    record('pre-step-prune-identity-provenance', { order, original: originalWindow.target, replacement, trace, originalTrace, measurement: ctx.tokenMeter.measure(session) })

    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'contract request cancelled' }], source: { kind: 'contract-control', status: 'cancelled', requestSeq } }), { surfaceOp: 'append' })
    assert.deepEqual(ctx.sessionProjections.stateOf(session, key), { status: 'cancelled', requestSeq })
    assert.equal(await ctx.sessions.flush(session), true)
    record('projection-cancel-state', ctx.sessionProjections.checkpoint(session)[key])
    // Query is an unrestricted host reader, not an authorization service.
    // Only a plugin-validated actual replacement plus matching control metadata
    // can authorize a recovery reference. Guessing a seq still reads raw data.
    record('trace-is-provenance-not-authorization', { readableOriginalSeq: (await query.readEvent({ sessionId: session.id, seq: target.seq })).target.seq })
    return evidence
  } finally { for (const dispose of disposers.reverse()) dispose() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { createContractHost, prepareToolHistory } = await import('./published-contract.mjs')
  const host = await createContractHost()
  try {
    assert.equal(typeof prepareToolHistory, 'function', 'Host module must export prepareToolHistory for standalone execution')
    await prepareToolHistory(host)
    console.log(JSON.stringify(await runInterfaces(host), null, 2))
  } finally { await host.close() }
}
