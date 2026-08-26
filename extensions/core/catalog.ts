/**
 * 权限目录（DESIGN.md §4）：catalog.json 的加载与校验。
 * agent 只能申请目录中登记的权限 id——这是白名单安全边界。
 */
import { loadBundledConfig } from "./config.ts";

export type GrantStrategy = "self-service" | "approval" | "owner-request";

export interface CatalogPermission {
  id: string;
  name: string;
  description?: string;
  /** wiki-space | drive-doc | drive-folder | position | ... */
  type: string;
  grant: GrantStrategy;
  // self-service
  spaceId?: string;
  url?: string;
  token?: string;
  targetType?: string;
  memberRole?: "member" | "admin";
  memberType?: string;
  perm?: string;
  /** 执行直授时的身份（默认 bot） */
  as?: "user" | "bot";
  // approval
  approvalKeyword?: string;
  approvalCode?: string;
  formTemplate?: Array<{ name: string; value: string }>;
  // 仅允许特定角色申请（空 = 不限）
  needsApprovalRole?: string[];
}

export interface Catalog {
  permissions: CatalogPermission[];
}

let cached: Catalog | null = null;

export function loadCatalog(): Catalog {
  if (cached) return cached;
  const raw = loadBundledConfig("catalog");
  const perms = Array.isArray(raw?.permissions) ? (raw.permissions as CatalogPermission[]) : [];
  cached = { permissions: perms };
  return cached;
}

export function getPermission(id: string): CatalogPermission | undefined {
  return loadCatalog().permissions.find((p) => p.id === id);
}

export function listPermissions(): CatalogPermission[] {
  return loadCatalog().permissions;
}

/** 占位符判定：管理员没填真实值（示例/模板标记） */
const PLACEHOLDER_RE = /(REPLACE_|<|your-|your_|example|示例)/i;

/** 校验一条目录记录是否自洽（不抛错；返回问题列表） */
export function validatePermission(p: CatalogPermission): string[] {
  const issues: string[] = [];
  if (!p.id) issues.push("缺少 id");
  if (!p.name) issues.push(`${p.id}: 缺少 name`);
  if (!p.grant) issues.push(`${p.id}: 缺少 grant`);
  if (p.grant === "self-service" && !p.spaceId && !p.url && !p.token) {
    issues.push(`${p.id}: self-service 需要 spaceId 或 url/token`);
  }
  if (p.spaceId && PLACEHOLDER_RE.test(String(p.spaceId))) issues.push(`${p.id}: spaceId 是占位符（${p.spaceId}），请管理员填写真实值`);
  if (p.url && PLACEHOLDER_RE.test(String(p.url))) issues.push(`${p.id}: url 是占位符，请管理员填写真实值`);
  if (p.token && PLACEHOLDER_RE.test(String(p.token))) issues.push(`${p.id}: token 是占位符，请管理员填写真实值`);
  if (p.grant === "approval" && !p.approvalCode && !p.approvalKeyword) {
    issues.push(`${p.id}: approval 需要 approvalCode 或 approvalKeyword`);
  }
  if (p.grant === "owner-request" && !p.url && !p.token) {
    issues.push(`${p.id}: owner-request 需要 url 或 token`);
  }
  return issues;
}
