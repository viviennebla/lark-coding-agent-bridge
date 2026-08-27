import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionCatalog } from '../../../src/session/catalog.js';
import { CodexRuntimeCoordinator } from '../../../src/runtime/codex-runtime-coordinator.js';

class FakeRpc extends EventEmitter {
  calls: Array<{ method: string; params: unknown }> = [];
  threadId = 'thread-1'; turn = 0;
  failInterrupt = false; failRead = false; failTurnStart = false;
  ambiguousTurnStart = false;
  ambiguousNoMatch = false;
  ambiguousClientId = 'msg-ambiguous';
  rejectTurnStartWithoutDisconnect = false;
  temporarilyUnsteerable = false;
  fatalSteer = false;
  async request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: this.threadId } } as T;
    if (method === 'thread/read') { if (this.failRead) throw new Error('read failed'); return { thread: { id: this.threadId, turns: [{ id: `turn-${this.turn}`, status: this.ambiguousTurnStart ? 'inProgress' : 'completed', items: this.ambiguousTurnStart && !this.ambiguousNoMatch ? [{ type: 'userMessage', clientId: this.ambiguousClientId }] : [] }] } } as T; }
    if (method === 'turn/interrupt' && this.failInterrupt) throw new Error('interrupt failed');
    if (method === 'turn/steer' && this.temporarilyUnsteerable) throw new Error('ActiveTurnNotSteerable: review turn');
    if (method === 'turn/steer' && this.fatalSteer) throw new Error('permission denied');
    if (method === 'turn/start' && this.failTurnStart) throw new Error('turn start failed');
    if (method === 'turn/start' && this.rejectTurnStartWithoutDisconnect) { this.ambiguousTurnStart = true; this.ambiguousClientId = String((params as { clientUserMessageId?: string })?.clientUserMessageId); this.turn++; throw new Error('request timed out'); }
    if (method === 'turn/start' && this.ambiguousTurnStart) { this.ambiguousClientId = String((params as { clientUserMessageId?: string })?.clientUserMessageId); this.turn++; this.emit('disconnect'); this.emit('ready'); throw new Error('connection closed before response'); }
    if (method === 'turn/start') return { turn: { id: `turn-${++this.turn}` } } as T;
    return {} as T;
  }
}

const base = { scopeId: 'chat:1', agentId: 'codex' as const, cwdRealpath: '/work', policyFingerprint: 'policy' };
async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'codex-runtime-'));
  const catalog = new SessionCatalog(join(dir, 'catalog.json'));
  const rpc = new FakeRpc();
  return { rpc, catalog, runtime: new CodexRuntimeCoordinator(rpc, catalog) };
}

describe('CodexRuntimeCoordinator', () => {
  it('starts then steers a running turn', async () => {
    const { runtime, rpc } = await harness();
    await runtime.submitMessage({ ...base, message: 'first', messageId: 'msg-1', images: ['/tmp/a.png'], ignoreRules: true, ignoreUserConfig: true });
    const second = await runtime.submitMessage({ ...base, message: 'second', messageId: 'msg-2' });
    expect(second.action).toBe('steered');
    expect(rpc.calls.map((call) => call.method)).toEqual(['thread/start', 'turn/start', 'turn/steer']);
    expect(rpc.calls[0]?.params).toMatchObject({ approvalPolicy: 'never', config: { shell_environment_policy: { inherit: 'all' }, skip_git_repo_check: true, ignore_rules: true, ignore_user_config: true } });
    expect(rpc.calls[1]?.params).toMatchObject({ clientUserMessageId: 'msg-1', approvalPolicy: 'never', input: [{ type: 'text', text: 'first', text_elements: [] }, { type: 'localImage', path: '/tmp/a.png' }] });
    expect(rpc.calls[2]?.params).toEqual({ threadId: 'thread-1', expectedTurnId: 'turn-1', clientUserMessageId: 'msg-2', input: [{ type: 'text', text: 'second', text_elements: [] }] });
  });
  it('queues a different identity instead of steering it into the active turn', async () => {
    const { runtime, rpc } = await harness(); await runtime.submitMessage({ ...base, message: 'first' }); const queued = runtime.submitMessage({ ...base, cwdRealpath: '/other', policyFingerprint: 'other-policy', message: 'other', messageId: 'msg-other', images: ['/tmp/other.png'] });
    expect(rpc.calls.filter((call) => call.method === 'turn/steer')).toHaveLength(0); rpc.emit('notification', { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } }); await expect(queued).resolves.toMatchObject({ action: 'started', turnId: 'turn-2' }); expect(rpc.calls.at(-1)).toMatchObject({ method: 'turn/start', params: { clientUserMessageId: 'msg-other', input: [{ type: 'text', text: 'other', text_elements: [] }, { type: 'localImage', path: '/tmp/other.png' }] } });
  });
  it('queues a recognized temporarily unsteerable turn until completion', async () => {
    const { runtime, rpc } = await harness(); await runtime.submitMessage({ ...base, message: 'first' }); rpc.temporarilyUnsteerable = true; const queued = runtime.submitMessage({ ...base, message: 'review followup' }); await new Promise((resolve) => setImmediate(resolve)); expect(rpc.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1); rpc.temporarilyUnsteerable = false; rpc.emit('notification', { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } }); await expect(queued).resolves.toMatchObject({ action: 'started', turnId: 'turn-2' });
  });
  it('rejects non-transient steer errors without queueing them', async () => {
    const { runtime, rpc } = await harness(); await runtime.submitMessage({ ...base, message: 'first' }); rpc.fatalSteer = true; await expect(runtime.submitMessage({ ...base, message: 'bad steer' })).rejects.toThrow('permission denied'); rpc.emit('notification', { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } }); await new Promise((resolve) => setImmediate(resolve)); expect(rpc.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1);
  });

  it('resumes an existing catalog thread', async () => {
    const { runtime, rpc, catalog } = await harness();
    catalog.upsertActive({ ...base, threadId: 'thread-existing' });
    rpc.threadId = 'thread-existing';
    await runtime.submitMessage({ ...base, message: 'again' });
    expect(rpc.calls[0]).toMatchObject({ method: 'thread/resume', params: { threadId: 'thread-existing' } });
  });

  it('does not release a stopped scope until matching completion', async () => {
    const { runtime, rpc } = await harness();
    await runtime.submitMessage({ ...base, message: 'first' });
    await expect(runtime.stop(base.scopeId)).resolves.toBe(true);
    const queued = runtime.submitMessage({ ...base, message: 'queued' });
    expect(runtime.state(base.scopeId).state).toBe('stopping');
    rpc.emit('notification', { jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'wrong', turn: { id: 'turn-1', status: 'interrupted' } } });
    expect(runtime.state(base.scopeId).state).toBe('stopping');
    rpc.emit('notification', { jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } } });
    const dispatched = await queued;
    expect(dispatched).toMatchObject({ action: 'started', turnId: 'turn-2' });
    expect(dispatched.events).toBeDefined();
    expect(rpc.calls.filter((call) => call.method === 'turn/start')).toHaveLength(2);
    rpc.emit('notification', { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(runtime.state(base.scopeId)).toMatchObject({ state: 'running', turnId: 'turn-2' });
  });

  it('ignores a completion whose commit is delayed until the scope is reconciling', async () => {
    const { runtime, rpc } = await harness();
    await runtime.submitMessage({ ...base, message: 'first' });
    rpc.emit('notification', { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    rpc.emit('disconnect');
    await new Promise((resolve) => setImmediate(resolve));
    expect(runtime.state(base.scopeId)).toMatchObject({ state: 'reconciling', turnId: 'turn-1' });
  });

  it('translates generated delta and terminal notification shapes into agent events', async () => {
    const { runtime, rpc } = await harness();
    const started = await runtime.submitMessage({ ...base, message: 'first' });
    const received: unknown[] = [];
    const collecting = (async () => { for await (const event of started.events!) received.push(event); })();
    rpc.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'hello' } });
    rpc.emit('notification', { method: 'item/reasoning/summaryTextDelta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'reason-1', delta: 'thinking', summaryIndex: 0 } });
    rpc.emit('notification', { method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', startedAtMs: 1, item: { type: 'commandExecution', id: 'tool-1', command: 'pwd', status: 'inProgress' } } });
    rpc.emit('notification', { method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', completedAtMs: 2, item: { type: 'commandExecution', id: 'tool-1', command: 'pwd', status: 'completed', aggregatedOutput: '/work' } } });
    rpc.emit('notification', { method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', startedAtMs: 2, item: { type: 'imageView', id: 'image-1', path: '/tmp/a.png' } } });
    rpc.emit('notification', { method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', tokenUsage: { total: { inputTokens: 4, outputTokens: 3, cachedInputTokens: 2, reasoningOutputTokens: 1, totalTokens: 7 } } } });
    rpc.emit('notification', { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [], error: null } } });
    await collecting;
    expect(received).toEqual([
      { type: 'system', threadId: 'thread-1', cwd: '/work', model: undefined },
      { type: 'text', delta: 'hello' },
      { type: 'thinking', delta: 'thinking' },
      { type: 'tool_use', id: 'tool-1', name: 'commandExecution', input: 'pwd' },
      { type: 'tool_result', id: 'tool-1', output: '/work', isError: false },
      { type: 'tool_use', id: 'image-1', name: 'imageView', input: '/tmp/a.png' },
      { type: 'usage', inputTokens: 4, outputTokens: 3, cachedInputTokens: 2, reasoningOutputTokens: 1 },
      { type: 'done', threadId: 'thread-1', terminationReason: 'normal' },
    ]);
  });

  it('keeps an active stream through transient disconnect and resumes queued work after supervisor readiness', async () => {
    const { runtime, rpc } = await harness();
    const started = await runtime.submitMessage({ ...base, message: 'first' });
    const received: unknown[] = [];
    const collecting = (async () => { for await (const event of started.events!) received.push(event); })();
    rpc.emit('disconnect');
    expect(runtime.state(base.scopeId).state).toBe('reconciling');
    const queued = runtime.submitMessage({ ...base, message: 'after restart' });
    rpc.emit('ready');
    await expect(queued).resolves.toMatchObject({ action: 'started', turnId: 'turn-2' });
    await collecting;
    expect(received.at(-1)).toMatchObject({ type: 'done' });
    expect(rpc.calls.filter((call) => call.method === 'turn/start')).toHaveLength(2);
  });

  it('reconciles a turn accepted before a lost turn/start response without duplicating it', async () => {
    const { runtime, rpc } = await harness(); rpc.ambiguousTurnStart = true;
    const result = await runtime.submitMessage({ ...base, message: 'ambiguous', messageId: 'msg-ambiguous' });
    expect(result).toMatchObject({ action: 'started', turnId: 'turn-1' });
    expect(rpc.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1);
  });
  it('fails closed when an ambiguous start cannot be matched and never retries turn/start', async () => {
    const { runtime, rpc } = await harness(); rpc.ambiguousTurnStart = true; rpc.ambiguousNoMatch = true;
    await expect(runtime.submitMessage({ ...base, message: 'ambiguous', messageId: 'msg-ambiguous' })).rejects.toThrow(/could not be reconciled/);
    expect(rpc.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1); expect(rpc.calls.filter((call) => call.method === 'turn/interrupt')).toHaveLength(0); expect(runtime.state(base.scopeId).state).toBe('failed');
  });
  it('reconciles a timed out turn/start request even without a disconnect event', async () => {
    const { runtime, rpc } = await harness(); rpc.rejectTurnStartWithoutDisconnect = true;
    await expect(runtime.submitMessage({ ...base, message: 'timeout', messageId: 'msg-timeout' })).resolves.toMatchObject({ action: 'started', turnId: 'turn-1' }); expect(rpc.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1); expect(runtime.state(base.scopeId).state).toBe('running');
  });
  it('generates one stable id for a no-disconnect response loss when caller omitted messageId', async () => {
    const { runtime, rpc } = await harness(); rpc.rejectTurnStartWithoutDisconnect = true;
    await expect(runtime.submitMessage({ ...base, message: 'timeout-no-id' })).resolves.toMatchObject({ action: 'started', turnId: 'turn-1' }); expect(rpc.ambiguousClientId).toMatch(/\S/); expect(rpc.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1); expect(runtime.state(base.scopeId).state).toBe('running');
  });
  it('fails closed after disconnect when a generated id cannot be matched, without resubmitting', async () => {
    const { runtime, rpc } = await harness(); rpc.ambiguousTurnStart = true; rpc.ambiguousNoMatch = true;
    await expect(runtime.submitMessage({ ...base, message: 'disconnect-no-id', messageId: '' })).rejects.toThrow(/could not be reconciled/); expect(rpc.ambiguousClientId).toMatch(/\S/); expect(rpc.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1); expect(runtime.state(base.scopeId).state).toBe('failed');
  });

  it('bounds interrupt and reconcile failures, closes events, and rejects queued work', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-runtime-')); const catalog = new SessionCatalog(join(dir, 'catalog.json')); const rpc = new FakeRpc();
    const runtime = new CodexRuntimeCoordinator(rpc, catalog, 20, { terminalTimeoutMs: 5, reconcileAttempts: 1, reconcileBackoffMs: 1 });
    const started = await runtime.submitMessage({ ...base, message: 'first' });
    rpc.failInterrupt = true; rpc.failRead = true;
    await runtime.stop(base.scopeId);
    const queued = runtime.submitMessage({ ...base, message: 'queued' });
    await expect(queued).rejects.toThrow(/did not reach a terminal state/);
    const events: unknown[] = []; for await (const event of started.events!) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'error', terminationReason: 'failed' });
    expect(runtime.state(base.scopeId).state).toBe('failed');
  });

  it('fails closed when a sent turn/start request cannot be reconciled', async () => {
    const { runtime, rpc } = await harness(); rpc.failTurnStart = true;
    await expect(runtime.submitMessage({ ...base, message: 'bad', messageId: 'msg-bad' })).rejects.toThrow(/could not be reconciled/);
    expect(runtime.state(base.scopeId).state).toBe('failed'); expect(rpc.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1);
  });
});
