import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ShakeConfig } from './config.js'
import { planShakeRegions } from './regions.js'
import { readShakeState, ShakeControlSchema, ShakeRequestSchema } from './state.js'
import { ShakeLifecycle } from './lifecycle.js'

const BUSY = '会话忙碌，请空闲后重试。'

/** The reservation follows the actual maintenance task, not the UI promise's lifetime. */
export function registerShakeCommand(ctx: Context, policy: ShakeConfig, lifecycle = new ShakeLifecycle()): () => void {
  const active = new WeakSet<Agent>()
  return ctx.commands.register({
    name: 'shake', description: '安排下一次模型请求前的上下文减重；cancel 取消待执行请求。',
    input: { hint: '[cancel]' }, recordInput: false,
    handler(invocation: CommandInvocation): Promise<CommandResult> {
      return lifecycle.run(invocation.signal, signal => handle({ ...invocation, signal }))
    },
  })
  async function handle(invocation: CommandInvocation): Promise<CommandResult> {
      const { agent, signal, attachments } = invocation
      const input = invocation.rawInput.trim()
      if ((input !== '' && input !== 'cancel') || attachments.length) {
        return { kind: 'error', text: '用法：/shake 或 /shake cancel；不接受附件。' }
      }
      if (active.has(agent)) return { kind: 'error', text: BUSY }
      active.add(agent)
      try {
        return await agent.runMaintenance(async maintenanceSignal => {
          const session = agent.session
          const check = () => {
            signal.throwIfAborted()
            maintenanceSignal.throwIfAborted()
            if (agent.session !== session) throw new Error('会话已改变，请重试。')
          }
          check()
          // A resumed interrupted turn can expose idle status without stable idle history.
          const boundary = ctx.sessionProjections.stateOf(session, 'turnBoundary')
          if (boundary?.openTurnStartSeq !== null && boundary?.openTurnStartSeq !== undefined) {
            return { kind: 'error', text: BUSY }
          }
          const state = readShakeState(ctx.sessionProjections, session)
          if (input === 'cancel') {
            if (!state.current) return { kind: 'success', text: '没有待执行的清理请求；不会恢复已完成的替换。' }
            if (state.lastResult?.operationId === state.current.operationId) {
              return { kind: 'error', text: '清理已经开始，不能取消或恢复已发生的替换。' }
            }
            const request = state.current
            const source = ShakeControlSchema.parse({
              kind: 'dsh-shake-control', schemaVersion: 1, operationId: request.operationId, sessionId: session.id,
              current: null, lastResult: { operationId: request.operationId, sessionId: session.id,
                requestSeq: request.requestSeq, status: 'cancelled', removedRegions: 0,
                skippedRegions: request.regions.length, estimatedTokensSaved: 0 },
            })
            check()
            lifecycle.touch(session)
            const event = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '已取消待执行的清理请求。' }], source }), { surfaceOp: 'append' })
            if (!await ctx.sessions.flush(session)) throw new Error('无法确认持久化：没有会话保存监听器。')
            lifecycle.saved(session)
            check()
            return { kind: 'success', text: '已取消待执行的清理请求；不会恢复已完成的替换。', sourceEventSeq: event.seq }
          }
          if (state.current) return { kind: 'error', text: '已有待执行的清理请求，将在下一次模型请求前执行；可用 /shake cancel 取消。' }
          const operationId = randomUUID()
          const requestSeq = Number(session.seq)
          const plan = await planShakeRegions(session, ctx, { operationId, requestSeq, policy })
          check()
          if (!plan.regions.length) return { kind: 'success', text: '无需清理。' }
          // Awaited public reads must not shift the prospective reference sequence.
          if (Number(session.seq) !== requestSeq) throw new Error('规划期间会话日志已改变，请重试。')
          const current = ShakeRequestSchema.parse({ operationId, sessionId: session.id, requestSeq,
            cutoffSeq: plan.cutoffSeq, policy, regions: plan.regions })
          const source = ShakeControlSchema.parse({ kind: 'dsh-shake-control', schemaVersion: 1,
            operationId, sessionId: session.id, current, lastResult: state.lastResult })
          lifecycle.touch(session)
          const event = session.append('user/message', createUserMessage({
            content: [{ type: 'text', text: '清理请求待执行。' }], source,
          }), { surfaceOp: 'append' })
          if (!await ctx.sessions.flush(session)) throw new Error('无法确认持久化：没有会话保存监听器。')
          lifecycle.saved(session)
          check()
          return { kind: 'success', text: '已安排，将在下一次模型请求前执行。', sourceEventSeq: event.seq }
        })
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : '清理请求失败，未确认保存。' }
      } finally { active.delete(agent) }
  }
}
