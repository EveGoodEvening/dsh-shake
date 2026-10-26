import { describe, it } from 'vitest'
import { partialRestart, failedRestart, forkRecovery, completionRestart, coexistence, compactedAuthorization } from './fixtures/recovery.js'

// The shared scenarios assert actual public host history/request/authorization
// behavior. They never call the executor directly or synthesize turn boundaries.
describe('durable recovery through published natural turns', () => {
  it('reopens a landed replacement without a progress checkpoint and does not replace it twice', partialRestart, 60000)
  it('preserves a recorded failure across JSONL restart without an automatic model request or retry', failedRestart, 60000)
  it('clears inherited pending intent while preserving only current seeded read scope', forkRecovery, 60000)
  it.each([false, true])('reopens an interrupted completion without duplicate replacements (clear=%s)', async clear => {
    await completionRestart(clear)
  }, 60000)
  it.each([
    ['prune', false], ['prune', true], ['compact', false], ['compact', true],
  ] as const)('does not resurrect history or duplicate messages across host %s (afterPlan=%s)', async (kind, afterPlan) => {
    await coexistence(kind, afterPlan)
  }, 60000)
  it('preserves authorized original reads after full compaction and restart while denying corrupt or missing evidence', compactedAuthorization, 60000)
})
