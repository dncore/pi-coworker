/**
 * Bot Agent 守护程序配置：全部由环境变量驱动（.env.example 为模板）。
 * RUN_MODE=local（默认，个人本机）| server（公司共享服务器）。
 */
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { detectMode, defaultTools, defaultNoBuiltin, serverModeEnv, type RunMode } from "./mode.ts";

const here = dirname(fileURLToPath(import.meta.url)); // agent/src
export const REPO_ROOT = resolve(here, "..", "..");

export interface AgentConfig {
  mode: RunMode;
  piBin: string;
  provider: string;
  model: string;
  thinkingLevel: string;
  extensionPath: string;
  allowedTools: string[];
  noBuiltinTools: boolean;
  sessionDir: string;
  maxAgents: number;
  agentIdleTtlMs: number;
  rateLimit: { windowMs: number; max: number };
  larkEventKeys: { message: string; card: string };
  larkEnv: Record<string, string>;
  auditFile: string;
  /** 传给 pi 子进程的环境（server 模式：COWORKER_SERVER_MODE=1 → 知识工具 bot 身份） */
  serverModeEnv: Record<string, string>;
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

function int(v: string | undefined, dflt: number): number {
  const n = parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : dflt;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const mode = detectMode(env);
  const sessionDir = expandHome(env.SESSION_DIR ?? (mode === "server" ? "~/.coworker/server-sessions" : "~/.coworker/local-sessions"));
  const auditFile = expandHome(env.AUDIT_FILE ?? "~/.coworker/audit.jsonl");
  return {
    mode,
    piBin: env.PI_BIN ?? "pi",
    provider: env.LLM_PROVIDER ?? "google",
    model: env.LLM_MODEL ?? "",
    thinkingLevel: env.THINKING_LEVEL ?? "medium",
    extensionPath: env.COWORKER_EXT ?? join(REPO_ROOT, "extensions", "index.ts"),
    allowedTools: env.TOOL_ALLOWLIST ? env.TOOL_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean) : defaultTools(mode, env),
    noBuiltinTools: defaultNoBuiltin(mode, env),
    sessionDir,
    maxAgents: int(env.MAX_AGENTS, 20),
    agentIdleTtlMs: int(env.AGENT_IDLE_TTL_MS, 10 * 60_000),
    rateLimit: { windowMs: int(env.RATE_WINDOW_MS, 60_000), max: int(env.RATE_MAX, mode === "server" ? 20 : 60) },
    larkEventKeys: {
      message: env.LARK_EVENT_MESSAGE ?? "im.message.receive_v1",
      card: env.LARK_EVENT_CARD ?? "card.action.trigger",
    },
    larkEnv: {
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
    },
    auditFile,
    serverModeEnv: serverModeEnv(mode),
  };
}
