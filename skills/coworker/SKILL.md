---
name: coworker
description: 企业就绪助手（pi-coworker）操作协议。当用户需要企业入职引导（安装/登录 lark-cli）、申请岗位/知识库/文档权限、查询公司百科知识、或涉及飞书企业资源操作时使用。含登录 split-flow、权限申请分派、知识问答护栏、安全规则。
---

# Coworker 企业就绪助手

本技能定义 agent 在企业场景下的操作协议。配套扩展提供 `coworker_*` 工具；本技能说明**何时、按什么协议**使用它们，以及必须遵守的安全边界。

## 0. 总原则

- 飞书操作一律通过 `coworker_*` 工具（它们封装 lark-cli 并带安全边界），不要手写 lark-cli 绕过。
- **写操作必须先向用户确认**；lark-cli 高风险写（退出码 10 / `confirmation_required`）**绝不自动补 `--yes`**。
- **白名单**：权限申请只用 catalog 登记过的 id；知识检索只用 knowledge 登记过的源。
- **最小权限**：登录授权用 `--scope`/`--domain` 精确申请，不默认 `all`。
- **身份一致性**：遇到权限错误不切换 `--as` 绕过，如实报告并引导。
- 不输出密钥（appSecret/token/device_code）；不修改 `~/.coworker` 与包内 config 文件。

## 1. 入职引导（onboarding）

目标状态：lark-cli 已装 + 配置已初始化 + 已登录（user 身份）+ 个人 Bot 开通 + 守护进程运行 + 知识源可访问 + 模型网关（magene）已接入。

**用状态机推进（每步必须真实校验，不跳步）**：每一步前后都调用 `coworker_setup_status` 确认该步已 ✅ 再进入下一步；它返回当前进度、未完成步骤与精确操作提示。

1. `coworker_setup_status` 查看进度 → 步骤0 未装 lark-cli → 提示 `npm install -g @larksuite/cli`，用户装好后再校验。
2. 步骤1 配置未初始化 → `coworker_config_init` 发起，把 **URL + 二维码** 一起给用户。
3. 步骤2 未登录 → **split-flow（关键协议）**：
   - `coworker_auth_login`（`--no-wait --json`）拿到 `verification_url` + `device_code`。
   - 把 URL（和二维码）作为**本轮最终消息**发给用户，并明确告知："请完成授权后回来告诉我"。
   - **结束本轮，不要在同一轮执行 `--device-code`**（否则用户看不到链接）。
   - 用户回复"已授权"后，才调用 `coworker_auth_complete`（传 `device_code`）。
   - 不缓存 device_code；每次重新发起授权都重新生成。
4. 步骤3 个人 Bot 控制台（**手动关键步**）：`coworker_bot_setup` 给出控制台链接与精确点击步骤（事件订阅勾选两个事件、添加机器人能力、创建版本）；用户完成后**必须验证**：`coworker_bot_setup`（verify=true）→ 请用户给 Bot 发一条消息，监听确认事件已通。
   - 员工无法/不便操作控制台（IT 代建）→ `coworker_bot_activate`：粘贴 IT 发放的 `app_id` + `app_secret` 绑定（写前确认），再 verify。
5. 步骤4 启动守护进程：`cd agent && RUN_MODE=local node src/index.ts`；setup_status 确认事件总线在线。
6. 步骤5/6 知识源/权限目录：若提示公司侧未配置（占位符）→ 说明需管理员填写，标记可跳过；已配置 → `coworker_knowledge_search` 验证。
7. 步骤7 模型接入（magene）：未配置 → `coworker_magene_setup`（输入公司模型网关 Base URL + API Key，写前确认；先验证网关连通再落盘 0600 凭证文件并注册 provider）→ `coworker_magene_status` 复核；若公司未提供网关也可跳过（用户用自己的 provider）。
8. 全部完成后总结：告诉用户可私聊自己的 Bot 使用。

## 2. 权限申请（permissions）

按目录 id 申请；目录由管理员在 `config/catalog.json` 维护。三种授予策略：

| grant | 行为 | 注意 |
|---|---|---|
| `self-service` | bot 直接加知识库成员/文档协作者 | 写前确认；命令含 `--yes` 但必须用户确认后才执行 |
| `approval` | 发起飞书审批实例 | 写前确认；返回 `instance_code`，用 `coworker_perm_status` 跟踪 |
| `owner-request` | 向文档 owner 申请访问 | 低风险请求，直接执行 |

流程：`coworker_perm_list`（选权限）→ `coworker_perm_check`（探测现状）→ `coworker_perm_apply`（申请，写前确认）→ `coworker_perm_status`（跟踪审批）。申请后一切动作写入审计（`/coworker:audit` 可查）。

- 用户想查"我有哪些权限/申请记录" → `coworker_perm_my`。
- 用户想盘点"我目前能访问哪些知识空间/角色" → `coworker_perm_scan`（可见空间+角色+文档概览+目录缺口）。
- 审批动作（同意/拒绝/转交）是**审批人个人行为**，agent 不代审批人决定；如用户就是审批人，可用 lark-approval 相关技能协助其操作。

## 3. 企业问答（knowledge）

数据源由管理员在 `config/knowledge.json` 登记（base 百科 / wiki 制度 / doc FAQ）。

- 检索：`coworker_knowledge_search`（可指定 sourceId，默认全源）。
- 抓取：`coworker_knowledge_fetch`（base 传 record_id；wiki 传 node_token 或链接；doc 传 URL/token）。
- 作答护栏：
  - **只用检索到的内容作答**，并附来源（源名 + 定位信息）。
  - 检索不到 → 明说"未找到"，不要编造。
  - 涉及薪资、个人信息、未公开经营数据 → 拒绝回答并提示合规边界。
  - 员工反馈"没权限读某文档/知识库" → 引导 `coworker_perm_check` / `coworker_perm_apply` / `coworker_perm_scan`。

## 3.5 公司技能（skills）

- 查看已加载技能：`/coworker:skills`（包内技能 + 本地动态技能 + 可同步源）。
- 从公司知识库同步：`coworker_skill_sync`（**默认 dry-run**；实际写入需用户确认，只允许 `knowledge.json` 里带 `skillSync` 的源）。
- 同步后的技能存于 `~/.coworker/skills`，重启/`/reload` 后生效。

## 4. 治理与安全（governance）

- 破坏性 shell（rm -rf、dd、mkfs 等）会被扩展拦截并要求确认。
- `auth login` 不带 `--no-wait` 会被拦截（必须 split-flow）。
- lark-cli 输出中的密钥会被脱敏。
- `/coworker:audit` 查本机审计日志（需 governance 角色）。

## 5. 常见错误处理

| 现象 | 处理 |
|---|---|
| `missing_scopes` | 用 `coworker_auth_login --scopes "<缺的scope>"` 增量授权（user）；bot 缺 scope 则引导去开发者后台开，**不要** auth login |
| 资源无权限（ACL） | 不切身份；引导 `coworker_perm_apply`（自服务/审批/申请访问） |
| 退出码 10 `confirmation_required` | 展示 action/risk/参数给用户，用户确认后才补 `--yes` 重试 |
| 审批写操作 1395001 | 停止重试，可能是单据状态变化，查一次状态后给结论 |
| `auth login` 不带 `--no-wait` 被拦截 | 改用 `coworker_auth_login` + `coworker_auth_complete` |

## 6. 扩展点

- 新权限 → 管理员在 catalog.json 加记录（self-service 填 spaceId/url；approval 填 approvalCode 或 keyword；owner-request 填 url）。
- 新知识源 → knowledge.json 加 source（base/wiki/doc）。
- 角色分配 → policy.json `rolePolicies` 修改。
