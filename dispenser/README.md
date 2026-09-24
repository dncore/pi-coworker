# 授权分发 CLI（auth-dispenser）

把**本应用已配置的网关**（公司 magene 网关，或用户给定的自定义 OpenAI 兼容网关）分发到本机其它
AI agent，让员工不用手工改配置就能在 Codex / Claude Code / Reasonix / dsh / Grok Build / omp / OpenCode
里用上同一个网关；并支持**还原**与**修复**。

配套技能：`skills/auth-dispenser/SKILL.md`（聊天驱动协议）。CLI 是「手」，技能是「协议」。

## 移植来源与边界

- `lib/**` 原样搬运自 **pi-agent-dispenser@0.2.7**（`lib/`，含其单测）。上游是 pi 扩展
  （`index.ts` 3321 行，pi TUI 交互式菜单）；本目录**只取纯逻辑层**：
  各 agent 配置的文本级「块内合并」patch、备份/还原、状态解析、模型元数据解析。
- 上游的交互流程（`ctx.ui.select/confirm`）在应用里由 **app 内置 agent + 技能协议** 取代；
  `cli.ts` 是新的非交互入口（JSON in / JSON out），不改上游 lib 语义。
- 上游依赖 `~/.pi/agent` 的路径约定，这里通过 `PI_CODING_AGENT_DIR` 兼容 app 隔离目录
  （`~/.coworker/pi-agent`，见 `piDirs()`）。
- **模型元数据来源**：`lib/known-models.ts` 的 KNOWN_MODELS 表由 `scripts/sync-model-meta.mjs`
  在**构建期**从 canonical gist（dncore/b8931f4c…/models.json）生成——与 `extensions/core/magene.ts`
  同源同一次生成（CI `check:models` 做漂移门禁）。上游的「配置服务器下发」机制（`lib/remote-config.ts`）
  在本仓**已废弃并删除**；运行时元数据来源只有三级：用户覆盖文件 > 内置表（gist 生成）> 按 id 推断。
- **同步上游**：`cp <pi-agent-dispenser>/lib/*.ts dispenser/lib/`，然后跑
  `node --test dispenser/lib/*.test.ts` 与 `node scripts/dispenser-test.ts` 验证。

## 命令

```
node cli.ts agents                                    探测本机 agent（只读）
node cli.ts doctor                                    凭证 + 网关连通性 + 已装 agent（只读）
node cli.ts status  --agent <id>                      现状与问题（只读）
node cli.ts plan    --agent <id> [--main-model M]     变更预览（只读）
node cli.ts apply   --agent <id> … --yes              落盘（写前备份）
node cli.ts models  --agent <id> --yes                仅刷新模型列表
node cli.ts backups --agent <id>                      列出备份（只读）
node cli.ts restore --agent <id> [--backup F] --yes   还原（还原前再备份）
node cli.ts repair  --agent <id> --yes                诊断并修复（幂等重写托管块）
```

公共参数：`--gateway magene|custom`、`--base-url U`、`--api-key-stdin`、`--provider-name N`、
`--label L`、`--main-model M`、`--<role>-model M`（claude 的 haiku/sonnet/opus/fable/subagent）。

## 门禁（gate）设计

| 门禁 | 实现 | 位置 |
|---|---|---|
| 写操作必须确认 | 缺 `--yes` → `code=confirm_required`（退出码 2）+ 完整 `plan`；只读命令不需要 | `cmdPlanApplyModels` 等 |
| 写前备份 | 托管文件走各自的 `writeXxx`（`.bak-<ts>`）或通用 `writeWithBackup`；还原前再备份 `.bak-pre-restore-*` | `commitWrites` |
| 密钥不外泄 | 只从 env / stdin 读取；输出统一掩码 + 全局兜底替换（`scrub`）；写盘后不回显 | `mask` / `scrub` / `SECRET` |
| 密钥文件不备份 | `.env` / `.credentials.yaml` / `auth.json` 固定 0600 且不产生副本 | `writeSecretFile` / lib 写入器 |
| 审计 | 每次写操作追加 `~/.coworker/audit/dispenser.jsonl`（无密钥） | `audit` |
| 幂等 | patch 只改托管键/块，二次 apply 无变更也不写盘、不产生备份 | lib patch 语义 |
| 失败可退 | 任何失败都可 `restore`；非法 JSON 时明确 `needs_restore` 而非硬改 | `cmdRepair` |

## 运行时布局

- 开发：`node dispenser/cli.ts`（node ≥22.18 直接跑 TS；app 内置 node 24）。
- 打包：`gui/scripts/prepare-dispenser.mjs` 复制到 `Resources/dispenser/`；
  后端启动时写稳定入口 `~/.coworker/bin/dispenser.mjs` 并导出 `COWORKER_DISPENSER_CLI`。
- 独立更新：组件覆盖层 `~/.coworker/components/dispenser/current`（公司组件源 `dispenser` 组件），
  优先级 覆盖层 > 随包。

## 测试

- `node --test dispenser/lib/*.test.ts`：上游单测（78 断言，patch/备份/凭据）。
- `node scripts/dispenser-test.ts`：本仓端到端（假网关 + 隔离 HOME + 7 个 agent）：
  门禁（confirm_required）、写前备份、幂等、还原、修复、非法 JSON、密钥不外泄、审计、自定义网关 stdin。
