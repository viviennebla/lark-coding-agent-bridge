import { afterEach, describe, expect, it } from 'vitest';
import type { ServiceAdapter } from '../../../src/daemon/service-adapter.js';
import { installManagedServiceEntry } from '../../../src/cli/commands/update.js';

describe('managed service entry transaction', () => {
  const inherited = process.env.LARK_CHANNEL_BRIDGE_ENTRY;
  afterEach(() => { if (inherited === undefined) delete process.env.LARK_CHANNEL_BRIDGE_ENTRY; else process.env.LARK_CHANNEL_BRIDGE_ENTRY = inherited; });
  it('restores the old entry definition after a partial managed install failure', async () => {
    const entries: Array<string | undefined> = []; let calls = 0;
    const service = { install: async () => { entries.push(process.env.LARK_CHANNEL_BRIDGE_ENTRY); if (calls++ === 0) throw new Error('partial install'); } } as unknown as ServiceAdapter;
    await expect(installManagedServiceEntry(service, 'runtime/launcher.mjs', 'old/cli.js')).rejects.toThrow('partial install');
    expect(entries).toEqual(['runtime/launcher.mjs', 'old/cli.js']); expect(process.env.LARK_CHANNEL_BRIDGE_ENTRY).toBe(inherited);
  });
});
