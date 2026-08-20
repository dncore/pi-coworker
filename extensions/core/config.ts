/**
 * 配置加载与校验（DESIGN.md §6）。
 * - 用户级配置：~/.coworker/coworker.json（员工 + setup 维护）
 * - 包内配置：config/{catalog,knowledge,policy}.json（管理员维护）
 * - 审计日志：~/.coworker/audit.jsonl
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";

export const COWORKER_DIR = join(homedir(), ".coworker");

export function userConfigPath(): string {
  return join(COWORKER_DIR, "coworker.json");
}
export function auditPath(): string {
  return join(COWORKER_DIR, "audit.jsonl");
}

export interface CoworkerUserConfig {
  version: number;
  user?: {
    name?: string;
    email?: string;
    openId?: string;
    userId?: string;
    avatarUrl?: string;
  };
  roles: string[];
  clusters: {
    enabled: string[];
    /** 公司技能目录（resources_discover 动态加载；默认 ~/.coworker/skills） */
    skillsDir?: string;
  };
  lark?: {
    scopes?: string[];
    domains?: string[];
  };
  onboardedAt?: string;
}

const DEFAULT_USER_CONFIG: CoworkerUserConfig = {
  version: 1,
  roles: [],
  clusters: { enabled: [] },
};

export function loadUserConfig(): CoworkerUserConfig {
  try {
    const raw = readFileSync(userConfigPath(), "utf8");
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_USER_CONFIG,
      ...parsed,
      clusters: { ...DEFAULT_USER_CONFIG.clusters, ...(parsed.clusters ?? {}) },
    };
  } catch {
    return { ...DEFAULT_USER_CONFIG };
  }
}

export function saveUserConfig(cfg: CoworkerUserConfig): void {
  mkdirSync(COWORKER_DIR, { recursive: true });
  writeFileSync(userConfigPath(), JSON.stringify(cfg, null, 2), "utf8");
}

export function patchUserConfig(patch: Partial<CoworkerUserConfig>): CoworkerUserConfig {
  const cfg = loadUserConfig();
  const next: CoworkerUserConfig = {
    ...cfg,
    ...patch,
    user: { ...(cfg.user ?? {}), ...(patch.user ?? {}) },
    clusters: { ...cfg.clusters, ...(patch.clusters ?? {}) },
    lark: { ...(cfg.lark ?? {}), ...(patch.lark ?? {}) },
  };
  saveUserConfig(next);
  return next;
}

/** 包根目录（含 config/ 与 skills/）——从本文件位置向上解析 */
export function packageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // <root>/extensions/core
  return join(here, "..", "..");
}

export function bundledConfigPath(name: "catalog" | "knowledge" | "policy"): string {
  return join(packageRoot(), "config", `${name}.json`);
}

export function loadJsonFile<T = any>(absPath: string): T | null {
  try {
    return JSON.parse(readFileSync(absPath, "utf8")) as T;
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    throw new Error(`配置文件解析失败 ${absPath}: ${e?.message ?? e}`);
  }
}

export function loadBundledConfig(name: "catalog" | "knowledge" | "policy"): any | null {
  return loadJsonFile(bundledConfigPath(name));
}

/** 审计：追加一条 JSONL（governance 层，DESIGN.md §7） */
export function appendAudit(entry: {
  user?: string;
  cluster: string;
  action: string;
  resource: string;
  result: "ok" | "error" | "blocked" | "pending";
  detail?: Record<string, unknown>;
}): void {
  try {
    mkdirSync(COWORKER_DIR, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    appendFileSync(auditPath(), line + "\n", "utf8");
  } catch {
    // 审计失败不阻断业务
  }
}

export interface AuditEntry {
  ts: string;
  user?: string;
  cluster: string;
  action: string;
  resource: string;
  result: string;
  detail?: Record<string, unknown>;
}

/** 读取审计日志（倒序，limit 条） */
export function readAudit(limit = 50): AuditEntry[] {
  try {
    const lines = readFileSync(auditPath(), "utf8").split("\n").filter(Boolean);
    return lines
      .slice(-limit)
      .reverse()
      .map((l) => {
        try {
          return JSON.parse(l) as AuditEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is AuditEntry => e !== null);
  } catch {
    return [];
  }
}

export function pathExists(p: string): boolean {
  return existsSync(p);
}
