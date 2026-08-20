/**
 * 桌面 GUI 本地后端（员工本机，用户身份）。
 *
 * 架构：Tauri 壳 → 本机 HTTP(127.0.0.1:PORT) → 本后端
 *   - 结构化能力（env/login/perm）直接复用 coworker 内核（extensions/core）
 *   - 对话问答走 pi --mode rpc（全 coworker 工具，禁本地工具，用户身份）
 *
 * 安全：仅监听 127.0.0.1；CORS 放开（本机服务）；写操作需前端确认后带 confirm。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, mkdir, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runLark, userIdentityOf, countScopes, describeLarkError } from "../../../extensions/core/lark.ts";
import { listPermissions, getPermission, validatePermission } from "../../../extensions/core/catalog.ts";
import { appendAudit } from "../../../extensions/core/config.ts";
import { PiAgentPool } from "../../../agent/src/agent/pool.ts";

const here = dirname(fileURLToPath(import.meta.url)); // gui/backend/src
export const REPO_ROOT = resolve(here, "..", "..", "..");

const PORT = parseInt(process.env.GUI_PORT ?? "17331", 10);
const PI_BIN = process.env.PI_BIN ?? "pi";
const LLM_PROVIDER = process.env.LLM_PROVIDER ?? "google";
const LLM_MODEL = process.env.LLM_MODEL ?? "";

/** GUI 允许的团队工具（全部 coworker 工具，禁本地工具） */
const GUI_TOOLS = [
  "coworker_check_env", "coworker_config_init", "coworker_auth_login", "coworker_auth_complete", "coworker_auth_status",
  "coworker_perm_list", "coworker_perm_check", "coworker_perm_apply", "coworker_perm_status", "coworker_perm_my", "coworker_perm_scan",
  "coworker_knowledge_search", "coworker_knowledge_fetch",
  "coworker_skill_sync",
];

const sessionDir = process.env.GUI_SESSION_DIR ?? join(REPO_ROOT, ".gui-sessions");

const pool = new PiAgentPool({
  mode: "local",
  piBin: PI_BIN,
  provider: LLM_PROVIDER,
  model: LLM_MODEL,
  thinkingLevel: "medium",
  extensionPath: join(REPO_ROOT, "extensions", "index.ts"),
  allowedTools: GUI_TOOLS,
  noBuiltinTools: true,
  sessionDir,
  maxAgents: 4,
  agentIdleTtlMs: 20 * 60_000,
  rateLimit: { windowMs: 60_000, max: 60 },
  larkEventKeys: { message: "", card: "" },
  larkEnv: { LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" },
  auditFile: join(REPO_ROOT, ".gui-sessions", "audit.jsonl"),
  serverModeEnv: {},
} as any);

// ---------------- 结构化能力（复用 coworker 内核） ----------------

async function checkEnv(): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  const ver = await runLark(["--version"], { timeoutMs: 15_000 });
  if (ver.exitCode === -1) {
    out.larkCli = { installed: false, message: "lark-cli 未安装，请运行 npm install -g @larksuite/cli" };
    return out;
  }
  out.larkCli = { installed: true, version: (ver.stdout || ver.stderr).trim().split("\n")[0] };
  const cfg = await runLark(["config", "show"], { timeoutMs: 30_000 });
  out.config = { initialized: cfg.ok };
  const auth = await runLark(["auth", "status", "--json"], { timeoutMs: 60_000 });
  const u = userIdentityOf(auth.envelope);
  out.auth = auth.ok && u
    ? { loggedIn: true, name: u.userName ?? u.openId, openId: u.openId, scopes: countScopes(u.scope) }
    : { loggedIn: false, message: describeLarkError(auth) };
  return out;
}

async function startLogin(scopes?: string, domains?: string): Promise<Record<string, any>> {
  const args = ["auth", "login", "--no-wait", "--json"];
  if (scopes) args.push("--scope", scopes);
  if (domains) args.push("--domain", domains);
  if (!scopes && !domains) args.push("--domain", "wiki,drive,base,docs,contact,approval");
  const r = await runLark(args, { timeoutMs: 60_000 });
  const d = r.envelope?.data ?? r.envelope;
  const url = d?.verification_url ?? d?.verification_uri_complete;
  const deviceCode = d?.device_code ?? d?.deviceCode;
  if (!r.ok || !url || !deviceCode) return { ok: false, message: describeLarkError(r) };
  return { ok: true, url, deviceCode, qrUrl: `/qr?u=${encodeURIComponent(url)}` };
}

async function completeLogin(deviceCode: string): Promise<Record<string, any>> {
  const r = await runLark(["auth", "login", "--device-code", deviceCode, "--json"], { timeoutMs: 240_000 });
  if (!r.ok) return { ok: false, message: describeLarkError(r) };
  const env = await checkEnv();
  return { ok: true, identity: env.auth };
}

async function permScan(): Promise<Record<string, any>> {
  const r = await runLark(["wiki", "+space-list", "--format", "json"], { as: "user", timeoutMs: 60_000 });
  const spaces: any[] = r.envelope?.data?.spaces ?? [];
  const roles: Record<string, string> = {};
  const me = (await checkEnv()).auth?.openId;
  await Promise.all(
    spaces.slice(0, 20).map(async (s: any) => {
      const sid = String(s.space_id);
      try {
        const m = await runLark(["wiki", "+member-list", "--space-id", sid, "--page-all", "--format", "json"], { as: "user", timeoutMs: 60_000 });
        const members: any[] = m.envelope?.data?.members ?? [];
        const hit = members.find((x) => String(x.member_id) === String(me));
        roles[sid] = hit?.member_role === "admin" ? "admin" : hit?.member_role === "member" ? "member" : "仅可见";
      } catch {
        roles[sid] = "未知";
      }
    }),
  );
  return { spaces: spaces.map((s: any) => ({ name: s.name, spaceId: s.space_id, visibility: s.visibility, role: roles[String(s.space_id)] ?? "仅可见" })) };
}

/** 申请权限：self-service → bot 直授（写前需 confirm）；approval/owner-request → 指引 */
async function applyPermission(id: string, confirm: boolean): Promise<Record<string, any>> {
  const perm = getPermission(id);
  if (!perm) return { ok: false, message: `目录中不存在权限「${id}」` };
  const issues = validatePermission(perm);
  if (issues.length) return { ok: false, message: `目录配置不完整：${issues.join("；")}` };

  if (perm.grant !== "self-service") {
    appendAudit({ cluster: "permissions", action: "perm_apply", resource: id, result: "pending", detail: { grant: perm.grant } });
    return {
      ok: false,
      needOther: true,
      message: perm.grant === "approval"
        ? "该权限需走审批，请在飞书审批中心发起（或联系管理员）。"
        : "该权限需向文档 owner 申请，请使用飞书文档内「申请访问」功能。",
    };
  }
  if (!confirm) {
    return { ok: false, needConfirm: true, message: `将给当前用户授予「${perm.name}」，确认执行？` };
  }

  const env = await checkEnv();
  const openId = env.auth?.openId;
  if (!openId) return { ok: false, message: "未登录，无法获取你的身份。" };

  let argv: string[];
  if (perm.type === "wiki-space" && perm.spaceId) {
    argv = ["wiki", "+member-add", "--space-id", String(perm.spaceId), "--member-id", openId, "--member-type", "openid", "--member-role", perm.memberRole ?? "member", "--as", "bot", "--yes"];
  } else if (perm.url || perm.token) {
    argv = ["drive", "+member-add", "--token", perm.url ?? perm.token ?? "", ...(perm.targetType ? ["--type", perm.targetType] : []), "--member-id", openId, "--member-type", "openid", "--perm", perm.perm ?? "view", "--as", "bot", "--yes"];
  } else {
    return { ok: false, message: "目录配置不完整（缺少 spaceId/url）。" };
  }
  const r = await runLark(argv, { timeoutMs: 60_000 });
  appendAudit({ cluster: "permissions", action: "perm_apply", resource: id, result: r.ok ? "ok" : "error", detail: { grant: "self-service", openId } });
  if (!r.ok) return { ok: false, message: describeLarkError(r) };
  return { ok: true, message: `✅ 「${perm.name}」已开通。` };
}

// ---------------- 对话（pi RPC，全工具） ----------------

function guiPrompt(text: string): string {
  return [
    "你是用户的企业 AI 助手（桌面个人模式，本机用户身份）。",
    "规则：",
    "1. 企业问答：只用 coworker_knowledge_search / coworker_knowledge_fetch，回答附来源；找不到就明说，不编造。",
    "2. 环境/登录：用 coworker_check_env / coworker_auth_status 等；登录走 split-flow（先给链接，用户授权后再完成）。",
    "3. 权限：用 coworker_perm_list / coworker_perm_scan / coworker_perm_check；申请前先向用户确认。",
    "4. 涉及薪资/个人信息/机密：拒绝并提示合规边界。",
    "5. 中文回答，简洁。",
    "",
    `用户：${text}`,
  ].join("\n");
}

let busy = false;
const waiters: Array<() => void> = [];

async function ask(text: string): Promise<string> {
  if (busy) await new Promise<void>((r) => waiters.push(r));
  busy = true;
  try {
    return await pool.ask("me", guiPrompt(text), 180_000);
  } finally {
    busy = false;
    waiters.shift()?.();
  }
}

// ---------------- HTTP 服务 ----------------

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => {
      try {
        resolve(d ? JSON.parse(d) : {});
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const path = u.pathname;
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type" });
      res.end();
      return;
    }
    if (path === "/health") return json(res, 200, { ok: true });
    if (path === "/env" && req.method === "GET") return json(res, 200, await checkEnv());
    if (path === "/perm/list" && req.method === "GET") {
      return json(res, 200, { ok: true, permissions: listPermissions() });
    }
    if (path === "/perm/scan" && req.method === "GET") return json(res, 200, await permScan());

    if (req.method === "POST") {
      const body = await readBody(req);
      if (path === "/login") {
        return json(res, 200, await startLogin(body?.scopes, body?.domains));
      }
      if (path === "/login/complete") {
        return json(res, 200, await completeLogin(String(body?.deviceCode ?? "")));
      }
      if (path === "/perm/apply") {
        return json(res, 200, await applyPermission(String(body?.id ?? ""), body?.confirm === true));
      }
      if (path === "/ask") {
        const text = String(body?.text ?? "").trim();
        if (!text) return json(res, 400, { ok: false, message: "text 为空" });
        const answer = await ask(text);
        return json(res, 200, { ok: true, answer });
      }
    }

    // 二维码图片
    if (path === "/qr" && req.method === "GET") {
      const url = u.searchParams.get("u") ?? "";
      if (!/^https?:\/\//.test(url)) return json(res, 400, { ok: false, message: "无效链接" });
      const dir = join(REPO_ROOT, ".gui-sessions");
      await mkdir(dir, { recursive: true });
      const name = `qr-${Date.now()}.png`;
      const qr = await runLark(["auth", "qrcode", url, "--output", name], { timeoutMs: 30_000, cwd: dir });
      if (!qr.ok) return json(res, 500, { ok: false, message: "二维码生成失败" });
      const buf = await readFile(join(dir, name));
      await rm(join(dir, name), { force: true });
      res.writeHead(200, { "content-type": "image/png", "access-control-allow-origin": "*" });
      res.end(buf);
      return;
    }

    json(res, 404, { ok: false, message: `未找到 ${path}` });
  } catch (e: any) {
    json(res, 500, { ok: false, message: e?.message ?? String(e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`✅ GUI 后端已启动 http://127.0.0.1:${PORT}`);
});

process.on("SIGINT", async () => {
  await pool.closeAll();
  server.close(() => process.exit(0));
});
