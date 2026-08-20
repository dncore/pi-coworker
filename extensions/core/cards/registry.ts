/**
 * 卡片动作注册表：任何模块都能注册按钮回调处理，通道统一分发并应用结果。
 *
 * 回调事件（card.action.trigger）→ parseActionValue → 查注册表 → 执行 handler
 * → 按 outcome 统一处理：reply（发文本）/ update（用 token 更新原卡片）/
 *    send（发新卡片到 user/chat/reply）。
 */
import type { LarkCardChannel } from "./channel.ts";

/** 按钮/交互组件 value（JSON 字符串或对象） */
export interface CardActionValue {
  action: string;
  [k: string]: any;
}

export interface CardActionEvent {
  operatorId: string;
  action: CardActionValue;
  /** 表单提交值（按钮在 form 内时） */
  formValue?: Record<string, any>;
  token?: string;
  messageId?: string;
  chatId?: string;
  actionTag?: string;
  option?: string;
}

export interface CardAuditEntry {
  cluster?: string;
  action: string;
  resource: string;
  result: string;
  detail?: Record<string, unknown>;
  user?: string;
}

export interface CardActionContext {
  event: CardActionEvent;
  channel: LarkCardChannel;
  audit(entry: CardAuditEntry): void;
}

export type CardActionOutcome =
  | { reply: string }
  | { update: unknown }
  | { send: { to: "user" | "chat" | "reply"; target: string; card: unknown } }
  | Record<string, never>;

export type CardActionHandler = (ctx: CardActionContext) => Promise<CardActionOutcome>;

/** 解析回调中的 action_value（JSON 字符串或对象） */
export function parseActionValue(raw: any): CardActionValue | null {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed as CardActionValue;
    } catch {
      return { action: raw };
    }
  }
  if (raw && typeof raw === "object" && typeof raw.action === "string") return raw as CardActionValue;
  return null;
}

export class CardActionRegistry {
  private handlers = new Map<string, CardActionHandler>();
  private channel: LarkCardChannel;
  private auditFn?: (entry: CardAuditEntry) => void;

  constructor(channel: LarkCardChannel, auditFn?: (entry: CardAuditEntry) => void) {
    this.channel = channel;
    this.auditFn = auditFn;
  }

  register(action: string, handler: CardActionHandler): this {
    this.handlers.set(action, handler);
    return this;
  }

  has(action: string): boolean {
    return this.handlers.has(action);
  }

  /** 分发回调；返回是否处理（未注册 → handled=false 并给出原因） */
  async dispatch(evt: CardActionEvent): Promise<{ handled: boolean; error?: string }> {
    const handler = this.handlers.get(evt.action.action);
    if (!handler) {
      return { handled: false, error: `未注册的卡片动作「${evt.action.action}」` };
    }
    this.auditFn?.({
      cluster: "cards",
      action: "card_callback",
      resource: evt.action.action,
      result: "pending",
      user: evt.operatorId,
      detail: { value: evt.action, formValue: evt.formValue },
    });
    const outcome = await handler({ event: evt, channel: this.channel, audit: this.auditFn ?? (() => {}) });
    await this.apply(evt, outcome);
    this.auditFn?.({
      cluster: "cards",
      action: "card_callback",
      resource: evt.action.action,
      result: "ok",
      user: evt.operatorId,
      detail: { outcome: Object.keys(outcome) },
    });
    return { handled: true };
  }

  private async apply(evt: CardActionEvent, outcome: CardActionOutcome): Promise<void> {
    if ("reply" in outcome) {
      await this.channel.sendText(evt.operatorId, outcome.reply);
    } else if ("update" in outcome) {
      if (evt.token) await this.channel.update(evt.token, outcome.update);
      else await this.channel.sendToUser(evt.operatorId, outcome.update);
    } else if ("send" in outcome) {
      const { to, target, card } = outcome.send;
      if (to === "user") await this.channel.sendToUser(target, card);
      else if (to === "chat") await this.channel.sendToChat(target, card);
      else await this.channel.replyToMessage(target, card);
    }
  }
}

export function createCardRegistry(channel: LarkCardChannel, auditFn?: (entry: CardAuditEntry) => void): CardActionRegistry {
  return new CardActionRegistry(channel, auditFn);
}
