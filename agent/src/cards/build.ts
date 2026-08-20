/**
 * 飞书交互卡片构建器（Card 2.0 userDSL）。
 * 三种卡片：权限申请、权限目录（可申请）、入职引导。
 * 按钮 value 为 JSON 对象（回调时以 action_value JSON 字符串送达）。
 */
import type { CatalogPermission } from "../../../extensions/core/catalog.ts";

export interface Card {
  schema?: string;
  config?: { wide_screen_mode?: boolean };
  header?: { template?: string; title: { tag: "plain_text"; content: string } };
  elements: any[];
}

const grantLabel: Record<string, string> = {
  "self-service": "自服务直授",
  approval: "审批",
  "owner-request": "向 owner 申请",
};

export function permApplyCard(perm: CatalogPermission, state?: "pending" | "done" | "error", message?: string): Card {
  const elements: any[] = [
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content:
          `**${perm.name}**（${perm.id}）\n` +
          `类型：${perm.type} · 授予方式：${grantLabel[perm.grant] ?? perm.grant}` +
          (perm.description ? `\n${perm.description}` : ""),
      },
    },
    { tag: "hr" },
  ];
  if (state === "done") {
    elements.push({
      tag: "div",
      text: { tag: "lark_md", content: `✅ **已开通**${message ? `\n${message}` : ""}` },
    });
  } else if (state === "error") {
    elements.push({
      tag: "div",
      text: { tag: "lark_md", content: `❌ **处理失败**${message ? `\n${message}` : ""}` },
    });
  } else if (state === "pending") {
    elements.push({
      tag: "div",
      text: { tag: "lark_md", content: "⏳ **处理中…**" },
    });
  } else {
    elements.push({
      tag: "action",
      actions: [
        {
          tag: "button",
          text: { tag: "plain_text", content: "一键申请" },
          type: "primary",
          value: { action: "perm_apply", permissionId: perm.id },
        },
        {
          tag: "button",
          text: { tag: "plain_text", content: "查看可申请权限" },
          type: "default",
          value: { action: "perm_catalog" },
        },
      ],
    });
  }
  return {
    config: { wide_screen_mode: true },
    header: { template: "blue", title: { tag: "plain_text", content: "🔐 权限申请" } },
    elements,
  };
}

/** 权限目录卡片：列出可申请权限，每个带「申请」按钮（最多 5 个） */
export function permCatalogCard(perms: CatalogPermission[]): Card {
  const rows = perms.slice(0, 5);
  const elements: any[] = [
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content:
          rows.length > 0
            ? rows.map((p, i) => `${i + 1}. **${p.name}**（${grantLabel[p.grant] ?? p.grant}）`).join("\n")
            : "权限目录为空，请联系管理员维护 catalog.json。",
      },
    },
    { tag: "hr" },
  ];
  if (rows.length > 0) {
    elements.push({
      tag: "action",
      actions: rows.map((p, i) => ({
        tag: "button",
        text: { tag: "plain_text", content: `申请 ${i + 1}` },
        type: i === 0 ? "primary" : "default",
        value: { action: "perm_apply", permissionId: p.id },
      })),
    });
  }
  return {
    config: { wide_screen_mode: true },
    header: { template: "blue", title: { tag: "plain_text", content: "📋 可申请权限" } },
    elements,
  };
}

/** 入职引导卡片 */
export function onboardingCard(): Card {
  return {
    config: { wide_screen_mode: true },
    header: { template: "green", title: { tag: "plain_text", content: "🎒 入职三步曲" } },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content:
            "**① 登录飞书**（员工号）\n" +
            "**② 下载公司桌面助手（GUI）** → 扫码登录，自动开通权限\n" +
            "**③ 必读文档** → 新员工入职必读",
        },
      },
      { tag: "hr" },
      {
        tag: "action",
        actions: [
          { tag: "button", text: { tag: "plain_text", content: "我完成了" }, type: "primary", value: { action: "onboard_done" } },
          { tag: "button", text: { tag: "plain_text", content: "联系 IT" }, type: "default", value: { action: "contact_it" } },
        ],
      },
    ],
  };
}
