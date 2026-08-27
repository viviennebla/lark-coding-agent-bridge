import type { JsonRpcNotification } from '../agent/codex/app-server/protocol';
import { turnCompletedParams } from '../agent/codex/app-server/protocol';
import type { SessionCatalog, SessionCatalogIdentity } from '../session/catalog';
import type { AgentEvent } from '../agent/types';
import { randomUUID } from 'node:crypto';

export interface CodexRpc {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  on(event: 'notification', listener: (event: JsonRpcNotification) => void): unknown;
}
export type CodexScopeState = 'idle' | 'starting' | 'running' | 'stopping' | 'draining' | 'reconciling' | 'failed';
export interface CodexSubmitInput extends SessionCatalogIdentity { message: string; messageId?: string; model?: string; sandbox?: string; images?: readonly string[]; ignoreRules?: boolean; ignoreUserConfig?: boolean }
interface Queued { input: CodexSubmitInput; resolve: (result: CodexSubmitResult) => void; reject: (error: unknown) => void }
interface Scope { state: CodexScopeState; threadId?: string; turnId?: string; identity?: SessionCatalogIdentity; queue: Queued[]; serial: Promise<void>; events?: EventQueue; terminalTimer?: NodeJS.Timeout; pendingMessageId?: string }
export interface CodexRuntimeOptions { terminalTimeoutMs?: number; reconcileAttempts?: number; reconcileBackoffMs?: number }
export interface CodexSubmitResult { accepted: true; action: 'started' | 'steered' | 'queued'; threadId?: string; turnId?: string; events?: AsyncIterable<AgentEvent> }

export class CodexRuntimeCoordinator {
  private readonly scopes = new Map<string, Scope>();
  constructor(private readonly rpc: CodexRpc, private readonly catalog: SessionCatalog, private readonly maxQueue = 20, private readonly options: CodexRuntimeOptions = {}) {
    rpc.on('notification', (event) => this.notification(event));
    const disconnectable = rpc as CodexRpc & { on(event: 'disconnect', listener: () => void): unknown };
    disconnectable.on('disconnect', () => this.disconnected());
    const restartable = rpc as CodexRpc & { on(event: 'ready', listener: () => void): unknown };
    restartable.on('ready', () => this.reconnected());
  }

  state(scopeId: string): Readonly<Scope> { return this.scope(scopeId); }
  submitMessage(input: CodexSubmitInput): Promise<CodexSubmitResult> {
    const normalized = { ...input, messageId: typeof input.messageId === 'string' && input.messageId.trim() ? input.messageId : randomUUID() };
    const scope = this.scope(normalized.scopeId);
    if (scope.state === 'failed') return Promise.reject(new Error('Codex scope failed reconciliation'));
    if (scope.state !== 'idle' && scope.state !== 'running') return this.enqueue(scope, normalized);
    if (scope.state === 'running' && !sameIdentity(scope.identity, normalized)) return this.enqueue(scope, normalized);
    return this.serialize(scope, () => this.submit(scope, normalized)).catch((error) => error instanceof QueueAfterSteerError ? this.enqueue(scope, error.input) : Promise.reject(error));
  }
  steerMessage(scopeId: string, message: string, messageId?: string): Promise<boolean> {
    const scope = this.scope(scopeId);
    return this.serialize(scope, async () => {
      if (scope.state !== 'running' || !scope.identity) return false;
      await this.submit(scope, { ...scope.identity, message, messageId });
      return true;
    });
  }
  stop(scopeId: string): Promise<boolean> {
    const scope = this.scope(scopeId);
    return this.serialize(scope, async () => {
      if (scope.state !== 'running' || !scope.threadId || !scope.turnId) return false;
      scope.state = 'stopping';
      try { await this.rpc.request('turn/interrupt', { threadId: scope.threadId, turnId: scope.turnId }); }
      catch { void this.reconcile(scope); return true; }
      this.armTerminalTimeout(scope);
      return true;
    });
  }
  async drain(timeoutMs = 300_000): Promise<void> {
    for (const [scopeId, scope] of this.scopes) if (scope.state === 'running') await this.stop(scopeId);
    const deadline = Date.now() + timeoutMs;
    while ([...this.scopes.values()].some((scope) => !['idle', 'failed'].includes(scope.state))) { if (Date.now() >= deadline) throw new Error('timed out draining Codex runtime'); await delay(25); }
  }

  private async submit(scope: Scope, input: CodexSubmitInput): Promise<CodexSubmitResult> {
    if (scope.state === 'running') {
      if (!scope.threadId || !scope.turnId || !sameIdentity(scope.identity, input)) return this.enqueue(scope, input);
      try { await this.rpc.request('turn/steer', { threadId: scope.threadId, expectedTurnId: scope.turnId, clientUserMessageId: input.messageId, input: userInput(input) }); }
      catch (error) { if (isTemporarilyUnsteerable(error)) throw new QueueAfterSteerError(input); throw error; }
      return { accepted: true, action: 'steered', threadId: scope.threadId, turnId: scope.turnId, events: scope.events };
    }
    if (scope.state !== 'idle') return this.enqueue(scope, input);
    scope.state = 'starting'; scope.identity = identity(input);
    try {
      const existing = this.catalog.activeFor(input)?.threadId;
      const thread = existing
        ? await this.rpc.request<{ thread: { id: string } }>('thread/resume', {
            threadId: existing, cwd: input.cwdRealpath, approvalPolicy: 'never',
            ...(input.model ? { model: input.model } : {}), ...(input.sandbox ? { sandbox: input.sandbox } : {}),
            config: runtimeConfig(input),
          })
        : await this.rpc.request<{ thread: { id: string } }>('thread/start', {
          cwd: input.cwdRealpath,
          approvalPolicy: 'never',
          ...(input.model ? { model: input.model } : {}),
          ...(input.sandbox ? { sandbox: input.sandbox } : {}),
          config: runtimeConfig(input),
        });
      scope.threadId = thread.thread.id;
      this.catalog.upsertActive({ ...input, agentId: 'codex', threadId: scope.threadId });
      scope.events = new EventQueue();
      scope.events.push({ type: 'system', threadId: scope.threadId, cwd: input.cwdRealpath, model: input.model });
      scope.pendingMessageId = input.messageId;
      const turn = await this.rpc.request<{ turn: { id: string } }>('turn/start', { threadId: scope.threadId, clientUserMessageId: input.messageId, approvalPolicy: 'never', input: userInput(input) });
      scope.turnId = turn.turn.id; scope.state = 'running';
      scope.pendingMessageId = undefined;
      return { accepted: true, action: 'started', threadId: scope.threadId, turnId: scope.turnId, events: scope.events };
    } catch (error) {
      if (scope.pendingMessageId === input.messageId && scope.threadId && input.messageId) { scope.state = 'reconciling'; return this.reconcileAmbiguousStart(scope, input); }
      scope.events?.push({ type: 'error', message: error instanceof Error ? error.message : String(error), terminationReason: 'failed' });
      scope.events?.close(); scope.events = undefined; scope.turnId = undefined; scope.state = 'idle';
      throw error;
    }
  }

  private notification(event: JsonRpcNotification): void {
    if (event.method === 'item/agentMessage/delta') {
      const raw = record(event.params);
      if (typeof raw?.threadId !== 'string' || typeof raw.turnId !== 'string' || typeof raw.delta !== 'string') return;
      const scope = [...this.scopes.values()].find((candidate) => candidate.threadId === raw.threadId && candidate.turnId === raw.turnId);
      scope?.events?.push({ type: 'text', delta: raw.delta });
      return;
    }
    const raw = record(event.params); const scope = raw && typeof raw.threadId === 'string' ? [...this.scopes.values()].find((candidate) => candidate.threadId === raw.threadId && (event.method === 'thread/tokenUsage/updated' || (typeof raw.turnId === 'string' && candidate.turnId === raw.turnId))) : undefined;
    if (scope?.events && (event.method === 'item/reasoning/summaryTextDelta' || event.method === 'item/reasoning/textDelta') && typeof raw?.delta === 'string') { scope.events.push({ type: 'thinking', delta: raw.delta }); return; }
    if (scope?.events && event.method === 'item/mcpToolCall/progress' && typeof raw?.message === 'string') { scope.events.push({ type: 'thinking', delta: raw.message }); return; }
    if (scope?.events && event.method === 'thread/tokenUsage/updated') { const total = record(record(raw?.tokenUsage)?.total); scope.events.push({ type: 'usage', inputTokens: number(total?.inputTokens), outputTokens: number(total?.outputTokens), cachedInputTokens: number(total?.cachedInputTokens), reasoningOutputTokens: number(total?.reasoningOutputTokens) }); return; }
    if (scope?.events && (event.method === 'item/started' || event.method === 'item/completed')) { const item = record(raw?.item); const tool = toolItem(item); if (tool) { scope.events.push(event.method === 'item/started' ? { type: 'tool_use', id: tool.id, name: tool.name, input: tool.input } : { type: 'tool_result', id: tool.id, output: tool.output, isError: tool.isError }); } return; }
    if (event.method !== 'turn/completed') return;
    const completed = turnCompletedParams(event.params); if (!completed) return;
    for (const scope of this.scopes.values()) {
      if (scope.threadId !== completed.threadId || scope.turnId !== completed.turn.id) continue;
      const completedThreadId = completed.threadId;
      const completedTurnId = completed.turn.id;
      void this.serialize(scope, async () => {
        if (
          scope.threadId !== completedThreadId ||
          scope.turnId !== completedTurnId ||
          (scope.state !== 'running' && scope.state !== 'stopping')
        ) return;
        this.finish(scope, completed.turn.status);
      });
    }
  }
  private disconnected(): void {
    for (const scope of this.scopes.values()) {
      if (scope.state === 'idle') continue;
      scope.state = 'reconciling';
      this.armTerminalTimeout(scope);
    }
  }
  private reconnected(): void {
    for (const scope of this.scopes.values()) {
      if (scope.state !== 'reconciling' || scope.pendingMessageId) continue;
      void this.reconcile(scope);
    }
  }
  private armTerminalTimeout(scope: Scope): void {
    if (scope.terminalTimer) clearTimeout(scope.terminalTimer);
    scope.terminalTimer = setTimeout(() => { void this.reconcile(scope); }, this.options.terminalTimeoutMs ?? 30_000);
  }
  private reconcile(scope: Scope): Promise<void> {
    return this.serialize(scope, async () => {
      const attempts = this.options.reconcileAttempts ?? 3;
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          if (!scope.threadId || !scope.turnId) throw new Error('missing active turn identity');
          const response = await this.rpc.request('thread/read', { threadId: scope.threadId, includeTurns: true });
          const thread = record(record(response)?.thread); const turns = Array.isArray(thread?.turns) ? thread.turns : [];
          const turn = turns.map(record).find((candidate) => candidate?.id === scope.turnId);
          if (!turn || typeof turn.status !== 'string') throw new Error('active turn not found during reconcile');
          if (turn.status === 'completed' || turn.status === 'interrupted' || turn.status === 'failed') { this.finish(scope, turn.status); return; }
          if (turn.status !== 'inProgress') throw new Error(`unknown turn status: ${turn.status}`);
          await this.rpc.request('turn/interrupt', { threadId: scope.threadId, turnId: scope.turnId });
        } catch { /* bounded retry below */ }
        if (attempt + 1 < attempts) await delay(this.options.reconcileBackoffMs ?? 100);
      }
      this.failScope(scope, new Error('Codex turn did not reach a terminal state after reconciliation'));
    });
  }
  private async reconcileAmbiguousStart(scope: Scope, input: CodexSubmitInput): Promise<CodexSubmitResult> {
    if (scope.terminalTimer) clearTimeout(scope.terminalTimer); scope.terminalTimer = undefined;
    const attempts = this.options.reconcileAttempts ?? 3;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const response = await this.rpc.request('thread/read', { threadId: scope.threadId, includeTurns: true }); const thread = record(record(response)?.thread); const turns = Array.isArray(thread?.turns) ? thread.turns.map(record) : [];
        const matched = turns.find((turn) => Array.isArray(turn?.items) && turn.items.some((value) => { const item = record(value); return item?.type === 'userMessage' && item.clientId === input.messageId; }));
        if (matched && typeof matched.id === 'string') { scope.turnId = matched.id; scope.pendingMessageId = undefined; const events = scope.events; const status = matched.status; if (status === 'completed' || status === 'interrupted' || status === 'failed') { scope.state = 'running'; this.finish(scope, String(status)); } else scope.state = 'running'; return { accepted: true, action: 'started', threadId: scope.threadId, turnId: scope.turnId, events }; }
      } catch { /* bounded retry */ }
      if (attempt + 1 < attempts) await delay(this.options.reconcileBackoffMs ?? 100);
    }
    const failure = new Error('Codex ambiguous turn start could not be reconciled'); this.failScope(scope, failure); throw failure;
  }
  private finish(scope: Scope, status: string): void {
    if (scope.terminalTimer) clearTimeout(scope.terminalTimer); scope.terminalTimer = undefined;
    const interrupted = status === 'interrupted' || scope.state === 'stopping'; scope.state = 'draining';
    scope.events?.push(status === 'failed' ? { type: 'error', message: 'Codex turn failed', terminationReason: 'failed' } : { type: 'done', threadId: scope.threadId, terminationReason: interrupted ? 'interrupted' : 'normal' });
    scope.events?.close(); scope.events = undefined; scope.turnId = undefined; scope.state = 'idle';
    const next = scope.queue.shift(); if (next) this.submit(scope, next.input).then(next.resolve, next.reject);
  }
  private failScope(scope: Scope, error: Error): void {
    if (scope.terminalTimer) clearTimeout(scope.terminalTimer); scope.terminalTimer = undefined;
    scope.state = 'failed'; scope.events?.push({ type: 'error', message: error.message, terminationReason: 'failed' }); scope.events?.close(); scope.events = undefined; scope.turnId = undefined;
    for (const queued of scope.queue.splice(0)) queued.reject(error);
  }
  private enqueue(scope: Scope, input: CodexSubmitInput): Promise<CodexSubmitResult> {
    if (scope.queue.length >= this.maxQueue) return Promise.reject(new Error('Codex scope message queue is full'));
    return new Promise((resolve, reject) => scope.queue.push({ input, resolve, reject }));
  }
  private scope(id: string): Scope { let value = this.scopes.get(id); if (!value) { value = { state: 'idle', queue: [], serial: Promise.resolve() }; this.scopes.set(id, value); } return value; }
  private serialize<T>(scope: Scope, work: () => Promise<T>): Promise<T> { const result = scope.serial.then(work, work); scope.serial = result.then(() => undefined, () => undefined); return result; }
}
function record(value: unknown): Record<string, unknown> | undefined { return value && typeof value === 'object' ? value as Record<string, unknown> : undefined; }
function number(value: unknown): number | undefined { return typeof value === 'number' ? value : undefined; }
function toolItem(item: Record<string, unknown> | undefined): { id: string; name: string; input: unknown; output: string; isError: boolean } | undefined { if (!item || typeof item.id !== 'string' || typeof item.type !== 'string') return; if (!['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'fileChange', 'collabToolCall', 'collabAgentToolCall', 'imageView', 'sleep', 'contextCompaction', 'imageGeneration'].includes(item.type)) return; const name = typeof item.tool === 'string' ? item.tool : item.type; const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : JSON.stringify(item.result ?? item.error ?? item.status ?? 'completed'); return { id: item.id, name, input: item.arguments ?? item.command ?? item.query ?? item.changes ?? item.path ?? item.durationMs ?? {}, output, isError: Boolean(item.error) || item.status === 'failed' }; }
class EventQueue implements AsyncIterable<AgentEvent> {
  private values: AgentEvent[] = []; private waiters: Array<() => void> = []; private done = false;
  push(value: AgentEvent): void { if (this.done) return; this.values.push(value); this.wake(); }
  close(): void { this.done = true; this.wake(); }
  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    while (true) { if (this.values.length) { yield this.values.shift()!; continue; } if (this.done) return; await new Promise<void>((resolve) => this.waiters.push(resolve)); }
  }
  private wake(): void { for (const waiter of this.waiters.splice(0)) waiter(); }
}
function identity(input: CodexSubmitInput): SessionCatalogIdentity { return { scopeId: input.scopeId, agentId: 'codex', cwdRealpath: input.cwdRealpath, policyFingerprint: input.policyFingerprint }; }
function userInput(input: CodexSubmitInput): Array<Record<string, unknown>> {
  return [
    { type: 'text', text: input.message, text_elements: [] },
    ...(input.images ?? []).map((path) => ({ type: 'localImage', path })),
  ];
}
function runtimeConfig(input: CodexSubmitInput): Record<string, unknown> {
  return {
    shell_environment_policy: { inherit: 'all' }, skip_git_repo_check: true,
    ...(input.ignoreRules ? { ignore_rules: true } : {}),
    ...(input.ignoreUserConfig ? { ignore_user_config: true } : {}),
  };
}
function sameIdentity(a: SessionCatalogIdentity | undefined, b: CodexSubmitInput): boolean { return Boolean(a && a.scopeId === b.scopeId && a.cwdRealpath === b.cwdRealpath && a.policyFingerprint === b.policyFingerprint); }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
class QueueAfterSteerError extends Error { constructor(readonly input: CodexSubmitInput) { super('Codex turn is temporarily not steerable'); } }
function isTemporarilyUnsteerable(error: unknown): boolean { const message = error instanceof Error ? error.message : String(error); return /ActiveTurnNotSteerable|not[ -]?steerable|review.*turn|compact.*turn/i.test(message); }
