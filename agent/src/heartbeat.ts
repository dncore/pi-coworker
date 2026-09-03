/**
 * 轻心跳（可选）：Bot Agent 守护进程周期向公司一个极简端点上报在线状态。
 *
 * 用途（DESIGN-LOCAL.md §3.3）：IT 侧能看到「哪些员工的本机 agent 掉线了」。
 *
 * 边界：
 *   - 默认关闭（HEARTBEAT_URL 为空时不启动）。
 *   - 只上报 { ts, mode, pid, openId, status }，**绝不携带任何对话/业务内容**。
 *   - 上报失败静默降级（记日志），不影响守护进程主流程。
 */
import { spawnSync } from "node:child_process";
import { resolveLarkBin } from "./runtime.ts";

export interface HeartbeatConfig {
  url: string;
  intervalMs: number;
  mode: string;
}

let cachedOpenId: string | null = null;
let openIdTried = false;

/** 通过 lark-cli 用户身份解析 openId（仅一次，失败返回 null） */
export function resolveOpenId(): string | null {
  if (openIdTried) return cachedOpenId;
  openIdTried = true;
  try {
    const r = spawnSync(resolveLarkBin(), ["auth", "status", "--json"], {
      env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" },
      encoding: "utf8",
      timeout: 20_000,
    });
    const start = (r.stdout || "").indexOf("{");
    if (start >= 0) {
      const j = JSON.parse((r.stdout || "").slice(start)) as any;
      const data = j?.data ?? j;
      const user = data?.identities?.user ?? data?.user ?? data;
      cachedOpenId = user?.open_id ?? user?.openId ?? null;
    }
  } catch {
    /* ignore */
  }
  return cachedOpenId;
}

let failureStreak = 0;

async function sendHeartbeat(cfg: HeartbeatConfig): Promise<void> {
  const openId = resolveOpenId();
  const payload = {
    ts: Date.now(),
    mode: cfg.mode,
    pid: process.pid,
    status: "online",
    openId: openId ?? null,
  };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    const resp = await fetch(cfg.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok && failureStreak % 10 === 0) {
      console.warn(`[heartbeat] 上报失败 HTTP ${resp.status}（${failureStreak + 1} 次）`);
    }
    failureStreak = resp.ok ? 0 : failureStreak + 1;
  } catch (e: any) {
    failureStreak += 1;
    if (failureStreak % 10 === 1) {
      console.warn(`[heartbeat] 上报失败：${e?.message ?? e}（已 ${failureStreak} 次，继续重试）`);
    }
  }
}

/** 启动心跳（无 URL 则不启动），返回停止函数 */
export function startHeartbeat(cfg: HeartbeatConfig): () => void {
  if (!cfg.url) return () => {};
  void sendHeartbeat(cfg); // 启动即上报一次
  const timer = setInterval(() => void sendHeartbeat(cfg), cfg.intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
