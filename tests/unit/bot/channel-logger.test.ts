import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as channelModule from '../../../src/bot/channel.js';

describe('Lark SDK logger noise filtering', () => {
  it('suppresses optional wiki-node permission failures that fall back to the original file token', () => {
    const shouldSuppress = (
      channelModule as {
        shouldSuppressSdkErrorLog?: (args: unknown[]) => boolean;
      }
    ).shouldSuppressSdkErrorLog;

    expect(
      shouldSuppress?.([
        [
          {
            message: 'Request failed with status code 400',
            config: {
              method: 'get',
              url: 'https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node',
            },
            response: {
              data: {
                code: 99991672,
                msg: 'Access denied. One of the following scopes is required: [wiki:node:read].',
              },
            },
          },
          {
            code: 99991672,
            msg: 'Access denied. One of the following scopes is required: [wiki:node:read].',
          },
        ],
      ]),
    ).toBe(true);
  });

  it('keeps unrelated permission failures visible', () => {
    const shouldSuppress = (
      channelModule as {
        shouldSuppressSdkErrorLog?: (args: unknown[]) => boolean;
      }
    ).shouldSuppressSdkErrorLog;

    expect(
      shouldSuppress?.([
        {
          message: 'Request failed with status code 400',
          config: {
            method: 'post',
            url: 'https://open.feishu.cn/open-apis/im/v1/messages',
          },
          response: {
            data: {
              code: 99991672,
              msg: 'Access denied.',
            },
          },
        },
      ]),
    ).toBe(false);
  });
});

describe('startChannel initialization cleanup', () => {
  it('atomically cleans post-connect resources before rethrowing initialization failures', async () => {
    const source = await readFile(resolve(process.cwd(), 'src/bot/channel.ts'), 'utf8');
    const connectAt = source.indexOf('await channel.connect();');
    const catchAt = source.indexOf('} catch (error) {', connectAt);
    const rethrowAt = source.indexOf('throw error;', catchAt);
    const cleanup = source.slice(catchAt, rethrowAt);

    expect(connectAt).toBeGreaterThan(-1);
    expect(catchAt).toBeGreaterThan(connectAt);
    expect(rethrowAt).toBeGreaterThan(catchAt);
    expect(cleanup).toContain('ownerRefresh?.stop()');
    expect(cleanup).toContain('knownChatsRefresh?.stop()');
    expect(cleanup).toContain('keepalive?.stop()');
    expect(cleanup).toContain('agentConsole?.close()');
    expect(cleanup).toContain('activeRuns.stopAll()');
    expect(cleanup).toContain('channel.disconnect()');
    expect(cleanup).toContain('Promise.allSettled');
  });
});
