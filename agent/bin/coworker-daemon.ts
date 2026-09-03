#!/usr/bin/env node
/**
 * coworker-daemon —— 跨平台 Bot Agent 守护进程管理 CLI。
 *
 * 用法：
 *   coworker-daemon start                后台启动（写 pid + 日志）
 *   coworker-daemon stop / restart       优雅停止 / 重启
 *   coworker-daemon status               运行状态 + 事件总线
 *   coworker-daemon logs [--tail N]      查看日志
 *   coworker-daemon install [--autostart] 配置开机自启（macOS LaunchAgent / Windows 任务计划 / Linux systemd）
 *   coworker-daemon uninstall            停止并移除自启
 *
 * 运行文件：pid 与日志在 ~/.coworker/（跨平台）。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, openSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkUpdate, localVersion, compareVersions } from "../src/update.ts";
import { LARK_CONFIG_DIR, bundledPiBin, bundledRuntimeDir, resolveLarkBin } from "../src/runtime.ts";

const here = dirname(fileURLToPath(import.meta.url)); // agent/bin
const AGENT_DIR = resolve(here, ".."); // agent/
const SRC = join(AGENT_DIR, "src", "index.ts");
const RUNTIME_DIR = join(homedir(), ".coworker");

/** 守护进程子进程环境：内置运行时优先（与系统安装隔离），回退现有探测 */
function runtimeEnv(): Record<string, string> {
  const env: Record<string, string> = {
    LARKSUITE_CLI_CONFIG_DIR: LARK_CONFIG_DIR,
  };
  env.PI_BIN = process.env.PI_BIN?.trim() || bundledPiBin() || "pi";
  env.LARK_CLI_RUNTIME_DIR = process.env.LARK_CLI_RUNTIME_DIR?.trim() || bundledRuntimeDir() || "";
  const larkBin = resolveLarkBin();
  if (larkBin !== "lark-cli") env.LARK_CLI_BIN = larkBin;
  return env;
}
const PID_FILE = join(RUNTIME_DIR, "daemon.pid");
const LOG_FILE = join(RUNTIME_DIR, "daemon.log");
const NODE = process.execPath;

const log = (msg: string) => console.log(msg);

function usage(): void {
  log(`coworker-daemon — Bot Agent 守护进程管理

用法：
  coworker-daemon start                后台启动守护进程（日志 ${LOG_FILE}）
  coworker-daemon stop / restart       停止 / 重启
  coworker-daemon status               查看运行状态与事件总线
  coworker-daemon logs [--tail N]      查看日志（默认 50 行）
  coworker-daemon check-update [--url U] 检查新版本（默认 UPDATE_URL 环境变量）
  coworker-daemon install [--autostart] 配置开机自启
  coworker-daemon uninstall            停止并移除自启
`);
}

function readPid(): number | null {
  try {
    const pid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------- start ----------------

function start(): void {
  const pid = readPid();
  if (pid && alive(pid)) {
    log(`⚠️  守护进程已在运行 (pid ${pid})`);
    return;
  }
  mkdirSync(RUNTIME_DIR, { recursive: true });
  const out = openSync(LOG_FILE, "a");
  const child = spawn(NODE, [SRC], {
    env: {
      ...process.env,
      RUN_MODE: process.env.RUN_MODE ?? "local",
      // 内置运行时优先（node24/pi/lark-cli 与系统安装隔离）；后台进程 PATH 常缺 lark-cli，显式注入绝对路径
      ...runtimeEnv(),
    },
    stdio: ["ignore", out, out],
    detached: true,
    windowsHide: true,
  });
  child.unref();
  writeFileSync(PID_FILE, String(child.pid));
  log(`✅ 守护进程已启动 (pid ${child.pid})`);
  log(`   日志：${LOG_FILE}`);
  log(`   状态：coworker-daemon status`);
}

// ---------------- stop ----------------

async function stop(): Promise<void> {
  const pid = readPid();
  if (!pid || !alive(pid)) {
    log("ℹ️  守护进程未在运行");
    unlinkSyncIfExists(PID_FILE);
    return;
  }
  log(`⏳ 正在停止 (pid ${pid})…`);
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* ignore */
  }
  // 等待优雅退出，8s 后强杀
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && alive(pid)) {
    await sleep(200);
  }
  if (alive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ignore */
    }
    log("⚠️  优雅退出超时，已强制终止");
  } else {
    log("✅ 已停止");
  }
  unlinkSyncIfExists(PID_FILE);
}

// ---------------- restart / status / logs ----------------

async function restart(): Promise<void> {
  await stop();
  start();
}

async function status(): Promise<void> {
  const pid = readPid();
  const running = pid !== null && alive(pid);
  log(`守护进程：${running ? `✅ 运行中 (pid ${pid})` : "❌ 未运行"}`);
  if (running && pid) {
    // 事件总线状态
    const larkBin = resolveLarkBin();
    const es = spawnSync(larkBin, ["event", "status", "--json"], {
      env: { ...process.env, LARKSUITE_CLI_CONFIG_DIR: LARK_CONFIG_DIR, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" },
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
    });
    try {
      const j = JSON.parse(es.stdout.slice(es.stdout.indexOf("{")));
      const apps: any[] = j.apps ?? [];
      for (const a of apps) {
        const online = a.running;
        let suffix = "";
        if (!online) {
          // 读最近日志，判断是否为“被其他实例占用”冲突
          let conflict = false;
          try {
            const tail = readFileSync(LOG_FILE, "utf8").slice(-4000);
            conflict = /another event bus|remote event connection|已被.+(占用|连接)|事件订阅失败/.test(tail);
          } catch { /* 无日志 */ }
          if (conflict) suffix = "（可能被其他设备/实例占用，仅一处能收消息）";
        }
        log(`事件总线（${a.app_id}）：${online ? "✅ 在线" : "❌ 离线"}${suffix}`);
      }
      if (apps.length === 0) log("事件总线：未找到订阅记录");
    } catch {
      log("事件总线：查询失败（lark-cli event status）");
    }
  }
  if (existsSync(LOG_FILE)) {
    const size = statSync(LOG_FILE).size;
    log(`日志：${LOG_FILE}（${(size / 1024).toFixed(1)} KB）`);
  }
}

function logs(args: string[]): void {
  const ti = args.indexOf("--tail");
  const n = ti >= 0 ? Math.max(1, parseInt(args[ti + 1] ?? "50", 10) || 50) : 50;
  if (!existsSync(LOG_FILE)) {
    log("尚无日志（守护进程未启动过）");
    return;
  }
  const content = readFileSync(LOG_FILE, "utf8");
  const lines = content.split("\n").filter(Boolean);
  log(lines.slice(-n).join("\n"));
}

// ---------------- install / uninstall（开机自启） ----------------

function install(args: string[]): void {
  const autostart = args.includes("--autostart");
  if (!autostart) {
    log("用法：coworker-daemon install --autostart");
    return;
  }
  switch (process.platform) {
    case "darwin":
      return installMac();
    case "win32":
      return installWindows();
    case "linux":
      return installLinux();
    default:
      log(`❌ 暂不支持平台：${process.platform}`);
  }
}

function installMac(): void {
  const dir = join(homedir(), "Library", "LaunchAgents");
  mkdirSync(dir, { recursive: true });
  const plist = join(dir, "com.coworker.agent.plist");
  // 登录自启环境：内置运行时（node24/pi/lark-cli）优先；LaunchAgent 的 PATH 很精简，把运行时目录前置
  const env: Record<string, string> = { RUN_MODE: "local", ...runtimeEnv() };
  const rt = env.LARK_CLI_RUNTIME_DIR;
  if (rt) env.PATH = `${rt}:/usr/bin:/bin:/usr/sbin:/sbin`;
  const envXml = Object.entries(env)
    .filter(([, v]) => v)
    .map(([k, v]) => `<key>${k}</key><string>${xmlEscape(v)}</string>`)
    .join("");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.coworker.agent</string>
  <key>ProgramArguments</key>
  <array><string>${NODE}</string><string>${SRC}</string></array>
  <key>WorkingDirectory</key><string>${AGENT_DIR}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG_FILE}</string>
  <key>StandardErrorPath</key><string>${LOG_FILE}</string>
  <key>EnvironmentVariables</key>
  <dict>${envXml}</dict>
</dict>
</plist>
`;
  writeFileSync(plist, xml);
  const r = spawnSync("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? ""}`, plist], { encoding: "utf8", windowsHide: true });
  log(r.status === 0 ? `✅ 已配置开机自启（${plist}）` : `✅ 已写入 ${plist}（launchctl: ${r.stderr?.trim() || "ok"}）`);
}

function installWindows(): void {
  // 写一个包装 .cmd（设置内置运行时环境后启动），再注册任务计划
  const cmdFile = join(RUNTIME_DIR, "coworker-agent.cmd");
  mkdirSync(RUNTIME_DIR, { recursive: true });
  const env: Record<string, string> = { RUN_MODE: "local", ...runtimeEnv() };
  const rt = env.LARK_CLI_RUNTIME_DIR;
  const lines = ["@echo off"];
  for (const [k, v] of Object.entries(env)) {
    if (!v) continue;
    if (k === "PATH") continue;
    lines.push(`set ${k}=${v}`);
  }
  if (rt) lines.push(`set PATH=${rt};%PATH%`);
  lines.push(`"${NODE}" "${SRC}"`);
  const cmd = lines.join("\r\n") + "\r\n";
  writeFileSync(cmdFile, cmd);
  const task = "CoworkerAgent";
  const r = spawnSync("schtasks", ["/Create", "/F", "/TN", task, "/TR", `"${cmdFile}"`, "/SC", "ONLOGON", "/RL", "LIMITED"], { encoding: "utf8", windowsHide: true });
  log(r.status === 0 ? `✅ 已注册 Windows 任务计划（登录时自动启动）` : `✅ 已生成 ${cmdFile}（schtasks: ${r.stderr?.trim() || r.stdout?.trim() || "ok"}）`);
}

function installLinux(): void {
  const env: Record<string, string> = { RUN_MODE: "local", ...runtimeEnv() };
  const envLines = Object.entries(env)
    .filter(([, v]) => v)
    .map(([k, v]) => `Environment=${k}=${v}`)
    .join("\n");
  const unit = join(homedir(), ".config", "systemd", "user", "coworker-agent.service");
  mkdirSync(dirname(unit), { recursive: true });
  const body = `[Unit]
Description=Coworker Bot Agent
After=network.target

[Service]
ExecStart=${NODE} ${SRC}
${envLines}
WorkingDirectory=${AGENT_DIR}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
  writeFileSync(unit, body);
  const r = spawnSync("systemctl", ["--user", "enable", "--now", "coworker-agent"], { encoding: "utf8", windowsHide: true });
  log(r.status === 0 ? `✅ 已启用 systemd 用户服务（开机自启）` : `✅ 已写入 ${unit}（systemctl: ${r.stderr?.trim() || "ok"}）`);
}

async function uninstall(): Promise<void> {
  await stop();
  try {
    if (process.platform === "darwin") {
      const plist = join(homedir(), "Library", "LaunchAgents", "com.coworker.agent.plist");
      spawnSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? ""}/com.coworker.agent`], { encoding: "utf8", windowsHide: true });
      unlinkSyncIfExists(plist);
      log("✅ 已移除 macOS 自启");
    } else if (process.platform === "win32") {
      spawnSync("schtasks", ["/Delete", "/F", "/TN", "CoworkerAgent"], { encoding: "utf8", windowsHide: true });
      unlinkSyncIfExists(join(RUNTIME_DIR, "coworker-agent.cmd"));
      log("✅ 已移除 Windows 任务计划");
    } else if (process.platform === "linux") {
      spawnSync("systemctl", ["--user", "disable", "--now", "coworker-agent"], { encoding: "utf8", windowsHide: true });
      unlinkSyncIfExists(join(homedir(), ".config", "systemd", "user", "coworker-agent.service"));
      log("✅ 已移除 Linux systemd 服务");
    }
  } catch (e: any) {
    log(`⚠️  移除自启出错：${e?.message ?? e}`);
  }
  log("✅ 卸载完成");
}

// ---------------- helpers ----------------

function unlinkSyncIfExists(p: string): void {
  try {
    unlinkSync(p);
  } catch {
    /* ignore */
  }
}

/** XML 属性/文本转义（plist 生成用） */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------- main ----------------

async function checkUpdateCmd(args: string[]): Promise<void> {
  const ui = args.indexOf("--url");
  const url = (ui >= 0 ? args[ui + 1] : undefined) ?? process.env.UPDATE_URL ?? "";
  if (!url) {
    log("未配置更新源：请传 --url <version.json 地址> 或设置环境变量 UPDATE_URL。");
    return;
  }
  log(`当前版本：${localVersion()}`);
  const r = await checkUpdate({ url, intervalMs: 0 });
  if (r.error) {
    log(`❌ 检查失败：${r.error}`);
    return;
  }
  if (r.available) {
    log(`🔔 发现新版本：${r.latest}${r.notes ? `\n  说明：${r.notes}` : ""}`);
    if (r.url) log(`   下载：${r.url}`);
    log(`   升级方式：pi update --extensions 后重启守护进程（coworker-daemon restart）`);
  } else {
    log(`✅ 已是最新版本（${r.latest}）`);
  }
}

// ---------------- main ----------------

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "start":
      start();
      break;
    case "stop":
      await stop();
      break;
    case "restart":
      await restart();
      break;
    case "status":
      await status();
      break;
    case "logs":
      logs(args);
      break;
    case "check-update":
      await checkUpdateCmd(args);
      break;
    case "install":
      install(args);
      break;
    case "uninstall":
      await uninstall();
      break;
    default:
      usage();
  }
}

main().catch((e) => {
  console.error("执行失败:", e?.message ?? e);
  process.exit(1);
});
