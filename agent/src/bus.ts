/**
 * 事件总线控制器：订阅生命周期（持有/让出/重试）+ 跨机让位信令。
 *
 * 背景：飞书同一应用全局只允许一个事件长连接（先占优先）。本控制器把原来
 * 「启动订阅一次、失败即永久降级」的逻辑升级为状态机：
 *
 *   held      两个事件 key（消息/卡片）订阅存活
 *   released  主动让出（本机 CLI/GUI 或收到 /coworker-yield 信令）；
 *             冷却 YIELD_COOLDOWN_MS 内不反抢，期满自动转 retrying（自愈：
 *             若新机器随后退出，本机还能拿回总线）
 *   retrying  退避重试（30s→1m→2m→5m→10m 封顶）；判定为「被他端占用」时，
 *             每个信令冷却窗（SIGNAL_WINDOW_MS）向 bot 会话发一条
 *             /coworker-yield 让位请求（以 owner 用户身份发送、发出即撤回），
 *             持有端收到后主动让出，本端下次重试即接管。
 *
 * 跨机指令通道（CLI/GUI → 运行中的 daemon）：~/.coworker/bus-control.json
 * {cmd:"bus-stop"|"bus-start", nonce, ts}，daemon 每 2s 轮询，应用后删除并在
 * state 中回执 nonce。状态快照：~/.coworker/bus-state.json（status 展示用）。
 */
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { consumeEvent, stderrOf, type ConsumerHandle } from "./bot/consume.ts";
import { resolveLarkBin, LARK_CONFIG_DIR } from "./runtime.ts";

export type BusState = "held" | "released" | "retrying";

const CTRL_DIR = join(homedir(), ".coworker");
const CONTROL_FILE = join(CTRL_DIR, "bus-control.json");
const STATE_FILE = join(CTRL_DIR, "bus-state.json");
const CHAT_CACHE = join(CTRL_DIR, "bot-chat.json");

const BACKOFF_STEPS = [30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000];
const YIELD_COOLDOWN_MS = 5 * 60_000; // 被挤掉后的反抢冷却
const SIGNAL_WINDOW_MS = 10 * 60_000; // 让位信令发送频控窗
const CONTROL_POLL_MS = 2_000;

/** 「被他端占用」特征（与 coworker-daemon.ts 的冲突正则同源） */
function isConflictError(err: unknown): boolean {
  const text = `${err instanceof Error ? err.message : ""}\n${stderrOf(err)}`;
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
  private backoffIdx = 0;
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
    if (this.stopping) return;
    this.lastError = "";
    try {
      this.handles.push(await consumeEvent(this.cfg.larkEventKeys.message, "bot", this.ev.onMessage, this.cfg.larkEnv, () => this.onHandleExit("message")));
      this.handles.push(await consumeEvent(this.cfg.larkEventKeys.card, "bot", this.ev.onCard, this.cfg.larkEnv, () => this.onHandleExit("card")));
      this.backoffIdx = 0;
      this.setState("held", "subscribe-ok");
      console.log(`✅ 事件总线已持有（${this.cfg.larkEventKeys.message} + ${this.cfg.larkEventKeys.card}）`);
      return;
    } catch (e: any) {
      this.lastError = `${e?.message ?? e}`;
      this.releaseHandles();
    }
    const conflict = isConflictError(this.lastError);
    this.setState("retrying", conflict ? "conflict" : "subscribe-failed");
    if (conflict) void this.maybeSendYieldSignal();
    const delay = BACKOFF_STEPS[Math.min(this.backoffIdx, BACKOFF_STEPS.length - 1)];
    this.backoffIdx++;
    this.scheduleRetry(delay);
  }

  /**
   * 订阅子进程在 ready 后退出（6h --timeout 到期/断线/被他端抢占）。
   * 退出后先查 event status：running=true 说明已有另一端接管（飞书长连接
   * 为后连抢占语义，盲目快速重订会造成两端互踢振荡）→ 转 released + 冷却；
   * 无连接 → 正常断线/到期，短延迟重订。
   */
  private onHandleExit(which: string): void {
    if (this.stopping || this.state !== "held") return;
    console.log(`[bus] ${which} 订阅退出，检查接管方…`);
    this.releaseHandles();
    this.setState("retrying", `exit:${which}`);
    setTimeout(() => void this.reconcileAfterExit(), 5_000).unref?.();
  }

  private async reconcileAfterExit(): Promise<void> {
    if (this.stopping || this.state === "held") return;
    const taken = await busTakenByPeer();
    if (taken) {
      console.log("[bus] 检测到他端已接管事件总线，本机让位（冷却后再评估接管）");
      this.setState("released", "peer-took-over");
      this.cooldownUntil = Date.now() + YIELD_COOLDOWN_MS;
      this.scheduleRetry(YIELD_COOLDOWN_MS);
    } else {
      this.backoffIdx = 0;
      void this.trySubscribe();
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
      this.releaseHandles();
      this.setState("released", "local-stop");
      this.cooldownUntil = 0; // 本机主动让出不设冷却，等 bus-start 或重启
      this.persistState("ack bus-stop");
      console.log("⏸ 事件总线已让出（本机指令）");
    } else if (cmd.cmd === "bus-start") {
      this.setState("retrying", "local-start");
      console.log("▶ 尝试接管事件总线（本机指令）");
      this.backoffIdx = 0;
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


/** 查询事件总线当前是否被他端持有（event status running 且连接进程非本 daemon 系） */
async function busTakenByPeer(): Promise<boolean> {
  try {
    const out = await larkCli(["event", "status", "--json"], 15_000);
    const i = out.indexOf("{");
    const apps = JSON.parse(out.slice(i)).apps ?? [];
    return apps.some((a: any) => a.running === true);
  } catch {
    return false; // 查询失败按无接管处理（走重订路径，由订阅结果兜底判定）
  }
}
/** 记住 owner↔bot 的 p2p 会话（收到消息时由 handler 调用；chat_id 全局稳定） */
export function rememberBotChat(chatId: string): void {
  try {
    writeJson(CHAT_CACHE, { chatId, ts: new Date().toISOString() });
  } catch {
    /* ignore */
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
