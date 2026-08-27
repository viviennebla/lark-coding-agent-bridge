import { UpdateManager } from '../../update/manager';
import { getServiceAdapter } from '../../daemon/service-adapter';
import { paths } from '../../config/paths';
import { loadRootConfig, readActiveProfile } from '../../config/profile-store';
import { readAndPrune } from '../../runtime/registry';
import { resolveAppPaths } from '../../config/app-paths';
import type { ServiceAdapter } from '../../daemon/service-adapter';
import { join } from 'node:path';
export async function installManagedServiceEntry(service: ServiceAdapter, launcher: string, oldEntry = process.env.LARK_CHANNEL_BRIDGE_ENTRY ?? process.argv[1]): Promise<void> {
  const inherited = process.env.LARK_CHANNEL_BRIDGE_ENTRY; process.env.LARK_CHANNEL_BRIDGE_ENTRY = launcher;
  try { await service.install(); } catch (error) { process.env.LARK_CHANNEL_BRIDGE_ENTRY = oldEntry; try { await service.install(); } catch { /* preserve original activation failure */ } throw error; } finally { if (inherited === undefined) delete process.env.LARK_CHANNEL_BRIDGE_ENTRY; else process.env.LARK_CHANNEL_BRIDGE_ENTRY = inherited; }
}
async function manager(profile?: string): Promise<UpdateManager> {
  const root = await loadRootConfig(paths.configFile); const selected = profile ?? await readActiveProfile(paths.rootDir) ?? root?.activeProfile ?? 'claude'; const service = getServiceAdapter(selected);
  const appPaths = resolveAppPaths({ rootDir: paths.rootDir, profile: selected });
  const codex = root?.profiles[selected]?.codex; const codexHome = codex?.codexHome ?? (codex?.inheritCodexHome === false ? join(appPaths.profileDir, 'codex-home') : process.env.CODEX_HOME);
  return new UpdateManager({
    healthContext: { profile: selected, rootConfigFile: paths.configFile, larkCliConfigDir: appPaths.larkCliConfigDir, profileExists: Boolean(root?.profiles[selected]), codexHome },
    serviceRunning: () => readAndPrune().length > 0 || Object.keys(root?.profiles ?? {}).some((name) => getServiceAdapter(name)?.isRunning() ?? false),
    activateService: async (launcher) => {
      if (!service?.fileExists()) return;
      await installManagedServiceEntry(service, launcher);
    },
  });
}
export async function runUpdateCheck(opts: { manifest: string; profile?: string }): Promise<void> { console.log(JSON.stringify(await (await manager(opts.profile)).check(opts.manifest), null, 2)); }
export async function runUpdateStatus(opts: { profile?: string } = {}): Promise<void> { console.log(JSON.stringify(await (await manager(opts.profile)).status(), null, 2)); }
export async function runUpdateApply(opts: { manifest: string; profile?: string }): Promise<void> { console.log(JSON.stringify(await (await manager(opts.profile)).apply(opts.manifest), null, 2)); }
export async function runUpdateRollback(opts: { profile?: string } = {}): Promise<void> { console.log(JSON.stringify(await (await manager(opts.profile)).rollback(), null, 2)); }
