import type { Context } from '@deepseek-ai/cordis'
import { ShakeConfigSchema, parseShakeConfig, type ShakeConfig } from './config.js'
import { registerShakeCommand } from './commands.js'
import { ShakeStateStore } from './state.js'
import { registerShakeExecution } from './execute.js'
import { registerShakeRead } from './read.js'
import { ShakeLifecycle } from './lifecycle.js'

export const name = 'dsh-shake'
export const inject = ['agents', 'commands', 'sessions', 'sessionQuery', 'sessionProjections', 'tokenMeter', 'tools']
export const Config = ShakeConfigSchema
export type Config = ShakeConfig

/** Durable commands remain idle; the natural turn hook consumes pending work. */
export async function apply(ctx: Context, config: ShakeConfig): Promise<void> {
  const policy = parseShakeConfig(config)
  const lifecycle = new ShakeLifecycle()
  const state = ctx.plugin(ShakeStateStore)
  await state
  const entries: (() => void)[] = []
  try {
    await ctx.inject(['shakeState'], scoped => {
      entries.push(registerShakeCommand(scoped, policy, lifecycle))
      entries.push(registerShakeExecution(scoped, lifecycle))
      entries.push(registerShakeRead(scoped, policy, lifecycle))
    })
    // Registered last so public Cordis reverse-order cleanup closes entry points
    // before draining work, while the projection remains available to that work.
    ctx.effect(() => async () => {
      for (const dispose of entries.reverse()) dispose()
      try { await lifecycle.close(session => ctx.sessions.flush(session)) }
      finally { await state.dispose() }
    })
  } catch (error) {
    for (const dispose of entries.reverse()) dispose()
    await state.dispose()
    throw error
  }
}
