/**
 * Bot Agent 守护程序入口（RUN_MODE=local|server）。
 * 启动：配置校验（按模式工具白名单 fail-fast）→ 事件订阅（消息/卡片）→ agent 池就绪。
 * 退出：Ctrl+C / SIGTERM → 优雅关闭事件订阅（stdin EOF）与 agent 池。
 */
import { loadConfig } from "./config";
import { validateToolAllowlist } from "./security/allowlist";
import { MODE_LABEL } from "./mode";
import { Gateway } from "./security/gateway";
import { PiAgentPool } from "./agent/pool";
import { consumeEvent, type ConsumerHandle } from "./bot/consume";
import { handleMessage, handleCardAction, type BotContext } from "./bot/handler";

async function main(): Promise<void> {
  const cfg = loadConfig();

  // 安全 fail-fast：按模式校验工具白名单
  const problems = validateToolAllowlist(cfg.allowedTools, cfg.mode);
  if (problems.length > 0) {
    console.error("❌ 安全校验失败，拒绝启动：\n" + problems.map((p) => `  - ${p}`).join("\n"));
    process.exit(1);
  }

  const gateway = new Gateway(cfg);
  const pool = new PiAgentPool(cfg);
  const ctx: BotContext = { cfg, gateway, pool };

  console.log(`模式 ${MODE_LABEL[cfg.mode]}`, JSON.stringify({
    provider: cfg.provider,
    model: cfg.model || "(默认)",
    tools: cfg.allowedTools,
    noBuiltinTools: cfg.noBuiltinTools,
    maxAgents: cfg.maxAgents,
    sessionDir: cfg.sessionDir,
  }, null, 2));

  const handles: ConsumerHandle[] = [];
  try {
    handles.push(await consumeEvent(cfg.larkEventKeys.message, "bot", (e) => void handleMessage(ctx, e), cfg.larkEnv));
    console.log(`✅ 已订阅 ${cfg.larkEventKeys.message}`);
    handles.push(await consumeEvent(cfg.larkEventKeys.card, "bot", (e) => void handleCardAction(ctx, e), cfg.larkEnv));
    console.log(`✅ 已订阅 ${cfg.larkEventKeys.card}`);
  } catch (e: any) {
    console.error(`❌ 事件订阅失败（确认 lark-cli 已配置 Bot 应用且有对应 scope）：${e?.message ?? e}`);
    for (const h of handles) h.stop();
    process.exit(1);
  }

  console.log("🚀 Bot Agent 运行中（Ctrl+C 退出）");

  const sweep = setInterval(() => {
    void pool.sweep();
  }, 60_000);

  const shutdown = async () => {
    console.log("\n正在关闭…");
    clearInterval(sweep);
    for (const h of handles) h.stop();
    await pool.closeAll();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("启动失败:", e);
  process.exit(1);
});
