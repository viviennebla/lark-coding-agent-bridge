import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startAgentConsoleServer, type AgentConsoleServerHandle } from '../../../src/agent-console/server.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import type { AppConfig } from '../../../src/config/schema.js';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { ProcessPool } from '../../../src/bot/process-pool.js';
import { RunExecutor } from '../../../src/runtime/run-executor.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter, type FakeAgentEvents } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

interface MirrorSentMessage {
  chatId: string;
  content: { markdown?: string; text?: string };
  options?: { replyTo?: string; replyInThread?: true };
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('Agent Console server', () => {
  it('exposes public state with a token and gates skills/messages with that token', async () => {
    const h = await createHarness();

    const stateResponse = await fetch(`${h.console.baseUrl}/api/state`);
    expect(stateResponse.status).toBe(200);
    const state = await stateResponse.json() as { api: { token: string }; status: string };
    expect(state.api.token).toBe('test-token');
    expect(state.status).toBe('idle');

    const unauthSkills = await fetch(`${h.console.baseUrl}/api/skills`);
    expect(unauthSkills.status).toBe(403);

    const unauthMessage = await fetch(`${h.console.baseUrl}/api/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'interrupt' }),
    });
    expect(unauthMessage.status).toBe(403);
  });

  it('lists local skills with token auth and query filtering', async () => {
    const h = await createHarness();

    const response = await fetch(`${h.console.baseUrl}/api/skills?token=test-token&query=fix`);
    expect(response.status).toBe(200);
    const body = await response.json() as { skills: Array<{ name: string; description: string }> };
    expect(body.skills).toEqual([
      expect.objectContaining({
        name: 'fixit',
        description: 'Diagnose and repair a broken workflow.',
      }),
    ]);
  });

  it('handles /interrupt without spawning a run when the scope is idle', async () => {
    const h = await createHarness();

    const response = await postMessage(h.console, { text: '/interrupt' });
    expect(response.status).toBe(202);
    expect(h.agent.runs).toHaveLength(0);

    const state = await getState(h.console);
    expect(state.events.at(-1)).toMatchObject({
      type: 'system.notice',
      text: 'no active run for scope',
    });
  });

  it('submits a web prompt to the shared RunExecutor and records run events', async () => {
    const h = await createHarness({
      events: [
        { type: 'text', delta: 'pong' },
        { type: 'usage', inputTokens: 1, outputTokens: 1 },
        { type: 'done', terminationReason: 'normal' },
      ],
    });

    const response = await postMessage(h.console, { text: 'ping', skill: 'fixit' });
    expect(response.status).toBe(202);
    expect(h.agent.runOptions[0]).toMatchObject({
      prompt: 'Use the fixit skill for this task: ping',
      cwd: h.tmp.workspace,
    });

    const state = await waitForState(h.console, (state) =>
      state.events.some((event) => event.type === 'task.completed'),
    );
    expect(state.status).toBe('idle');
    expect(state.events.map((event) => event.type)).toContain('message.assistant.delta');
    expect(state.events.map((event) => event.type)).toContain('message.assistant.final');
    expect(state.events.at(-1)).toMatchObject({ type: 'task.completed', text: 'normal' });
  });

  it('mirrors web prompts and final assistant replies to the resolved Feishu chat', async () => {
    const h = await createHarness({
      events: [
        { type: 'text', delta: 'pong' },
        { type: 'done', terminationReason: 'normal' },
      ],
      mirror: true,
    });

    const response = await postMessage(h.console, { text: 'ping', chatId: 'oc_test' });
    expect(response.status).toBe(202);

    await waitForState(h.console, (state) =>
      state.events.some((event) => event.type === 'task.completed'),
    );

    expect(h.mirrorSent).toEqual([
      {
        chatId: 'oc_test',
        content: { markdown: '**Agent Console 输入**\n\nping' },
        options: undefined,
      },
      {
        chatId: 'oc_test',
        content: { markdown: 'pong' },
        options: { replyTo: 'om_console_1' },
      },
    ]);
  });

  it('persists console event history and supports cursor-based sync', async () => {
    const historyTmp = await createTmpProfile('agent-console-history-');
    cleanups.push(historyTmp.cleanup);
    const historyFile = join(historyTmp.root, 'agent-console-events.jsonl');
    const first = await createHarness({ historyFile });

    const response = await postMessage(first.console, { text: '/interrupt' });
    expect(response.status).toBe(202);

    const firstState = await getState(first.console);
    const lastEvent = firstState.events.at(-1);
    expect(lastEvent).toMatchObject({
      type: 'system.notice',
      text: 'no active run for scope',
    });
    expect(lastEvent?.id).toBeTruthy();

    const historyResponse = await fetch(`${first.console.baseUrl}/api/history?token=test-token&limit=1`);
    expect(historyResponse.status).toBe(200);
    const history = await historyResponse.json() as { events: Array<{ id: string; type: string }> };
    expect(history.events).toEqual([
      expect.objectContaining({
        id: lastEvent?.id,
        type: 'system.notice',
      }),
    ]);

    const second = await createHarness({ historyFile });
    const secondState = await getState(second.console);
    expect(secondState.events.at(-1)).toMatchObject({
      id: lastEvent?.id,
      type: 'system.notice',
      text: 'no active run for scope',
    });

    const afterResponse = await fetch(
      `${second.console.baseUrl}/api/history?token=test-token&after=${encodeURIComponent(lastEvent?.id ?? '')}`,
    );
    expect(afterResponse.status).toBe(200);
    const after = await afterResponse.json() as { events: Array<unknown> };
    expect(after.events).toEqual([]);
  });

  it('does not throw when the requested port is already occupied', async () => {
    const blocker = createServer((_, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('occupied');
    });
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const address = blocker.address();
    if (!address || typeof address === 'string') throw new Error('expected tcp address');
    cleanups.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())));

    const h = await createHarness({ port: address.port });
    const response = await fetch(`http://127.0.0.1:${address.port}/api/state`);

    expect(h.console.baseUrl).toBe(`http://127.0.0.1:${address.port}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('occupied');
  });
});

async function createHarness(options: {
  events?: FakeAgentEvents;
  port?: number;
  historyFile?: string;
  mirror?: boolean;
} = {}): Promise<{
  agent: FakeAgentAdapter;
  console: AgentConsoleServerHandle;
  mirrorSent: MirrorSentMessage[];
  tmp: TmpProfile;
}> {
  const tmp = await createTmpProfile('agent-console-');
  cleanups.push(tmp.cleanup);
  const skillRoot = join(tmp.root, 'skills');
  const staticDir = join(tmp.root, 'static');
  await Promise.all([
    mkdir(join(skillRoot, 'fixit'), { recursive: true }),
    mkdir(staticDir, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(skillRoot, 'fixit', 'SKILL.md'),
      '---\nname: fixit\ndescription: Diagnose and repair a broken workflow.\n---\n',
    ),
    writeFile(join(staticDir, 'index.html'), '<!doctype html><title>Agent Console</title>'),
    writeFile(join(staticDir, 'app.js'), ''),
    writeFile(join(staticDir, 'styles.css'), ''),
  ]);

  const app = { id: 'cli_test', secret: 'secret', tenant: 'feishu' as const };
  const cfg: AppConfig = {
    accounts: { app },
    preferences: { messageReply: 'card' },
  };
  const profile = createDefaultProfileConfig({
    agentKind: 'codex',
    accounts: { app },
    codex: { binaryPath: 'codex' },
  });
  const agent = new FakeAgentAdapter({
    id: 'codex',
    displayName: 'Codex CLI',
    events: options.events ?? [],
  });
  const activeRuns = new ActiveRuns();
  const pool = new ProcessPool(() => 10);
  const executor = new RunExecutor({
    agent,
    pool,
    activeRuns,
    createRunId: () => 'run-1',
  });
  const workspaces = new WorkspaceStore(join(tmp.root, 'workspaces.json'));
  await workspaces.load();
  workspaces.setCwd('web:default', tmp.workspace);
  await workspaces.flush();
  const controls = {
    profile: 'codex',
    profileConfig: profile,
    ownerRefreshState: 'unknown' as const,
    knownChats: [],
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: join(tmp.root, 'config.json'),
    cfg,
    processId: 'proc-1',
  };
  const mirrorSent: MirrorSentMessage[] = [];
  let nextMirrorMessage = 1;
  const mirrorChannel = options.mirror
    ? {
        async send(
          chatId: string,
          content: { markdown?: string; text?: string },
          sendOptions?: { replyTo?: string; replyInThread?: true },
        ): Promise<{ messageId: string }> {
          mirrorSent.push({ chatId, content, options: sendOptions });
          return { messageId: `om_console_${nextMirrorMessage++}` };
        },
      }
    : undefined;

  const console = await startAgentConsoleServer({
    agent,
    activeRuns,
    controls,
    executor,
    pool,
    workspaces,
    staticDir,
    skillRoots: [skillRoot],
    token: 'test-token',
    port: options.port ?? 0,
    historyFile: options.historyFile ?? join(tmp.root, 'agent-console-events.jsonl'),
    mirrorChannel,
  });
  cleanups.push(console.close);
  return { agent, console, mirrorSent, tmp };
}

async function postMessage(console: AgentConsoleServerHandle, body: object): Promise<Response> {
  return fetch(`${console.baseUrl}/api/message`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-agent-console-token': console.token,
    },
    body: JSON.stringify(body),
  });
}

async function getState(console: AgentConsoleServerHandle): Promise<{
  status: string;
  events: Array<{ id?: string; type: string; text?: string }>;
}> {
  const response = await fetch(`${console.baseUrl}/api/state`);
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    status: string;
    events: Array<{ id?: string; type: string; text?: string }>;
  }>;
}

async function waitForState(
  console: AgentConsoleServerHandle,
  predicate: (state: { events: Array<{ id?: string; type: string; text?: string }> }) => boolean,
): Promise<{ status: string; events: Array<{ id?: string; type: string; text?: string }> }> {
  for (let i = 0; i < 20; i++) {
    const state = await getState(console);
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return getState(console);
}
