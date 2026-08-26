# 阶段 A 设计：个人效率集群（coworker_personal）

- 日期：2026-08-26
- 状态：待用户审阅
- 关联：DESIGN.md §3/§5（工作集群）、DESIGN-LOCAL.md（个人本地 Bot）、gui/README.md（桌面 GUI）

## 1. 背景与目标

企业 AI 助手目前只覆盖：入职引导、权限申请、知识问答、技能同步。员工日常最常用的个人效率场景（日程/待办/会议纪要/邮件/通讯录）未覆盖。

本设计新增**个人效率工作集群**，让用户通过对话（GUI / 个人 Bot / CLI）问"我今天有什么会"、"我有哪些未完成的待办"、"上次的会议纪要讲了啥"、"有没有新邮件"、"帮我查一下同事 X"，并能**经确认后**建日程、建/完成任务、发邮件。

全部能力编排 `lark-cli` 对应域的 +shortcut（已逐条在真实账号验证可用），不直接调飞书 OpenAPI。

## 2. 架构

```
extensions/clusters/personal.ts      —— 新的工作集群（与其他集群同构）
  ├─ pi.registerTool(...)  x12       —— coworker_* 工具（读 8 + 写 4）
  ├─ runLark/describeLarkError       —— 复用 core/lark.ts（--as user / 脱敏 / exit10 门禁）
  ├─ confirmWrite + appendAudit      —— 复用 core/safety.ts / core/config.ts
  └─ requireCluster("personal")      —— policy.json 集群白名单门禁
```

- 工具三端自动生效：GUI 后端（PiAgentPool `-e extensions/index.ts`）、Bot Agent daemon、CLI（pi + `/coworker:*`）。
- 身份：一律 `--as user`（员工自己的身份，只碰自己的数据）。拒绝 bot 身份执行本集群工具（治理规则拦截）。
- GUI 后端 `GUI_TOOLS` 白名单追加本集群工具 id（写工具 GUI 内同样走确认弹窗）。
- 审计：写操作（create/complete/send）必须 `appendAudit`；读操作不强制审计（量大），但敏感域（邮件正文）不落审计日志。

## 3. 工具规格

参数均用 `Type.Object`（typebox）。输出统一 `okResult({...})` / `errResult(msg)` 结构（与现有集群一致）。

### 读类（8 个）

| 工具 | 参数 | 输出要点 | lark-cli 调用 |
|---|---|---|---|
| `coworker_schedule_today` | 无 | 今日日程列表（时间/标题/地点/参会人）；无日程时提示"今日无日程"并附明日首条 | `calendar +agenda --as user` |
| `coworker_schedule_query` | `start?` `end?` `keyword?` | 时间窗内日程（默认近 7 天）或关键词搜索 | `calendar +search-event \| +agenda --range` |
| `coworker_task_list` | `filter?` (all\|open\|done, 默认 open) `tasklistId?` | 待办列表（标题/截止/完成态/清单名），按 due 排序 | `task +get-my-tasks` |
| `coworker_minutes_search` | `query?` `start?` `end?` | 妙记列表（标题/时间/所有者），默认近 30 天 | `minutes +search`（至少一个过滤参数） |
| `coworker_minutes_get` | `token`（必填） | 妙记摘要/待办/章节（`+detail` artifact），截断 14k | `minutes +detail --token` |
| `coworker_mail_triage` | `query?` `limit?` (≤10) | 收件箱摘要（发送人/主题/时间/message_id），支持全文检索 | `mail +triage` |
| `coworker_mail_read` | `messageId`（必填） `full?`(默认 false) | 单封邮件正文（默认去引用段/签名）+ 附件元数据 | `mail +message \| +thread` |
| `coworker_contact_find` | `keyword`（必填） | 同事姓名/部门/职位/邮箱（脱敏，如 li**@xx.com） | `contact +search-user --query` |

### 写类（4 个工具，全部走确认）

| 工具 | 参数 | 确认与审计 | lark-cli 调用 |
|---|---|---|---|
| `coworker_schedule_create` | `title` `start` `end` `attendees?[]` `room?` | confirmWrite + appendAudit(schedule_create) | `calendar +create --as user` |
| `coworker_task_create` | `title` `due?` `desc?` | confirmWrite + appendAudit(task_create) | `task +create` |
| `coworker_task_complete` | `taskId` | confirmWrite + appendAudit(task_complete) | `task +complete` |
| `coworker_mail_send` | `to[]` `subject` `body` `cc?` | 草稿预览 → confirmWrite → 发送；appendAudit(mail_send, 不含正文) | `mail +send --confirm-send` |

> 写工具参数 `confirm`（boolean，可选）：交互模式走 UI 确认；非交互必须显式传 `confirm:true`（复用 confirmWrite 既有语义）。

## 4. 安全边界

1. **身份**：全部 `--as user`；治理规则确保本集群工具禁止 bot 身份执行。
2. **写必确认**：写工具一律 confirmWrite；lark-cli exit 10（high-risk 写）绝不自动 `--yes`。本设计不包含 high-risk 写（不发 `+message-trash`、不删日程）。
3. **脱敏**：
   - 邮件/妙记正文：走 `core/lark.ts` 已有脱敏 + 对 body 字段再做一次 sanitize。
   - 通讯录邮箱打码。
   - 审计日志：记录"发生了什么"，不记录邮件正文/妙记全文。
4. **截断**：邮件/妙记正文默认截断（14k），防上下文爆。
5. **集群白名单**：policy.json `clusters.enabled` 需包含 `personal`。

## 5. 数据流示例

"我今天有什么会"：
1. 对话 → `coworker_schedule_today`
2. `runLark(["calendar","+agenda","--as","user"])` → 信封解析
3. 失败 → `describeLarkError` 明确报错（未登录/缺 scope/无权限）
4. 成功 → 列表格式化返回（空 → "今日无日程"）

"帮我把周三 10 点建个会，参会人张三李四"：
1. `coworker_schedule_create`（先 `contact +search-user` 解 open_id；找不到返回候选）
2. confirmWrite（标题/时间/参会人预览）→ 用户确认
3. `calendar +create --as user` → appendAudit → 返回含日程链接

## 6. 错误处理

- lark-cli 信封 `ok:false`：`describeLarkError`（missing_scopes 时提示授予 scope）。
- 写工具被拒：`errResult` + `blocked:true`，不调 API。
- 参会人解析失败：返回候选列表，不猜测。
- scope 缺失：引导重新授权（split-flow）。

## 7. 测试计划

1. **冒烟（真实账号）**：12 个工具逐个调用；写类验证"不经确认不落盘"。
2. **单元**：参数校验、脱敏、时间窗解析。
3. **集成**：GUI `/ask` 真数据问答；daemon 冒烟。
4. **回归**：`npm run check` + 现有集群不受影响。

## 8. 范围控制（YAGNI）

- 不做：考勤、OKR、白板、slides、邮件自动分类、日程智能编排、会议 bot 入会。
- GUI「今日聚合卡片」二期；本阶段 GUI 靠对话即可，仅追加 GUI_TOOLS 白名单。

## 9. 配置与文档变更

- `config/policy.json`：`clusters.enabled` 加 `personal`。
- `gui/backend/src/index.ts`：`GUI_TOOLS` 追加本集群工具 id。
- `README.md` / `docs/INTERACTION.md`：工作集群表补充 personal。
- 命令族：MVP 先只加 `/coworker:today` 快捷命令。