/**
 * 卡片构造器测试：用通用构造器（Card 2.0）生成卡片并发送验证。
 * 用法：node scripts/card-test.ts <open_id> [--sink | --onboard | --catalog | --apply <permId>]
 * 默认发送全部示例卡 + kitchen-sink 全元素卡（发到用户私聊，注意是真实消息）。
 */
import { coworkerCard, createCardChannel, input, button } from "../../extensions/core/cards/index.ts";
import { onboardingCard, permCatalogCard, permApplyCard } from "../src/cards/build.ts";
import { listPermissions, getPermission } from "../../extensions/core/catalog.ts";

/** kitchen-sink：覆盖构造器主要元素（div/markdown/hr/note/select/input/form/overflow/buttons） */
function kitchenSinkCard(): unknown {
  return coworkerCard()
    .header("blue", "🧪 构造器全元素演示")
    .md("**通用卡片构造器**（Card 2.0）\n覆盖：段落、分隔线、下拉、输入、表单、按钮、备注")
    .divider()
    .select("dept", [
      { text: "研发", value: "eng" },
      { text: "市场", value: "mkt" },
    ], { placeholder: "选择部门" })
    .input("remark", { placeholder: "补充说明（可选）", label: "备注" })
    .form("frm", [
      input("reason", { placeholder: "申请理由（表单内，必填）", required: true }),
      button({ text: "提交表单", type: "primary", formActionType: "submit", name: "submit_btn" }),
      button({ text: "重置", formActionType: "reset", name: "reset_btn" }),
    ])
    .divider()
    .buttons([
      { text: "主按钮", type: "primary", action: "sink_primary", payload: { k: 1 }, confirm: { text: "确定执行演示动作？" } },
      { text: "次按钮", action: "sink_secondary" },
    ])
    .overflow([
      { text: "选项 A", value: "a" },
      { text: "选项 B", value: "b" },
    ])
    .note("由 coworker 构造器生成 · schema 2.0")
    .build();
}

async function main(): Promise<void> {
  const openId = process.argv[2];
  if (!openId) {
    console.error("用法: node scripts/card-test.ts <open_id> [--sink] [--onboard] [--catalog] [--apply <permId>]");
    process.exit(1);
  }
  const args = process.argv.slice(3);
  const has = (f: string) => args.includes(f);
  const channel = createCardChannel("user");
  const send = async (card: unknown, label: string) => {
    try {
      await channel.sendToUser(openId, card);
      console.log(`✅ ${label}`);
    } catch (e: any) {
      console.log(`❌ ${label}: ${e?.message}`);
    }
  };

  if (args.length === 0 || has("--sink")) await send(kitchenSinkCard(), "kitchenSink（全元素）");
  if (has("--onboard") || args.length === 0) await send(onboardingCard(), "onboarding");
  if (has("--catalog") || args.length === 0) await send(permCatalogCard(listPermissions()), "permCatalog");
  const ai = args.indexOf("--apply");
  if (ai >= 0) {
    const perm = getPermission(args[ai + 1] ?? "");
    if (!perm) {
      console.error("未找到权限:", args[ai + 1]);
      process.exit(1);
    }
    await send(permApplyCard(perm), `permApply(${perm.id})`);
  }
}

main().catch((e) => {
  console.error("失败:", e?.message ?? e);
  process.exit(1);
});
