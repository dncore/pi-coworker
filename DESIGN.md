# pi-pi-coworker — 企业就绪 pi agent 扩展 设计文档

- 版本：0.1.0（设计）
- 日期：2026-02（初稿）
- 状态：已确认，进入实现

## 1. 背景与目标

企业希望把 pi（coding agent）变成一款**企业就绪**的工作助手：新员工装上 pi 后，能在一分钟内完成飞书（Lark）接入、权限申请、知识问答等日常工作，同时保证整个过程在**安全边界**之内，权限与行为可审计、可治理、可持续扩展。

本项目交付一个 pi 包 `pi-coworker`，基于 lark-cli 编排飞书能力，以**工作集群（work cluster）** 组织功能，内置安全规则引擎。

### 核心目标

1. **引导入职**：引导员工安装 lark-cli、初始化配置、完成登录授权（扫码/链接），并校验状态。
2. **权限自助/申请**：按权限目录（catalog）申请岗位权限、知识库权限、文档权限，混合策略（直授 / 审批 / 向 owner 申请），并跟踪进度。
3. **企业问答**：接入公司百科等多源知识，回答员工问题，仅限已登记的知识源，附来源，禁止编造。
4. **安全治理**：设置安全边界与规则（最小权限、身份一致性、高风险门禁、密钥保护、白名单），全量审计。
5. **可持续扩展**：集群即插即用，新增权限 / 知识源 / 集群只改配置或新增模块。

## 2. 总体架构

```
┌──────────────────────────────────────────────────────────┐
│  pi (agent)  —— 引导 / 问答 / 权限 交互入口               │
│  ┌────────────────────────────────────────────────────┐  │
│  │  pi-coworker 扩展（TypeScript）                  │  │
│  │  ┌──────────┬──────────┬──────────┬────────────┐   │  │
│  │  │onboarding│permissions│knowledge │ governance │   │  │
│  │  │ 入职引导 │ 权限申请   │ 知识问答  │ 治理与安全  │   │  │
│  │  └──────────┴──────────┴──────────┴────────────┘   │  │
│  │  core：lark 封装 · 配置 · 安全规则 · 审计 · 目录     │  │
│  └──────────────────────┬─────────────────────────────┘  │
│                         │ 子进程（JSON 信封，无 shell）    │
└─────────────────────────┼────────────────────────────────┘
                          ▼
                     lark-cli（飞书）
        config / auth / approval / wiki / drive / base / docs / contact
```

### 设计原则

- **单一后端**：扩展不直接调飞书 OpenAPI，只编排 `lark-cli`。认证、scope、身份、权限、高风险门禁全部复用 lark-cli 的能力，扩展负责**流程编排 + 安全边界 + 规则注入 + 审计**。
- **进程隔离**：所有 lark-cli 调用走 `execFile`（参数数组，无 shell 拼接），杜绝 shell 注入。
- **目录驱动**：权限目录（catalog）、知识源（knowledge）、策略（policy）都是配置文件，管理员维护，扩展按配置动态路由。**agent 只能触碰目录中登记的资源**。
- **默认只读、写必确认**：读取类操作放开，写入类操作必须用户确认（含 lark-cli 的 exit 10 门禁）。

### 工作方式（个人本地 Bot 为核心）

agent 以**「个人本地 Bot」**为主：后台常驻 agent 跑在员工本机，用户在飞书里私聊自己的 Bot（问答/权限/入职/点卡片），用**用户自己的 lark-cli 身份 + 自己的 LLM provider**，工作目录=本机，通过 lark-cli 与飞书能力捆绑。同一守护程序（`agent/`）以 `RUN_MODE` 切换：

| 模式 | 运行位置 | 身份 | 工具集 | 交互入口 |
|---|---|---|---|---|
| `local`（默认） | 本机 | lark-cli 用户 | 全 coworker 工具（可开本地工具） | 飞书私聊个人 Bot + 卡片 |
| `server` | 服务器 | bot 身份 | 只读子集 | 飞书群 @共享机器人 + 卡片 |
| CLI（补充） | 本机 | lark-cli 用户 | 全部 coworker 工具 | pi TUI + `/coworker:*` |
| 桌面 GUI（可选） | 本机 | lark-cli 用户 | coworker 工具（禁本地工具） | 守护进程托盘/启动器 |

> 用户具体怎么交互（登录 split-flow、自然语言、卡片按钮等）详见 [`docs/INTERACTION.md`](docs/INTERACTION.md)。

## 3. 工作集群（Work Clusters）

每个集群是一组「工具 + 命令 + 规则」的内聚模块。工具（tool）供 LLM 在对话中调用；命令（command）供用户输入 `/coworker:*` 触发。

| 集群 | 职责 | 工具（coworker_*） | 命令 |
|---|---|---|---|
| **onboarding 入职引导** | 装 lark-cli、config init、split-flow 登录、状态校验、入职清单、**个人 Bot 开通**、**状态机向导** | `check_env`、`config_init`、`auth_login`、`auth_complete`、`auth_status`、`bot_setup`、`setup_status` | `/coworker:setup`、`/coworker:status`、`/coworker:bot` |
| **permissions 权限申请** | 权限目录浏览、现状检测、申请（混合策略）、进度跟踪、知识权限盘点 | `perm_list`、`perm_check`、`perm_apply`、`perm_status`、`perm_my`、`perm_scan` | `/coworker:perm` |
| **knowledge 知识问答** | 统一检索层（base/wiki/doc）、内容抓取、问答护栏 | `knowledge_search`、`knowledge_fetch` | — |
| **skills 公司技能** | 从公司知识库同步 skill 到本地并加载；技能盘点 | `skill_sync` | `/coworker:skills` |
| **governance 治理与安全** | 危险操作拦截、密钥脱敏、身份一致性、角色可见性、审计 | （事件钩子 + 审计） | `/coworker`、`/coworker:audit` |
| **lifecycle 生命周期**（扩展点） | 离职回收权限、周期性权限复核、权限到期提醒 | 预留接口 | 预留 |

> 生命周期集群暂不实现，只预留目录扩展点（见 §9）。

### 3.1 知识权限盘点（perm_scan）

`coworker_perm_scan` 直接以用户身份读取其知识权限：

- `wiki +space-list --as user`：列出用户可见的全部知识空间（含 visibility / space_type）。
- `wiki +member-list --space-id <id>`（并发，按用户 openId 过滤）：得到用户在每个空间的**角色**（admin / member / 非成员仅可见）。
- `drive +search`（空查询浏览）：得到用户当前**可检索文档总数**（检索受 ACL 约束，即可见面）。
- 与 catalog 对比输出**权限缺口**（已具备 / 未具备 / 目录未配置）。

适用于入职自查与定期权限治理。

### 3.2 公司技能加载与同步（skills）

- **包内分发**：包自带 `skills/` 目录，管理员往里加 `skills/<公司技能>/SKILL.md` 随包分发。
- **动态加载**：扩展在 `resources_discover` 返回 `skillPaths`（默认 `~/.coworker/skills`，可用用户配置 `clusters.skillsDir` 覆盖），运行时注入，`/coworker:skills` 查看。
- **从知识库同步**：管理员在 `knowledge.json` 的某个源上配置 `skillSync`（白名单，仅此类源可同步），`coworker_skill_sync` 拉取 Base 中的技能（名称/描述/内容/启用开关）写入本地目录；**默认 dry-run，写入需 confirmWrite**。技能名按 pi 命名规则校验。

## 4. 混合权限授予策略（catalog 驱动）

`config/catalog.json` 声明权限目录。每条权限包含 `id / name / type / grant`，`grant` 决定申请时的授予路径：

| grant 策略 | 含义 | 实现路径 | 身份 |
|---|---|---|---|
| `self-service` | 自助直授：bot 有管理员权限，直接加成员/协作者 | `wiki +member-add` / `drive +member-add` | `--as bot` |
| `approval` | 走飞书审批：发起实例，跟踪进度 | `approvals search → approvals get → instances create → tasks query / instances get` | `--as user` |
| `owner-request` | 向文档 owner 申请访问 | `drive +apply-permission` | `--as user` |

权限类型（type）与目标解析：

- `wiki-space`：知识空间，`space_id`（或 URL，用 `wiki +node-get` 解析）
- `drive-doc` / `drive-folder`：云文档 / 文件夹，`url` 或 token
- `position`：岗位权限，映射到审批定义（`approvalCode`），形成「岗位 → 权限包」

自服务直授属于**高风险写操作**：工具先 `--dry-run` 预览，再用 `ctx.ui.confirm` 向用户确认，确认后才追加 `--yes` 执行。禁止静默 `--yes`。

## 5. 安全边界与规则（四层防御）

### 5.1 目录白名单层（Catalog Allowlist）

- `coworker_perm_apply` 只接受 `catalog.json` 中登记的权限 `id`；未登记一律拒绝。
- `coworker_knowledge_search/fetch` 只接受 `knowledge.json` 中登记的 `sourceId`；未登记源一律拒绝。
- 管理员维护的配置文件是**唯一事实来源**，扩展启动时校验 schema，非法配置拒绝加载对应集群。

### 5.2 lark-cli 原生门禁

- 高风险写操作（`risk: high-risk-write`）无 `--yes` 时退出码 `10`，stderr 返回 `confirmation_required`。**扩展绝不自动补 `--yes`**；必须向用户展示 `error.action / error.risk / 关键参数`，用户确认后才重试。
- 判断成功用 `ok == true`（或退出码 0），**不用** OpenAPI 老格式 `code == 0` 判断。

### 5.3 扩展拦截层（事件钩子）

- `tool_call`：拦截破坏性 shell（`rm -rf`、`dd`、`mkfs`、`> /dev/sda`、`curl|sh`、`sudo` 等），弹确认。
- `tool_call`：拦截 `auth login` 不带 `--no-wait` 的调用（会阻塞 agent），提示用 split-flow。
- `tool_result`：对 lark-cli 输出做**密钥脱敏**（`app_secret`、`appSecret`、`access_token`、`refresh_token`、`device_code` 等）。
- 身份一致性：所有工具显式传 `--as`；遇到权限错误**不静默换身份**，按 lark-shared 规则如实报告。

### 5.4 规则注入层（skill + 系统提示）

- 随包分发 `skills/coworker/SKILL.md`，在 `before_agent_start` 将企业规则追加进系统提示：
  - 最小权限授权：登录只用 `--scope`/`--domain`，不申请 `all` 除非用户明确要求。
  - 只读默认：读取开放，写入需用户确认。
  - 问答护栏：只用已登记知识源；引用来源（标题/链接）；不知道就明说，禁止编造公司政策。
  - 审批动作（同意/拒绝等）属于审批人个人行为，agent 不代审批人决定。

### 5.5 角色可见性（policy 驱动）

`config/policy.json` 定义 `rolePolicies`（角色 → 可用集群）。工具执行前校验当前用户角色是否被允许使用该集群；未授权返回明确原因。默认角色 `employee` 可用 onboarding + knowledge；permissions 写操作需更高角色或逐次用户确认。

## 6. 配置模型

| 文件 | 位置 | 维护者 | 内容 |
|---|---|---|---|
| `config/catalog.json` | 包内（分发） | 管理员 | 权限目录（grant 策略） |
| `config/knowledge.json` | 包内（分发） | 管理员 | 知识源声明 |
| `config/policy.json` | 包内（分发） | 管理员 | 安全规则 + 角色→集群映射 |
| `~/.coworker/coworker.json` | 用户机器 | 员工 + setup | 角色、身份、启用集群、登录信息 |
| `~/.coworker/audit.jsonl` | 用户机器 | 系统 | 审计日志（可选同步 Base） |

### 6.1 catalog.json

```jsonc
{
  "$schema": "./schemas/catalog.schema.json",
  "permissions": [
    { "id": "wiki_engineering", "name": "研发知识库", "type": "wiki-space",
      "grant": "self-service", "spaceId": "1234567890",
      "memberRole": "member", "as": "bot" },
    { "id": "pos_backend", "name": "后端岗位权限", "type": "position",
      "grant": "approval", "approvalKeyword": "岗位权限申请",
      "approvalCode": "xxx", "formTemplate": [ { "name": "岗位", "value": "后端" } ] },
    { "id": "doc_onboarding", "name": "入职文档", "type": "drive-doc",
      "grant": "owner-request", "url": "https://xxx.feishu.cn/docx/xxx", "perm": "view" }
  ]
}
```

### 6.2 knowledge.json

```jsonc
{
  "sources": [
    { "id": "encyclopedia", "type": "base", "name": "公司百科",
      "baseToken": "bascn_xxx", "table": "百科", "searchFields": ["词条", "内容"] },
    { "id": "policies", "type": "wiki", "name": "制度与流程", "spaceId": "7351xxxx" },
    { "id": "faq", "type": "doc", "name": "FAQ", "url": "https://xxx.feishu.cn/docx/xxx" },
    { "id": "skillhub", "type": "base", "name": "公司技能库",
      "baseToken": "bascn_xxx", "table": "技能", "enabled": false,
      "skillSync": {              // 白名单：仅带 skillSync 的源可同步技能
        "nameField": "名称", "contentField": "内容",
        "descriptionField": "描述", "enabledField": "启用",
        "targetDir": "~/.coworker/skills"
      } }
  ]
}
```

### 6.3 policy.json

```jsonc
{
  "rolePolicies": {
    "employee":   { "clusters": ["onboarding", "knowledge"] },
    "admin":      { "clusters": ["onboarding", "permissions", "knowledge", "governance"] }
  },
  "defaultRole": "employee",
  "rules": {
    "minimalScopeLogin": true,
    "requireUserConfirmOnWrite": true,
    "redactSecrets": true,
    "blockDestructiveShell": true,
    "requireRegisteredSource": true
  }
}
```

## 7. 审计

- 所有权限申请、直授、审批发起、知识源访问写入 `~/.coworker/audit.jsonl`（JSON Lines）。
- 审计条目：`ts / user / cluster / action / resource / result / detail`。
- `/coworker:audit` 命令查看本机审计记录。
- 扩展点：`audit.sink` 可配置同步到公司 Base（留接口，后续实现）。

## 8. 关键数据流

### 8.1 登录流（split-flow）

1. `coworker_check_env`：lark-cli 是否安装 / config 是否初始化 / 登录态。
2. 未装 → 引导安装（见 `bin/bootstrap.sh` / README）。
3. 未初始化 → `coworker_config_init` 后台捕获 `verification_url`，展示 URL + 二维码。
4. `coworker_auth_login --scope ...`（`--no-wait --json`）→ 拿到 `verification_url` + `device_code`，生成二维码。
5. **结束本轮**，告知用户完成授权后回来。
6. 用户回复已授权 → `coworker_auth_complete --device-code` 完成登录。
7. `coworker_auth_status --verify` 校验；把 open_id/userName 写入用户配置。

### 8.2 权限申请流

1. `coworker_perm_list`：列出当前角色可见的权限。
2. `coworker_perm_check <id>`：探测当前是否已具备（知识空间可见性 / 文档可读）。
3. `coworker_perm_apply <id>`：按 grant 分派 →
   - `self-service`：dry-run 预览 → 用户确认 → `--yes` 直授 → 审计。
   - `approval`：搜索定义 → 取表单 → 用户确认 → 发起实例 → 返回 instance_code → 审计。
   - `owner-request`：`drive +apply-permission` → 审计。
4. `coworker_perm_status`：按 instance_code 查详情，或列待办/已发起。

### 8.3 知识问答流

1. `coworker_knowledge_search`：按 sourceId（或多源）检索 → 候选 + 标题 + 定位信息。
2. `coworker_knowledge_fetch`：抓取候选完整内容（base 记录 / wiki 节点 / doc 全文）。
3. agent 综合成答案：**附来源**、不编造、越界（非登记源 / 敏感信息）明确拒绝。

## 9. 扩展点与路线图

| 扩展点 | 方式 | 状态 |
|---|---|---|
| 新增权限 | 改 `catalog.json` 加一条记录 | ✅ 已实现 |
| 新增知识源 | 改 `knowledge.json` 加一个 source | ✅ 已实现 |
| 新增集群 | `extensions/clusters/<name>.ts` 注册工具 + 在 `policy.json` 分配角色 | ✅ 已实现 |
| 知识权限盘点 | `coworker_perm_scan`（可见空间+角色+缺口） | ✅ 已实现 |
| 公司技能加载 | 包内 `skills/` + `resources_discover` 动态加载 + `/coworker:skills` | ✅ 已实现 |
| 技能同步 | `skillSync` 白名单源 + `coworker_skill_sync`（dry-run/确认） | ✅ 已实现 |
| 审计同步 | 实现 `audit.sink`（同步公司 Base） | 待实现 |
| lifecycle 集群 | 离职回收、定期复核、到期提醒 | 待实现 |
| 组织策略 | 统一从中心 Base 拉取 catalog/policy（管理员集中维护） | 待实现 |

## 10. 分发与安装

```bash
# 员工机器：
pi install git:github.com/dncore/pi-coworker@v0.1.0
# 或公司 bootstrap 脚本预置（见 bin/bootstrap.sh）
# 更新：
pi update --extensions
# 首次运行引导：
/coworker:setup
```

## 11. 技术约束（lark-cli 封装规则）

- 所有调用走 `execFile("lark-cli", args, ...)`，不经过 shell。
- 一律显式传 `--as`（user/bot），不依赖 profile 默认。
- 读取类命令加 `--format json`（或该命令的 JSON 形态）；解析 JSON 信封用 `ok == true` 判断成功。
- 高风险写操作尊重 exit 10：识别 `confirmation_required` → 用户确认 → 才加 `--yes`。
- 认证/身份/scope 相关一律遵守 lark-shared 规则（split-flow、不缓存 device_code、禁止对 bot 执行 auth login）。
- 路径参数只接受相对路径。
