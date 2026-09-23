/**
 * 技能管理（GUI「技能」面板）——列出 pi 会话实际可见的技能、查看内容、启用/停用。
 *
 * 技能来源：
 *   builtin   包内公司技能（覆盖层 components/skills > 随包 skills/；只读，不可停用）
 *   lark-cli  lark-cli 内嵌技能（后端导出到 ~/.coworker/pi-agent/skills，随 CLI 版本重建）
 *   company   公司动态技能（管理员经知识源同步到 ~/.coworker/skills，pi 侧经 resources_discover 挂载）
 *   user      员工自放在 app 专属技能目录里的技能
 *
 * 停用机制：把技能目录移动到 <root>/.disabled/<相对路径>。pi 的技能扫描
 * （loadSkillsFromDirInternal）跳过任意以 "." 开头的目录，因此移入后即不可见；
 * 启用即移回原相对路径。lark-cli 重新导出时会跳过处于停用位置的技能（不重建）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { basename, dirname, join } from "node:path";

export type SkillSource = "builtin" | "lark-cli" | "company" | "user";

export interface SkillInfo {
  name: string;
  description: string;
  source: SkillSource;
  enabled: boolean;
  /** 是否支持启停（内置随包技能只读，不支持） */
  toggleable: boolean;
  /** 技能根目录（用于定位 .disabled） */
  root: string;
  /** SKILL.md 绝对路径 */
  path: string;
  mtimeMs: number;
  size: number;
}

export interface SkillRoots {
  /** 包内技能目录（覆盖层 > 随包）；可能不存在 */
  builtinDir?: string;
  /** app 专属 pi 技能目录（lark-cli 导出 + 用户自放） */
  piSkillsDir: string;
  /** 公司动态技能目录 */
  companyDir: string;
}

export const DISABLED_DIRNAME = ".disabled";

const MAX_DEPTH = 4;

/** 解析 SKILL.md frontmatter（只取 name/description 两个标量，够 GUI 用） */
export function parseSkillFrontmatter(text: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(name|description):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const value = kv[2].trim().replace(/^["']|["']$/g, "");
    if (kv[1] === "name" && !out.name) out.name = value;
    if (kv[1] === "description" && !out.description) out.description = value;
  }
  return out;
}

function readSkillFile(dir: string): { name?: string; description?: string; mtimeMs: number; size: number } | null {
  const file = join(dir, "SKILL.md");
  try {
    const st = statSync(file);
    if (!st.isFile()) return null;
    const meta = parseSkillFrontmatter(readFileSync(file, "utf8"));
    return { ...meta, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

/** 递归收集技能目录（含 .disabled 子树，标出 enabled）；命中 SKILL.md 的目录不再下钻 */
function collect(root: string, disabled: boolean, out: Array<{ dir: string; enabled: boolean }>, depth = 0): void {
  if (depth > MAX_DEPTH) return;
  const entries = safeReaddir(root);
  if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) {
    out.push({ dir: root, enabled: !disabled });
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === "node_modules") continue;
    if (e.name === DISABLED_DIRNAME) {
      for (const inner of safeReaddir(join(root, e.name))) {
        if (!inner.isDirectory()) continue;
        collect(join(root, e.name, inner.name), true, out, depth + 1);
      }
      continue;
    }
    if (e.name.startsWith(".")) continue;
    collect(join(root, e.name), disabled, out, depth + 1);
  }
}

function safeReaddir(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function relativeTo(root: string, dir: string, disabled: boolean): string {
  const base = disabled ? join(root, DISABLED_DIRNAME) : root;
  const rel = dir.slice(base.length).replace(/^[/\\]+/, "");
  return rel.replace(/\\/g, "/");
}

function larkSkillNames(piSkillsDir: string): Set<string> {
  try {
    const stamp = JSON.parse(readFileSync(join(piSkillsDir, ".lark-skills.json"), "utf8")) as { names?: string[] };
    return new Set((stamp.names ?? []).map(String));
  } catch {
    return new Set();
  }
}

/** 列出所有技能（按来源分组顺序：builtin → lark-cli → company → user） */
export function listSkills(roots: SkillRoots): SkillInfo[] {
  const out: SkillInfo[] = [];
  const push = (root: string, source: SkillSource, toggleable: boolean, topNameIsSource?: Set<string>) => {
    if (!root || !existsSync(root)) return;
    const found: Array<{ dir: string; enabled: boolean }> = [];
    collect(root, false, found);
    for (const { dir, enabled } of found) {
      const meta = readSkillFile(dir);
      if (!meta) continue;
      const rel = relativeTo(root, dir, !enabled);
      const top = rel.split("/")[0];
      const src: SkillSource = topNameIsSource && !topNameIsSource.has(top) ? "user" : source;
      out.push({
        name: meta.name || basename(dir),
        description: meta.description ?? "",
        source: src,
        enabled,
        toggleable,
        root,
        path: join(dir, "SKILL.md"),
        mtimeMs: meta.mtimeMs,
        size: meta.size,
      });
    }
  };
  push(roots.builtinDir ?? "", "builtin", false);
  push(roots.piSkillsDir, "lark-cli", true, larkSkillNames(roots.piSkillsDir));
  push(roots.companyDir, "company", true);
  return out;
}

/** 读取技能正文（上限 256KB，防超大文件灌进 GUI） */
export function readSkillContent(skill: Pick<SkillInfo, "path">): string {
  const text = readFileSync(skill.path, "utf8");
  return text.length > 256 * 1024 ? text.slice(0, 256 * 1024) + "\n\n…（已截断）" : text;
}

export interface ToggleResult {
  ok: boolean;
  message: string;
}

/** 启用/停用技能：在 <root>/<rel> 与 <root>/.disabled/<rel> 之间移动目录 */
export function setSkillEnabled(skill: Pick<SkillInfo, "root" | "source" | "path">, enabled: boolean): ToggleResult {
  if (skill.source === "builtin") return { ok: false, message: "内置技能随安装包发布，不支持停用" };
  const from = dirname(skill.path); // 当前技能目录
  const root = skill.root;
  const disabledRoot = join(root, DISABLED_DIRNAME);
  const rel = from.startsWith(disabledRoot)
    ? from.slice(disabledRoot.length).replace(/^[/\\]+/, "")
    : from.slice(root.length).replace(/^[/\\]+/, "");
  if (!rel) return { ok: false, message: "技能目录异常，无法切换" };
  const to = enabled ? join(root, rel) : join(disabledRoot, rel);
  try {
    if (existsSync(to)) return { ok: false, message: `目标位置已存在：${to}` };
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    // 清理迁移后空掉的 .disabled 子树（尽力而为）
    if (enabled) pruneEmpty(disabledRoot);
    return { ok: true, message: enabled ? "已启用（下一条消息生效）" : "已停用（下一条消息生效）" };
  } catch (e: any) {
    return { ok: false, message: `切换失败：${e?.message ?? e}` };
  }
}

function pruneEmpty(dir: string): void {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) pruneEmpty(join(dir, e.name));
    }
    if (readdirSync(dir).length === 0 && !dir.endsWith(DISABLED_DIRNAME)) rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
}

/** 记录一次 lark 技能导出结果（供 syncLarkSkills 写戳） */
export function writeLarkSkillsStamp(piSkillsDir: string, payload: Record<string, unknown>): void {
  mkdirSync(piSkillsDir, { recursive: true });
  writeFileSync(join(piSkillsDir, ".lark-skills.json"), JSON.stringify(payload, null, 2) + "\n");
}

/** 该技能是否处于停用位置（lark 重新导出时据此跳过，不重建被用户停用的技能） */
export function isSkillDisabled(piSkillsDir: string, rel: string): boolean {
  return existsSync(join(piSkillsDir, DISABLED_DIRNAME, rel));
}
