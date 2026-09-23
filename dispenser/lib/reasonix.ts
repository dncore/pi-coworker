// Reasonix 配置管理:provider 接入([[providers]],任意 provider 名)+ [serve] 鉴权
// (生成/关闭固定 Token)。Reasonix 全局配置位于 <Reasonix home>/config.toml
// (macOS/Linux 默认 ~/.reasonix),provider 凭据只写 <Reasonix home>/.env,
// config.toml 仅保存 api_key_env 变量名。

import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";

import {
  applyTextOps,
  escapeRegExp,
  planManagedKeyUpserts,
  readFileOrEmpty,
  timestamp,
} from "./config-io.ts";

/** magene provider 写入 reasonix 时使用的 API Key 环境变量名。 */
export const REASONIX_API_KEY_ENV = "MAGENE_API_KEY";

/** magene 在 reasonix [[providers]] 中的路由名(团队默认)。 */
export const REASONIX_PROVIDER_NAME = "magene";

export function reasonixHome(): string {
  return process.env.REASONIX_HOME ?? path.join(os.homedir(), ".reasonix");
}

/** 生成 URL 安全的随机 Token(32 字节 base64url,无 padding)。 */
export function generateReasonixToken(): string {
  return randomBytes(32).toString("base64url");
}

/** 脱敏展示 token:保留首尾便于辨认。 */
export function maskToken(token: string): string {
  if (token.length <= 10) return "****";
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

export async function readReasonixConfigToml(): Promise<string> {
  return readFileOrEmpty(path.join(reasonixHome(), "config.toml"));
}

export async function writeReasonixConfigToml(text: string): Promise<{ path: string; backup?: string }> {
  const home = reasonixHome();
  await mkdir(home, { recursive: true });
  const cfgPath = path.join(home, "config.toml");
  let backup: string | undefined;
  if (existsSync(cfgPath)) {
    backup = `${cfgPath}.bak-${timestamp()}`;
    await rename(cfgPath, backup);
  }
  await writeFile(cfgPath, text);
  return { path: cfgPath, backup };
}

// ---------------------------------------------------------------------------
// TOML 文本补丁(纯函数)
// ---------------------------------------------------------------------------

/** 定位表头并返回其正文区间:bodyStart 在表头行结束(换行)之后,bodyEnd 为下一表头或 EOF。 */
function locateSection(text: string, headerRe: RegExp): { bodyStart: number; bodyEnd: number } | null {
  const m = text.match(headerRe);
  if (!m || m.index === undefined) return null;
  const lineEnd = text.indexOf("\n", m.index);
  const bodyStart = lineEnd === -1 ? text.length : lineEnd + 1;
  const rest = text.slice(bodyStart);
  const nextHeader = rest.match(/^\s*\[/m);
  const bodyEnd = nextHeader ? bodyStart + nextHeader.index! : text.length;
  return { bodyStart, bodyEnd };
}

/** 取 [section] 段的正文(不含表头,到下一个表头或 EOF)。 */
function extractSection(text: string, section: string): string | null {
  const loc = locateSection(text, new RegExp(`^\\[${escapeRegExp(section)}\\]\\s*$`, "m"));
  return loc ? text.slice(loc.bodyStart, loc.bodyEnd) : null;
}

/** 在 [section] 段内 upsert 一个 key(保留段内其他 key/注释)。 */
function upsertInSection(
  text: string,
  section: string,
  key: string,
  value: string,
): { text: string; changed: boolean } {
  const loc = locateSection(text, new RegExp(`^\\[${escapeRegExp(section)}\\]\\s*$`, "m"));
  if (!loc) return { text, changed: false };
  const body = text.slice(loc.bodyStart, loc.bodyEnd);
  const line = `${key} = ${JSON.stringify(value)}`;
  const keyRe = new RegExp(`^${escapeRegExp(key)}\\s*=.*$`, "m");
  if (keyRe.test(body)) {
    const nextBody = body.replace(keyRe, line);
    if (nextBody === body) return { text, changed: false };
    return { text: text.slice(0, loc.bodyStart) + nextBody + text.slice(loc.bodyEnd), changed: true };
  }
  // 段内无此 key:插入到表头下一行
  return { text: text.slice(0, loc.bodyStart) + line + "\n" + text.slice(loc.bodyStart), changed: true };
}

/** 移除 [section] 段内的 key 行。 */
function removeKeyInSection(text: string, section: string, key: string): { text: string; changed: boolean } {
  const loc = locateSection(text, new RegExp(`^\\[${escapeRegExp(section)}\\]\\s*$`, "m"));
  if (!loc) return { text, changed: false };
  const body = text.slice(loc.bodyStart, loc.bodyEnd);
  const keyRe = new RegExp(`^${escapeRegExp(key)}\\s*=.*$`, "m");
  if (!keyRe.test(body)) return { text, changed: false };
  const nextBody = body
    .replace(keyRe, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "");
  return { text: text.slice(0, loc.bodyStart) + nextBody + text.slice(loc.bodyEnd), changed: true };
}

/** 生成/更新 config.toml 的 [serve] 鉴权段:token 模式(固定 token)或 none(移除 token/password_hash)。 */
export function patchReasonixServeAuth(
  text: string,
  mode: "token" | "none",
  token?: string,
): { text: string; changes: string[] } {
  const hasServe = /^\[serve\]\s*$/m.test(text);
  const changes: string[] = [];

  if (mode === "token") {
    if (!token) throw new Error("token 不能为空");
    if (!hasServe) {
      const block = `[serve]\nauth_mode = "token"\ntoken = ${JSON.stringify(token)}\n`;
      return {
        text: (text.trim() ? text.replace(/\s+$/, "") + "\n\n" : "") + block,
        changes: ["[serve] 段新建:auth_mode = token"],
      };
    }
    let out = text;
    const r1 = upsertInSection(out, "serve", "auth_mode", "token");
    if (r1.changed) changes.push("auth_mode = token");
    out = r1.text;
    const r2 = upsertInSection(out, "serve", "token", token);
    if (r2.changed) changes.push("token = <新生成,固定复用>");
    out = r2.text;
    return { text: out, changes };
  }

  // mode === "none"
  if (!hasServe) return { text, changes }; // 无 [serve] 段 = 默认 none,无需改动
  let out = text;
  const r1 = upsertInSection(out, "serve", "auth_mode", "none");
  if (r1.changed) changes.push("auth_mode = none");
  out = r1.text;
  const r2 = removeKeyInSection(out, "serve", "token");
  if (r2.changed) changes.push("token 已移除");
  out = r2.text;
  const r3 = removeKeyInSection(out, "serve", "password_hash");
  if (r3.changed) changes.push("password_hash 已移除");
  out = r3.text;
  return { text: out, changes };
}

/** 在 [[providers]] 数组中按 name 定位块,返回 [start, end) 区间(不含表头行)。 */
function findProvidersBlock(text: string, name: string): { start: number; end: number } | null {
  for (const m of text.matchAll(/^\[\[providers\]\]\s*$/gm)) {
    const lineEnd = text.indexOf("\n", m.index);
    const bodyStart = lineEnd === -1 ? text.length : lineEnd + 1;
    const rest = text.slice(bodyStart);
    const nextHeader = rest.match(/^\s*\[/m);
    const bodyEnd = nextHeader ? bodyStart + nextHeader.index! : text.length;
    const body = text.slice(bodyStart, bodyEnd);
    const nameRe = new RegExp(`^name\\s*=\\s*["']${escapeRegExp(name)}["']\\s*$`, "m");
    if (nameRe.test(body)) return { start: bodyStart, end: bodyEnd };
  }
  return null;
}

/** provider 块的 TOML 值:普通值走 JSON,数组逗号+空格,raw 原样输出(内联表等)。 */
type ProviderValue = string | string[] | boolean | { raw: string };

function tomlValue(v: ProviderValue): string {
  if (typeof v === "object" && v !== null && !Array.isArray(v)) return (v as { raw: string }).raw;
  if (Array.isArray(v)) return `[${v.map((s) => JSON.stringify(s)).join(", ")}]`;
  return JSON.stringify(v);
}

/** upsert [[providers]] 块内的管理键(块内其他 key、注释与空行原位保留);块不存在则追加新块。 */
function upsertProviderBlock(
  text: string,
  name: string,
  kv: Record<string, ProviderValue>,
): { text: string; changed: boolean } {
  const existing = findProvidersBlock(text, name);
  if (!existing) {
    const header = "[[providers]]\n";
    const body = Object.entries(kv)
      .map(([k, v]) => `${k} = ${tomlValue(v)}`)
      .join("\n");
    const block = header + body + "\n";
    return { text: (text.trim() ? text.replace(/\s+$/, "") + "\n\n" : "") + block, changed: true };
  }

  const ops = planManagedKeyUpserts(
    text,
    { start: existing.start, end: existing.end },
    {
      separator: "=",
      indent: 0,
      keys: Object.entries(kv).map(([k, v]) => ({ key: k, lines: [`${k} = ${tomlValue(v)}`] })),
    },
  );
  const next = applyTextOps(text, ops);
  return { text: next, changed: next !== text };
}

/**
 * 合并 model_overrides 内联表:已有条目的其它键原样保留(context_window 只改数值),
 * 列表外条目移除,新条目追加。
 */
function mergeInlineOverrides(
  oldRaw: string | null,
  entries: Array<[string, number]>,
): string {
  const wanted = new Map(entries);
  const seen = new Set<string>();
  const parts: string[] = [];
  if (oldRaw) {
    for (const m of oldRaw.matchAll(/"((?:[^"\\]|\\.)*)"\s*=\s*\{([^}]*)\}/g)) {
      let id = m[1]!;
      try {
        id = JSON.parse(`"${id}"`) as string;
      } catch {
        // 非法转义——按原样处理
      }
      if (!wanted.has(id) || seen.has(id)) continue;
      seen.add(id);
      const cw = wanted.get(id)!;
      let inner = m[2]!.trim();
      inner = /context_window\s*=/.test(inner)
        ? inner.replace(/context_window\s*=\s*\d+/, `context_window = ${cw}`)
        : inner.length > 0
          ? `context_window = ${cw}, ${inner}`
          : `context_window = ${cw}`;
      parts.push(`${JSON.stringify(id)} = { ${inner} }`);
    }
  }
  for (const [id, cw] of entries) {
    if (!seen.has(id)) parts.push(`${JSON.stringify(id)} = { context_window = ${cw} }`);
  }
  return `{ ${parts.join(", ")} }`;
}

/** 顶层 key upsert(缺失时插到文件头部,同 codex 的 upsertKey)。 */
function upsertTopLevelKey(
  text: string,
  key: string,
  value: string,
): { text: string; changed: boolean } {
  const line = `${key} = ${JSON.stringify(value)}`;
  const re = new RegExp(`^${escapeRegExp(key)}\\s*=.*$`, "m");
  if (re.test(text)) {
    const next = text.replace(re, line);
    return { text: next, changed: next !== text };
  }
  return { text: line + "\n" + text, changed: true };
}

export type ReasonixProviderInput = {
  providerName: string;
  baseUrl: string;
  apiKeyEnv: string;
  modelIds: string[];
  defaultModel?: string;
  modelContexts?: Record<string, number>;
};

/**
 * 生成/更新 config.toml 的 provider 块([[providers]],任意 provider 名)。
 * API Key 由调用方写入全局 .env。modelContexts: id → contextWindow,写入
 * model_overrides 供 reasonix 自动压缩使用。同时保证顶层 default_model 有效
 * (缺失时补 provider 名,指向不存在模型/预设时修正)。
 */
export function patchReasonixProvider(
  text: string,
  input: ReasonixProviderInput,
): { text: string; changes: string[] } {
  const { providerName, baseUrl, apiKeyEnv, modelIds, defaultModel, modelContexts } = input;
  const sorted = [...modelIds].sort((a, b) => a.localeCompare(b));
  const kv: Record<string, ProviderValue> = {
    name: providerName,
    kind: "openai",
    base_url: baseUrl,
    models: sorted,
  };
  const def = defaultModel && modelIds.includes(defaultModel) ? defaultModel : modelIds[0];
  if (def) kv.default = def;
  kv.api_key_env = apiKeyEnv;

  // 每个模型的上下文窗口 → model_overrides(内联表);未知模型继承 provider 级默认
  const knownCtx = modelContexts
    ? Object.entries(modelContexts)
        .filter(([id]) => sorted.includes(id))
        .sort(([a], [b]) => a.localeCompare(b))
    : [];
  if (knownCtx.length > 0) {
    const prevBlock = findProvidersBlock(text, providerName);
    const prevRaw = prevBlock ? text.slice(prevBlock.start, prevBlock.end).match(/^model_overrides\s*=\s*(.*)$/m)?.[1] ?? null : null;
    kv.model_overrides = { raw: mergeInlineOverrides(prevRaw, knownCtx) };
  }

  const existed = Boolean(findProvidersBlock(text, providerName));
  const r = upsertProviderBlock(text, providerName, kv);
  let out = r.text;
  const changes = r.changed
    ? [
        `[[providers]] ${providerName} ${existed ? "已更新" : "已新增"}` +
          `(${sorted.length} 个模型, default=${def ?? "无"}, api_key_env=${apiKeyEnv})`,
      ]
    : [];
  if (knownCtx.length > 0 && r.changed) {
    changes.push(`model_overrides 已写入(${knownCtx.length} 个模型的 context_window)`);
  }

  // 顶层 default_model 缺失时必须补上:定义 [[providers]] 会替换内置预设,
  // 缺省模型 deepseek-flash 变成 unknown,reasonix serve/交互启动直接报错。
  if (!/^default_model\s*=.*$/m.test(out)) {
    const dm = upsertTopLevelKey(out, "default_model", providerName);
    out = dm.text;
    if (dm.changed) changes.push(`default_model = "${providerName}"(指向 provider 默认模型 ${def ?? "无"})`);
  }

  // default_model 有效性校验:指向不存在模型/已被替换的内置预设时修正为 provider 名。
  // 合法形式:provider 名(本 provider 或 config 里已有的 [[providers]] 名)、
  // provider/model(<provider>/<模型>,模型须在对应 provider 列表内)、列表内的裸模型名。
  const dmVal = out.match(/^default_model\s*=\s*"([^"]+)"/m)?.[1] ?? null;
  if (dmVal) {
    const [provPart, modelPart] = dmVal.split("/");
    const valid =
      dmVal === providerName ||
      sorted.includes(dmVal) ||
      Boolean(findProvidersBlock(out, dmVal)) ||
      (modelPart !== undefined &&
        (provPart === providerName ? sorted.includes(modelPart) : Boolean(findProvidersBlock(out, provPart))));
    if (!valid) {
      const fix = upsertTopLevelKey(out, "default_model", providerName);
      out = fix.text;
      if (fix.changed) changes.push(`default_model = "${providerName}"(原 "${dmVal}" 指向不存在的模型/预设)`);
    }
  }

  if (changes.length === 0) return { text, changes: [] };
  return { text: out, changes };
}

/**
 * 「仅更新模型列表」:只刷新既有 [[providers]] 块的 models 与 model_overrides
 * (model_overrides 内条目的其它键保留),base_url / api_key_env / default / 顶层 default_model
 * 一概不动。块不存在时 providerFound=false。
 */
export function patchReasonixModels(
  text: string,
  opts: { providerName: string; modelIds: string[]; modelContexts?: Record<string, number> },
): { text: string; changes: string[]; providerFound: boolean } {
  const block = findProvidersBlock(text, opts.providerName);
  if (!block) return { text, changes: [], providerFound: false };
  const sorted = [...opts.modelIds].sort((a, b) => a.localeCompare(b));
  if (sorted.length === 0) return { text, changes: [], providerFound: true };

  const kv: Record<string, ProviderValue> = { models: sorted };
  const knownCtx = opts.modelContexts
    ? Object.entries(opts.modelContexts)
        .filter(([id]) => sorted.includes(id))
        .sort(([a], [b]) => a.localeCompare(b))
    : [];
  if (knownCtx.length > 0) {
    const prevRaw = text.slice(block.start, block.end).match(/^model_overrides\s*=\s*(.*)$/m)?.[1] ?? null;
    kv.model_overrides = { raw: mergeInlineOverrides(prevRaw, knownCtx) };
  }

  const r = upsertProviderBlock(text, opts.providerName, kv);
  const changes: string[] = [];
  if (r.changed) {
    changes.push(`models 已更新(${sorted.length} 个模型)`);
    if (knownCtx.length > 0) changes.push(`model_overrides 已同步(${knownCtx.length} 个 context_window)`);
  }
  return { text: r.text, changes, providerFound: true };
}

/** 在 Reasonix 全局 .env 中 upsert 一个 key(文件 0600)。 */
export async function upsertReasonixEnvKey(key: string, value: string): Promise<{ changed: boolean; path: string }> {
  const envPath = path.join(reasonixHome(), ".env");
  const text = await readFileOrEmpty(envPath);
  const keyRe = new RegExp(`^(?:export\\s+)?${escapeRegExp(key)}\\s*=.*$`, "m");
  const line = `${key}=${JSON.stringify(value)}`;
  let next: string;
  let changed: boolean;
  if (keyRe.test(text)) {
    next = text.replace(keyRe, line);
    changed = next !== text;
  } else {
    next = (text.trim() ? text.replace(/\s+$/, "") + "\n" : "") + line + "\n";
    changed = true;
  }
  if (!changed) return { changed: false, path: envPath };
  await mkdir(path.dirname(envPath), { recursive: true });
  await writeFile(envPath, next, { mode: 0o600 });
  return { changed: true, path: envPath };
}

// ---------------------------------------------------------------------------
// 状态诊断
// ---------------------------------------------------------------------------

export type ReasonixServeStatus = {
  reasonixHome: string;
  configExists: boolean;
  authMode: string | null;
  tokenSet: boolean;
  tokenMasked: string | null;
  passwordHashSet: boolean;
  behindProxy: boolean;
  providerConfigured: boolean;
  providerModels: number;
  providerDefault: string | null;
  providerApiKeyEnv: string | null;
  providerKeyInEnvFile: boolean;
};

/** 读取 reasonix 当前配置与鉴权状态(只读诊断;providerName 默认 magene 团队配置)。 */
export async function reasonixStatus(
  providerName: string = REASONIX_PROVIDER_NAME,
): Promise<ReasonixServeStatus> {
  const home = reasonixHome();
  const cfgText = await readReasonixConfigToml();
  const envText = await readFileOrEmpty(path.join(home, ".env"));

  const serve = extractSection(cfgText, "serve");
  const tokenRaw = serve?.match(/^token\s*=\s*"([^"]*)"/m)?.[1] ?? null;
  const authMode = serve?.match(/^auth_mode\s*=\s*"([^"]+)"/m)?.[1] ?? null;

  const providerBlock = findProvidersBlock(cfgText, providerName);
  const providerBlockText = providerBlock ? cfgText.slice(providerBlock.start, providerBlock.end) : "";
  const providerApiKeyEnv = providerBlockText.match(/^api_key_env\s*=\s*"([^"]+)"/m)?.[1] ?? null;
  const modelsMatch = providerBlockText.match(/^models\s*=\s*\[(.*?)\]/ms)?.[1];
  const providerModels = modelsMatch
    ? modelsMatch.split(",").map((s) => s.trim()).filter((s) => s.length > 0).length
    : 0;

  return {
    reasonixHome: home,
    configExists: existsSync(path.join(home, "config.toml")),
    authMode,
    tokenSet: Boolean(tokenRaw),
    tokenMasked: tokenRaw ? maskToken(tokenRaw) : null,
    passwordHashSet: Boolean(serve?.match(/^password_hash\s*=/m)),
    behindProxy: /^behind_proxy\s*=\s*true/m.test(serve ?? ""),
    providerConfigured: Boolean(providerBlock),
    providerModels,
    providerDefault: providerBlockText.match(/^default\s*=\s*"([^"]+)"/m)?.[1] ?? null,
    providerApiKeyEnv,
    providerKeyInEnvFile: providerApiKeyEnv
      ? new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?${escapeRegExp(providerApiKeyEnv)}\\s*=`).test(envText)
      : false,
  };
}
