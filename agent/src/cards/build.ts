/**
 * 示例卡片（基于通用构造器 coworkerCard 的用法示范）。
 * 以后新交互请直接用 extensions/core/cards 构造，无需在此加模板。
 */
import { coworkerCard, select, input, button } from "../../../extensions/core/cards/index.ts";
import type { CatalogPermission } from "../../../extensions/core/catalog.ts";

const grantLabel: Record<string, string> = {
  "self-service": "自服务直授",
  approval: "审批",
  "owner-request": "向 owner 申请",
};

export function permApplyCard(perm: CatalogPermission, state?: "pending" | "done" | "error", message?: string): unknown {
  const b = coworkerCard()
    .header("blue", "🔐 权限申请")
    .md(
      `**${perm.name}**（${perm.id}）\n` +
        `类型：${perm.type} · 授予方式：${grantLabel[perm.grant] ?? perm.grant}` +
        (perm.description ? `\n${perm.description}` : ""),
    )
    .divider();
  if (state === "done") {
    b.md(`✅ **已开通**${message ? `\n${message}` : ""}`);
  } else if (state === "error") {
    b.md(`❌ **处理失败**${message ? `\n${message}` : ""}`);
  } else if (state === "pending") {
    b.md("⏳ **处理中…**");
  } else {
    b.buttons([
      { text: "一键申请", type: "primary", action: "perm_apply", payload: { permissionId: perm.id } },
      { text: "查看可申请权限", action: "perm_catalog" },
    ]);
  }
  return b.build();
}

export function permCatalogCard(perms: CatalogPermission[]): unknown {
  const rows = perms.slice(0, 5);
  const b = coworkerCard()
    .header("blue", "📋 可申请权限")
    .md(
      rows.length > 0
        ? rows.map((p, i) => `${i + 1}. **${p.name}**（${grantLabel[p.grant] ?? p.grant}）`).join("\n")
        : "权限目录为空，请联系管理员维护 catalog.json。",
    )
    .divider();
  if (rows.length > 0) {
    b.buttons([
      ...rows.map((p, i) => ({
        text: `申请 ${i + 1}`,
        type: (i === 0 ? "primary" : "default") as "primary" | "default",
        action: "perm_apply",
        payload: { permissionId: p.id },
      })),
      { text: "📝 表单申请", action: "perm_form" },
    ]);
  }
  return b.build();
}

export function onboardingCard(): unknown {
  return coworkerCard()
    .header("green", "🎒 入职三步曲")
    .md("**① 登录飞书**（员工号）\n**② 下载公司桌面助手（GUI）** → 扫码登录，自动开通权限\n**③ 必读文档**\n   🔗 新员工入职必读")
    .divider()
    .buttons([
      { text: "我完成了", type: "primary", action: "onboard_done" },
      { text: "联系 IT", action: "contact_it" },
    ])
    .build();
}

/** 表单式权限申请（演示通用交互：下拉选权限 + 理由 + 提交 → 回调拿 form_value） */
export function permRequestCard(perms: CatalogPermission[]): unknown {
  const rows = perms.slice(0, 8);
  return coworkerCard()
    .header("blue", "📝 权限申请（表单）")
    .md("选择要申请的权限并填写理由，提交后按目录授予方式处理。")
    .divider()
    .form("perm_form", [
      select("perm_select", rows.map((p) => ({ text: p.name, value: p.id })), { placeholder: "选择权限", required: true }),
      input("reason", { placeholder: "申请理由（必填）", required: true }),
      // 纯表单提交：submit 按钮 name = 动作名（无 value），回调按 name 路由到 perm_request，form_value 携带数据
      button({ text: "提交申请", type: "primary", formActionType: "submit", name: "perm_request" }),
    ])
    .note("提交后将按目录授予方式处理（自服务直授 / 审批 / 申请访问）")
    .build();
}
