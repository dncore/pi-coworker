/**
 * pi 扩展包的应用内安装/装配（与系统全局隔离，**不依赖系统 npm**）。
 *
 * 员工机通常没有 node/npm 也没有外网，两种来源：
 *  1) 内置装配 assembleBundledPackages()：把随包资源（或组件覆盖层）里已解析好的
 *     node_modules 树同步进 app 专属 pi 环境（<piDir>/npm/node_modules）；
 *  2) 用户安装 installNpmPackage()：`npm:name[@ver]` 从 registry 直接拉 tarball，
 *     解析依赖闭包（扁平安装），解包落盘。
 *
 * 两条路径都登记进 <piDir>/settings.json 的 packages 列表（pi 的发现机制据此加载），
 * 并只作用于传入的 piDir（GUI 后端固定传 ~/.coworker/pi-agent），系统 pi 配置零触碰。
 *
 * 简化口径（够用且可解释）：依赖范围解析取 registry 的 dist-tags.latest（`^`/`~` 的
 * 常规语义下即最新兼容版本）；不做版本冲突嵌套（扁平覆盖，扩展包依赖树通常很浅）。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { extractTarGz, type ComponentFile } from "./components.ts";

export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";

export interface PiEnvPaths {
  /** <piDir>/npm */
  npmDir: string;
  /** <piDir>/npm/node_modules */
  nodeModules: string;
  /** <piDir>/settings.json */
  settingsPath: string;
}

export function piEnvPaths(piDir: string): PiEnvPaths {
  const npmDir = join(piDir, "npm");
  return { npmDir, nodeModules: join(npmDir, "node_modules"), settingsPath: join(piDir, "settings.json") };
}

function readSettings(piDir: string): Record<string, any> {
  try {
    return JSON.parse(readFileSync(piEnvPaths(piDir).settingsPath, "utf8")) as Record<string, any>;
  } catch {
    return {};
  }
}

function writeSettings(piDir: string, s: Record<string, any>): void {
  mkdirSync(piDir, { recursive: true });
  writeFileSync(piEnvPaths(piDir).settingsPath, JSON.stringify(s, null, 2) + "\n");
}

/** settings.packages 加入 "npm:<name>"（幂等；返回是否新增） */
export function addPackageRef(piDir: string, name: string): boolean {
  const s = readSettings(piDir);
  const list: string[] = Array.isArray(s.packages) ? s.packages : [];
  const ref = `npm:${name}`;
  if (list.includes(ref)) return false;
  list.push(ref);
  s.packages = list;
  writeSettings(piDir, s);
  return true;
}

export function removePackageRef(piDir: string, name: string): boolean {
  const s = readSettings(piDir);
  const list: string[] = Array.isArray(s.packages) ? s.packages : [];
  const ref = `npm:${name}`;
  if (!list.includes(ref)) return false;
  s.packages = list.filter((x) => x !== ref);
  writeSettings(piDir, s);
  return true;
}

export function listPackageRefs(piDir: string): string[] {
  const s = readSettings(piDir);
  return (Array.isArray(s.packages) ? s.packages : []).map((x: any) => String(x));
}

/** 某包在 node_modules 里的实际版本（无则 undefined） */
export function installedVersion(piDir: string, name: string): string | undefined {
  try {
    const pj = join(piEnvPaths(piDir).nodeModules, ...name.split("/"), "package.json");
    return (JSON.parse(readFileSync(pj, "utf8")) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

// ---------------- 内置装配（随包资源 / 组件覆盖层 → app pi 环境） ----------------

export interface AssembleResult {
  ok: boolean;
  skipped: boolean;
  installed: Array<{ name: string; version: string }>;
  message: string;
}

/**
 * 把 sourceDir（含 node_modules/ 与 packages.json）装配进 piDir。
 * - 以 packages.json 内容哈希为戳：未变则跳过（避免每次启动几十 MB 拷贝）；
 * - 合并拷贝（force）不删用户自装包；只清理「上一版内置、本版已移除」的包目录；
 * - 用户自装包与内置包共用 <piDir>/npm/node_modules（node 解析语义）。
 */
export function assembleBundledPackages(sourceDir: string, piDir: string, force = false): AssembleResult {
  const manifestPath = join(sourceDir, "packages.json");
  if (!existsSync(manifestPath)) {
    return { ok: true, skipped: true, installed: [], message: "无随包 pi 扩展（缺 packages.json）" };
  }
  const raw = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(raw) as { packages?: Array<{ name: string; version: string }> };
  const pkgs = manifest.packages ?? [];
  const stamp = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  const stampPath = join(piDir, ".pi-packages-stamp");
  let prev: { hash?: string; names?: string[] } = {};
  if (existsSync(stampPath)) {
    try { prev = JSON.parse(readFileSync(stampPath, "utf8")); } catch { prev = {}; }
  }
  if (!force && prev.hash === stamp) {
    return { ok: true, skipped: true, installed: pkgs, message: "内置扩展包已是最新" };
  }
  const paths = piEnvPaths(piDir);
  mkdirSync(paths.nodeModules, { recursive: true });
  // 清理上一版内置、本版已移除的包（不碰用户自装包）
  const nowNames = new Set(pkgs.map((p) => p.name));
  for (const oldName of prev.names ?? []) {
    if (!nowNames.has(oldName)) rmSync(join(paths.nodeModules, ...oldName.split("/")), { recursive: true, force: true });
  }
  // 整棵依赖树合并同步（含间接依赖）
  const srcNM = join(sourceDir, "node_modules");
  if (existsSync(srcNM)) {
    cpSync(srcNM, paths.nodeModules, { recursive: true, force: true });
  }
  for (const p of pkgs) addPackageRef(piDir, p.name);
  mkdirSync(piDir, { recursive: true });
  writeFileSync(stampPath, JSON.stringify({ hash: stamp, names: pkgs.map((p) => p.name), at: new Date().toISOString() }, null, 2) + "\n");
  return {
    ok: true,
    skipped: false,
    installed: pkgs,
    message: `已装配内置扩展：${pkgs.map((p) => `${p.name}@${p.version}`).join(", ")}`,
  };
}

// ---------------- 用户安装（registry 直取，无需 npm） ----------------

const NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;

/** 解析 npm:name[@ver] / name[@ver] → {name, version?} */
export function parseNpmSpec(source: string): { name: string; version?: string } {
  const s = source.trim().replace(/^npm:/i, "");
  const at = s.lastIndexOf("@");
  let name = s;
  let version: string | undefined;
  if (at > 0) {
    name = s.slice(0, at);
    version = s.slice(at + 1) || undefined;
  }
  if (!NAME_RE.test(name)) throw new Error(`包名不合法：${name}`);
  if (version && !/^[0-9][0-9A-Za-z.\-+]*$/.test(version)) throw new Error(`版本号不合法：${version}`);
  return { name, version };
}

interface RegistryMeta {
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, { dependencies?: Record<string, string>; dist?: { tarball?: string } }>;
}

async function fetchJson(url: string, timeoutMs: number): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}（${url}）`);
  return await res.json();
}

async function fetchBuf(url: string, timeoutMs: number): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}（${url}）`);
  return Buffer.from(await res.arrayBuffer());
}

/** dist-tags.latest（或指定版本）的元数据 */
async function resolveVersion(name: string, version: string | undefined, registry: string, timeoutMs: number) {
  const meta = (await fetchJson(`${registry}/${name.replace("/", "%2f")}`, timeoutMs)) as RegistryMeta;
  const ver = version ?? meta["dist-tags"]?.latest;
  if (!ver || !meta.versions?.[ver]) throw new Error(`registry 无此版本：${name}@${ver ?? "latest"}`);
  return { version: ver, info: meta.versions[ver] };
}

export interface NpmInstallResult {
  name: string;
  version: string;
  packages: number;
}

/**
 * 安装 npm 扩展包及依赖闭包（扁平）到 <piDir>/npm/node_modules，并登记 settings。
 * 全程只依赖 registry 的 HTTP 接口与内置解包器，**不调用 npm**。
 */
export async function installNpmPackage(opts: {
  source: string;
  piDir: string;
  registry?: string;
  timeoutMs?: number;
  maxPackages?: number;
}): Promise<NpmInstallResult> {
  const registry = (opts.registry ?? DEFAULT_NPM_REGISTRY).replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const maxPackages = opts.maxPackages ?? 300;
  const root = parseNpmSpec(opts.source);
  const paths = piEnvPaths(opts.piDir);
  mkdirSync(paths.nodeModules, { recursive: true });

  const done = new Map<string, string>(); // name → version
  const queue: Array<{ name: string; version?: string }> = [root];
  while (queue.length) {
    if (done.size >= maxPackages) throw new Error(`依赖过多（>${maxPackages}），已中止`);
    const { name, version } = queue.shift()!;
    if (done.has(name)) continue;
    const resolved = await resolveVersion(name, version, registry, timeoutMs);
    const tarball = resolved.info.dist?.tarball;
    if (!tarball) throw new Error(`${name}@${resolved.version} 缺 tarball 地址`);
    const buf = await fetchBuf(tarball, timeoutMs);
    // npm tarball 顶层统一是 package/ 前缀
    const files: ComponentFile[] = extractTarGz(buf)
      .map((f) => ({ ...f, path: f.path.replace(/^package\//, "") }))
      .filter((f) => f.path.length > 0);
    if (!files.some((f) => f.path === "package.json")) {
      throw new Error(`${name}@${resolved.version} 包结构异常（无 package.json）`);
    }
    const dst = join(paths.nodeModules, ...name.split("/"));
    rmSync(dst, { recursive: true, force: true });
    mkdirSync(dst, { recursive: true });
    for (const f of files) {
      const target = join(dst, f.path);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, f.data);
    }
    done.set(name, resolved.version);
    for (const [dep, range] of Object.entries(resolved.info.dependencies ?? {})) {
      if (!done.has(dep)) queue.push({ name: dep, version: undefined, ...rangeToHint(range) });
    }
  }
  addPackageRef(opts.piDir, root.name);
  return { name: root.name, version: done.get(root.name) ?? "", packages: done.size };
}

/** `^x.y.z`/`~x.y.z`/`>=x` 等取 latest（见文件头简化口径）；精确版本原样传递 */
function rangeToHint(range: string): { version?: string } {
  const m = range.match(/^=?v?(\d+\.\d+\.\d+[0-9A-Za-z.\-+]*)$/);
  return m ? { version: m[1] } : {};
}

/** 移除某包：settings 登记 + node_modules 目录（依赖残留不深清） */
export function removeNpmPackage(piDir: string, source: string): { name: string; removedSettings: boolean } {
  const { name } = parseNpmSpec(source);
  const removedSettings = removePackageRef(piDir, name);
  const dst = join(piEnvPaths(piDir).nodeModules, ...name.split("/"));
  rmSync(dst, { recursive: true, force: true });
  return { name, removedSettings };
}
