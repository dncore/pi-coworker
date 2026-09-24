/**
 * 授权分发（dispenser）端到端测试（封闭，无外网）：
 *   · 本地 http 假网关（/models）+ 隔离 HOME；
 *   · 覆盖 7 个 agent 的 plan → apply → status → 幂等 → restore 全链路；
 *   · 验证门禁：无 --yes 必须 confirm_required（退出码 2）；密钥不进 stdout/审计；写前备份。
 * 运行：node scripts/dispenser-test.ts（被 npm run smoke 收编）
 */
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
function ok(name: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${extra ? `（${extra}）` : ""}`);
  if (!cond) failures++;
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const CLI = join(repoRoot, "dispenser", "cli.ts");

const root = mkdtempSync(join(tmpdir(), "cw-dispenser-"));
const home = join(root, "home");
const piDir = join(home, ".coworker", "pi-agent");
const KEY = "sk-test-SECRET-abcdef1234567890";

// ---------- 假网关（独立进程：测试本体是同步 spawnSync，同进程 http server 会被卡死） ----------
const MODELS = ["deepseek-v4-pro", "deepseek-v4-flash", "qwen3.8-max", "claude-sonnet-5"];
const gwScript = join(root, "gateway.mjs");
writeFileSync(
  gwScript,
  `import { createServer } from "node:http";
const models = ${JSON.stringify(MODELS)};
const s = createServer((req, res) => {
  if ((req.url ?? "").startsWith("/api/v1/models")) {
    if (!String(req.headers.authorization ?? "").startsWith("Bearer ")) { res.writeHead(401).end("unauthorized"); return; }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: models.map((id) => ({ id })) }));
    return;
  }
  res.writeHead(404).end("nf");
});
s.listen(0, "127.0.0.1", () => console.log("PORT " + s.address().port));
`,
);
const gateway = spawn(process.execPath, [gwScript], { stdio: ["ignore", "pipe", "inherit"] });
const port = await new Promise<number>((resolvePort) => {
  gateway.stdout!.on("data", (d: Buffer) => {
    const m = /PORT (\d+)/.exec(String(d));
    if (m) resolvePort(Number(m[1]));
  });
});
const baseUrl = `http://127.0.0.1:${port}/api/v1`;

// ---------- 隔离 HOME + app 凭证（模拟 app 内已取 Key） ----------
mkdirSync(join(piDir, "extensions", "magene-provider"), { recursive: true });
writeFileSync(
  join(piDir, "extensions", "magene-provider", ".env"),
  `MAGENE_BASE_URL=${baseUrl}\nMAGENE_API_KEY=${KEY}\n`,
);

function cli(args: string[]): { code: number; json: any; raw: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: piDir, PATH: "/usr/bin:/bin" },
    timeout: 60_000,
  });
  const raw = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  let json: any = null;
  try {
    json = JSON.parse((r.stdout ?? "").trim().split("\n").pop() ?? "null");
  } catch {
    json = null;
  }
  return { code: r.status ?? -1, json, raw };
}

const read = (p: string): string => (existsSync(p) ? readFileSync(p, "utf8") : "");

console.log("== 只读命令：doctor / agents / status ==");
{
  const d = cli(["doctor"]);
  ok("doctor 成功且网关可达", d.json?.ok === true && d.json?.reachable === true, d.json?.summary);
  ok("doctor 报模型数", d.json?.models === MODELS.length);
  ok("doctor 掩码密钥且不回显明文", !!d.json?.gateway?.apiKeyMasked && !d.raw.includes(KEY), String(d.json?.gateway?.apiKeyMasked));

  const a = cli(["agents"]);
  ok("agents 列出 7 个 agent", (a.json?.agents ?? []).length === 7);
  ok("隔离 HOME 下不误报已安装", (a.json?.agents ?? []).every((x: any) => x.installed === false));

  const s = cli(["status", "--agent", "codex"]);
  ok("status 只读可见（未安装也返回问题清单）", s.json?.ok === true && Array.isArray(s.json?.issues), s.json?.summary?.slice(0, 70));
}

console.log("== 门禁：写操作必须 --yes（confirm_required 退出码 2） ==");
{
  const r = cli(["apply", "--agent", "claude"]);
  ok("无 --yes 被拒绝", r.json?.ok === false && r.json?.code === "confirm_required", `exit=${r.code}`);
  ok("退出码为 2", r.code === 2);
  ok("拒绝时附计划", Array.isArray(r.json?.plan) && r.json.plan.length > 0);
  ok("未落盘", !existsSync(join(home, ".claude", "settings.json")));
}

console.log("== Claude Code：apply → 幂等 → restore ==");
{
  const settings = join(home, ".claude", "settings.json");
  mkdirSync(dirname(settings), { recursive: true });
  writeFileSync(settings, JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }, null, 2) + "\n");

  const p = cli(["plan", "--agent", "claude"]);
  ok("plan 不写盘", read(settings).includes("permissions") && !read(settings).includes("ANTHROPIC_BASE_URL"));

  const r = cli(["apply", "--agent", "claude", "--yes"]);
  ok("apply 成功", r.json?.ok === true, r.json?.summary);
  const doc = JSON.parse(read(settings));
  ok("写入 ANTHROPIC_BASE_URL（/api/v1 → /api/anthropic）", doc.env?.ANTHROPIC_BASE_URL === `${baseUrl.replace("/api/v1", "")}/api/anthropic`, doc.env?.ANTHROPIC_BASE_URL);
  ok("写入 AUTH_TOKEN", doc.env?.ANTHROPIC_AUTH_TOKEN === KEY);
  ok("保留原有 permissions", Array.isArray(doc.permissions?.allow));
  ok("角色模型齐全", ["ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"].every((k) => doc.env?.[k]));
  ok("stdout 无明文密钥", !r.raw.includes(KEY));
  const backups = cli(["backups", "--agent", "claude"]);
  ok("写前有备份", (backups.json?.files?.[0]?.backups ?? []).length >= 1);

  const again = cli(["apply", "--agent", "claude", "--yes"]);
  ok("重复 apply 幂等（无变更）", again.json?.ok === true && /无变化/.test(again.json?.summary ?? ""), again.json?.summary);

  const st = cli(["status", "--agent", "claude"]);
  ok("status 无遗留问题", (st.json?.issues ?? []).length === 0, JSON.stringify(st.json?.issues));

  const rs = cli(["restore", "--agent", "claude", "--yes"]);
  ok("restore 成功", rs.json?.ok === true, rs.json?.summary);
  ok("还原回原内容（permissions 且无 ANTHROPIC）", read(settings).includes("permissions") && !read(settings).includes("ANTHROPIC_BASE_URL"));
  ok("还原前再备份 .bak-pre-restore", execFileSync("ls", [dirname(settings)]).toString().includes(".bak-pre-restore-"));
}

console.log("== Codex：config.toml + models.json（白名单可见/隐藏） ==");
{
  const cfg = join(home, ".codex", "config.toml");
  mkdirSync(dirname(cfg), { recursive: true });
  writeFileSync(cfg, "# 用户自己的注释\napproval_policy = \"never\"\n");

  const r = cli(["apply", "--agent", "codex", "--yes"]);
  ok("apply 成功", r.json?.ok === true, r.json?.summary);
  const text = read(cfg);
  ok("写 provider 段（base_url + wire_api=responses）", text.includes("[model_providers.magene]") && text.includes(`base_url = "${baseUrl}"`) && text.includes('wire_api = "responses"'));
  ok("requires_openai_auth=false", /requires_openai_auth = false/.test(text));
  ok("model_catalog_json 指向 models.json", /model_catalog_json = .*models\.json/.test(text));
  ok("用户原有键保留", text.includes("approval_policy") && text.includes("# 用户自己的注释"));
  const catalog = JSON.parse(read(join(home, ".codex", "models.json")));
  const listIds = catalog.models.filter((m: any) => m.visibility === "list").map((m: any) => m.slug);
  ok("白名单模型可见（deepseek-v4-pro）", listIds.includes("deepseek-v4-pro"), listIds.join(","));
  ok("非白名单模型仅隐藏（claude-sonnet-5 不在 list）", !listIds.includes("claude-sonnet-5"));
  ok("隐藏项仍在目录里（codex -m 可用）", catalog.models.some((m: any) => m.slug === "claude-sonnet-5"));
  ok("stdout 无明文密钥", !r.raw.includes(KEY));

  const again = cli(["apply", "--agent", "codex", "--yes"]);
  ok("重复 apply 幂等", /无变化|已是最新/.test(again.json?.summary ?? ""), again.json?.summary);

  const st = cli(["status", "--agent", "codex"]);
  ok("status 无遗留问题", (st.json?.issues ?? []).length === 0, JSON.stringify(st.json?.issues));

  const m = cli(["models", "--agent", "codex", "--yes"]);
  ok("models 仅刷新目录（不报错）", m.json?.ok === true, m.json?.summary);
}

console.log("== 其余 agent：reasonix / dsh / grok / omp / opencode ==");
{
  const cases: Array<{ id: string; file: string; marker: string[] }> = [
    { id: "reasonix", file: join(home, ".reasonix", "config.toml"), marker: ["[[providers]]", "base_url", "magene"] },
    { id: "dsh", file: join(home, ".dsh", "settings.yaml"), marker: ["llm-pi-ai", "providers", "magene"] },
    { id: "grok", file: join(home, ".grok", "config.toml"), marker: ["model_providers.magene", "base_url"] },
    { id: "omp", file: join(home, ".omp", "agent", "models.yml"), marker: ["providers", "magene"] },
    { id: "opencode", file: join(home, ".config", "opencode", "opencode.json"), marker: ['"provider"', "magene"] },
  ];
  for (const c of cases) {
    const r = cli(["apply", "--agent", c.id, "--yes"]);
    const text = read(c.file);
    ok(`${c.id}：apply 成功且落到 ${c.file.replace(home, "~")}`, r.json?.ok === true && c.marker.every((mk) => text.includes(mk)), r.json?.summary?.slice(0, 90));
    ok(`${c.id}：stdout 无明文密钥`, !r.raw.includes(KEY));
    const st = cli(["status", "--agent", c.id]);
    ok(`${c.id}：status 已接入`, (st.json?.status?.providerConfigured ?? st.json?.status?.providerModels > 0) === true, JSON.stringify(st.json?.issues));
    const models = cli(["models", "--agent", c.id, "--yes"]);
    ok(`${c.id}：models 仅刷新可用`, models.json?.ok === true, models.json?.summary?.slice(0, 60));
  }
  // 密钥文件权限
  const reasonixEnv = join(home, ".reasonix", ".env");
  const mode = (statSync(reasonixEnv).mode & 0o777).toString(8).padStart(3, "0");
  ok("reasonix 凭据 .env 为 0600", mode === "600", mode);
  const ocAuth = join(home, ".local", "share", "opencode", "auth.json");
  ok("opencode auth.json 已写且含 provider", read(ocAuth).includes("magene"));
}

console.log("== 审计与修复 ==");
{
  const audit = join(home, ".coworker", "audit", "dispenser.jsonl");
  const text = read(audit);
  ok("审计已落盘", text.trim().length > 0);
  ok("审计含动作记录", text.includes('"action"') && text.includes("restore"));
  ok("审计无明文密钥", !text.includes(KEY));

  // 修复：把 claude settings 弄坏（去掉 base url）→ repair 检测并恢复
  const settings = join(home, ".claude", "settings.json");
  const doc = JSON.parse(read(settings));
  delete doc.env;
  writeFileSync(settings, JSON.stringify(doc, null, 2));
  const before = cli(["status", "--agent", "claude"]);
  ok("损坏后 status 报问题", (before.json?.issues ?? []).length > 0, JSON.stringify(before.json?.issues));
  const noConfirm = cli(["repair", "--agent", "claude"]);
  ok("repair 无 --yes 被拒绝", noConfirm.json?.code === "confirm_required");
  const r = cli(["repair", "--agent", "claude", "--yes"]);
  ok("repair 修复成功", r.json?.ok === true && (r.json?.issuesRemaining ?? []).length === 0, r.json?.summary?.slice(0, 90));

  // 非法 JSON → 明确引导还原而非硬改
  writeFileSync(settings, "{ 坏 JSON");
  const bad = cli(["repair", "--agent", "claude", "--yes"]);
  ok("非法 JSON 时 repair 返回 needs_restore", bad.json?.code === "needs_restore", bad.json?.message);
  const st = cli(["status", "--agent", "claude"]);
  ok("status 标记 blocked", st.json?.blocked === true);
}

console.log("== 自定义网关（密钥走 stdin，不进 argv） ==");
{
  const r = spawnSync(process.execPath, [CLI, "doctor", "--gateway", "custom", "--base-url", baseUrl, "--api-key-stdin"], {
    encoding: "utf8",
    input: KEY + "\n",
    env: { HOME: home, PI_CODING_AGENT_DIR: piDir, PATH: "/usr/bin:/bin" },
  });
  const json = JSON.parse((r.stdout ?? "").trim());
  ok("自定义网关 doctor 可用", json?.ok === true && json?.reachable === true, json?.summary?.slice(0, 80));
  ok("密钥不出现在输出", !`${r.stdout}${r.stderr}`.includes(KEY));
  const missing = spawnSync(process.execPath, [CLI, "doctor", "--gateway", "custom", "--base-url", baseUrl], {
    encoding: "utf8",
    env: { HOME: home, PI_CODING_AGENT_DIR: piDir, PATH: "/usr/bin:/bin" },
  });
  ok("自定义网关缺密钥时报错而非静默", (missing.stdout ?? "").includes("api-key-stdin"));
}

console.log("== 工具层门禁：先看后写（extensions/core/dispenser.ts） ==");
{
  const { checkPlanGate, clearPlan, recordPlan, renderDispenseResult } = await import("../extensions/core/dispenser.ts");
  ok("只读命令不需要计划", checkPlanGate("status", "claude", false) === null);
  ok("doctor/agents 也放行", checkPlanGate("agents", "", false) === null && checkPlanGate("doctor", "", false) === null);
  ok("apply 缺计划 → 拒绝并提示先 plan", /plan/.test(checkPlanGate("apply", "claude", false) ?? ""));
  ok("models/repair 同样受门禁", /plan/.test(checkPlanGate("models", "claude", false) ?? "") && /plan/.test(checkPlanGate("repair", "claude", false) ?? ""));
  recordPlan("plan", "claude");
  ok("出过计划后 apply 放行", checkPlanGate("apply", "claude", false) === null);
  ok("门禁按 agent 隔离", checkPlanGate("apply", "codex", false) !== null);
  ok("restore 要求先看备份而非计划", /backups/.test(checkPlanGate("restore", "claude", false) ?? ""));
  recordPlan("backups", "claude");
  ok("看过备份后 restore 放行", checkPlanGate("restore", "claude", false) === null);
  ok("显式确认可越过（工具内 confirmWrite 仍把门）", checkPlanGate("apply", "codex", true) === null);
  clearPlan("claude");
  ok("写成功后计划作废（需重新先看后写）", checkPlanGate("apply", "claude", false) !== null);
  const text = renderDispenseResult(
    { summary: "s", plan: [{ path: "/x", changes: ["a"] }], written: ["f（备份 b）"], issues: ["i"], nextSteps: ["重启 X"], code: "confirm_required" },
    "",
  );
  ok("渲染包含计划/写入/问题/生效/确认提示", ["/x", "备份 b", "i", "重启 X", "confirm=true"].every((k) => text.includes(k)), text.slice(0, 80));
}

gateway.kill();
rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "\n全部通过 ✅" : `\n${failures} 个失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
