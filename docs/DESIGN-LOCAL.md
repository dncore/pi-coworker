# pi-coworker 纯本机 Agent 形态设计（DESIGN-LOCAL）

- 版本：0.1.0
- 状态：设计中，部分已实现（magene 鉴权同步）
- 关联：[DESIGN.md](./DESIGN.md)（通用内核）· [INTERACTION.md](./INTERACTION.md)（交互渠道）· [PRODUCT-PLAN.md](./PRODUCT-PLAN.md)（三层形态）

## 1. 定位

**每名员工本机跑一个 agent，用户在飞书私聊「自己的个人 Bot」完成工作**：企业问答、权限申请、入职引导、本地文档处理。模型走**公司统一 LLM 网关**（本文称 magene provider），员工零配置 API 平台、成本可归属、审计可到人。

本形态与 DESIGN.md 的关系：

| 维度 | DESIGN.md（内核） | DESIGN-LOCAL（本文） |
|---|---|---|
| 部署 | local / server 双模式 | **只保留员工本机（local）** |
| 共享知识机器人（server） | 补充模式 | 不作为主路径（可后续单独部署） |
| LLM 接入 | 用户自带 provider | **公司 magene 网关（同步自 magene-provider 插件）** |
| 桌面 GUI | 可选托盘 | **标配壳**（托盘状态 + 引导 + 重连） |

## 2. 目标拓扑（单员工视角）

```
员工本机
┌──────────────────────────────────────────────┐
│ 桌面助手 App（非开发者唯一入口）                 │
│  ├─ 安装器：打包 Node+lark-cli+pi+coworker     │
│  ├─ 开机自启 + 崩溃重启（launchd/systemd）      │
│  ├─ 引导流：扫码飞书 → 建/绑个人 Bot → 配 magene│
│  ├─ 托盘状态：运行中/离线/网关异常 + [重连]       │
│  └─ 更新器：查内网更新源 → 卡片通知重启           │
│                                              │
│  Bot Agent 守护进程（agent/ RUN_MODE=local）    │
│  ├─ lark-cli event consume（个人 Bot）        │ ← WebSocket 长连接，无需公网
│  ├─ pi --mode rpc（coworker + 只读本地工具）    │
│  ├─ 身份：员工自己的 lark-cli（user）           │
│  ├─ LLM：magene 网关（Bearer API Key，0600）    │
│  └─ 安全：仅本人校验 / 写确认 / 审计 / 限流       │
└──────────────────────────────────────────────┘
        ↑ 私聊「自己的 Bot」（手机/桌面飞书）
        员工
```

## 3. 三个规模化问题与对策

纯本机 = N 台机器。三个问题必须正面解决：

### 3.1 个人 Bot 应用怎么来（最大卡点）

**现实约束**：飞书开放平台不支持全自动 API 创建应用；`lark-cli config init --new` 为浏览器阻塞式流程；「机器人能力 + 两个事件（`im.message.receive_v1` / `card.action.trigger`）」须在控制台勾选。

| 路径 | 做法 | 员工感知 |
|---|---|---|
| **A1 自助引导（起步）** | 桌面助手内嵌引导流：点「创建我的 Bot」→ 打开控制台照图点 5 步 → 自动验证（`coworker_bot_setup` verify） | 扫码 + 照图点 5 步 |
| **A2 IT 代建（兜底）** | IT 用员工身份代建、启用后发放 app_id 物料，员工粘贴激活 | 粘贴 app_id |

### 3.2 环境怎么装/更

- **一键安装包**：dmg/msi 打包 Node 运行时 + lark-cli + pi + coworker + 守护进程；安装即注册开机自启与崩溃重启 → 员工**双击安装、永不再碰终端**。
- **自更新**：守护进程定时查公司内网更新源（静态文件），新版本 → 飞书卡片通知 → 一键重启；`pi update --extensions` 藏进更新器。
- **托盘必须保留**：非开发者需要「我的助手还在吗」的可视反馈 + 重连按钮。

### 3.3 故障怎么发现

- **本机自检**：事件订阅在线 / 登录态有效 / 网关可达 / 磁盘空间 → 异常主动发状态卡片「助手离线，点此重连」。
- **可选轻心跳**：每分钟向公司一个极简端点上报 `{open_id, 在线状态}`（**不传任何对话内容**），供 IT 看谁掉线。可砍（纯本机），但掉线排查只能靠员工自觉。

## 4. 模型网关鉴权（magene provider）

> 能力**同步自公司内部 magene-provider 插件**的「鉴权生成」部分，开源化落地。分析结论：网关当前为**静态 API Key + Bearer** 鉴权（非 OAuth 换发），因此第一版同步「凭证直配 + 验证 + 注册」，把「open_id 换 token」留作扩展点（见 4.6）。

### 4.1 同步的能力清单

| 能力 | 来源实现 | 本包落地 |
|---|---|---|
| provider 注册 | `pi.registerProvider("magene", {api:"openai-completions", authHeader:true, models})` | `extensions/core/magene.ts` `registerMageneProvider` |
| 凭证文件 | `~/.pi/agent/extensions/magene-provider/.env`（`MAGENE_BASE_URL` / `MAGENE_API_KEY`） | 同路径共用（两扩展共存不冲突），0600 |
| 配置优先级 | 环境变量 > .env 文件 > 内置默认 | `resolveMageneConfig` |
| 模型发现 | `GET {baseUrl}/models`（Bearer） | `fetchMageneModels` |
| 模型元数据 | override > 内置已知表 > 推断 > 默认 | `resolveModelMeta` / `buildResolvedModels`（含 deepseek/qwen 方言 compat） |
| 验证 | 写前连通性检查、注册后 /models 复核 | `coworker_magene_setup` 先验证后落盘 |

### 4.2 配置模型

```
环境变量 MAGENE_BASE_URL / MAGENE_API_KEY   （部署方集中注入，最高优先）
   ↓ 未设置时回退
~/.pi/agent/extensions/magene-provider/.env  （coworker_magene_setup 写入，0600）
   ↓ 未设置时回退
内置占位符 https://<your-magene-gateway>/api/v1（提示配置，不参与注册）
```

**脱敏约束**：默认地址为占位符，本包不硬编码任何公司内网地址；公司专属模型清单 / 配置下发地址均不内置。

### 4.3 provider 注册（守护进程自动生效）

- 扩展加载时（含 Bot Agent 的 `pi --mode rpc` 子进程）非阻塞后台注册：凭证已配置则拉取 `/models` 并 `registerProvider("magene", …)`；网关不可达保持未注册、不阻塞启动。
- 模型定义带 `contextWindow` / `maxTokens` / `reasoning` / `compat`（deepseek：`thinkingFormat:"deepseek"`、`requiresReasoningContentOnAssistantMessages`；qwen：`thinkingFormat:"qwen"`）。
- 会话中 `/reload` 后可直接用 `magene/<模型ID>`。

### 4.4 工具

| 工具 | 行为 |
|---|---|
| `coworker_magene_setup` | 配置/更新网关凭证：`baseUrl`（预填已有值）+ `apiKey` → **写前确认**（展示脱敏 Key）→ 先验证 `/models` 连通 → 落盘 0600 → 注册 provider → 审计。Key 或 Base URL 缺失/占位符时明确报错引导 |
| `coworker_magene_status` | 诊断：Base URL 与来源（env/file/占位符）、API Key 是否配置、凭证文件、provider 注册状态、网关连通性（不含密钥明文） |

`coworker_setup_status` 状态机新增 **s7 模型接入（magene）**：`apiKeyConfigured && baseUrlSource !== "default"` 视为完成；未配置可跳过（提示 `coworker_magene_setup` 或配置环境变量）。

### 4.5 安全

- 凭证文件 0600；工具输出与确认框只展示 `maskKey`（首4…尾4）；日志不落明文。
- 写前确认走统一 `confirmWrite` 门禁；审计记录 `{cluster:"onboarding", action:"magene_setup", …}`。
- 凭据**不进代码库、不进 `.env.example`**（那里只有 `LLM_PROVIDER` 开关）。

### 4.6 扩展点（不臆造，留给公司网关演进）

1. **open_id 换 token**：若网关后续提供 OAuth/身份换发接口，按 pi 的 OAuth provider 形态接入（`oauth.login/refreshToken/getApiKey`，`/login magene`），替换静态 Key 直配。
2. **远端模型配置下发**：可选的模型元数据集中下发服务（版本比对 + 本地缓存），默认关闭；本包仅保留 `MAGENE_*` 环境变量约定。
3. **配额/成本归属**：网关侧按员工 open_id 映射配额与计费（本包不实现，属网关职责）。

## 5. 安全边界（本机形态四道）

1. **仅本人可用**：bot 事件校验 `sender.open_id == 绑定 open_id`（`handler.ts` owner check），默认强制。
2. **本地能力分级**：coworker 工具 + **只读本地工具默认开**（读文件/目录——本地文档问答是本形态核心价值）；`LOCAL_ENABLE_SHELL=1` 才开 bash/write/edit。
3. **写操作确认**：lark-cli 高风险写（exit 10）绝不自动 `--yes`；凭证写入走 `confirmWrite`。
4. **全量审计**：`~/.coworker/audit.jsonl`（`/coworker:audit` 查看）。

## 6. 员工旅程（目标：拿到电脑到能用 < 10 分钟）

```
双击安装（2min）→ 打开助手 → 扫码飞书（1min）
→ 引导创建个人 Bot（A1，照图点 5 步，5min）
→ 配置 magene 网关（粘贴公司发放的 Base URL + API Key，1min）
→ 完成
日常：飞书私聊自己的 Bot——问答 / 申请权限 / 入职 / 读本地文档
掉线：守护进程自检 → 状态卡片「助手离线，点此重连」→ 一键恢复
```

## 7. 最小公司侧组件（基础设施，非 agent 服务）

1. **安装包 / 更新源**：内网静态文件（含 bootstrap 产物）。
2. **magene 网关**：公司 LLM 基础设施；员工凭证发放（管理员/自助）。
3. **可选轻心跳端点**：极简状态收集（open_id + 在线），不存对话。

## 8. 决策默认值

| 决策 | 默认 |
|---|---|
| 个人 Bot 发放 | A1 自助引导起步，A2 IT 代建兜底 |
| 本地只读工具 | 默认开（本形态核心价值） |
| magene 鉴权 | 静态 API Key 直配（4.6 扩展点演进） |
| 轻心跳 | 建议保留（可选砍掉） |
| 桌面托盘 | 标配（从可选项升回） |

## 9. 落地状态

| 项 | 状态 |
|---|---|
| magene 鉴权同步（`extensions/core/magene.ts` + `coworker_magene_setup/status` + setup s7 + 冒烟测试 `scripts/magene-smoke.ts`） | ✅ 已实现 |
| 开源脱敏（无内网地址/密钥/真实资源 ID，git 历史干净；`package-lock` 包名、`ARCHITECTURE.md` 旧名已清理） | ✅ 已处理 |
| 个人 Bot IT 代建（A2）：`coworker_bot_activate`（app_id/app_secret 粘贴绑定 + 写前确认）+ [IT 代建指南](./IT-PROVISIONING.md) | ✅ 已实现 |
| 轻心跳：`agent/src/heartbeat.ts`（`HEARTBEAT_URL` 可选，默认关；仅上报 openId/status/ts）+ GUI 后端 `/magene/*`、`/daemon/install` 端点 | ✅ 已实现 |
| GUI 安装向导（含模型网关步骤 + 配置开机自启按钮） | ✅ 已补齐 |
| 桌面托盘（Tauri：打开/启动/停止/退出） | ✅ 已有 |
| 自更新检查（可选 `UPDATE_URL`：`agent/src/update.ts` + daemon `check-update` + 新版通知绑定用户 + `scripts/update/version.sample.json`） | ✅ 已实现 |
| 离线打包（`scripts/package.sh` 产出 tarball）+ bootstrap 一键安装（自启+启动+指引） | ✅ 已实现 |
| 发布手册（`RELEASE.md`：版本/打包/更新源/分发） | ✅ 已实现 |
| GitHub Actions 流水线（`.github/workflows/`：`ci.yml` 测试+脱敏门禁；`release.yml` tag 触发 → 核心包+macOS/Windows GUI → Release + 自动更新源 `version.json`） | ✅ 已实现 |
| 一键安装包（dmg/msi 正式签名 + GUI 更新通道） | 待定（`cargo tauri build` 可产包；签名/公证/更新通道见 `gui/DISTRIBUTION.md` 与 `RELEASE.md`） |
