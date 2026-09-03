/**
 * Bot Agent 守护程序配置：全部由环境变量驱动（.env.example 为模板）。
 * RUN_MODE=local（默认，个人本机）| server（公司共享服务器）。
 */
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { detectMode, defaultTools, defaultNoBuiltin, serverModeEnv, type RunMode } from "./mode.ts";
import { LARK_CONFIG_DIR } from "./runtime.ts";

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
  /** 轻心跳（可选）：HEARTBEAT_URL 为空则不启动 */
  heartbeatUrl: string;
  heartbeatIntervalMs: number;
  /** 自更新检查（可选）：UPDATE_URL 为空则不检查 */
  updateUrl: string;
  updateCheckIntervalMs: number;
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
      // App 专用配置目录（与用户系统里自己装的 lark-cli 隔离；首次使用自动迁移见 extensions/core/lark.ts）
      LARKSUITE_CLI_CONFIG_DIR: LARK_CONFIG_DIR,
    },
    auditFile,
    heartbeatUrl: (env.HEARTBEAT_URL ?? "").trim(),
    heartbeatIntervalMs: int(env.HEARTBEAT_INTERVAL_MS, 60_000),
    updateUrl: (env.UPDATE_URL ?? "").trim(),
    updateCheckIntervalMs: int(env.UPDATE_CHECK_INTERVAL_MS, 6 * 60 * 60 * 1000),
    serverModeEnv: serverModeEnv(mode),
  };
}
