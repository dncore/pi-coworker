/**
 * pi --mode rpc 客户端（JSONL 协议）。
 *
 * 关键实现点：
 * - 按 `\n` 手动切行（协议要求：不能用 Node readline，它会把 U+2028/2029 也当换行）。
 * - 发送命令带 id，按 id 关联 response；事件走回调。
 * - ask()：prompt → 等待 agent_settled → 返回该轮最终 assistant 文本（message_end 为准）。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentConfig } from "../config.ts";

let seq = 0;

export interface RpcEvent {
  type: string;
  [k: string]: any;
}

export class PiRpcClient {
  private proc: ChildProcessWithoutNullStreams;
  private cfg: AgentConfig;
  private sessionId: string;
  private buf = "";
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private eventHandlers = new Set<(e: RpcEvent) => void>();
  private settledWaiters = new Set<() => void>();
  private closed = false;
  private assistantText = "";

  constructor(cfg: AgentConfig, sessionId: string) {
    this.cfg = cfg;
    this.sessionId = sessionId;
    const args = [
      "--mode", "rpc",
      "--no-extensions",
      "--provider", cfg.provider,
      "--session-id", sessionId,
      "--session-dir", cfg.sessionDir,
      "-e", cfg.extensionPath,
    ];
    if (cfg.model) args.push("--model", cfg.model);
    if (cfg.thinkingLevel) args.push("--thinking", cfg.thinkingLevel);
    if (cfg.noBuiltinTools) args.push("--no-builtin-tools");
    if (cfg.allowedTools.length > 0) args.push("--tools", cfg.allowedTools.join(","));

    this.proc = spawn(cfg.piBin, args, {
      env: { ...process.env, ...cfg.larkEnv, ...cfg.serverModeEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout.on("data", (d: Buffer) => this.onData(d));
    this.proc.stderr.on("data", (d: Buffer) => process.stderr.write(`[pi:${sessionId}] ${String(d)}`));
    this.proc.on("exit", (code, signal) => {
      this.closed = true;
      const err = new Error(`pi 子进程退出 code=${code} signal=${signal ?? ""}`);
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
      for (const w of this.settledWaiters) w();
      this.settledWaiters.clear();
    });
  }

  get id(): string {
    return this.sessionId;
  }

  isClosed(): boolean {
    return this.closed;
  }

  onEvent(fn: (e: RpcEvent) => void): void {
    this.eventHandlers.add(fn);
  }

  /** 发送命令并等待带相同 id 的 response */
  send(cmd: Record<string, any>, timeoutMs = 30_000): Promise<any> {
    if (this.closed) return Promise.reject(new Error("agent 已关闭"));
    return new Promise((resolve, reject) => {
      const id = cmd.id ?? `req-${++seq}`;
      const full: Record<string, any> = { ...cmd, id };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC 命令超时: ${full.type}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v: any) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.proc.stdin.write(JSON.stringify(full) + "\n");
    });
  }

  /**
   * 向 agent 提问：prompt → 等待 agent_settled → 返回最终 assistant 文本。
   * 串行使用（同一会话同一时刻只允许一个 ask）。
   */
  async ask(text: string, timeoutMs = 120_000): Promise<string> {
    if (this.closed) throw new Error("agent 已关闭");
    this.assistantText = "";
    const id = `p-${++seq}`;
    const resp = await this.send({ id, type: "prompt", message: text }, 30_000);
    if (resp.success === false) {
      throw new Error(`prompt 被拒绝: ${JSON.stringify(resp.error ?? resp)}`);
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settledWaiters.delete(waiter);
        reject(new Error(`agent 在 ${timeoutMs / 1000}s 内未完成`));
      }, timeoutMs);
      const waiter = () => {
        clearTimeout(timer);
        this.settledWaiters.delete(waiter);
        resolve();
      };
      this.settledWaiters.add(waiter);
    });
    return this.assistantText.trim();
  }

  close(): void {
    if (this.closed) return;
    try {
      this.proc.stdin.end();
    } catch {
      /* ignore */
    }
    const t = setTimeout(() => {
      try {
        this.proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, 3000);
    t.unref();
  }

  private onData(d: Buffer): void {
    this.buf += String(d);
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      try {
        this.handleLine(JSON.parse(line));
      } catch {
        process.stderr.write(`[pi:${this.sessionId}] 无法解析 RPC 行: ${line.slice(0, 200)}\n`);
      }
    }
  }

  private handleLine(msg: RpcEvent): void {
    // 带 id 且是请求响应 → 关联 pending
    if (msg.id && this.pending.has(msg.id) && (msg.type === "response" || msg.command)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      p.resolve(msg);
      return;
    }
    switch (msg.type) {
      case "message_end": {
        const m = msg.message;
        if (m?.role === "assistant") {
          const text = (m.content ?? [])
            .filter((c: any) => c.type === "text" && typeof c.text === "string")
            .map((c: any) => c.text)
            .join("");
          if (text) this.assistantText = text;
        }
        break;
      }
      case "agent_settled": {
        for (const w of this.settledWaiters) w();
        this.settledWaiters.clear();
        break;
      }
    }
    for (const fn of this.eventHandlers) {
      try {
        fn(msg);
      } catch {
        /* 事件回调异常不影响主循环 */
      }
    }
  }
}
