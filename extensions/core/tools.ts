/**
 * 工具级共享助手：结果封装、身份解析。
 */
import { runLark, userIdentityOf } from "./lark.ts";
import { loadUserConfig } from "./config.ts";

export interface ToolContentBlock {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolContentBlock[];
  details: Record<string, unknown>;
}

export function okResult(text: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text }], details: { ok: true, ...details } };
}

export function errResult(text: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text }], details: { ok: false, ...details } };
}

/** 当前用户身份摘要（来自 auth status，缓存于用户配置） */
export function currentUser(): { openId?: string; name?: string; email?: string; userId?: string } {
  const cfg = loadUserConfig();
  return cfg.user ?? {};
}

/** 从 auth status 刷新并返回当前身份 */
export async function refreshIdentity(): Promise<{
  ok: boolean;
  openId?: string;
  name?: string;
  email?: string;
  userId?: string;
  message: string;
}> {
  const r = await runLark(["auth", "status", "--json"], { as: "user", timeoutMs: 60_000 });
  const id = userIdentityOf(r.envelope);
  if (!r.ok || !id) {
    return { ok: false, message: r.envelope ? JSON.stringify(r.envelope.error ?? r.envelope) : r.stderr || "未登录" };
  }
  const identity = {
    openId: id.openId ?? id.user?.openId,
    name: id.userName ?? id.localized_name ?? id.name ?? id.user?.userName,
    email: id.email ?? id.user?.email,
    userId: id.userId ?? id.user?.userId,
  };
  return { ok: true, message: `当前用户：${identity.name ?? identity.openId ?? "未知"}`, ...identity };
}

/** 通过邮箱/姓名解析 open_id（contact +search-user） */
export async function resolveOpenId(
  query: string,
): Promise<{ openId?: string; name?: string; message: string }> {
  const r = await runLark(["contact", "+search-user", "--query", query, "--format", "json"], {
    as: "user",
    timeoutMs: 60_000,
  });
  const users = r.envelope?.data?.users ?? r.envelope?.data?.items ?? [];
  const hit = Array.isArray(users) && users.length > 0 ? users[0] : undefined;
  if (!hit?.open_id) {
    return { message: `未找到用户「${query}」${r.ok ? "" : "（" + (r.envelope?.error?.message ?? "") + "）"}` };
  }
  return { openId: hit.open_id, name: hit.localized_name ?? hit.name, message: `已解析：${hit.localized_name ?? hit.name ?? query}` };
}
