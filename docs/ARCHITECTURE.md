# 架构设计 · Agent 工作边界与飞书交互能力层

> 本文档回答两个核心设计问题：**agent 能干什么、不能干什么（工作边界）**，以及 **agent 如何与用户在飞书里交互（交互能力层）**。配套实现见 `DESIGN.md`（总体）与各模块。

## 一、Agent 工作边界（7 层防御，从外到内）

```
┌──────────────────────────────────────────────────────────────┐
│ ① 模式边界                                                      │
│    RUN_MODE=local  ：本机 · 用户身份 · 全 teamset 工具（可开本地） │
│    RUN_MODE=server ：服务器 · bot 身份 · 只读子集                │
├──────────────────────────────────────────────────────────────┤
│ ② 工具白名单（fail-fast，非法拒绝启动）                          │
│    server：禁 bash/read/write/edit/grep/find/ls + 授权写工具     │
│            （perm_apply / skill_sync / 登录类）；只留 6 只读      │
│    local ：禁 skill_sync；其余 teamset + 可选本地工具            │
│            （LOCAL_ENABLE_SHELL=1 才开 bash/write）             │
├──────────────────────────────────────────────────────────────┤
│ ③ 目录白名单                                                    │
│    权限申请只用 catalog.json 登记 id · 知识检索只用              │
│    knowledge.json 登记源 · 技能同步只用 skillSync 源             │
├──────────────────────────────────────────────────────────────┤
│ ④ 运行时强制（最硬的一层）                                       │
│    pi --no-builtin-tools --tools <白名单>                       │
│    → server 模式 agent 物理上没有 bash/write 等本地工具          │
├──────────────────────────────────────────────────────────────┤
│ ⑤ 治理钩子（governance 集群）                                   │
│    tool_call：拦截破坏性 shell（rm -rf/dd/mkfs/curl|sh…）、      │
│               阻塞式 auth login；tool_result：密钥脱敏；         │
│               before_agent_start：系统提示注入企业规则            │
├──────────────────────────────────────────────────────────────┤
│ ⑥ 角色与写确认（policy + safety）                               │
│    rolePolicies：角色→可用集群门禁（requireCluster）             │
│    写操作 confirmWrite：无交互环境 fail-closed（须显式 confirm）  │
├──────────────────────────────────────────────────────────────┤
│ ⑦ 身份 / 会话 / 审计                                            │
│    不静默切换 --as（权限错误如实报告）；每用户独立 pi 会话；       │
│    ~/.coworker/audit.jsonl 全量审计（可查/可回溯）               │
└──────────────────────────────────────────────────────────────┘
```

**设计要点**：
- 边界在**进程参数层**物理掐死（④），不是只靠提示词——这是与其他 agent 系统最大的差异。
- 模式（①）决定身份与工具集；同一份守护程序代码，`RUN_MODE` 切换部署形态。
- 白名单（②③）是「配置即边界」：加权限/加知识源/加角色 = 改配置，不改代码。

## 二、飞书交互能力层（从底到顶）

```
┌──────────────────────────────────────────────────────────────┐
│ ⑥ 意图路由（agent/src/bot/handler.ts）                        │
│    快捷意图（申请X权限/查看权限/入职）→ 直接发卡片（快且确定，   │
│    不耗 agent）；其余 → agent 问答（按模式提示词）               │
├──────────────────────────────────────────────────────────────┤
│ ⑤ 事件接入（agent/src/bot/consume.ts）                        │
│    lark-cli event consume：im.message.receive_v1 +             │
│    card.action.trigger（ready 标记 + NDJSON 流 + stdin EOF 退订）│
├──────────────────────────────────────────────────────────────┤
│ ④ 动作注册表（core/cards/registry.ts）                         │
│    任何模块 register(action, handler)；dispatch 统一应用结果：   │
│    reply（发文本）/ update（token 原地更新卡片）/ send（新卡片） │
│    回调路由：value.action 优先；纯表单提交按 submit 按钮 name     │
├──────────────────────────────────────────────────────────────┤
│ ③ 卡片构造器（core/cards/builder.ts）                          │
│    通用 Card 2.0：header/md/text/markdown/hr/note/img/         │
│    buttons/select/input/form/columnSet/overflow               │
│    （v2 差异已收口：无 action/note 容器、文本对象化、             │
│      form_action_type:submit、columns 字段——全部真实验证）     │
├──────────────────────────────────────────────────────────────┤
│ ② 交互通道（core/cards/channel.ts）                            │
│    sendToUser / sendToChat / replyToMessage / sendText /      │
│    update（token 30min/2次原地更新）· bot/user 身份可选         │
├──────────────────────────────────────────────────────────────┤
│ ① lark-cli 封装（core/lark.ts）                               │
│    execFile 参数数组（无 shell 注入）· JSON 信封（ok==true、     │
│    exit10 confirmation）· 密钥脱敏 · --as 身份注入 ·            │
│    server 模式 → TEAMSET_SERVER_MODE=1（知识工具 bot 身份）    │
└──────────────────────────────────────────────────────────────┘
```

**设计要点**：
- 交互层是「**通道 + 构造器 + 注册表**」的通用抽象，**不是固定模板**：任何 agent 行为要用户响应，都走同一条链路。
- 构造器按官方 Card 2.0 实现并经真实飞书 API 逐元素验证；v2 与 v1 的差异全部收口在库内，业务侧无感知。
- 已内置示例动作：`perm_apply / perm_catalog / perm_refresh / perm_request / perm_form / onboard_done / contact_it`。

## 三、边界与交互的衔接点

| 场景 | 边界如何生效 |
|---|---|
| 用户点「一键申请」 | 卡片回调 → 注册表 → **bot 直授**（守护进程自己的代码路径，不经 agent 工具，白名单只管 agent） |
| agent 收到「帮我执行命令」 | server 物理无 bash 工具 → 拒绝；local 默认也禁，需 `LOCAL_ENABLE_SHELL=1` |
| 非本人私聊/群里 @（local） | `enforceLocalOwner`：只处理 p2p 且 sender==owner，否则忽略（防信息泄露） |
| 纯表单提交（submit 无 value） | 按 submit 按钮 `name` 路由到注册表（约定：按钮 name = 动作名） |
| 卡片回调可信性 | 事件走平台 websocket 长连接（应用级鉴权）；Bot「仅本人可用」控制台设置 + local 模式 owner 校验 |

## 四、两个缺口的处置（已补）

| 缺口 | 处置 |
|---|---|
| local 模式「仅本人可用」仅靠控制台设置 | 守护进程新增 `enforceLocalOwner`：local 模式只处理 p2p 且 sender == 本机用户 open_id（`auth status` 解析，缓存 1min），否则忽略并审计 |
| 纯表单提交的路由未定义 | 新增约定：submit 按钮 `name` = 动作名，无 value；回调按 `action_name` 路由，`form_value` 携带数据。演示卡 `permRequestCard` 已改为该写法 |

## 五、设计一致性检查

- 边界与交互不冲突：**bot 直授**（通道层能力）与 **agent 白名单**（边界层）分离——直授是守护进程写死的代码路径，agent 永远拿不到写工具。
- 配置即边界：catalog/knowledge/policy 三个配置 = 权限/知识/角色的唯一事实来源，三种模式（CLI/GUI/Bot）共用。
- 审计贯穿：卡片回调、权限动作、拦截事件全部落 `~/.coworker/audit.jsonl`。
