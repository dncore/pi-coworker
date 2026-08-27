/**
 * 知识源注册表（DESIGN.md §6.2）：knowledge.json 的加载与校验。
 * agent 只能访问登记过的 sourceId——白名单安全边界。
 */
import { loadBundledConfig } from "./config.ts";

export type KnowledgeSourceType = "base" | "wiki" | "doc";

export interface KnowledgeSource {
  id: string;
  type: KnowledgeSourceType;
  name: string;
  description?: string;
  /** base 源 */
  baseToken?: string;
  table?: string;
  searchFields?: string[];
  /** wiki 源 */
  spaceId?: string;
  /** doc 源 */
  url?: string;
  enabled?: boolean;
}

export interface KnowledgeConfig {
  sources: KnowledgeSource[];
}

let cached: KnowledgeConfig | null = null;

export function loadKnowledge(): KnowledgeConfig {
  if (cached) return cached;
  const raw = loadBundledConfig("knowledge");
  const sources = Array.isArray(raw?.sources) ? (raw.sources as KnowledgeSource[]) : [];
  cached = { sources };
  return cached;
}

export function getSource(id: string): KnowledgeSource | undefined {
  return loadKnowledge().sources.find((s) => s.id === id && s.enabled !== false);
}

export function listSources(): KnowledgeSource[] {
  return loadKnowledge().sources.filter((s) => s.enabled !== false);
}

export function validateSource(s: KnowledgeSource): string[] {
  const issues: string[] = [];
  if (!s.id) issues.push("缺少 id");
  if (!s.name) issues.push(`${s.id}: 缺少 name`);
  if (s.type === "base" && !s.baseToken) issues.push(`${s.id}: base 源需要 baseToken`);
  if (s.type === "wiki" && !s.spaceId) issues.push(`${s.id}: wiki 源需要 spaceId`);
  if (s.type === "doc" && !s.url) issues.push(`${s.id}: doc 源需要 url`);
  // 占位符（知识源尚未由管理员填入真实值）视为“未配置”
  if (
    (s.type === "base" && isPlaceholder(s.baseToken)) ||
    (s.type === "wiki" && isPlaceholder(s.spaceId)) ||
    (s.type === "doc" && isPlaceholder(s.url))
  ) {
    issues.push(`${s.id}: 知识源尚未配置真实标识（当前为占位符），不会参与检索`);
  }
  return issues;
}

/** 检测配置占位符（REPLACE / REPLACE_WITH_* / 含 REPLACE 的模板值） */
function isPlaceholder(v?: string): boolean {
  return !v || /replac/i.test(v);
}
