# Lark Channel Bridge 开发约定

## 仓库边界

- 实际 Git 仓库是 `bridge-source`；上级 `D:\workspace\lark` 不是本项目的 Git 根目录。
- 项目包名是 `lark-channel-bridge`，命令行入口是 `lark-channel-bridge`。
- `@larksuite/cli`（命令 `lark-cli`）是独立的飞书 API CLI，不要把它和 bridge CLI 混为一谈。

## 当前架构

- `src/bot/channel.ts` 负责飞书消息接入、队列、卡片/COT 和 Agent Console 事件分发。
- `src/cli/commands/start.ts` 负责 profile 解析、运行时锁、Codex App Server 生命周期和热重载。
- `src/runtime/codex-runtime-coordinator.ts` 负责 Codex thread/turn、steer、drain 和断线恢复。
- `src/agent/codex/app-server/` 负责 Codex App Server 子进程和 JSON-RPC 通信。
- `src/update/` 负责 bridge、Codex、lark-cli 的兼容 bundle 校验、切换和回滚。
- 当前主路径是 Codex App Server + Agent Console；上游 `src/ui` / `web` 文件暂未接入现有 CLI，不要默认启用或重写启动架构。

## 外部运行时

- Codex 必须通过 App Server 协议运行，不能只按全局 `codex` 命令版本判断兼容性。
- bridge、Codex 和 `lark-cli` 应作为同一兼容 bundle 验证和更新；不要单独替换其中一个生产版本。
- profile 配置、技能、会话和 lark-cli 配置使用 profile-specific `LARK_CHANNEL_HOME`，不得跨 profile 复用。
- 远程部署以 Linux 服务器为目标；不要把 Windows/WSL 路径、shell 或 GUI 假设写进核心逻辑。

## 常用验证

```bash
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run
node node_modules/tsup/dist/cli-default.js
```

- 修改 runtime、channel、service 或 updater 后，至少运行类型检查和对应的 unit/integration 测试。
- Windows 下部分 legacy Codex fixture 依赖 `/bin/sh`；沙箱下 home-root 策略测试可能因路径不可访问失败，这些要和真实回归分开判断。
- 构建 Web UI 需要上游的 Vite/React 依赖和生成 `src/ui/generated/index.html`；当前 branch 不把它作为默认构建前提。

## 修改与安全

- 保留已有用户配置、技能、会话、profile 和 updater 状态；不要使用破坏性的 `git reset --hard` 或批量删除来解决冲突。
- stop/restart/reload 必须考虑旧 turn 的 drain、runtime lock、EventQueue 所有权和 Codex thread writer 释放。
- 配置重载时先完成候选 runtime/channel 的启动和验证，再切换旧实例；失败时回滚到旧实例。
- 不要把没有本地所有权的 steered run 当成新的 run，也不要让多个 channel pump 消费同一个事件队列。

## 远程开发交接

- 服务器上从 fork 的目标分支开始开发，并单独设置 `LARK_CHANNEL_HOME`。
- 先确认 Node、Codex App Server、`lark-cli` 的实际路径和版本，再运行 bridge。
- 服务器上的版本升级应通过兼容 bundle 或明确的协议升级变更完成，并保留 rollback 路径。
- 提交前记录：分支、commit、类型检查、聚焦测试、全量测试失败及其环境原因。
