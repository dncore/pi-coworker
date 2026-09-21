/**
 * lark-cli 输出形状契约测试（CI 可跑，无网络/无飞书）。
 *
 * 思路：本项目的风险集中在"lark-cli 输出的字段路径 / 错误封套"上——解析器一改、
 * lark-cli 一升级就可能静默失效。这里用**合成 fixture**（scripts/fixtures/lark-shapes.json）
 * 调用我们真实的解析函数，把依赖的字段路径钉死；真实上游是否仍长这样，由
 * `scripts/lark-live-check.ts` 在开发机上对着真 lark-cli 校验（只输出通过/漂移）。
 *
 * 用法：node scripts/contract-test.ts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const F = JSON.parse(readFileSync(join(here, "fixtures", "lark-shapes.json"), "utf8")) as Record<string, any>;

const {
  extractJson, extractAllJson, parseEnvelope, dataOf, userIdentityOf, countScopes, describeLarkError,
} = await import("../extensions/core/lark.ts");
const { parseBaseResult, formatCellValue } = await import("../extensions/core/base.ts");
const { isConflictError } = await import("../agent/src/bus.ts");

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "✅" : "❌"} ${name}${ok || !detail ? "" : ` —— ${detail}`}`);
  if (!ok) failed++;
}

// ---------------- 身份 / 配置 ----------------
console.log("== 身份与配置（config show / auth status）==");
{
  const u = userIdentityOf(F.auth_status);
  check("auth status → openId", u?.openId === "ou_testuser", JSON.stringify(u?.openId));
  check("auth status → userName / tokenStatus", u?.userName === "测试用户" && u?.tokenStatus === "valid");
  check("auth status → scope 计数（空格分隔串）", countScopes(u?.scope) === 4, String(countScopes(u?.scope)));
  check("config show → appId（顶层裸对象）", dataOf(F.config_show)?.appId === "cli_testappid");
  check("信封真值判定用 ok==true 而非 code==0", F.envelope.ok === true && F.envelope.code === undefined);
}

// ---------------- 信封解析 ----------------
console.log("== 信封解析（含 tip 前缀 / 错误走 stderr）==");
{
  check("extractJson 能剥掉 tip 前缀", extractJson(F.error_stdout_with_tip_prefix)?.data?.x === 1);
  check("parseEnvelope 优先 stdout 成功信封", parseEnvelope(JSON.stringify(F.envelope), "")?.ok === true);
  check("parseEnvelope 回退 stderr 错误信封", parseEnvelope("", JSON.stringify(F.error_conflict))?.error?.subtype === "failed_precondition");
  // --page-all 的输出是多段 JSON 拼接（NDJSON 变体）：extractJson 只取首段，
  // 分页场景必须用 extractAllJson（门户地址发现靠它遍历上千个应用）
  const two = `${JSON.stringify(F.event_status)}\n${JSON.stringify({ ok: true, data: { app_list: [{ app_id: "cli_x", app_name: "AI应用门户", redirect_urls: ["http://h:1/feishu/login"] }] } })}`;
  check("extractJson 只取第一段（对照）", extractJson(two)?.apps?.[0]?.app_id === "cli_testappid");
  const all = extractAllJson(two);
  check("extractAllJson 取到全部两段", all.length === 2 && all[1]?.data?.app_list?.[0]?.app_name === "AI应用门户", `段数 ${all.length}`);
}

// ---------------- 错误封套 ----------------
console.log("== 错误封套（exit 10 / 冲突 / scope）==");
{
  const r10 = {
    ok: false, exitCode: 10, envelope: F.error_confirmation_required, stdout: "", stderr: "",
    confirmationRequired: true,
  };
  const msg = describeLarkError(r10 as any);
  check("exit 10 → 展示 action/risk", msg.includes("drive.member.add") && msg.includes("high-risk-write"), msg.slice(0, 80));
  const rScope = { ok: false, exitCode: 3, envelope: F.error_missing_scope, stdout: "", stderr: "", confirmationRequired: false };
  check("missing_scope → 展示缺失 scope", describeLarkError(rScope as any).includes("wiki:member:create"));
  check("总线冲突判定命中真实报文", isConflictError(null, F.error_conflict.error.message));
  check("冲突判定不吃普通错误", !isConflictError(null, "network timeout while connecting"));
}

// ---------------- IM 事件（Bot 主链路）----------------
console.log("== IM 消息 / 卡片回调（字段即代码读取的字段）==");
{
  const m = F.im_message_receive;
  check("消息含 chat_id/chat_type/content/message_id/sender_id",
    !!(m.chat_id && m.chat_type && m.content && m.message_id && m.sender_id));
  check("content 已解码为纯文本（非 JSON 串）", typeof m.content === "string" && !m.content.startsWith("{"));
  const c = F.card_action_trigger;
  check("卡片回调含 operator_id/action_value/token/message_id",
    !!(c.operator_id && c.action_value && c.token && c.message_id));
  check("action_value 是 JSON 字符串（parseActionValue 解析）",
    JSON.parse(c.action_value).action === "perm_apply");
}

// ---------------- Base / Wiki ----------------
console.log("== 多维表格 / 知识空间 ==");
{
  const recs = parseBaseResult(F.base_record_search);
  check("record-search → 记录数与顺序", recs.length === 2 && recs[0].record_id === "rec1");
  check("record-search → 字段按 field_id_list 对齐",
    recs[0].values[0].fieldId === "fld1" && recs[0].values[0].value === "员工手册");
  check("单元格：对象取 text / 数组拼接", formatCellValue([{ text: "制度" }]) === "制度" && formatCellValue(["a", "b"]) === "a, b");
  check("field-list → id/name 可用于名称映射",
    F.base_field_list.data.fields.every((f: any) => f.id && f.name));
  check("space-list → space_id/name/visibility", F.wiki_space_list.data.spaces[0].space_id && F.wiki_space_list.data.spaces[0].visibility);
  check("member-list → member_id/member_role（perm_check 判据）",
    F.wiki_member_list.data.members[0].member_id.startsWith("ou_") && F.wiki_member_list.data.members[0].member_role === "member");
  check("node-get → obj_token/obj_type（wiki 抓取分发）", F.wiki_node_get.data.obj_token && F.wiki_node_get.data.obj_type);
  check("drive search → result_meta.url（wiki 兜底召回）", F.drive_search.data.results[0].result_meta.url.includes("feishu.cn"));
  check("docs fetch → data.document.content", typeof F.docs_fetch.data.document.content === "string");
}

// ---------------- 个人效率集群字段 ----------------
console.log("== 个人效率集群（task / minutes / mail / contact / calendar）==");
{
  const items = F.task_get_my_tasks.data.items;
  const isDone = (t: any) => Boolean(t.completed_at ?? t.completed) && String(t.completed_at ?? "") !== "0";
  check("task list → completed_at 语义（'0' 视为未完成）", items.length === 2 && isDone(items[0]) === false && isDone(items[1]) === true);
  check("task list → due_at '0' 不显示截止", items[1].due_at === "0");
  check("minutes search → token/display_info", F.minutes_search.data.items[0].token && F.minutes_search.data.items[0].display_info);
  check("minutes detail → artifacts.summary/todos/chapters",
    F.minutes_detail.data.minutes[0].artifacts.todos[0].content && F.minutes_detail.data.minutes[0].artifacts.chapters[0].title);
  check("mail triage → 顶层 messages 数组 + message_id", Array.isArray(F.mail_triage.messages) && F.mail_triage.messages[0].message_id);
  check("mail message → data.data.body_plain_text/head_from", F.mail_message.data.data.body_plain_text && F.mail_message.data.data.head_from.email);
  check("contact search → open_id/localized_name/email（邮箱脱敏正则用）",
    F.contact_search_user.data.users[0].open_id && F.contact_search_user.data.users[0].email.includes("@"));
  // 日历两个 shortcut 形状不同（曾因此把 agenda 写成"永远暂无日程"），这里钉死
  check("calendar +agenda → data 是数组（不是 {items}）", Array.isArray(F.calendar_agenda.data));
  check("calendar +agenda → 元素用 start_time.datetime", F.calendar_agenda.data[0].start_time.datetime);
  check("calendar +search-event → data.items[]，元素用 start.date_time",
    F.calendar_search_event.data.items[0].start.date_time && !Array.isArray(F.calendar_search_event.data));
  {
    // 直接调产品函数（personal.ts 导出），而不是在测试里重写一份逻辑
    const { eventItems, fmtEvent } = await import("../extensions/clusters/personal.ts");
    const a = eventItems(F.calendar_agenda);
    const b = eventItems(F.calendar_search_event);
    check("eventItems：agenda（数组形态）取到 1 条", a.length === 1, String(a.length));
    check("eventItems：search-event（{items} 形态）取到 1 条", b.length === 1, String(b.length));
    const lineA = fmtEvent(a[0]);
    const lineB = fmtEvent(b[0]);
    check("fmtEvent：agenda 时间可读且不含 [object Object]",
      lineA.includes("2026-01-01T14:00") && !lineA.includes("[object"), lineA.slice(0, 60));
    check("fmtEvent：search-event 时间可读", lineB.includes("2026-01-02T10:00") && !lineB.includes("[object"), lineB.slice(0, 60));
  }
  check("messages-send → data.message_id（撤回/信令取 id 用）", F.im_messages_send.data.message_id.startsWith("om_"));
  check("approval instance → instance_code/status", F.approval_instance.data.instance_code && F.approval_instance.data.status);
}

// ---------------- 事件总线状态 ----------------
console.log("== 事件总线状态形状 ==");
{
  const parse = (out: string) => JSON.parse(out.slice(out.indexOf("{"))).apps ?? [];
  check("event status → apps[].running=false（未占用）", parse(JSON.stringify(F.event_status))[0].running === false);
  check("event status → apps[].running=true（本机占用）", parse(JSON.stringify(F.event_status_running))[0].running === true);
}

console.log(failed === 0 ? "\n✅ 契约测试全部通过" : `\n❌ 契约测试失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
