import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeCapability, codexCapability } from '../agent/capability';
import type { AgentAdapter, AgentEvent } from '../agent/types';
import type { ActiveRuns } from '../bot/active-runs';
import type { ProcessPool } from '../bot/process-pool';
import type { Controls } from '../commands';
import { resolveAppPaths } from '../config/app-paths';
import { getAgentStopGraceMs } from '../config/schema';
import { log } from '../core/logger';
import { evaluateRunPolicy } from '../policy/run-policy';
import type { RunExecutor } from '../runtime/run-executor';
import type { WorkspaceStore } from '../workspace/store';

export interface AgentConsoleServerDeps {
  agent: AgentAdapter;
  activeRuns: ActiveRuns;
  controls: Controls;
  executor: RunExecutor;
  pool: ProcessPool;
  workspaces: WorkspaceStore;
  host?: string;
  port?: number;
  staticDir?: string;
  token?: string;
  now?: () => number;
  skillRoots?: string[];
  historyFile?: string;
}

export interface AgentConsoleServerHandle {
  readonly baseUrl: string;
  readonly token: string;
  close(): Promise<void>;
}

interface ConsoleEvent {
  id: string;
  timestamp: string;
  type: string;
  text?: string;
  scope?: string;
  runId?: string;
  source?: string;
  agent?: string;
  profile?: string;
  cwd?: string;
  prompt?: string;
  event?: unknown;
}

interface SkillSummary {
  name: string;
  id: string;
  source: string;
  description: string;
  path?: string;
}

const DEFAULT_SCOPE = 'web:default';
const MAX_EVENTS = 240;
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

export async function startAgentConsoleServer(
  deps: AgentConsoleServerDeps,
): Promise<AgentConsoleServerHandle> {
  const requestedHost = deps.host ?? process.env.LARK_CHANNEL_LOCAL_API_HOST ?? '127.0.0.1';
  const host = isLoopbackHost(requestedHost) ? requestedHost : '127.0.0.1';
  const port = deps.port ?? Number(process.env.LARK_CHANNEL_LOCAL_API_PORT ?? 1313);
  let actualPort = port;
  const staticDir =
    deps.staticDir ??
    process.env.LARK_CHANNEL_CONSOLE_STATIC_DIR ??
    fileURLToPath(new URL('../assets/agent-console', import.meta.url));
  const historyFile = resolveHistoryFile(deps);
  const token = deps.token ?? process.env.LARK_CHANNEL_LOCAL_API_TOKEN ?? randomUUID();
  const now = deps.now ?? Date.now;
  const events: ConsoleEvent[] = await loadHistory(historyFile, MAX_EVENTS);
  const clients = new Set<ServerResponse>();
  let nextEventSeq = 0;
  await mkdir(dirname(historyFile), { recursive: true }).catch((err) =>
    log.warn('agent-console', 'history-dir-create-failed', {
      path: historyFile,
      err: err instanceof Error ? err.message : String(err),
    }),
  );

  const publish = (event: Omit<ConsoleEvent, 'id' | 'timestamp'>): ConsoleEvent => {
    const full: ConsoleEvent = {
      id: `${now()}-${++nextEventSeq}`,
      timestamp: new Date(now()).toISOString(),
      ...event,
    };
    events.push(full);
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
    appendHistory(historyFile, full);
    const frame = sseFrame(full);
    for (const client of clients) client.write(frame);
    return full;
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${host}:${actualPort}`);
      if (!isRequestAllowed(req, url, actualPort, token)) {
        json(res, 403, { error: 'forbidden' }, actualPort);
        return;
      }

      if (req.method === 'OPTIONS') {
        writeCors(res, actualPort);
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/state') {
        json(res, 200, buildState(deps, events, host, actualPort, token, historyFile), actualPort);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/events') {
        writeSse(res, actualPort);
        clients.add(res);
        for (const event of eventsSince(events, eventCursor(req, url))) res.write(sseFrame(event));
        req.on('close', () => clients.delete(res));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/history') {
        const limit = clamp(Number(url.searchParams.get('limit') ?? MAX_EVENTS), 1, MAX_EVENTS);
        json(res, 200, {
          events: eventsSince(events, eventCursor(req, url)).slice(-limit),
          maxEvents: MAX_EVENTS,
        }, actualPort);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/skills') {
        const query = url.searchParams.get('query') ?? '';
        const skills = await listSkills({
          query,
          roots: deps.skillRoots,
        });
        json(res, 200, { skills }, actualPort);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/message') {
        const body = await readJson(req);
        const result = await submitMessage({
          body,
          deps,
          publish,
          now,
        });
        json(res, result.status, result.body, actualPort);
        return;
      }

      if (req.method === 'GET') {
        await serveStatic(res, staticDir, url.pathname, actualPort);
        return;
      }

      json(res, 404, { error: 'not_found' }, actualPort);
    } catch (err) {
      log.fail('agent-console', err);
      json(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      }, actualPort);
    }
  });

  const listenResult = await new Promise<{ ok: true } | { ok: false; err: unknown }>((resolve) => {
    const onError = (err: unknown): void => resolve({ ok: false, err });
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      const address = server.address();
      if (address && typeof address === 'object') actualPort = address.port;
      resolve({ ok: true });
    });
  });

  if (!listenResult.ok) {
    const message = listenResult.err instanceof Error ? listenResult.err.message : String(listenResult.err);
    log.fail('agent-console', listenResult.err, { step: 'listen', host, port });
    publish({
      type: 'system.notice',
      text: `Agent Console failed to listen on http://${host}:${port}: ${message}`,
    });
    return {
      baseUrl: `http://${host}:${actualPort}`,
      token,
      close: () => Promise.resolve(),
    };
  }

  log.info('agent-console', 'listening', { host, port: actualPort, staticDir });
  console.log(`[agent-console] http://${host}:${actualPort}`);

  return {
    baseUrl: `http://${host}:${actualPort}`,
    token,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const client of clients) client.end();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function submitMessage(input: {
  body: unknown;
  deps: AgentConsoleServerDeps;
  publish: (event: Omit<ConsoleEvent, 'id' | 'timestamp'>) => ConsoleEvent;
  now: () => number;
}): Promise<{ status: number; body: object }> {
  const body = isObject(input.body) ? input.body : {};
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const explicitCommand =
    typeof body.command === 'string' ? body.command.trim().toLowerCase() : '';
  const scopeId =
    typeof body.scopeId === 'string' && body.scopeId.trim()
      ? body.scopeId.trim()
      : DEFAULT_SCOPE;
  const command = explicitCommand || text.match(/^\/([a-zA-Z0-9_-]+)\b/)?.[1]?.toLowerCase();

  if (command && /^(stop|interrupt|cancel)$/.test(command)) {
    const interrupted = input.deps.activeRuns.interrupt(scopeId);
    input.publish({
      type: interrupted ? 'task.interrupted' : 'system.notice',
      scope: scopeId,
      text: interrupted ? 'interrupted by web command' : 'no active run for scope',
    });
    return { status: 202, body: { ok: true, interrupted, scope: scopeId } };
  }

  if (!text) return { status: 400, body: { ok: false, error: 'empty_text' } };

  const workspace = input.deps.workspaces.cwdFor(scopeId) ?? process.cwd();
  const cwdRealpath = await realpath(workspace).catch(() => workspace);
  const profile = input.deps.controls.profileConfig;
  const capability =
    input.deps.agent.id === 'codex' ? codexCapability(profile) : claudeCapability(profile);
  const policy = evaluateRunPolicy({
    scope: { source: 'im', chatId: scopeId, actorId: 'web-console' },
    attachments: [],
    prompt:
      typeof body.skill === 'string' && body.skill.trim() && !text.startsWith('/')
        ? `Use the ${body.skill.trim()} skill for this task: ${text}`
        : text,
    requestedCwd: workspace,
    cwdRealpath,
    access: { ok: true, reason: 'owner' },
    capability,
    profileConfig: profile,
    now: input.now(),
    codexHome: profile.codex?.codexHome,
    inheritCodexHome: profile.codex?.inheritCodexHome === true,
  });
  if (!policy.ok) {
    return { status: 403, body: { ok: false, error: policy.rejectReason.code } };
  }

  const execution = await input.deps.executor.submit({
    scopeId,
    policy,
    stopGraceMs: getAgentStopGraceMs(input.deps.controls.cfg),
    observability: {
      profile: input.deps.controls.profile,
      agent: input.deps.agent.id,
      source: 'web',
      stage: 'agent-console',
    },
  });

  input.publish({
    type: 'task.started',
    runId: execution.runId,
    scope: scopeId,
    source: 'web',
    agent: input.deps.agent.id,
    profile: input.deps.controls.profile,
    cwd: cwdRealpath,
    prompt: text,
    text,
  });
  input.publish({
    type: 'message.user',
    runId: execution.runId,
    scope: scopeId,
    source: 'web',
    prompt: text,
    text,
  });
  void pumpRunEvents(execution.subscribe(), {
    runId: execution.runId,
    scope: scopeId,
    agent: input.deps.agent.id,
    profile: input.deps.controls.profile,
    publish: input.publish,
  });

  return { status: 202, body: { ok: true, runId: execution.runId, scope: scopeId } };
}

async function pumpRunEvents(
  stream: AsyncIterable<AgentEvent>,
  opts: {
    runId: string;
    scope: string;
    agent: string;
    profile: string;
    publish: (event: Omit<ConsoleEvent, 'id' | 'timestamp'>) => ConsoleEvent;
  },
): Promise<void> {
  try {
    for await (const event of stream) {
      opts.publish({
        ...mapAgentEvent(event),
        runId: opts.runId,
        scope: opts.scope,
        source: 'web',
        agent: opts.agent,
        profile: opts.profile,
        event,
      });
      if (event.type === 'done' || event.type === 'error') return;
    }
  } catch (err) {
    opts.publish({
      type: 'task.failed',
      runId: opts.runId,
      scope: opts.scope,
      source: 'web',
      agent: opts.agent,
      profile: opts.profile,
      text: err instanceof Error ? err.message : String(err),
    });
  }
}

function mapAgentEvent(event: AgentEvent): { type: string; text: string } {
  switch (event.type) {
    case 'system':
      return { type: 'system.notice', text: 'system.notice' };
    case 'text':
      return { type: 'message.assistant.delta', text: event.delta };
    case 'thinking':
      return { type: 'message.assistant.delta', text: event.delta };
    case 'tool_use':
      return { type: 'tool.started', text: event.name };
    case 'tool_result':
      return { type: event.isError ? 'tool.failed' : 'tool.completed', text: event.output };
    case 'usage':
      return { type: 'task.usage', text: 'task.usage' };
    case 'done':
      return {
        type: event.terminationReason === 'interrupted' ? 'task.interrupted' : 'task.completed',
        text: event.terminationReason,
      };
    case 'error':
      return {
        type: event.terminationReason === 'interrupted' ? 'task.interrupted' : 'task.failed',
        text: event.message,
      };
  }
}

function buildState(
  deps: AgentConsoleServerDeps,
  events: ConsoleEvent[],
  host: string,
  port: number,
  token: string,
  historyFile: string,
): object {
  return {
    status: deps.activeRuns.snapshot().length > 0 ? 'running' : 'idle',
    workspace: process.cwd(),
    profile: deps.controls.profile,
    bridgeProfile: deps.controls.profile,
    agent: deps.agent.id,
    agentDisplayName: deps.agent.displayName,
    processId: deps.controls.processId,
    api: { host, port, baseUrl: `http://${host}:${port}`, token },
    task: { status: deps.activeRuns.snapshot().length > 0 ? 'running' : 'idle' },
    session: { scope: null, workspace: process.cwd() },
    pool: deps.pool.snapshot(),
    settings: {
      profile: deps.controls.profile,
      messageReply: deps.controls.cfg.preferences?.messageReply,
      appId: deps.controls.cfg.accounts.app.id,
    },
    history: {
      file: historyFile,
      maxEvents: MAX_EVENTS,
      eventCount: events.length,
      lastEventId: events.at(-1)?.id ?? null,
    },
    events,
  };
}

async function listSkills(input: {
  query: string;
  roots?: string[];
}): Promise<SkillSummary[]> {
  const roots = input.roots ?? defaultSkillRoots();
  const skills: SkillSummary[] = [];
  for (const root of roots) {
    await collectSkills(root, skills).catch((err) =>
      log.warn('agent-console', 'skill-scan-failed', {
        root,
        err: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  const query = input.query.trim().toLowerCase();
  if (!query) return skills;
  return skills.filter((skill) =>
    [skill.name, skill.description, skill.source].some((value) =>
      value.toLowerCase().includes(query),
    ),
  );
}

async function collectSkills(root: string, out: SkillSummary[], source = root): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  const skillFile = entries.find((entry) => entry.isFile() && entry.name === 'SKILL.md');
  if (skillFile) {
    const path = join(root, skillFile.name);
    const text = await readFile(path, 'utf8');
    const parsed = parseSkill(text);
    out.push({
      id: parsed.name,
      name: parsed.name,
      source,
      description: parsed.description,
      path,
    });
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await collectSkills(join(root, entry.name), out, source);
  }
}

function parseSkill(text: string): { name: string; description: string } {
  const frontMatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const block = frontMatter?.[1] ?? '';
  const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? 'unknown';
  const description = block.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '';
  return { name, description };
}

function defaultSkillRoots(): string[] {
  const codexHome = process.env.CODEX_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.codex');
  return [join(codexHome, 'skills'), join(codexHome, 'plugins', 'cache')];
}

function isRequestAllowed(
  req: IncomingMessage,
  url: URL,
  port: number,
  token: string,
): boolean {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false;
  const origin = req.headers.origin;
  if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
    return false;
  }
  if (
    req.method === 'GET' &&
    ['/', '/index.html', '/app.js', '/styles.css', '/api/state'].includes(url.pathname)
  ) {
    return true;
  }
  if (req.method === 'OPTIONS') return true;
  if (
    req.method === 'GET' &&
    (url.pathname === '/api/skills' || url.pathname === '/api/events' || url.pathname === '/api/history')
  ) {
    return req.headers['x-agent-console-token'] === token || url.searchParams.get('token') === token;
  }
  if (req.method === 'POST') {
    const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
    if (!contentType.startsWith('application/json')) return false;
    return req.headers['x-agent-console-token'] === token || url.searchParams.get('token') === token;
  }
  return false;
}

async function serveStatic(
  res: ServerResponse,
  staticDir: string,
  pathname: string,
  port: number,
): Promise<void> {
  const file = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = join(staticDir, file);
  const root = await realpath(staticDir);
  const resolved = await realpath(target).catch(() => '');
  if (!resolved.startsWith(root)) {
    json(res, 404, { error: 'not_found' }, port);
    return;
  }
  const info = await stat(resolved).catch(() => undefined);
  if (!info?.isFile()) {
    json(res, 404, { error: 'not_found' }, port);
    return;
  }
  const bytes = await readFile(resolved);
  writeCors(res, port);
  res.writeHead(200, { 'content-type': contentTypeFor(resolved) });
  res.end(bytes);
}

function contentTypeFor(path: string): string {
  switch (extname(path)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function json(res: ServerResponse, status: number, body: object, port: number): void {
  writeCors(res, port);
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function writeCors(res: ServerResponse, port: number): void {
  res.setHeader('access-control-allow-origin', `http://127.0.0.1:${port}`);
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type,x-agent-console-token');
}

function writeSse(res: ServerResponse, port: number): void {
  writeCors(res, port);
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  res.write('\n');
}

function sseFrame(event: ConsoleEvent): string {
  return `event: ${event.type}\nid: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
}

function resolveHistoryFile(deps: AgentConsoleServerDeps): string {
  return (
    deps.historyFile ??
    process.env.LARK_CHANNEL_CONSOLE_HISTORY_FILE ??
    join(resolveAppPaths({ profile: deps.controls.profile }).profileDir, 'agent-console-events.jsonl')
  );
}

async function loadHistory(path: string, limit: number): Promise<ConsoleEvent[]> {
  try {
    const text = await readFile(path, 'utf8');
    const events = text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ConsoleEvent)
      .filter(isConsoleEvent);
    return events.slice(-limit);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      log.warn('agent-console', 'history-load-failed', {
        path,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    return [];
  }
}

function appendHistory(path: string, event: ConsoleEvent): void {
  try {
    appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf8');
  } catch (err) {
    log.warn('agent-console', 'history-append-failed', {
      path,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function eventsSince(events: ConsoleEvent[], after: string | undefined): ConsoleEvent[] {
  if (!after) return events;
  const index = events.findIndex((event) => event.id === after);
  return index >= 0 ? events.slice(index + 1) : events;
}

function eventCursor(req: IncomingMessage, url: URL): string | undefined {
  const header = req.headers['last-event-id'];
  return url.searchParams.get('after') ?? (Array.isArray(header) ? header[0] : header) ?? undefined;
}

function isConsoleEvent(value: unknown): value is ConsoleEvent {
  if (!isObject(value)) return false;
  return typeof value.id === 'string' && typeof value.timestamp === 'string' && typeof value.type === 'string';
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return max;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function isLoopbackAddress(address: string | undefined): boolean {
  return (
    address === undefined ||
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1'
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
