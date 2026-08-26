/**
 * magene —— 模型网关（LLM provider）鉴权与注册模块。
 *
 * 能力同步自公司内部 magene-provider 插件的「鉴权生成」部分，开源化：
 *   - 凭证管理：`~/.pi/agent/extensions/magene-provider/.env`（MAGENE_BASE_URL / MAGENE_API_KEY，0600）
 *   - 模型发现：`GET {baseUrl}/models`（Authorization: Bearer <key>）
 *   - provider 注册：`pi.registerProvider("magene", …)`（api: openai-completions, authHeader: true）
 *   - 模型元数据降级：用户 override > 内置已知表 > 正则推断 > 默认值
 *
 * 脱敏约束（本文件供开源）：
 *   - 不硬编码任何公司内网地址；默认 Base URL 为占位符，由部署方通过
 *     环境变量 / setup 输入覆盖。
 *   - 不包含公司专属模型列表 / 远端配置下发地址；远端下发为可选扩展点。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 默认网关地址占位符：部署方替换为真实地址（环境变量 MAGENE_BASE_URL 或 setup 输入优先）。 */
export const DEFAULT_MAGENE_BASE_URL = "https://<your-magene-gateway>/api/v1";

/** 与 magene-provider 插件共用的凭证文件（两扩展共存不冲突） */
export const MAGENE_PROVIDER_DIR = join(homedir(), ".pi", "agent", "extensions", "magene-provider");
export const MAGENE_ENV_PATH = join(MAGENE_PROVIDER_DIR, ".env");

/** 用户级模型元数据覆盖文件（最高优先级） */
export const MAGENE_OVERRIDES_PATH = join(homedir(), ".pi", "agent", "magene-model-overrides.json");

export interface MageneModelMeta {
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  compat?: Record<string, unknown>;
  thinkingLevelMap?: Record<string, string | null>;
}

export interface MageneConfig {
  baseUrl: string;
  apiKey: string;
  /** 配置来源：env（环境变量）/ file（.env 文件）/ default */
  baseUrlSource: "env" | "file" | "default";
  apiKeySource: "env" | "file" | "default" | "missing";
}

/** 简单 .env 解析（与 magene-provider 同构，支持 # 注释与引号） */
export function parseDotEnv(filePath: string): Record<string, string> {
  try {
    const raw = readFileSync(filePath, "utf8");
    const result: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

/** 解析当前生效的 magene 配置：环境变量 > .env 文件 > 默认占位符 */
export function resolveMageneConfig(env: NodeJS.ProcessEnv = process.env): MageneConfig {
  const envFile = parseDotEnv(MAGENE_ENV_PATH);
  const baseUrl = env.MAGENE_BASE_URL ?? envFile.MAGENE_BASE_URL ?? DEFAULT_MAGENE_BASE_URL;
  const apiKey = env.MAGENE_API_KEY ?? envFile.MAGENE_API_KEY ?? "";
  return {
    baseUrl,
    apiKey,
    baseUrlSource: env.MAGENE_BASE_URL ? "env" : envFile.MAGENE_BASE_URL ? "file" : "default",
    apiKeySource: env.MAGENE_API_KEY ? "env" : envFile.MAGENE_API_KEY ? "file" : "missing",
  };
}

/** 读取 .env 中已保存的凭证（用于 setup 预填） */
export function readMageneEnv(): { baseUrl: string; apiKey: string } | null {
  const envFile = parseDotEnv(MAGENE_ENV_PATH);
  const baseUrl = envFile.MAGENE_BASE_URL?.trim();
  const apiKey = envFile.MAGENE_API_KEY?.trim();
  if (baseUrl || apiKey) return { baseUrl: baseUrl || DEFAULT_MAGENE_BASE_URL, apiKey: apiKey || "" };
  return null;
}

/** 写入凭证到 .env（文件 0600；保持与 magene-provider 插件同一格式） */
export function writeMageneEnv(baseUrl: string, apiKey: string): void {
  mkdirSync(MAGENE_PROVIDER_DIR, { recursive: true });
  const content = [
    "# Magene Provider Configuration",
    `MAGENE_BASE_URL=${baseUrl}`,
    `MAGENE_API_KEY=${apiKey}`,
    "",
  ].join("\n");
  writeFileSync(MAGENE_ENV_PATH, content, { mode: 0o600 });
}

/** 读取用户级模型元数据覆盖文件 */
export function loadMageneOverrides(): Record<string, MageneModelMeta> {
  try {
    const raw = readFileSync(MAGENE_OVERRIDES_PATH, "utf8");
    const parsed = JSON.parse(raw) as { models?: Record<string, MageneModelMeta> };
    return parsed.models ?? {};
  } catch {
    return {};
  }
}

/** 拉取网关模型列表（Bearer 鉴权；返回模型 ID 数组，失败抛错） */
export async function fetchMageneModels(baseUrl: string, apiKey: string, timeoutMs = 15_000): Promise<string[]> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
    }
    const payload = (await response.json()) as Array<{ id?: string }> | { data?: Array<{ id?: string }> };
    const rows = Array.isArray(payload) ? payload : payload.data ?? [];
    return [...new Set(rows.map((row) => row.id).filter((id): id is string => Boolean(id)))].sort((a, b) =>
      a.localeCompare(b),
    );
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 模型元数据：内置已知表（通用开源模型）→ 正则推断 → 默认值
// ---------------------------------------------------------------------------

const DEEPSEEK_COMPAT: Record<string, unknown> = {
  thinkingFormat: "deepseek",
  requiresReasoningContentOnAssistantMessages: true,
  maxTokensField: "max_tokens",
};

const QWEN_COMPAT: Record<string, unknown> = {
  thinkingFormat: "qwen",
  supportsReasoningEffort: true,
};

const KNOWN_MODELS: Record<string, MageneModelMeta> = {
  "deepseek-chat": { contextWindow: 128000, maxTokens: 8192, reasoning: false, compat: DEEPSEEK_COMPAT },
  "deepseek-coder": { contextWindow: 128000, maxTokens: 8192, reasoning: false, compat: DEEPSEEK_COMPAT },
  "deepseek-reasoner": { contextWindow: 131072, maxTokens: 32768, reasoning: true, compat: DEEPSEEK_COMPAT },
  "deepseek-v3": { contextWindow: 128000, maxTokens: 8192, reasoning: false, compat: DEEPSEEK_COMPAT },
  "deepseek-r1": {
    contextWindow: 131072,
    maxTokens: 32768,
    reasoning: true,
    compat: { ...DEEPSEEK_COMPAT, supportsReasoningEffort: true, reasoningEffortMap: { minimal: "high", low: "high", medium: "high", high: "high", xhigh: "max" } },
  },
  "qwen-max": { contextWindow: 32768, maxTokens: 8192, reasoning: true, compat: QWEN_COMPAT },
  "qwen-plus": { contextWindow: 32768, maxTokens: 8192, reasoning: true, compat: QWEN_COMPAT },
  "qwen-turbo": { contextWindow: 32768, maxTokens: 8192, reasoning: true, compat: QWEN_COMPAT },
  "glm-4": { contextWindow: 131072, maxTokens: 8192, reasoning: false },
  "doubao-pro": { contextWindow: 128000, maxTokens: 16384, reasoning: true },
  "doubao-lite": { contextWindow: 128000, maxTokens: 16384, reasoning: false },
  "moonshot-v1-8k": { contextWindow: 8192, maxTokens: 4096, reasoning: false },
  "moonshot-v1-32k": { contextWindow: 32768, maxTokens: 8192, reasoning: false },
  "moonshot-v1-128k": { contextWindow: 128000, maxTokens: 16384, reasoning: false },
};

const DEFAULT_META: MageneModelMeta = { contextWindow: 128000, maxTokens: 16384, reasoning: false };

/** 按模型 ID 推断元数据：override > 已知表 > 正则 > 默认 */
export function resolveModelMeta(id: string, overrides: Record<string, MageneModelMeta> = loadMageneOverrides()): MageneModelMeta {
  const fromOverride = overrides[id];
  if (fromOverride) return { ...DEFAULT_META, ...fromOverride };
  const known = KNOWN_MODELS[id];
  if (known) return known;

  const low = id.toLowerCase();
  if (/r1|reasoner/.test(low))
    return { contextWindow: 131072, maxTokens: 32768, reasoning: true, compat: DEEPSEEK_COMPAT };
  if (low.startsWith("deepseek"))
    return { contextWindow: 128000, maxTokens: 8192, reasoning: false, compat: DEEPSEEK_COMPAT };
  if (low.startsWith("qwen")) return { contextWindow: 32768, maxTokens: 8192, reasoning: true, compat: QWEN_COMPAT };
  if (low.startsWith("glm")) return { contextWindow: 131072, maxTokens: 8192, reasoning: false };
  if (low.startsWith("doubao")) return { contextWindow: 128000, maxTokens: 16384, reasoning: low.includes("1.5") };
  if (/^(claude|gpt|gemini)/.test(low)) return { contextWindow: 200000, maxTokens: 16384, reasoning: true };
  return DEFAULT_META;
}

export type ModelSource = "override" | "known" | "inferred" | "default";

export interface ResolvedModel {
  id: string;
  name: string;
  source: ModelSource;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  compat?: Record<string, unknown>;
}

/** 把模型 ID 列表解析为注册用的模型定义 */
export function buildResolvedModels(ids: string[]): ResolvedModel[] {
  const overrides = loadMageneOverrides();
  return ids.map((id) => {
    const meta = resolveModelMeta(id, overrides);
    const source: ModelSource = overrides[id] ? "override" : KNOWN_MODELS[id] ? "known" : meta === DEFAULT_META ? "default" : "inferred";
    return {
      id,
      name: id,
      source,
      contextWindow: meta.contextWindow,
      maxTokens: meta.maxTokens,
      reasoning: meta.reasoning,
      compat: meta.compat,
    };
  });
}

// ---------------------------------------------------------------------------
// provider 注册
// ---------------------------------------------------------------------------

let activePi: ExtensionAPI | null = null;

/** 记住扩展实例（onboarding 集群注册工具时调用） */
export function bindPi(pi: ExtensionAPI): void {
  activePi = pi;
}

/** 当前是否已注册 magene provider */
export function mageneProviderRegistered(): boolean {
  return activePi !== null;
}

/** 注册/更新 magene provider（models 为空则注销） */
export function registerMageneProvider(baseUrl: string, apiKey: string, modelIds: string[]): void {
  if (!activePi) return;
  activePi.unregisterProvider("magene");
  if (modelIds.length === 0) return;
  const resolved = buildResolvedModels(modelIds);
  activePi.registerProvider("magene", {
    name: "Magene",
    baseUrl,
    apiKey,
    authHeader: true,
    api: "openai-completions",
    models: resolved.map((m) => ({
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      compat: m.compat,
    })),
  });
}

/** 注销 magene provider */
export function unregisterMageneProvider(): void {
  if (!activePi) return;
  activePi.unregisterProvider("magene");
}

// ---------------------------------------------------------------------------
// 状态诊断
// ---------------------------------------------------------------------------

export interface MageneStatus {
  baseUrl: string;
  baseUrlSource: MageneConfig["baseUrlSource"];
  apiKeyConfigured: boolean;
  apiKeySource: MageneConfig["apiKeySource"];
  envFileExists: boolean;
  providerRegistered: boolean;
  lastError?: string;
}

/** 诊断状态（不含密钥明文） */
export async function mageneStatus(timeoutMs = 15_000): Promise<MageneStatus> {
  const cfg = resolveMageneConfig();
  const status: MageneStatus = {
    baseUrl: cfg.baseUrl,
    baseUrlSource: cfg.baseUrlSource,
    apiKeyConfigured: Boolean(cfg.apiKey),
    apiKeySource: cfg.apiKeySource,
    envFileExists: existsSync(MAGENE_ENV_PATH),
    // 注意：activePi 仅在 pi 子进程内设置；本函数常被 GUI 后端（另一进程）调用，
    // 故跨进程查不到真实注册状态。改为“配置就绪”语义：凭证+URL 已落盘，pi 子进程加载扩展时会自动注册。
    providerRegistered: Boolean(cfg.apiKey) && cfg.baseUrlSource !== "default",
  };
  if (cfg.apiKey && cfg.baseUrlSource !== "default") {
    try {
      await fetchMageneModels(cfg.baseUrl, cfg.apiKey, timeoutMs);
    } catch (e: any) {
      status.lastError = e?.message ?? String(e);
    }
  }
  return status;
}
