import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Commands from '@deepseek-ai/dsh-commands'
import Projections from '@deepseek-ai/dsh-session-projection'
import Query, { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import Meter from '@deepseek-ai/dsh-token-meter'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { registerShakeProjection, readShakeState } from '../src/state.js'
import { registerShakeCommand } from '../src/commands.js'
import { parseShakeConfig } from '../src/config.js'

class CommandTestQuery extends Query {
  async searchSessions(): Promise<never> {
    throw new SessionQueryError('Command fixtures do not provide full-text search', 'SESSION_QUERY_SEARCH_DISABLED')
  }

  async searchEvents(): Promise<never> {
    throw new SessionQueryError('Command fixtures do not provide full-text search', 'SESSION_QUERY_SEARCH_DISABLED')
  }
}

async function fixture() {
  const ctx = new Context()
  const plugins = [ctx.plugin(SessionStore), ctx.plugin(Commands), ctx.plugin(Projections), ctx.plugin(CommandTestQuery), ctx.plugin(Meter)]
  await Promise.all(plugins)
  const session = ctx.sessions.create(SessionId('commands-test'))
  registerShakeProjection(ctx.sessionProjections)
  registerShakeCommand(ctx, parseShakeConfig({ protectedTokens: 0 }))
  let occupied = false
  let running = false
  const agent: Agent = {
    id: session.id, session, ctx, options: {},
    get status() { return running ? 'running' : 'idle' },
    inbox: { nextTurn: [], nextStep: [], splice() { return [] }, clear() {}, append() {}, prepend() {}, replace() { return false }, remove() { return false } },
    async runMaintenance(task) {
      if (occupied || running) throw new Error('busy')
      occupied = true
      try { return await task(new AbortController().signal) } finally { occupied = false }
    },
    send() { throw new Error('must not schedule') }, followup() { throw new Error('must not schedule') },
    steer() { throw new Error('must not schedule') }, inject() { throw new Error('must not schedule') },
    cancel() { throw new Error('must not cancel unrelated work') }, async whenIdle() {},
  }
  const execute = (line: string) => ctx.commands.execute(agent, line, [], new AbortController().signal)
  const candidate = () => {
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const event = session.append('assistant/message', { turn: 1, step: 1, stream: [], message: {
      id: MessageId('old-code'), role: 'assistant', source: { kind: 'model', provider: 'test', model: 'test' },
      content: [{ type: 'text', text: '```ts\n' + 'const original = 1;\n'.repeat(600) + '```' }],
    } }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    return event
  }
  return { ctx, session, agent, execute, candidate, busy: () => { running = true } }
}

describe('durable command admission', () => {
  it('rejects invalid input and returns no-op without creating pending state', async () => {
    const f = await fixture()
    try {
      expect((await f.execute('/shake extra'))?.result.kind).toBe('error')
      expect((await f.execute('/shake cancel extra'))?.result.kind).toBe('error')
      expect((await f.execute('/shake'))?.result).toEqual({ kind: 'success', text: '无需清理。' })
      expect(readShakeState(f.ctx.sessionProjections, f.session).current).toBeNull()
      const attachment = await f.ctx.commands.execute(f.agent, '/shake', [{ type: 'file', receiptId: 'forbidden' }], new AbortController().signal)
      expect(attachment?.result.kind).toBe('error')
    } finally { await f.ctx.fiber.dispose() }
  })
  it('waits for persistence and records exact prospective sequence and snapshot; duplicate rejects; cancel clears', async () => {
    const f = await fixture()
    try {
      const original = f.candidate()
      let release: (value: boolean) => void = () => { throw new Error('gate not initialized') }
      const gate = new Promise<boolean>(resolve => { release = resolve })
      const flush = vi.spyOn(f.ctx.sessions, 'flush').mockReturnValueOnce(gate).mockResolvedValue(true)
      let settled = false
      const admission = f.execute('/shake').then(value => { settled = true; return value })
      await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(1))
      expect(settled).toBe(false)
      const pending = readShakeState(f.ctx.sessionProjections, f.session).current!
      expect(pending.cutoffSeq).toBeLessThan(pending.requestSeq)
      expect(pending.regions[0]?.eventSeq).toBe(original.seq)
      expect(pending.policy.protectedTokens).toBe(0)
      expect(f.session.deriveEventMessage(original)).toEqual(original.data.message)
      release(true)
      const accepted = await admission
      expect(accepted?.result.kind).toBe('success')
      if (accepted?.result.kind === 'success') expect(Number(accepted.result.sourceEventSeq)).toBe(pending.requestSeq)
      expect((await f.execute('/shake'))?.result.kind).toBe('error')
      expect(readShakeState(f.ctx.sessionProjections, f.session).current).toEqual(pending)
      expect((await f.execute('/shake cancel'))?.result.kind).toBe('success')
      const cancelled = readShakeState(f.ctx.sessionProjections, f.session)
      expect(cancelled.current).toBeNull()
      expect(cancelled.lastResult?.status).toBe('cancelled')
      expect(f.session.deriveEventMessage(original)).toEqual(original.data.message)
    } finally { await f.ctx.fiber.dispose() }
  })
  it.each([false, new Error('disk failure')])('never acknowledges persistence failure %s', async failure => {
    const f = await fixture()
    try {
      f.candidate()
      const flush = vi.spyOn(f.ctx.sessions, 'flush')
      if (failure instanceof Error) flush.mockRejectedValue(failure)
      else flush.mockResolvedValue(failure)
      expect((await f.execute('/shake'))?.result).toEqual({ kind: 'error',
        text: failure instanceof Error ? failure.message : '无法确认持久化：没有会话保存监听器。' })
      // Append is not a transaction: retain the unconfirmed request, never pretend rollback.
      expect(readShakeState(f.ctx.sessionProjections, f.session).current?.regions[0]?.eventSeq).toBeDefined()
      expect((await f.execute('/shake cancel'))?.result).toEqual({ kind: 'error',
        text: failure instanceof Error ? failure.message : '无法确认持久化：没有会话保存监听器。' })
      expect(readShakeState(f.ctx.sessionProjections, f.session).current).toBeNull()
    } finally { await f.ctx.fiber.dispose() }
  })
  it('rejects busy admission and cancellation without planning or changes', async () => {
    const f = await fixture()
    try {
      f.candidate(); f.busy()
      const read = vi.spyOn(f.ctx.sessionQuery, 'readSurface')
      expect((await f.execute('/shake'))?.result.kind).toBe('error')
      expect((await f.execute('/shake cancel'))?.result.kind).toBe('error')
      expect(read).not.toHaveBeenCalled()
      expect(readShakeState(f.ctx.sessionProjections, f.session).current).toBeNull()
    } finally { await f.ctx.fiber.dispose() }
  })
})
