// 自定义网关(任意 OpenAI 兼容 base_url + api_key)的凭证存储与模型拉取。
// 凭证存 ~/.pi/agent/custom-providers.json(文件 0600,含 API Key):
// 该目录不受插件升级/重装影响(scripts/install.js 只保留插件目录内的 .env),
// 与 magene-model-overrides.json 等插件属主文件同级。

import { chmod, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readFileOrEmpty } from "./config-io.ts";

export type CustomProviderConfig = {
  /** provider 路由名(slug,写入各 agent 配置的 key)。 */
  name: string;
  /** 展示名(默认与 name 相同)。 */
  displayName: string;
  baseUrl: string;
  apiKey: string;
  /** Anthropic 兼容端点(Claude Code 用);留空时从 baseUrl 自动推导。 */
  anthropicBaseUrl: string;
  /** 默认模型 id(setup 向导选定;各 agent 配置写入默认模型)。 */
  defaultModel: string;
  /** Codex 向导勾选的模型 id(持久记忆,下次进入默认勾选)。 */
  codexModels: string[];
};

type CustomProviderFile = {
  version: 1;
  provider: CustomProviderConfig;
};

export const CUSTOM_PROVIDERS_PATH = path.join(os.homedir(), ".pi", "agent", "custom-providers.json");

/** 由 provider 名派生凭据环境变量名(对齐 dsh 官方 deriveKeyRef 规则)。 */
export function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

/** 校验/规范化 provider 路由名:小写 slug,保留字母数字-_。空/非法/与 magene 冲突时报错。 */
export function normalizeProviderName(input: string): string {
  const name = input.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) {
    throw new Error("provider 名必须以字母或数字开头,仅含小写字母/数字/-/_(最长 32 字符)");
  }
  if (name === "magene") {
    throw new Error("provider 名不能是 magene(团队网关保留名)");
  }
  return name;
}

export async function loadCustomProvider(): Promise<CustomProviderConfig | null> {
  const raw = await readFileOrEmpty(CUSTOM_PROVIDERS_PATH);
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CustomProviderFile>;
    const p = parsed.provider;
    if (!p || typeof p.name !== "string" || typeof p.baseUrl !== "string" || typeof p.apiKey !== "string") {
      return null;
    }
    return {
      name: p.name,
      displayName: p.displayName || p.name,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      anthropicBaseUrl: typeof p.anthropicBaseUrl === "string" ? p.anthropicBaseUrl : "",
      defaultModel: typeof p.defaultModel === "string" ? p.defaultModel : "",
      codexModels: Array.isArray(p.codexModels) ? p.codexModels.filter((id): id is string => typeof id === "string") : [],
    };
  } catch {
    return null;
  }
}

/** 保存自定义网关凭证(文件 0600,不备份——含密钥,避免多副本)。 */
export async function saveCustomProvider(cfg: CustomProviderConfig): Promise<string> {
  const doc: CustomProviderFile = { version: 1, provider: cfg };
  await mkdir(path.dirname(CUSTOM_PROVIDERS_PATH), { recursive: true });
  await writeFile(CUSTOM_PROVIDERS_PATH, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  await chmod(CUSTOM_PROVIDERS_PATH, 0o600);
  return CUSTOM_PROVIDERS_PATH;
}

// ---------------------------------------------------------------------------
// 网关模型拉取(通用 OpenAI 兼容 /models)
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 15_000;

async function fetchWithTimeout(url: string, init?: RequestInit & { timeoutMs?: number }): Promise<Response> {
  const timeoutMs = init?.timeoutMs ?? FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return response;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 从 OpenAI 兼容网关拉取模型 id 列表(去重 + 字母序)。 */
export async function fetchModelIds(baseUrl: string, apiKey: string): Promise<string[]> {
  const response = await fetchWithTimeout(`${baseUrl.replace(/\/$/, "")}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch models: ${response.status} ${await response.text()}`);
  }

  const payload = (await response.json()) as Array<{ id?: string }> | { data?: Array<{ id?: string }> };
  const rows = Array.isArray(payload) ? payload : payload.data ?? [];
  return [...new Set(rows.map((row) => row.id).filter((id): id is string => Boolean(id)))].sort((a, b) => a.localeCompare(b));
}

/** 默认模型选择:已配置的优先;否则取网关内常见的 deepseek-v4-flash,再退回第一个。 */
export function pickDefaultModel(modelIds: string[], configured?: string): string {
  if (configured && modelIds.includes(configured)) return configured;
  if (modelIds.includes("deepseek-v4-flash")) return "deepseek-v4-flash";
  return modelIds[0] ?? "";
}
