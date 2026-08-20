/**
 * 示例卡片（基于通用构造器 coworkerCard 的用法示范）。
 * 以后新交互请直接用 extensions/core/cards 构造，无需在此加模板。
 */
import { coworkerCard } from "../../../extensions/core/cards/index.ts";
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
    b.buttons(
      rows.map((p, i) => ({
        text: `申请 ${i + 1}`,
        type: i === 0 ? "primary" : "default",
        action: "perm_apply",
        payload: { permissionId: p.id },
      })),
    );
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
