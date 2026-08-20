/**
 * 自测：验证 pi --mode rpc 桥接（无需飞书）。
 * 用法：node scripts/self-test.ts [--prompt "你好"] [--timeout 90000]
 * - 默认只做 RPC 握手（get_state），不消耗模型
 * - 加 --prompt 会真实调用一次 agent（需要已配置模型 provider）
 */
import { loadConfig } from "../src/config.ts";
import { PiRpcClient } from "../src/agent/rpc.ts";

async function main(): Promise<void> {
  const cfg = loadConfig();
  console.log("配置:", { provider: cfg.provider, model: cfg.model || "(默认)", tools: cfg.allowedTools });

  const client = new PiRpcClient(cfg, "self-test");
  client.onEvent((e) => {
    // 输出流式文本（辅助观察）
    if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
      process.stdout.write(e.assistantMessageEvent.delta);
    }
  });

  // 1) RPC 握手
  const state = await client.send({ type: "get_state" }, 60_000);
  console.log("\n[get_state]", JSON.stringify(state).slice(0, 300));

  // 2) 可选真实提问
  const idx = process.argv.indexOf("--prompt");
  if (idx >= 0) {
    const text = process.argv[idx + 1] ?? "请用一句话回复：ok";
    const t0 = Date.now();
    console.log(`\n[ask] ${text}`);
    const answer = await client.ask(text, 120_000);
    console.log(`\n[answer(${Date.now() - t0}ms)] ${answer}`);
  }

  client.close();
  console.log("\n✅ 自测完成");
}

main().catch((e) => {
  console.error("❌ 自测失败:", e?.message ?? e);
  process.exit(1);
});
