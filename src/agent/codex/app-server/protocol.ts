export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc?: '2.0'; id: JsonRpcId; method: string; params?: unknown;
}
export interface JsonRpcNotification { jsonrpc?: '2.0'; method: string; params?: unknown }
export interface JsonRpcResponse { jsonrpc?: '2.0'; id: JsonRpcId; result?: unknown; error?: { code: number; message: string; data?: unknown } }
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export interface TurnCompletedParams {
  threadId: string;
  turn: { id: string; status: string };
}

export function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (item.jsonrpc === undefined || item.jsonrpc === '2.0') && (typeof item.id === 'number' || typeof item.id === 'string' || typeof item.method === 'string');
}

export function turnCompletedParams(value: unknown): TurnCompletedParams | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as { threadId?: unknown; turn?: { id?: unknown; status?: unknown } };
  if (typeof raw.threadId !== 'string' || typeof raw.turn?.id !== 'string' || typeof raw.turn.status !== 'string') return undefined;
  return { threadId: raw.threadId, turn: { id: raw.turn.id, status: raw.turn.status } };
}
