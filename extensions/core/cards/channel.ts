/**
 * 飞书卡片通道：发卡片 / 收回调的统一出入口。
 *
 * - 发送：im +messages-send / +messages-reply（interactive）
 * - 原地更新：POST /open-apis/interactive/v1/card/update（token 30min、最多 2 次）
 * - 身份：bot（守护进程/机器人）/ user（个人 CLI/GUI 场景）
 */
import { runLark, describeLarkError } from "../lark.ts";

export type ChannelIdentity = "bot" | "user";

export class LarkCardChannel {
  private as: ChannelIdentity;

  constructor(as: ChannelIdentity = "bot") {
    this.as = as;
  }

  /** 私聊发卡片 */
  async sendToUser(openId: string, card: unknown): Promise<void> {
    const r = await runLark(
      ["im", "+messages-send", "--user-id", openId, "--msg-type", "interactive", "--content", JSON.stringify(card)],
      { as: this.as, timeoutMs: 60_000 },
    );
    if (!r.ok) throw new Error(`卡片发送失败: ${describeLarkError(r)}`);
  }

  /** 群聊发卡片 */
  async sendToChat(chatId: string, card: unknown): Promise<void> {
    const r = await runLark(
      ["im", "+messages-send", "--chat-id", chatId, "--msg-type", "interactive", "--content", JSON.stringify(card)],
      { as: this.as, timeoutMs: 60_000 },
    );
    if (!r.ok) throw new Error(`卡片发送失败: ${describeLarkError(r)}`);
  }

  /** 回帖发卡片（群内 @场景） */
  async replyToMessage(messageId: string, card: unknown): Promise<void> {
    const r = await runLark(
      ["im", "+messages-reply", "--message-id", messageId, "--msg-type", "interactive", "--content", JSON.stringify(card)],
      { as: this.as, timeoutMs: 60_000 },
    );
    if (!r.ok) throw new Error(`卡片回帖失败: ${describeLarkError(r)}`);
  }

  /** 回帖发文本（markdown：lark-cli --markdown 自动包裹成 post 富文本，支持 markdown 渲染） */
  async replyText(messageId: string, text: string): Promise<void> {
    const r = await runLark(["im", "+messages-reply", "--message-id", messageId, "--markdown", String(text ?? "")], {
      as: this.as,
      timeoutMs: 60_000,
    });
    if (!r.ok) throw new Error(`回帖失败: ${describeLarkError(r)}`);
  }

  /** 发文本（markdown：lark-cli --markdown 自动包裹成 post 富文本，支持 markdown 渲染） */
  async sendText(openId: string, text: string): Promise<void> {
    const r = await runLark(["im", "+messages-send", "--user-id", openId, "--markdown", String(text ?? "")], {
      as: this.as,
      timeoutMs: 60_000,
    });
    if (!r.ok) throw new Error(`发送失败: ${describeLarkError(r)}`);
  }

  /** 原地更新卡片（需回调中的 token；token 30 分钟内最多 2 次） */
  async update(token: string, card: unknown): Promise<void> {
    const r = await runLark(
      ["api", "POST", "/open-apis/interactive/v1/card/update", "--data", JSON.stringify({ token, card })],
      { as: this.as, timeoutMs: 30_000 },
    );
    if (!r.ok) throw new Error(`卡片更新失败: ${describeLarkError(r)}`);
  }
}

export function createCardChannel(as: ChannelIdentity = "bot"): LarkCardChannel {
  return new LarkCardChannel(as);
}
