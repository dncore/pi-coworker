/**
 * 卡片回调处理（card.action.trigger）。
 * - perm_apply：按 catalog 授予策略执行（self-service → bot 直授；其余给指引）
 * - perm_catalog / perm_refresh：重发目录卡片
 * - onboard_done / contact_it：文案回复
 * 带 token 时用 card/update 原地更新卡片，否则回文本。
 */
import { runLark, describeLarkError } from "../../../extensions/core/lark.ts";
import { getPermission, listPermissions } from "../../../extensions/core/catalog.ts";
import type { CatalogPermission } from "../../../extensions/core/catalog.ts";
import type { Gateway } from "../security/gateway.ts";
import { permApplyCard, permCatalogCard } from "./build.ts";

export type CardAction = { action: string; permissionId?: string; [k: string]: any };

export function parseCardAction(raw: any): CardAction | null {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as CardAction;
    } catch {
      return { action: raw };
    }
  }
  if (raw && typeof raw === "object") return raw as CardAction;
  return null;
}

export interface CardCallbackCtx {
  operatorId: string;
  token?: string;
  messageId?: string;
}

/** 更新卡片（延迟更新 API；token 30 分钟内最多 2 次） */
export async function updateCard(token: string, card: unknown): Promise<string | null> {
  const r = await runLark(["api", "POST", "/open-apis/interactive/v1/card/update", "--data", JSON.stringify({ token, card })], {
    as: "bot",
    timeoutMs: 30_000,
  });
  if (!r.ok) return `卡片更新失败：${describeLarkError(r)}`;
  return null;
}

/** 自服务直授：bot 加知识库成员 / 文档协作者 */
async function grantSelfService(perm: CatalogPermission, openId: string, gateway: Gateway): Promise<{ ok: boolean; message: string }> {
  let argv: string[];
  let describe: string;
  if (perm.type === "wiki-space" && perm.spaceId) {
    argv = [
      "wiki", "+member-add",
      "--space-id", String(perm.spaceId),
      "--member-id", openId,
      "--member-type", perm.memberType ?? "openid",
      "--member-role", perm.memberRole ?? "member",
      "--as", "bot",
      "--yes",
    ];
    describe = `知识空间 ${perm.spaceId}`;
  } else if (perm.url || perm.token) {
    const type = perm.targetType ?? (perm.url ? "docx" : undefined);
    argv = [
      "drive", "+member-add",
      "--token", perm.url ?? perm.token ?? "",
      ...(type ? ["--type", type] : []),
      "--member-id", openId,
      "--member-type", perm.memberType ?? "openid",
      "--perm", perm.perm ?? "view",
      "--as", "bot",
      "--yes",
    ];
    describe = `文档 ${perm.url ?? perm.token}`;
  } else {
    return { ok: false, message: "目录配置不完整（缺少 spaceId/url），请联系管理员。" };
  }
  const r = await runLark(argv, { timeoutMs: 60_000 });
  gateway.audit({ user: openId, cluster: "bot", action: "card_grant", resource: perm.id, result: r.ok ? "ok" : "error", detail: { describe } });
  if (!r.ok) return { ok: false, message: describeLarkError(r) };
  return { ok: true, message: `${describe} 已开通。` };
}

/**
 * 处理卡片回调，返回 { reply?: string; card?: unknown; state?: "done"|"error"|undefined }。
 * - 返回 reply：以文本回复用户（无 token 或无需更新时）
 * - 返回 card + state：用 token 更新原卡片
 */
export async function handleCardActionValue(
  gateway: Gateway,
  openId: string,
  action: CardAction,
  cb?: CardCallbackCtx,
): Promise<{ reply?: string; card?: unknown; state?: "done" | "error" }> {
  gateway.audit({ user: openId, cluster: "bot", action: "card", resource: action.action, result: "pending", detail: { permissionId: action.permissionId } });

  switch (action.action) {
    case "perm_apply": {
      const perm = getPermission(action.permissionId ?? "");
      if (!perm) return { reply: `目录中不存在权限「${action.permissionId}」。` };
      if (perm.grant === "self-service") {
        const res = await grantSelfService(perm, openId, gateway);
        const card = permApplyCard(perm, res.ok ? "done" : "error", res.message);
        if (cb?.token) {
          await updateCard(cb.token, card);
          return {};
        }
        return { reply: res.message };
      }
      const card = permApplyCard(perm, "error", perm.grant === "approval" ? "审批型权限请通过飞书审批链接发起（功能接入中），或联系管理员。" : "请在桌面助手（GUI）中申请，或联系文档 owner。");
      if (cb?.token) {
        await updateCard(cb.token, card);
        return {};
      }
      return { reply: "该权限需走审批/申请流程，请使用桌面助手或联系管理员。" };
    }

    case "perm_catalog":
    case "perm_refresh": {
      const card = permCatalogCard(listPermissions());
      if (cb?.token) {
        await updateCard(cb.token, card);
        return {};
      }
      return { reply: "可申请权限已列出（见新卡片）。" };
    }

    case "onboard_done":
      return { reply: "收到！如有问题可继续提问，或联系 IT。", state: "done" };

    case "contact_it":
      return { reply: "请在企业微信/飞书联系 IT 支持（admin@example.com），或在内网工单系统提交。", state: "done" };

    default:
      return { reply: `按钮「${action.action}」功能接入中。` };
  }
}
