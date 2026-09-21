/**
 * Bot 侧纯逻辑回归测试（不依赖飞书/网络）：
 *   1) 意图路由：只认显式指令，正常提问不得被截胡成卡片
 *   2) 确认卡片桥：extension_ui_request → 卡片 → 点按钮回写响应（fail-closed 全路径）
 *
 * 密封性：测试把 HOME 指向临时目录并写入自带的 catalog.json（用户级覆盖），
 * 因此断言不受开发者本机 ~/.coworker/catalog.json 影响，也顺带验证
 * 「用户级覆盖优先于包内模板」。
 *
 * 用法：node agent/scripts/bot-test.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "✅" : "❌"} ${name}${ok || !detail ? "" : ` —— ${detail}`}`);
  if (!ok) failed++;
}

// ---------------- 密封环境：临时 HOME + 自带权限目录 ----------------

const tmpHome = mkdtempSync(join(tmpdir(), "cw-bot-test-"));
mkdirSync(join(tmpHome, ".coworker"), { recursive: true });
writeFileSync(
  join(tmpHome, ".coworker", "catalog.json"),
  JSON.stringify({
    permissions: [
      { id: "fixture_wiki", name: "测试用知识库", type: "wiki-space", grant: "self-service", spaceId: "111" },
      { id: "fixture_pos", name: "测试岗位权限", type: "position", grant: "approval", approvalCode: "x" },
      { id: "fixture_doc", name: "测试入职文档", type: "drive-doc", grant: "owner-request", url: "https://example.com/docx/x" },
    ],
  }),
);
process.env.HOME = tmpHome; // catalog.ts 的 COWORKER_DIR 在 import 时按 HOME 解析

// ---------------- 1. 意图路由 ----------------

let detectIntent: (text: string) => { type: string; perm?: { id: string } } | null;

function checkIntent(text: string, expect: string | null): void {
  const got = detectIntent(text);
  const key = got ? `${got.type}${got.perm ? `:${got.perm.id}` : ""}` : null;
  check(`「${text}」→ ${key ?? "（交给 agent）"}`, key === expect, `期望 ${expect ?? "（交给 agent）"}`);
}

// ---------------- 2. 确认卡片桥 ----------------

interface SentCard {
  to: string;
  card: any;
}

async function main(): Promise<void> {
  // HOME 已指向临时目录，此刻再加载被测模块，保证读到的是自带 fixture 目录
  const { detectIntent: di } = await import("../src/bot/handler.ts");
  const { createConfirmBridge } = await import("../src/bot/ui.ts");
  const { createCardRegistry } = await import("../../extensions/core/cards/registry.ts");
  detectIntent = di as any;

  function makeBridge(ttlMs?: number) {
    const sent: SentCard[] = [];
    const responses: Array<Record<string, any>> = [];
    const audits: Array<Record<string, any>> = [];
    const channel = {
      async sendToUser(openId: string, card: unknown) {
        sent.push({ to: openId, card });
      },
    };
    const bridge = createConfirmBridge({
      channel,
      respond: (_openId, payload) => responses.push(payload),
      audit: (e) => audits.push(e as any),
      ttlMs,
    });
    const registry = createCardRegistry(channel as any, () => {});
    bridge.register(registry);
    return { bridge, registry, sent, responses, audits };
  }

  const click = (registry: any, operatorId: string, action: Record<string, any>) =>
    registry.dispatch({ operatorId, action });

  console.log("== 1. 意图路由：知识问答不得被截胡 ==");
  checkIntent("新员工入职流程是什么？", null);
  checkIntent("测试用知识库在哪里能找到？", null);
  checkIntent("帮我查一下入职培训的资料", null);
  checkIntent("这个文档能帮助我理解 DFMEA 吗", null);
  checkIntent("研发知识库里的部署规范是什么", null); // 包内模板条目不得命中（密封性检查）
  checkIntent("报销流程是什么", null);

  console.log("== 1b. 显式指令才走卡片 ==");
  checkIntent("帮助", "onboard");
  checkIntent("入职指引", "onboard");
  checkIntent("查看我的权限", "catalog");
  checkIntent("权限目录", "catalog");
  checkIntent("申请权限", "catalog");
  checkIntent("申请 测试用知识库", "apply:fixture_wiki");
  checkIntent("帮我申请 测试岗位权限", "apply:fixture_pos");
  checkIntent("开通 fixture_doc", "apply:fixture_doc");
  checkIntent("申请 火星基地门禁", null); // 点名不存在的权限 → 交给 agent 解释

  console.log("== 2. 确认卡片：发起 + 点确认 ==");
  {
    const t = makeBridge();
    const owner = "ou_owner";
    await t.bridge.handle(owner, {
      type: "extension_ui_request",
      id: "r1",
      method: "confirm",
      title: "发送邮件",
      message: "收件人：a@b.com\n主题：周报",
    });
    const blob = JSON.stringify(t.sent[0]?.card ?? {});
    check("已向 owner 发出确认卡", t.sent.length === 1 && t.sent[0].to === owner, JSON.stringify(t.sent.map((s) => s.to)));
    check("卡片含标题与正文", blob.includes("发送邮件") && blob.includes("周报"));
    check("卡片含确认/取消两个按钮", blob.includes("ui_confirm") && blob.includes('"approve":true') && blob.includes('"approve":false'));
    check("已禁止转发后交互（enable_forward_interaction=false）", t.sent[0]?.card?.config?.enable_forward_interaction === false, blob.slice(0, 160));
    check("计入待确认", t.bridge.pendingCount() === 1, String(t.bridge.pendingCount()));

    await click(t.registry, owner, { action: "ui_confirm", id: "r1", approve: true });
    check("点确认 → 回写 confirmed:true", t.responses[0]?.confirmed === true, JSON.stringify(t.responses));
    check("回写 id 匹配", t.responses[0]?.id === "r1");
    check("确认后不再挂起", t.bridge.pendingCount() === 0);
  }

  console.log("== 3. 点「取消」/ 他人点击 / 超时 ==");
  {
    // 取消
    const a = makeBridge();
    await a.bridge.handle("ou_owner", { type: "extension_ui_request", id: "r2", method: "confirm", title: "建日程" });
    await click(a.registry, "ou_owner", { action: "ui_confirm", id: "r2", approve: false });
    check("取消 → confirmed:false", a.responses[0]?.confirmed === false, JSON.stringify(a.responses));
    check("取消后不再挂起", a.bridge.pendingCount() === 0);

    // 他人点击：不应回写任何响应
    const b = makeBridge();
    await b.bridge.handle("ou_owner", { type: "extension_ui_request", id: "r3", method: "confirm", title: "发邮件" });
    await click(b.registry, "ou_attacker", { action: "ui_confirm", id: "r3", approve: true });
    check("非 owner 点击不回写响应", b.responses.length === 0, JSON.stringify(b.responses));
    check("原确认仍挂起（等人本人点）", b.bridge.pendingCount() === 1);
    // 本人再点仍然生效
    await click(b.registry, "ou_owner", { action: "ui_confirm", id: "r3", approve: true });
    check("本人补点仍生效", b.responses[0]?.confirmed === true);

    // 超时 → 取消
    const c = makeBridge(150);
    await c.bridge.handle("ou_owner", { type: "extension_ui_request", id: "r4", method: "confirm", title: "发邮件" });
    await new Promise((r) => setTimeout(r, 400));
    check("超时 → cancelled:true", c.responses[0]?.cancelled === true, JSON.stringify(c.responses));
    check("超时后清空挂起", c.bridge.pendingCount() === 0);
    check("超时审计为 blocked", c.audits.some((x) => x.result === "blocked" && (x.detail as any)?.reason === "expired"));
  }

  console.log("== 4. 不支持的 dialog 与收场 ==");
  {
    const d = makeBridge();
    await d.bridge.handle("ou_owner", { type: "extension_ui_request", id: "r5", method: "input", title: "输入点啥" });
    check("input 请求 → 直接取消", d.responses[0]?.cancelled === true && d.responses[0]?.id === "r5", JSON.stringify(d.responses));
    check("并提示需在桌面端执行", JSON.stringify(d.sent[0]?.card ?? "").includes("桌面助手"));
    check("不挂起", d.bridge.pendingCount() === 0);

    const e = makeBridge();
    await e.bridge.handle("ou_owner", { type: "extension_ui_request", id: "r6", method: "confirm", title: "直授权限" });
    e.bridge.closeAll();
    check("closeAll → cancelled:true（不留悬空调用）", e.responses[0]?.cancelled === true && e.bridge.pendingCount() === 0);
  }

  console.log(failed === 0 ? "\n✅ Bot 侧测试全部通过" : `\n❌ Bot 侧测试失败 ${failed} 项`);
  rmSync(tmpHome, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("❌ 测试异常：", e?.message ?? e);
  rmSync(tmpHome, { recursive: true, force: true });
  process.exit(1);
});
