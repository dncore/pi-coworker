/**
 * 回复：复用扩展的 lark-cli 封装（runLark）以 bot 身份发消息/回帖。
 */
import { runLark, describeLarkError } from "../../../extensions/core/lark.ts";

export async function sendTextToUser(openId: string, text: string): Promise<void> {
  const r = await runLark(["im", "+messages-send", "--user-id", openId, "--text", text], {
    as: "bot",
    timeoutMs: 60_000,
  });
  if (!r.ok) throw new Error(`发送失败: ${describeLarkError(r)}`);
}

export async function replyInThread(messageId: string, text: string): Promise<void> {
  const r = await runLark(["im", "+messages-reply", "--message-id", messageId, "--text", text], {
    as: "bot",
    timeoutMs: 60_000,
  });
  if (!r.ok) throw new Error(`回帖失败: ${describeLarkError(r)}`);
}

export async function sendCardToUser(openId: string, card: unknown): Promise<void> {
  const r = await runLark(["im", "+messages-send", "--user-id", openId, "--msg-type", "interactive", "--content", JSON.stringify(card)], {
    as: "bot",
    timeoutMs: 60_000,
  });
  if (!r.ok) throw new Error(`卡片发送失败: ${describeLarkError(r)}`);
}

export async function replyCardInThread(messageId: string, card: unknown): Promise<void> {
  const r = await runLark(["im", "+messages-reply", "--message-id", messageId, "--msg-type", "interactive", "--content", JSON.stringify(card)], {
    as: "bot",
    timeoutMs: 60_000,
  });
  if (!r.ok) throw new Error(`卡片回帖失败: ${describeLarkError(r)}`);
}
