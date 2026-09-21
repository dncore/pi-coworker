/**
 * lark-cli 真机形状校验（开发机/发布前跑；**不进 CI**，需要真实登录且会真实读数据）。
 *
 * 与 scripts/contract-test.ts 的关系：
 *   - contract-test 用合成 fixture 锁我们的解析器（CI 每次都跑）；
 *   - 本脚本拿**真实 lark-cli** 打同一批字段路径，回答"上游是不是变了"。
 *     只打印 ✅/⚠️ 与字段路径名，不落任何响应内容（避免真实数据进仓库/日志）。
 *
 * 全部为只读命令（config show / auth status / event status / wiki / drive / task /
 * minutes / mail / contact / calendar），走 product 自己的配置目录与 runLark 封装。
 *
 * 用法：node scripts/lark-live-check.ts
 */
import { runLark, dataOf, userIdentityOf } from "../extensions/core/lark.ts";

let drift = 0;
let checked = 0;

function ok(path: string, present: unknown): void {
  checked++;
  if (present) {
    console.log(`  ✅ ${path}`);
  } else {
    drift++;
    console.log(`  ⚠️  ${path} —— 未取到（上游形状可能变了，请对照 contract-test 的 fixture 更新）`);
  }
}

async function main(): Promise<void> {
  const ver = await runLark(["--version"], { timeoutMs: 15_000 });
  console.log(`lark-cli: ${(ver.stdout || ver.stderr || "?").trim().split("\n")[0]}`);
  console.log(`配置目录: ${process.env.LARKSUITE_CLI_CONFIG_DIR ?? "~/.coworker/lark-cli（默认）"}\n`);

  console.log("== 身份与配置 ==");
  const cfg = await runLark(["config", "show"], { timeoutMs: 30_000 });
  ok("config show → appId", dataOf(cfg.envelope)?.appId);

  const auth = await runLark(["auth", "status", "--json"], { as: "user", timeoutMs: 60_000 });
  const u = userIdentityOf(auth.envelope);
  ok("auth status → identities.user.openId", u?.openId);
  ok("auth status → userName", u?.userName);
  ok("auth status → tokenStatus", u?.tokenStatus);
  ok("auth status → scope", typeof u?.scope === "string" && u.scope.length > 0);

  console.log("== 事件总线 ==");
  const es = await runLark(["event", "status", "--json"], { timeoutMs: 20_000 });
  const apps = dataOf(es.envelope)?.apps;
  ok("event status → apps[].app_id", Array.isArray(apps) && apps[0]?.app_id);
  ok("event status → apps[].running（布尔）", typeof apps?.[0]?.running === "boolean");

  console.log("== 知识（wiki / drive / docs）==");
  const spaces = await runLark(["wiki", "+space-list", "--format", "json"], { as: "user", timeoutMs: 60_000 });
  const spaceList: any[] = dataOf(spaces.envelope)?.spaces ?? [];
  ok("wiki +space-list → spaces[].space_id", spaceList[0]?.space_id);
  ok("wiki +space-list → spaces[].name", spaceList[0]?.name);
  if (spaceList[0]?.space_id) {
    const members = await runLark(
      ["wiki", "+member-list", "--space-id", String(spaceList[0].space_id), "--page-all", "--format", "json"],
      { as: "user", timeoutMs: 60_000 },
    );
    const ms: any[] = dataOf(members.envelope)?.members ?? [];
    ok("wiki +member-list → members[].member_id/member_role", ms[0]?.member_id && ms[0]?.member_role);
  }
  const search = await runLark(["drive", "+search", "--query", "文档", "--page-size", "3", "--format", "json"], { as: "user", timeoutMs: 60_000 });
  const results: any[] = dataOf(search.envelope)?.results ?? [];
  ok("drive +search → data.total（数字）", typeof dataOf(search.envelope)?.total === "number");
  if (results.length) ok("drive +search → results[].result_meta.url", results[0]?.result_meta?.url ?? results[0]?.url);

  console.log("== 个人效率（task / minutes / mail / contact / calendar）==");
  const tasks = await runLark(["task", "+get-my-tasks", "--page-size", "5"], { as: "user", timeoutMs: 60_000 });
  const items: any[] = dataOf(tasks.envelope)?.items ?? [];
  ok("task +get-my-tasks → data.items[]（数组）", Array.isArray(items));
  if (items.length) {
    ok("task → 条目含 summary", items[0]?.summary != null);
    ok("task → 条目含 completed_at（Task v2 完成标记）", items[0]?.completed_at !== undefined || items[0]?.completed !== undefined);
  }
  // +search 要求至少一个过滤参数（query/start/end），否则直接报错
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const min = await runLark(["minutes", "+search", "--start", since, "--page-size", "3", "--format", "json"], { as: "user", timeoutMs: 60_000 });
  ok("minutes +search → data.items[]（数组）", Array.isArray(dataOf(min.envelope)?.items));
  const mail = await runLark(["mail", "+triage", "--format", "json"], { as: "user", timeoutMs: 60_000 });
  ok("mail +triage → messages[]（顶层）", Array.isArray(mail.envelope?.messages) || Array.isArray(dataOf(mail.envelope)?.messages));
  if (u?.userName) {
    const ct = await runLark(["contact", "+search-user", "--query", String(u.userName).slice(0, 10)], { as: "user", timeoutMs: 60_000 });
    const users: any[] = dataOf(ct.envelope)?.users ?? [];
    if (users.length) ok("contact +search-user → users[].open_id/localized_name", users[0]?.open_id && users[0]?.localized_name);
    else console.log("  ⏭  contact +search-user 无结果（换关键词再试，或忽略）");
  }
  // 日历两个 shortcut 形状不同，历史上正是这里写错过（agenda 被当 {items} 解析）。
  // 用一个回看窗口（近 30 天）而不是"今天"，否则多数时候没有日程、元素形状断言会被跳过。
  const today = new Date().toISOString().slice(0, 10);
  const cal = await runLark(["calendar", "+agenda", "--start", since, "--end", today, "--format", "json"], { as: "user", timeoutMs: 45_000 });
  const calData = dataOf(cal.envelope);
  ok("calendar +agenda → data 是数组", Array.isArray(calData));
  if (Array.isArray(calData) && calData.length > 0) {
    ok("calendar +agenda → 元素含 summary + start_time.datetime", calData[0]?.summary != null && calData[0]?.start_time?.datetime);
  }
  const se = await runLark(
    ["calendar", "+search-event", "--start", since, "--page-size", "3", "--format", "json"],
    { as: "user", timeoutMs: 45_000 },
  );
  const seItems: any[] = dataOf(se.envelope)?.items ?? [];
  ok("calendar +search-event → data.items[]", Array.isArray(dataOf(se.envelope)?.items));
  if (seItems.length > 0) ok("calendar +search-event → 元素含 start.date_time", seItems[0]?.start?.date_time);

  console.log(`\n检查 ${checked} 项，漂移/未取到 ${drift} 项`);
  if (drift > 0) {
    console.log("⚠️  上游形状可能已变：对照 scripts/fixtures/lark-shapes.json 与 scripts/contract-test.ts 更新解析器/fixture。");
    process.exit(1);
  }
  console.log("✅ 上游形状与我们依赖的字段路径一致");
}

main().catch((e) => {
  console.error("❌ 校验失败：", e?.message ?? e);
  process.exit(1);
});
