# pi-coworker-agent · Bot Agent 守护程序

在**飞书里**和用户交互的常驻 agent。同一份代码两种运行模式：

| 模式（`RUN_MODE`） | 位置 | 身份 | 工具集 | 典型场景 |
|---|---|---|---|---|
| **local**（默认） | 个人本机 | lark-cli **用户**（个人 Bot 应用收发） | 全 coworker 工具，可开本地工具 | 个人助手：问答/权限/入职，数据在本地 |
| **server** | 公司服务器 | **bot** 身份 | 只读子集（禁本地/写工具） | 全员共享知识机器人（7×24） |

```
用户（飞书）←→ 个人/公司 Bot 应用
                    ↕ lark-cli event consume（消息/卡片回调）
              ┌──────────────┐
              │ 本守护程序      │
              │  ├ 安全网关(限流/审计/白名单) │
              │  ├ 意图路由（申请/权限/入职 → 卡片）│
              │  └ pi --mode rpc agent 池（按模式限定工具）│
              └──────────────┘
```

## 为什么是 local 模式（推荐）

- **交互全在飞书**：用户私聊/群@自己的 Bot，无需装客户端、无需服务器。
- **数据在本地**：agent 跑在本机，用**用户自己的 lark-cli 身份 + 自己的 LLM provider**，个人上下文（我的权限/我的文档）直接可用。
- **本机即工作目录**：可做本地文件/命令操作（需 `LOCAL_ENABLE_SHELL=1`，默认关）。
- **零服务器成本**：不像公司共享机器人需要 7×24 服务器；代价是**本机要开机、守护进程要运行**。

## 快速开始（local 模式）

```bash
# 1) 配置个人 Bot 应用（首次）
lark-cli config init --new      # 创建/绑定你的个人飞书应用（Bot）
lark-cli auth login --domain wiki,drive,base,docs --no-wait   # 用户身份授权（split-flow）

# 2) 启动守护程序
RUN_MODE=local node src/index.ts
```

在飞书里私聊你的 Bot 应用即可：问问题、申请权限、点卡片按钮。

## server 模式（公司共享机器人）

```bash
RUN_MODE=server TOOL_ALLOWLIST=... node src/index.ts
```

- 只读工具子集 + 白名单 fail-fast；bot 身份；限流/审计。
- 需公司 Bot 应用 + 事件订阅（im.message.receive_v1 / card.action.trigger）开通。

## 目录

```
src/
├── index.ts          # 入口（RUN_MODE 切换 + 白名单校验 + 事件订阅）
├── config.ts         # 环境配置（按模式默认）
├── mode.ts           # 两种模式：工具集 / 身份 / 提示词
├── agent/            # pi --mode rpc 池（rpc.ts / pool.ts）
├── bot/              # 事件消费(consume) / 路由(handler) / 回复(reply)
├── cards/            # 交互卡片（build / handle）
└── security/         # 白名单校验(allowlist) / 限流审计(gateway)
```

## 守护进程管理

```bash
npm run daemon -- start             # 后台启动（pid+日志在 ~/.coworker/）
npm run daemon -- status            # 运行状态 + 事件总线
npm run daemon -- stop / restart
npm run daemon -- logs --tail 50
npm run daemon -- install --autostart   # 开机自启（macOS LaunchAgent / Windows 任务计划 / Linux systemd）
npm run daemon -- uninstall
```

## 自测

```bash
node scripts/self-test.ts                 # RPC 握手
node scripts/self-test.ts --prompt "你好"  # 真实 ask
node scripts/card-test.ts <open_id>        # 发送测试卡片
```
