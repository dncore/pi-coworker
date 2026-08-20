/**
 * 公司技能同步（从已登记知识源拉取管理员维护的 skill 到本地）。
 *
 * 安全（DESIGN.md §5）：
 * - 只允许 knowledge.json 中带 skillSync 配置的知识源（管理员白名单）。
 * - 同步目标默认 ~/.coworker/skills，由资源 discover 动态加载。
 * - 写入本地磁盘前必须经过 confirmWrite。
 */
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { listBaseRecords, recordValue } from "./base.ts";
import { listSources } from "./knowledge.ts";
import { loadUserConfig } from "./config.ts";
import type { KnowledgeSource } from "./knowledge.ts";

export interface SkillSyncConfig {
  /** Base 表名/ID */
  table?: string;
  /** 技能名（ASCII，符合 skill 命名规则） */
  nameField: string;
  /** 技能正文（markdown） */
  contentField: string;
  /** 描述 */
  descriptionField?: string;
  /** 启用开关字段；值为空/否/false/0/停用 时跳过 */
  enabledField?: string;
  /** 目标目录（默认 ~/.coworker/skills） */
  targetDir?: string;
}

export interface SkillSpec {
  name: string;
  description: string;
  body: string;
}

export function companySkillsDir(cfg = loadUserConfig()): string {
  const dir = cfg.clusters?.skillsDir as string | undefined;
  return dir ? expandHome(dir) : join(homedir(), ".coworker", "skills");
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/** 已登记且带 skillSync 的知识源（白名单） */
export function skillSyncSources(): Array<KnowledgeSource & { skillSync: SkillSyncConfig }> {
  return listSources().filter((s): s is KnowledgeSource & { skillSync: SkillSyncConfig } => Boolean((s as any).skillSync));
}

export function getSkillSyncSource(id: string): (KnowledgeSource & { skillSync: SkillSyncConfig }) | undefined {
  return skillSyncSources().find((s) => s.id === id);
}

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** 校验 skill 名（pi 命名规则：小写字母数字连字符，1-64，无前导/尾随/连续连字符） */
export function sanitizeSkillName(name: string): string | null {
  const n = String(name ?? "").trim().toLowerCase();
  if (!SKILL_NAME_RE.test(n)) return null;
  if (n.startsWith("-") || n.endsWith("-") || n.includes("--")) return null;
  return n;
}

function enabledValue(v: string): boolean {
  const t = String(v ?? "").trim().toLowerCase();
  if (!t) return true; // 未填视为启用
  return !["否", "false", "0", "停用", "no", "disabled", "off"].includes(t);
}

/** 从 base 知识源读取技能清单 */
export async function fetchSkillsFromBase(
  source: KnowledgeSource & { skillSync: SkillSyncConfig },
): Promise<{ specs: SkillSpec[]; skipped: string[] }> {
  const baseToken = source.baseToken ?? "";
  const table = source.skillSync.table ?? source.table ?? "";
  if (!baseToken || !table) throw new Error(`知识源「${source.name}」缺少 baseToken 或 skillSync.table`);

  const { records, nameToId } = await listBaseRecords(baseToken, table);
  const specs: SkillSpec[] = [];
  const skipped: string[] = [];

  for (const rec of records) {
    const rawName = recordValue(rec, nameToId, source.skillSync.nameField);
    const name = sanitizeSkillName(rawName);
    if (!name) {
      skipped.push(`「${rawName || "(无名)"}」名称不合法，跳过（需小写字母数字连字符）`);
      continue;
    }
    if (source.skillSync.enabledField) {
      const flag = recordValue(rec, nameToId, source.skillSync.enabledField);
      if (!enabledValue(flag)) {
        skipped.push(`「${name}」未启用，跳过`);
        continue;
      }
    }
    const body = recordValue(rec, nameToId, source.skillSync.contentField);
    if (!body.trim()) {
      skipped.push(`「${name}」内容为空，跳过`);
      continue;
    }
    const description =
      (source.skillSync.descriptionField ? recordValue(rec, nameToId, source.skillSync.descriptionField) : "") ||
      `公司技能库「${source.name}」技能`;
    specs.push({ name, description, body });
  }
  return { specs, skipped };
}

export interface SyncPlan {
  toCreate: SkillSpec[];
  toUpdate: Array<SkillSpec & { reason: string }>;
  unchanged: string[];
  skipped: string[];
}

/** 对比目标目录，生成同步计划（不写盘） */
export function planSkillSync(specs: SkillSpec[], targetDir: string): SyncPlan {
  const plan: SyncPlan = { toCreate: [], toUpdate: [], unchanged: [], skipped: [] };
  if (!existsSync(targetDir)) {
    plan.toCreate = [...specs];
    return plan;
  }
  const existing = readdirSync(targetDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  for (const spec of specs) {
    if (!existing.includes(spec.name)) {
      plan.toCreate.push(spec);
      continue;
    }
    const file = join(targetDir, spec.name, "SKILL.md");
    const prev = existsSync(file) ? readFileSync(file, "utf8") : "";
    const next = renderSkillFile(spec);
    if (prev.trim() === next.trim()) plan.unchanged.push(spec.name);
    else plan.toUpdate.push({ ...spec, reason: "内容已变化" });
  }
  return plan;
}

export function renderSkillFile(spec: SkillSpec): string {
  return [
    "---",
    `name: ${spec.name}`,
    `description: ${spec.description}`,
    "---",
    "",
    spec.body.trim(),
    "",
  ].join("\n");
}

/** 写入技能到目标目录 */
export function writeSkills(specs: SkillSpec[], targetDir: string): string[] {
  const written: string[] = [];
  for (const spec of specs) {
    const dir = join(targetDir, spec.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), renderSkillFile(spec), "utf8");
    written.push(spec.name);
  }
  return written;
}

/** 列出目标目录已加载的公司技能名 */
export function listLocalSkills(targetDir: string): string[] {
  if (!existsSync(targetDir)) return [];
  return readdirSync(targetDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(targetDir, e.name, "SKILL.md")))
    .map((e) => e.name);
}
