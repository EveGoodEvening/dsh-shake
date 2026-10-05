import type { Context } from '@deepseek-ai/cordis'
import { ShakeConfigSchema, parseShakeConfig, type ShakeConfig } from './config.js'
import { registerShakeCommand } from './commands.js'
import { registerShakeProjection } from './state.js'
import { registerShakeExecution } from './execute.js'
import { registerShakeRead } from './read.js'
import { ShakeLifecycle } from './lifecycle.js'

export const name = 'dsh-shake'
export const inject = ['commands', 'sessions', 'sessionQuery', 'sessionProjections', 'tokenMeter', 'tools']
export const Config = ShakeConfigSchema
export type Config = ShakeConfig

/** Durable commands remain idle; the natural turn hook consumes pending work. */
export function apply(ctx: Context, config: ShakeConfig): void {
  const policy = parseShakeConfig(config)
  const lifecycle = new ShakeLifecycle()
  const disposeProjection = registerShakeProjection(ctx.sessionProjections)
  const entries: (() => void)[] = []
  try {
    entries.push(registerShakeCommand(ctx, policy, lifecycle))
    entries.push(registerShakeExecution(ctx, lifecycle))
    entries.push(registerShakeRead(ctx, policy, lifecycle))
    // Registered last so public Cordis reverse-order cleanup closes entry points
    // before draining work, while the projection remains available to that work.
    ctx.effect(() => async () => {
      for (const dispose of entries.reverse()) dispose()
      try { await lifecycle.close(session => ctx.sessions.flush(session)) }
      finally { disposeProjection() }
    })
  } catch (error) {
    for (const dispose of entries.reverse()) dispose()
    disposeProjection()
    throw error
  }
}
