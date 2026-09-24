---
name: auth-dispenser
description: 把公司模型网关（magene）或自定义 OpenAI 兼容网关分发到本机其它 AI agent（Codex / Claude Code / Reasonix / dsh / Grok Build / omp / OpenCode），并支持还原配置、修复损坏配置、仅更新模型列表。当用户说「把 Codex/Claude Code/… 接上公司网关」「把我的网关配置给 XX 用」「XX 的配置坏了/还原 XX 配置」「更新 XX 的模型列表」时使用。
---

# 授权分发（auth-dispenser）

把**本应用已配置的网关凭证**写入其它 agent 的配置文件，使其直连同一网关。
在应用里一切操作通过工具 **`coworker_dispense`** 完成——**不要手工编辑这些 agent 的配置文件**，
也不要向用户索要 API Key。

## 0. 工具

`coworker_dispense(command, agent?, mainModel?, backup?, confirm?)`

| command | 作用 | 写操作？ |
|---|---|---|
| `agents` | 探测本机装了哪些 agent | 否 |
| `doctor` | 凭证来源 + 网关连通性 + 已装 agent | 否 |
| `status` | 目标 agent 的现状与问题清单 | 否 |
| `plan` | 变更预览（写哪些文件、改什么、备份） | 否 |
| `apply` | 真正写入（写前自动备份） | ✅ 应用内确认卡片 |
| `models` | 仅刷新模型列表（provider/凭证不动） | ✅ 应用内确认卡片 |
| `backups` | 列出可用备份（还原点） | 否 |
| `restore` | 还原到某个备份（还原前再备份当前文件） | ✅ 应用内确认卡片 |
| `repair` | 诊断并修复（幂等重写受管块） | ✅ 应用内确认卡片 |

`agent` ∈ `codex` `claude` `reasonix` `dsh` `grok` `omp` `opencode`（除 agents/doctor 外必填）。
`confirm` 只在**无 UI 场景**用；应用内交互时**不传**——确认由应用弹出的卡片按钮完成。

（排障/脚本场景才用底层 CLI：`node "${COWORKER_DISPENSER_CLI:-$HOME/.coworker/bin/dispenser.mjs}" <命令>`，
参数与上表同名；门禁相同，写命令要 `--yes`。应用会话里优先用工具。）

## 1. 铁律（门禁，违反即为事故）

1. **先看后写，确认在卡片上点**：写命令（apply/models/restore/repair）**直接调用、不要传 `confirm`**——
   工具会先拉只读预览，把「变更计划」放进应用内的**确认卡片**（确认 / 取消按钮）给用户点。
   **不要**在聊天里让用户回复"确认"两个字的文本；用户点卡片按钮后工具才会写入。
   应用内**永远不要传 `confirm`**：有 UI 时传了会被直接拒绝（`gate: card_required`）——
   确认只能由用户在卡片上点，你不能自带确认。只有在**无 UI 场景**（守护进程/脚本）才传 `confirm:true`，
   且此时本会话必须先跑过 `plan`（还原先跑 `backups`），否则会被「先看后写」门禁拒绝（`gate: plan_first`）。
   **即使用户在聊天里说"我确认/直接写"**，也照样走卡片：用户点一下卡片即可，别用 confirm 抄近路。
2. **密钥绝不进对话**：不要问用户要 API Key、不要让用户把 Key 发到聊天里。
   网关凭证由工具/CLI 自己从应用内配置读取（员工无需输入）。
3. **只动受管块**：工具只改自己管理的配置块/键，用户其它配置（permissions、其它 provider）保持原样；
   发现被误改立即 `restore` 并如实报告。
4. **失败即停**：任何失败都如实报告原因（工具返回里的 `message` / `issues`），并给出 `restore` 退路；
   不要反复重试同一条命令。
5. **不做超出请求的事**：用户说「接 Codex」就只动 Codex。
6. **如实汇报**：只报告工具真实返回的内容；没跑就说没跑。

## 2. 标准工作流

### A. 接入（用户：「把 X 接到公司网关」）

1. `coworker_dispense(command="doctor")` → 网关是否可达、凭证来源、本机有哪些 agent。
   - 返回「未找到网关凭证」→ 引导用户在应用里点「获取 API Key」（或走 `coworker_magene_setup`），
     **不要**让用户把 Key 发到聊天。
2. `command="status", agent=X` → 汇报现状与问题。
3. `command="plan", agent=X`（可选 `mainModel`）→ 得到将要写入的文件与变更。
4. `command="apply", agent=X`（**不传 confirm**）→ 应用弹出确认卡片（内含上面的变更计划 + 确认/取消）。
   可以在回答里用一两句话说明"卡片里是什么、点确认会做什么"，但**不要**要求用户打字回复。
5. 用户点「确认」后工具落盘（点「取消」则原样返回，不要重试）。把「已写入 + 备份文件名 + 生效方式」转述给用户。
6. `command="status", agent=X` 复核：问题清单为空才算成功；非空则如实报告剩余问题。

### B. 仅更新模型列表（网关上了新模型）

`command="models", agent=X`（不传 confirm）→ 确认卡片点确认。

### C. 还原（用户：「还原 XX 的配置 / 别用公司网关了」）

1. `command="backups", agent=X` → 列出可用还原点（含时间）。
   - 空列表 → 如实告知「没有可用备份，无法还原」，不要伪造。
2. `command="restore", agent=X`（**不传 confirm**；要指定还原点就带 `backup=<文件名>`）→
   应用弹出确认卡片（内含备份列表与将覆盖的文件）→ 用户点确认才还原。
3. `command="status", agent=X` 复核。

### D. 修复（用户：「XX 的配置坏了 / 用不了了」）

1. `command="status", agent=X` → 看问题清单。
2. `command="repair", agent=X`（**不传 confirm**）→ 确认卡片里会给出将重写的受管块；用户点确认才写入。
   - 返回 `needs_restore`（配置文件不是合法 JSON 等）→ **不要**手工改 JSON，转 C 流程还原或人工修复。
3. 看「剩余问题」：为空 = 修好；非空 = 如实报告并建议还原。

## 3. 汇报模板

```
✅ 已把 Claude Code 接到公司网关
- 写入：~/.claude/settings.json（备份 settings.json.bak-20260923101533）
- 主模型：deepseek-v4-flash[1m]；haiku/sonnet/opus/fable/subagent 角色同主模型
- 生效：新开终端重启 claude
- 回滚：说「还原 Claude 配置」即可（会自动再备份当前文件）
```

失败时：先结论（哪一步没成功），再原因（工具返回的 message/issues），最后退路（还原 / 找 IT）。

## 4. 常见情况对照

| 现象 | 含义 | 处置 |
|---|---|---|
| `gate: plan_first` | 无 UI 场景下没先出计划 | 先 `plan`（还原先 `backups`），再 `confirm:true` |
| `gate: card_required` | 应用内传了 `confirm`（想绕过卡片） | 去掉 `confirm` 重新调用，让用户点卡片 |
| `confirm_required` | 工具/CLI 要求确认 | 同上门禁：先展示计划再重试 |
| `no_credentials` | 应用内还没有网关凭证 | 引导应用内取 Key / `coworker_magene_setup`；不要索要 Key |
| `no_backup` | 没有可还原的备份 | 如实告知；不要手写配置 |
| `needs_restore` | 配置文件非法 JSON | 转还原流程或人工修复 |
| 网关不可达 | 网络/凭证问题 | 报告，别反复重试 |
| 问题剩「模型列表为空」 | 网关没返回模型 | `doctor` 看 `/models`，再 `models … confirm=true` |
| 用户要指定模型 | `mainModel`（如 `deepseek-v4-pro`） | 先 `doctor` 看样例模型，再让用户挑 |

## 5. 安全与审计

- 每次操作都会写审计：应用侧 `~/.coworker/audit.jsonl`（`dispense_*`）与 CLI 侧
  `~/.coworker/audit/dispenser.jsonl`（含文件与备份，**不含密钥**）。
- 密钥只落在被写入的 agent 配置文件（各 agent 自身规范）与 0600 的凭据文件里。
- 输出中密钥一律掩码（`sk-t…7890`）。若在**任何输出**里看到完整密钥：停止操作并报告异常。
- 还原前会自动把当前文件再备份为 `.bak-pre-restore-*`，还原本身也可回滚。

## 6. 其它

- 支持自定义网关（非公司网关）仅限 CLI 场景（`--gateway custom --base-url … --api-key-stdin`），
  Key 从 stdin 走、不进 argv、不进对话。
- 本技能只负责「分发与还原」；应用自身模型配置走 `coworker_magene_setup` / `coworker_magene_status`。
- 平台：macOS / Windows / Linux 通用；各 agent 配置文件路径按自身约定（Windows 如 `%USERPROFILE%\.codex`）。
