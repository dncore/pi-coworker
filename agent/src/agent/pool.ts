/**
 * agent 池：每个员工（open_id）一个独立 pi RPC 会话。
 * - 懒启动：首次提问才拉起
 * - LRU 淘汰 + 空闲回收：控制服务器资源与 token 成本
 * - 串行：同一会话同一时刻只允许一个 ask（由调用方保证或在此排队）
 */
import { PiRpcClient } from "./rpc.ts";
import type { AgentConfig } from "../config.ts";
import { join } from "node:path";

interface Entry {
  client: PiRpcClient;
  lastUsed: number;
  busy: boolean;
  queue: Array<() => void>;
}

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

export class PiAgentPool {
  private agents = new Map<string, Entry>();
  private cfg: AgentConfig;
  /** 扩展 UI 交互（extension_ui_request）回调；未注册时 dialog 自动取消（安全默认） */
  private onUiEvent: ((openId: string, req: any) => void) | null;

  constructor(cfg: AgentConfig, opts: { onUiEvent?: (openId: string, req: any) => void } = {}) {
    this.cfg = cfg;
    this.onUiEvent = opts.onUiEvent ?? null;
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
      // 扩展 UI 交互：有回调转发出去；否则 dialog 自动取消（避免无响应卡死）
      e.client.onEvent((msg) => {
        if (msg?.type !== "extension_ui_request") return;
        if (this.onUiEvent) {
          this.onUiEvent(openId, msg);
        } else if (DIALOG_METHODS.has(msg.method)) {
          e!.client.writeRaw({ type: "extension_ui_response", id: msg.id, cancelled: true });
        }
      });
      this.agents.set(openId, e);
    }
    return e;
  }

  /** 直接对某会话写入原始 RPC 消息（如 extension_ui_response） */
  writeRaw(openId: string, payload: Record<string, unknown>): void {
    const e = this.agents.get(openId);
    e?.client.writeRaw(payload);
  }

  /** 关闭并移除某会话（下次 ask 用新参数重建；用于模型切换等） */
  closeSession(openId: string): void {
    const e = this.agents.get(openId);
    if (e) {
      e.client.close();
      this.agents.delete(openId);
    }
  }

  /** 设置默认模型（新 client 生效；已建会话调用方先 closeSession） */
  setModel(model: string): void {
    this.cfg.model = model;
  }

  /** 切换会话目录（用户身份变化时调用；调用方应先 closeAll 清掉旧会话） */
  setSessionDir(dir: string): void {
    this.cfg.sessionDir = dir;
    this.cfg.auditFile = join(dir, "audit.jsonl");
  }

  getCfgModel(): string {
    return this.cfg.model ?? "";
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
