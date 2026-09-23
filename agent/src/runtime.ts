/**
 * 内置运行时解析（随 GUI 打包：node24 + pi + lark-cli，与系统安装的组件完全隔离）。
 *
 * agent 侧所有 lark-cli / pi 调用共用的解析逻辑：
 *   - lark-cli 二进制：LARK_CLI_BIN（显式）> 覆盖层 ~/.coworker/components（应用内独立更新）
 *     > 内置运行时（LARK_CLI_RUNTIME_DIR 或打包路径）> 版本管理器 > PATH
 *   - pi 启动器：覆盖层 > PI_BIN（显式）> 内置 bundle（打包/开发两种布局）
 *   - 配置目录：app 专用 ~/.coworker/lark-cli（与 extensions/core/lark.ts 保持一致）
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { componentActiveDir } from "../../extensions/core/components.ts";

const here = dirname(fileURLToPath(import.meta.url)); // agent/src

/** app 专用 lark-cli 配置目录（LARKSUITE_CLI_CONFIG_DIR） */
export const LARK_CONFIG_DIR = join(homedir(), ".coworker", "lark-cli");

/** 打包/开发两种布局下内置的 pi 启动器 */
export function bundledPiBin(): string | undefined {
  const cands = [
    resolve(here, "..", "..", "pi", "pi.mjs"), // 打包: Resources/pi/pi.mjs
    resolve(here, "..", "..", "gui", "src-tauri", "resources", "pi", "pi.mjs"), // 开发: repo/gui/src-tauri/resources/pi/pi.mjs
  ];
  return cands.find((p) => existsSync(p));
}

/** 内置运行时目录（node24 + lark-cli 二进制所在） */
export function bundledRuntimeDir(): string | undefined {
  const cands = [
    resolve(here, "..", "..", "runtime"), // 打包: Resources/runtime
    resolve(here, "..", "..", "gui", "src-tauri", "resources", "runtime"), // 开发: repo/gui/src-tauri/resources/runtime
  ];
  return cands.find((d) => existsSync(d));
}

/** pi 启动器解析：覆盖层（应用内独立更新）> PI_BIN（显式）> 内置 bundle */
export function resolvePiLauncher(env: NodeJS.ProcessEnv = process.env): string {
  const overlay = componentActiveDir("pi", env);
  if (overlay) {
    const p = join(overlay, "pi.mjs");
    if (existsSync(p)) return p;
  }
  const explicit = env.PI_BIN?.trim();
  if (explicit) return explicit;
  return bundledPiBin() ?? "pi";
}

/** 授权分发 CLI 入口解析：覆盖层（应用内独立更新）> 随包资源（打包=Resources/dispenser，开发=repo/dispenser） */
export function resolveDispenserCli(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const overlay = componentActiveDir("dispenser", env);
  if (overlay) {
    const p = join(overlay, "cli.ts");
    if (existsSync(p)) return p;
  }
  const explicit = env.COWORKER_DISPENSER_BIN?.trim();
  if (explicit && existsSync(explicit)) return explicit;
  const cands = [
    resolve(here, "..", "..", "dispenser", "cli.ts"), // 打包: Resources/dispenser/cli.ts；开发: repo/dispenser/cli.ts
    resolve(here, "..", "..", "gui", "src-tauri", "resources", "dispenser", "cli.ts"), // 开发: 资源目录副本
  ];
  return cands.find((p) => existsSync(p));
}

/** 包内技能目录解析：覆盖层（应用内独立更新）> 随包资源（打包=Resources/skills，开发=repo/skills，同一相对位置） */
export function resolveSkillsDir(): string | undefined {
  const overlay = componentActiveDir("skills");
  if (overlay && existsSync(overlay)) return overlay;
  const d = resolve(here, "..", "..", "skills");
  return existsSync(d) ? d : undefined;
}

/** 常见 Node 版本管理器的 lark-cli 安装位置（fnm/nvm/volta/asdf） */
function managedCliCandidates(): string[] {
  const home = homedir();
  const out: string[] = [];
  try {
    for (const v of readdirSync(join(home, ".local", "share", "fnm", "node-versions"))) {
      out.push(join(home, ".local", "share", "fnm", "node-versions", v, "installation", "bin", "lark-cli"));
    }
  } catch { /* 无 fnm */ }
  try {
    for (const v of readdirSync(join(home, ".nvm", "versions", "node"))) {
      out.push(join(home, ".nvm", "versions", "node", v, "bin", "lark-cli"));
    }
  } catch { /* 无 nvm */ }
  out.push(join(home, ".volta", "bin", "lark-cli"));
  out.push(join(home, ".asdf", "shims", "lark-cli"));
  return out;
}

/**
 * 解析 lark-cli 二进制路径。优先内置运行时（随 App 分发、与用户系统安装隔离），
 * 依次回退 LARK_CLI_BIN → 版本管理器 → PATH；最后兜底裸命令名（未安装语义）。
 */
export function resolveLarkBin(env: NodeJS.ProcessEnv = process.env): string {
  if (env.LARK_CLI_BIN?.trim()) return env.LARK_CLI_BIN.trim();
  // 覆盖层（应用内独立更新）：~/.coworker/components/lark-cli/<current>/
  const overlay = componentActiveDir("lark-cli", env);
  if (overlay) {
    for (const name of ["lark-cli", "lark-cli.exe", "lark-cli.cmd"]) {
      const p = join(overlay, name);
      if (existsSync(p)) return p;
    }
  }
  const rt = env.LARK_CLI_RUNTIME_DIR?.trim() || bundledRuntimeDir();
  if (rt) {
    for (const name of ["lark-cli", "lark-cli.exe", "lark-cli.cmd"]) {
      const p = join(rt, name);
      if (existsSync(p)) return p;
    }
  }
  for (const c of managedCliCandidates()) {
    if (existsSync(c)) return c;
  }
  for (const d of (env.PATH ?? "").split(env.PATH?.includes(";") ? ";" : ":")) {
    if (!d) continue;
    const p = join(d, "lark-cli");
    if (existsSync(p)) return p;
  }
  return "lark-cli";
}