/**
 * 事件总线控制器：订阅生命周期（持有/让出/重试）+ 跨机让位信令。
 *
 * 背景（lark-cli 实测语义）：同一应用全局限一条事件长连接，先占优先——第二个
 * consumer 会被 lark-cli 用 API 查到远端连接后直接拒绝（exit 2
 * `another event bus is already connected to this app (N remote event connection(s) ...)`）；
 * 且 `event status`/`event stop` **只能看/停本机总线**，看不到远端占用。
 * 因此：**订阅结果本身是唯一权威信号**——不再拿本机 status 去猜远端是否接管
 * （那会在自己 6h 超时重订时把本机残留总线误判成"他端接管"，白等 5 分钟）。
 *
 *   held      两个事件 key（消息/卡片）订阅存活
 *   released  主动让出（本机 CLI/GUI 指令或收到 /coworker-yield 信令）；
 *             信令让出后冷却 YIELD_COOLDOWN_MS，期满自动重试（自愈：新机器随后
 *             退出时本机还能拿回总线）
 *   retrying  订阅失败/订阅退出后的退避重试。失败分两类：判定为「被他端占用」
 *             走 CONFLICT_BACKOFF（30s→…→10m 封顶），并按信令窗
 *             （SIGNAL_WINDOW_MS）向 bot 会话发 /coworker-yield 让位请求
 *             （owner 用户身份发送、发出即撤回），持有端收到后主动让出；
 *             其余失败走 FAIL_BACKOFF（5s→…→5m）。
 *
 * 跨机指令通道（CLI/GUI → 运行中的 daemon）：$COWORKER_STATE_DIR/bus-control.json
 * {cmd:"bus-stop"|"bus-start", nonce, ts}，daemon 每 2s 轮询，应用后删除并在
 * state 中回执 nonce。状态快照：$COWORKER_STATE_DIR/bus-state.json（status 展示用）。
 *
 * 启动时清理本机残留总线（上次被强杀留下的孤儿 consumer 会静默吞事件）；
 * 只作用于本机，远端占用时无效也无害；检测到另有 daemon 存活时不动。
 */
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { consumeEvent, stderrOf, type ConsumerHandle } from "./bot/consume.ts";
import { resolveLarkBin, LARK_CONFIG_DIR } from "./runtime.ts";

export type BusState = "held" | "released" | "retrying";

/** 状态目录（测试可用 COWORKER_STATE_DIR 隔离到临时目录） */
const CTRL_DIR = process.env.COWORKER_STATE_DIR?.trim() || join(homedir(), ".coworker");
const CONTROL_FILE = join(CTRL_DIR, "bus-control.json");
const STATE_FILE = join(CTRL_DIR, "bus-state.json");
const CHAT_CACHE = join(CTRL_DIR, "bot-chat.json");
const DAEMON_PID_FILE = join(CTRL_DIR, "daemon.pid");

/** 订阅存活期退出（6h --timeout 到期/断线）后的重订延迟：短延迟，别惩罚正常轮换 */
const EXIT_RETRY_MS = 3_000;
/** 普通订阅失败退避（未登录/网络/CLI 异常） */
const FAIL_BACKOFF = [5_000, 15_000, 30_000, 60_000, 2 * 60_000, 5 * 60_000];
/** 判定为被他端占用时的退避（对方可能几分钟后才让出） */
const CONFLICT_BACKOFF = [30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000];
const YIELD_COOLDOWN_MS = 5 * 60_000; // 被信令挤掉后的反抢冷却
const SIGNAL_WINDOW_MS = 10 * 60_000; // 让位信令发送频控窗
const CONTROL_POLL_MS = 2_000;

/**
 * 「被他端占用」特征（lark-cli exit 2 failed_precondition + 本地同订阅冲突）。
 * 必须吃**原始 Error 对象**：冲突证据在子进程 stderr 尾部（stderrOf 用 WeakMap 挂着），
 * 只传 message 字符串会永远匹配不到——冲突分支会静默退化成普通失败。
 */
export function isConflictError(err: unknown, fallbackText = ""): boolean {
  const text = `${err instanceof Error ? err.message : ""}\n${stderrOf(err)}\n${fallbackText}`;
  return /another event bus|remote event connection|已被.+(占用|连接)|事件订阅失败|already.*bus/i.test(text);
}

function writeJson(path: string, obj: unknown): void {
  try {
    writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
  } catch {
    /* 状态写失败不致命 */
  }
}

export interface BusEvents {
  onMessage: (e: any) => void;
  onCard: (e: any) => void;
  /** 让出/接管的通知回执（发给 owner；以 bot 身份经 HTTP API，不依赖事件连接） */
  notifyOwner: (text: string) => Promise<void>;
}

export class BusController {
  private handles: ConsumerHandle[] = [];
  private state: BusState = "retrying";
  private stateSince = Date.now();
  private lastError = "";
  private nextRetryAt = 0;
  private cooldownUntil = 0;
  private lastSignalAt = 0;
  /** 冲突退避档位 / 普通失败退避档位（成功即归零） */
  private conflictIdx = 0;
  private failIdx = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private controlTimer: NodeJS.Timeout | null = null;
  private lastAckNonce = "";
  private stopping = false;
  /** 测试注入口（避免真实发信令） */
  public signalSink: ((text: string) => void) | null = null;

  private cfg: { larkEventKeys: { message: string; card: string }; larkEnv: Record<string, string> };
  private ev: BusEvents;

  constructor(cfg: { larkEventKeys: { message: string; card: string }; larkEnv: Record<string, string> }, ev: BusEvents) {
    this.cfg = cfg;
    this.ev = ev;
  }

  async start(): Promise<void> {
    this.controlTimer = setInterval(() => this.pollControl(), CONTROL_POLL_MS);
    this.controlTimer.unref?.();
    await this.clearStaleLocalBus();
    await this.trySubscribe();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.controlTimer) clearInterval(this.controlTimer);
    this.releaseHandles();
  }

  /** 收到 owner 的 /coworker-yield 信令：让位给另一台设备 */
  async yieldToPeer(reason: string): Promise<void> {
    this.releaseHandles();
    this.setState("released", reason);
    this.cooldownUntil = Date.now() + YIELD_COOLDOWN_MS;
    this.scheduleRetry(YIELD_COOLDOWN_MS);
    try {
      await this.ev.notifyOwner(`已让出事件总线（${reason}）。新设备将自动接管；本机 ${Math.round(YIELD_COOLDOWN_MS / 60_000)} 分钟后若无新设备接管会自动重试。`);
    } catch {
      /* 回执失败不影响让出 */
    }
  }

  getState(): { state: BusState; since: number; lastError: string; nextRetryAt: number; cooldownUntil: number } {
    return {
      state: this.state,
      since: this.stateSince,
      lastError: this.lastError,
      nextRetryAt: this.nextRetryAt,
      cooldownUntil: this.cooldownUntil,
    };
  }

  // ---------------------------------------------------------------------------

  private setState(s: BusState, why: string): void {
    this.state = s;
    this.stateSince = Date.now();
    this.persistState(`state=${s} why=${why}`);
  }

  private persistState(extra = ""): void {
    writeJson(STATE_FILE, {
      state: this.state,
      since: new Date(this.stateSince).toISOString(),
      lastError: this.lastError,
      nextRetryAt: this.nextRetryAt ? new Date(this.nextRetryAt).toISOString() : null,
      cooldownUntil: this.cooldownUntil ? new Date(this.cooldownUntil).toISOString() : null,
      ackNonce: this.lastAckNonce || undefined,
      pid: process.pid,
      ts: new Date().toISOString(),
      extra,
    });
  }

  private releaseHandles(): void {
    for (const h of this.handles) {
      try {
        h.stop();
      } catch {
        /* ignore */
      }
    }
    this.handles = [];
  }

  private async trySubscribe(): Promise<void> {
    // 已持有就别再订：同一 EventKey 的第二个 consumer 会被 lark-cli 拒绝，
    // 而失败路径会 releaseHandles() 把已在工作的 handle 一起掐掉（bus-start 重入）。
    if (this.stopping || this.state === "held") return;
    this.lastError = "";
    let err: unknown = null;
    try {
      this.handles.push(await consumeEvent(this.cfg.larkEventKeys.message, "bot", this.ev.onMessage, this.cfg.larkEnv, () => this.onHandleExit("message")));
      this.handles.push(await consumeEvent(this.cfg.larkEventKeys.card, "bot", this.ev.onCard, this.cfg.larkEnv, () => this.onHandleExit("card")));
      this.conflictIdx = 0;
      this.failIdx = 0;
      this.setState("held", "subscribe-ok");
      console.log(`✅ 事件总线已持有（${this.cfg.larkEventKeys.message} + ${this.cfg.larkEventKeys.card}）`);
      return;
    } catch (e: any) {
      err = e;
      // 带上子进程 stderr 尾部：冲突/未登录/scope 缺失的真实原因在这里
      // （GUI 状态页与 coworker-daemon status 都展示 lastError）
      const tail = stderrOf(e).replace(/\s+/g, " ").trim();
      this.lastError = `${e?.message ?? e}${tail ? ` —— ${tail.slice(-200)}` : ""}`;
      this.releaseHandles();
    }
    if (isConflictError(err, this.lastError)) {
      this.setState("retrying", "conflict");
      void this.maybeSendYieldSignal();
      const delay = CONFLICT_BACKOFF[Math.min(this.conflictIdx, CONFLICT_BACKOFF.length - 1)];
      this.conflictIdx++;
      console.warn(`[bus] 事件总线被他端占用，${Math.round(delay / 1000)}s 后重试`);
      this.scheduleRetry(delay);
      return;
    }
    this.setState("retrying", "subscribe-failed");
    const delay = FAIL_BACKOFF[Math.min(this.failIdx, FAIL_BACKOFF.length - 1)];
    this.failIdx++;
    this.scheduleRetry(delay);
  }

  /**
   * 订阅子进程在 ready 后退出：6h --timeout 到期、断线、或本机总线被清理。
   * 不做任何"对端猜测"——直接短延迟重订，真正的占用会在重订时报冲突，
   * 再走冲突退避（避免拿本机 status 误判远端，见文件头注释）。
   */
  private onHandleExit(which: string): void {
    if (this.stopping || this.state !== "held") return;
    console.log(`[bus] ${which} 订阅退出（超时/断线），${EXIT_RETRY_MS / 1000}s 后重订`);
    this.releaseHandles();
    this.setState("retrying", `exit:${which}`);
    this.conflictIdx = 0;
    this.failIdx = 0;
    this.scheduleRetry(EXIT_RETRY_MS);
  }

  /**
   * 启动前清理本机残留总线：上次 daemon 被强杀（SIGKILL）时，它拉起的
   * `event consume` 子进程会成为孤儿，继续占着总线静默吞事件。lark-cli 的
   * `event stop --force` 正好能停掉"仍挂着 consumer 的本机总线"。
   * - 只作用于本机（远端占用时 stop 无效，也不会误伤别机）；
   * - 检测到另有 daemon 存活（daemon.pid 指向他人）时不动，交给订阅冲突逻辑；
   * - COWORKER_BUS_KEEP_LOCAL=1 可整体跳过（排障用）。
   */
  private async clearStaleLocalBus(): Promise<void> {
    if ((process.env.COWORKER_BUS_KEEP_LOCAL ?? "0") === "1") return;
    if (this.anotherDaemonAlive()) {
      console.log("[bus] 检测到另有守护进程存活，跳过本机总线清理");
      return;
    }
    try {
      const out = await larkCli(["event", "status", "--json"], 15_000);
      const apps = JSON.parse(out.slice(out.indexOf("{"))).apps ?? [];
      if (!apps.some((a: any) => a.running === true)) return;
      await larkCli(["event", "stop", "--force"], 20_000);
      console.log("[bus] 已清理本机残留事件总线（上次未优雅退出）");
    } catch (e: any) {
      console.warn(`[bus] 残留总线清理跳过：${e?.message ?? e}`);
    }
  }

  /** daemon.pid 是否指向另一个存活进程 */
  private anotherDaemonAlive(): boolean {
    try {
      const pid = parseInt(readFileSync(DAEMON_PID_FILE, "utf8").trim(), 10);
      if (!Number.isFinite(pid) || pid === process.pid) return false;
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private scheduleRetry(delayMs: number): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.nextRetryAt = Date.now() + delayMs;
    this.persistState();
    this.retryTimer = setTimeout(() => void this.trySubscribe(), delayMs);
    this.retryTimer.unref?.();
  }

  // ---------------------------------------------------------------------------
  // CLI/GUI 控制通道

  private pollControl(): void {
    let cmd: { cmd?: string; nonce?: string };
    try {
      cmd = JSON.parse(readFileSync(CONTROL_FILE, "utf8"));
      unlinkSync(CONTROL_FILE);
    } catch {
      return; // 无控制文件/已消费
    }
    if (!cmd?.cmd) return;
    this.lastAckNonce = cmd.nonce ?? "";
    if (cmd.cmd === "bus-stop") {
      // 取消已排队的重试，否则"让出"会在几秒后被自动重订覆盖
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.nextRetryAt = 0;
      this.releaseHandles();
      this.setState("released", "local-stop");
      this.cooldownUntil = 0; // 本机主动让出不设冷却，等 bus-start 或重启
      this.persistState("ack bus-stop");
      console.log("⏸ 事件总线已让出（本机指令）");
    } else if (cmd.cmd === "bus-start") {
      if (this.state === "held") {
        console.log("ℹ️ 事件总线已持有，bus-start 无须重复订阅");
        this.persistState("ack bus-start(already-held)");
        return;
      }
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.nextRetryAt = 0;
      this.setState("retrying", "local-start");
      console.log("▶ 尝试接管事件总线（本机指令）");
      this.conflictIdx = 0;
      this.failIdx = 0;
      void this.trySubscribe();
    }
  }

  // ---------------------------------------------------------------------------
  // 跨机让位信令（owner 用户身份 → bot p2p 会话）

  private async maybeSendYieldSignal(): Promise<void> {
    // 环境开关：COWORKER_BUS_YIELD_SIGNAL=0 禁发让位信令（server/测试环境防误踢）
    if ((process.env.COWORKER_BUS_YIELD_SIGNAL ?? "1") === "0") return;
    if (Date.now() - this.lastSignalAt < SIGNAL_WINDOW_MS) return;
    this.lastSignalAt = Date.now();
    const text = "/coworker-yield";
    if (this.signalSink) {
      this.signalSink(text); // 测试模式：不真实发送
      return;
    }
    try {
      const chatId = await resolveBotChat();
      if (!chatId) {
        console.warn("[bus] 未定位到与 Bot 的会话，跳过让位信令（本机收到过消息后会自动记住会话）");
        return;
      }
      const sent = await larkCli(["im", "+messages-send", "--chat-id", chatId, "--as", "user", "--text", text]);
      const messageId = /"message_id"\s*:\s*"(om_[^"]+)"/.exec(sent ?? "")?.[1];
      console.log("[bus] 已发送让位信令到 Bot 会话（持有端将让出；本端稍后自动接管）");
      if (messageId) {
        // 尽力撤回，避免污染会话；撤回失败不影响信令（事件已在持有端消费）
        await larkCli(["im", "messages", "delete", "--message-id", messageId, "--as", "user"]).catch(() => undefined);
      }
    } catch (e: any) {
      console.warn(`[bus] 让位信令发送失败：${e?.message ?? e}`);
    }
  }
}

// -----------------------------------------------------------------------------
// lark-cli 子进程封装（spawn + 参数数组，无 shell；带超时）
// -----------------------------------------------------------------------------

function larkCli(args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveLarkBin(), args, {
      env: {
        ...process.env,
        LARKSUITE_CLI_CONFIG_DIR: LARK_CONFIG_DIR,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        reject(new Error(`lark-cli ${args[0]} 超时`));
      }
    }, timeoutMs);
    child.stdout!.on("data", (d: Buffer) => (out += String(d)));
    child.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      code === 0 ? resolve(out) : reject(new Error(`lark-cli ${args.slice(0, 3).join(" ")} code=${code}: ${out.slice(-300)}`));
    });
  });
}


/** 记住 owner↔bot 的 p2p 会话（收到消息时由 handler 调用；chat_id 全局稳定） */
export function rememberBotChat(chatId: string): void {
  try {
    writeJson(CHAT_CACHE, { chatId, ts: new Date().toISOString() });
  } catch {
    /* ignore */
  }
}

/** 读取缓存的 owner↔bot p2p 会话（卡片回调校验来源用；无缓存返回 null） */
export function rememberedBotChat(): string | null {
  try {
    const chatId = JSON.parse(readFileSync(CHAT_CACHE, "utf8")).chatId;
    return typeof chatId === "string" && chatId.startsWith("oc_") ? chatId : null;
  } catch {
    return null;
  }
}

/**
 * 定位与 Bot 的 p2p 会话：
 * 1) 缓存文件（本机曾收到过消息）
 * 2) user 身份列全部 p2p，逐个用 bot 身份只读试探（bot 只在它与 owner 的会话里，
 *    不在的会话 API 报错）——首个可读者即目标；串行、每会话一条请求
 */
async function resolveBotChat(): Promise<string | null> {
  try {
    const cached = JSON.parse(readFileSync(CHAT_CACHE, "utf8")).chatId;
    if (typeof cached === "string" && cached.startsWith("oc_")) return cached;
  } catch {
    /* 无缓存 */
  }
  const listRaw = await larkCli(["im", "+chat-list", "--types", "p2p", "--as", "user"]);
  const chatIds = [...listRaw.matchAll(/"chat_id"\s*:\s*"(oc_[^"]+)"/g)].map((m) => m[1]);
  for (const oc of chatIds) {
    try {
      await larkCli(["im", "+chat-messages-list", "--chat-id", oc, "--page-size", "1", "--as", "bot"], 15_000);
      rememberBotChat(oc);
      return oc; // bot 可读 = bot 在该会话（个人 bot 可见性仅 owner，唯一）
    } catch {
      /* bot 不在该会话，继续 */
    }
  }
  return null;
}
