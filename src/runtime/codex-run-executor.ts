import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentRun } from '../agent/types';
import type { AgentAdapter } from '../agent/types';
import type { ActiveRuns } from '../bot/active-runs';
import type { ProcessPool } from '../bot/process-pool';
import { RunExecutor, type RunExecution, type RunExecutorDeps, type SubmitRunInput } from './run-executor';
import type { CodexRuntimeCoordinator } from './codex-runtime-coordinator';
import { RunRejected } from './errors';

/** Compatibility edge: presents long-lived App Server turns to existing renderers. */
export class CodexRunExecutor extends RunExecutor {
  private readonly identities = new Map<string, { cwdRealpath: string; policyFingerprint: string; model?: string }>();
  private readonly submissions = new Map<string, Promise<void>>();
  constructor(
    deps: RunExecutorDeps,
    private readonly runtime: CodexRuntimeCoordinator,
    private readonly active: ActiveRuns,
    private readonly runtimeAgent: AgentAdapter = deps.agent,
    private readonly codexPool: ProcessPool = deps.pool,
    private readonly codexNow: () => number = deps.now ?? Date.now,
  ) { super(deps); }

  override async submit(input: SubmitRunInput): Promise<RunExecution> {
    const previous = this.submissions.get(input.scopeId) ?? Promise.resolve();
    let release!: () => void; const current = new Promise<void>((resolve) => { release = resolve; }); const entry = previous.then(() => current); this.submissions.set(input.scopeId, entry);
    await previous;
    try { return await this.submitSerial(input); } finally { release(); if (this.submissions.get(input.scopeId) === entry) this.submissions.delete(input.scopeId); }
  }
  private async submitSerial(input: SubmitRunInput): Promise<RunExecution> {
    if (input.policy.expiresAt <= this.codexNow()) throw new RunRejected('policy-expired', 'run policy expired before Codex admission');
    if (this.active.newRunsPaused()) throw new RunRejected('reconnect-in-progress', this.active.newRunsPauseReason() ?? 'new runs are temporarily paused');
    const messageId = input.messageId ?? randomUUID();
    const bridgeAgent = this.agentWithPrompt();
    const appServerConfig = this.agentConfig();
    const runtimeInput = {
      scopeId: input.scopeId, agentId: 'codex' as const, cwdRealpath: input.policy.cwdRealpath, policyFingerprint: input.policy.policyFingerprint,
      message: bridgeAgent ? bridgeAgent.bridgePrompt(input.policy.prompt) : input.policy.prompt, messageId, images: input.images,
      ignoreRules: appServerConfig?.ignoreRules, ignoreUserConfig: appServerConfig?.ignoreUserConfig, model: input.model, sandbox: input.policy.sandbox,
    };
    const active = this.active.get(input.scopeId);
    const surface = input.observability?.source ?? 'unknown';
    const activeIdentity = this.identities.get(input.scopeId);
    if (active && !active.interrupted && activeIdentity?.cwdRealpath === input.policy.cwdRealpath && activeIdentity.policyFingerprint === input.policy.policyFingerprint && activeIdentity.model === input.model) {
      const shared = active.run.events as SharedEvents;
      const claim = shared.beginClaim(surface);
      let accepted; try { accepted = await this.runtime.submitMessage(runtimeInput); } catch (error) { shared.rollbackClaim(claim); throw error; }
      if (accepted.action !== 'steered') { shared.rollbackClaim(claim); throw new Error('Codex active scope did not accept steer'); }
      shared.commitClaim(claim);
      return { runId: active.run.runId, scopeId: input.scopeId, run: active.run, handle: active, subscribe: () => shared.subscribe(claim), stop: () => active.run.stop() };
    }
    if (active) { const exited = await active.run.waitForExit(300_000); if (!exited) throw new RunRejected('run-already-active', 'previous Codex run did not exit before identity handoff'); this.active.unregister(input.scopeId, active.run); }
    if (!active && this.runtime.state(input.scopeId).state === 'running') throw new RunRejected('run-already-active', 'Codex coordinator has an active turn without local ownership');
    const releaseScope = this.active.reserve(input.scopeId);
    if (!releaseScope) throw new RunRejected('run-already-active', 'another run is already active for this scope');
    const releasePool = input.nowait ? this.codexPool.tryAcquire() : await this.codexPool.acquire();
    if (!releasePool) { releaseScope(); throw new RunRejected('pool-full', 'process pool is full'); }
    if (input.policy.expiresAt <= this.codexNow()) { releasePool(); releaseScope(); throw new RunRejected('policy-expired', 'run policy expired while waiting for Codex admission'); }
    if (this.active.newRunsPaused()) { releasePool(); releaseScope(); throw new RunRejected('reconnect-in-progress', this.active.newRunsPauseReason() ?? 'new runs are temporarily paused'); }
    const runId = randomUUID();
    let result;
    try { result = await this.runtime.submitMessage(runtimeInput); } catch (error) { releasePool(); releaseScope(); throw error; }
    if (result.action === 'steered') { releasePool(); releaseScope(); throw new RunRejected('run-already-active', 'Codex steer was accepted without local physical ownership'); }
    if (!result.events) { releasePool(); releaseScope(); throw new Error('Codex runtime accepted message without an event stream'); }
    const shared = new SharedEvents(result.events);
    const run: AgentRun = {
      runId,
      events: shared,
      stop: async () => { await this.runtime.stop(input.scopeId); await shared.finished; },
      waitForExit: (timeoutMs) => shared.wait(timeoutMs),
    };
    let handle;
    try { handle = this.active.register(input.scopeId, run); } catch (error) { releasePool(); releaseScope(); throw error; }
    this.identities.set(input.scopeId, { cwdRealpath: input.policy.cwdRealpath, policyFingerprint: input.policy.policyFingerprint, model: input.model });
    shared.finished.then(() => { this.active.unregister(input.scopeId, run); if (this.active.get(input.scopeId)?.run !== run) this.identities.delete(input.scopeId); releasePool(); });
    return { runId, scopeId: input.scopeId, run, handle, subscribe: () => shared.subscribeSurface(surface), stop: run.stop };
  }
  private agentConfig(): { ignoreRules: boolean; ignoreUserConfig: boolean } | undefined {
    const candidate = this.runtimeAgent as AgentAdapter & { appServerRunConfig?: () => { ignoreRules: boolean; ignoreUserConfig: boolean } };
    return candidate.appServerRunConfig?.();
  }
  private agentWithPrompt(): { bridgePrompt(prompt: string): string } | undefined {
    const candidate = this.runtimeAgent;
    return candidate && typeof (candidate as { bridgePrompt?: unknown }).bridgePrompt === 'function'
      ? candidate as unknown as { bridgePrompt(prompt: string): string }
      : undefined;
  }
}

class SharedEvents implements AsyncIterable<AgentEvent> {
  private readonly buffer: AgentEvent[] = []; private waiters = new Set<() => void>(); private done = false; private failure?: unknown;
  private readonly generations = new Map<string, number>(); private readonly pendingClaims = new Map<string, symbol>();
  readonly finished: Promise<void>;
  constructor(source: AsyncIterable<AgentEvent>) {
    this.finished = (async () => { try { for await (const event of source) { this.buffer.push(event); this.wake(); } } catch (error) { this.failure = error; } finally { this.done = true; this.wake(); } })();
  }
  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return this.iterator(0, 'default', this.generation('default'));
  }
  subscribeSurface(surface: string): AsyncIterable<AgentEvent> { const generation = this.generation(surface); return { [Symbol.asyncIterator]: () => this.iterator(0, surface, generation) }; }
  beginClaim(surface: string): { index: number; surface: string; generation: number; token: symbol } { const token = Symbol(surface); this.pendingClaims.set(surface, token); this.wake(); return { index: this.buffer.length, surface, generation: this.generation(surface) + 1, token }; }
  commitClaim(claim: { surface: string; generation: number; token: symbol }): void { if (this.pendingClaims.get(claim.surface) !== claim.token) throw new Error('stale stream claim'); this.pendingClaims.delete(claim.surface); this.generations.set(claim.surface, claim.generation); this.wake(); }
  rollbackClaim(claim: { surface: string; token: symbol }): void { if (this.pendingClaims.get(claim.surface) === claim.token) this.pendingClaims.delete(claim.surface); this.wake(); }
  subscribe(claim: { index: number; surface: string; generation: number }): AsyncIterable<AgentEvent> {
    return { [Symbol.asyncIterator]: () => this.iterator(claim.index, claim.surface, claim.generation) };
  }
  private iterator(start: number, surface: string, generation: number): AsyncIterator<AgentEvent> {
    let index = start;
    return { next: async () => { while (generation === this.generation(surface) && (this.pendingClaims.has(surface) || (index >= this.buffer.length && !this.done))) await new Promise<void>((resolve) => { const wake = () => { this.waiters.delete(wake); resolve(); }; this.waiters.add(wake); }); if (generation !== this.generation(surface)) return { done: true, value: undefined }; if (index < this.buffer.length) return { done: false, value: this.buffer[index++]! }; if (this.failure) throw this.failure; return { done: true, value: undefined }; } };
  }
  private generation(surface: string): number { return this.generations.get(surface) ?? 0; }
  async wait(timeoutMs: number): Promise<boolean> { if (this.done) return true; return Promise.race([this.finished.then(() => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs))]); }
  private wake(): void { for (const waiter of [...this.waiters]) waiter(); }
}
