import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { CodexAppServerSupervisor } from '../../../src/agent/codex/app-server/supervisor.js';

describe('CodexAppServerSupervisor', () => {
  it('continuously drains bounded stderr while initializing', async () => {
    const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: (_signal?: string) => { child.exitCode = 0; child.emit('exit', 0, null); return true; } });
    let input = ''; child.stdin.on('data', (chunk) => { input += chunk; const newline = input.indexOf('\n'); if (newline < 0) return; const request = JSON.parse(input.slice(0, newline)) as { id: number }; input = input.slice(newline + 1); child.stdout.write(`${JSON.stringify({ id: request.id, result: { userAgent: 'fake' } })}\n`); });
    const supervisor = new CodexAppServerSupervisor({ binary: 'codex', profileStateDir: '/state', spawn: (() => child) as never });
    const starting = supervisor.start(); child.stderr.write(`authorization=secret-value ${'x'.repeat(100_000)}\n`); await starting; await new Promise((resolve) => setImmediate(resolve));
    expect(child.stderr.readableLength).toBe(0); await supervisor.stop();
  });
});
