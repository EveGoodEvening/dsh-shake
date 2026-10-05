import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ProjectionDefinition, SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { ShakeConfigSchema } from './config.js'

export const SHAKE_PROJECTION_KEY = 'dsh-shake'
export const SHAKE_CONTROL_KIND = 'dsh-shake-control'
export const SHAKE_EXCERPT_KIND = 'dsh-shake-excerpt'
const index = z.number().int().nonnegative().safe()
const identity = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+(?![\s\S])/)
const sessionIdentity = z.string().min(1)

/** Positions are half-open UTF-16 indices within one ORIGINAL text content block. */
export const ShakeRegionSchema = z.object({
  eventSeq: index,
  messageId: z.string().min(1),
  kind: z.enum(['tool-text', 'assistant-code', 'assistant-xml']),
  blockIndex: index,
  start: index,
  end: index,
  checksum: z.string().regex(/^sha256:[a-f0-9]{64}(?![\s\S])/),
}).strict().refine(value => value.start < value.end, { message: 'Region must be nonempty' })
export type ShakeRegion = z.output<typeof ShakeRegionSchema>

export const ShakeRequestSchema = z.object({
  operationId: identity,
  sessionId: sessionIdentity,
  requestSeq: index,
  cutoffSeq: index,
  policy: ShakeConfigSchema,
  regions: z.array(ShakeRegionSchema).min(1),
}).strict().superRefine((value, ctx) => {
  if (value.cutoffSeq >= value.requestSeq) ctx.addIssue({ code: 'custom', message: 'Cutoff must precede request' })
  const ranges = new Map<string, { start: number, end: number }[]>()
  for (const region of value.regions) {
    if (region.eventSeq > value.cutoffSeq) ctx.addIssue({ code: 'custom', message: 'Region exceeds cutoff' })
    const key = `${region.eventSeq}:${region.blockIndex}`
    const previous = ranges.get(key) ?? []
    if (previous.some(other => region.start < other.end && other.start < region.end)) {
      ctx.addIssue({ code: 'custom', message: 'Overlapping regions' })
    }
    previous.push(region)
    ranges.set(key, previous)
  }
})
export type ShakeRequest = z.output<typeof ShakeRequestSchema>

/** Bounded last outcome, not an operation ledger. Failure retains current request. */
export const ShakeResultSchema = z.object({
  operationId: identity,
  sessionId: sessionIdentity,
  requestSeq: index,
  status: z.enum(['executing', 'completed', 'cancelled', 'failed']),
  removedRegions: index,
  skippedRegions: index,
  estimatedTokensSaved: index,
}).strict()
export type ShakeResult = z.output<typeof ShakeResultSchema>

/** Every control record contains the WHOLE post-change business state. */
export const ShakeControlSchema = z.object({
  kind: z.literal(SHAKE_CONTROL_KIND),
  schemaVersion: z.literal(1),
  operationId: identity,
  sessionId: sessionIdentity,
  current: ShakeRequestSchema.nullable(),
  lastResult: ShakeResultSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  if (!value.current && !value.lastResult) ctx.addIssue({ code: 'custom', message: 'Empty control record' })
  if (value.current && value.current.sessionId !== value.sessionId) {
    ctx.addIssue({ code: 'custom', message: 'Control session mismatch' })
  }
  if (!value.current && value.lastResult?.sessionId !== value.sessionId) {
    ctx.addIssue({ code: 'custom', message: 'Outcome-only control session mismatch' })
  }
  const active = value.current ?? value.lastResult
  if (active?.operationId !== value.operationId) ctx.addIssue({ code: 'custom', message: 'Control operation mismatch' })
  if (value.current && value.lastResult?.operationId === value.current.operationId) {
    if (value.lastResult.requestSeq !== value.current.requestSeq || !['executing', 'completed', 'failed'].includes(value.lastResult.status)) {
      ctx.addIssue({ code: 'custom', message: 'Only an executing, staged completed or failed outcome can retain the same current request' })
    }
  }
})
export type ShakeControl = z.output<typeof ShakeControlSchema>

export const ShakeRefSchema = z.object({
  version: z.literal(1), operationId: identity, requestSeq: index, regionIndex: index,
}).strict()
export type ShakeRef = z.output<typeof ShakeRefSchema>
/** References locate metadata only. They NEVER confer permission to read original text. */
export function formatShakeRef(value: ShakeRef): string {
  const ref = ShakeRefSchema.parse(value)
  return `shake:1:${ref.operationId}:${ref.requestSeq}:${ref.regionIndex}`
}
/** Strict canonical format: reject unknown versions, extra fields and unsafe indices. */
export function parseShakeRef(value: string): ShakeRef {
  const match = /^shake:1:([A-Za-z0-9_-]{1,128}):(0|[1-9][0-9]*):(0|[1-9][0-9]*)(?![\s\S])/.exec(value)
  if (!match) throw new Error('Invalid shake reference')
  return ShakeRefSchema.parse({ version: 1, operationId: match[1], requestSeq: Number(match[2]), regionIndex: Number(match[3]) })
}

export const ShakeExcerptSchema = z.object({
  kind: z.literal(SHAKE_EXCERPT_KIND), schemaVersion: z.literal(1),
  operationId: identity, sessionId: sessionIdentity, requestSeq: index,
  originalEventSeq: index, regionIndices: z.array(index).min(1),
}).strict().refine(value => value.originalEventSeq < value.requestSeq && new Set(value.regionIndices).size === value.regionIndices.length, {
  message: 'Invalid excerpt provenance',
})
export type ShakeExcerpt = z.output<typeof ShakeExcerptSchema>

/** Checksum the ORIGINAL selected substring, not the transformed text or entire message. */
export function checksumShakeText(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf16le').digest('hex')}`
}

export const ShakeStateSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: sessionIdentity,
  current: ShakeRequestSchema.nullable(),
  lastResult: ShakeResultSchema.nullable(),
}).strict().refine(value => value.current === null || value.current.sessionId === value.sessionId, {
  message: 'Inherited pending request is not executable',
})
export type ShakeState = z.output<typeof ShakeStateSchema>

declare module '@deepseek-ai/dsh-llm/message' {
  interface MessageSourceMap {
    'dsh-shake-control': ShakeControl
    'dsh-shake-excerpt': ShakeExcerpt
  }
}
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    'dsh-shake': ShakeState
  }
}

/** Invalid owned metadata throws rather than opening a modification path. */
export function applyShakeEvent(state: ShakeState, event: SessionEvent): ShakeState {
  if (event.type !== 'user/message' || event.data.source.kind !== SHAKE_CONTROL_KIND) return state
  const control = ShakeControlSchema.parse(event.data.source)
  if (control.current && control.current.requestSeq > event.seq) throw new Error('Request sequence is in the future')
  if (control.lastResult && control.lastResult.requestSeq >= event.seq) throw new Error('Result must follow request')
  // A fork inherits history and outcomes, never the parent's pending intent.
  return {
    schemaVersion: 1, sessionId: state.sessionId,
    current: control.sessionId === state.sessionId ? control.current : null,
    lastResult: control.lastResult,
  }
}

/** Host-only native fold: no custom subscriptions, wire view, original text or operation list. */
export const shakeProjection: ProjectionDefinition<typeof SHAKE_PROJECTION_KEY> = {
  key: SHAKE_PROJECTION_KEY, stateVersion: 1, stateSchema: ShakeStateSchema,
  init: header => ({ schemaVersion: 1, sessionId: header.id, current: null, lastResult: null }),
  apply: applyShakeEvent,
}
export function registerShakeProjection(registry: SessionProjectionRegistry): () => void {
  return registry.register(shakeProjection)
}
/** Throws if lifecycle registration is absent; callers must not mutate the native projection. */
export function readShakeState(registry: SessionProjectionRegistry, session: Session): ShakeState {
  const state = registry.stateOf(session, SHAKE_PROJECTION_KEY)
  if (!state) throw new Error('Shake projection is not registered')
  return state
}
