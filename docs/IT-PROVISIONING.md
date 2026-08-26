# IT 代建个人 Bot 指南（A2 路径）

> 场景：**非开发者员工无法或不便自助创建个人 Bot 应用**（A1 自助引导走不通时），由 IT 集中代建，员工只做「粘贴物料激活」。

本指南对应 `DESIGN-LOCAL.md` §3.1 的 **A2 路径**，激活工具为 `coworker_bot_activate`（或 GUI 安装向导）。

## 1. 为什么需要代建

飞书开放平台**不支持通过 OpenAPI 全自动创建应用**，「应用创建 + 机器人能力 + 事件订阅」必须在开发者后台（或 `lark-cli config init --new` 的浏览器流程）完成。对不会碰控制台/终端的员工，这一步由 IT 代劳最省事。

## 2. IT 侧：为每位员工创建个人 Bot 应用

每个员工一个**个人应用**（防止他人触达员工本机 agent）。两种方式任选：

### 方式 A：`lark-cli config init --new`（批量半自动）

在**员工本人的机器**上（或 IT 用员工授权后）执行：

```bash
lark-cli config init --new
```

浏览器完成应用创建后，记录物料的两个字段：

| 物料 | 说明 | 示例 |
|---|---|---|
| `app_id` | 应用唯一 ID | `cli_xxxxxxxx` |
| `app_secret` | 应用密钥（**机密**） | 32 位字符串 |

### 方式 B：开发者后台手动创建

1. 开放平台 → 创建企业自建应用（名称建议含员工姓名，如「张三的助手」）；
2. 应用能力 → 添加「机器人」；
3. 事件与回调 → 事件订阅 → 添加事件：`im.message.receive_v1`、`card.action.trigger`（订阅方式选**长连接**，本机无需公网回调地址）；
4. 版本管理与发布 → 创建版本并发布（个人自用：创建版本即可）；
5. 记录 `app_id` / `app_secret`。

## 3. 物料发放（安全要求）

- `app_secret` 是**机密**：走密码保险箱 / 加密文档，**不得经过明文 IM、邮件、代码仓库**；
- 员工激活完成后，建议提示其不要转发 app_secret；离职时在开放平台**停用/删除**该应用（回收）。

## 4. 员工侧：激活（两种入口）

员工拿到物料后：

**入口一：CLI（pi 内）**

```
请激活我的个人 Bot：app_id=cli_xxx，app_secret=xxx
```

agent 调用 `coworker_bot_activate`（写前确认）→ `lark-cli config init --app-id <id> --app-secret-stdin` 绑定 → 校验 `config show` 返回同一 app_id。

**入口二：GUI 安装向导**

向导「开通个人 Bot」步骤提供「粘贴 IT 发放的应用物料」输入框（后端走同一绑定逻辑）。

激活后仍需完成：`coworker_bot_setup`（verify=true）验证事件链路 → 启动守护进程（`coworker_daemon start` / `install --autostart`）。

## 5. 与 A1 的切换策略

| 条件 | 路径 |
|---|---|
| 员工可扫码/照图操作 | A1 自助引导（`coworker_bot_setup`） |
| 员工无法/不便操作控制台 | **A2 IT 代建（本指南）** |

建议先上 A1，统计「卡在控制台三件事」的反馈量；若占比高，切 A2（IT 每周批量代建 + 发放）。
