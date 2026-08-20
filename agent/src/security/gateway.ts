/**
 * 安全网关：限流 + 审计。
 */
import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentConfig } from "../config.ts";

export class Gateway {
  private hits = new Map<string, number[]>();
  private cfg: AgentConfig;

  constructor(cfg: AgentConfig) {
    this.cfg = cfg;
  }

  /** 滑动窗口限流：返回是否允许 + 建议重试等待 */
  check(openId: string): { ok: boolean; retryAfterMs?: number } {
    const now = Date.now();
    const window = this.cfg.rateLimit.windowMs;
    const max = this.cfg.rateLimit.max;
    let arr = (this.hits.get(openId) ?? []).filter((t) => now - t < window);
    if (arr.length >= max) {
      this.hits.set(openId, arr);
      const oldest = arr[0];
      return { ok: false, retryAfterMs: oldest + window - now };
    }
    arr.push(now);
    this.hits.set(openId, arr);
    return { ok: true };
  }

  audit(entry: { user?: string; cluster: string; action: string; resource: string; result: string; detail?: Record<string, unknown> }): void {
    try {
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
      mkdirSync(dirname(this.cfg.auditFile), { recursive: true });
      appendFileSync(this.cfg.auditFile, line + "\n", "utf8");
    } catch {
      /* 审计失败不阻断 */
    }
  }
}
