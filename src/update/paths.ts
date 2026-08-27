import { homedir } from 'node:os';
import { join } from 'node:path';
export interface UpdatePaths { root: string; releases: string; staging: string; current: string; previous: string; state: string; lock: string }
export function resolveUpdatePaths(root = join(process.env.LARK_CHANNEL_HOME ?? join(homedir(), '.lark-channel'), 'runtime')): UpdatePaths {
  return { root, releases: join(root, 'releases'), staging: join(root, 'staging'), current: join(root, 'current.json'), previous: join(root, 'previous.json'), state: join(root, 'update-state.json'), lock: join(root, 'update.lock') };
}
