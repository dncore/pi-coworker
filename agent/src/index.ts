/**
 * Bot Agent 守护程序入口（RUN_MODE=local|server）。
 * 启动：配置校验（按模式工具白名单 fail-fast）→ 事件订阅（消息/卡片）→ agent 池就绪。
 * 退出：Ctrl+C / SIGTERM → 优雅关闭事件订阅（stdin EOF）与 agent 池。
 */
import { loadConfig } from "./config.ts";
import { validateToolAllowlist } from "./security/allowlist.ts";
import { MODE_LABEL } from "./mode.ts";
import { Gateway } from "./security/gateway.ts";
import { PiAgentPool } from "./agent/pool.ts";
import { consumeEvent, type ConsumerHandle } from "./bot/consume.ts";
import { handleMessage, handleCardAction, createBotContext } from "./bot/handler.ts";
import { startHeartbeat, resolveOpenId } from "./heartbeat.ts";
import { checkUpdate } from "./update.ts";

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
  const ctx = createBotContext(cfg, pool, gateway);

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
    // 事件订阅失败不闪退：可能事件总线已被别处占用（仅允许全局一个 bus）。
    // 降级为本地 agent 运行（不接收实时飞书消息），保持守护进程稳定；
    // 若后续无人订阅，守护进程仍有价值（本地问答/定时）。
    console.error(`⚠️ 事件订阅失败（可能已被别处占用）：${e?.message ?? e}`);
    for (const h of handles) h.stop();
    console.error("已降级为本地运行（不订阅实时事件）。若需接收飞书消息，请确保全局只有一个事件总线上线。");
  }

  console.log("🚀 Bot Agent 运行中（Ctrl+C 退出）");

  // 轻心跳（可选）：仅上报 openId/在线状态，不携带对话内容
  const stopHeartbeat = startHeartbeat({
    url: cfg.heartbeatUrl,
    intervalMs: cfg.heartbeatIntervalMs,
    mode: cfg.mode,
  });
  if (cfg.heartbeatUrl) console.log(`✅ 心跳上报已启用（${cfg.heartbeatUrl}，每 ${cfg.heartbeatIntervalMs / 1000}s）`);

  // 自更新检查（可选）：发现新版本 → 日志 + 审计 + 通知绑定用户；不自动升级
  const checkForUpdate = async (notifyUser: boolean): Promise<void> => {
    if (!cfg.updateUrl) return;
    const r = await checkUpdate({ url: cfg.updateUrl, intervalMs: cfg.updateCheckIntervalMs });
    if (r.error) {
      console.warn(`[update] 检查失败：${r.error}`);
      return;
    }
    if (!r.available) return;
    console.warn(`[update] 发现新版本 ${r.latest}（当前 ${r.current}）${r.notes ? `：${r.notes}` : ""}`);
    ctx.gateway.audit({
      user: "daemon",
      cluster: "update",
      action: "update_available",
      resource: "package",
      result: "ok",
      detail: { current: r.current, latest: r.latest },
    });
    if (notifyUser) {
      const openId = resolveOpenId();
      if (openId) {
        try {
          await ctx.channel.sendText(
            openId,
            `🔔 助手有新版本 ${r.latest}（当前 ${r.current}）${r.notes ? `\n${r.notes}` : ""}\n请打开桌面助手更新，或联系 IT 协助。`,
          );
        } catch (e: any) {
          console.warn(`[update] 通知发送失败：${e?.message ?? e}`);
        }
      }
    }
  };
  if (cfg.updateUrl) {
    void checkForUpdate(false); // 启动即查一次（仅日志+审计，避免启动期打扰）
    const updateTimer = setInterval(() => void checkForUpdate(true), cfg.updateCheckIntervalMs);
    updateTimer.unref?.();
    console.log(`✅ 自更新检查已启用（${cfg.updateUrl}，每 ${cfg.updateCheckIntervalMs / 3_600_000}h）`);
  }

  const sweep = setInterval(() => {
    void pool.sweep();
  }, 60_000);

  const shutdown = async () => {
    console.log("\n正在关闭…");
    clearInterval(sweep);
    stopHeartbeat();
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