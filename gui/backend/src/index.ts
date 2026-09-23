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
import { spawnSync, spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { readFile, mkdir, rm, readdir, stat } from "node:fs/promises";
import { readdirSync, renameSync, mkdirSync, copyFileSync, chmodSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { runLark, userIdentityOf, countScopes, describeLarkError, dataOf, LARK_ENV, resolveLarkCli, resetLarkCliCache } from "../../../extensions/core/lark.ts";
import { listPermissions, getPermission, validatePermission } from "../../../extensions/core/catalog.ts";
import { companySkillsDir } from "../../../extensions/core/skillsync.ts";
import { appendAudit } from "../../../extensions/core/config.ts";
import { writeKnowledgeConfig, loadKnowledge } from "../../../extensions/core/knowledge.ts";
import { resolveMageneConfig, writeMageneEnv, fetchMageneModels, mageneStatus, defaultProviderName, DEFAULT_MAGENE_BASE_URL } from "../../../extensions/core/magene.ts";
import { PiAgentPool } from "../../../agent/src/agent/pool.ts";
import { resolvePiLauncher, bundledPiBin, bundledRuntimeDir, resolveLarkBin, resolveSkillsDir } from "../../../agent/src/runtime.ts";
import { COMPONENT_NAMES, COMPONENT_POLICY, componentCurrentVersion, componentActiveDir, installFromFeed, fetchFeedManifest, feedUrlFromConfig, compareSemver, evaluateUpgrade } from "../../../extensions/core/components.ts";
import { listSkills, readSkillContent, setSkillEnabled, isSkillDisabled } from "../../../extensions/core/skills-admin.ts";
import { assembleBundledPackages, installNpmPackage, removeNpmPackage, listPackageRefs, installedVersion, parseNpmSpec, latestVersionOf, DEFAULT_NPM_REGISTRY } from "../../../extensions/core/pi-packages.ts";

const here = dirname(fileURLToPath(import.meta.url)); // gui/backend/src
export const REPO_ROOT = resolve(here, "..", "..", "..");

const PORT = parseInt(process.env.GUI_PORT ?? "17331", 10);

// ---------------- 本机 HTTP 服务的来源管控 ----------------
// 只监听 127.0.0.1 并不能阻止"用户浏览器里的任意网页"向回环地址发请求（CSRF/SSRF 面：
// /magene/setup 改网关、/bot/activate 换 Bot 应用、/ask 驱动 agent 都有真实副作用）。
// 规则：
//   1) CORS 响应头只发给 App webview（tauri://localhost / http://tauri.localhost）与本机开发来源；
//   2) 状态变更请求（非 GET）若带 Origin 且不在允许列表 → 直接拒绝（表单/POST 都会带 Origin）；
//   3) portal 取 Key 回调来自公司门户页面（外部来源，不可预知）→ 用一次性 nonce 校验兜底。
// 排障可设 GUI_CORS_ANY=1 恢复旧行为（放行所有来源）。
const EXTRA_ALLOWED_ORIGINS = (process.env.GUI_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function corsAllowAny(): boolean {
  return process.env.GUI_CORS_ANY === "1";
}

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return false;
  if (EXTRA_ALLOWED_ORIGINS.includes(origin)) return true;
  if (origin === "tauri://localhost" || origin === "http://tauri.localhost" || origin === "https://tauri.localhost") return true;
  // 本机开发（vite / 浏览器直连调试）：任意端口的 localhost/127.0.0.1
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

/** 给响应带上 CORS 头（仅允许来源；未允许则不加，浏览器就读取不到内容） */
function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (origin && (corsAllowAny() || originAllowed(origin))) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "Origin");
  }
}

// ---------------- portal 取 Key 回调的一次性 nonce ----------------
// 后端启动时生成，写入 0600 文件；GUI（Rust on_page_load）读取并注入到页面脚本，
// 回调请求必须带 x-cw-nonce。这样即使该端点 CORS 放开，其他网页也无法伪造回调。
// 校验以**文件为准**（每次请求重读）：App 可被重复启动，新实例会刷新 nonce 文件后
// 因端口占用而退出、由旧实例继续服务——若拿旧实例内存里的值比对，取 Key 会静默 403。
const PORTAL_NONCE_PATH = join(homedir(), ".coworker", "gui-portal-nonce");
const PORTAL_NONCE = randomBytes(24).toString("hex");

function writePortalNonce(): void {
  try {
    mkdirSync(dirname(PORTAL_NONCE_PATH), { recursive: true });
    writeFileSync(PORTAL_NONCE_PATH, PORTAL_NONCE + "\n", { mode: 0o600 });
  } catch (e: any) {
    console.warn(`[portal] nonce 写入失败（内嵌取 Key 将不可用）：${e?.message ?? e}`);
  }
}

function nonceOk(req: IncomingMessage): boolean {
  const got = String(req.headers["x-cw-nonce"] ?? "");
  let want = PORTAL_NONCE;
  try {
    const fromFile = readFileSync(PORTAL_NONCE_PATH, "utf8").trim();
    if (fromFile) want = fromFile;
  } catch { /* 文件缺失时退回本进程内存值 */ }
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}
// 内嵌 pi agent：覆盖层（应用内独立更新）> PI_BIN > 内置 bundle > PATH 上的 pi
const PI_BIN = resolvePiLauncher();
// magene 已配置则用扩展注册的 magene provider（pi 子进程加载扩展后异步注册，
// rpc 客户端等注册完成再 set_model，见 agent/src/agent/rpc.ts）；否则 fallback google。
// 与 Bot Agent 守护进程共用 defaultProviderName，避免两处默认值漂移。
const LLM_PROVIDER = defaultProviderName();
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
  // 内置 pi 扩展包（随安装包分发，见 gui/scripts/prepare-pi-packages.mjs）
  "todo",              // @juicesharp/rpiv-todo
  "ask_user_question", // @juicesharp/rpiv-ask-user-question
];

// 会话/审计文件放用户目录（打包后 Resources 只读，不应写入应用包内）
// 按飞书用户 openId 隔离：~/.coworker/gui-sessions/{openId}/ 。未登录时用 _shared（不应有会话）。
const SESSION_ROOT = process.env.GUI_SESSION_DIR ?? join(homedir(), ".coworker", "gui-sessions");
// ============ 内嵌 pi agent 隔离（不读系统全局 ~/.pi/agent）============
// app 专属 pi 配置目录 + 复制 magene 凭证；lark-cli 配置目录也隔离到 ~/.coworker/lark-cli
// （见 extensions/core/lark.ts：LARKSUITE_CLI_CONFIG_DIR + 首次自动迁移旧配置）。
const APP_PI_DIR = join(homedir(), ".coworker", "pi-agent");
let piIsolated = false;
try {
  const srcDir = join(homedir(), ".pi", "agent", "extensions", "magene-provider");
  const dstDir = join(APP_PI_DIR, "extensions", "magene-provider");
  mkdirSync(dstDir, { recursive: true });
  const envSrc = join(srcDir, ".env");
  const envDst = join(dstDir, ".env");
  if (!existsSync(envDst) && existsSync(envSrc)) {
    copyFileSync(envSrc, envDst);
    chmodSync(envDst, 0o600);
  }
  // 复制 model overrides（若文件存在）
  const ovSrc = join(homedir(), ".pi", "agent", "magene-model-overrides.json");
  const ovDst = join(APP_PI_DIR, "magene-model-overrides.json");
  if (!existsSync(ovDst) && existsSync(ovSrc)) copyFileSync(ovSrc, ovDst);
  // 让内嵌 pi 子进程读 app 专属配置（magene.ts 也读 PI_CODING_AGENT_DIR）
  process.env.PI_CODING_AGENT_DIR = APP_PI_DIR;
  piIsolated = true;
  console.log(`[隔离] pi 配置目录: ${APP_PI_DIR}（magene 凭证已复制）`);
} catch (e: any) {
  console.error("[隔离] pi 隔离初始化失败:", e?.message ?? String(e));
}
// ---------------- pi 扩展包 / 技能 的应用内装配（与系统全局隔离，不依赖系统 npm） ----------------
const execFileP = promisify(execFile);
// 内置包来源：组件覆盖层（应用内独立更新）> 随包资源。用户自装包走 registry 直取（见 pi-packages.ts）。

function resolvePiPackagesSource(): string | null {
  const overlay = componentActiveDir("pi-packages");
  if (overlay) return overlay;
  const cands = [
    join(REPO_ROOT, "pi-packages"), // 打包形态: Resources/pi-packages
    join(REPO_ROOT, "gui", "src-tauri", "resources", "pi-packages"), // 开发形态
  ];
  return cands.find((d) => existsSync(join(d, "packages.json"))) ?? null;
}

const LARK_SKILLS_STAMP = join(APP_PI_DIR, "skills", ".lark-skills.json");

/** 把 lark-cli 内嵌技能（随 CLI 版本走）导出到 app 专属 pi 技能目录；同版本跳过 */
async function syncLarkSkills(force = false): Promise<void> {
  try {
    const bin = resolveLarkCli();
    const verOut = await execFileP(bin, ["--version"], { timeout: 15_000 });
    const ver = (String(verOut.stdout).match(/\d+\.\d+\.\d+/) ?? [""])[0];
    let prev: { cli?: string; names?: string[] } = {};
    if (existsSync(LARK_SKILLS_STAMP)) {
      try { prev = JSON.parse(readFileSync(LARK_SKILLS_STAMP, "utf8")); } catch { prev = {}; }
    }
    if (!force && ver && prev.cli === ver && (prev.names ?? []).length > 0) return;
    const listOut = await execFileP(bin, ["skills", "list", "--json"], { timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
    const skills: Array<{ name?: string }> = (JSON.parse(String(listOut.stdout)) as any)?.skills ?? [];
    const names = skills.map((s) => String(s.name ?? "")).filter(Boolean);
    const skillsRoot = join(APP_PI_DIR, "skills");
    let files = 0;
    for (const name of names) {
      if (isSkillDisabled(skillsRoot, name)) continue; // 用户停用的技能不重建（见 skills-admin.ts）
      const seen = new Set<string>();
      const stack = [name];
      while (stack.length) {
        const p = stack.shift()!;
        const out = await execFileP(bin, ["skills", "list", p, "--json"], { timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
        const entries: Array<{ path?: string; is_dir?: boolean }> = (JSON.parse(String(out.stdout)) as any)?.entries ?? [];
        for (const e of entries) {
          const rel = String(e.path ?? "");
          if (!rel) continue;
          if (e.is_dir) { stack.push(rel); continue; }
          if (seen.has(rel) || !rel.startsWith(name + "/")) continue;
          seen.add(rel);
          const content = await execFileP(bin, ["skills", "read", rel], { timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
          const target = join(skillsRoot, rel);
          mkdirSync(join(target, ".."), { recursive: true });
          writeFileSync(target, String(content.stdout));
          files++;
        }
      }
    }
    // 清理上一版导出、本版已不存在的技能目录（不碰用户/公司放置的技能）
    for (const old of prev.names ?? []) {
      if (!names.includes(old)) rmSync2(join(skillsRoot, old));
    }
    mkdirSync(skillsRoot, { recursive: true });
    writeFileSync(LARK_SKILLS_STAMP, JSON.stringify({ cli: ver, names, files, at: new Date().toISOString() }, null, 2) + "\n");
    console.log(`[pi] lark-cli 技能已导出到 app 环境（${names.length} 个技能 / ${files} 个文件，cli ${ver}）`);
  } catch (e: any) {
    console.warn(`[pi] lark-cli 技能导出失败（忽略）：${e?.message ?? e}`);
  }
}

/** 启动装配：内置 pi 扩展包 + lark-cli 技能（异步，不阻塞启动） */
async function ensurePiEnvironment(): Promise<void> {
  const src = resolvePiPackagesSource();
  if (src) {
    try {
      const r = assembleBundledPackages(src, APP_PI_DIR);
      if (!r.skipped) console.log(`[pi] ${r.message}`);
    } catch (e: any) {
      console.warn(`[pi] 内置扩展包装配失败（忽略）：${e?.message ?? e}`);
    }
  }
  await syncLarkSkills();
}

function rmSync2(p: string): void {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

let currentOpenId = ""; // 当前登录飞书用户 openId（checkEnv 同步）
function sessionDirFor(openId: string): string {
  return join(SESSION_ROOT, openId || "_shared");
}
function sessionFile(id: string): string {
  return join(sessionDirFor(currentOpenId), `${id}.jsonl`);
}
// 启动时迁移旧数据：根目录下散落的 *.jsonl（升级前未按用户隔离）移到 legacy/，避免混入新用户
function migrateLegacySessions(): void {
  try {
    mkdirSync(join(SESSION_ROOT, "legacy"), { recursive: true });
    for (const f of readdirSync(SESSION_ROOT)) {
      if (!f.endsWith(".jsonl")) continue;
      renameSync(join(SESSION_ROOT, f), join(SESSION_ROOT, "legacy", f));
    }
  } catch { /* 目录不存在或无旧文件 */ }
}
migrateLegacySessions();

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
  sessionDir: sessionDirFor(""),
  maxAgents: 4,
  agentIdleTtlMs: 20 * 60_000,
  rateLimit: { windowMs: 60_000, max: 60 },
  larkEventKeys: { message: "", card: "" },
  larkEnv: { LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" },
  auditFile: join(sessionDirFor(""), "audit.jsonl"),
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
    out.larkCli = { installed: false, message: "内置 lark-cli 缺失（安装包可能损坏），请重新安装应用" };
    return out;
  }
  out.larkCli = { installed: true, version: (ver.stdout || ver.stderr).trim().split("\n")[0] };
  const cfg = await runLark(["config", "show"], { timeoutMs: 30_000 });
  out.config = { initialized: cfg.ok };
  const auth = await runLark(["auth", "status", "--json"], { timeoutMs: 60_000 });
  const u = userIdentityOf(auth.envelope);
  // 必须 user 身份 ready（token valid）才算登录；status=missing 时 identities.user 仍存在，需显式排除
  const ready = auth.ok && u && (u.status === "ready" || u.status === "needs_refresh");
  out.auth = ready
    ? { loggedIn: true, name: u.userName ?? u.openId, openId: u.openId, scopes: countScopes(u.scope) }
    : { loggedIn: false, message: ready ? describeLarkError(auth) : (u?.message ?? "未登录") };
  // 用户身份变化 → 切换会话目录（按 openId 隔离），并清掉旧会话连接
  if (ready && u.openId && u.openId !== currentOpenId) {
    currentOpenId = u.openId;
    void refreshPortalTarget(); // 登录后按用户读工作台，发现门户地址（后台，不阻塞）
    const dir = sessionDirFor(currentOpenId);
    await mkdir(dir, { recursive: true });
    pool.setSessionDir(dir);
    await pool.closeAll();
    currentSessionId = "me";
  }
  return out;
}

/**
 * 全新机器首次登录：应用配置（config.json）不存在时，`auth login` 会报 config/not_configured。
 * 这里后台起 `lark-cli config init --new`（阻塞直到用户在浏览器完成应用创建），
 * 解析出验证 URL 返回给前端展示；进程退出码 0 = 配置已写入，随后可正常走 auth login。
 */
const configInit: {
  proc: ReturnType<typeof spawn> | null;
  url: string;
  done: boolean;
  ok: boolean;
  error: string;
  startedAt: number;
} = { proc: null, url: "", done: false, ok: false, error: "", startedAt: 0 };
const CONFIG_INIT_TIMEOUT_MS = 10 * 60_000;

function startConfigInit(): Record<string, any> {
  if (configInit.proc && !configInit.done) {
    // 已有进行中实例：复用已抓到的 URL（去重）
    if (configInit.url) {
      return { ok: true, needConfigInit: true, url: configInit.url, qrUrl: `/qr?u=${encodeURIComponent(configInit.url)}` };
    }
    return { ok: false, needConfigInit: true, message: "应用配置正在初始化，请稍候" };
  }
  configInit.proc = null;
  configInit.url = "";
  configInit.done = false;
  configInit.ok = false;
  configInit.error = "";
  configInit.startedAt = Date.now();
  const child = spawn(resolveLarkCli(), ["config", "init", "--new"], {
    env: { ...process.env, ...LARK_ENV },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  configInit.proc = child;
  const URL_RE = /https:\/\/open\.(?:feishu|larksuite)\.(?:cn|com)\/page\/cli\?user_code=[^\s"'\\]+/;
  const drain = (d: Buffer | string) => {
    const s = String(d);
    if (!configInit.url) {
      const m = s.match(URL_RE);
      if (m) configInit.url = m[0];
    }
  };
  child.stdout.on("data", drain);
  child.stderr.on("data", drain);
  child.on("error", (e: any) => {
    configInit.done = true;
    configInit.ok = false;
    configInit.error = e?.message ?? String(e);
  });
  child.on("exit", (code) => {
    configInit.done = true;
    configInit.ok = code === 0;
    if (code !== 0 && !configInit.error) configInit.error = `config init 退出码 ${code}`;
    console.log(`[config-init] 进程结束 code=${code}${configInit.url ? `（url=${configInit.url.slice(0, 60)}…）` : "（未捕获 URL）"}`);
  });
  // 超时兜底：标记失败，前端可重试
  setTimeout(() => {
    if (!configInit.done) {
      configInit.done = true;
      configInit.ok = false;
      configInit.error = "应用配置超时（10 分钟），请重试";
      try {
        child.kill("SIGTERM");
      } catch { /* ignore */ }
    }
  }, CONFIG_INIT_TIMEOUT_MS).unref?.();

  if (configInit.url) {
    return { ok: true, needConfigInit: true, url: configInit.url, qrUrl: `/qr?u=${encodeURIComponent(configInit.url)}` };
  }
  // URL 未同步输出（极少）：给一点时间再取
  return { ok: true, needConfigInit: true, message: "正在生成应用配置链接…", polling: true };
}

function configInitStatus(): Record<string, any> {
  const configured = (() => {
    try {
      // 进程已结束且退出码 0 = 配置已写入（config show 也能验证）
      return configInit.done && configInit.ok;
    } catch { /* ignore */ }
    return false;
  })();
  return {
    ok: true,
    done: configInit.done,
    configured,
    url: configInit.url && !configInit.done ? configInit.url : "",
    error: configInit.error || "",
    startedAt: configInit.startedAt,
  };
}

async function startLogin(scopes?: string, domains?: string): Promise<Record<string, any>> {
  // 全新机器：应用配置不存在时先走 config init --new（浏览器创建应用），再回来登录
  const cfg = await runLark(["config", "show"], { timeoutMs: 30_000 });
  if (cfg.ok) {
    const data: any = dataOf(cfg.envelope);
    if (!data?.appId && !data?.app_id) return startConfigInit();
  } else {
    return startConfigInit();
  }
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
  // lark-cli 语义：登录成功但请求的 scopes 未全部授予时，stdout 输出
  // authorization_complete payload 并以退出码 3（ExitAuth）结束——token 已写入，属于“成功但有缺项”。
  const payload: any = r.envelope;
  const completed = r.ok || (payload?.event === "authorization_complete" && !!payload?.user_open_id);
  if (!completed) return { ok: false, message: describeLarkError(r) };
  const env = await checkEnv();
  const missing: string[] = Array.isArray(payload?.missing) ? payload.missing : [];
  const granted: string[] = Array.isArray(payload?.granted) ? payload.granted : [];
  const warning = missing.length
    ? `已登录，但 ${missing.length} 个权限未授予（${missing.slice(0, 8).join("、")}${missing.length > 8 ? " 等" : ""}）。请在企业飞书管理后台为应用开通对应权限后，重新授权一次即可补全。`
    : "";
  if (warning) {
    appendAudit({ cluster: "onboarding", action: "auth_login", resource: "scopes", result: "ok", detail: { partial: true, missing: missing.slice(0, 20) } });
  }
  return { ok: true, identity: env.auth, warning, missing, granted };
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

/** lark-cli 绑定 bot 的 API 权限 scope 清单（auth scopes），按服务分组 */
async function permScopes(): Promise<Record<string, any>> {
  try {
    const r = await runLark(["auth", "scopes", "--json"], { as: "user", timeoutMs: 60_000 });
    const data = dataOf(r.envelope);
    const scopes: string[] = Array.isArray(data?.userScopes) ? data.userScopes : [];
    const SERVICES: Array<[string, string]> = [
      ["wiki", "知识库 Wiki"], ["drive", "云盘 Drive"], ["docs", "云文档"], ["docx", "文档 Docx"],
      ["sheets", "电子表格"], ["slides", "幻灯片"], ["base", "多维表格"], ["im", "消息 IM"],
      ["calendar", "日历"], ["mail", "邮箱"], ["task", "任务"], ["approval", "审批"],
      ["contact", "通讯录"], ["minutes", "妙记"], ["vc", "视频会议"], ["search", "搜索"],
      ["board", "画板"], ["attendance", "考勤"], ["profile", "个人资料"], ["application", "应用"],
    ];
    const byService = SERVICES.map(([key, label]) => {
      const items = scopes.filter((s) => s.startsWith(key + ":") || s === key).sort();
      return { key, label, count: items.length, scopes: items };
    }).filter((g) => g.count > 0);
    const other = scopes.filter((s) => !SERVICES.some(([k]) => s.startsWith(k + ":") || s === k)).sort();
    return { ok: true, total: scopes.length, identity: data?.tokenType ?? "user", byService, other };
  } catch (e: any) {
    return { ok: false, message: describeLarkError(e) };
  }
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

/** LLM provider 是否可用：magene 网关已配置，或外部 api-key 环境变量已提供 */
function providerReady(): boolean {
  try {
    const m = resolveMageneConfig();
    if (m.apiKey?.trim() && !m.baseUrl.includes("<")) return true;
  } catch { /* 配置解析失败按未配置处理 */ }
  const keyEnvs = [
    "GOOGLE_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY",
    "XAI_API_KEY", "DEEPSEEK_API_KEY", "KIMI_API_KEY", "AZURE_OPENAI_API_KEY", "MISTRAL_API_KEY",
  ];
  return keyEnvs.some((k) => (process.env[k] ?? "").trim() !== "");
}

// ---------------- 会话与模型管理 ----------------
let currentSessionId = "me";
let currentModel = process.env.LLM_MODEL ?? "";
const sessionModels = new Map<string, string>();

/** 会话文件名（含 .jsonl 后缀）→ 会话 id */
function sessionIdFromFile(name: string): string {
  return name.replace(/\.jsonl$/, "");
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
    const dir = sessionDirFor(currentOpenId);
    const files = await readdir(dir);
    const jsons = files.filter((f) => f.endsWith(".jsonl"));
    const list = await Promise.all(jsons.map((f) => parseSessionFile(join(dir, f))));
    return list
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt, count: s.messages.length }));
  } catch {
    return [];
  }
}

async function ask(text: string): Promise<string> {
  // provider 不能沿用启动时的快照：网关 Key 往往是运行中才拿到的（登录后自动取 Key），
  // 启动时还没配置就会固定成回退 provider（google），此后每条消息都会等它 20s 后报
  // "pi 在 20s 内未出现 provider「google」的模型"。这里每次对话前重新解析，变了就重建会话。
  try {
    const want = defaultProviderName();
    if (pool.getCfgProvider() !== want) {
      console.log(`[ask] provider 切换：${pool.getCfgProvider()} → ${want}（重建会话）`);
      pool.setProvider(want);
      await pool.closeAll();
    }
  } catch { /* 解析失败保持现状 */ }
  if (!providerReady()) {
    throw new Error(
      "尚未配置模型网关/API Key：请在「权限与配置 → 模型网关」获取 API Key（打开公司门户，登录后自动写入），或联系 IT 获取。",
    );
  }
  if (busy) await new Promise<void>((r) => waiters.push(r));
  busy = true;
  try {
    const model = sessionModels.get(currentSessionId) ?? currentModel;
    if (model && pool.getCfgModel?.() !== model) pool.setModel?.(model);
    // 上下文/检索门禁：超时 120s 提前失败，避免 pi 因上下文过大/检索卡死；异常转明确错误而非连接中断
    try {
      return await pool.ask(currentSessionId, guiPrompt(text), 120_000);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      // pi 子进程意外退出（切会话目录/切模型的竞态、启动期被回收等）：丢弃会话重建一次再问，
      // 别把一个可自愈的瞬时故障直接抛给用户。
      if (/agent 已关闭|pi 子进程退出/.test(msg)) {
        console.warn(`[ask] pi 会话不可用，重建后重试：${msg.slice(0, 160)}`);
        pool.closeSession(currentSessionId);
        try {
          return await pool.ask(currentSessionId, guiPrompt(text), 120_000);
        } catch (e2: any) {
          throw new Error("处理失败（已重试）：" + String(e2?.message ?? e2).slice(0, 200));
        }
      }
      if (/timeout|abort|Timed out|ETIMEDOUT/i.test(msg)) {
        throw new Error("处理超时：可能上下文过长或检索范围过大，建议新开对话后重试");
      }
      throw new Error("处理失败：" + msg.slice(0, 200));
    }
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
    if (process.platform === "darwin") spawnSync("open", [u], { timeout: 5000, windowsHide: true });
    else if (process.platform === "win32") spawnSync("cmd", ["/c", "start", "", u], { timeout: 5000, windowsHide: true });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, message: String(e?.message ?? e) };
  }
}

// ---------------- 守护进程管理（复用 coworker-daemon CLI） ----------------

const DAEMON_CLI = join(REPO_ROOT, "agent", "bin", "coworker-daemon.ts");

function runDaemonCli(cmd: string): { ok: boolean; output: string } {
  const r = spawnSync(process.execPath, [DAEMON_CLI, ...cmd.split(" ")], { encoding: "utf8", timeout: 30_000, windowsHide: true });
  return { ok: r.status === 0, output: (r.stdout || "") + (r.status !== 0 ? r.stderr || "" : "") };
}

async function daemonStatus(): Promise<Record<string, any>> {
  const r = runDaemonCli("status");
  const output = r.output.trim();
  const running = /守护进程：✅/.test(output);
  const busOnline = /事件总线（[^）]+）：✅/.test(output);
  const busConflict = /被其他设备\/实例占用|another event bus|remote event connection|事件订阅失败/.test(output);
  return { ok: true, running, busOnline, busConflict, output };
}

async function daemonControl(action: "start" | "stop" | "restart"): Promise<Record<string, any>> {
  const r = runDaemonCli(action);
  return { ok: r.ok, message: r.output.trim().split("\n")[0] || "完成", output: r.output.trim() };
}

/** 让出/接管事件总线（写 bus-control.json，daemon 轮询应用） */
function daemonBus(body: any): Record<string, any> {
  const action = body?.action === "stop" ? "stop" : body?.action === "start" ? "start" : "";
  if (!action) return { ok: false, message: "action 应为 stop|start" };
  const r = runDaemonCli(`bus ${action}`);
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

/** 检查 card.action.trigger 卡片回调是否已在控制台启用（尝试订阅判断） */
async function botCardInfo(): Promise<Record<string, any>> {
  const cfg = await runLark(["config", "show"], { timeoutMs: 30_000 });
  const data: any = cfg.envelope?.data ?? cfg.envelope ?? {};
  const appId: string | undefined = data.appId ?? data.app_id;
  const brand: string | undefined = data.brand;
  const consoleHost = brand === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
  let enabled = false;
  let reason = "";
  if (appId) {
    // 尝试短暂订阅：成功 = 已启用；报 requires not subscribed = 未启用
    const r = await runLark(
      ["event", "consume", "card.action.trigger", "--as", "bot", "--timeout", "1s", "--max-events", "0"],
      { timeoutMs: 15_000 },
    );
    const errText = `${r.stderr ?? ""}${r.stdout ?? ""}`;
    if (r.ok) {
      enabled = true;
    } else {
      enabled = !/requires callbacks not subscribed|not subscribed in console|EventKey .* requires callbacks/i.test(errText);
      reason = errText.match(/requires[^\\n]*/)?.[0] ?? "";
    }
  }
  return {
    ok: true,
    appId,
    enabled,
    reason,
    consoleUrl: appId ? `${consoleHost}/app/${appId}/event` : null,
  };
}

/** Bot 资料（名字 + 头像 + 应用设置页链接）：尽力获取飞书应用信息，失败回退默认 */
async function botProfile(): Promise<Record<string, any>> {
  const cfg = await runLark(["config", "show"], { timeoutMs: 30_000 });
  const data: any = cfg.envelope?.data ?? cfg.envelope ?? {};
  const appId: string | undefined = data.appId ?? data.app_id;
  const brand: string | undefined = data.brand;
  const consoleHost = brand === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
  let name = "企业 AI 助手";
  let avatarUrl = "";
  let kind: "feishu" | "fallback" = "fallback";
  if (appId) {
    try {
      const r = await runLark(
        ["api", "GET", `/open-apis/application/v6/applications/${appId}?lang=zh_cn`],
        { as: "bot", timeoutMs: 15_000 },
      );
      const d = dataOf(r.envelope);
      if (d?.app_name || d?.avatar_url) {
        if (d.app_name) name = d.app_name;
        if (d.avatar_url) avatarUrl = d.avatar_url;
        kind = "feishu";
      }
    } catch {
      // 拿不到 → 回退默认
    }
  }
  return {
    ok: true,
    appId,
    name,
    avatarUrl,
    kind,
    consoleUrl: appId ? `${consoleHost}/app/${appId}/event` : null,
    settingsUrl: appId ? `${consoleHost}/app/${appId}` : null,
  };
}

/** 知识源同步：扫描用户可见 wiki 空间，写入用户覆盖知识源配置（agent 检索生效） */
async function syncKnowledgeSources(): Promise<Record<string, any>> {
  try {
    const r = await runLark(["wiki", "+space-list", "--format", "json"], { as: "user", timeoutMs: 60_000 });
    const spaces: any[] = dataOf(r.envelope)?.spaces ?? [];
    if (!spaces.length) return { ok: false, message: "未发现可见知识空间，请先申请知识库权限。" };
    const cfg = loadKnowledge();
    const current = cfg.sources.filter((s) => s.type !== "wiki" || /replac/i.test(String(s.spaceId ?? "")));
    // 覆盖：现有非 wiki 源 + 用户可见 wiki 空间（去重）
    const byId = new Map<string, any>();
    for (const s of current) byId.set(s.id, s);
    const added: string[] = [];
    const DEFAULT_NAMES: Record<string, string> = {
      policies: "公司全员知识库",
      encyclopedia: "公司百科",
      faq: "员工 FAQ",
      skillhub: "公司技能库",
    };
    for (const sp of spaces) {
      const sid = String(sp.space_id);
      const id = sp.name === DEFAULT_NAMES.policies || sp.name.includes("全员") ? "policies" : `wiki_${sid}`;
      if (!byId.has(id)) {
        byId.set(id, { id, type: "wiki", name: sp.name, description: `用户可见知识空间：${sp.name}`, spaceId: sid });
        added.push(sp.name);
      } else if (byId.get(id).spaceId !== sid) {
        byId.set(id, { ...byId.get(id), spaceId: sid });
        added.push(`${sp.name}(spaceId 更新)`);
      }
    }
    writeKnowledgeConfig({ sources: [...byId.values()] });
    return { ok: true, count: spaces.length, added, message: `已接入 ${spaces.length} 个 wiki 知识空间。` };
  } catch (e: any) {
    return { ok: false, message: `同步失败：${e?.message ?? String(e)}` };
  }
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
//
// 部署配置 ~/.coworker/deploy.json（内网地址不进仓库/公开安装包，由 IT 或 deploy 脚本放置）：
//   { "portalUrl": "http://<portal-host>:<port>", "mageneBaseUrl": "http://<gateway>/api/v1" }
//   portalUrl     向导「飞书登录获取 API Key」按钮的登录页（缺省时按钮提示未配置）
//   mageneBaseUrl 向导表单的 Base URL 预填（员工只需粘贴 Key）
interface DeployConfig {
  portalUrl?: string;
  /** 飞书工作台里门户应用的名称（默认「AI应用门户」） */
  portalAppName?: string;
  /** 门户页面路径（默认 /portal/?lang=zh-CN） */
  portalPath?: string;
  /** 门户应用（自建应用）app_id：工作台发现失败时用它拼 OAuth 授权地址 */
  portalAppId?: string;
  mageneBaseUrl?: string;
  /** 组件更新源（公司内网）：{feedUrl}/{platform}/manifest.json + sha256 校验，见 extensions/core/components.ts */
  componentFeedUrl?: string;
  /** npm registry（用户安装 pi 扩展包用；默认官方源，内网可指向镜像） */
  npmRegistry?: string;
}
function loadDeployConfig(): DeployConfig {
  try {
    return JSON.parse(readFileSync(join(homedir(), ".coworker", "deploy.json"), "utf8")) as DeployConfig;
  } catch { /* 无部署配置（开源形态）：全部走手动/环境变量 */ }
  return {};
}
const deployCfg = loadDeployConfig();

// ---------------- 门户地址解析（两个渠道） ----------------
// 渠道 1（首选）：读飞书工作台——在企业安装应用里找名为「AI应用门户」的自建应用，
//   取其 redirect_urls / back_home_url 的域作为门户根地址（实测该应用 redirect_urls[0]
//   就是 {base}/feishu/login）。
// 渠道 2（兜底）：PORTAL_URL 环境变量 > deploy.json 的 portalUrl（内网地址不进仓库）。
// 解析结果被缓存（~/.coworker/portal-discovery.json，24h），发现放后台跑，不阻塞启动。
interface PortalTarget {
  base: string;      // 门户根：http://host:port
  /** 飞书 OAuth 授权地址：浏览器/内嵌窗口**必须**用这个入口 */
  authUrl: string;
  /** {base}/feishu/login：门户自己的免登页，**只在飞书客户端内可用**
   *  （它调 window.tt.requestAccess，浏览器里 window.tt 不存在 → 脚本报错整页空白） */
  loginUrl: string;
  pageUrl: string;   // 门户页：{base}{portalPath}
  source: "env" | "workplace" | "deploy" | "none";
  appId?: string;
  callbackUrl?: string;
  detail?: string;
}
const PORTAL_APP_NAME = (process.env.PORTAL_APP_NAME ?? deployCfg.portalAppName ?? "AI应用门户").trim();
const PORTAL_PATH = (process.env.PORTAL_PATH ?? deployCfg.portalPath ?? "/portal/?lang=zh-CN").trim();
const PORTAL_DISCOVERY_PATH = join(homedir(), ".coworker", "portal-discovery.json");
const PORTAL_DISCOVERY_TTL_MS = 24 * 3600 * 1000;

function baseOf(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

/** 飞书 OAuth 授权域名（品牌来自 lark-cli config show；默认飞书） */
let portalAuthHost = "https://open.feishu.cn";

/** 飞书 OAuth 授权地址：app_id + redirect_uri(门户回调) + state=LOGIN。
 *  这是浏览器/内嵌窗口唯一可用的登录入口（门户的 /feishu/login 是客户端专用页）。 */
function buildAuthUrl(base: string, appId: string, callbackUrl: string): string {
  if (!appId || !callbackUrl) return "";
  return (
    `${portalAuthHost}/open-apis/authen/v1/index` +
    `?app_id=${encodeURIComponent(appId)}` +
    `&redirect_uri=${encodeURIComponent(callbackUrl)}` +
    `&state=LOGIN`
  );
}

function mkTarget(
  base: string,
  source: PortalTarget["source"],
  opts: { appId?: string; callbackUrl?: string; detail?: string } = {},
): PortalTarget | null {
  if (!base) return null;
  // redirect_uri 必须用门户应用在飞书后台**已登记**的地址，否则授权后飞书拒绝回调。
  // 实测该应用 redirect_urls[0] = {base}/feishu/login（免登页/回调页一体），
  // /feishu/auth/callback 是臆测路径，仅当发现渠道真的返回了带 auth/callback 的登记值时才用。
  const callbackUrl = opts.callbackUrl || `${base}/feishu/login`;
  return {
    base,
    loginUrl: `${base}/feishu/login`,
    authUrl: buildAuthUrl(base, opts.appId ?? deployCfg.portalAppId ?? "", callbackUrl),
    pageUrl: `${base}${PORTAL_PATH}`,
    source,
    appId: opts.appId ?? deployCfg.portalAppId,
    callbackUrl,
    detail: opts.detail,
  };
}

/** 渠道 2：显式配置（env > deploy.json）。portalUrl 允许给根地址或完整页面地址 */
function configuredPortalTarget(): PortalTarget | null {
  const raw = (process.env.PORTAL_URL ?? deployCfg.portalUrl ?? "").trim();
  if (!raw) return null;
  const base = baseOf(raw);
  if (!base) return null;
  // portalUrl 带了路径（如 .../portal/?lang=zh-CN）时，尊重它作为页面地址
  let pagePath = PORTAL_PATH;
  try {
    const u = new URL(raw);
    if (u.pathname && u.pathname !== "/") pagePath = `${u.pathname}${u.search}`;
  } catch { /* 用默认路径 */ }
  const t = mkTarget(base, process.env.PORTAL_URL ? "env" : "deploy");
  return t ? { ...t, pageUrl: `${base}${pagePath}` } : null;
}

function readDiscoveryCache(): { base?: string; appId?: string; callbackUrl?: string; ts?: number } | null {
  try {
    return JSON.parse(readFileSync(PORTAL_DISCOVERY_PATH, "utf8"));
  } catch {
    return null;
  }
}

let portalTarget: PortalTarget | null = configuredPortalTarget();
let portalDiscoveryRunning = false;

/** 渠道 1：从飞书工作台（企业安装应用列表）发现门户地址 */
async function discoverPortalFromWorkplace(): Promise<PortalTarget | null> {
  const uid = currentOpenId; // 后端登录后写入
  if (!uid) return null;
  const seen: string[] = [];
  let pageToken = "";
  for (let page = 0; page < 60; page++) {
    const params: Record<string, any> = { user_id: uid, user_id_type: "open_id", page_size: 50, lang: "zh_cn" };
    if (pageToken) params.page_token = pageToken;
    const r = await runLark(
      ["api", "GET", "/open-apis/application/v6/applications", "--params", JSON.stringify(params)],
      { as: "bot", timeoutMs: 25_000 },
    );
    if (!r.ok) {
      seen.push(`第 ${page + 1} 页失败：${describeLarkError(r).slice(0, 120)}`);
      break;
    }
    const data = r.envelope?.data ?? {};
    const list: any[] = data.app_list ?? [];
    const hit = list.find((a) => String(a?.app_name ?? "").trim() === PORTAL_APP_NAME);
    if (hit) {
      const redirects: string[] = Array.isArray(hit.redirect_urls) ? hit.redirect_urls.map((x: any) => String(x)) : [];
      const callback = redirects.find((u) => /auth\/callback/i.test(u)) || redirects.find((u) => /feishu\/login/i.test(u)) || "";
      const rawUrl = redirects.find((u) => /feishu\/login/i.test(u)) || String(hit.back_home_url ?? "").trim() || redirects[0] || "";
      const base = baseOf(rawUrl);
      if (base) {
        try {
          writeFileSync(PORTAL_DISCOVERY_PATH, JSON.stringify({ base, appId: hit.app_id, callbackUrl: callback || `${base}/feishu/login`, ts: Date.now() }, null, 2) + "\n", "utf8");
        } catch { /* 缓存失败不影响本次使用 */ }
        return mkTarget(base, "workplace", { appId: hit.app_id, callbackUrl: callback });
      }
      seen.push(`找到「${PORTAL_APP_NAME}」但没有可用 URL（back_home_url/redirect_urls 均为空）`);
      break;
    }
    if (!data.has_more) break;
    if (!data.page_token) {
      // 实测该接口 has_more=true 但不给 page_token（列表只出前 500 条），要留痕便于排障
      seen.push(`应用列表 has_more=true 但无 page_token，仅前 ${list.length} 条可见，未含「${PORTAL_APP_NAME}」`);
      break;
    }
    pageToken = String(data.page_token);
  }
  const detail = seen.join("；") || `企业安装应用列表里没有名为「${PORTAL_APP_NAME}」的应用`;
  return { base: "", authUrl: "", loginUrl: "", pageUrl: "", source: "none", detail };
}

/** 后台刷新门户地址（缓存未过期则跳过）；失败静默，保留兜底渠道 */
async function refreshPortalTarget(force = false): Promise<void> {
  if (portalDiscoveryRunning) return;
  if (process.env.PORTAL_URL) return; // 显式指定优先，不做发现
  const cached = readDiscoveryCache();
  if (!force && cached?.base && Date.now() - (cached.ts ?? 0) < PORTAL_DISCOVERY_TTL_MS) {
    portalTarget = mkTarget(cached.base, "workplace", { appId: cached.appId, callbackUrl: (cached as any).callbackUrl }) ?? portalTarget;
    return;
  }
  portalDiscoveryRunning = true;
  try {
    try {
      const cfgShow = await runLark(["config", "show"], { timeoutMs: 15_000 });
      const brand = String(dataOf(cfgShow.envelope)?.brand ?? "");
      if (brand === "lark") portalAuthHost = "https://open.larksuite.com";
    } catch { /* 保持默认飞书域名 */ }
    const found = await discoverPortalFromWorkplace();
    if (found?.base) {
      portalTarget = found;
      console.log(`[portal] 工作台发现门户地址：${found.base}（应用 ${found.appId}）`);
    } else {
      if (found?.detail) console.warn(`[portal] 工作台未发现门户地址：${found.detail}`);
      if (!portalTarget) portalTarget = found; // 保留诊断信息
    }
  } catch (e: any) {
    console.warn(`[portal] 工作台发现失败：${e?.message ?? e}`);
  } finally {
    portalDiscoveryRunning = false;
  }
}

function readClipboardText(): string {
  try {
    if (process.platform === "darwin") {
      const r = spawnSync("/usr/bin/pbpaste", [], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
      return (r.stdout || "").replace(/\0/g, "").trim();
    }
    if (process.platform === "win32") {
      const r = spawnSync("powershell", ["-NoProfile", "-Command", "Get-Clipboard -Raw"], { encoding: "utf8", timeout: 5000, windowsHide: true });
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

async function portalOpen(): Promise<{ ok: boolean; message?: string; url?: string }> {
  // 用户主动点「获取 API Key」时顺手刷新一次发现结果（缓存过期才真跑）
  void refreshPortalTarget();
  const target = portalTarget;
  if (!target?.pageUrl) {
    return { ok: false, message: target?.detail ?? "未配置公司门户地址（需放置 deploy.json 的 portalUrl 或设置 PORTAL_URL）" };
  }
  // 用 OAuth 授权地址进（登录后回调落到门户控制台）；拿不到 app_id 时才退回门户页
  const url = target.authUrl || target.pageUrl;
  try {
    if (process.platform === "darwin") spawnSync("open", [url], { timeout: 5000, windowsHide: true });
    else if (process.platform === "win32") spawnSync("cmd", ["/c", "start", "", url], { timeout: 5000, windowsHide: true });
    return { ok: true, url };
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
    // portalUrl 保持为"门户根"（前端拼 /feishu/login 用）；新增字段供诊断与页面跳转
    portalUrl: portalTarget?.base ?? "",
    portalBase: portalTarget?.base ?? "",
    authUrl: portalTarget?.authUrl ?? "",
    callbackUrl: portalTarget?.callbackUrl ?? "",
    loginUrl: portalTarget?.loginUrl ?? "",
    pageUrl: portalTarget?.pageUrl ?? "",
    portalUrlSource: portalTarget?.source ?? "none",
    portalAppId: portalTarget?.appId ?? "",
    portalDetail: portalTarget?.detail ?? "",
    // 未配置时用部署配置预填（员工只粘贴 Key）；已配置则显示现值
    mageneBaseUrl: resolveMageneConfig().baseUrlSource === "default"
      ? (deployCfg.mageneBaseUrl ?? "")
      : resolveMageneConfig().baseUrl,
  };
}

// ---------------- portal 内嵌 webview 取 Key（B 方案） ----------------
// webview 注入脚本在登录完成后 POST /portal/key-callback：
// 验证 Key → 持久化 portal 会话（UID cookie，31 天，供静默刷新）→ 塞进 clipWatch.found，
// 复用 A 方案的 watch-status 轮询 → 前端 /magene/setup 落盘链路（单一写入路径）。

const PORTAL_SESSION_PATH = join(homedir(), ".coworker", "portal-session.json");

interface PortalSession { uid: string; user?: { name?: string; department?: string }; savedAt: string }

function loadPortalSession(): PortalSession | null {
  try {
    const s = JSON.parse(readFileSync(PORTAL_SESSION_PATH, "utf8")) as PortalSession;
    return s?.uid ? s : null;
  } catch { return null; }
}

function savePortalSession(s: PortalSession): void {
  try {
    mkdirSync(dirname(PORTAL_SESSION_PATH), { recursive: true });
    writeFileSync(PORTAL_SESSION_PATH, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  } catch { /* 会话持久化失败不影响当次配置 */ }
}

/** 带 UID 会话调 portal 取 Key（供 key-callback 校验来源与静默刷新共用）；失败返回空串 */
async function fetchPortalApiKey(portalUrl: string, uid: string, timeoutMs = 15_000): Promise<string> {
  try {
    const r = await fetch(`${portalUrl.replace(/\/+$/, "")}/api/tops/user/api-key`, {
      headers: { cookie: `UID=${uid}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return "";
    const j = (await r.json()) as { api_key?: string };
    return j.api_key?.trim() ?? "";
  } catch { return ""; }
}

async function portalKeyCallback(body: any): Promise<Record<string, any>> {
  const key = String(body?.api_key ?? "").trim();
  const cookie = String(body?.cookie ?? "");
  if (!key) return { ok: false, message: "api_key 为空（portal 会话未就绪？）" };
  // 验证 Key 可用再放行（与 /magene/setup 同验证口径；此处不写 .env，落盘由前端统一走 /magene/setup）
  const baseUrl = resolveMageneConfig().baseUrlSource === "default"
    ? (deployCfg.mageneBaseUrl ?? "")
    : resolveMageneConfig().baseUrl;
  if (!baseUrl) return { ok: false, message: "缺少网关 Base URL（部署配置 deploy.json 未放置）" };
  let modelCount = 0;
  try {
    const models = await fetchMageneModels(baseUrl, key);
    modelCount = models.length;
  } catch (e: any) {
    return { ok: false, message: `Key 验证失败：${e?.message ?? String(e)}` };
  }
  // 持久化 portal 会话（UID 31 天有效，供下次静默刷新免扫码）
  const uid = cookie.match(/UID=([a-f0-9]{16,64})/)?.[1] ?? "";
  if (uid) savePortalSession({ uid, user: body?.user, savedAt: new Date().toISOString() });
  // 塞进现有捕获状态：前端轮询 watch-status 发现 found 后走既有保存流程
  clipWatch.found = key;
  clipWatch.active = false;
  if (clipWatch.timer) clearInterval(clipWatch.timer);
  appendAudit({ cluster: "onboarding", action: "portal_key_callback", resource: "magene-provider", result: "ok", detail: { modelCount, sessionSaved: !!uid } });
  console.log(`[portal] key-callback 验证通过（${modelCount} 模型${uid ? "，会话已保存" : ""}）`);
  return { ok: true, modelCount };
}

/** 启动静默刷新：magene 未配置但存有 portal 会话（31 天内）时直接取 Key 自动配置。
 *  覆盖：Key 服务端轮换 / .env 被删 / 重装 App。异步执行，不阻塞启动。 */
async function portalSilentRefresh(): Promise<void> {
  try {
    const cfg = resolveMageneConfig();
    if (cfg.apiKey && !cfg.baseUrl.includes("<")) return; // 已配置，无需刷新
    const portalUrl = deployCfg.portalUrl ?? "";
    const baseUrl = deployCfg.mageneBaseUrl ?? "";
    const session = loadPortalSession();
    if (!portalUrl || !baseUrl || !session) return;
    const key = await fetchPortalApiKey(portalUrl, session.uid);
    if (!key) return; // 会话过期（31 天）等：回到正常扫码流程
    const models = await fetchMageneModels(baseUrl, key);
    writeMageneEnv(baseUrl, key);
    appendAudit({ cluster: "onboarding", action: "portal_silent_refresh", resource: "magene-provider", result: "ok", detail: { modelCount: models.length } });
    console.log(`[portal] 静默刷新成功（${models.length} 模型），已写入 magene 配置`);
  } catch (e: any) {
    console.warn(`[portal] 静默刷新失败（忽略）：${e?.message ?? String(e)}`);
  }
}

// ---------------- 内嵌组件（lark-cli / pi / skills）应用内独立更新 ----------------
// 覆盖层 ~/.coworker/components/（与系统全局隔离），解析优先级见 agent/src/runtime.ts。
// 更新源 = deploy.json.componentFeedUrl（或环境变量 COMPONENT_FEED_URL），静态清单 + sha256。

const COMPONENT_PLATFORM = `${process.platform}-${process.arch}`;

function readTextSafe(p: string): string {
  try { return readFileSync(p, "utf8").trim(); } catch { return ""; }
}

/** 包内随版本发布的组件版本戳（lark-cli/node 在 runtime/versions.json；pi 在 VERSION 文件） */
function bundledComponentVersion(name: (typeof COMPONENT_NAMES)[number]): string {
  if (name === "lark-cli" || name === "node") {
    const rt = bundledRuntimeDir();
    if (rt) {
      try {
        const j = JSON.parse(readFileSync(join(rt, "versions.json"), "utf8")) as { larkCli?: string; node?: string };
        const v = name === "node" ? j?.node : j?.larkCli;
        if (v) return v;
      } catch { /* 缺版本戳 */ }
    }
    return "随包";
  }
  if (name === "pi") {
    const p = bundledPiBin();
    return p ? readTextSafe(join(dirname(p), "VERSION")) || "随包" : "随包";
  }
  if (name === "pi-packages") {
    const src = resolvePiPackagesSource();
    if (src) {
      try {
        const j = JSON.parse(readFileSync(join(src, "packages.json"), "utf8")) as { packages?: Array<{ version?: string }> };
        const vers = [...new Set((j.packages ?? []).map((p) => p.version ?? "").filter(Boolean))];
        if (vers.length) return vers.join("/");
      } catch { /* ignore */ }
    }
    return "随包";
  }
  return "随包"; // skills 无版本号，随包发布
}

// ---- 主动版本检测：启动后探测一次 + 每 6 小时刷新，结果缓存在内存（GUI 随时可读） ----
const COMPONENT_PROBE_INTERVAL_MS = 6 * 60 * 60 * 1000;
let componentProbe: { at: number; available: Record<string, string>; error?: string } = { at: 0, available: {} };

/** 有效版本：覆盖层已装 > 随包（"随包"视作无版本，仅用于建议计算） */
function effectiveVersion(name: (typeof COMPONENT_NAMES)[number]): string | undefined {
  return componentCurrentVersion(name) ?? bundledComponentVersion(name);
}

function recommendedNames(available: Record<string, string>): string[] {
  return COMPONENT_NAMES.filter((n) => evaluateUpgrade(n, effectiveVersion(n), available[n]).level === "update");
}

async function probeComponents(): Promise<void> {
  const feedUrl = feedUrlFromConfig(deployCfg);
  if (!feedUrl) {
    componentProbe = { at: Date.now(), available: {}, error: "" };
    return;
  }
  try {
    const m = await fetchFeedManifest(feedUrl, COMPONENT_PLATFORM);
    const available: Record<string, string> = {};
    for (const name of COMPONENT_NAMES) {
      const s = m.components[name];
      if (s) available[name] = s.version;
    }
    componentProbe = { at: Date.now(), available };
    const rec = recommendedNames(available);
    if (rec.length) {
      console.log(`[components] 主动检测：${rec.length} 项建议升级 → ${rec.map((n) => `${n}→${available[n]}`).join(", ")}`);
    } else {
      console.log("[components] 主动检测：全部组件无需升级");
    }
  } catch (e: any) {
    componentProbe = { at: Date.now(), available: componentProbe.available, error: e?.message ?? String(e) };
    console.warn(`[components] 主动检测失败（忽略）：${e?.message ?? e}`);
  }
}

async function componentsStatus(deep: boolean): Promise<Record<string, any>> {
  const feedUrl = feedUrlFromConfig(deployCfg);
  if (deep) await probeComponents(); // 手动「检查更新」= 立即刷新探测缓存
  const available = componentProbe.available ?? {};
  const components: Record<string, any>[] = [];
  for (const name of COMPONENT_NAMES) {
    const bundled = bundledComponentVersion(name);
    const installed = componentCurrentVersion(name) ?? null;
    const activePath =
      name === "lark-cli" ? resolveLarkBin()
      : name === "pi" ? resolvePiLauncher()
      : name === "node" ? process.execPath
      : name === "pi-packages" ? resolvePiPackagesSource() ?? ""
      : componentActiveDir("skills") ?? "";
    components.push({
      name,
      bundled,
      installed,
      activePath,
      policy: COMPONENT_POLICY[name],
      advice: evaluateUpgrade(name, installed ?? bundled, available[name]),
    });
  }
  // lark-cli 实测版本（比包内戳更可信）；失败不阻塞
  try {
    const r = await runLark(["--version"], { timeoutMs: 10_000 });
    const v = (r.stdout || r.stderr).trim().split("\n")[0].replace(/^\s*(lark-cli\s+)?(version\s+)?/i, "").trim();
    if (v) components[0].activeVersion = v;
  } catch { /* 忽略 */ }
  const out: Record<string, any> = {
    platform: COMPONENT_PLATFORM,
    feedUrl,
    components,
    available,
    checkedAt: componentProbe.at || null,
    recommended: recommendedNames(available),
  };
  if (componentProbe.error) out.availableError = componentProbe.error;
  if (deep && !feedUrl) out.availableError = "未配置组件更新源（deploy.json.componentFeedUrl）";
  return out;
}

/** 从组件源检查并安装；有任何更新落地后：清缓存、重建 pi 会话、重启守护进程 */
async function componentsUpdate(names?: string[]): Promise<Record<string, any>> {
  const feedUrl = feedUrlFromConfig(deployCfg);
  if (!feedUrl) {
    return { ok: false, message: "未配置组件更新源：请在 deploy.json 设置 componentFeedUrl（公司内网组件源），或联系 IT。" };
  }
  const wanted = Array.isArray(names) && names.length
    ? (names.filter((n) => (COMPONENT_NAMES as readonly string[]).includes(n)) as (typeof COMPONENT_NAMES)[number][])
    : undefined;
  const r = await installFromFeed({ feedUrl, platform: COMPONENT_PLATFORM, names: wanted });
  const changed = r.results.filter((x) => x.ok && /^已更新/.test(x.message));
  let daemonRestarted = false;
  if (changed.length) {
    resetLarkCliCache(); // 本进程内立即启用新 lark-cli
    pool.setPiBin(resolvePiLauncher()); // pi 亦为启动期快照，重新解析后再重建会话
    await pool.closeAll(); // 旧 pi 子进程按旧 bundle 启动，重建
    // 组件联动：pi-packages 新版 → 重新装配内置扩展；lark-cli 新版 → 重新导出内嵌技能
    if (changed.some((c) => c.name === "pi-packages")) {
      const src = resolvePiPackagesSource();
      if (src) {
        try {
          const a = assembleBundledPackages(src, APP_PI_DIR, true);
          console.log(`[components] ${a.message}`);
        } catch (e: any) {
          console.warn(`[components] 内置扩展重装配失败：${e?.message ?? e}`);
        }
      }
    }
    if (changed.some((c) => c.name === "lark-cli")) {
      await syncLarkSkills(true);
    }
    try {
      const ds = await daemonStatus();
      if (ds?.running) {
        await daemonControl("restart"); // 守护进程持有 lark-cli 长连接，必须重启
        daemonRestarted = true;
      }
    } catch { /* 守护进程未运行或不支持时忽略 */ }
    appendAudit({
      cluster: "onboarding",
      action: "components_update",
      resource: changed.map((c) => `${c.name}@${c.version}`).join(","),
      result: "ok",
      detail: { feedUrl, results: r.results },
    });
    console.log(`[components] 已更新：${changed.map((c) => `${c.name}@${c.version}`).join(", ")}${daemonRestarted ? "（守护进程已重启）" : ""}`);
    void probeComponents(); // 更新后立即刷新探测缓存（建议列表随之收敛）
  }
  return { ok: r.ok, results: r.results, changed: changed.length > 0, daemonRestarted, feedUrl };
}

/** 用户安装 pi 扩展包（registry 直取，不需要系统 npm）；装完重建会话，下一条消息即可用 */
async function piInstall(source: string): Promise<Record<string, any>> {
  if (!source.trim()) return { ok: false, message: "请填写包名（如 npm:pi-web-access 或 @scope/name@1.2.3）" };
  const registry = (deployCfg.npmRegistry ?? process.env.NPM_REGISTRY ?? DEFAULT_NPM_REGISTRY).replace(/\/+$/, "");
  try {
    const r = await installNpmPackage({ source, piDir: APP_PI_DIR, registry });
    await pool.closeAll(); // 让新扩展在下一条消息生效
    piPkgProbe = { at: 0, latest: {} }; // 让下一次探测重新查 latest
    appendAudit({ cluster: "onboarding", action: "pi_package_install", resource: `${r.name}@${r.version}`, result: "ok", detail: { registry, packages: r.packages } });
    console.log(`[pi] 已安装扩展包 ${r.name}@${r.version}（含依赖共 ${r.packages} 个包，registry=${registry}）`);
    return { ok: true, name: r.name, version: r.version, packages: r.packages };
  } catch (e: any) {
    return { ok: false, message: `安装失败：${e?.message ?? String(e)}` };
  }
}

// ---- pi 扩展包升级检测：用户自装包查 registry latest（内置包随「内嵌组件」走，不在此列） ----
let piPkgProbe: { at: number; latest: Record<string, string>; error?: string } = { at: 0, latest: {} };

/** 内置扩展包名（随组件包分发，更新走 /components/update 的 pi-packages 组件） */
function bundledPackageNames(): Set<string> {
  const src = resolvePiPackagesSource();
  if (!src) return new Set();
  try {
    const j = JSON.parse(readFileSync(join(src, "packages.json"), "utf8")) as { packages?: Array<{ name?: string }> };
    return new Set((j.packages ?? []).map((p) => String(p.name ?? "")).filter(Boolean));
  } catch {
    return new Set();
  }
}

async function probePiPackages(): Promise<void> {
  const registry = (deployCfg.npmRegistry ?? process.env.NPM_REGISTRY ?? DEFAULT_NPM_REGISTRY).replace(/\/+$/, "");
  const bundled = bundledPackageNames();
  const latest: Record<string, string> = {};
  let error: string | undefined;
  for (const ref of listPackageRefs(APP_PI_DIR)) {
    const name = ref.replace(/^npm:/, ""); // settings 里统一登记为 npm:<name>（不带版本）
    if (bundled.has(name)) continue; // 内置包由组件源管
    try {
      latest[name] = await latestVersionOf(name, registry, 12_000);
    } catch (e: any) {
      error = error ?? `${name}: ${e?.message ?? e}`;
    }
  }
  piPkgProbe = { at: Date.now(), latest, error };
}

function piPackagesStatus(): Record<string, any> {
  const bundled = bundledPackageNames();
  const packages = listPackageRefs(APP_PI_DIR).map((ref) => {
    const name = ref.replace(/^npm:/, ""); // settings 里统一登记为 npm:<name>（不带版本）
    const version = installedVersion(APP_PI_DIR, name) ?? "";
    const lat = piPkgProbe.latest[name];
    const isBundled = bundled.has(name);
    return {
      ref,
      name,
      version,
      bundled: isBundled,
      latest: lat ?? null,
      updateAvailable: !isBundled && !!lat && !!version && compareSemver(lat, version) > 0,
    };
  });
  return { ok: true, packages, checkedAt: piPkgProbe.at || null, checkError: piPkgProbe.error ?? null };
}

async function piRemove(source: string): Promise<Record<string, any>> {
  if (!source.trim()) return { ok: false, message: "请指定要移除的包名" };
  try {
    const r = removeNpmPackage(APP_PI_DIR, source);
    await pool.closeAll();
    appendAudit({ cluster: "onboarding", action: "pi_package_remove", resource: r.name, result: "ok" });
    return { ok: true, name: r.name };
  } catch (e: any) {
    return { ok: false, message: `移除失败：${e?.message ?? String(e)}` };
  }
}

// ---------------- 技能管理（列出 / 查看 / 启停 / 重新导出） ----------------
// 覆盖 pi 会话实际可见的三类技能；停用 = 移入 <root>/.disabled/（pi 扫描跳过 . 目录）。

function skillRoots() {
  return {
    builtinDir: resolveSkillsDir(),
    piSkillsDir: join(APP_PI_DIR, "skills"),
    companyDir: companySkillsDir(),
  };
}

function skillsList(): Record<string, any> {
  const roots = skillRoots();
  const skills = listSkills(roots);
  return {
    ok: true,
    skills,
    roots,
    counts: {
      total: skills.length,
      enabled: skills.filter((s) => s.enabled).length,
      larkCli: skills.filter((s) => s.source === "lark-cli").length,
      company: skills.filter((s) => s.source === "company").length,
      builtin: skills.filter((s) => s.source === "builtin").length,
      user: skills.filter((s) => s.source === "user").length,
    },
  };
}

function findSkill(source: string, name: string) {
  return listSkills(skillRoots()).find((s) => s.source === source && s.name === name);
}

async function skillsToggle(source: string, name: string, enabled: boolean): Promise<Record<string, any>> {
  const skill = findSkill(source, name);
  if (!skill) return { ok: false, message: `未找到技能：${source}/${name}` };
  const r = setSkillEnabled(skill, enabled);
  if (r.ok) {
    await pool.closeAll(); // 技能集变化：重建会话，下一条消息生效
    appendAudit({ cluster: "governance", action: enabled ? "skill_enable" : "skill_disable", resource: `${source}/${name}`, result: "ok" });
  }
  return { ...r, ...skillsList() };
}

/** 重新导出 lark-cli 内嵌技能（CLI 升级后一般自动触发，这里给用户手动入口） */
async function skillsRefresh(): Promise<Record<string, any>> {
  await syncLarkSkills(true);
  await pool.closeAll();
  return { ok: true, message: "已重新导出 lark-cli 技能", ...skillsList() };
}

// ---------------- HTTP 服务 ----------------

// ---------------- /proxy-img 的 SSRF 防护 ----------------
// 该端点由 <img> 触发（不带 Origin，CORS 挡不住），必须自己校验目标：
// 仅 https + 解析结果必须是公网地址（拒绝回环/私网/链路本地/云元数据段），并逐跳校验重定向。

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 6) {
    const l = ip.toLowerCase();
    if (l === "::1" || l === "::") return true;
    if (l.startsWith("fe80") || l.startsWith("fc") || l.startsWith("fd")) return true; // 链路本地 / 唯一本地
    if (l.startsWith("::ffff:")) return isPrivateIp(l.slice(7)); // v4-mapped
    return false;
  }
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // 解析异常按危险处理
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // 链路本地 / 云元数据 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

async function assertPublicHost(u: URL): Promise<void> {
  if (u.protocol !== "https:") throw new Error("仅支持 https 图片地址");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error("目标地址不可访问");
    return;
  }
  const addrs = await lookup(host, { all: true });
  if (addrs.length === 0) throw new Error("域名解析失败");
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error("目标地址不可访问");
  }
}

async function fetchImageSafely(rawUrl: string): Promise<{ buf: Buffer; ct: string }> {
  let target = new URL(rawUrl);
  for (let hop = 0; hop < 4; hop++) {
    await assertPublicHost(target);
    const r = await fetch(target, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location");
      if (!loc) throw new Error("重定向缺少 location");
      target = new URL(loc, target);
      continue;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const ct = r.headers.get("content-type") || "image/*";
    if (!/^image\//i.test(ct) && ct !== "application/octet-stream") throw new Error("非图片");
    return { buf: Buffer.from(await r.arrayBuffer()), ct };
  }
  throw new Error("重定向过多");
}

function json(res: ServerResponse, code: number, body: unknown): void {
  // CORS 头由 applyCors 按来源设置，这里不再硬编码 *
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
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
    applyCors(req, res);
    if (req.method === "OPTIONS") {
      const origin = req.headers.origin;
      const allowHeaders = "content-type, x-cw-nonce";
      // portal 取 Key 回调：来源是公司门户页面（不可预知），放行预检、靠 nonce 兜底
      if (path === "/portal/key-callback") {
        res.writeHead(204, {
          "access-control-allow-origin": origin ?? "*",
          "access-control-allow-methods": "POST,OPTIONS",
          "access-control-allow-headers": allowHeaders,
          "vary": "Origin",
        });
        res.end();
        return;
      }
      if (corsAllowAny() || !origin || originAllowed(origin)) {
        res.writeHead(204, {
          ...(origin ? { "access-control-allow-origin": origin } : {}),
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": allowHeaders,
          "vary": "Origin",
        });
        res.end();
        return;
      }
      console.warn(`[cors] 拒绝预检来源 ${origin}（${path}）`);
      res.writeHead(403, { "content-type": "application/json; charset=utf-8", "vary": "Origin" });
      res.end(JSON.stringify({ ok: false, message: "来源不允许" }));
      return;
    }
    // 状态变更请求：带 Origin 的跨站请求一律拒绝（浏览器表单/POST 必带 Origin）
    if (req.method !== "GET" && path !== "/portal/key-callback" && !corsAllowAny()) {
      const origin = req.headers.origin;
      if (origin && !originAllowed(origin)) {
        console.warn(`[cors] 拒绝跨站 ${req.method} ${path}（Origin: ${origin}）`);
        return json(res, 403, { ok: false, message: "来源不允许" });
      }
    }
    if (path === "/health") return json(res, 200, { ok: true });
    if (path === "/env" && req.method === "GET") return json(res, 200, await checkEnv());
    if (path === "/perm/list" && req.method === "GET") {
      return json(res, 200, { ok: true, permissions: listPermissions() });
    }
    if (path === "/perm/scopes" && req.method === "GET") {
      return json(res, 200, await permScopes());
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
    if (path === "/daemon/bus" && req.method === "POST") return json(res, 200, daemonBus(await readBody(req)));
    if (path === "/magene/status" && req.method === "GET") return json(res, 200, await mageneStatus());
    if (path === "/components/status" && req.method === "GET") {
      return json(res, 200, { ok: true, ...(await componentsStatus(u.searchParams.get("check") === "1")) });
    }
    if (path === "/pi/packages" && req.method === "GET") {
      if (u.searchParams.get("check") === "1") await probePiPackages();
      return json(res, 200, piPackagesStatus());
    }
    if (path === "/skills" && req.method === "GET") return json(res, 200, skillsList());
    if (path === "/skills/content" && req.method === "GET") {
      const skill = findSkill(u.searchParams.get("source") ?? "", u.searchParams.get("name") ?? "");
      if (!skill) return json(res, 404, { ok: false, message: "技能不存在" });
      try {
        return json(res, 200, { ok: true, name: skill.name, source: skill.source, path: skill.path, text: readSkillContent(skill) });
      } catch (e: any) {
        return json(res, 500, { ok: false, message: `读取失败：${e?.message ?? e}` });
      }
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      if (path === "/skills/toggle") {
        if (body?.confirm !== true) return json(res, 200, { ok: false, message: "写操作需确认（confirm）" });
        return json(res, 200, await skillsToggle(String(body?.source ?? ""), String(body?.name ?? ""), body?.enabled !== false));
      }
      if (path === "/skills/refresh") {
        if (body?.confirm !== true) return json(res, 200, { ok: false, message: "写操作需确认（confirm）" });
        return json(res, 200, await skillsRefresh());
      }
      if (path === "/components/update") {
        if (body?.confirm !== true) return json(res, 200, { ok: false, message: "写操作需确认（confirm）" });
        return json(res, 200, await componentsUpdate(Array.isArray(body?.names) ? body.names : undefined));
      }
      if (path === "/pi/install") {
        if (body?.confirm !== true) return json(res, 200, { ok: false, message: "写操作需确认（confirm）" });
        return json(res, 200, await piInstall(String(body?.source ?? "")));
      }
      if (path === "/pi/remove") {
        if (body?.confirm !== true) return json(res, 200, { ok: false, message: "写操作需确认（confirm）" });
        return json(res, 200, await piRemove(String(body?.source ?? "")));
      }
      if (path === "/daemon/start") return json(res, 200, await daemonControl("start"));
      if (path === "/daemon/stop") return json(res, 200, await daemonControl("stop"));
      if (path === "/daemon/restart") return json(res, 200, await daemonControl("restart"));
      if (path === "/daemon/install") return json(res, 200, await daemonInstallAutostart());
      if (path === "/magene/setup") {
        return json(res, 200, await mageneSetup(String(body?.baseUrl ?? ""), String(body?.apiKey ?? "")));
      }
      if (path === "/portal/open") return json(res, 200, portalOpen());
      if (path === "/portal/watch-start") return json(res, 200, portalWatchStart());
      if (path === "/portal/key-callback") {
        if (!nonceOk(req)) {
          console.warn("[portal] key-callback 被拒绝：nonce 缺失或不匹配");
          return json(res, 403, { ok: false, message: "nonce 无效" });
        }
        return json(res, 200, await portalKeyCallback(body));
      }
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

    // 全新机器："/login" 返回 needConfigInit 后，前端轮询此接口等应用配置完成
    if (path === "/config-init/status" && req.method === "GET") return json(res, 200, configInitStatus());
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
    if (path === "/bot/card-info" && req.method === "GET") return json(res, 200, await botCardInfo());
    if (path === "/knowledge/sync" && req.method === "GET") return json(res, 200, await syncKnowledgeSources());
    if (path === "/bot/profile" && req.method === "GET") return json(res, 200, await botProfile());
    // Bot 激活（IT 代建）
    if (req.method === "POST" && path === "/bot/activate") {
      const body = await readBody(req);
      return json(res, 200, await botActivate(String(body?.appId ?? ""), String(body?.appSecret ?? "")));
    }

    // 外部图片代理（绕过 WebView CSP 对飞书 CDN 等外部图片的限制）
    if (path === "/proxy-img" && req.method === "GET") {
      const url = u.searchParams.get("url") ?? "";
      if (!/^https?:\/\//i.test(url)) return json(res, 400, { ok: false, message: "仅支持 http(s)" });
      try {
        const { buf, ct } = await fetchImageSafely(url);
        res.writeHead(200, { "content-type": ct, "cache-control": "public, max-age=3600" });
        res.end(buf);
      } catch (e: any) {
        json(res, 502, { ok: false, message: `代理失败：${e?.message ?? String(e)}` });
      }
      return;
    }

    // 二维码图片
    if (path === "/qr" && req.method === "GET") {
      const url = u.searchParams.get("u") ?? "";
      if (!/^https?:\/\//.test(url)) return json(res, 400, { ok: false, message: "无效链接" });
      const dir = sessionDirFor(currentOpenId);
      await mkdir(dir, { recursive: true });
      const name = `qr-${Date.now()}.png`;
      const qr = await runLark(["auth", "qrcode", url, "--output", name], { timeoutMs: 30_000, cwd: dir });
      if (!qr.ok) return json(res, 500, { ok: false, message: "二维码生成失败" });
      const buf = await readFile(join(dir, name));
      await rm(join(dir, name), { force: true });
      res.writeHead(200, { "content-type": "image/png" });
      res.end(buf);
      return;
    }

    json(res, 404, { ok: false, message: `未找到 ${path}` });
  } catch (e: any) {
    json(res, 500, { ok: false, message: e?.message ?? String(e) });
  }
});

// 端口接管：App 被强杀/升级覆盖时，旧后端进程可能仍占着端口变成孤儿——新后端会
// EADDRINUSE 直接退出，App 表面正常、实际一直跑**旧代码**（升级后尤其危险），
// 且旧进程内存里的 nonce 与文件不一致。启动前若有旧 pidfile 指向的活进程，先收掉它。
const PID_FILE = join(homedir(), ".coworker", "gui-backend.pid");
function killStaleBackend(): void {
  try {
    const old = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
    if (!old || old === process.pid) return;
    process.kill(old, "SIGTERM");
    console.log(`[后端] 已接管端口：终止旧后端进程 pid=${old}`);
  } catch { /* 无 pidfile / 进程已退出 */ }
}

function startServer(): void {
  server.listen(PORT, "127.0.0.1", () => {
    writePortalNonce(); // GUI 页面探针读取该文件注入 nonce
    try {
      writeFileSync(PID_FILE, String(process.pid) + "\n", { mode: 0o600 });
    } catch { /* pidfile 失败不影响服务 */ }
    console.log(`✅ GUI 后端已启动 http://127.0.0.1:${PORT}（CORS 来源管控已启用）`);
    console.log(`   门户地址：${portalTarget?.base ? `${portalTarget.base}（来源：${portalTarget.source}）` : "未解析（可在登录后由工作台发现 / deploy.json 兜底）"}`);
    void portalSilentRefresh(); // 31 天 portal 会话静默配置（无会话/已配置时自动跳过）
    void ensurePiEnvironment(); // 内置 pi 扩展包 + lark-cli 技能装配（异步；未变时零拷贝跳过）
    // 主动版本检测：启动探测一次 + 每 6 小时刷新（检查源未配置时自动跳过）
    const probeAll = () => { void probeComponents(); void probePiPackages(); };
    void probeComponents().then(() => {
      void probePiPackages();
      setInterval(probeAll, COMPONENT_PROBE_INTERVAL_MS).unref?.();
    });
    // 登录后才有 openId，才能按用户读工作台应用列表；这里延迟到首次 /env 之后由 refreshPortalTarget 触发
  });
}
let listenRetried = false;
server.on("error", (e: any) => {
  if (e?.code === "EADDRINUSE" && !listenRetried) {
    listenRetried = true;
    killStaleBackend();
    setTimeout(() => {
      try { server.close(); } catch { /* 未监听时 close 会抛，忽略 */ }
      startServer();
    }, 800);
    return;
  }
  console.error("[后端] 监听失败：", e?.message ?? e);
  process.exit(1);
});
startServer();

process.on("SIGINT", async () => {
  await pool.closeAll();
  try {
    configInit.proc?.kill("SIGTERM");
  } catch { /* ignore */ }
  server.close(() => process.exit(0));
});
