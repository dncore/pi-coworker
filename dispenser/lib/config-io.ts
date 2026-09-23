// 配置文件共享 I/O 与文本工具:备份写入 / 密钥写入(0600) / 备份列表与还原 /
// YAML 块定位(缩进感知的文本级补丁)与 TOML/YAML 标量引号。
// 写入策略:非密钥文件写前自动备份为 .bak-<时间戳>;还原前当前文件再备份为
// .bak-pre-restore-<时间戳>(双保险);密钥文件不备份(避免凭据多副本),固定 0600。

import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// 通用文本工具
// ---------------------------------------------------------------------------

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 时间戳(用于备份文件名,UTC 紧凑格式)。 */
export function timestamp(): string {
  return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

/**
 * YAML 标量安全引号:安全字符(含空格)直接输出,否则按 JSON 双引号转义(JSON 转义是合法 YAML)。
 * 排除含 `: `(冒号+空格)或 ` #`(空格+井号)的值——这两种会让 plain scalar 语义改变。
 */
export function yamlQuote(value: string): string {
  if (value.length > 0 && /^[A-Za-z0-9_./:?=&%~+@ -]+$/.test(value) && !/: | #/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

/** 反转 YAML 标量引号(仅用于状态展示)。 */
export function unquoteYaml(s: string): string {
  const v = s.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  return v;
}

// ---------------------------------------------------------------------------
// YAML 块定位(缩进感知的文本级补丁,dsh/omp 共用)
// ---------------------------------------------------------------------------

/** 在 [from, to) 区域内定位 `key:` 行(可限定缩进)。 */
export function findKeyInRegion(
  text: string,
  from: number,
  to: number,
  key: string,
  exactIndent?: number,
): { start: number; end: number; indent: number } | null {
  const region = text.slice(from, to);
  const re = new RegExp(`^( *)${escapeRegExp(key)}:(?:[ \\t]|$)`, "m");
  const m = region.match(re);
  if (!m) return null;
  if (exactIndent !== undefined && m[1]!.length !== exactIndent) return null;
  const lineStart = from + m.index!;
  const lineEnd = text.indexOf("\n", lineStart);
  const end = lineEnd === -1 ? text.length : lineEnd;
  return { start: lineStart, end, indent: m[1]!.length };
}

/** 行尾后的下一个位置(跳过换行符)。 */
export function lineAfter(text: string, lineEnd: number): number {
  return lineEnd < text.length && text[lineEnd] === "\n" ? lineEnd + 1 : text.length;
}

/** 块体的结束位置:第一个缩进 <= blockIndent 的非空非注释行。 */
export function blockBodyEnd(text: string, bodyStart: number, blockIndent: number, limit: number): number {
  let pos = bodyStart;
  while (pos < limit) {
    const lineEnd = text.indexOf("\n", pos);
    const end = lineEnd === -1 ? limit : lineEnd + 1;
    const line = text.slice(pos, end);
    const content = line.trimStart();
    if (content.length > 0 && !content.startsWith("#")) {
      const indent = line.length - line.trimStart().length;
      if (indent <= blockIndent) return pos;
    }
    pos = end;
  }
  return limit;
}

/** 键行是否带内联值(flow style 等,直接报错要求手动编辑)。 */
export function headerHasInlineContent(text: string, headerStart: number, headerEnd: number): boolean {
  const line = text.slice(headerStart, headerEnd);
  const colonIdx = line.indexOf(":");
  const rest = line.slice(colonIdx + 1).trim();
  return rest.length > 0 && !rest.startsWith("#");
}

// ---------------------------------------------------------------------------
// 管理键合并(块内逐键 upsert:只改我们管理的键,其余行原样保留)
// ---------------------------------------------------------------------------

export type TextOp = { start: number; end: number; replacement: string };

/** 从后往前应用区间操作,保证偏移在前序操作后仍有效(同一位置时按输入顺序)。 */
export function applyTextOps(text: string, ops: TextOp[]): string {
  let out = text;
  for (const op of [...ops].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, op.start) + op.replacement + out.slice(op.end);
  }
  return out;
}

export type ManagedKey = {
  key: string;
  /** 替换文本行(已含缩进);null = 当前不适用,存在则移除。 */
  lines: string[] | null;
  /** true = 键行连同其子块一起处理(YAML 嵌套块/列表);false = 仅键行(内联值随行覆盖)。 */
  block?: boolean;
};

/** 区域内定位键行(TOML `key =` 或 YAML `key:`,限定精确缩进)。 */
function findKeyLine(
  text: string,
  from: number,
  to: number,
  key: string,
  separator: ":" | "=",
  exactIndent: number,
): { start: number; end: number; indent: number } | null {
  const region = text.slice(from, to);
  const re =
    separator === ":"
      ? new RegExp(`^( *)${escapeRegExp(key)}:(?:[ \\t]|$)`, "gm")
      : new RegExp(`^( *)${escapeRegExp(key)}[ \\t]*=`, "gm");
  for (const m of region.matchAll(re)) {
    if (m[1]!.length !== exactIndent) continue;
    const lineStart = from + m.index!;
    const lineEnd = text.indexOf("\n", lineStart);
    return { start: lineStart, end: lineEnd === -1 ? text.length : lineEnd, indent: m[1]!.length };
  }
  return null;
}

/** 块体尾部空行的起始位置(替换/删除块时保留尾部空行,避免吃掉段间空行)。 */
export function trailingBlankStart(text: string, from: number, to: number): number {
  const body = text.slice(from, to);
  const m = body.match(/\n(?:[ \t]*\n)+$/);
  return m ? from + m.index! + 1 : to;
}

/**
 * 在 [from,to) 区域内规划「管理键」的区间操作:
 * - 已有键:block=true 时替换键行 + 子块,否则仅替换键行;lines=null 时移除;
 * - 缺失且 lines 非 null:插入到区域起始(其余行原位保留)。
 * 调用方随后用 applyTextOps 应用,并在应用后对比文本判断是否变化。
 */
export function planManagedKeyUpserts(
  text: string,
  region: { start: number; end: number },
  opts: { separator: ":" | "="; indent: number; keys: ManagedKey[] },
): TextOp[] {
  const ops: TextOp[] = [];
  const inserts: string[] = [];
  for (const k of opts.keys) {
    const found = findKeyLine(text, region.start, region.end, k.key, opts.separator, opts.indent);
    if (!found) {
      if (k.lines) inserts.push(...k.lines);
      continue;
    }
    if (!k.lines) {
      if (k.block) {
        // 连同子块一起移除(仅保留尾部空行)
        const bodyStart = lineAfter(text, found.end);
        const bodyEnd = blockBodyEnd(text, bodyStart, found.indent, region.end);
        const coreEnd = trailingBlankStart(text, bodyStart, bodyEnd);
        ops.push({ start: found.start, end: bodyEnd, replacement: text.slice(coreEnd, bodyEnd) });
      } else {
        ops.push({ start: found.start, end: lineAfter(text, found.end), replacement: "" });
      }
      continue;
    }
    if (k.block) {
      const bodyStart = lineAfter(text, found.end);
      const bodyEnd = blockBodyEnd(text, bodyStart, found.indent, region.end);
      const coreEnd = trailingBlankStart(text, bodyStart, bodyEnd);
      ops.push({
        start: found.start,
        end: bodyEnd,
        replacement: `${k.lines.join("\n")}\n${text.slice(coreEnd, bodyEnd)}`,
      });
    } else {
      ops.push({ start: found.start, end: found.end, replacement: k.lines.join("\n") });
    }
  }
  if (inserts.length > 0) {
    ops.push({ start: region.start, end: region.start, replacement: `${inserts.join("\n")}\n` });
  }
  return ops;
}

export type YamlListItem = { id: string; start: number; bodyStart: number; end: number; indent: number };

/**
 * 扫描 [from,to) 内同缩进的 `- <key>: <value>` 列表项(值经 unquoteYaml 反转义);
 * end 为下一项起始或 to(含尾部空行,替换时用 trailingBlankStart 拆分)。
 */
export function scanYamlListItems(text: string, from: number, to: number, key = "id"): YamlListItem[] {
  const region = text.slice(from, to);
  const re = new RegExp(`^([ \\t]*)-[ \\t]+${escapeRegExp(key)}[ \\t]*:[ \\t]*(.*)$`, "gm");
  const hits: Array<{ start: number; indent: number; id: string }> = [];
  for (const m of region.matchAll(re)) {
    hits.push({ start: from + m.index!, indent: m[1]!.length, id: unquoteYaml(m[2]!.trim()) });
  }
  const listIndent = hits[0]?.indent;
  const items = hits.filter((h) => h.indent === listIndent);
  return items.map((h, i) => {
    const lineEnd = text.indexOf("\n", h.start);
    const bodyStart = lineEnd === -1 ? text.length : lineEnd + 1;
    return {
      id: h.id,
      start: h.start,
      bodyStart,
      end: i + 1 < items.length ? items[i + 1]!.start : to,
      indent: h.indent,
    };
  });
}

/** 列表项/块体的「内容结束位」:保留尾部空行,供替换时原样带回。 */
export function preserveTrailingBlanks(text: string, item: { bodyStart: number; end: number }): string {
  return text.slice(trailingBlankStart(text, item.bodyStart, item.end), item.end);
}

// ---------------------------------------------------------------------------
// 文件 I/O:备份写入 / 密钥写入 / 备份列表 / 还原
// ---------------------------------------------------------------------------

/** 读文件;不存在/不可读时返回空串(用于可选配置文件)。 */
export async function readFileOrEmpty(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

export type WrittenFile = { path: string; backup?: string };

/**
 * 写文件前先备份原文件为 .bak-<时间戳>(仅非密钥文件用)。
 * 备份为「复制后写原文件」(非 rename):写入失败时原文件仍在原位。
 */
export async function writeWithBackup(filePath: string, content: string, mode?: number): Promise<WrittenFile> {
  await mkdir(path.dirname(filePath), { recursive: true });
  let backup: string | undefined;
  if (existsSync(filePath)) {
    const existing = await readFile(filePath, "utf8");
    backup = `${filePath}.bak-${timestamp()}`;
    await writeFile(backup, existing);
  }
  await writeFile(filePath, content, mode === undefined ? {} : { mode });
  return { path: filePath, backup };
}

/** 写密钥文件(不备份,避免凭据多副本),固定 0600。 */
export async function writeSecretFile(filePath: string, content: string): Promise<string> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, { mode: 0o600 });
  await chmod(filePath, 0o600);
  return filePath;
}

/** 在 .env 风格文本中 upsert 一个 key(纯文本;文件写入方负责 0600)。 */
export function upsertEnvKeyText(text: string, key: string, value: string): { text: string; changed: boolean } {
  const line = `${key}=${JSON.stringify(value)}`;
  const re = new RegExp(`^(?:export\\s+)?${escapeRegExp(key)}\\s*=.*$`, "m");
  if (re.test(text)) {
    const next = text.replace(re, line);
    return { text: next, changed: next !== text };
  }
  return { text: (text.trim() ? text.replace(/\s+$/, "") + "\n" : "") + line + "\n", changed: true };
}

export type BackupInfo = { path: string; name: string; size: number; mtimeMs: number };

/** 列出目标文件的同目录备份(<name>.bak-*),按修改时间倒序。 */
export async function listBackups(targetPath: string): Promise<BackupInfo[]> {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const out: BackupInfo[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(`${base}.bak-`)) continue;
      const p = path.join(dir, entry.name);
      try {
        const st = await stat(p);
        out.push({ path: p, name: entry.name, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // 跳过不可读条目
      }
    }
  } catch {
    // 目录缺失——无备份
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export type RestoredFile = { target: string; backup?: string };

/**
 * 用备份覆盖目标文件。还原前先把当前文件备份为 .bak-pre-restore-<时间戳>,
 * 防止误还原后无法回到还原前状态(双保险)。
 */
export async function restoreBackup(targetPath: string, backupPath: string): Promise<RestoredFile> {
  const content = await readFile(backupPath, "utf8");
  const current = await readFileOrEmpty(targetPath);
  let backup: string | undefined;
  if (current) {
    backup = `${targetPath}.bak-pre-restore-${timestamp()}`;
    await writeFile(backup, current);
  }
  await writeFile(targetPath, content);
  return { target: targetPath, backup };
}
