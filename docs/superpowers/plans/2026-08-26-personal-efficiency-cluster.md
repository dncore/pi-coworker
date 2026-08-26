# 个人效率集群（coworker_personal）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 personal 工作集群，12 个 coworker_* 工具覆盖日历/待办/妙记/邮件/通讯录，员工对话即可查自己的日程、任务、纪要、邮件、同事，写操作（建日程/任务/发邮件）经确认+审计。

**Architecture:** 与其他集群同构——`extensions/clusters/personal.ts` 用 `pi.registerTool` 注册工具，全部复用 `core/lark.ts` 的 `runLark`（自动 `--as user`、脱敏、exit10 门禁）、`core/safety.ts` 的 `requireCluster`/`confirmWrite`、`core/config.ts` 的 `appendAudit`。接线：`extensions/index.ts` 注册、`config/policy.json` 角色集群白名单、GUI `GUI_TOOLS` 白名单、`/coworker:today` 命令。

**Tech Stack:** TypeScript（node 22 type-stripping / jiti）、typebox（工具参数 schema）、lark-cli 1.0.74（calendar/task/minutes/mail/contact 域 +shortcut）。

## Global Constraints

- 全部 `--as user`；禁止 bot 身份执行本集群工具（治理规则拦截）。
- 写操作一律 `confirmWrite`（`explicitConfirm: params.confirm`）+ `appendAudit`；lark-cli exit 10 绝不自动 `--yes`。
- 邮件/妙记正文脱敏 + 截断（14k 字符）。
- 审计日志不记录邮件正文/妙记全文。
- 工具输出统一 `okResult(text, details)` / `errResult(text, details)`。
- 集群门禁：`requireCluster("personal")`，policy.json 各角色 clusters 需含 `"personal"`。
- 界面无 emoji（现有 clean 规则），工具返回文本不引入 emoji。

---

### Task 1: 集群骨架 + 日历域（schedule_today / schedule_query / schedule_create）

**Files:**
- Create: `extensions/clusters/personal.ts`

**Interfaces:**
- Produces: `registerPersonal(pi: ExtensionAPI): void`（Task 6 在 index.ts 调用）
- 工具：`coworker_schedule_today`、`coworker_schedule_query`、`coworker_schedule_create`

- [ ] **Step 1: 建文件并实现骨架 + 日历 3 工具**

```ts
/**
 * personal 工作集群（spec: docs/superpowers/specs/2026-08-26-personal-efficiency-cluster-design.md）
 * 员工个人效率：日历 / 待办 / 妙记 / 邮件 / 通讯录。全部 --as user；写操作确认 + 审计。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runLark, describeLarkError } from "../core/lark.ts";
import { requireCluster, confirmWrite } from "../core/safety.ts";
import { okResult, errResult } from "../core/tools.ts";
import { appendAudit } from "../core/config.ts";

const MAX_TEXT = 14_000;
function truncate(text: string, max = MAX_TEXT): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n…（内容过长已截断，共 ${text.length} 字符）`;
}
function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").trim();
}
function txt(v: unknown): string {
  return stripHtml(String(v ?? ""));
}

interface ToolCtx {
  hasUI?: boolean;
  ui?: { confirm(title: string, message: string): Promise<boolean> };
  notify?(title: string, kind?: string): void;
}

/** 将 {start_time,end_time,summary,attendees} 风格条目格式化为日程行 */
function fmtEvent(e: Record<string, any>): string {
  const st = txt(e.start_time ?? e.start_time_ts ?? "");
  const en = txt(e.end_time ?? e.end_time_ts ?? "");
  const sum = txt(e.summary ?? e.title ?? "（无标题）");
  const loc = txt(e.location ?? e.vchat ?? "");
  const who = Array.isArray(e.attendees) && e.attendees.length
    ? " · " + e.attendees.slice(0, 5).map((a: any) => txt(a.name ?? a.user_id ?? "")).join("、")
    : "";
  return `- ${st} ~ ${en} ${sum}${loc ? " @" + loc : ""}${who}`;
}

export function registerPersonal(pi: ExtensionAPI): void {
  // ---------------- 日历：今日 ----------------
  pi.registerTool({
    name: "coworker_schedule_today",
    label: "Coworker 今日日程",
    description:
      "查看今天（或指定日期）的日程安排：时间、标题、地点、参会人。用于回答「我今天有什么会」「今天安排」。",
    parameters: Type.Object({
      date: Type.Optional(Type.String({ description: "日期 YYYY-MM-DD（默认今天）" })),
    }),
    async execute(_id, params) {
      const gate = requireCluster("personal");
      if (gate) return errResult(gate);
      const r = await runLark(
        params.date ? ["calendar", "+agenda", "--date", String(params.date)] : ["calendar", "+agenda"],
        { as: "user", timeoutMs: 45_000 },
      );
      if (!r.ok) return errResult(describeLarkError(r));
      const items: any[] = r.envelope?.data?.items ?? r.envelope?.data?.events ?? [];
      if (!items.length) return okResult(`今天暂无日程。`, { count: 0 });
      return okResult(`今日日程（${items.length}）：\n` + items.map(fmtEvent).join("\n"), { count: items.length });
    },
  });

  // ---------------- 日历：查询 ----------------
  pi.registerTool({
    name: "coworker_schedule_query",
    label: "Coworker 日程查询",
    description:
      "按时间范围或关键词查询日程。用于回答「下周有什么安排」「最近和 XXX 的会」。",
    parameters: Type.Object({
      keyword: Type.Optional(Type.String({ description: "标题/参会人关键词（≤30 字）" })),
      start: Type.Optional(Type.String({ description: "起始日期 YYYY-MM-DD（默认今天）" })),
      end: Type.Optional(Type.String({ description: "结束日期 YYYY-MM-DD（默认 7 天后）" })),
    }),
    async execute(_id, params) {
      const gate = requireCluster("personal");
      if (gate) return errResult(gate);
      const args = ["calendar", "+search-event"];
      if (params.keyword) args.push("--query", String(params.keyword).slice(0, 30));
      if (params.start) args.push("--start", String(params.start));
      if (params.end) args.push("--end", String(params.end));
      const r = await runLark(args, { as: "user", timeoutMs: 45_000 });
      if (!r.ok) return errResult(describeLarkError(r));
      const items: any[] = r.envelope?.data?.items ?? r.envelope?.data?.events ?? [];
      if (!items.length) return okResult("未找到符合条件的日程。", { count: 0 });
      return okResult(`日程（${items.length}）：\n` + items.map(fmtEvent).join("\n"), { count: items.length });
    },
  });

  // ---------------- 日历：创建（写，需确认） ----------------
  pi.registerTool({
    name: "coworker_schedule_create",
    label: "Coworker 创建日程",
    description:
      "创建日历日程（可带参会人/会议室/描述）。写操作：创建前会展示预览并请用户确认。",
    parameters: Type.Object({
      title: Type.String({ description: "日程标题（≤60 字）" }),
      start: Type.String({ description: "开始时间 ISO 8601，如 2026-08-26T14:00+08:00" }),
      end: Type.String({ description: "结束时间 ISO 8601" }),
      attendeeIds: Type.Optional(Type.Array(Type.String({ description: "参会人 open_id（ou_xxx）" }))),
      description: Type.Optional(Type.String({ description: "日程备注" })),
      confirm: Type.Optional(Type.Boolean({ description: "非交互模式显式确认（管理员脚本用）" })),
    }),
    async execute(_id, params, _sig, _onUpdate, ctx: ToolCtx) {
      const gate = requireCluster("personal");
      if (gate) return errResult(gate);
      const title = String(params.title ?? "").trim().slice(0, 60);
      if (!title) return errResult("title 不能为空。");
      if (!params.start || !params.end) return errResult("需要 start 与 end。");

      const preview = `将创建日程「${title}」\n${params.start} ~ ${params.end}` +
        (params.attendeeIds?.length ? `\n参会人：${params.attendeeIds.length} 人` : "") +
        (params.description ? `\n备注：${truncate(String(params.description), 200)}` : "");
      const confirm = await confirmWrite(ctx, { title: "创建日程", message: preview, explicitConfirm: params.confirm });
      if (!confirm.ok) return errResult(`已取消：${confirm.reason ?? "用户未确认"}`, { blocked: true });

      const argv = ["calendar", "+create", "--summary", title, "--start", String(params.start), "--end", String(params.end)];
      if (params.attendeeIds?.length) argv.push("--attendee-ids", params.attendeeIds.join(","));
      if (params.description) argv.push("--description", String(params.description).slice(0, 2000));
      const r = await runLark(argv, { as: "user", timeoutMs: 60_000 });
      if (!r.ok) return errResult(describeLarkError(r));
      appendAudit({ cluster: "personal", action: "schedule_create", resource: title, result: "ok" });
      const ev = r.envelope?.data?.event ?? r.envelope?.data ?? {};
      return okResult(`已创建日程「${title}」（${params.start} ~ ${params.end}）`, { eventId: ev.event_id ?? ev.id ?? "" });
    },
  });
}
```

- [ ] **Step 2: 注册冒烟（临时在 index.ts 挂载前先单测加载）**

Run:
```bash
cd /Users/nuc8i7beh/magene/pi-coworker && node --experimental-strip-types -e "
import('./extensions/clusters/personal.ts').then(async m => {
  const tools=[]; const pi={registerTool(d){tools.push(d.name); handlers[d.name]=d.execute}, registerCommand(){}, on(){}, sendUserMessage(){} };
  const handlers={}; m.registerPersonal({ registerTool(d){tools.push(d.name); handlers[d.name]=d.execute}, registerCommand(){}, on(){}, sendUserMessage(){} });
  console.log('registered:', tools.join(', '));
  // 真数据冒烟：今日日程
  const ctx={hasUI:false};
  const r1 = await handlers.coworker_schedule_today(undefined, {}, undefined, undefined, ctx);
  console.log('today =>', JSON.stringify(r1.details), r1.content[0].text.slice(0,120));
}).catch(e=>{console.error(e); process.exit(1)})"
```
Expected: `registered: coworker_schedule_today, coworker_schedule_query, coworker_schedule_create`，today 返回真实日程或"今天暂无日程"。

- [ ] **Step 3: Commit**

```bash
git add extensions/clusters/personal.ts
git commit -m "feat(personal): 日历域 3 工具（今日/查询/创建）"
```

---

### Task 2: 待办域（task_list / task_create / task_complete）

**Files:**
- Modify: `extensions/clusters/personal.ts`（在 `registerPersonal` 内、`// ---------------- 日历：创建` 块之后追加）

**Interfaces:**
- Consumes: Task 1 的 `truncate`/`txt`/`ToolCtx`/`okResult`/`errResult`/`runLark`/`confirmWrite`/`appendAudit`/`requireCluster`
- Produces: `coworker_task_list`、`coworker_task_create`、`coworker_task_complete`

- [ ] **Step 1: 追加待办 3 工具**

```ts
  // ---------------- 待办：列表 ----------------
  pi.registerTool({
    name: "coworker_task_list",
    label: "Coworker 我的待办",
    description:
      "查看我的待办任务（默认未完成），可按完成态筛选。用于回答「我有哪些待办」「还有什么没做完」。",
    parameters: Type.Object({
      filter: Type.Optional(Type.Union([
        Type.Literal("open"), Type.Literal("done"), Type.Literal("all"),
      ], { description: "open(默认)/done/all" })),
    }),
    async execute(_id, params) {
      const gate = requireCluster("personal");
      if (gate) return errResult(gate);
      const r = await runLark(["task", "+get-my-tasks", "--page-all"], { as: "user", timeoutMs: 60_000 });
      if (!r.ok) return errResult(describeLarkError(r));
      const items: any[] = r.envelope?.data?.items ?? [];
      const filter = params.filter ?? "open";
      const rows = items
        .filter((t) => (filter === "all" ? true : filter === "done" ? t.completed === true : !t.completed))
        .map((t) => {
          const done = t.completed === true ? "[x]" : "[ ]";
          const due = t.due_at ? ` 截止 ${txt(t.due_at)}` : "";
          const summary = txt(t.summary ?? "(无标题)");
          return `- ${done} ${summary}${due}`;
        });
      if (!rows.length) return okResult(filter === "done" ? "暂无已完成任务。" : "太棒了，没有未完成的待办。", { count: 0 });
      return okResult(`待办（${rows.length}）：\n` + rows.join("\n"), { count: rows.length });
    },
  });

  // ---------------- 待办：创建（写） ----------------
  pi.registerTool({
    name: "coworker_task_create",
    label: "Coworker 创建待办",
    description: "创建一条待办任务（可带截止时间/描述）。写操作：确认后创建。",
    parameters: Type.Object({
      title: Type.String({ description: "任务标题（≤100 字）" }),
      due: Type.Optional(Type.String({ description: "截止：YYYY-MM-DD 或 ISO 时间" })),
      description: Type.Optional(Type.String({ description: "任务描述" })),
      confirm: Type.Optional(Type.Boolean({ description: "非交互显式确认" })),
    }),
    async execute(_id, params, _sig, _onUpdate, ctx: ToolCtx) {
      const gate = requireCluster("personal");
      if (gate) return errResult(gate);
      const title = String(params.title ?? "").trim().slice(0, 100);
      if (!title) return errResult("title 不能为空。");
      const confirm = await confirmWrite(ctx, {
        title: "创建待办",
        message: `将创建待办「${title}」${params.due ? `（截止 ${params.due}）` : ""}`,
        explicitConfirm: params.confirm,
      });
      if (!confirm.ok) return errResult(`已取消：${confirm.reason ?? "用户未确认"}`, { blocked: true });
      const argv = ["task", "+create", "--summary", title];
      if (params.due) argv.push("--due", String(params.due));
      if (params.description) argv.push("--description", String(params.description).slice(0, 2000));
      const r = await runLark(argv, { as: "user", timeoutMs: 60_000 });
      if (!r.ok) return errResult(describeLarkError(r));
      appendAudit({ cluster: "personal", action: "task_create", resource: title, result: "ok" });
      const t = r.envelope?.data?.task ?? r.envelope?.data ?? {};
      return okResult(`已创建待办「${title}」`, { taskGuid: t.guid ?? t.task_id ?? "" });
    },
  });

  // ---------------- 待办：完成（写） ----------------
  pi.registerTool({
    name: "coworker_task_complete",
    label: "Coworker 完成任务",
    description: "把一条待办标记为完成。写操作：确认后完成。",
    parameters: Type.Object({
      taskId: Type.String({ description: "任务 id（来自 coworker_task_list 的 guid）" }),
      confirm: Type.Optional(Type.Boolean({ description: "非交互显式确认" })),
    }),
    async execute(_id, params, _sig, _onUpdate, ctx: ToolCtx) {
      const gate = requireCluster("personal");
      if (gate) return errResult(gate);
      if (!params.taskId) return errResult("taskId 不能为空。");
      const confirm = await confirmWrite(ctx, {
        title: "完成任务",
        message: `将待办 ${params.taskId} 标记为完成，确认？`,
        explicitConfirm: params.confirm,
      });
      if (!confirm.ok) return errResult(`已取消：${confirm.reason ?? "用户未确认"}`, { blocked: true });
      const r = await runLark(["task", "+complete", "--task-id", String(params.taskId)], { as: "user", timeoutMs: 60_000 });
      if (!r.ok) return errResult(describeLarkError(r));
      appendAudit({ cluster: "personal", action: "task_complete", resource: String(params.taskId), result: "ok" });
      return okResult("任务已完成。");
    },
  });
```

- [ ] **Step 2: 冒烟**

Run:
```bash
cd /Users/nuc8i7beh/magene/pi-coworker && node --experimental-strip-types -e "
import('./extensions/clusters/personal.ts').then(async m => {
  const handlers={};
  m.registerPersonal({ registerTool(d){handlers[d.name]=d.execute}, registerCommand(){}, on(){}, sendUserMessage(){} });
  const r = await handlers.coworker_task_list(undefined, {}, undefined, undefined, {hasUI:false});
  console.log('task_list =>', JSON.stringify(r.details), r.content[0].text.slice(0,150));
}).catch(e=>{console.error(e); process.exit(1)})"
```
Expected: 返回真实待办列表或"太棒了，没有未完成的待办"。

- [ ] **Step 3: Commit**

```bash
git add extensions/clusters/personal.ts
git commit -m "feat(personal): 待办域 3 工具（列表/创建/完成）"
```

---

### Task 3: 妙记域（minutes_search / minutes_get）

**Files:**
- Modify: `extensions/clusters/personal.ts`（追加）

**Interfaces:**
- Produces: `coworker_minutes_search`、`coworker_minutes_get`

- [ ] **Step 1: 追加妙记 2 工具**

```ts
  // ---------------- 妙记：检索 ----------------
  pi.registerTool({
    name: "coworker_minutes_search",
    label: "Coworker 妙记检索",
    description:
      "检索会议妙记（录音转写/纪要）：按关键词或时间范围。用于回答「上次的会讲了啥」「找一下 XX 会议记录」。",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "关键词（≤30 字）" })),
      start: Type.Optional(Type.String({ description: "起始日期 YYYY-MM-DD（默认 30 天前）" })),
      end: Type.Optional(Type.String({ description: "结束日期 YYYY-MM-DD（默认今天）" })),
    }),
    async execute(_id, params) {
      const gate = requireCluster("personal");
      if (gate) return errResult(gate);
      const argv = ["minutes", "+search"];
      if (params.query) argv.push("--query", String(params.query).slice(0, 30));
      if (params.start) argv.push("--start", String(params.start));
      if (params.end) argv.push("--end", String(params.end));
      const r = await runLark(argv, { as: "user", timeoutMs: 60_000 });
      if (!r.ok) return errResult(describeLarkError(r));
      const items: any[] = r.envelope?.data?.items ?? [];
      if (!items.length) return okResult("未找到相关妙记。", { count: 0 });
      const rows = items.map((m) => `- ${txt(m.display_info ?? m.title ?? m.minute_token)}`);
      return okResult(`妙记（${items.length}）：\n` + rows.slice(0, 10).join("\n"), { count: items.length });
    },
  });

  // ---------------- 妙记：详情 ----------------
  pi.registerTool({
    name: "coworker_minutes_get",
    label: "Coworker 妙记详情",
    description:
      "读取单条妙记的 AI 摘要/待办/章节。用于「把上次会的结论和待办列出来」。",
    parameters: Type.Object({
      token: Type.String({ description: "妙记 token（来自 coworker_minutes_search）" }),
    }),
    async execute(_id, params) {
      const gate = requireCluster("personal");
      if (gate) return errResult(gate);
      if (!params.token) return errResult("token 不能为空。");
      const r = await runLark(
        ["minutes", "+detail", "--minute-tokens", String(params.token), "--summary", "--todo", "--chapter"],
        { as: "user", timeoutMs: 60_000 },
      );
      if (!r.ok) return errResult(describeLarkError(r));
      const d = r.envelope?.data ?? {};
      const lines: string[] = [];
      const title = txt(d.subject ?? d.title ?? params.token);
      lines.push(`「${title}」`);
      if (d.summary) lines.push(`\n【摘要】\n${truncate(txt(d.summary))}`);
      if (d.todos?.length) {
        lines.push(`\n【待办】`);
        d.todos.forEach((t: any) => lines.push(`- ${txt(t.text ?? t.todo ?? JSON.stringify(t)).slice(0, 120)}`));
      }
      if (d.chapters?.length) {
        lines.push(`\n【章节】`);
        d.chapters.slice(0, 12).forEach((c: any) => lines.push(`- ${txt(c.title ?? "")} @${txt(c.start_time ?? "")}`));
      }
      return okResult(truncate(lines.join("\n")), { token: String(params.token) });
    },
  });
```

- [ ] **Step 2: 冒烟**

Run:
```bash
cd /Users/nuc8i7beh/magene/pi-coworker && node --experimental-strip-types -e "
import('./extensions/clusters/personal.ts').then(async m => {
  const handlers={};
  m.registerPersonal({ registerTool(d){handlers[d.name]=d.execute}, registerCommand(){}, on(){}, sendUserMessage(){} });
  const s = await handlers.coworker_minutes_search(undefined, {start:'2026-08-01'}, undefined, undefined, {hasUI:false});
  console.log('search =>', JSON.stringify(s.details), s.content[0].text.slice(0,150));
}).catch(e=>{console.error(e); process.exit(1)})"
```
Expected: 返回真实妙记列表（该账号有历史妙记）。

- [ ] **Step 3: Commit**

```bash
git add extensions/clusters/personal.ts
git commit -m "feat(personal): 妙记域 2 工具（检索/详情）"
```

---

### Task 4: 邮件域（mail_triage / mail_read / mail_send）

**Files:**
- Modify: `extensions/clusters/personal.ts`（追加）

**Interfaces:**
- Produces: `coworker_mail_triage`、`coworker_mail_read`、`coworker_mail_send`

- [ ] **Step 1: 追加邮件 3 工具**

```ts
  // ---------------- 邮件：收件箱摘要 ----------------
  pi.registerTool({
    name: "coworker_mail_triage",
    label: "Coworker 收件箱摘要",
    description:
      "查看收件箱摘要（发送人/主题/时间），支持全文检索。用于「有没有新邮件」「搜一下 XX 主题的邮件」。",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "全文检索关键词（≤30 字）" })),
      limit: Type.Optional(Type.Integer({ description: "返回条数（默认 8，最大 10）" })),
    }),
    async execute(_id, params) {
      const gate = requireCluster("personal");
      if (gate) return errResult(gate);
      const argv = ["mail", "+triage"];
      if (params.query) argv.push("--query", String(params.query).slice(0, 30));
      const r = await runLark(argv, { as: "user", timeoutMs: 45_000 });
      if (!r.ok) return errResult(describeLarkError(r));
      const items: any[] = r.envelope?.data?.items ?? r.envelope?.data?.messages ?? [];
      const limit = Math.min(Math.max(params.limit ?? 8, 1), 10);
      if (!items.length) return okResult("收件箱暂无邮件。", { count: 0 });
      const rows = items.slice(0, limit).map((m: any) => {
        const from = txt(m.from?.email ?? m.sender ?? "");
        const subj = txt(m.subject ?? "(无主题)");
        const ts = txt(m.received_time ?? m.date ?? m.ts ?? "");
        return `- ${ts}  ${from}\n  ${subj}`;
      });
      return okResult(`收件箱（前 ${rows.length} 封）：\n` + rows.join("\n"), { count: items.length });
    },
  });

  // ---------------- 邮件：读单封 ----------------
  pi.registerTool({
    name: "coworker_mail_read",
    label: "Coworker 读邮件",
    description: "读取单封邮件正文与附件元数据。用于「把那封邮件内容念给我」。",
    parameters: Type.Object({
      messageId: Type.String({ description: "邮件 message_id（来自 coworker_mail_triage）" }),
      full: Type.Optional(Type.Boolean({ description: "true 返回完整正文（默认去除引用/签名段）" })),
    }),
    async execute(_id, params) {
      const gate = requireCluster("personal");
      if (gate) return errResult(gate);
      if (!params.messageId) return errResult("messageId 不能为空。");
      const r = await runLark(
        ["mail", "+message", "--message-id", String(params.messageId), "--html=false"],
        { as: "user", timeoutMs: 45_000 },
      );
      if (!r.ok) return errResult(describeLarkError(r));
      const m = r.envelope?.data ?? {};
      let body = txt(m.body ?? m.snippet ?? m.content ?? "");
      if (!params.full) {
        body = body.split(/^--\s*$/m)[0];            // 去引用分隔线
        body = body.replace(/\n>.*/g, "").trim();      // 去引用行
      }
      const lines = [`发件人：${txt(m.from?.email ?? m.sender ?? "")}`];
      const subj = txt(m.subject ?? "(无主题)");
      lines.push(`主题：${subj}`);
      if (m.to?.length) lines.push(`收件人：${m.to.map((x: any) => txt(x.email ?? "")).join("、")}`);
      if (m.date) lines.push(`时间：${txt(m.date)}`);
      lines.push(`\n${truncate(body)}`);
      if (m.attachments?.length) {
        lines.push(`\n附件（${m.attachments.length}）：` + m.attachments.map((a: any) => txt(a.name ?? "")).join("、"));
      }
      return okResult(lines.join("\n"));
    },
  });

  // ---------------- 邮件：发送（写） ----------------
  pi.registerTool({
    name: "coworker_mail_send",
    label: "Coworker 发邮件",
    description:
      "撰写并发送邮件（保存为草稿预览 → 用户确认 → 发送）。写操作：必须先确认收件人与内容。",
    parameters: Type.Object({
      to: Type.Array(Type.String({ description: "收件人邮箱" })),
      subject: Type.String({ description: "主题（≤200 字）" }),
      body: Type.String({ description: "正文（纯文本）" }),
      cc: Type.Optional(Type.Array(Type.String({ description: "抄送邮箱" }))),
      confirm: Type.Optional(Type.Boolean({ description: "非交互显式确认" })),
    }),
    async execute(_id, params, _sig, _onUpdate, ctx: ToolCtx) {
      const gate = requireCluster("personal");
      if (gate) return errResult(gate);
      const to = (params.to ?? []).filter(Boolean);
      const subject = String(params.subject ?? "").trim().slice(0, 200);
      if (!to.length) return errResult("至少需要一个收件人。");
      if (!subject) return errResult("subject 不能为空。");
      if (!params.body) return errResult("body 不能为空。");

      const preview = `收件人：${to.join("、")}${params.cc?.length ? `\n抄送：${params.cc.join("、")}` : ""}\n主题：${subject}\n\n${truncate(String(params.body), 500)}`;
      const confirm = await confirmWrite(ctx, { title: "发送邮件", message: preview, explicitConfirm: params.confirm });
      if (!confirm.ok) return errResult(`已取消：${confirm.reason ?? "用户未确认"}`, { blocked: true });

      const argv = ["mail", "+send", "--to", to.join(","), "--subject", subject, "--body", String(params.body), "--plain-text", "--confirm-send"];
      if (params.cc?.length) argv.push("--cc", params.cc.join(","));
      const r = await runLark(argv, { as: "user", timeoutMs: 90_000 });
      if (!r.ok) return errResult(describeLarkError(r));
      appendAudit({ cluster: "personal", action: "mail_send", resource: subject, result: "ok" });
      return okResult(`已发送邮件「${subject}」给 ${to.join("、")}`);
    },
  });
```

- [ ] **Step 2: 冒烟**

Run:
```bash
cd /Users/nuc8i7beh/magene/pi-coworker && node --experimental-strip-types -e "
import('./extensions/clusters/personal.ts').then(async m => {
  const handlers={};
  m.registerPersonal({ registerTool(d){handlers[d.name]=d.execute}, registerCommand(){}, on(){}, sendUserMessage(){} });
  const t = await handlers.coworker_mail_triage(undefined, {}, undefined, undefined, {hasUI:false});
  console.log('triage =>', JSON.stringify(t.details), t.content[0].text.slice(0,150));
}).catch(e=>{console.error(e); process.exit(1)})"
```
Expected: 返回真实收件箱摘要（或"收件箱暂无邮件"）。

- [ ] **Step 3: Commit**

```bash
git add extensions/clusters/personal.ts
git commit -m "feat(personal): 邮件域 3 工具（摘要/读信/发送）"
```

---

### Task 5: 通讯录域（contact_find）

**Files:**
- Modify: `extensions/clusters/personal.ts`（追加）

**Interfaces:**
- Produces: `coworker_contact_find`

- [ ] **Step 1: 追加通讯录工具**

```ts
  // ---------------- 通讯录：查同事 ----------------
  pi.registerTool({
    name: "coworker_contact_find",
    label: "Coworker 查同事",
    description:
      "按姓名/关键词在企业通讯录中查找同事（姓名/部门/职位/邮箱，邮箱脱敏）。用于「查一下同事张三的联系方式」。",
    parameters: Type.Object({
      keyword: Type.String({ description: "姓名或关键词（≤30 字）" }),
    }),
    async execute(_id, params) {
      const gate = requireCluster("personal");
      if (gate) return errResult(gate);
      const keyword = String(params.keyword ?? "").trim().slice(0, 30);
      if (!keyword) return errResult("keyword 不能为空。");
      const r = await runLark(["contact", "+search-user", "--query", keyword], { as: "user", timeoutMs: 45_000 });
      if (!r.ok) return errResult(describeLarkError(r));
      const users: any[] = r.envelope?.data?.users ?? r.envelope?.data?.items ?? [];
      if (!users.length) return okResult(`未找到「${keyword}」。`, { count: 0 });
      const rows = users.slice(0, 8).map((u: any) => {
        const name = txt(u.name ?? u.zh_name ?? "");
        const dept = txt(u.department ?? "");
        const title = txt(u.title ?? u.position ?? "");
        const email = String(u.email ?? u.enterprise_email ?? "").replace(/^(.{2}).*(@.*)$/, "$1**$2");
        return `- ${name}${dept ? " · " + dept : ""}${title ? " · " + title : ""}${email && email !== "@" ? `\n  ${email}` : ""}`;
      });
      return okResult(`找到 ${users.length} 位：\n` + rows.join("\n"), { count: users.length });
    },
  });
```

- [ ] **Step 2: 冒烟**

Run:
```bash
cd /Users/nuc8i7beh/magene/pi-coworker && node --experimental-strip-types -e "
import('./extensions/clusters/personal.ts').then(async m => {
  const handlers={};
  m.registerPersonal({ registerTool(d){handlers[d.name]=d.execute}, registerCommand(){}, on(){}, sendUserMessage(){} });
  const r = await handlers.coworker_contact_find(undefined, {keyword:'李'}, undefined, undefined, {hasUI:false});
  console.log('contact =>', JSON.stringify(r.details), r.content[0].text.slice(0,150));
}).catch(e=>{console.error(e); process.exit(1)})"
```
Expected: 返回同事列表，邮箱已打码（li**@…）。

- [ ] **Step 3: Commit**

```bash
git add extensions/clusters/personal.ts
git commit -m "feat(personal): 通讯录域 1 工具（查同事）"
```

---

### Task 6: 接线（policy / index / 命令 / GUI / 文档）

**Files:**
- Modify: `config/policy.json`（employee/permissions-manager 角色 clusters 加 `"personal"`）
- Modify: `extensions/index.ts`（import + `registerPersonal(pi)`）
- Modify: `extensions/commands.ts`（`/coworker:today`）
- Modify: `gui/backend/src/index.ts`（GUI_TOOLS 追加 12 个 id）
- Modify: `README.md`、`docs/INTERACTION.md`（工作集群表补 personal）
- Test: `scripts/smoke-test.ts`（应自动列出新工具）

**Interfaces:**
- Consumes: Task 1-5 的 `registerPersonal`

- [ ] **Step 1: policy.json 集群白名单**

```json
"employee": { "clusters": ["onboarding", "permissions", "knowledge", "personal"] },
"permissions-manager": { "clusters": ["onboarding", "permissions", "knowledge", "personal"] },
"admin": { "clusters": ["onboarding", "permissions", "knowledge", "governance", "personal"] }
```

- [ ] **Step 2: index.ts 注册**

```ts
import { registerPersonal } from "./clusters/personal.ts";
// 在 registerSkillsCluster(pi); 之后：
registerPersonal(pi);
```

- [ ] **Step 3: /coworker:today 命令（commands.ts 末尾追加）**

```ts
  // ---------------- /coworker:today 今日概览 ----------------
  pi.registerCommand("coworker:today", {
    description: "今日概览：日程 + 未完成待办 + 收件箱未读（只读）",
    handler: async (_args, ctx) => {
      const prompt =
        "请为用户生成「今日概览」，依次调用：coworker_schedule_today（今日日程）、coworker_task_list（未完成待办）、coworker_mail_triage（收件箱摘要前几条）。" +
        "输出分三节：日程 / 待办 / 邮件；没有内容的一节明确写「无」。不要做任何写操作。";
      pi.sendUserMessage(prompt, { deliverAs: "followUp" });
      ctx.ui.notify("正在生成今日概览…", "info");
    },
  });
```

- [ ] **Step 4: GUI_TOOLS 追加（gui/backend/src/index.ts）**

```ts
const GUI_TOOLS = [
  // …现有…
  "coworker_magene_setup", "coworker_magene_status",
  // personal 集群
  "coworker_schedule_today", "coworker_schedule_query", "coworker_schedule_create",
  "coworker_task_list", "coworker_task_create", "coworker_task_complete",
  "coworker_minutes_search", "coworker_minutes_get",
  "coworker_mail_triage", "coworker_mail_read", "coworker_mail_send",
  "coworker_contact_find",
];
```

- [ ] **Step 5: 回归 + 注册冒烟**

Run:
```bash
cd /Users/nuc8i7beh/magene/pi-coworker && npm run check && node scripts/smoke-test.ts
```
Expected: tsc 通过；smoke 输出 tools 列表含 12 个 personal 工具（总数 = 现有 + 12）。

- [ ] **Step 6: 文档更新**

README.md「工作集群」表加一行：
```
| personal 个人效率 | `coworker_schedule_today`/`schedule_query`/`schedule_create`/`task_list`/`task_create`/`task_complete`/`minutes_search`/`minutes_get`/`mail_triage`/`mail_read`/`mail_send`/`contact_find` | `/coworker:today` |
```
docs/INTERACTION.md 相应补充一节"个人效率（日历/待办/妙记/邮件/通讯录）"。

- [ ] **Step 7: Commit**

```bash
git add config/policy.json extensions/index.ts extensions/commands.ts gui/backend/src/index.ts README.md docs/INTERACTION.md
git commit -m "feat(personal): 接线（policy 白名单 / 注册 / /coworker:today / GUI 工具 / 文档）"
```

---

### Task 7: 端到端验证（GUI + 写操作确认路径）

**Files:** 无（验证）

- [ ] **Step 1: GUI 后端起服务，对话问真实数据**

Run:
```bash
cd /Users/nuc8i7beh/magene/pi-coworker && lsof -iTCP:17331 -sTCP:LISTEN | awk 'NR==2{print $2}' | xargs -I{} kill {} 2>/dev/null; sleep 1
(GUI_PORT=17331 node gui/backend/src/index.ts > /tmp/gui-personal.log 2>&1 &) && sleep 3
curl -s -X POST http://127.0.0.1:17331/ask -H 'content-type: application/json' -d '{"text":"我今天有什么会？"}' | head -c 300
```
Expected: 回答含真实今日日程（或"今日无日程"），说明工具已生效。

- [ ] **Step 2: 写操作拒绝路径（无 confirm 应 blocked）**

Run:
```bash
curl -s -X POST http://127.0.0.1:17331/ask -H 'content-type: application/json' -d '{"text":"调用 coworker_schedule_create 创建日程「测试」今天 15:00-16:00，不要确认"}' | head -c 300
```
Expected: 返回"已取消/需确认"，未真实创建日程（确认后也不会创建，因为 GUI 无 UI confirm 弹窗路径下显式 confirm 缺失）。

- [ ] **Step 3: （可选）重打包 GUI 安装**

Run: `cd gui && npm run build`（含 prepare:pi）→ 手动 bundle_dmg.sh → 装 /Applications（本计划不改 GUI 前端代码，只加了工具白名单，重打包让 GUI 具备新工具）。

- [ ] **Step 4: 总结 + 收尾**

确认无遗留 TODO；`git log --oneline -8` 应有 6 个个人效率相关提交。

---

## Self-Review

**Spec 覆盖：** 12 工具（Task1:3 日历 / Task2:3 待办 / Task3:2 妙记 / Task4:3 邮件 / Task5:1 通讯录）+ 接线（Task6 policy/index/命令/GUI/文档）+ 验证（Task7）。spec §4 安全边界（--as user / 写确认 / 脱敏 / 截断 / 集群白名单）由各工具实现 + Task6 白名单覆盖。spec §5 数据流示例在 Task1/Task7 冒烟覆盖。spec §6 错误处理（describeLarkError / blocked / 参会人解析）实现于各 execute。spec §9 配置变更全部在 Task6。

**占位符扫描：** 无 TBD/TODO；每个工具 execute 有完整代码。

**类型一致性：** `registerPersonal(pi: ExtensionAPI)` 由 index.ts 调用；工具名在 Task1-5 定义与 Task6 GUI_TOOLS/README 引用一致；`confirmWrite(ctx, {explicitConfirm: params.confirm})` 与现有 permissions.ts 用法一致；`execute(_id, params, _sig, _onUpdate, ctx)` 五参签名与 permissions.ts 一致。
