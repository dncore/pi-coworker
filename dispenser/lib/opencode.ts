// OpenCode 配置:写入 ~/.config/opencode/opencode.json(provider 块 + 默认 model)
// + ~/.local/share/opencode/auth.json(密钥,0600)。
// 纯函数,不做文件 I/O。格式对齐 opencode 官方 config schema(ConfigProviderV1):
//   provider.<id>: { name, npm: "@ai-sdk/openai-compatible", options: { baseURL }, models: { "<id>": { name? } } }
// 密钥走官方凭据存储 auth.json(opencode auth login 同款):
//   { "<id>": { "type": "api", "key": "..." } }(opencode 源码 auth/index.ts 的 Api schema)。
// 移植自 axon-llm-dispenser src/core/opencode.ts。

import type { ResolvedModel } from "./model-resolution.ts";

/** opencode 对 OpenAI 兼容网关的内建 adapter。 */
const PROVIDER_NPM = "@ai-sdk/openai-compatible";

export type OpenCodeProviderInput = {
  providerName: string;
  displayName: string;
  baseUrl: string;
  models: ResolvedModel[];
  /** 默认模型 id(写顶层 model: <provider>/<id>)。 */
  defaultModel: string;
};

function parseDoc(text: string, path: string): Record<string, unknown> {
  if (!text.trim()) return {};
  try {
    const doc = JSON.parse(text);
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new Error("不是对象");
    return doc;
  } catch (e) {
    throw new Error(`${path} 不是合法 JSON: ${e instanceof Error ? e.message : e}`);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 按 id 合并模型表:已有条目只改管理字段(name),条目内用户加的其它字段保留。 */
function mergeModelEntries(
  prevModels: unknown,
  models: ResolvedModel[],
): Record<string, Record<string, unknown>> {
  const prev = isPlainObject(prevModels) ? prevModels : {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const m of models) {
    const entry: Record<string, unknown> = isPlainObject(prev[m.id]) ? { ...(prev[m.id] as Record<string, unknown>) } : {};
    // 模型 key 必须是网关 API 接受的 model 字段值;显示名与 id 不同才写 name
    if (m.name && m.name !== m.id) entry.name = m.name;
    else delete entry.name;
    out[m.id] = entry;
  }
  return out;
}

/** 合并写 opencode.json 的 provider.<name> 块与顶层 model(保留其它 provider、顶层键与 provider 内用户键)。 */
export function patchOpenCodeConfig(
  text: string,
  input: OpenCodeProviderInput,
): { text: string; changes: string[] } {
  const doc = parseDoc(text, "~/.config/opencode/opencode.json");
  const providers = (doc.provider ?? {}) as Record<string, unknown>;
  const prevRaw = providers[input.providerName];
  const existing = prevRaw !== undefined;
  const prev = isPlainObject(prevRaw) ? prevRaw : {};
  const prevOptions = isPlainObject(prev.options) ? prev.options : {};

  providers[input.providerName] = {
    ...prev,
    name: input.displayName,
    npm: PROVIDER_NPM,
    options: { ...prevOptions, baseURL: input.baseUrl },
    models: mergeModelEntries(prev.models, input.models),
  };
  doc.provider = providers;

  const model = input.defaultModel ? `${input.providerName}/${input.defaultModel}` : "";
  const changes: string[] = [];
  if (!existing) {
    changes.push(`新增 provider ${input.providerName}`);
  } else {
    changes.push(`更新 provider ${input.providerName}`);
  }
  changes.push(`baseURL=${input.baseUrl}`);
  changes.push(`${input.models.length} 个模型`);
  if (model && doc.model !== model) {
    changes.push(`model=${model}`);
    doc.model = model;
  }

  return { text: JSON.stringify(doc, null, 2) + "\n", changes };
}

/**
 * 「仅更新模型列表」:只刷新既有 provider.<name>.models(条目内用户字段保留),
 * provider 元数据(name/npm/options)与顶层 model 一概不动。未配置时 providerFound=false。
 */
export function patchOpenCodeModels(
  text: string,
  opts: { providerName: string; models: ResolvedModel[] },
): { text: string; changes: string[]; providerFound: boolean } {
  const doc = parseDoc(text, "~/.config/opencode/opencode.json");
  const providers = (doc.provider ?? {}) as Record<string, unknown>;
  const prevRaw = providers[opts.providerName];
  if (!isPlainObject(prevRaw)) return { text, changes: [], providerFound: false };
  providers[opts.providerName] = { ...prevRaw, models: mergeModelEntries(prevRaw.models, opts.models) };
  doc.provider = providers;
  return {
    text: JSON.stringify(doc, null, 2) + "\n",
    changes: [`models 已更新(${opts.models.length} 个模型)`],
    providerFound: true,
  };
}

/** 合并写 auth.json 的 <providerName> 凭据(api 类型,保留其它条目与 OAuth 结构)。 */
export function patchOpenCodeAuth(
  text: string,
  providerName: string,
  apiKey: string,
): { text: string; changes: string[] } {
  const doc = parseDoc(text, "~/.local/share/opencode/auth.json");
  const existing = doc[providerName];
  const entry =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>), type: "api", key: apiKey }
      : { type: "api", key: apiKey };
  doc[providerName] = entry;
  const changes: string[] = [];
  if (existing) {
    changes.push(`更新凭据 ${providerName}`);
  } else {
    changes.push(`新增凭据 ${providerName}`);
  }
  return { text: JSON.stringify(doc, null, 2) + "\n", changes };
}

export type OpenCodeStatus = {
  configExists: boolean;
  authExists: boolean;
  providerConfigured: boolean;
  providerBaseUrl: string | null;
  providerModels: number;
  keySet: boolean;
  model: string | null;
};

/** 从 opencode.json / auth.json 文本解析状态(纯)。 */
export function parseOpenCodeStatus(configText: string, authText: string, providerName: string): OpenCodeStatus {
  const configExists = configText.trim().length > 0;
  const authExists = authText.trim().length > 0;
  let providerConfigured = false;
  let providerBaseUrl: string | null = null;
  let providerModels = 0;
  let model: string | null = null;
  try {
    const doc = JSON.parse(configText) as Record<string, unknown>;
    if (typeof doc.model === "string") model = doc.model;
    const providers = (doc.provider ?? {}) as Record<
      string,
      { options?: { baseURL?: unknown }; models?: Record<string, unknown> }
    >;
    const p = providers[providerName];
    if (p) {
      providerConfigured = true;
      providerBaseUrl = typeof p.options?.baseURL === "string" ? p.options.baseURL : null;
      providerModels = Object.keys(p.models ?? {}).length;
    }
  } catch {
    // 非 JSON 视为未配置
  }
  let keySet = false;
  try {
    const auth = JSON.parse(authText) as Record<string, { key?: unknown }>;
    const k = auth[providerName]?.key;
    keySet = typeof k === "string" && k.length > 0;
  } catch {
    // 非 JSON 视为未配置
  }
  return { configExists, authExists, providerConfigured, providerBaseUrl, providerModels, keySet, model };
}
