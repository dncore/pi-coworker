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
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { readFile, mkdir, rm, readdir, stat } from "node:fs/promises";
import { join, dirname, resolve, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runLark, userIdentityOf, countScopes, describeLarkError, dataOf } from "../../../extensions/core/lark.ts";
import { listPermissions, getPermission, validatePermission } from "../../../extensions/core/catalog.ts";
import { appendAudit } from "../../../extensions/core/config.ts";
import { resolveMageneConfig, writeMageneEnv, fetchMageneModels, mageneStatus, DEFAULT_MAGENE_BASE_URL } from "../../../extensions/core/magene.ts";
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
  "coworker_magene_setup", "coworker_magene_status",
  // personal 集群（个人效率）
  "coworker_schedule_today", "coworker_schedule_query", "coworker_schedule_create",
  "coworker_task_list", "coworker_task_create", "coworker_task_complete",
  "coworker_minutes_search", "coworker_minutes_get",
  "coworker_mail_triage", "coworker_mail_read", "coworker_mail_send",
  "coworker_contact_find",
];

// 会话/审计文件放用户目录（打包后 Resources 只读，不应写入应用包内）
const sessionDir = process.env.GUI_SESSION_DIR ?? join(homedir(), ".coworker", "gui-sessions");

// 扩展 UI 交互队列（extension_ui_request：confirm/select/input/notify 等）
let uiPending: any[] = [];

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
  auditFile: join(sessionDir, "audit.jsonl"),
  serverModeEnv: {},
} as any, {
  onUiEvent: (_openId, req) => {
    uiPending.push({ ...req, _queueAt: Date.now() });
    // 120s 兜底：无论请求是否已被前端取走，超时即自动取消，避免 pi 子进程无限等待阻塞会话
    setTimeout(() => {
      const i = uiPending.findIndex((x) => x.id === req.id);
      if (i >= 0) uiPending.splice(i, 1);
      pool.writeRaw("me", { type: "extension_ui_response", id: req.id, cancelled: true });
      console.log("[ui] timeout auto-cancel", req.id);
    }, 120_000);
    console.log("[ui] request", req.method, req.id);
  },
});

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
  // 必须 user 身份 ready（token valid）才算登录；status=missing 时 identities.user 仍存在，需显式排除
  const ready = auth.ok && u && u.status === "ready";
  out.auth = ready
    ? { loggedIn: true, name: u.userName ?? u.openId, openId: u.openId, scopes: countScopes(u.scope) }
    : { loggedIn: false, message: ready ? describeLarkError(auth) : (u?.message ?? "未登录") };
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
    // wiki +member-add 是 write（无 --yes 标志）
    argv = ["wiki", "+member-add", "--space-id", String(perm.spaceId), "--member-id", openId, "--member-type", "openid", "--member-role", perm.memberRole ?? "member", "--as", "bot"];
  } else if (perm.url || perm.token) {
    // drive +member-add 是 high-risk-write（必须 --yes）
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

// 当前时间（严格，模型必须以此判定"今天/本周/最近"）
function nowStrict(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const wk = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} ${wk}（涉及时间范围判断一律以此为准）`;
}
function guiPrompt(text: string): string {
  return [
    "你是用户的企业 AI 助手（桌面个人模式，本机用户身份）。",
    `当前时间：${nowStrict()}`,
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

// ---------------- 会话与模型管理 ----------------
let currentSessionId = "me";
let currentModel = process.env.LLM_MODEL ?? "";
const sessionModels = new Map<string, string>();

/** 会话文件名（含 .jsonl 后缀）→ 会话 id */
function sessionIdFromFile(name: string): string {
  return name.replace(/\.jsonl$/, "");
}
function sessionFile(id: string): string {
  return join(sessionDir, `${id}.jsonl`);
}

/** 解析会话文件：标题（第一条用户问题）+ 消息列表（渲染用） */
async function parseSessionFile(file: string): Promise<{ id: string; title: string; updatedAt: string; messages: Array<{ role: string; text: string }> }> {
  const id = sessionIdFromFile(basename(file));
  let title = "新对话";
  const messages: Array<{ role: string; text: string }> = [];
  try {
    const raw = await readFile(file, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let d: any;
      try { d = JSON.parse(line); } catch { continue; }
      const m = d?.message;
      if (!m?.role) continue;
      let text = (m.content ?? [])
        .filter((c: any) => c.type === "text" && typeof c.text === "string")
        .map((c: any) => c.text)
        .join("");
      if (!text) continue;
      if (m.role === "user") {
        // 剥离 guiPrompt 包装（"…\n用户：xxx"）
        const i = text.lastIndexOf("\n用户：");
        if (i >= 0) text = text.slice(i + "\n用户：".length);
        if (!title || title === "新对话") title = text.slice(0, 30) || "新对话";
      }
      messages.push({ role: m.role, text });
    }
  } catch { /* 文件缺失等 */ }
  let updatedAt = "";
  try {
    const st = await stat(file);
    updatedAt = st.mtime.toISOString();
  } catch { /* ignore */ }
  return { id, title, updatedAt, messages };
}

/** 会话列表（新→旧） */
async function listSessions(): Promise<Array<{ id: string; title: string; updatedAt: string; count: number }>> {
  try {
    const files = await readdir(sessionDir);
    const jsons = files.filter((f) => f.endsWith(".jsonl"));
    const list = await Promise.all(jsons.map((f) => parseSessionFile(join(sessionDir, f))));
    return list
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt, count: s.messages.length }));
  } catch {
    return [];
  }
}

async function ask(text: string): Promise<string> {
  if (busy) await new Promise<void>((r) => waiters.push(r));
  busy = true;
  try {
    const model = sessionModels.get(currentSessionId) ?? currentModel;
    if (model && pool.getCfgModel?.() !== model) pool.setModel?.(model);
    return await pool.ask(currentSessionId, guiPrompt(text), 180_000);
  } finally {
    busy = false;
    waiters.shift()?.();
  }
}

/** 当前用户信息（头像继承飞书） */
async function meInfo(): Promise<Record<string, any>> {
  const r = await runLark(["contact", "+get-user", "--format", "json"], { as: "user", timeoutMs: 45_000 });
  if (!r.ok) return { loggedIn: false };
  const u = r.envelope?.data?.user ?? {};
  return {
    loggedIn: true,
    name: String(u.name ?? ""),
    avatarUrl: String(u.avatar_big ?? u.avatar_thumb ?? u.avatar_url ?? ""),
  };
}

/** 登出：清 lark-cli 凭证 */
async function logout(): Promise<Record<string, any>> {
  const r = await runLark(["auth", "logout"], { as: "user", timeoutMs: 30_000 });
  return { ok: r.ok, message: r.ok ? "已登出" : describeLarkError(r) };
}

/** 用系统默认浏览器打开链接（Tauri WebView 中 window.open 会被拦截，走系统浏览器最稳） */
async function openUrl(url: string): Promise<{ ok: boolean; message?: string }> {
  const u = String(url ?? "").trim();
  if (!/^https?:\/\//i.test(u)) return { ok: false, message: "仅支持 http(s) 链接" };
  try {
    if (process.platform === "darwin") spawnSync("open", [u], { timeout: 5000 });
    else if (process.platform === "win32") spawnSync("cmd", ["/c", "start", "", u], { timeout: 5000 });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, message: String(e?.message ?? e) };
  }
}

// ---------------- 守护进程管理（复用 coworker-daemon CLI） ----------------

const DAEMON_CLI = join(REPO_ROOT, "agent", "bin", "coworker-daemon.ts");

function runDaemonCli(cmd: string): { ok: boolean; output: string } {
  const r = spawnSync(process.execPath, [DAEMON_CLI, ...cmd.split(" ")], { encoding: "utf8", timeout: 30_000 });
  return { ok: r.status === 0, output: (r.stdout || "") + (r.status !== 0 ? r.stderr || "" : "") };
}

async function daemonStatus(): Promise<Record<string, any>> {
  const r = runDaemonCli("status");
  const running = /守护进程：✅/.test(r.output);
  const busOnline = /事件总线（[^）]+）：✅/.test(r.output);
  return { ok: true, running, busOnline, output: r.output.trim() };
}

async function daemonControl(action: "start" | "stop" | "restart"): Promise<Record<string, any>> {
  const r = runDaemonCli(action);
  return { ok: r.ok, message: r.output.trim().split("\n")[0] || "完成", output: r.output.trim() };
}

/** 配置开机自启（coworker-daemon install --autostart） */
async function daemonInstallAutostart(): Promise<Record<string, any>> {
  const r = runDaemonCli("install --autostart");
  return { ok: r.ok, output: r.output.trim(), message: r.output.trim().split("\n")[0] || "完成" };
}

// ---------------- Bot 激活（IT 代建：粘贴 app_id/app_secret 绑定） ----------------

async function botActivate(appId: string, appSecret: string): Promise<Record<string, any>> {
  const id = (appId ?? "").trim();
  const secret = (appSecret ?? "").trim();
  if (!/^cli_[a-zA-Z0-9_-]{6,}$/.test(id)) return { ok: false, message: "app_id 格式不正确（应为 cli_ 开头）。" };
  if (!secret) return { ok: false, message: "缺少 app_secret。" };

  const args = ["config", "init", "--app-id", id, "--brand", "feishu", "--app-secret-stdin"];
  if (process.env.OPENCLAW_HOME || process.env.HERMES_HOME) args.push("--force-init");
  const r = await runLark(args, { timeoutMs: 120_000, input: `${secret}\n` });

  const cfg = await runLark(["config", "show"], { timeoutMs: 30_000 });
  const data: any = cfg.envelope?.data ?? cfg.envelope ?? {};
  const bound = cfg.ok && (data.appId ?? data.app_id) === id;
  appendAudit({ cluster: "onboarding", action: "bot_activate", resource: id, result: bound ? "ok" : "error" });
  if (!bound) return { ok: false, message: `绑定未确认：${describeLarkError(r)}` };
  return { ok: true, message: `✅ 个人 Bot 应用已绑定：${id}` };
}

// ---------------- Bot 开通信息（控制台三件事 + 事件总线） ----------------

async function botSetupInfo(): Promise<Record<string, any>> {
  const cfg = await runLark(["config", "show"], { timeoutMs: 30_000 });
  const data: any = cfg.envelope?.data ?? cfg.envelope ?? {};
  const appId: string | undefined = data.appId ?? data.app_id;
  const brand: string | undefined = data.brand;
  const es = await runLark(["event", "status", "--json"], { timeoutMs: 30_000 });
  const apps: any[] = dataOf(es.envelope)?.apps ?? [];
  const bus = apps.find((a: any) => String(a.app_id) === appId);
  const consoleHost = brand === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
  return {
    ok: true,
    appConfigured: cfg.ok && !!appId,
    appId,
    consoleUrl: appId ? `${consoleHost}/app/${appId}/event` : null,
    busRunning: bus?.running === true,
  };
}

// ---------------- 模型网关（magene）配置 ----------------

async function mageneSetup(baseUrl: string, apiKey: string): Promise<Record<string, any>> {
  const url = (baseUrl ?? "").trim() || resolveMageneConfig().baseUrl;
  const key = (apiKey ?? "").trim();
  if (!key) return { ok: false, message: "API Key 不能为空。" };
  if (url.includes("<") || url === DEFAULT_MAGENE_BASE_URL) return { ok: false, message: "Base URL 是占位符，需要真实网关地址。" };
  // 先验证再落盘
  try {
    const models = await fetchMageneModels(url, key);
    writeMageneEnv(url, key);
    appendAudit({ cluster: "onboarding", action: "magene_setup", resource: "magene-provider", result: "ok", detail: { modelCount: models.length } });
    return { ok: true, message: `✅ 已配置（${models.length} 个模型）。新会话/守护进程将自动使用 magene provider。`, modelCount: models.length };
  } catch (e: any) {
    return { ok: false, message: `网关验证失败（未写入）：${e?.message ?? String(e)}` };
  }
}

// ---------------- 今日聚合（个人效率） ----------------

/** 今日聚合：日程 + 未完成待办 + 收件箱摘要（只读） */
async function todayOverview(): Promise<Record<string, any>> {
  const [agenda, tasks, mail] = await Promise.allSettled([
    runLark(["calendar", "+agenda", "--format", "json"], { as: "user", timeoutMs: 45_000 }),
    runLark(["task", "+get-my-tasks", "--page-all", "--format", "json"], { as: "user", timeoutMs: 60_000 }),
    runLark(["mail", "+triage", "--format", "json"], { as: "user", timeoutMs: 45_000 }),
  ]);

  const fmtTime = (t?: string) => (t ?? "").replace("T", " ").slice(0, 16);

  const agendaR = agenda.status === "fulfilled" ? agenda.value : null;
  const schedule = agendaR?.ok
    ? (agendaR.envelope?.data?.items ?? agendaR.envelope?.data?.events ?? [])
        .map((e: any) => ({
          summary: String(e.summary ?? e.title ?? "(无标题)"),
          start: fmtTime(e.start?.date_time ?? e.start_time ?? ""),
          end: fmtTime(e.end?.date_time ?? e.end_time ?? ""),
          location: String(e.location ?? ""),
        }))
    : [];

  const tasksR = tasks.status === "fulfilled" ? tasks.value : null;
  const todos = tasksR?.ok
    ? (tasksR.envelope?.data?.items ?? [])
        .filter((t: any) => !t.completed)
        .map((t: any) => ({
          id: String(t.guid ?? t.task_id ?? ""),
          summary: String(t.summary ?? "(无标题)"),
          due: fmtTime(t.due_at ?? ""),
        }))
    : [];

  const mailR = mail.status === "fulfilled" ? mail.value : null;
  const mails = mailR?.ok
    ? (mailR.envelope?.messages ?? mailR.envelope?.data?.messages ?? [])
        .slice(0, 6)
        .map((m: any) => ({
          messageId: String(m.message_id ?? ""),
          subject: String(m.subject ?? "(无主题)"),
          from: String(m.from ?? ""),
          date: String(m.date ?? ""),
        }))
    : [];

  return {
    ok: true,
    date: new Date().toISOString().slice(0, 10),
    schedule,
    todos,
    mails,
  };
}

/** 完成一条待办（写，前端确认后调用；审计） */
async function completeTask(taskId: string): Promise<Record<string, any>> {
  if (!taskId) return { ok: false, message: "taskId 不能为空" };
  const r = await runLark(["task", "+complete", "--task-id", taskId], { as: "user", timeoutMs: 60_000 });
  if (!r.ok) return { ok: false, message: describeLarkError(r) };
  appendAudit({ cluster: "personal", action: "task_complete", resource: taskId, result: "ok" });
  return { ok: true, message: "任务已完成" };
}

// ---------------- portal 模型网关自动配置 ----------------
// portal：公司 AI provider 鉴权门户（飞书扫码登录 → 控制台 → API key）。
// 流程：打开 portal → 用户扫码 → 控制台点「API key」弹窗复制 → 本机剪贴板监听捕获 → 自动写入 magene provider。
const PORTAL_URL = process.env.PORTAL_URL ?? "http://192.168.188.61:8090/portal/";

function readClipboardText(): string {
  try {
    if (process.platform === "darwin") {
      const r = spawnSync("/usr/bin/pbpaste", [], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
      return (r.stdout || "").replace(/\0/g, "").trim();
    }
    if (process.platform === "win32") {
      const r = spawnSync("powershell", ["-NoProfile", "-Command", "Get-Clipboard -Raw"], { encoding: "utf8", timeout: 5000 });
      return (r.stdout || "").trim();
    }
  } catch {
    /* 读剪贴板失败视为空 */
  }
  return "";
}

/** 启发式：形如 API key 的字符串（长度适中、无空白/中文） */
function looksLikeApiKey(s: string): boolean {
  if (s.length < 20 || s.length > 256) return false;
  if (/\s/.test(s) || /[\u4e00-\u9fff\uFF00-\uFFEF]/.test(s)) return false;
  return true;
}

const clipWatch = {
  active: false,
  baseline: "",
  found: "",
  startedAt: 0,
  timer: undefined as NodeJS.Timeout | undefined,
};

function portalOpen(): { ok: boolean; message?: string } {
  try {
    if (process.platform === "darwin") spawnSync("open", [PORTAL_URL], { timeout: 5000 });
    else if (process.platform === "win32") spawnSync("cmd", ["/c", "start", "", PORTAL_URL], { timeout: 5000 });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, message: String(e ?? e?.message) };
  }
}

function portalWatchStart(): { ok: boolean } {
  clipWatch.baseline = readClipboardText();
  clipWatch.found = "";
  clipWatch.active = true;
  clipWatch.startedAt = Date.now();
  if (clipWatch.timer) clearInterval(clipWatch.timer);
  clipWatch.timer = setInterval(() => {
    if (!clipWatch.active) {
      clearInterval(clipWatch.timer);
      return;
    }
    if (Date.now() - clipWatch.startedAt > 120_000) {
      clipWatch.active = false;
      clearInterval(clipWatch.timer);
      return;
    }
    const cur = readClipboardText();
    if (cur && cur !== clipWatch.baseline && looksLikeApiKey(cur)) {
      clipWatch.found = cur;
      clipWatch.active = false;
      clearInterval(clipWatch.timer);
    }
  }, 2000);
  return { ok: true };
}

function portalWatchStatus(): Record<string, any> {
  const k = clipWatch.found;
  return {
    active: clipWatch.active,
    found: !!k,
    // 127.0.0.1 本地回环服务；key 仅在本机传输（与 /magene/setup 同边界）
    key: k || "",
    keyPreview: k ? `${k.slice(0, 6)}…${k.slice(-4)}` : "",
    portalUrl: PORTAL_URL,
    mageneBaseUrl: resolveMageneConfig().baseUrl,
  };
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
    if (path === "/today" && req.method === "GET") return json(res, 200, await todayOverview());
    if (path === "/sessions" && req.method === "GET") return json(res, 200, { ok: true, sessions: await listSessions() });
    if (path === "/me" && req.method === "GET") return json(res, 200, await meInfo());
    if (path === "/models" && req.method === "GET") {
      // 可用模型：magene 网关已配置则拉取列表
      let available: string[] = [];
      let baseUrl = "";
      try {
        const cfg = resolveMageneConfig();
        if (cfg.apiKey && !cfg.baseUrl.includes("<")) {
          available = await fetchMageneModels(cfg.baseUrl, cfg.apiKey, 8000);
          baseUrl = cfg.baseUrl;
        }
      } catch { /* 网关不可达则空列表 */ }
      const used = sessionModels.get(currentSessionId) ?? currentModel;
      return json(res, 200, { ok: true, available, current: used || "", baseUrl });
    }
    if (path === "/today/task-complete" && req.method === "POST") {
      const body = await readBody(req);
      return json(res, 200, await completeTask(String(body?.taskId ?? "")));
    }
    if (path === "/perm/scan" && req.method === "GET") return json(res, 200, await permScan());

    // 守护进程管理（复用 agent/bin/coworker-daemon CLI）
    if (path === "/daemon/status" && req.method === "GET") return json(res, 200, await daemonStatus());
    if (path === "/magene/status" && req.method === "GET") return json(res, 200, await mageneStatus());
    if (req.method === "POST") {
      const body = await readBody(req);
      if (path === "/daemon/start") return json(res, 200, await daemonControl("start"));
      if (path === "/daemon/stop") return json(res, 200, await daemonControl("stop"));
      if (path === "/daemon/restart") return json(res, 200, await daemonControl("restart"));
      if (path === "/daemon/install") return json(res, 200, await daemonInstallAutostart());
      if (path === "/magene/setup") {
        return json(res, 200, await mageneSetup(String(body?.baseUrl ?? ""), String(body?.apiKey ?? "")));
      }
      if (path === "/portal/open") return json(res, 200, portalOpen());
      if (path === "/portal/watch-start") return json(res, 200, portalWatchStart());
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
        return json(res, 200, { ok: true, answer, sessionId: currentSessionId });
      }
      if (path === "/session/new") {
        currentSessionId = "s-" + randomUUID().slice(0, 8);
        sessionModels.set(currentSessionId, currentModel);
        return json(res, 200, { ok: true, sessionId: currentSessionId });
      }
      if (path === "/session/open") {
        const id = String(body?.sessionId ?? "");
        if (!id) return json(res, 400, { ok: false, message: "sessionId 不能为空" });
        const data = await parseSessionFile(sessionFile(id));
        currentSessionId = id;
        sessionModels.set(id, currentModel);
        return json(res, 200, { ok: true, sessionId: id, title: data.title, messages: data.messages });
      }
      if (path === "/session/delete") {
        const id = String(body?.sessionId ?? "");
        if (!id) return json(res, 400, { ok: false, message: "sessionId 不能为空" });
        try {
          await rm(sessionFile(id), { force: true });
          pool.closeSession(id);
          if (currentSessionId === id) currentSessionId = "me";
        } catch (e: any) {
          return json(res, 500, { ok: false, message: String(e?.message ?? e) });
        }
        return json(res, 200, { ok: true });
      }
      if (path === "/model") {
        const model = String(body?.model ?? "").trim();
        if (!model) return json(res, 400, { ok: false, message: "model 不能为空" });
        currentModel = model;
        sessionModels.set(currentSessionId, model);
        pool.setModel(model);
        pool.closeSession(currentSessionId); // 切换模型即时生效（下一条 resume 新模型）
        return json(res, 200, { ok: true, model });
      }
      if (path === "/auth/logout") {
        return json(res, 200, await logout());
      }
      if (path === "/open-url") {
        return json(res, 200, await openUrl(String(body?.url ?? "")));
      }
      if (path === "/interaction/respond") {
        const id = String(body?.id ?? "");
        if (!id) return json(res, 400, { ok: false, message: "id 不能为空" });
        const payload: Record<string, unknown> = { type: "extension_ui_response", id };
        if (body?.confirmed !== undefined) payload.confirmed = !!body.confirmed;
        if (body?.value !== undefined) payload.value = String(body.value);
        if (body?.cancelled) payload.cancelled = true;
        pool.writeRaw("me", payload);
        uiPending = uiPending.filter((x) => x.id !== id);
        console.log("[ui] respond", id, JSON.stringify(payload));
        return json(res, 200, { ok: true });
      }
    }

    // portal 状态（GET）
    if (path === "/portal/watch-status" && req.method === "GET") return json(res, 200, portalWatchStatus());
    // 扩展 UI 交互（确认/选择/输入卡片）
    if (path === "/interaction/poll" && req.method === "GET") {
      const now = Date.now();
      const dialogs = uiPending.filter((x) => x.method !== "notify");
      const notifs = uiPending.filter((x) => x.method === "notify");
      // 前端取走 notify 即消费；dialog 保留到 respond 或超时
      uiPending = uiPending.filter((x) => x.method === "notify" ? false : now - (x._queueAt || 0) <= 60_000);
      // 超时未响应的 dialog：自动取消并出队
      const overdue = dialogs.filter((x) => now - (x._queueAt || 0) > 60_000);
      for (const d of overdue) pool.writeRaw("me", { type: "extension_ui_response", id: d.id, cancelled: true });
      return json(res, 200, { items: [...dialogs, ...notifs] });
    }
    // Bot 开通信息（控制台三件事 + 事件总线）
    if (path === "/bot/setup-info" && req.method === "GET") return json(res, 200, await botSetupInfo());
    // Bot 激活（IT 代建）
    if (req.method === "POST" && path === "/bot/activate") {
      const body = await readBody(req);
      return json(res, 200, await botActivate(String(body?.appId ?? ""), String(body?.appSecret ?? "")));
    }

    // 二维码图片
    if (path === "/qr" && req.method === "GET") {
      const url = u.searchParams.get("u") ?? "";
      if (!/^https?:\/\//.test(url)) return json(res, 400, { ok: false, message: "无效链接" });
      const dir = sessionDir;
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
