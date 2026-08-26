/**
 * 自更新检查（可选）：守护进程向公司更新源查询新版本。
 *
 * 更新源（UPDATE_URL）需返回 JSON：
 *   { "version": "0.2.0", "url": "https://.../pi-coworker-0.2.0.tar.gz", "notes": "变更说明" }
 *
 * 边界：
 *   - 默认关闭（UPDATE_URL 为空不检查）。
 *   - 只做「检查 + 提示」，不自动下载/替换（更新走 pi update --extensions + 重启，见 RELEASE.md）。
 *   - 失败静默降级，不影响守护进程主流程。
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface UpdateCheckConfig {
  url: string;
  intervalMs: number;
}

export interface UpdateResult {
  current: string;
  latest: string | null;
  available: boolean;
  url: string | null;
  notes: string | null;
  error?: string;
}

const here = dirname(fileURLToPath(import.meta.url)); // agent/src
export const AGENT_ROOT = join(here, ".."); // agent/
export const PACKAGE_ROOT = join(AGENT_ROOT, ".."); // 仓库根

/** 读取本地版本（仓库根 package.json 的 version 字段） */
export function localVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** 简易语义化比较：major.minor.patch 数字比较，忽略预发布后缀 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/** 检查更新：GET {url}（期望 version.json），返回对比结果 */
export async function checkUpdate(cfg: UpdateCheckConfig, timeoutMs = 8_000): Promise<UpdateResult> {
  const current = localVersion();
  const base: UpdateResult = { current, latest: null, available: false, url: null, notes: null };
  if (!cfg.url) return base;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch(cfg.url, { signal: controller.signal });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const j = (await resp.json()) as { version?: string; url?: string; notes?: string };
    const latest = String(j.version ?? "").trim();
    if (!latest) throw new Error("version 字段缺失");
    return {
      current,
      latest,
      available: compareVersions(latest, current) > 0,
      url: j.url ?? null,
      notes: j.notes ?? null,
    };
  } catch (e: any) {
    return { ...base, error: e?.message ?? String(e) };
  }
}
