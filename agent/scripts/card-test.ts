/**
 * 卡片冒烟测试：用真实构建器生成卡片，发送到指定 open_id 验证 schema。
 * 用法：node scripts/card-test.ts <open_id> [--onboard] [--catalog] [--apply <permId>]
 * 默认发送 onboarding + catalog 两张卡片（发到用户私聊，注意是真实消息）。
 */
import { runLark } from "../../extensions/core/lark.ts";
import { onboardingCard, permCatalogCard, permApplyCard } from "../src/cards/build.ts";
import { listPermissions, getPermission } from "../../extensions/core/catalog.ts";

async function send(openId: string, card: unknown, label: string): Promise<void> {
  const r = await runLark(["im", "+messages-send", "--user-id", openId, "--msg-type", "interactive", "--content", JSON.stringify(card)], {
    as: "user",
    timeoutMs: 60_000,
  });
  console.log(`${r.ok ? "✅" : "❌"} ${label} ${r.ok ? "" : JSON.stringify(r.envelope?.error ?? r.stderr)}`);
}

async function main(): Promise<void> {
  const openId = process.argv[2];
  if (!openId) {
    console.error("用法: node scripts/card-test.ts <open_id> [--onboard] [--catalog] [--apply <permId>]");
    process.exit(1);
  }
  const args = process.argv.slice(3);
  const has = (f: string) => args.includes(f);

  if (has("--onboard") || args.length === 0) await send(openId, onboardingCard(), "onboardingCard");
  if (has("--catalog") || args.length === 0) await send(openId, permCatalogCard(listPermissions()), "permCatalogCard");
  const ai = args.indexOf("--apply");
  if (ai >= 0) {
    const perm = getPermission(args[ai + 1] ?? "");
    if (!perm) {
      console.error("未找到权限:", args[ai + 1]);
      process.exit(1);
    }
    await send(openId, permApplyCard(perm), `permApplyCard(${perm.id})`);
  }
}

main().catch((e) => {
  console.error("失败:", e?.message ?? e);
  process.exit(1);
});
