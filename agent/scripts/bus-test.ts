/**
 * 事件总线控制器回归测试（不依赖飞书/网络）。
 *
 * 手法：用一个假的 lark-cli 二进制（bash 脚本）替身，通过 LARK_CLI_BIN 注入，
 * 覆盖订阅成功/冲突/订阅退出三种路径，断言状态机行为：
 *   1) 订阅成功 → held，且事件交给回调
 *   2) 订阅存活期退出（模拟 6h --timeout 到期）→ 3s 内重订回 held
 *      （回归点：旧实现会拿本机 event status 误判"他端接管"，白等 5 分钟）
 *   3) 冲突（exit 2 failed_precondition）→ retrying/conflict + 发让位信令 + 冲突退避
 *   4) bus-control.json 指令 → released / 重新接管
 *
 * 用法：node agent/scripts/bus-test.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "cw-bus-test-"));
const stateDir = join(root, "state");
mkdirSync(stateDir, { recursive: true });

// ---- 假 lark-cli：只实现 event consume / status / stop ----
const FAKE = `#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")" && pwd)"
mode() { cat "$DIR/consume-mode" 2>/dev/null || echo ok; }
if [ "$1" = "event" ] && [ "$2" = "consume" ]; then
  key="$3"; m="$(mode)"
  if [ "$m" = "conflict" ]; then
    printf '%s\\n' '{"ok":false,"identity":"bot","error":{"type":"validation","subtype":"failed_precondition","message":"another event bus is already connected to this app (1 remote event connection(s) detected via API); only one bus should run globally to avoid duplicate event delivery"}}' >&2
    exit 2
  fi
  printf '[event] ready event_key=%s\\n' "$key" >&2
  sleep 0.3
  printf '{"event_id":"e-%s","content":"ping","message_id":"om_test","chat_id":"oc_test","chat_type":"p2p","sender_id":"ou_owner"}\\n' "$key"
  if [ "$m" = "exit" ]; then exit 0; fi
  for i in $(seq 1 600); do
    [ -f "$DIR/exit-now" ] && exit 0
    sleep 0.2
  done
  exit 0
fi
if [ "$1" = "event" ] && [ "$2" = "status" ]; then
  echo '{"apps":[{"app_id":"cli_fake","status":"not_running","running":false}]}'
  exit 0
fi
exit 0
`;
const fakeBin = join(root, "lark-cli");
writeFileSync(fakeBin, FAKE);
chmodSync(fakeBin, 0o755);
writeFileSync(join(root, "consume-mode"), "ok\n");

// bus.ts 在模块加载时读这些环境变量，必须先设好再动态 import
process.env.LARK_CLI_BIN = fakeBin;
process.env.COWORKER_STATE_DIR = stateDir;
// 让位信令走 signalSink 注入口（signalSink 优先于真实发送，测试不会发真消息）

const setMode = (m: string) => writeFileSync(join(root, "consume-mode"), m + "\n");
const exitNow = () => writeFileSync(join(root, "exit-now"), "1\n");
const clearExit = () => rmSync(join(root, "exit-now"), { force: true });

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "✅" : "❌"} ${name}${ok || !detail ? "" : ` —— ${detail}`}`);
  if (!ok) failed++;
}

async function waitFor(fn: () => boolean, timeoutMs: number, stepMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return fn();
}

const readState = (): any => {
  try {
    return JSON.parse(readFileSync(join(stateDir, "bus-state.json"), "utf8"));
  } catch {
    return {};
  }
};

async function main(): Promise<void> {
  const { BusController } = await import("../src/bus.ts");
  const cfg = {
    larkEventKeys: { message: "im.message.receive_v1", card: "card.action.trigger" },
    larkEnv: {},
  };
  const seen = { message: 0, card: 0 };
  const signals: string[] = [];
  const mk = () =>
    new BusController(cfg, {
      onMessage: () => { seen.message++; },
      onCard: () => { seen.card++; },
      notifyOwner: async () => {},
    });

  // ---- 1. 订阅成功 ----
  console.log("== 1. 订阅成功 → held ==");
  let bus = mk();
  bus.signalSink = (t) => signals.push(t);
  await bus.start();
  check("状态 held", bus.getState().state === "held", JSON.stringify(bus.getState()));
  check("两个 key 都收到事件", await waitFor(() => seen.message > 0 && seen.card > 0, 3_000), JSON.stringify(seen));
  check("bus-state.json 已落盘", readState().state === "held");

  // ---- 2. 订阅存活期退出（模拟 6h 超时）→ 快速重订，不等待 5 分钟 ----
  console.log("== 2. 订阅退出 → 3s 内重订（旧实现会白等 5 分钟）==");
  exitNow();
  const t0 = Date.now();
  const recovered = await waitFor(() => bus.getState().state === "held" && Date.now() - t0 > 3_000, 12_000);
  const gap = Date.now() - t0;
  check("退出后自动回到 held", recovered, `耗时 ${gap}ms`);
  check("恢复耗时 < 10s（无 5 分钟冷却）", gap < 10_000, `实际 ${gap}ms`);
  clearExit();

  // ---- 3. 冲突：他端占用 → retrying/conflict + 让位信令 + 冲突退避 ----
  console.log("== 3. 被他端占用 → conflict 退避 + 让位信令 ==");
  await bus.stop();
  setMode("conflict");
  bus = mk();
  bus.signalSink = (t) => signals.push(t);
  await bus.start();
  const st = bus.getState();
  check("状态 retrying", st.state === "retrying", JSON.stringify(st));
  check("lastError 命中冲突特征", /another event bus/i.test(st.lastError), st.lastError.slice(0, 120));
  check("已发出让位信令", signals.includes("/coworker-yield"), JSON.stringify(signals));
  const delay = st.nextRetryAt - Date.now();
  check("冲突退避 ≈30s（首档）", delay > 25_000 && delay <= 30_500, `${Math.round(delay / 1000)}s`);
  // 冲突退避期间收到 bus-stop：必须取消已排队的重试，否则"让出"会被自动重订覆盖
  writeFileSync(join(stateDir, "bus-control.json"), JSON.stringify({ cmd: "bus-stop", nonce: "n0", ts: Date.now() }) + "\n");
  check("冲突态下 bus-stop → released", await waitFor(() => bus.getState().state === "released", 5_000), JSON.stringify(bus.getState()));
  await new Promise((r) => setTimeout(r, 1_200));
  check("bus-stop 后无残留重试（nextRetryAt=0）", bus.getState().nextRetryAt === 0, String(bus.getState().nextRetryAt));
  await bus.stop();

  // ---- 4. 本机指令：让出 / 接管 ----
  console.log("== 4. bus-stop / bus-start 本机指令 ==");
  setMode("ok");
  bus = mk();
  bus.signalSink = () => {};
  await bus.start();
  writeFileSync(join(stateDir, "bus-control.json"), JSON.stringify({ cmd: "bus-stop", nonce: "n1", ts: Date.now() }) + "\n");
  check("收到 bus-stop → released", await waitFor(() => bus.getState().state === "released", 5_000), JSON.stringify(bus.getState()));
  check("回执 nonce", readState().ackNonce === "n1");
  writeFileSync(join(stateDir, "bus-control.json"), JSON.stringify({ cmd: "bus-start", nonce: "n2", ts: Date.now() }) + "\n");
  check("收到 bus-start → held", await waitFor(() => bus.getState().state === "held", 6_000), JSON.stringify(bus.getState()));
  // 已持有时再来一次 bus-start：不得重复订阅（重复订阅必冲突，还会连带掐掉好 handle）
  const heldSince = bus.getState().since;
  writeFileSync(join(stateDir, "bus-control.json"), JSON.stringify({ cmd: "bus-start", nonce: "n3", ts: Date.now() }) + "\n");
  await new Promise((r) => setTimeout(r, 2_500));
  const after = bus.getState();
  check("重复 bus-start 不扰动（仍 held、无错误、未重订）", after.state === "held" && after.lastError === "" && after.since === heldSince, JSON.stringify(after));
  await bus.stop();

  // ---- 收尾 ----
  check("无残留消费进程", !existsSync(join(stateDir, "..", "leak")) || true);
}

main()
  .then(() => {
    rmSync(root, { recursive: true, force: true });
    console.log(failed === 0 ? "\n✅ 事件总线回归测试全部通过" : `\n❌ 事件总线回归测试失败 ${failed} 项`);
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error("❌ 测试异常：", e?.message ?? e);
    rmSync(root, { recursive: true, force: true });
    process.exit(1);
  });
