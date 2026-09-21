/**
 * 扩展 UI 桥：pi RPC 的 `extension_ui_request` → 飞书确认卡片 → `extension_ui_response`。
 *
 * 背景：RPC 模式下 ctx.hasUI === true，扩展里的 ctx.ui.confirm()（如 confirmWrite 写前确认）
 * 会发出 extension_ui_request 并阻塞等待响应。守护进程原先没有接这条链路，
 * dialog 被统一自动取消 —— 于是"写操作要用户确认"实际退化成"模型自己传 confirm:true"。
 * 本桥把它接回真正的用户：请求变成一张卡片发给 owner，点按钮才回写响应。
 *
 * 安全：
 * - 只在 local 模式接线（server 模式无写工具，dialog 保持自动取消）；
 * - 卡片带 config.enable_forward_interaction=false：被转发后按钮不生效；
 * - 回调再校验点击者 == 请求发起者（owner），并校验请求仍在有效期内；
 * - TTL 到期未点击 → 回 cancelled（fail-closed），并提示用户。
 */
import { coworkerCard } from "../../../extensions/core/cards/builder.ts";
import type { CardActionContext, CardActionOutcome, CardActionRegistry } from "../../../extensions/core/cards/registry.ts";

export interface ConfirmBridgeDeps {
  /** 发卡片（守护进程里是 LarkCardChannel） */
  channel: { sendToUser(openId: string, card: unknown): Promise<void> };
  /** 回写 RPC 响应（守护进程里是 pool.writeRaw(openId, payload)） */
  respond: (openId: string, payload: Record<string, unknown>) => void;
  /** 审计（可选） */
  audit?: (entry: { user: string; action: string; resource: string; result: string; detail?: Record<string, unknown> }) => void;
  /** 确认有效期（默认 10 分钟） */
  ttlMs?: number;
}

interface Pending {
  openId: string;
  id: string;
  title: string;
  timer: NodeJS.Timeout | null;
}

/** 扩展 UI 请求里我们支持的 dialog 方法；其余需要真实终端，飞书渠道不支持 */
const SUPPORTED = new Set(["confirm"]);

export class ConfirmBridge {
  private channel: ConfirmBridgeDeps["channel"];
  private respondFn: ConfirmBridgeDeps["respond"];
  private auditFn?: ConfirmBridgeDeps["audit"];
  private ttlMs: number;
  private pending = new Map<string, Pending>();

  constructor(deps: ConfirmBridgeDeps) {
    this.channel = deps.channel;
    this.respondFn = deps.respond;
    this.auditFn = deps.audit;
    this.ttlMs = deps.ttlMs ?? 10 * 60_000;
  }

  /** 处理一条 extension_ui_request */
  async handle(openId: string, req: any): Promise<void> {
    const id = String(req?.id ?? "");
    const method = String(req?.method ?? "");
    if (!id) return;

    if (!SUPPORTED.has(method)) {
      // select/input/editor 需要终端交互：直接取消，别让工具调用挂死
      this.respondFn(openId, { type: "extension_ui_response", id, cancelled: true });
      this.auditFn?.({ user: openId, action: "ui_unsupported", resource: method, result: "blocked" });
      try {
        await this.channel.sendToUser(
          openId,
          coworkerCard()
            .header("yellow", "⚠️ 该操作需要交互式终端")
            .md(`这个操作要求 \`${method}\` 输入（飞书渠道不支持），已自动取消。\n请在**桌面助手**或 CLI 里执行。`)
            .build(),
        );
      } catch {
        /* 提示失败不影响取消 */
      }
      return;
    }

    const key = this.key(openId, id);
    const timer = setTimeout(() => void this.expire(key), this.ttlMs);
    timer.unref?.();
    this.pending.set(key, { openId, id, title: String(req.title ?? "操作确认"), timer });

    this.auditFn?.({ user: openId, action: "ui_confirm_request", resource: id, result: "pending", detail: { title: String(req.title ?? "") } });
    await this.channel.sendToUser(openId, confirmCard(id, String(req.title ?? "操作确认"), String(req.message ?? ""), this.ttlMs));
  }

  /** 把卡片回调注册进动作注册表（守护进程启动时调用一次） */
  register(registry: CardActionRegistry): void {
    registry.register("ui_confirm", async (ctx: CardActionContext): Promise<CardActionOutcome> => {
      const id = String(ctx.event.action.id ?? "");
      const approve = ctx.event.action.approve === true;
      const operator = ctx.event.operatorId;
      const key = this.key(operator, id);
      const p = this.pending.get(key);
      if (!p) {
        return { update: decidedCard(false, "⏳ 该确认已过期或已处理，请重新发起操作。") };
      }
      if (p.openId !== operator) {
        // 理论上到不了（pending 以 operator 为键），保留显式校验以防键规则变更
        this.auditFn?.({ user: operator, action: "ui_confirm", resource: id, result: "blocked", detail: { reason: "operator-mismatch" } });
        return {};
      }
      this.settle(key, p);
      this.respondFn(operator, { type: "extension_ui_response", id, confirmed: approve });
      this.auditFn?.({ user: operator, action: "ui_confirm", resource: id, result: approve ? "ok" : "blocked", detail: { title: p.title } });
      return { update: decidedCard(approve, approve ? "✅ 已确认，正在执行…" : "❌ 已取消，未执行任何写操作。") };
    });
  }

  /** 当前待确认数（状态展示/测试用） */
  pendingCount(): number {
    return this.pending.size;
  }

  /** 进程退出/停止时清场：全部按取消处理，别让工具调用悬着 */
  closeAll(): void {
    for (const [key, p] of [...this.pending]) {
      this.settle(key, p);
      this.respondFn(p.openId, { type: "extension_ui_response", id: p.id, cancelled: true });
    }
  }

  // ---------------------------------------------------------------------------

  private key(openId: string, id: string): string {
    return `${openId}:${id}`;
  }

  private settle(key: string, p: Pending): void {
    if (p.timer) clearTimeout(p.timer);
    this.pending.delete(key);
  }

  private async expire(key: string): Promise<void> {
    const p = this.pending.get(key);
    if (!p) return;
    this.settle(key, p);
    this.respondFn(p.openId, { type: "extension_ui_response", id: p.id, cancelled: true });
    this.auditFn?.({ user: p.openId, action: "ui_confirm", resource: p.id, result: "blocked", detail: { reason: "expired" } });
    try {
      await this.channel.sendToUser(
        p.openId,
        coworkerCard()
          .header("grey", "⌛ 确认已超时")
          .md(`「${p.title}」超过 ${Math.round(this.ttlMs / 60_000)} 分钟未确认，已按**取消**处理（未执行写操作）。`)
          .build(),
      );
    } catch {
      /* 提示失败不影响取消 */
    }
  }
}

export function createConfirmBridge(deps: ConfirmBridgeDeps): ConfirmBridge {
  return new ConfirmBridge(deps);
}

// ---------------- 卡片 ----------------

function confirmCard(id: string, title: string, message: string, ttlMs: number): unknown {
  return coworkerCard()
    .config({ enable_forward_interaction: false })
    .header("orange", "⚠️ 需要你确认")
    .md(`**${title}**${message ? `\n\n${message}` : ""}`)
    .divider()
    .buttons([
      { text: "确认执行", type: "primary", action: "ui_confirm", payload: { id, approve: true } },
      { text: "取消", type: "danger", action: "ui_confirm", payload: { id, approve: false } },
    ])
    .note(`${Math.round(ttlMs / 60_000)} 分钟内未确认将自动取消（安全默认）`)
    .build();
}

function decidedCard(approve: boolean, text: string): unknown {
  return coworkerCard()
    .header(approve ? "green" : "grey", approve ? "✅ 已确认" : "❌ 已取消")
    .md(text)
    .build();
}
