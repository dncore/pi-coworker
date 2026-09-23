/**
 * 内嵌组件覆盖层 —— lark-cli / pi / skills 的「应用内独立更新」（与系统全局隔离）。
 *
 * 动机：包内（安装目录）组件随 App 版本走，升级要换整个安装包；而 lark-cli / pi bundle /
 * 公司技能的实际迭代比 App 快得多。此模块提供一个**用户可写的覆盖层**：
 *
 *   ~/.coworker/components/
 *     <name>/current            ← 文本指针（当前启用版本，写入用 tmp+rename 原子替换）
 *     <name>/<version>/…        ← 该版本的文件树
 *
 * 解析优先级（各解析点统一遵守）：覆盖层 current > 包内资源 > 系统安装。
 * 覆盖层在 ~/.coworker 下，与系统安装的 lark-cli / pi / 用户自己的 ~/.lark-cli 完全隔离。
 *
 * 更新源（公司内网可控）：deploy.json.componentFeedUrl（或环境变量 COMPONENT_FEED_URL），
 * 目录约定：
 *   {feedUrl}/{platform}/manifest.json        platform = darwin-arm64 / win32-x64
 *   {feedUrl}/{platform}/<file>               组件包（kind=file 为裸文件；kind=targz 为 tar.gz）
 * manifest 中每个组件必须带 sha256，校验不通过一律拒绝安装。
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { gunzipSync } from "node:zlib";

export const COMPONENT_NAMES = ["lark-cli", "pi", "node", "pi-packages", "skills", "dispenser"] as const;
export type ComponentName = (typeof COMPONENT_NAMES)[number];

export function componentsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.COWORKER_COMPONENTS_DIR?.trim() || join(homedir(), ".coworker", "components");
}

function currentPath(name: ComponentName, env?: NodeJS.ProcessEnv): string {
  return join(componentsRoot(env), name, "current");
}

/** 覆盖层中该组件当前启用版本；未装过则 undefined */
export function componentCurrentVersion(name: ComponentName, env?: NodeJS.ProcessEnv): string | undefined {
  try {
    const v = readFileSync(currentPath(name, env), "utf8").trim();
    return v || undefined;
  } catch {
    return undefined;
  }
}

/** 覆盖层中该组件当前启用目录（current 指向且存在）；否则 undefined */
export function componentActiveDir(name: ComponentName, env?: NodeJS.ProcessEnv): string | undefined {
  const v = componentCurrentVersion(name, env);
  if (!v) return undefined;
  const dir = join(componentsRoot(env), name, v);
  return existsSync(dir) ? dir : undefined;
}

export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** 3 段 semver 比较（同 agent/src/update.ts 的口径；此处自带以免反向依赖） */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// ---------------- 升级策略（按组件区分「是否建议升到最新」） ----------------
// 依据（产品口径）：
//   lark-cli / pi / 扩展包 / 公司技能 —— 与公司服务/能力直接相关，建议尽快跟进最新；
//   node —— 运行时求稳，不建议始终追最新：只在同大版本内跟进补丁，跨大版本随 App 版本一起验证。
export type UpgradeMode = "latest" | "same-major";

export interface ComponentPolicy {
  mode: UpgradeMode;
  /** 升级建议标签（GUI 展示） */
  adviceLabel: string;
  note: string;
}

export const COMPONENT_POLICY: Record<ComponentName, ComponentPolicy> = {
  "lark-cli": { mode: "latest", adviceLabel: "建议升级", note: "连接公司服务，建议尽快跟进最新版" },
  pi: { mode: "latest", adviceLabel: "建议升级", note: "agent 内核，能力与修复建议尽快跟进" },
  node: { mode: "same-major", adviceLabel: "保守升级", note: "运行时求稳：仅同大版本内跟进，跨大版本随 App 版本一起验证" },
  "pi-packages": { mode: "latest", adviceLabel: "建议升级", note: "内置扩展包，随组件源检测升级" },
  skills: { mode: "latest", adviceLabel: "建议升级", note: "公司技能包，随组件源检测升级" },
  dispenser: { mode: "latest", adviceLabel: "建议升级", note: "授权分发脚本（含各 agent 接入规则），随组件源检测升级" },
};

export interface UpgradeAdvice {
  level: "update" | "hold" | "current" | "unknown";
  current?: string;
  available?: string;
  reason: string;
}

function majorOf(v: string): number {
  return parseInt(v.split(".")[0] ?? "", 10) || 0;
}

/** 版本串里取最高的 semver 段（pi-packages 的随包版本形如 "1.2.3/4.5.6"，由多个包版本拼成） */
export function maxSemverIn(s: string): string {
  const parts = String(s).split(/[/,\s]+/).filter(Boolean);
  return parts.reduce((a, b) => (compareSemver(b, a) > 0 ? b : a), parts[0] ?? "");
}

/**
 * 按组件策略给单组件出升级建议。current = 覆盖层已装版本 ?? 随包版本（"随包"视为无版本）。
 * 检查源不可用时一律 unknown（不下"已是最新"的结论，避免误报）。
 */
export function evaluateUpgrade(name: ComponentName, current: string | undefined, available: string | undefined): UpgradeAdvice {
  const policy = COMPONENT_POLICY[name];
  if (!available) return { level: "unknown", current, reason: "组件源未提供该组件" };
  const cur = current && current !== "随包" ? maxSemverIn(current) : "";
  if (!cur) return { level: "update", available, reason: `可安装 ${available}` };
  if (compareSemver(available, cur) <= 0) return { level: "current", current: cur, available, reason: "已是最新" };
  if (policy.mode === "same-major" && majorOf(available) !== majorOf(cur)) {
    return {
      level: "hold",
      current: cur,
      available,
      reason: `跨大版本（${cur} → ${available}）暂不升级：${policy.note}`,
    };
  }
  return {
    level: "update",
    current: cur,
    available,
    reason: policy.mode === "same-major" ? `同大版本内可升级到 ${available}` : `建议升级到 ${available}`,
  };
}

export interface ComponentFile {
  path: string; // 相对路径（用 / 分隔）
  data: Buffer;
  mode?: number;
}

/** 路径安全检查：拒绝绝对路径与 .. 穿越 */
function safeRelative(p: string): string | null {
  const norm = normalize(p.replace(/\\/g, "/")).replace(/^\.\/+/, "");
  if (!norm || norm === "." || isAbsolute(norm) || norm.split("/").includes("..")) return null;
  return norm;
}

/**
 * 解析 tar.gz（ustar 子集）：普通文件与目录，其余类型（软链等）跳过。
 * 只做数据解包，不做落盘——落盘统一走 installComponent 的路径校验。
 */
export function extractTarGz(buf: Buffer): ComponentFile[] {
  const tar = gunzipSync(buf);
  const out: ComponentFile[] = [];
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break; // 结束块
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const sizeStr = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const modeStr = header.subarray(100, 108).toString("utf8").replace(/\0.*$/, "").trim();
    const type = String.fromCharCode(header[156] || 0x30);
    const size = parseInt(sizeStr, 8) || 0;
    const full = prefix ? `${prefix}/${name}` : name;
    off += 512;
    const data = tar.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    if (type === "5") continue; // 目录：由文件路径隐式创建
    if (type !== "0" && type !== "\0" && type !== "7") continue; // 仅普通文件/连续文件
    const rel = safeRelative(full);
    if (!rel) continue;
    out.push({ path: rel, data: Buffer.from(data), mode: modeStr ? parseInt(modeStr, 8) : undefined });
  }
  return out;
}

/**
 * 安装组件到覆盖层并原子切换 current 指针。
 * - 同名版本重装：先整目录删除重写（幂等，避免半旧半新）。
 * - 写入完成后才更新 current，任何中途失败不影响正在使用的旧版本。
 */
export function installComponent(name: ComponentName, version: string, files: ComponentFile[], env?: NodeJS.ProcessEnv): string {
  if (!/^[0-9][0-9A-Za-z.\-]*$/.test(version)) throw new Error(`非法版本号：${version}`);
  const root = componentsRoot(env);
  const dir = join(root, name, version);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const rel = safeRelative(f.path);
    if (!rel) throw new Error(`组件包含非法路径：${f.path}`);
    const target = join(dir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.data);
    if (f.mode) chmodSync(target, f.mode);
  }
  mkdirSync(join(root, name), { recursive: true });
  const tmp = currentPath(name, env) + ".tmp";
  writeFileSync(tmp, version + "\n");
  renameSync(tmp, currentPath(name, env));
  return dir;
}

// ---------------- 组件源（公司内网清单） ----------------

export interface FeedComponent {
  version: string;
  /** 相对 {feedUrl}/{platform}/ 的文件名 */
  file: string;
  sha256: string;
  /** file=裸文件（如 lark-cli 二进制）；targz=tar.gz 文件树（默认） */
  kind?: "file" | "targz";
  /** kind=file 时落盘文件名（默认取组件名） */
  entry?: string;
}

export interface FeedManifest {
  platform?: string;
  components: Partial<Record<ComponentName, FeedComponent>>;
}

export function feedUrlFromConfig(deployCfg: { componentFeedUrl?: string }, env: NodeJS.ProcessEnv = process.env): string {
  return (env.COMPONENT_FEED_URL ?? deployCfg.componentFeedUrl ?? "").trim().replace(/\/+$/, "");
}

async function fetchBuf(url: string, timeoutMs: number): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function fetchFeedManifest(feedUrl: string, platform: string, timeoutMs = 15_000): Promise<FeedManifest> {
  const buf = await fetchBuf(`${feedUrl}/${platform}/manifest.json`, timeoutMs);
  const m = JSON.parse(buf.toString("utf8")) as FeedManifest;
  if (!m || typeof m !== "object" || !m.components) throw new Error("manifest.json 结构无效（缺 components）");
  return m;
}

export interface InstallResult {
  name: ComponentName;
  version?: string;
  ok: boolean;
  message: string;
}

/**
 * 从组件源检查并安装更新（仅安装比当前覆盖层版本新的；未装过的直接装）。
 * 平台参数形如 darwin-arm64 / win32-x64（与 runtime/versions.json 同口径）。
 */
export async function installFromFeed(opts: {
  feedUrl: string;
  platform: string;
  names?: readonly ComponentName[];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<{ ok: boolean; results: InstallResult[] }> {
  const { feedUrl, platform, timeoutMs = 120_000, env } = opts;
  const names = opts.names ?? COMPONENT_NAMES;
  const manifest = await fetchFeedManifest(feedUrl, platform, Math.min(timeoutMs, 20_000));
  const results: InstallResult[] = [];
  for (const name of names) {
    const spec = manifest.components[name];
    if (!spec) {
      results.push({ name, ok: true, message: "组件源未提供，跳过" });
      continue;
    }
    const cur = componentCurrentVersion(name, env);
    if (cur && compareSemver(spec.version, cur) <= 0) {
      results.push({ name, version: cur, ok: true, message: `已是最新（${cur}）` });
      continue;
    }
    try {
      const buf = await fetchBuf(`${feedUrl}/${platform}/${spec.file}`, timeoutMs);
      const got = sha256Hex(buf);
      if (got !== spec.sha256.toLowerCase()) {
        throw new Error(`sha256 校验失败（期望 ${spec.sha256.slice(0, 12)}…，实际 ${got.slice(0, 12)}…）`);
      }
      const files: ComponentFile[] =
        spec.kind === "file"
          ? [{ path: spec.entry ?? name, data: buf, mode: 0o755 }]
          : extractTarGz(buf);
      if (files.length === 0) throw new Error("组件包为空或格式不符（tar.gz/ustar）");
      // lark-cli 二进制补执行位（tar 里未必带）
      for (const f of files) {
        if (name === "lark-cli" && !f.mode) f.mode = 0o755;
      }
      installComponent(name, spec.version, files, env);
      results.push({ name, version: spec.version, ok: true, message: `已更新到 ${spec.version}` });
    } catch (e: any) {
      results.push({ name, version: spec.version, ok: false, message: e?.message ?? String(e) });
    }
  }
  return { ok: results.every((r) => r.ok), results };
}
