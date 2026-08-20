/**
 * 事件路由（按模式）：
 * - 消息：先走卡片意图快捷路由（申请权限/查看权限/入职 → 通用构造器造卡片发送），
 *   其余交给 agent（按模式限定工具集）回答。
 * - 卡片回调：解析 action → 通用动作注册表分发（channel 统一更新/回复）。
 */
import type { AgentConfig } from "../config";
import type { PiAgentPool } from "../agent/pool";
import type { Gateway } from "../security/gateway";
import { buildPrompt } from "../mode";
import { createCardChannel, createCardRegistry, parseActionValue } from "../../../extensions/core/cards/index.ts";
import type { LarkCardChannel, CardActionRegistry, CardActionEvent } from "../../../extensions/core/cards/index.ts";
import { listPermissions } from "../../../extensions/core/catalog.ts";
import type { CatalogPermission } from "../../../extensions/core/catalog.ts";
import { permApplyCard, permCatalogCard, onboardingCard } from "../cards/build.ts";
import { registerDefaultCardActions } from "../cards/handle.ts";

export interface BotContext {
  cfg: AgentConfig;
  pool: PiAgentPool;
  gateway: Gateway;
  channel: LarkCardChannel;
  registry: CardActionRegistry;
}

export function createBotContext(cfg: AgentConfig, pool: PiAgentPool, gateway: Gateway): BotContext {
  const channel = createCardChannel("bot");
  const registry = createCardRegistry(channel, (e) =>
    gateway.audit({ user: e.user, cluster: e.cluster ?? "cards", action: e.action, resource: e.resource, result: e.result, detail: e.detail }),
  );
  registerDefaultCardActions(registry);
  return { cfg, pool, gateway, channel, registry };
}

function pick(v: any, ...keys: string[]): any {
  for (const k of keys) {
    if (v[k] != null) return v[k];
  }
  return undefined;
}

// ---------------- 卡片意图快捷路由 ----------------

interface Intent {
  type: "apply" | "catalog" | "onboard";
  perm?: CatalogPermission;
}

function detectIntent(text: string): Intent | null {
  const t = text.trim();
  const perm = listPermissions().find((p) => t.includes(p.name) || (p.id && t.includes(p.id)));
  if (perm) return { type: "apply", perm };
  if (/申请|开通|授权/.test(t) && /权限|知识库|文档/.test(t)) {
    const kw = t.replace(/申请|开通|授权|权限|知识库|文档|的|给我|我要/g, "").trim();
    const byName = listPermissions().find((p) => kw && (p.name.includes(kw) || kw.includes(p.name)));
    if (byName) return { type: "apply", perm: byName };
  }
  if (/查看我的权限|我能访问|能申请|权限目录|有哪些权限/.test(t)) return { type: "catalog" };
  if (/入职|指引|help|帮助|怎么开始/.test(t)) return { type: "onboard" };
  return null;
}

async function sendIntentCard(ctx: BotContext, intent: Intent, openId: string, chatType: string, messageId?: string): Promise<void> {
  const card =
    intent.type === "apply" && intent.perm
      ? permApplyCard(intent.perm)
      : intent.type === "catalog"
        ? permCatalogCard(listPermissions())
        : onboardingCard();
  if (chatType === "p2p") {
    await ctx.channel.sendToUser(openId, card);
  } else if (messageId) {
    await ctx.channel.replyToMessage(messageId, card);
  }
  ctx.gateway.audit({ user: openId, cluster: "bot", action: "intent_card", resource: intent.type, result: "ok", detail: { permissionId: intent.perm?.id } });
}

// ---------------- 消息处理 ----------------

export async function handleMessage(ctx: BotContext, evt: any): Promise<void> {
  const openId = pick(evt, "sender_id", "open_id") ?? evt.sender?.open_id;
  const chatType = pick(evt, "chat_type", "chatType") ?? "p2p";
  const messageId = pick(evt, "message_id") ?? evt.message?.message_id;
  const content = typeof evt.content === "string" ? evt.content : pick(evt, "text") ?? "";
  if (!openId || !content.trim()) return;

  const rate = ctx.gateway.check(openId);
  if (!rate.ok) {
    const wait = Math.ceil((rate.retryAfterMs ?? 0) / 1000);
    await ctx.channel.sendText(openId, `请求太频繁，请 ${wait} 秒后再试。`);
    return;
  }

  const text = content.trim();

  // 快捷意图 → 直接发卡片（快且确定，不消耗 agent）
  const intent = detectIntent(text);
  if (intent) {
    try {
      await sendIntentCard(ctx, intent, openId, chatType, messageId);
    } catch (e: any) {
      await ctx.channel.sendText(openId, `卡片发送失败：${e?.message ?? "未知错误"}`);
    }
    return;
  }

  // 其余 → agent 问答（按模式限定工具集/身份/提示词）
  const prompt = buildPrompt(ctx.cfg.mode, openId, text);
  try {
    const answer = await ctx.pool.ask(openId, prompt);
    ctx.gateway.audit({ user: openId, cluster: "bot", action: "ask", resource: "message", result: "ok", detail: { in: text.length, out: answer.length } });
    const replyText = answer || "（agent 没有返回内容，请稍后重试）";
    if (chatType === "p2p") {
      await ctx.channel.sendText(openId, replyText);
    } else if (messageId) {
      await ctx.channel.replyText(messageId, replyText);
    }
  } catch (e: any) {
    ctx.gateway.audit({ user: openId, cluster: "bot", action: "ask", resource: "message", result: "error", detail: { err: e?.message ?? String(e) } });
    await ctx.channel.sendText(openId, `处理失败：${e?.message ?? "未知错误"}。请稍后重试或联系 IT。`);
  }
}

// ---------------- 卡片回调 ----------------

export async function handleCardAction(ctx: BotContext, evt: any): Promise<void> {
  const openId = pick(evt, "operator_id", "open_id") ?? evt.operator?.open_id;
  const action = parseActionValue(evt.action_value ?? evt.action?.value);
  if (!openId || !action) return;
  const cardEvent: CardActionEvent = {
    operatorId: openId,
    action,
    formValue: evt.form_value ? (typeof evt.form_value === "string" ? safeJson(evt.form_value) : evt.form_value) : undefined,
    token: pick(evt, "token"),
    messageId: pick(evt, "message_id"),
    chatId: pick(evt, "chat_id"),
    actionTag: pick(evt, "action_tag"),
    option: pick(evt, "option"),
  };
  try {
    const res = await ctx.registry.dispatch(cardEvent);
    if (!res.handled) await ctx.channel.sendText(openId, res.error ?? "该按钮功能未注册。");
  } catch (e: any) {
    await ctx.channel.sendText(openId, `卡片处理失败：${e?.message ?? "未知错误"}`);
  }
}

function safeJson(s: string): Record<string, any> | undefined {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : undefined;
  } catch {
    return undefined;
  }
}
