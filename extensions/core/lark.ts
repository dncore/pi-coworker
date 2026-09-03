/**
 * lark-cli 子进程封装。
 *
 * 安全规则（对应 DESIGN.md §11）：
 * - 所有调用走 execFile（参数数组），不经过 shell，杜绝注入。
 * - 一律显式传 --as（user/bot），不依赖 profile 默认身份。
 * - 判断成功用信封的 ok == true（或退出码 0），不用 OpenAPI 老格式 code == 0。
 * - 高风险写操作尊重 exit 10（confirmation_required）：识别出来，绝不自动补 --yes。
 * - 输出做密钥脱敏（appSecret / access_token 等）。
 */
import { execFile, execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * App 专用 lark-cli 配置目录（与用户系统里自己装的 lark-cli 完全隔离，互不影响）：
 *   ~/.coworker/lark-cli/   （登录凭证 / 事件总线注册都在这里，不与 ~/.lark-cli 共享）
 * 首次使用时若隔离目录不存在，会把用户已有 ~/.lark-cli 的配置/凭证迁移过来，
 * 保留登录态（LARKSUITE_CLI_CONFIG_DIR 由 lark-cli 原生支持，见其 internal/core/config.go）。
 */
export const LARK_CONFIG_DIR = join(homedir(), ".coworker", "lark-cli");
const LEGACY_LARK_CONFIG_DIR = join(homedir(), ".lark-cli");
let larkConfigReady = false;

/** 首次调用时确保隔离配置目录存在（幂等；迁移失败不阻断使用） */
export function ensureLarkConfigDir(): void {
  if (process.env.LARKSUITE_CLI_CONFIG_DIR || larkConfigReady) return; // 显式指定则尊重
  larkConfigReady = true;
  try {
    if (existsSync(LARK_CONFIG_DIR)) return;
    if (!existsSync(LEGACY_LARK_CONFIG_DIR)) {
      mkdirSync(LARK_CONFIG_DIR, { recursive: true, mode: 0o700 });
      return;
    }
    mkdirSync(LARK_CONFIG_DIR, { recursive: true, mode: 0o700 });
    // 迁移配置/凭证/事件总线注册（logs/locks 是运行时状态，不迁移）
    for (const name of ["config.json", "update-state.json", "cache", "events"]) {
      const src = join(LEGACY_LARK_CONFIG_DIR, name);
      if (existsSync(src)) cpSync(src, join(LARK_CONFIG_DIR, name), { recursive: true });
    }
  } catch {
    /* 迁移失败不阻断（下次启动重试） */
  }
}

/** 常见 Node 版本管理器的 lark-cli 安装位置（fnm/nvm/volta/asdf） */
function managedCliCandidates(): string[] {
  const home = homedir();
  const out: string[] = [];
  try {
    for (const v of readdirSync(join(home, ".local", "share", "fnm", "node-versions"))) {
      out.push(join(home, ".local", "share", "fnm", "node-versions", v, "installation", "bin", "lark-cli"));
    }
  } catch { /* 无 fnm */ }
  try {
    for (const v of readdirSync(join(home, ".nvm", "versions", "node"))) {
      out.push(join(home, ".nvm", "versions", "node", v, "bin", "lark-cli"));
    }
  } catch { /* 无 nvm */ }
  out.push(join(home, ".volta", "bin", "lark-cli"));
  out.push(join(home, ".asdf", "shims", "lark-cli"));
  return out;
}

/**
 * 定位 lark-cli：GUI 经 Finder/`open` 启动时 PATH 不含用户 shell 路径，显式探测。
 * 优先级：$LARK_CLI_BIN > PATH > fnm/nvm/volta/asdf > 登录 shell（zsh/bash -lc）。结果缓存。
 */
let _larkCli: string | undefined;
export function resolveLarkCli(): string {
  if (_larkCli !== undefined) return _larkCli;
  const envBin = process.env.LARK_CLI_BIN?.trim();
  if (envBin) {
    _larkCli = envBin;
    return envBin;
  }
  // 内置 runtime 目录（Windows 安装包自带 node + lark-cli，解决新设备无依赖）
  const runtimeDir = process.env.LARK_CLI_RUNTIME_DIR?.trim();
  if (runtimeDir) {
    for (const name of ["lark-cli.exe", "lark-cli.cmd", "lark-cli"]) {
      const p = join(runtimeDir, name);
      if (existsSync(p)) {
        _larkCli = p;
        return p;
      }
    }
  }
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    for (const name of ["lark-cli", "lark-cli.exe", "lark-cli.cmd"]) {
      const p = join(dir, name);
      if (existsSync(p)) {
        _larkCli = p;
        return p;
      }
    }
  }
  for (const p of managedCliCandidates()) {
    if (existsSync(p)) {
      _larkCli = p;
      return p;
    }
  }
  for (const shell of ["/bin/zsh", "/bin/bash"]) {
    try {
      const out = execFileSync(shell, ["-lc", "command -v lark-cli"], {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const p = out.trim().split("\n")[0];
      if (p && existsSync(p)) {
        _larkCli = p;
        return p;
      }
    } catch {
      /* 继续尝试下一个 shell */
    }
  }
  // 回退到裸命令名：由调用方（exitCode -1 / ENOENT）呈现“未安装”语义
  _larkCli = "lark-cli";
  return _larkCli;
}

/** 抑制 lark-cli 的更新/技能提示，保证 JSON 稳定可解析；配置目录指向 app 隔离目录 */
export const LARK_ENV: Record<string, string> = {
  LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
  LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
  LARKSUITE_CLI_CONFIG_DIR: LARK_CONFIG_DIR,
};

export interface LarkErrorBody {
  type?: string;
  subtype?: string;
  code?: number;
  message?: string;
  hint?: string;
  missing_scopes?: string[];
  risk?: string;
  action?: string;
}

export interface LarkEnvelope {
  ok?: boolean;
  identity?: string;
  data?: any;
  meta?: any;
  error?: LarkErrorBody;
  /** 部分命令（mail +triage 等）无 data 包装，业务对象直接在信封顶层 */
  [key: string]: any;
}

export interface LarkResult {
  ok: boolean;
  exitCode: number;
  /** 解析出的 JSON 信封（成功在 stdout，失败在 stderr），解析不到为 null */
  envelope: LarkEnvelope | null;
  stdout: string;
  stderr: string;
  /** exit 10 高风险确认门禁 */
  confirmationRequired: boolean;
}

export interface RunOptions {
  /** 显式身份，总是传给 lark-cli */
  as?: "user" | "bot";
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
  /** 写入 stdin 的内容（如 config init --app-secret-stdin） */
  input?: string;
}

/** 从文本中提取第一个 JSON 对象（lark-cli 输出前后可能有日志/提示） */
export function extractJson(text: string): any | null {
  if (!text) return null;
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const raw = text.slice(start, i + 1);
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/"\s*(app_secret|appSecret|client_secret)\s*"\s*:\s*"[^"]{4,}"/g, `"$1":"***REDACTED***"`],
  [/"\s*(access_token|refresh_token|tenant_access_token|app_access_token|user_access_token)\s*"\s*:\s*"[^"]{8,}"/g, `"$1":"***REDACTED***"`],
  [/(app_secret|appSecret|client_secret)\s*[:=]\s*['"][^'"]{4,}['"]/g, `$1: '***REDACTED***'`],
  [/(authorization|Authorization)\s*[:=]\s*['"]Bearer [^'"]{8,}['"]/g, `$1: '***REDACTED***'`],
];

/** 对 lark-cli 输出做密钥脱敏（governance 层 tool_result 钩子与工具内共用） */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep as string);
  return out;
}

/** 解析 lark-cli 输出为 JSON 信封（成功信封在 stdout，错误信封在 stderr）
 * 注意：先剥掉 lark-cli 的 tip 提示行（部分命令会打印 tip: … 且含 JSON 花括号，会干扰 extractJson）。 */
export function parseEnvelope(stdout: string, stderr: string): LarkEnvelope | null {
  const clean = (s: string) => (s ?? "").replace(/^tip:.*$/gm, "");
  return extractJson(clean(stdout)) ?? extractJson(clean(stderr));
}

/** 统一取业务数据：部分命令（auth status / config show 等）直接返回原始对象，无 {ok,data} 信封 */
export function dataOf(envelope: LarkEnvelope | null): any {
  if (!envelope) return null;
  return envelope.data ?? envelope;
}

/** 统一取 user 身份对象（兼容信封内嵌与顶层两种形态） */
export function userIdentityOf(envelope: LarkEnvelope | null): any {
  const data = dataOf(envelope);
  return data?.identities?.user ?? data?.user ?? data;
}

/** 统计授权 scope 数（scope 可能是空格分隔字符串或数组） */
export function countScopes(scope: any): number {
  if (Array.isArray(scope)) return scope.length;
  if (typeof scope === "string" && scope.trim()) return scope.trim().split(/\s+/).length;
  return 0;
}

/**
 * 运行身份：服务器模式（COWORKER_SERVER_MODE=1，B1 机器人）用 bot 身份读公司知识；
 * 本机个人使用（默认）用 user 身份。
 */
export function runtimeIdentity(): "user" | "bot" {
  return process.env.COWORKER_SERVER_MODE === "1" ? "bot" : "user";
}

/**
 * 执行 lark-cli。
 * - 成功：exit 0，信封来自 stdout。
 * - 失败：exit != 0，信封来自 stderr（authorization / confirmation 等错误）。
 * - exit 10：confirmationRequired = true（高风险写操作需用户确认）。
 * - opts.input 时走 spawn（stdin 写入，如 config init --app-secret-stdin），避免密钥暴露在进程参数里。
 */
export async function runLark(args: string[], opts: RunOptions = {}): Promise<LarkResult> {
  ensureLarkConfigDir();
  const fullArgs = [...args];
  // auth / config 命令不接受 --as，其余命令一律显式传身份
  const first = fullArgs[0] ?? "";
  const noAs = first === "auth" || first === "config";
  if (opts.as && !noAs && !fullArgs.some((a) => a === "--as")) {
    fullArgs.push("--as", opts.as);
  }
  const env = { ...process.env, ...LARK_ENV, ...(opts.env ?? {}) };
  // lark-cli 是 node 脚本（shebang env node）：把其所在 bin 目录（通常与 node 同目录）前置到 PATH，
  // 保证 GUI 经 Finder/open 启动（最小 PATH）时 lark-cli 能解析到 node。
  const larkCli = resolveLarkCli();
  const binDir = dirname(larkCli);
  if (binDir !== "." && binDir !== "/") {
    env.PATH = [binDir, env.PATH].filter(Boolean).join(":");
  }
  const timeoutMs = opts.timeoutMs ?? 120_000;

  if (opts.input !== undefined) {
    return runLarkWithStdin(fullArgs, opts.input, env, timeoutMs, opts.cwd);
  }

  try {
    const { stdout, stderr } = await execFileAsync(resolveLarkCli(), fullArgs, {
      env,
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
      cwd: opts.cwd ?? process.cwd(),
    });
    return {
      ok: true,
      exitCode: 0,
      envelope: parseEnvelope(stdout ?? "", stderr ?? ""),
      stdout: stdout ?? "",
      stderr: stderr ?? "",
      confirmationRequired: false,
    };
  } catch (e: any) {
    const stdout: string = e?.stdout ?? "";
    const stderr: string = e?.stderr ?? "";
    const exitCode: number = typeof e?.code === "number" ? e.code : -1;
    const envelope = parseEnvelope(stdout, stderr);
    const confirmationRequired =
      exitCode === 10 ||
      (envelope?.error?.type === "confirmation" && envelope.error.subtype === "confirmation_required");
    return {
      ok: false,
      exitCode,
      envelope,
      stdout,
      stderr,
      confirmationRequired,
    };
  }
}

/** 错误结果文本：把 lark-cli 错误信封转成可读信息 */export function describeLarkError(r: LarkResult): string {
  const err = r.envelope?.error;
  if (r.confirmationRequired && err) {
    return (
      `[高风险操作需确认] action=${err.action ?? "?"} risk=${err.risk ?? "high-risk-write"}\n` +
      `${err.message ?? ""}${err.hint ? `\n提示：${err.hint}` : ""}`
    );
  }
  if (err) {
    const parts = [
      err.type && err.subtype ? `${err.type}/${err.subtype}` : err.type ?? "",
      err.code != null ? `code=${err.code}` : "",
      err.message ?? "",
      err.missing_scopes?.length ? `missing_scopes=${err.missing_scopes.join(",")}` : "",
      err.hint ? `hint=${err.hint}` : "",
    ];
    return parts.filter(Boolean).join(" | ");
  }
  const tail = (r.stderr || r.stdout).trim().slice(0, 500);
  return `lark-cli 退出码 ${r.exitCode}${tail ? `：${tail}` : ""}`;
}

/**
 * 带 stdin 输入的 lark-cli 调用（如 `config init --app-secret-stdin`）。
 * 走 spawn + stdin 写入：密钥不进入进程参数，避免 /proc 泄露。
 */
function runLarkWithStdin(
  args: string[],
  input: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
  cwd?: string,
): Promise<LarkResult> {
  ensureLarkConfigDir();
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(resolveLarkCli(), args, { env, cwd: cwd ?? process.cwd() });

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      const envelope = parseEnvelope(stdout, stderr);
      const confirmationRequired =
        exitCode === 10 ||
        (envelope?.error?.type === "confirmation" && envelope.error.subtype === "confirmation_required");
      resolve({
        ok: exitCode === 0,
        exitCode,
        envelope,
        stdout,
        stderr,
        confirmationRequired,
      });
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      finish(-1);
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", (e: any) => {
      clearTimeout(timer);
      finish(-1);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code ?? -1);
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}
