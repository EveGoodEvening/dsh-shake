import type { Session } from '@deepseek-ai/dsh-session'

/** Own only plugin work, never the agent's inbox or autonomous background turns. */
export class ShakeLifecycle {
  private readonly controller = new AbortController()
  private readonly tasks = new Set<Promise<unknown>>()
  private readonly sessions = new Set<Session>()

  run<T>(signal: AbortSignal, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const combined = AbortSignal.any([signal, this.controller.signal])
    combined.throwIfAborted()
    const pending = Promise.resolve().then(() => {
      combined.throwIfAborted()
      return task(combined)
    })
    this.tasks.add(pending)
    // Observe rejection without creating a second unhandled promise.
    void pending.then(() => this.tasks.delete(pending), () => this.tasks.delete(pending))
    return pending
  }

  touch(session: Session): void { this.sessions.add(session) }
  saved(session: Session): void { this.sessions.delete(session) }
  check(): void { this.controller.signal.throwIfAborted() }

  async close(flush: (session: Session) => Promise<boolean>): Promise<void> {
    this.controller.abort(new Error('dsh-shake unloaded'))
    await Promise.allSettled([...this.tasks])
    // A bounded final checkpoint per touched session; no new controls or retries.
    const sessions = [...this.sessions]
    this.sessions.clear()
    const results = await Promise.allSettled(sessions.map(session => flush(session)))
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason]
      : result.value ? [] : [new Error('无法确认清理持久化：没有会话保存监听器。')])
    if (errors.length) throw new AggregateError(errors, 'dsh-shake unload persistence failed')
  }
}
