import { z } from 'zod'

/** Only numeric policy knobs; message/identity/error protections are unconditional. */
export const ShakeConfigSchema = z.object({
  protectedTokens: z.number().int().nonnegative().safe().default(4000),
  toolTextMinTokens: z.number().int().nonnegative().safe().default(1000),
  assistantBlockMinTokens: z.number().int().nonnegative().safe().default(400),
  readDefaultLimit: z.number().int().min(1).max(4096).default(2048),
  readMaxLimit: z.number().int().min(1).max(4096).default(4096),
}).strict().refine(value => value.readDefaultLimit <= value.readMaxLimit, {
  message: 'readDefaultLimit must not exceed readMaxLimit',
})

export type ShakeConfig = z.output<typeof ShakeConfigSchema>
export const DEFAULT_SHAKE_CONFIG: Readonly<ShakeConfig> = Object.freeze(ShakeConfigSchema.parse({}))
/** Parse external configuration; unknown protection switches are rejected. */
export function parseShakeConfig(value: unknown = {}): ShakeConfig {
  return ShakeConfigSchema.parse(value)
}
