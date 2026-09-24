/**
 * pi --mode rpc 客户端（JSONL 协议）。
 *
 * 关键实现点：
 * - 按 `\n` 手动切行（协议要求：不能用 Node readline，它会把 U+2028/2029 也当换行）。
 * - 发送命令带 id，按 id 关联 response；事件走回调。
 * - ask()：prompt → 等待 agent_settled → 返回该轮最终 assistant 文本（message_end 为准）。
 * - provider/model 不走 --provider/--model 启动参数：pi 启动时会同步校验这两个参数，
 *   而扩展注册的 provider（magene）要等异步拉取模型列表后才存在，带参启动直接
 *   "Unknown provider" 退出 code=1。改为子进程就绪后用 set_model RPC 动态选定
 *   （ensureModel：轮询 get_available_models 直到目标 provider 出现）。
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
  /** ask 超时暂停/恢复（dialog 挂起期间调用；同一时刻只有一个 ask 在飞） */
  private holdAskTimeout: (() => void) | null = null;
  private resumeAskTimeout: (() => void) | null = null;
  private closed = false;
  private assistantText = "";
  /** 最近 stderr（供退出/失败时输出原因，窗口 4KB） */
  private stderrTail = "";
  /** 模型已通过 set_model 选定（每个 client 一次；失败后允许重试） */
  private modelSelected = false;
  private ensureModelPromise: Promise<void> | null = null;

  constructor(cfg: AgentConfig, sessionId: string) {
    this.cfg = cfg;
    this.sessionId = sessionId;
    const args = [
      "--mode", "rpc",
      // 扩展/技能发现必须开启：settings.json 里的 pi 扩展包（内置的 todo / ask_user_question，
      // 以及用户自行安装的包）经发现机制加载；技能从 app 专属目录（PI_CODING_AGENT_DIR，
      // 含由 lark-cli 导出的 skills）发现。与员工个人 ~/.pi/agent 完全隔离——
      // GUI 后端启动即把 PI_CODING_AGENT_DIR 指向 ~/.coworker/pi-agent（含 spawn 环境），
      // 因此这里的发现范围就是 app 自己的目录，不会混入个人配置。
      "--session-id", sessionId,
      "--session-dir", cfg.sessionDir,
      "-e", cfg.extensionPath,
    ];
    if (cfg.thinkingLevel) args.push("--thinking", cfg.thinkingLevel);
    if (cfg.noBuiltinTools) args.push("--no-builtin-tools");
    if (cfg.allowedTools.length > 0) args.push("--tools", cfg.allowedTools.join(","));

    // piBin 可以是可执行文件（PATH 上的 pi / 原生二进制），也可以是 node 脚本（打包进 GUI 的 pi.mjs）。
    // 脚本形态用当前 node 解释器启动，保证与后端运行时一致。
    // 防御：Windows 的 `\\?\` verbatim 前缀会让 node 解析 argv[1] 时崩（EISDIR lstat 'C:'），
    // 无论来自 Tauri resource_dir 还是手配环境变量，这里统一剥掉。
    const piBin = cfg.piBin.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/i, "");
    const isNodeScript = /\.(mjs|cjs|js|ts)$/.test(piBin);
    const command = isNodeScript ? process.execPath : piBin;
    const scriptPrefix = isNodeScript ? [piBin] : [];
    console.log(`[pi] spawn ${command}${scriptPrefix[0] ? " " + scriptPrefix[0] : ""}`);

    this.proc = spawn(command, [...scriptPrefix, ...args], {
      env: { ...process.env, ...cfg.larkEnv, ...cfg.serverModeEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout.on("data", (d: Buffer) => this.onData(d));
    this.proc.stderr.on("data", (d: Buffer) => {
      this.stderrTail = (this.stderrTail + String(d)).slice(-4000);
      process.stderr.write(`[pi:${sessionId}] ${String(d)}`);
    });
    this.proc.on("exit", (code, signal) => {
      this.closed = true;
      const tail = this.stderrTail.trim().split("\n").slice(-6).join("\n");
      const err = new Error(
        `pi 子进程退出 code=${code} signal=${signal ?? ""}${tail ? `\n最后输出：\n${tail}` : ""}`,
      );
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
   * 等目标 provider 注册完成并选定模型，再放行 prompt。
   * 扩展注册的 provider（magene）在子进程启动后异步拉模型列表（~1s），
   * 启动参数带 provider/model 会因同步校验直接退出，故延迟到这里动态选定。
   * 幂等：成功一次后不再执行；失败下次 ask 重试。
   */
  async ensureModel(timeoutMs = 20_000): Promise<void> {
    if (this.modelSelected) return;
    if (!this.ensureModelPromise) {
      this.ensureModelPromise = this.selectModel(timeoutMs).then(
        () => {
          this.modelSelected = true;
        },
        (e) => {
          this.ensureModelPromise = null; // 允许下次 ask 重试（网关恢复等）
          throw e;
        },
      );
    }
    return this.ensureModelPromise;
  }

  private async selectModel(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.closed) throw new Error(`agent 已关闭（provider「${this.cfg.provider}」未就绪）`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let r: any;
      try {
        r = await this.send({ type: "get_available_models" }, Math.min(15_000, remaining));
      } catch {
        if (Date.now() >= deadline) break; // 子进程启动慢/命令超时 → 到期为止继续等
        await new Promise((res) => setTimeout(res, 500));
        continue;
      }
      const candidates: Array<{ id: string }> = (r?.data?.models ?? []).filter(
        (m: any) => m?.provider === this.cfg.provider,
      );
      if (candidates.length > 0) {
        if (this.cfg.model && !candidates.some((m) => m.id === this.cfg.model)) {
          throw new Error(
            `模型「${this.cfg.model}」不在 provider「${this.cfg.provider}」的可用列表（共 ${candidates.length} 个）`,
          );
        }
        // 未指定模型时优先选轻量默认款（网关侧已验证可用），否则取列表第一个
        // （注意 cfg.model 可能为空串，须用 || 而非 ??）
        const chosen = this.cfg.model
          || (candidates.find((m) => m.id === "deepseek-v4-flash") ?? candidates[0]).id;
        const sm = await this.send({ type: "set_model", provider: this.cfg.provider, modelId: chosen }, 15_000);
        if (sm.success === false) {
          throw new Error(`set_model 失败：${sm.error ?? JSON.stringify(sm).slice(0, 200)}`);
        }
        return;
      }
      await new Promise((res) => setTimeout(res, 500));
    }
    const tail = this.stderrTail.trim().split("\n").slice(-4).join("\n");
    throw new Error(
      `pi 在 ${timeoutMs / 1000}s 内未出现 provider「${this.cfg.provider}」的模型（扩展未注册或网关不可达）` +
      (tail ? `；最后输出：\n${tail}` : ""),
    );
  }

  /**
   * 向 agent 提问：prompt → 等待 agent_settled → 返回最终 assistant 文本。
   * 串行使用（同一会话同一时刻只允许一个 ask）。
   */
  async ask(text: string, timeoutMs = 120_000): Promise<string> {
    if (this.closed) throw new Error("agent 已关闭");
    await this.ensureModel();
    this.assistantText = "";
    const id = `p-${++seq}`;
    const resp = await this.send({ id, type: "prompt", message: text }, 30_000);
    if (resp.success === false) {
      throw new Error(`prompt 被拒绝: ${JSON.stringify(resp.error ?? resp)}`);
    }
    await new Promise<void>((resolve, reject) => {
      // 「用户思考时间不算 agent 预算」：扩展弹 dialog（确认卡片/选择）期间，
      // 由 holdAskTimeout() 暂停倒计时，用户应答后 resumeAskTimeout() 用剩余时间恢复。
      let remaining = timeoutMs;
      let startedAt = Date.now();
      let timer: NodeJS.Timeout | null = null;
      const waiter = () => {
        if (timer) clearTimeout(timer);
        this.holdAskTimeout = null;
        this.resumeAskTimeout = null;
        this.settledWaiters.delete(waiter);
        resolve();
      };
      const arm = () => {
        startedAt = Date.now();
        timer = setTimeout(() => {
          this.holdAskTimeout = null;
          this.resumeAskTimeout = null;
          this.settledWaiters.delete(waiter);
          reject(new Error(`agent 在 ${timeoutMs / 1000}s 内未完成（已扣除等待用户操作的时间）`));
        }, remaining);
      };
      this.holdAskTimeout = () => {
        if (!timer) return;
        clearTimeout(timer);
        timer = null;
        remaining = Math.max(5_000, remaining - (Date.now() - startedAt));
      };
      this.resumeAskTimeout = () => {
        if (timer || this.closed) return;
        arm();
      };
      arm();
      this.settledWaiters.add(waiter);
    });
    return this.assistantText.trim();
  }

  /** 暂停 ask 的完成超时（扩展 dialog 打开时调用；未在 ask 中则无操作） */
  holdTimeout(): void {
    this.holdAskTimeout?.();
  }

  /** 恢复 ask 的完成超时（dialog 应答/取消后调用） */
  resumeTimeout(): void {
    this.resumeAskTimeout?.();
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

  /** 直接写一行 JSON 到 stdin（用于 extension_ui_response 等无需响应的消息） */
  writeRaw(payload: Record<string, unknown>): void {
    if (this.closed) return;
    try {
      this.proc.stdin.write(JSON.stringify(payload) + "\n");
    } catch {
      /* ignore */
    }
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
