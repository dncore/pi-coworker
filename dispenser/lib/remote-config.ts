// 远端模型配置客户端:URL 解析 / 版本比对 / 拉取 / 严格校验 / 本地缓存
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CompatConfig, InputType, ModelMeta, ThinkingLevel, ThinkingValue } from "./known-models.ts";

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

export type RemoteConfigPayload = {
  version: string;
  models: Record<string, ModelMeta>;
};

export type RemoteConfigCache = {
  version: string;
  fetchedAt: string; // ISO timestamp
  url: string;
  models: Record<string, ModelMeta>;
};

export type RemoteSyncResult =
  | { kind: "disabled" }
  | { kind: "current"; version: string; models: Record<string, ModelMeta> }
  | {
      kind: "updated";
      version: string;
      previousVersion: string | null;
      changedModelIds: string[];
      models: Record<string, ModelMeta>;
    }
  | { kind: "error"; error: string; models: Record<string, ModelMeta> | null };

export type ValidationResult =
  | { ok: true; payload: RemoteConfigPayload }
  | { ok: false; error: string };

const REMOTE_CACHE_PATH = path.join(os.homedir(), ".pi", "agent", "magene-remote-config.json");
// 版本检查超时:默认启用后每次启动都会访问配置服务,超时过久会拖慢启动。
// 局域网正常 ~50ms;2s 覆盖最坏网络情况(DROP 防火墙挂满超时才降级)。
const VERSION_TIMEOUT_MS = 2_000;
// 配置拉取超时:仅在版本变化时触发,可稍长。
const CONFIG_TIMEOUT_MS = 15_000;

// 配置下发服务：默认关闭。
// 原因：服务端（fed 上的 magene-config-server）维护不及时，实际曾长期落后于内置表
// （线上 117 条 vs 仓内 127 条），一启用反而会把旧元数据盖到新表上，
// 表现为上下文窗口 / 思考能力回退（如 glm-5.3 退回 200k/8k/无思考）。
// 模型元数据唯一真源 = lib/known-models.ts；确需远端下发时显式设置：
//   MAGENE_CONFIG_SERVER_URL=http://fed.internal.wonlap.cn:8800
export const DEFAULT_CONFIG_SERVER_URL = "";

// ---------------------------------------------------------------------------
// URL 解析(环境变量 > magene .env 文件;未配置或非法 → null)
// ---------------------------------------------------------------------------

/**
 * 解析配置下发服务地址。
 * 优先级:进程环境变量 > magene .env 文件 > 内置默认(DEFAULT_CONFIG_SERVER_URL)。
 * - 显式设置为空字符串 → 返回 null(显式禁用远端配置)
 * - 未设置 → 返回内置默认（当前默认为空 = 远端下发默认关闭）
 * - 设置非 http(s) 非法值 → 返回 null
 */
export function resolveConfigServerUrl(
  env: Record<string, string | undefined>,
  envFile: Record<string, string | undefined>,
): string | null {
  if (env.MAGENE_CONFIG_SERVER_URL !== undefined) return normalizeConfigServerUrl(env.MAGENE_CONFIG_SERVER_URL);
  if (envFile.MAGENE_CONFIG_SERVER_URL !== undefined) return normalizeConfigServerUrl(envFile.MAGENE_CONFIG_SERVER_URL);
  return normalizeConfigServerUrl(DEFAULT_CONFIG_SERVER_URL);
}

function normalizeConfigServerUrl(raw: string | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null; // 显式空值 = 禁用
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return trimmed.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 严格校验(ModelMeta 层未知字段拒绝;map 内未知键忽略)
// ---------------------------------------------------------------------------

const VALID_MODEL_KEYS = new Set(["contextWindow", "maxTokens", "reasoning", "input", "name", "thinkingLevelMap", "compat", "cost"]);
const VALID_COMPAT_KEYS = new Set(["supportsDeveloperRole", "supportsReasoningEffort", "maxTokensField", "thinkingFormat", "requiresReasoningContentOnAssistantMessages", "reasoningEffortMap"]);
const VALID_INPUT_TYPES = new Set(["text", "image"]);
const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
const VALID_MAX_TOKENS_FIELDS = new Set(["max_completion_tokens", "max_tokens"]);
const VALID_THINKING_FORMATS = new Set(["deepseek", "qwen"]);
const VALID_COST_KEYS = new Set(["input", "output", "cacheRead", "cacheWrite"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}
function isNonNegativeNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

export function validateRemoteConfigPayload(raw: unknown): ValidationResult {
  if (!isPlainObject(raw)) return { ok: false, error: "payload 必须是对象" };
  for (const key of Object.keys(raw)) {
    if (key !== "version" && key !== "models") return { ok: false, error: `payload 含未知字段 "${key}"` };
  }
  if (raw.version !== undefined && typeof raw.version !== "string") return { ok: false, error: "version 必须是字符串" };
  if (!isPlainObject(raw.models)) return { ok: false, error: "models 必须是对象" };

  const models: Record<string, ModelMeta> = {};
  for (const [modelId, rawMeta] of Object.entries(raw.models)) {
    if (!modelId.trim()) return { ok: false, error: "模型 ID 不能为空字符串" };
    if (!isPlainObject(rawMeta)) return { ok: false, error: `models["${modelId}"] 必须是对象` };

    for (const key of Object.keys(rawMeta)) {
      if (!VALID_MODEL_KEYS.has(key)) return { ok: false, error: `models["${modelId}"] 含未知字段 "${key}"` };
    }
    if (!isPositiveInt(rawMeta.contextWindow)) return { ok: false, error: `models["${modelId}"].contextWindow 必须为正整数` };
    if (!isPositiveInt(rawMeta.maxTokens)) return { ok: false, error: `models["${modelId}"].maxTokens 必须为正整数` };

    const meta: ModelMeta = { contextWindow: rawMeta.contextWindow, maxTokens: rawMeta.maxTokens };

    if (rawMeta.reasoning !== undefined) {
      if (typeof rawMeta.reasoning !== "boolean") return { ok: false, error: `models["${modelId}"].reasoning 必须是 boolean` };
      meta.reasoning = rawMeta.reasoning;
    }
    if (rawMeta.input !== undefined) {
      if (!Array.isArray(rawMeta.input) || rawMeta.input.length === 0 || !rawMeta.input.every((t) => typeof t === "string" && VALID_INPUT_TYPES.has(t))) {
        return { ok: false, error: `models["${modelId}"].input 必须是非空 ["text"|"image", ...] 数组` };
      }
      meta.input = [...new Set(rawMeta.input as InputType[])];
    }
    if (rawMeta.name !== undefined) {
      if (typeof rawMeta.name !== "string" || !rawMeta.name.trim()) return { ok: false, error: `models["${modelId}"].name 必须是非空字符串` };
      meta.name = rawMeta.name;
    }
    if (rawMeta.thinkingLevelMap !== undefined) {
      if (!isPlainObject(rawMeta.thinkingLevelMap)) return { ok: false, error: `models["${modelId}"].thinkingLevelMap 必须是对象` };
      const map: Partial<Record<ThinkingLevel, ThinkingValue>> = {};
      for (const [level, value] of Object.entries(rawMeta.thinkingLevelMap)) {
        if (!VALID_THINKING_LEVELS.has(level)) continue; // 未知等级忽略(向前兼容)
        if (value !== null && typeof value !== "string") return { ok: false, error: `models["${modelId}"].thinkingLevelMap["${level}"] 必须是 string|null` };
        map[level as ThinkingLevel] = value as ThinkingValue;
      }
      meta.thinkingLevelMap = map;
    }
    if (rawMeta.compat !== undefined) {
      if (!isPlainObject(rawMeta.compat)) return { ok: false, error: `models["${modelId}"].compat 必须是对象` };
      for (const key of Object.keys(rawMeta.compat)) {
        if (!VALID_COMPAT_KEYS.has(key)) return { ok: false, error: `models["${modelId}"].compat 含未知字段 "${key}"` };
      }
      const compat: CompatConfig = {};
      if (rawMeta.compat.supportsDeveloperRole !== undefined) {
        if (typeof rawMeta.compat.supportsDeveloperRole !== "boolean") return { ok: false, error: `models["${modelId}"].compat.supportsDeveloperRole 必须是 boolean` };
        compat.supportsDeveloperRole = rawMeta.compat.supportsDeveloperRole;
      }
      if (rawMeta.compat.supportsReasoningEffort !== undefined) {
        if (typeof rawMeta.compat.supportsReasoningEffort !== "boolean") return { ok: false, error: `models["${modelId}"].compat.supportsReasoningEffort 必须是 boolean` };
        compat.supportsReasoningEffort = rawMeta.compat.supportsReasoningEffort;
      }
      if (rawMeta.compat.maxTokensField !== undefined) {
        if (typeof rawMeta.compat.maxTokensField !== "string" || !VALID_MAX_TOKENS_FIELDS.has(rawMeta.compat.maxTokensField)) {
          return { ok: false, error: `models["${modelId}"].compat.maxTokensField 必须为 "max_completion_tokens" 或 "max_tokens"` };
        }
        compat.maxTokensField = rawMeta.compat.maxTokensField as "max_completion_tokens" | "max_tokens";
      }
      if (rawMeta.compat.thinkingFormat !== undefined) {
        if (typeof rawMeta.compat.thinkingFormat !== "string" || !VALID_THINKING_FORMATS.has(rawMeta.compat.thinkingFormat)) {
          return { ok: false, error: `models["${modelId}"].compat.thinkingFormat 必须为 "deepseek" 或 "qwen"` };
        }
        compat.thinkingFormat = rawMeta.compat.thinkingFormat as "deepseek" | "qwen";
      }
      if (rawMeta.compat.requiresReasoningContentOnAssistantMessages !== undefined) {
        if (typeof rawMeta.compat.requiresReasoningContentOnAssistantMessages !== "boolean") {
          return { ok: false, error: `models["${modelId}"].compat.requiresReasoningContentOnAssistantMessages 必须是 boolean` };
        }
        compat.requiresReasoningContentOnAssistantMessages = rawMeta.compat.requiresReasoningContentOnAssistantMessages;
      }
      if (rawMeta.compat.reasoningEffortMap !== undefined) {
        if (!isPlainObject(rawMeta.compat.reasoningEffortMap)) return { ok: false, error: `models["${modelId}"].compat.reasoningEffortMap 必须是对象` };
        const map: Record<string, string> = {};
        for (const [k, v] of Object.entries(rawMeta.compat.reasoningEffortMap)) {
          if (typeof v !== "string" || !v) return { ok: false, error: `models["${modelId}"].compat.reasoningEffortMap["${k}"] 必须是非空字符串` };
          map[k] = v;
        }
        compat.reasoningEffortMap = map;
      }
      meta.compat = compat;
    }
    if (rawMeta.cost !== undefined) {
      if (!isPlainObject(rawMeta.cost)) return { ok: false, error: `models["${modelId}"].cost 必须是对象` };
      for (const key of Object.keys(rawMeta.cost)) {
        if (!VALID_COST_KEYS.has(key)) return { ok: false, error: `models["${modelId}"].cost 含未知字段 "${key}"` };
      }
      const cost: NonNullable<ModelMeta["cost"]> = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      for (const key of VALID_COST_KEYS) {
        const v = rawMeta.cost[key];
        if (v === undefined) continue;
        if (!isNonNegativeNumber(v)) return { ok: false, error: `models["${modelId}"].cost.${key} 必须是非负数字` };
        cost[key as keyof NonNullable<ModelMeta["cost"]>] = v;
      }
      meta.cost = cost;
    }

    models[modelId] = meta;
  }

  return { ok: true, payload: { version: typeof raw.version === "string" ? raw.version : "", models } };
}

// ---------------------------------------------------------------------------
// 本地缓存
// ---------------------------------------------------------------------------

export async function readRemoteCache(cachePath: string = REMOTE_CACHE_PATH): Promise<RemoteConfigCache | null> {
  try {
    const raw = await readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw) as RemoteConfigCache;
    if (typeof parsed.version !== "string" || typeof parsed.url !== "string" || !isPlainObject(parsed.models)) return null;
    const validation = validateRemoteConfigPayload({ version: parsed.version, models: parsed.models });
    if (!validation.ok) return null;
    return {
      version: validation.payload.version,
      fetchedAt: typeof parsed.fetchedAt === "string" ? parsed.fetchedAt : "",
      url: parsed.url,
      models: validation.payload.models,
    };
  } catch {
    return null;
  }
}

export async function writeRemoteCache(cache: RemoteConfigCache, cachePath: string = REMOTE_CACHE_PATH): Promise<void> {
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// 网络(带超时)
// ---------------------------------------------------------------------------

async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new Error(`请求超时(${timeoutMs}ms)`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function checkRemoteVersion(url: string, timeoutMs = VERSION_TIMEOUT_MS): Promise<string> {
  const raw = await fetchJsonWithTimeout(`${url.replace(/\/+$/, "")}/version`, timeoutMs);
  if (!isPlainObject(raw) || typeof raw.version !== "string" || !raw.version) throw new Error("/version 响应缺少 version 字段");
  return raw.version;
}

export async function fetchRemoteConfig(url: string, timeoutMs = CONFIG_TIMEOUT_MS): Promise<ValidationResult> {
  const raw = await fetchJsonWithTimeout(`${url.replace(/\/+$/, "")}/config`, timeoutMs);
  return validateRemoteConfigPayload(raw);
}

// ---------------------------------------------------------------------------
// 版本差异(供 /magene-sync 展示)
// ---------------------------------------------------------------------------

export function diffModelMetadata(before: Record<string, ModelMeta>, after: Record<string, ModelMeta>): string[] {
  const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const id of ids) {
    const a = before[id];
    const b = after[id];
    if (!a || !b) {
      changed.push(id);
      continue;
    }
    if (a.contextWindow !== b.contextWindow || a.maxTokens !== b.maxTokens || a.reasoning !== b.reasoning) changed.push(id);
  }
  return changed.sort((x, y) => x.localeCompare(y));
}

// ---------------------------------------------------------------------------
// 同步编排:版本比对 → 拉取 → 校验 → 写缓存
// ---------------------------------------------------------------------------

export async function syncRemoteConfig(
  url: string | null,
  options?: {
    force?: boolean;
    cachePath?: string;
    versionTimeoutMs?: number;
    configTimeoutMs?: number;
    notify?: (msg: string, level: "info" | "warning" | "error") => void;
  },
): Promise<RemoteSyncResult> {
  if (!url) return { kind: "disabled" };
  const cache = await readRemoteCache(options?.cachePath);
  const cacheMatchesUrl = cache && cache.url === url;

  if (!options?.force) {
    try {
      const version = await checkRemoteVersion(url, options?.versionTimeoutMs);
      if (cacheMatchesUrl && cache.version === version) {
        return { kind: "current", version, models: cache.models };
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      if (cacheMatchesUrl) {
        options?.notify?.(`配置服务不可达(${errMsg}),使用缓存版本 ${cache.version}`, "warning");
        return { kind: "current", version: cache.version, models: cache.models };
      }
      options?.notify?.(`配置服务不可达(${errMsg}),使用内置配置`, "warning");
      return { kind: "error", error: errMsg, models: null };
    }
  }

  try {
    const validation = await fetchRemoteConfig(url, options?.configTimeoutMs);
    if (!validation.ok) {
      options?.notify?.(`配置校验失败:${validation.error},保持现有配置`, "warning");
      if (cacheMatchesUrl) return { kind: "current", version: cache.version, models: cache.models };
      return { kind: "error", error: validation.error, models: null };
    }
    const previous = cacheMatchesUrl ? cache : null;
    const changedModelIds = previous
      ? diffModelMetadata(previous.models, validation.payload.models)
      : Object.keys(validation.payload.models).sort((a, b) => a.localeCompare(b)); // 首次拉取:全部视为新增
    const fresh: RemoteConfigCache = {
      version: validation.payload.version,
      fetchedAt: new Date().toISOString(),
      url,
      models: validation.payload.models,
    };
    await writeRemoteCache(fresh, options?.cachePath);
    return {
      kind: "updated",
      version: fresh.version,
      previousVersion: previous?.version ?? null,
      changedModelIds,
      models: fresh.models,
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    options?.notify?.(`配置拉取失败(${errMsg})`, "warning");
    if (cacheMatchesUrl) return { kind: "current", version: cache.version, models: cache.models };
    return { kind: "error", error: errMsg, models: null };
  }
}
