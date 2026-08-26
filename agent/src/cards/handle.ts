/**
 * 默认卡片动作（示例）：把内置交互注册到通用动作注册表。
 * 新交互请用 CardActionRegistry.register 注册自己的动作，无需改这里。
 */
import { runLark, describeLarkError } from "../../../extensions/core/lark.ts";
import { getPermission, listPermissions } from "../../../extensions/core/catalog.ts";
import type { CatalogPermission } from "../../../extensions/core/catalog.ts";
import type { CardActionRegistry, CardActionContext, CardActionOutcome } from "../../../extensions/core/cards/index.ts";
import { permApplyCard, permCatalogCard, permRequestCard } from "./build.ts";

/** 自服务直授：bot 加知识库成员 / 文档协作者 */
async function grantSelfService(perm: CatalogPermission, openId: string): Promise<{ ok: boolean; message: string }> {
  let argv: string[];
  let describe: string;
  if (perm.type === "wiki-space" && perm.spaceId) {
    // wiki +member-add 是 write（无 --yes 标志）
    argv = [
      "wiki", "+member-add",
      "--space-id", String(perm.spaceId),
      "--member-id", openId,
      "--member-type", perm.memberType ?? "openid",
      "--member-role", perm.memberRole ?? "member",
      "--as", "bot",
    ];
    describe = `知识空间 ${perm.spaceId}`;
  } else if (perm.url || perm.token) {
    // drive +member-add 是 high-risk-write（必须 --yes）
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
  if (!r.ok) return { ok: false, message: describeLarkError(r) };
  return { ok: true, message: `${describe} 已开通。` };
}

/** 注册内置卡片动作 */
export function registerDefaultCardActions(registry: CardActionRegistry): void {
  // 权限申请
  registry.register("perm_apply", async (ctx: CardActionContext): Promise<CardActionOutcome> => {
    const openId = ctx.event.operatorId;
    const permissionId = ctx.event.action.permissionId ?? "";
    const perm = getPermission(permissionId);
    if (!perm) return { reply: `目录中不存在权限「${permissionId}」。` };

    if (perm.grant === "self-service") {
      ctx.audit({ cluster: "bot", action: "card_grant", resource: perm.id, result: "pending", user: openId });
      const res = await grantSelfService(perm, openId);
      ctx.audit({ cluster: "bot", action: "card_grant", resource: perm.id, result: res.ok ? "ok" : "error", user: openId, detail: { message: res.message } });
      return { update: permApplyCard(perm, res.ok ? "done" : "error", res.message) };
    }
    return {
      update: permApplyCard(
        perm,
        "error",
        perm.grant === "approval" ? "审批型权限请通过飞书审批链接发起（功能接入中），或联系管理员。" : "请在桌面助手（GUI）中申请，或联系文档 owner。",
      ),
    };
  });

  // 权限目录 / 刷新
  registry.register("perm_catalog", async (): Promise<CardActionOutcome> => {
    return { update: permCatalogCard(listPermissions()) };
  });
  registry.register("perm_refresh", async (): Promise<CardActionOutcome> => {
    return { update: permCatalogCard(listPermissions()) };
  });

  // 表单式申请：读取 form_value（perm_select + reason）
  registry.register("perm_request", async (ctx: CardActionContext): Promise<CardActionOutcome> => {
    const fv = ctx.event.formValue ?? {};
    const permissionId = String(fv.perm_select ?? "");
    const reason = String(fv.reason ?? "");
    const perm = getPermission(permissionId);
    if (!perm) return { reply: `目录中不存在权限「${permissionId}」。` };
    ctx.audit({ cluster: "bot", action: "perm_request", resource: perm.id, result: "pending", user: ctx.event.operatorId, detail: { reason } });
    if (perm.grant === "self-service") {
      const res = await grantSelfService(perm, ctx.event.operatorId);
      ctx.audit({ cluster: "bot", action: "perm_request", resource: perm.id, result: res.ok ? "ok" : "error", user: ctx.event.operatorId });
      return { reply: res.ok ? `✅ 「${perm.name}」已开通。` : `开通失败：${res.message}` };
    }
    return {
      reply: `已收到申请「${perm.name}」（理由：${reason || "未填写"}）。该权限需${perm.grant === "approval" ? "审批" : "向 owner 申请"}，请走飞书审批/文档申请，或联系管理员。`,
    };
  });

  // 打开表单式申请卡
  registry.register("perm_form", async (ctx: CardActionContext): Promise<CardActionOutcome> => {
    return { send: { to: "user", target: ctx.event.operatorId, card: permRequestCard(listPermissions()) } };
  });

  // 入职
  registry.register("onboard_done", async (): Promise<CardActionOutcome> => {
    return { reply: "收到！如有问题可继续提问，或联系 IT。" };
  });
  registry.register("contact_it", async (): Promise<CardActionOutcome> => {
    return { reply: "请联系 IT 支持，或在内网工单系统提交。" };
  });
}
