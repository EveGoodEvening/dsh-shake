import { describe, it } from 'vitest'
import { partialRestart, failedRestart, forkRecovery } from './fixtures/recovery.js'

// The shared scenarios assert actual public host history/request/authorization
// behavior. They never call the executor directly or synthesize turn boundaries.
describe('durable recovery through published natural turns', () => {
  it('reopens a landed replacement without a progress checkpoint and does not replace it twice', partialRestart, 60000)
  it('preserves a recorded failure across JSONL restart without an automatic model request or retry', failedRestart, 60000)
  it('clears inherited pending intent while preserving only current seeded read scope', forkRecovery, 60000)
})
