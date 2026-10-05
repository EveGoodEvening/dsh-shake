import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { renderShakeMessage, type IndexedShakeRegion } from './regions.js'
import { readShakeState, ShakeControlSchema, type ShakeResult } from './state.js'
import { ShakeLifecycle } from './lifecycle.js'

/** Runs only within the host's natural turn, before its request is assembled. */
export async function executePendingShake(ctx: Context, agent: Agent, signal: AbortSignal, lifecycle?: ShakeLifecycle): Promise<void> {
  const session = agent.session
  const state = readShakeState(ctx.sessionProjections, session)
  const request = state.current
  if (!request) {
    // A terminal clear can be visible before its flush resolves. Retry that
    // checkpoint on every natural step, including after replay, before next().
    if (state.lastResult?.status === 'completed' && state.lastResult.sessionId === session.id) {
      signal.throwIfAborted()
      if (!await ctx.sessions.flush(session)) throw new Error('无法确认清理持久化：没有会话保存监听器。')
      signal.throwIfAborted()
      if (agent.session !== session) throw new Error('清理期间会话已改变。')
    }
    return
  }
  if (state.lastResult?.operationId === request.operationId && state.lastResult.status === 'failed') {
    throw new Error('清理已失败；已发生的替换保留，本次请求不会自动重试。')
  }
  const result: ShakeResult = { operationId: request.operationId, sessionId: session.id,
    requestSeq: request.requestSeq, status: 'executing', removedRegions: 0, skippedRegions: 0, estimatedTokensSaved: 0 }
  const check = () => {
    signal.throwIfAborted()
    if (agent.session !== session) throw new Error('清理期间会话已改变。')
  }
  const persist = async (status: ShakeResult['status'], clear = false) => {
    check()
    result.status = status
    const source = ShakeControlSchema.parse({ kind: 'dsh-shake-control', schemaVersion: 1,
      operationId: request.operationId, sessionId: session.id,
      current: clear ? null : request, lastResult: result })
    lifecycle?.touch(session)
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text:
      status === 'completed' ? '上下文减重已完成（节省量为本地估算）。' : status === 'failed'
        ? '上下文减重失败；已提交的替换保留，未放行模型请求。' : '上下文减重执行中。' }], source }), { surfaceOp: 'append' })
    if (!await ctx.sessions.flush(session)) throw new Error('无法确认清理持久化：没有会话保存监听器。')
    lifecycle?.saved(session)
    check()
  }
  const complete = async () => {
    // Retain intent until the completed replacements are durable. The final
    // clear has its own flush; a rejected clear is gated by the branch above.
    await persist('completed')
    await persist('completed', true)
  }
  try {
    check()
    if (state.lastResult?.operationId === request.operationId && state.lastResult.status === 'completed') {
      Object.assign(result, state.lastResult)
      // The staged completion is already in the log: confirm it, then clear.
      if (!await ctx.sessions.flush(session)) throw new Error('无法确认清理持久化：没有会话保存监听器。')
      check()
      await persist('completed', true)
      return
    }
    // Public readSession observes once; retain only the frozen original prefix.
    // readEvent's host-configured 50-event neighbor limit cannot read long prefixes.
    const originals = new Map((await ctx.sessionQuery.readSession(session.id)).events
      .filter(event => event.seq <= request.cutoffSeq).map(event => [Number(event.seq), event]))
    check()
    const surface = await ctx.sessionQuery.readSurface(session.id)
    check()
    const current = new Map(surface.events.map(event => [Number(event.seq), event]))
    const measurement = ctx.tokenMeter.measure(session)
    const tokens = new Map(measurement.nodes.map(node => [Number(node.seq), node.tokens]))
    const protectedSeqs = new Set<number>()
    let recentTokens = 0
    for (let index = surface.events.length - 1; index >= 0 && recentTokens < request.policy.protectedTokens; index--) {
      const event = surface.events[index]!
      const price = tokens.get(Number(event.seq))
      if (price === undefined) throw new Error('Surface and token measurement disagree')
      recentTokens += price; protectedSeqs.add(Number(event.seq))
    }
    const groups = new Map<number, IndexedShakeRegion[]>()
    request.regions.forEach((region, regionIndex) => {
      const group = groups.get(region.eventSeq) ?? []
      group.push({ region, regionIndex }); groups.set(region.eventSeq, group)
    })
    await persist('executing')
    for (const [seq, selections] of groups) {
      check()
      const original = originals.get(seq)
      if (!original || seq > request.cutoffSeq) { result.skippedRegions += selections.length; continue }
      const trace = await ctx.sessionQuery.traceEvent({ sessionId: session.id, seq: SessionSeq(seq) })
      check()
      const message = session.deriveEventMessage(original)
      const rendered = message && renderShakeMessage(message, seq, selections, request, ctx.tokenMeter)
      if (trace.replacedBy !== undefined) {
        // Only an actual direct positional replacement with this request's sources
        // is progress. Do not chase a later replacement or restore a stale node.
        const replacement = (await ctx.sessionQuery.readEvent({ sessionId: session.id, seq: trace.replacedBy })).target
        check()
        if (rendered && replacement.sourceEventSeqs?.includes(SessionSeq(seq))
          && replacement.sourceEventSeqs.includes(SessionSeq(request.requestSeq))
          && JSON.stringify(session.deriveEventMessage(replacement)) === JSON.stringify(rendered.message)) {
          result.removedRegions += selections.length; result.estimatedTokensSaved += rendered.savedTokens
        } else result.skippedRegions += selections.length
        continue
      }
      if (!current.has(seq) || protectedSeqs.has(seq) || trace.target.surface !== 'current' || !rendered) {
        result.skippedRegions += selections.length; continue
      }
      // Public trace is awaited: recheck live membership immediately before append.
      if (!session.surface.nodes.includes(SessionSeq(seq))) {
        result.skippedRegions += selections.length; continue
      }
      check()
      const opts = { surfaceOp: { op: 'replace' as const, startSeq: SessionSeq(seq), endSeq: SessionSeq(seq) },
        sourceEventSeqs: [SessionSeq(seq), SessionSeq(request.requestSeq)] }
      if (original.type === 'tool/result' && rendered.message.role === 'tool') {
        // This pair is synchronous and adjacent. Preserve every field except text.
        lifecycle?.touch(session)
        session.append('compaction/prune', { shadowedRange: { start: SessionSeq(seq), end: SessionSeq(seq) },
          shadowedSeqs: [SessionSeq(seq)], shadowedTokenCount: ctx.tokenMeter.estimateMessage(message!) })
        session.append('tool/result', { ...original.data, message: rendered.message }, opts)
      } else if (original.type === 'assistant/message' && rendered.message.role === 'user'
        && toolPairingBalancedBefore(session, SessionSeq(seq)) && toolPairingBalancedAfter(session, SessionSeq(seq))) {
        lifecycle?.touch(session)
        session.append('compaction/prune', { shadowedRange: { start: SessionSeq(seq), end: SessionSeq(seq) },
          shadowedSeqs: [SessionSeq(seq)], shadowedTokenCount: ctx.tokenMeter.estimateMessage(message!) })
        session.append('user/message', rendered.message, opts)
      } else { result.skippedRegions += selections.length; continue }
      result.removedRegions += selections.length
      result.estimatedTokensSaved += rendered.savedTokens
      // Whole bounded state promptly accompanies each executed message; raw
      // positional replacement/source traces, not this summary, prove progress.
      await persist('executing')
    }
    await complete()
  } catch (error) {
    // Never let a failure/abort reach next(). Aborts must not write after exit.
    if (!signal.aborted && agent.session === session) {
      try { await persist('failed') } catch (saveError) {
        throw new AggregateError([error, saveError], `清理失败，已移除 ${result.removedRegions} 个区域；保存失败。`)
      }
    }
    throw error
  }
}

export function registerShakeExecution(ctx: Context, lifecycle = new ShakeLifecycle()): () => void {
  return ctx.on('agent/pre-step', async (payload, next) => {
    await lifecycle.run(payload.signal, async signal => {
      await executePendingShake(ctx, payload.agent, signal, lifecycle)
      signal.throwIfAborted()
    })
    payload.signal.throwIfAborted()
    lifecycle.check()
    return next()
  }, { prepend: true })
}
