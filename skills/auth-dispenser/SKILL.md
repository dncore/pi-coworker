---
name: auth-dispenser
description: 把公司模型网关（magene）或自定义 OpenAI 兼容网关分发到本机其它 AI agent（Codex / Claude Code / Reasonix / dsh / Grok Build / omp / OpenCode），并支持还原配置、修复损坏配置、仅更新模型列表。当用户说「把 Codex/Claude Code/… 接上公司网关」「把我的网关配置给 XX 用」「XX 的配置坏了/还原 XX 配置」「更新 XX 的模型列表」时使用。
---

# 授权分发（auth-dispenser）

把**本应用已配置的网关凭证**（或用户给定的自定义网关）写入其它 agent 的配置文件，使其直连同一网关。
一切写操作通过 `dispenser/cli.ts`（本技能称 **CLI**）完成——**不要手工编辑这些 agent 的配置文件**。

## 0. 工具

```bash
CLI="${COWORKER_DISPENSER_CLI:-$HOME/.coworker/bin/dispenser.mjs}"
node "$CLI" <命令> [参数]
```

- 所有命令输出**单行 JSON**：`ok` / `summary`（人读摘要）/ `plan`（待写文件与变更）/ `issues`（诊断）/ `status`。
- 退出码：`0` 成功；`2` = `confirm_required`（写操作缺 `--yes`，且 JSON 里带完整计划）；`1` 失败。
- 支持 agent：`codex` `claude` `reasonix` `dsh` `grok` `omp` `opencode`。
- 命令：`doctor` `agents` `status` `plan` `apply` `models` `backups` `restore` `repair`。

## 1. 铁律（门禁，违反即为事故）

1. **写操作必须用户确认**：`apply` / `models` / `restore` / `repair` 都必须先拿到用户的明确同意，再加 `--yes`。
   未确认时先跑 `plan`（只读）并把摘要给用户。**不要**为了"省事"直接 `--yes`。
2. **密钥绝不进对话**：不要问用户要 API Key，不要让用户把 Key 发到聊天里，绝不要把 Key 写进命令行。
   - magene 网关：凭证由 CLI 自己从应用内配置读取（员工无需输入）。
   - 自定义网关：用 `--api-key-stdin`（或让用户在环境变量里配），Key 不从你嘴里/命令里过。
3. **不改配置文件、不改第三方 agent 的其它设置**：只经 CLI 写「托管块」。用户其它配置（permissions、其它 provider）必须原样保留——CLI 已保证，若发现被误改，立即 `restore` 并如实报告。
4. **失败即停**：任何 `ok:false` 都不要盲目重试；读 `message` 给出原因，并把 `restore` 作为退路。
5. **不做超出请求的事**：用户说「接 Codex」就只动 Codex；不要顺手配置其它 agent。
6. **如实汇报**：只报告命令真实输出。命令没跑就说没跑；失败就把失败原文摘要给用户。

## 2. 标准工作流

### A. 接入（用户：「把 X 接到公司网关」）

1. `doctor`（只读）：确认网关可达 + 凭证来源 + 本机装了哪些 agent。
   - `ok:false`（无凭证）→ 引导用户在应用里点「获取 API Key」或走 `coworker_magene_setup`，**不要**让用户把 Key 发到聊天。
2. `status --agent X`（只读）：汇报现状与问题（未接入 / 配置损坏 / 模型为空）。
3. `plan --agent X`（只读，可加 `--main-model <id>` 指定默认模型）：得到将要写入的文件与变更清单。
4. **向用户确认**：把 plan 摘要说人话（写哪些文件、换成什么、会备份、要重启什么），用 `ask_user_question` 拿到同意。
5. `apply --agent X --yes`：落盘。把 `written`（文件 + 备份名）与 `nextSteps` 如实转述。
6. `status --agent X` 复核：`issues` 为空才算成功；非空则报告剩余问题。

### B. 仅更新模型列表（网关上了新模型）

`status` → 用户确认 → `models --agent X --yes`。只动模型条目，provider / 凭证 / 默认模型不变。

### C. 还原（用户：「还原 XX 的配置 / 别用公司网关了」）

1. `backups --agent X`（只读）列出可用备份（含时间）。
2. 让用户选（默认最近一次）→ `restore --agent X [--backup <文件名>] --yes`。
   - 无备份时 CLI 返回 `no_backup`：如实告知，不得伪造"已还原"。
3. 还原后 `status --agent X` 复核。

### D. 修复（用户：「XX 的配置坏了 / 用不了了」）

1. `status --agent X` 看 `issues`。
2. `repair --agent X --yes`（用户确认后）：重写托管块，幂等，写前备份。
   - 返回 `needs_restore`（配置文件不是合法 JSON 等）→ **不要**尝试手工改 JSON，转 C 流程让用户从备份还原或人工修复。
3. 看 `issuesRemaining`：为空 = 修好；非空 = 如实报告，并建议 `restore`。

## 3. 汇报模板（给用户的最终消息）

```
✅ 已把 Claude Code 接到公司网关
- 写入：~/.claude/settings.json（备份 settings.json.bak-20260923101533）
- 主模型：deepseek-v4-flash[1m]；角色模型 haiku/sonnet/opus/fable/subagent 同主模型
- 生效：新开终端重启 claude
- 回滚：说「还原 Claude 配置」即可（备份可选）
```

失败时：先说结论（没成功/哪一步失败），再给原因（JSON 里的 `message`），最后给退路（重试 / restore / 找 IT）。

## 4. 常见情况对照

| 现象 | 含义 | 处置 |
|---|---|---|
| `code=confirm_required`（退出码 2） | 少 `--yes` | 先拿用户确认，再带 `--yes` 重跑 |
| `code=no_credentials` | 应用内还没有网关凭证 | 引导应用内取 Key / `coworker_magene_setup`；不要索要 Key |
| `code=no_backup` | 没有可还原的备份 | 如实告知；不要手写配置 |
| `code=needs_restore` | 配置文件非法 JSON | 转还原流程或人工修复 |
| `gateway.reachable=false` | 网关不可达 | 报告网络/凭证问题，别反复重试 |
| `issues` 剩「模型列表为空」 | 网关没返回模型 | 跑 `doctor` 看 `/models`，再 `models --agent X --yes` |
| 用户要指定的模型 | `--main-model <id>`（如 `deepseek-v4-pro`） | 先 `doctor` 取 `sample`，再让用户挑 |

## 5. 安全与审计

- 每次写操作都会追加审计：`~/.coworker/audit/dispenser.jsonl`（含 agent、动作、文件、备份；**不含密钥**）。
- 密钥只出现在被写入的 agent 配置文件里（这是各 agent 自身的规范），以及 0600 的凭据文件里。
- 输出中的密钥一律掩码（`sk-t…7890`）。若你在任何输出里看到**完整**密钥：停止操作、报告异常。
- 还原前会自动把「当前文件」再备份为 `.bak-pre-restore-*`，还原本身也可回滚。

## 6. 其它

- **自定义网关**（非公司网关）：`--gateway custom --base-url <url> --api-key-stdin`；`label`/`provider-name` 可自定义。
  Key 从 stdin 传入时用管道（如 `printf '%s' "$KEY" | node "$CLI" …`），**不要**写进命令行参数。
- 平台：macOS / Windows / Linux 通用；Windows 下配置文件路径按各 agent 自身约定（如 `%USERPROFILE%\.codex`）。
- 本技能只负责「分发与还原」；应用自身模型的配置（magene provider）走 `coworker_magene_setup` / `coworker_magene_status`。
