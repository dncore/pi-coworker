# 飞书交互卡片库（构造器 + 通道 + 动作注册表）

通用能力：**任何 agent 交互需要用户在飞书里响应时，用它造卡片、发出去、收回调**——不写固定模板。

```
extensions/core/cards/
├── builder.ts   构造器：声明式组装 Card 2.0 卡片
├── channel.ts   通道：发卡片（私聊/群/回帖）/ 原地更新 / 发文本
└── registry.ts  动作注册表：按钮回调注册 + 统一分发 + 结果应用
```

> 已按**官方 Card 2.0（schema:"2.0"）**实现并用真实飞书 API 发送验证（v2 与 v1 有差异：无 `action`/`note` 容器、option/placeholder/confirm 文本须为 `{tag,content}` 对象）。

## 构造器用法

```typescript
import { coworkerCard } from "./index.ts";

const card = coworkerCard()
  .header("blue", "🔐 权限申请")
  .md("**研发知识库**（wiki_engineering）\n授予方式：自服务直授")
  .divider()
  .buttons([
    { text: "一键申请", type: "primary", action: "perm_apply", payload: { permissionId: "wiki_engineering" } },
    { text: "查看可申请权限", action: "perm_catalog" },
  ])
  .select("dept", [{ text: "研发", value: "eng" }], { placeholder: "选择部门" })
  .input("remark", { placeholder: "补充说明" })
  .note("由 coworker 生成")
  .build();
```

按钮 `value` 约定：`{ action: "动作名", ...payload }` → 回调时以 `action_value` JSON 字符串送达。

## 通道用法

```typescript
import { createCardChannel } from "./index.ts";

const ch = createCardChannel("bot");       // bot=守护进程 / user=个人 CLI/GUI
await ch.sendToUser(openId, card);         // 私聊
await ch.sendToChat(chatId, card);         // 群聊
await ch.replyToMessage(messageId, card);  // 回帖
await ch.sendText(openId, "文本");
await ch.update(token, newCard);           // 原地更新（token 30min/2次）
```

## 动作注册表用法（回调路由）

```typescript
import { createCardRegistry, createCardChannel } from "./index.ts";

const channel = createCardChannel("bot");
const registry = createCardRegistry(channel, (entry) => audit(entry));

registry.register("perm_apply", async (ctx) => {
  const { openId, action } = ctx.event;          // action.payload...
  const perm = getPermission(action.permissionId ?? "");
  // ...执行业务（如直授）
  return { update: permApplyCard(perm, "done") }; // 用 token 更新原卡片
  // 或 return { reply: "文本" } / { send: { to: "user", target, card } } / {}  // 无动作
});

// 收到 card.action.trigger 时：
await registry.dispatch({
  operatorId, action: parseActionValue(raw), token, messageId, chatId, formValue,
});
```

未注册的动作 → `{ handled:false }`，可回默认提示；所有回调自动审计。

## 已验证元素（真实发送通过）

| 元素 | 构造器 API | 说明 |
|---|---|---|
| 头部 | `.header(template, title, {emoji})` | 12 种模板色 |
| 段落 | `.md()` / `.text()` / `.markdown()` | lark_md 富文本 |
| 分割线 | `.divider()` | |
| 按钮（含 confirm 确认弹窗） | `.buttons([...])` / `button()` | 多按钮自动 column_set 并排 |
| 下拉单选 | `.select(name, options, opts)` | option 文本为对象 |
| 输入框 | `.input(name, opts)` | placeholder 为对象 |
| 折叠菜单 | `.overflow(options)` | |
| **表单容器** | `.form(name, elements)` | 批量录入一次提交 |
| **分栏容器** | `.columnSet(columns, opts)` | v2 用 `columns` 字段 |

**表单提交**：表单内按钮用 `formActionType: "submit"`（或 `"reset"`），回调以 `card.action.trigger` 的 `form_value`（按组件 name 映射）送达；表单内所有交互组件必须填唯一 `name`。

```typescript
.form("perm_form", [
  select("perm_select", [{ text: "研发知识库", value: "wiki_engineering" }], { required: true }),
  input("reason", { placeholder: "申请理由", required: true }),
  button({ text: "提交", type: "primary", formActionType: "submit", name: "submit_btn", value: { action: "perm_request" } }),
])
// 回调：ctx.event.formValue = { perm_select, reason }
```

## v2 踩坑记录（已修）

1. v2 **无 `action` 容器** → 按钮用 `column_set`（`columns` 字段）并排
2. v2 **无 `note` 组件** → 降级为 markdown 块
3. select/overflow 的 `options[].text`、input/select 的 `placeholder`、button 的 `confirm.text` 必须是 `{ tag:"plain_text", content }` 对象
4. form 的提交按钮必须 `form_action_type:"submit"`（否则报 no submit button）
