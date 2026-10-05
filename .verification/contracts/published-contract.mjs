import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Context } from '@deepseek-ai/cordis';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import Commands from '@deepseek-ai/dsh-commands';
import Query from '@deepseek-ai/dsh-session-query';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import { defineTool } from '@deepseek-ai/dsh-tools';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { installLlmReplay } from '@deepseek-ai/dsh-llm-replay';
import { InvariantRegistry } from '@deepseek-ai/dsh-invariants';
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import * as sessionInvariant from '@deepseek-ai/dsh-session/invariant';
import * as agentInvariant from '@deepseek-ai/dsh-agent/invariant';
import * as loopInvariant from '@deepseek-ai/dsh-agent-loop/invariant';
import * as commandsInvariant from '@deepseek-ai/dsh-commands/invariant';
import { z } from 'zod';
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic';
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner';

// A supported deterministic template summarizer: the published backend owns
// selection, bracket, durable replacement, checkpoint and failure handling.
class ContractTemplateCompaction extends BasicCompactionEngine {
  async summarize(input, agent, signal) {
    signal?.throwIfAborted();
    const roles = input.messages.map(message => message.role).join(', ');
    return { summary: [{ type: 'text', text: `Prior conversation roles: ${roles}. Filesystem evidence was inspected.` }],
      provider: agent.options.provider, model: agent.options.model };
  }
}
export async function installRecoveryCoexistence(host, { thresholdRatio = 0.99 } = {}) {
  await host.ctx.plugin(ContractTemplateCompaction, { headroomTokens: 1024, thresholdRatio, retainTokens: 0 });
  await host.ctx.plugin(ToolResultPruner, { thresholdChars: 1000, headChars: 100, tailChars: 100 });
  return {
    prune: async () => {
      let result;
      const errors = [];
      const removeError = host.ctx.on('agent/error', ({ agent, error }) => {
        if (agent === host.agent) errors.push(error);
      });
      // Content replacements remain positional tool/results: they must be
      // appended inside the real loop's open turn and step, before shake plans
      // are applied. A one-shot public hook also avoids pruning later steps.
      const removeStep = host.ctx.on('agent/pre-step', (payload, next) => {
        if (payload.agent === host.agent && result === undefined) {
          payload.signal.throwIfAborted();
          result = host.ctx.toolResultPruner.pruneSession(payload.agent.session);
        }
        return next();
      }, { prepend: true });
      try {
        host.agent.followup(user('contract-prune-user', 'Continue naturally while pruning prior tool evidence.'));
        await stage('coexistence/prune-agent-idle', () => host.agent.whenIdle());
        if (errors.length) throw new AggregateError(errors, 'Natural pruning turn failed');
        assert.ok(result, 'natural agent/pre-step must perform pruning');
        return result;
      } finally {
        removeStep();
        removeError();
      }
    },
    compact: () => host.ctx.compaction.compactNow(host.agent, new AbortController().signal),
  };
}

const VERSION = process.env.SHAKE_COMPAT_DSH_VERSION ?? '0.2.0-rc.2';
const CONTROL_KIND = 'published-contract-control';
const CONTROL_SOURCE = { kind: CONTROL_KIND, schema: 1, operation: 'contract-operation', candidates: [{ event: 1, block: 0 }], policy: { protectedTokens: 4000 } };
const ORIGINAL = 'Filesystem evidence: α😀𠮷\n' + 'retained original tool content\n'.repeat(400);
const REDUCED = '[published-contract: original remains available in its source log]';
const user = (id, text, source = { kind: 'user' }) => ({ id, role: 'user', content: [{ type: 'text', text }], source });
const stop = (text, usage) => ({ kind: 'chunks', chunks: [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  ...(usage ? [{ type: 'usage', usage }] : []),
  { type: 'finish', reason: { kind: 'stop' } },
] });
const call = { type: 'tool-call', id: 'published-read-call', name: 'contract_read_file', arguments: '{}' };
const STAGE_TIMEOUT_MS = 30000;
async function stage(name, operation, timeoutMs = STAGE_TIMEOUT_MS) {
  console.error(`[published-contract] START ${name}`);
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        // Keep this timer referenced: an unresolved lifecycle promise otherwise
        // lets Node exit 13 before reporting the blocked public API.
        timer = setTimeout(() => reject(new Error(`published-contract stage timed out after ${timeoutMs}ms: ${name}`)), timeoutMs);
      }),
    ]);
    console.error(`[published-contract] DONE ${name}`);
    return result;
  } catch (error) {
    console.error(`[published-contract] FAIL ${name}: ${error.stack ?? error}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
const CLEANUP_TIMEOUT_MS = 5000;
async function cleanup(steps, originalError) {
  const errors = [];
  for (const [name, operation, timeoutMs = CLEANUP_TIMEOUT_MS] of steps) {
    try { await stage(name, operation, timeoutMs); } catch (error) { errors.push(error); }
  }
  // Every cleanup failure is logged by stage, but must never replace the
  // assertion or startup failure that led us here.
  if (errors.length && originalError === undefined) throw new AggregateError(errors, 'published-contract cleanup failed');
}

// Official replay supports an override-only sidecar. This is deliberately not an
// echo model: its fixed stream invokes a real filesystem tool via production dispatch.
export async function createContractHost({ directory, resumeId, persistence = true, assistantText = 'The filesystem fixture was read.', usageAnchor = false, toolTail = [], seed, parentSessionId, sessionId = 'published-contract-session', laterResponseCount = 1 } = {}) {
  const ownedDirectory = directory === undefined;
  directory ??= await mkdtemp(join(tmpdir(), 'dsh-published-contract-'));
  const ctx = new Context();
  let handle;
  let closing;
  const close = () => closing ??= cleanup([
    // AgentHandle owns stop/drain, unregister, session removal and scope unwind.
    ...(handle ? [['close/agent', () => handle.dispose()]] : []),
    // Cordis exposes root teardown on its public Fiber, not Context.dispose().
    ['close/context', () => ctx.fiber.dispose()],
    ...(ownedDirectory ? [['close/directory', () => rm(directory, { recursive: true, force: true })]] : []),
  ]);
  try {
    // Compose the public services before waiting for startup. Awaiting each
    // registration during composition can strand dependency-driven activation.
    const plugins = [
      ['llm', LlmRuntime], ['sessions', SessionStore],
      ['sessionProjections', SessionProjectionRegistry], ['systemPrompt', SystemPrompt, {}],
      ['tools', ToolRuntime, { mode: 'native' }], ['agents', AgentRegistry],
      ['commands', Commands], ['sessionQuery', Query], ['tokenMeter', TokenMeter],
      ['invariants', InvariantRegistry],
      ...[sessionInvariant, agentInvariant, loopInvariant, commandsInvariant].map(companion => [companion.name, companion]),
      ...(persistence ? [['sessionPersistence', JsonlPersistence, { root: join(directory, 'sessions'), compression: 'none' }]] : []),
    ].map(([name, plugin, config]) => [name, ctx.plugin(plugin, config)]);
    await Promise.all(plugins.map(([name, fiber]) => stage(`startup/${name}`, () => fiber)));
    const sourceFile = join(directory, 'tool-source.txt');
    await writeFile(sourceFile, ORIGINAL, 'utf8');
    ctx.tools.register(defineTool({
      name: 'contract_read_file', description: 'Read the contract fixture from its actual filesystem path.',
      parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }, ...toolTail] },
      execute: async (_args, exec) => readFile(sourceFile, { encoding: 'utf8', signal: exec.signal }),
    }));
    const replayFile = join(directory, 'replay-override.json');
    await writeFile(replayFile, JSON.stringify([
      { kind: 'chunks', chunks: [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments },
        { type: 'block-end', index: 0, block: call },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ] }, stop(assistantText), ...(usageAnchor ? [stop('Usage anchor.', { inputTokens: 10000, outputTokens: 1 })] : []),
      ...Array.from({ length: laterResponseCount }, () => stop('The later request completed.')),
    ]), 'utf8');
    const replay = installLlmReplay(ctx, {
      file: replayFile, overrideFile: replayFile,
      providers: [{ id: 'contract-replay', models: [{ id: 'contract-model', contextWindow: 131072 }] }],
    });
    const requests = [];
    ctx.on('llm/stream', (options, next) => {
      requests.push(structuredClone(options.messages));
      const live = ctx.agents.get(options.sessionId);
      assert.ok(live, 'model request must belong to the published live agent');
      assert.deepEqual(options.messages, live.session.deriveMessages(), 'request must be exactly log-derived');
      return next();
    }, { prepend: true });
    ctx.sessionProjections.register({
      key: 'published-contract', stateVersion: 1,
      stateSchema: z.object({ source: z.unknown().nullable(), eventSeq: z.number().nullable() }),
      init: () => ({ source: null, eventSeq: null }),
      apply: (state, event) => event.type === 'user/message' && event.data.source.kind === CONTROL_KIND
        ? { source: event.data.source, eventSeq: event.seq } : state,
    });
    await stage('startup/agentLoop', () => ctx.plugin(AgentLoop, { agents: [] }));
    const agentOptions = { provider: 'contract-replay', model: 'contract-model' };
    handle = await stage(resumeId ? 'agent/resume' : 'agent/create', () => resumeId
      ? ctx.agents.resume({ resumeSessionId: SessionId(resumeId), agentOptions })
      : ctx.agents.create({ sessionId: SessionId(sessionId), meta: { cwd: directory,
        ...(seed ? { isSeeded: true, parentSession: SessionId(parentSessionId) } : {}) },
        ...(seed ? { seed, inheritedEventCount: seed.length } : {}), agentOptions }));
    return {
      ctx, agent: handle.agent, replay, requests, directory,
      close,
    };
  } catch (error) {
    console.error(`[published-contract] ORIGINAL startup failure: ${error.stack ?? error}`);
    await cleanup([['rollback/host', close, 20000]], error);
    throw error;
  }
}

export async function prepareToolHistory(host) {
  host.agent.followup(user('contract-initial-user', 'Read the filesystem contract fixture.'));
  await stage('history/initial-agent-idle', () => host.agent.whenIdle());
  assert.equal(host.requests.length, 2, 'real tool dispatch must cause the follow-on model request');
  const surface = await host.ctx.sessionQuery.readSurface(host.agent.session.id);
  const result = surface.events.find(event => event.type === 'tool/result');
  assert.ok(result, 'production tool result missing');
  assert.notEqual(result.data.message.isError, true, 'filesystem tool unexpectedly failed');
  assert.equal(result.data.message.content[0].text, ORIGINAL);
  return result;
}

async function probe() {
  const require = createRequire(import.meta.url);
  const cliPackage = require.resolve('@deepseek-ai/dsh/package.json');
  const cliMeta = JSON.parse(await readFile(cliPackage, 'utf8'));
  assert.equal(cliMeta.version, VERSION);
  const cliVersion = execFileSync(process.execPath, [join(dirname(cliPackage), cliMeta.bin.dsh), '--version'], { encoding: 'utf8', timeout: STAGE_TIMEOUT_MS }).trim();
  assert.ok(cliVersion.includes(VERSION), `unexpected installed CLI version: ${cliVersion}`);
  const directory = await mkdtemp(join(tmpdir(), 'dsh-published-contract-run-'));
  let host;
  let reopened;
  let memory;
  const evidence = { version: VERSION, node: process.version, cliVersion };
  let originalError;
  try {
    host = await createContractHost({ directory });
    const { ctx, agent } = host;
    const original = await prepareToolHistory(host);
    const requestsBeforeCommand = host.requests.length;
    const derivedBeforeCommand = agent.session.deriveMessages();
    let control;
    ctx.commands.register({
      name: 'contract', description: 'Persist a contract control record without waking the agent.', recordInput: false,
      handler: ({ agent: receiver }) => receiver.runMaintenance(async signal => {
        assert.equal(signal.aborted, false);
        assert.equal(receiver.status, 'idle');
        control = receiver.session.append('user/message', user('contract-control', 'Deferred contract request.', CONTROL_SOURCE), { surfaceOp: 'append' });
        assert.equal(await ctx.sessions.flush(receiver.session), true, 'JSONL backend must participate in flush');
        return { kind: 'success', text: 'Persisted contract request.', sourceEventSeq: control.seq };
      }),
    });
    const execution = await stage('command/persist-control', () => ctx.commands.execute(agent, '/contract', [], new AbortController().signal));
    await stage('command/assertions', () => {
      assert.equal(execution.result.kind, 'success');
      assert.equal(execution.result.sourceEventSeq, control.seq);
      assert.equal(host.requests.length, requestsBeforeCommand, 'command must not invoke model');
      assert.deepEqual(agent.session.deriveMessages().slice(0, derivedBeforeCommand.length), derivedBeforeCommand);
      assert.deepEqual(ctx.sessionProjections.stateOf(agent.session, 'published-contract'), { source: CONTROL_SOURCE, eventSeq: control.seq });
    });
    await stage('maintenance/exclusivity', async () => {
      let release;
      let heldSettled = false;
      let competingEntered = false;
      const held = agent.runMaintenance(() => new Promise(resolve => { release = resolve; }));
      held.then(() => { heldSettled = true; }, () => { heldSettled = true; });
      try {
        assert.equal(typeof release, 'function', 'maintenance operation must enter synchronously');
        assert.throws(() => agent.runMaintenance(async () => { competingEntered = true; }), Error, 'maintenance claim must be exclusive');
        assert.equal(competingEntered, false, 'competing maintenance callback must not run');
        await Promise.resolve();
        assert.equal(heldSettled, false, 'first maintenance must remain held until released');
      } finally {
        // Release even when exclusivity fails: teardown drains maintenance.
        release?.();
        await stage('maintenance/release', () => held);
        assert.equal(heldSettled, true, 'first maintenance must settle after release');
      }
    });
    let replacement;
    let prune;
    let enteredTurn;
    const removeHook = ctx.on('agent/pre-step', async (payload, next) => {
      if (replacement) return next();
      assert.equal(payload.agent, agent);
      const before = await ctx.sessionQuery.readSession(agent.session.id);
      enteredTurn = before.events.findLast(event => event.type === 'turn/start');
      assert.equal(enteredTurn.data.turn, payload.turn);
      assert.equal(before.events.some(event => event.type === 'step/start' && event.data.turn === payload.turn), false, 'pre-step must precede step/start');
      const message = { ...original.data.message, content: [{ type: 'text', text: REDUCED }] };
      prune = agent.session.append('compaction/prune', {
        shadowedRange: { start: original.seq, end: original.seq }, shadowedSeqs: [original.seq],
        shadowedTokenCount: ctx.tokenMeter.estimateMessage(original.data.message),
      });
      replacement = agent.session.append('tool/result', { ...original.data, message }, {
        surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq }, sourceEventSeqs: [original.seq],
      });
      assert.equal(replacement.seq, prune.seq + 1, 'shadow-price claim must be immediately adjacent');
      assert.equal(await ctx.sessions.flush(agent.session), true, 'replacement must flush before model dispatch');
      return next();
    }, { prepend: true });
    const measuredBefore = ctx.tokenMeter.measure(agent.session);
    agent.followup(user('contract-later-user', 'Continue with the reduced historical context.'));
    await stage('history/reduced-agent-idle', () => agent.whenIdle());
    removeHook();
    assert.ok(replacement, 'next natural pre-step must execute replacement');
    assert.equal(host.requests.length, 3);
    const lastRequest = host.requests.at(-1);
    assert.ok(lastRequest.some(message => message.role === 'tool' && message.content[0]?.text === REDUCED));
    assert.equal(lastRequest.some(message => message.role === 'tool' && message.content[0]?.text === ORIGINAL), false);
    assert.deepEqual(replacement.sourceEventSeqs, [original.seq]);
    const log = await ctx.sessionQuery.readSession(agent.session.id);
    const newStep = log.events.find(event => event.type === 'step/start' && event.data.turn === enteredTurn.data.turn);
    assert.ok(enteredTurn.seq < prune.seq && replacement.seq < newStep.seq, 'turn/start < prune/replacement < step/start');
    const untouched = (await ctx.sessionQuery.readEvent({ sessionId: agent.session.id, seq: original.seq })).target;
    assert.deepEqual(untouched, original, 'append-only original must remain intact');
    const changedIdentity = { ...replacement.data.message }; delete changedIdentity.content;
    const originalIdentity = { ...original.data.message }; delete originalIdentity.content;
    assert.deepEqual(changedIdentity, originalIdentity, 'only tool content may change');
    const derived = agent.session.deriveMessages();
    const projected = structuredClone(ctx.sessionProjections.stateOf(agent.session, 'published-contract'));
    const measurement = ctx.tokenMeter.measure(agent.session);
    assert.ok(ctx.tokenMeter.estimateMessage(replacement.data.message) < ctx.tokenMeter.estimateMessage(original.data.message));
    assert.ok(measurement.surfaceTokens < measuredBefore.surfaceTokens, 'large tool rewrite must reduce actual metered surface despite new turn messages');
    assert.equal(measurement.surfaceTokens, measurement.nodes.reduce((total, node) => total + node.tokens, 0));
    assert.equal(measurement.nodes.some(node => node.seq === original.seq), false);
    assert.equal(measurement.nodes.find(node => node.seq === replacement.seq).heuristicTokens, ctx.tokenMeter.estimateMessage(replacement.data.message));
    assert.equal(await ctx.sessions.flush(agent.session), true);
    host.replay.assertConsumed();
    await host.close(); host = undefined;
    reopened = await createContractHost({ directory, resumeId: 'published-contract-session' });
    assert.deepEqual(reopened.agent.session.deriveMessages(), derived, 'JSONL teardown/reopen must preserve derived history');
    assert.deepEqual(reopened.ctx.sessionProjections.stateOf(reopened.agent.session, 'published-contract'), projected, 'host-only state must rebuild from persisted log');
    const restoredControl = (await reopened.ctx.sessionQuery.readEvent({ sessionId: reopened.agent.session.id, seq: control.seq })).target;
    assert.deepEqual(restoredControl.data.source, CONTROL_SOURCE, 'custom source metadata must survive persistence');
    assert.deepEqual((await reopened.ctx.sessionQuery.readEvent({ sessionId: reopened.agent.session.id, seq: original.seq })).target, original);
    assert.deepEqual((await reopened.ctx.sessionQuery.readEvent({ sessionId: reopened.agent.session.id, seq: replacement.seq })).target, replacement);
    const { logRevision: restoredRevision, ...restoredMeasurement } = reopened.ctx.tokenMeter.measure(reopened.agent.session);
    const { logRevision: originalRevision, ...originalMeasurement } = measurement;
    assert.deepEqual(restoredMeasurement, originalMeasurement, 'meter node estimates, baseline and token totals must reconstruct identically');
    const restoredLog = await reopened.ctx.sessionQuery.readSession(reopened.agent.session.id);
    assert.deepEqual(restoredLog.events.slice(0, originalRevision), log.events, 'resume must preserve every existing durable event');
    const resumedEvents = restoredLog.events.slice(originalRevision);
    assert.equal(resumedEvents.length, 1, 'resume must append only its lifecycle boundary');
    assert.equal(resumedEvents[0].type, 'session/end-seed');
    assert.deepEqual(resumedEvents[0].data, {});
    assert.equal(restoredRevision, originalRevision + resumedEvents.length, 'resume lifecycle boundary legitimately advances meter log revision');
    const restoredSurface = await reopened.ctx.sessionQuery.readSurface(reopened.agent.session.id);
    assert.ok(restoredSurface.events.some(event => event.seq === replacement.seq));
    assert.equal(restoredSurface.events.some(event => event.seq === original.seq), false);
    assert.equal(await reopened.ctx.sessions.flush(reopened.agent.session), true);
    await reopened.close(); reopened = undefined;
    memory = await createContractHost({ persistence: false });
    assert.equal(await memory.ctx.sessions.flush(memory.agent.session), false, 'no persistence listener must return false');
    await memory.close(); memory = undefined;
    Object.assign(evidence, { initialModelCalls: 2, finalModelCalls: 3, originalSeq: original.seq, pruneSeq: prune.seq, replacementSeq: replacement.seq, controlSeq: control.seq, persistedReopen: true, noPersistenceFlush: false });
    console.log(JSON.stringify({ publishedContract: 'PASS', evidence }, null, 2));
  } catch (error) {
    originalError = error;
    console.error(`[published-contract] ORIGINAL probe failure: ${error.stack ?? error}`);
    throw error;
  } finally {
    await cleanup([
      ...(memory ? [['cleanup/memory', () => memory.close(), 20000]] : []),
      ...(reopened ? [['cleanup/reopened', () => reopened.close(), 20000]] : []),
      ...(host ? [['cleanup/host', () => host.close(), 20000]] : []),
      ['cleanup/directory', () => rm(directory, { recursive: true, force: true })],
    ], originalError);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await stage('probe', probe, 180000); } catch (error) {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  }
}
