import { describe, it } from 'vitest'
import { commandAcceptance, maintenanceInboxOrdering, pendingUnloadReload, activeUnload,
  persistenceFailuresAndConflicts, concurrentSessions, automaticCompaction, cancellationSignals } from './fixtures/lifecycle.js'

import { partialRestart } from './fixtures/recovery.js'
describe('published public-host cancellable lifecycle', () => {
  it('accepts only idle valid commands, freezes repeated pending selection, and cancels without model requests', commandAcceptance, 60000)
  it('retains normal input order while maintenance owns the agent', maintenanceInboxOrdering, 60000)
  it('unloads real plugin forks and reopens pending JSONL intent without automatic execution', pendingUnloadReload, 60000)
  it('drains an active command before unregistering state without after-unload writes', () => activeUnload('command'), 60000)
  it('aborts and drains active natural pre-step before a model request can escape', () => activeUnload('execution'), 60000)
  it('drains an actual public tool dispatch with a pending read before returning dispose', () => activeUnload('read'), 60000)
  it('rejects missing persistence, failed flush, and conflicting public registrations', persistenceFailuresAndConflicts, 60000)
  it('isolates concurrent agents and sessions in one public runtime', concurrentSessions, 60000)
  it('respects UI, Agent-owned maintenance, and tool caller cancellation signals', cancellationSignals, 60000)
  it('stops at an Agent cancellation between genuine replacement and progress writes', partialRestart, 60000)
  it('preserves host automatic compaction through its natural request path', automaticCompaction, 60000)
})
