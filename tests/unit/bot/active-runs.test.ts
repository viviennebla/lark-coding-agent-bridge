import { describe, expect, it } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs.js';

describe('ActiveRuns interrupt occupancy', () => {
  it('keeps an interrupted scope occupied until asynchronous stop is terminal', async () => {
    const active = new ActiveRuns();
    let finish!: () => void;
    const stopped = new Promise<void>((resolve) => { finish = resolve; });
    const run = { runId: 'run-1', events: { async *[Symbol.asyncIterator]() {} }, stop: () => stopped, waitForExit: async () => true };
    active.register('scope', run);
    expect(active.interrupt('scope')).toBe(true);
    expect(active.get('scope')?.interrupted).toBe(true);
    expect(active.reserve('scope')).toBeUndefined();
    finish(); await stopped; await new Promise((resolve) => setImmediate(resolve));
    expect(active.get('scope')).toBeUndefined();
  });
});
