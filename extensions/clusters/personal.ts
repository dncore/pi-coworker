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

/** 将 {start:{date_time},end:{date_time},summary,…} 或 {start_time,end_time,…} 条目格式化为日程行 */
function fmtEvent(e: Record<string, any>): string {
  const st = txt(e.start?.date_time ?? e.start_time ?? e.start_time_ts ?? "");
  const en = txt(e.end?.date_time ?? e.end_time ?? e.end_time_ts ?? "");
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
}
