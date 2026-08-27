import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { isJsonRpcMessage, type JsonRpcMessage, type JsonRpcNotification, type JsonRpcResponse } from './protocol';

export class CodexAppServerClient extends EventEmitter {
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly input: Writable, output: Readable, private readonly requestTimeoutMs = 30_000) {
    super();
    const lines = createInterface({ input: output, crlfDelay: Infinity });
    lines.on('line', (line) => this.receive(line));
    lines.on('close', () => this.close(new Error('Codex App Server output closed')));
    input.on('error', (error) => this.close(error));
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Codex App Server client is closed'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.write({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) throw new Error('Codex App Server client is closed');
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  close(reason = new Error('Codex App Server client closed')): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer); pending.reject(reason);
    }
    this.pending.clear();
    this.emit('close', reason);
  }

  private receive(line: string): void {
    let message: unknown;
    try { message = JSON.parse(line); } catch { this.emit('protocolError', new Error('invalid JSON from Codex App Server')); return; }
    if (!isJsonRpcMessage(message)) { this.emit('protocolError', new Error('invalid JSON-RPC message')); return; }
    if ('id' in message && typeof message.id === 'number' && !('method' in message)) {
      const response = message as JsonRpcResponse;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (response.error) pending.reject(new Error(`Codex App Server ${response.error.code}: ${response.error.message}`));
      else pending.resolve(response.result);
      return;
    }
    if ('id' in message && 'method' in message && (typeof message.id === 'number' || typeof message.id === 'string') && typeof message.method === 'string') {
      this.handleServerRequest(message.id, message.method);
      return;
    }
    if ('method' in message) this.emit('notification', message as JsonRpcNotification);
  }

  private handleServerRequest(id: string | number, method: string): void {
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval' || method === 'execCommandApproval') {
      this.write({ id, result: { decision: 'decline' } });
      this.emit('serverRequestDenied', { id, method });
      return;
    }
    this.write({ id, error: { code: -32601, message: `unsupported server request: ${method}` } });
    this.emit('serverRequestDenied', { id, method });
  }

  private write(message: JsonRpcMessage): void { this.input.write(`${JSON.stringify(message)}\n`, 'utf8'); }
}
