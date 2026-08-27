import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { CodexAppServerClient } from '../../../src/agent/codex/app-server/client.js';

describe('CodexAppServerClient', () => {
  it('correlates responses and forwards notifications', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const client = new CodexAppServerClient(input, output, 1000);
    let written = '';
    input.on('data', (chunk) => { written += chunk.toString(); });
    const notifications: string[] = [];
    client.on('notification', (event) => notifications.push(event.method));
    const result = client.request<{ ok: boolean }>('thread/start', { cwd: '/work' });
    await new Promise((resolve) => setImmediate(resolve));
    const request = JSON.parse(written.trim()) as { id: number };
    expect(JSON.parse(written.trim())).toEqual({ id: 1, method: 'thread/start', params: { cwd: '/work' } });
    output.write(`${JSON.stringify({ id: request.id, result: { ok: true } })}\n`);
    output.write(`${JSON.stringify({ method: 'turn/started', params: {} })}\n`);
    await expect(result).resolves.toEqual({ ok: true });
    expect(notifications).toEqual(['turn/started']);
    client.close();
  });

  it('declines generated approval ServerRequests and errors unsupported requests', async () => {
    const input = new PassThrough(); const output = new PassThrough();
    const client = new CodexAppServerClient(input, output, 1000);
    let written = ''; input.on('data', (chunk) => { written += chunk.toString(); });
    output.write(`${JSON.stringify({ method: 'item/commandExecution/requestApproval', id: 'approval-1', params: { threadId: 't', turnId: 'x', itemId: 'i' } })}\n`);
    output.write(`${JSON.stringify({ method: 'item/tool/requestUserInput', id: 9, params: {} })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    expect(written.trim().split('\n').map((line) => JSON.parse(line))).toEqual([
      { id: 'approval-1', result: { decision: 'decline' } },
      { id: 9, error: { code: -32601, message: 'unsupported server request: item/tool/requestUserInput' } },
    ]);
    client.close();
  });
});
