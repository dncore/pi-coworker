/**
 * agent 池：每个员工（open_id）一个独立 pi RPC 会话。
 * - 懒启动：首次提问才拉起
 * - LRU 淘汰 + 空闲回收：控制服务器资源与 token 成本
 * - 串行：同一会话同一时刻只允许一个 ask（由调用方保证或在此排队）
 */
import { PiRpcClient } from "./rpc.ts";
import type { AgentConfig } from "../config.ts";

interface Entry {
  client: PiRpcClient;
  lastUsed: number;
  busy: boolean;
  queue: Array<() => void>;
}

export class PiAgentPool {
  private agents = new Map<string, Entry>();
  private cfg: AgentConfig;

  constructor(cfg: AgentConfig) {
    this.cfg = cfg;
  }

  /** 取（或创建）某员工对应的 agent 会话；返回的 ask 包装保证串行 */
  async ask(openId: string, text: string, timeoutMs?: number): Promise<string> {
    const entry = this.getEntry(openId);
    await this.acquire(entry);
    try {
      entry.lastUsed = Date.now();
      return await entry.client.ask(text, timeoutMs);
    } finally {
      entry.busy = false;
      this.releaseNext(entry);
    }
  }

  /** 空闲回收 + 关闭全部 */
  async sweep(): Promise<void> {
    const now = Date.now();
    for (const [k, e] of this.agents) {
      if (!e.busy && e.queue.length === 0 && now - e.lastUsed > this.cfg.agentIdleTtlMs) {
        e.client.close();
        this.agents.delete(k);
      }
    }
  }

  async closeAll(): Promise<void> {
    for (const e of this.agents.values()) e.client.close();
    this.agents.clear();
  }

  stats(): { active: number; openIds: string[] } {
    return { active: this.agents.size, openIds: [...this.agents.keys()] };
  }

  // ---------- internal ----------

  private getEntry(openId: string): Entry {
    let e = this.agents.get(openId);
    if (!e) {
      if (this.agents.size >= this.cfg.maxAgents) this.evictLru();
      e = { client: new PiRpcClient(this.cfg, openId), lastUsed: Date.now(), busy: false, queue: [] };
      this.agents.set(openId, e);
    }
    return e;
  }

  private acquire(entry: Entry): Promise<void> {
    if (!entry.busy) {
      entry.busy = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      entry.queue.push(resolve);
    });
  }

  private releaseNext(entry: Entry): void {
    const next = entry.queue.shift();
    if (next) {
      entry.busy = true;
      next();
    }
  }

  private evictLru(): void {
    let oldest: string | null = null;
    let oldestTs = Infinity;
    for (const [k, e] of this.agents) {
      if (e.busy) continue;
      if (e.lastUsed < oldestTs) {
        oldestTs = e.lastUsed;
        oldest = k;
      }
    }
    if (oldest) {
      const e = this.agents.get(oldest)!;
      e.client.close();
      this.agents.delete(oldest);
    }
  }
}
