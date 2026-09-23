// Grok Build(grok CLI)配置管理:通过 [model_providers.<name>] + 每模型 [model.<id>] 块
// 把任意 OpenAI 兼容网关接入 grok-build。配置位于 <Grok home>/config.toml
// (macOS/Linux 默认 ~/.grok,可用 GROK_HOME 覆盖)。
//
// 鉴权形态:API Key 写入 [model_providers.<name>].api_key(明文,与 Codex 分支
// experimental_bearer_token 同一先例)。官方文档推荐 env_key,但 grok 不加载
// home 级 .env,env_key 依赖 shell 环境变量不持久,故弃用。
// grok 鉴权优先级:per-model api_key/env_key > 会话 token > XAI_API_KEY,
// 因此已 grok login 的用户无需 logout——自定义模型全走网关 key,官方 grok 模型
// 继续走官方通道(混合模式,/model 随时切换)。
//
// ⚠️ TOML 点号陷阱:含点号的模型 ID 必须用引号键 [model."glm-5.3"]——裸键
// [model.glm-5.3] 会被 TOML 解析成嵌套表,模型直接不可用(实测 "unknown model id")。

import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  applyTextOps,
  escapeRegExp,
  planManagedKeyUpserts,
  preserveTrailingBlanks,
  readFileOrEmpty,
  timestamp,
  type ManagedKey,
  type TextOp,
} from "./config-io.ts";

/** magene 在 grok-build [model_providers.<name>] 中的路由名(团队默认)。 */
export const GROK_BUILD_PROVIDER_NAME = "magene";

/** magene 分支默认模型(chat_completions 形态可用;与 Codex 分支的 /responses 特例互不影响)。 */
export const GROK_BUILD_DEFAULT_MODEL = "deepseek-v4-flash";

export function grokBuildHome(): string {
  return process.env.GROK_HOME ?? path.join(os.homedir(), ".grok");
}

export async function readGrokBuildConfigToml(): Promise<string> {
  return readFileOrEmpty(path.join(grokBuildHome(), "config.toml"));
}

export async function writeGrokBuildConfigToml(text: string): Promise<{ path: string; backup?: string }> {
  const home = grokBuildHome();
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

/** 在 PATH 中查找 grok CLI(不执行任何命令,纯文件系统检查)。 */
export function findGrokCli(): string | null {
  const names = process.platform === "win32" ? ["grok.cmd", "grok.exe", "grok"] : ["grok"];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir.trim()) continue;
    for (const name of names) {
      const full = path.join(dir, name);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// TOML 文本补丁(纯函数)
// ---------------------------------------------------------------------------

/** 段落正文结束位:遇到下一表头或 EOF;但截掉正文尾部的空行,只保留最后一个换行
 *  (否则整段替换会连带吃掉表头间的空行,破坏幂等)。 */
function sectionBodyEnd(text: string, bodyStart: number, bodyEnd: number): number {
  let cursor = bodyEnd;
  while (cursor > bodyStart && text.charCodeAt(cursor - 1) === 10) cursor--;
  if (cursor === bodyEnd) return bodyEnd; // 尾部无换行——原样
  return Math.min(cursor + 1, bodyEnd);
}

/** 定位表头并返回其正文区间(bodyStart 在表头行后,bodyEnd 为下一表头或 EOF,含尾部一个换行)。 */
function locateSection(text: string, headerRe: RegExp): { bodyStart: number; bodyEnd: number } | null {
  const m = text.match(headerRe);
  if (!m || m.index === undefined) return null;
  const lineEnd = text.indexOf("\n", m.index);
  const bodyStart = lineEnd === -1 ? text.length : lineEnd + 1;
  const rest = text.slice(bodyStart);
  const nextHeader = rest.match(/^\s*\[/m);
  const bodyEnd = nextHeader ? bodyStart + nextHeader.index! : text.length;
  return { bodyStart, bodyEnd: sectionBodyEnd(text, bodyStart, bodyEnd) };
}

/** TOML 表头键:非裸键(如含点号的 "glm-5.3")必须加引号,否则点被解析成嵌套表。 */
function tomlKey(id: string): string {
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : JSON.stringify(id);
}

const MODEL_HEADER_RE = /^\[model\.([^\]]+)\]\s*$/gm;
const MODELS_SECTION_RE = /^\[models\]\s*$/m;

type ModelBlock = {
  key: string;
  provider: string | null;
  start: number;
  bodyStart: number;
  bodyEnd: number;
};

/** 扫描全部 [model.<key>] 块:键去引号,provider 为其体内 model_provider 值(无则 null)。 */
function scanModelBlocks(text: string): ModelBlock[] {
  const blocks: ModelBlock[] = [];
  for (const m of text.matchAll(MODEL_HEADER_RE)) {
    if (m.index === undefined) continue;
    const rawKey = m[1]!.trim();
    let key: string;
    if (rawKey.startsWith('"') && rawKey.endsWith('"')) {
      try {
        key = JSON.parse(rawKey) as string;
      } catch {
        continue; // 非法引号键——跳过,不做任何处理
      }
    } else {
      key = rawKey;
    }
    const lineEnd = text.indexOf("\n", m.index);
    const bodyStart = lineEnd === -1 ? text.length : lineEnd + 1;
    const rest = text.slice(bodyStart);
    const nextHeader = rest.match(/^\[/m);
    const bodyEnd = sectionBodyEnd(text, bodyStart, nextHeader ? bodyStart + nextHeader.index! : text.length);
    const body = text.slice(bodyStart, bodyEnd);
    const provider = body.match(/^model_provider\s*=\s*"([^"]+)"/m)?.[1] ?? null;
    blocks.push({ key, provider, start: m.index, bodyStart, bodyEnd });
  }
  return blocks;
}

export type GrokBuildModel = {
  id: string;
  contextWindow: number;
  maxTokens: number;
};

export type GrokBuildPatchInput = {
  providerName: string;
  /** 展示名后缀(写入每个模型块的 name,如 "magene")。 */
  label: string;
  baseUrl: string;
  apiKey: string;
  defaultModel?: string;
  models: GrokBuildModel[];
};

/** 一个模型块的管理键(model/id 为身份行;max_completion_tokens 为 0 时移除)。 */
function modelBlockManagedKeys(m: GrokBuildModel, label: string, providerName: string): ManagedKey[] {
  return [
    { key: "model", lines: [`model = ${JSON.stringify(m.id)}`] },
    { key: "name", lines: [`name = ${JSON.stringify(`${m.id} (${label})`)}`] },
    { key: "model_provider", lines: [`model_provider = ${JSON.stringify(providerName)}`] },
    { key: "context_window", lines: [`context_window = ${m.contextWindow}`] },
    { key: "max_completion_tokens", lines: m.maxTokens > 0 ? [`max_completion_tokens = ${m.maxTokens}`] : null },
  ];
}

/** [model_providers.<name>] 段的管理键。 */
function providerSectionKeys(baseUrl: string, apiKey: string): ManagedKey[] {
  return [
    { key: "base_url", lines: [`base_url = ${JSON.stringify(baseUrl)}`] },
    { key: "api_backend", lines: [`api_backend = "chat_completions"`] },
    { key: "api_key", lines: [`api_key = ${JSON.stringify(apiKey)}`] },
  ];
}

/** 一个模型块的规范文本(含表头,尾随换行)。 */
function renderModelBlock(m: GrokBuildModel, label: string, providerName: string): string {
  const lines = [`[model.${tomlKey(m.id)}]`];
  for (const k of modelBlockManagedKeys(m, label, providerName)) if (k.lines) lines.push(...k.lines);
  return lines.join("\n") + "\n";
}

type ModelBlocksResult = { text: string; changes: string[] };

/**
 * 按 id 合并模型块:自有块只 upsert 管理键(块内用户键保留),陈旧自有块移除,
 * 新块追加(同 key 属于其他 provider 的块保留并跳过,避免 TOML 重复段)。
 */
function applyModelBlocks(
  text: string,
  providerName: string,
  label: string,
  sorted: GrokBuildModel[],
): ModelBlocksResult {
  const changes: string[] = [];
  const blocks = scanModelBlocks(text);
  const liveIds = new Set(sorted.map((m) => m.id));
  const ours = blocks.filter((b) => b.provider === providerName);
  const stale = ours.filter((b) => !liveIds.has(b.key));
  const sameKeyUserBlocks = sorted.filter((m) =>
    blocks.some((b) => b.key === m.id && b.provider !== null && b.provider !== providerName),
  );

  const ops: TextOp[] = [];
  for (const b of stale) {
    ops.push({
      start: b.start,
      end: b.bodyEnd,
      replacement: preserveTrailingBlanks(text, { bodyStart: b.bodyStart, end: b.bodyEnd }),
    });
  }
  for (const m of sorted) {
    const own = ours.find((b) => b.key === m.id);
    if (!own) continue;
    ops.push(
      ...planManagedKeyUpserts(
        text,
        { start: own.bodyStart, end: own.bodyEnd },
        { separator: "=", indent: 0, keys: modelBlockManagedKeys(m, label, providerName) },
      ),
    );
  }
  let out = applyTextOps(text, ops);

  const appended = sorted.filter((m) => !blocks.some((b) => b.key === m.id));
  if (appended.length > 0) {
    out = out.replace(/\s+$/, "") + "\n\n" + appended.map((m) => renderModelBlock(m, label, providerName)).join("\n");
    changes.push(`写入 ${appended.length} 个模型块([model.<id>],含 context_window)`);
  }
  if (stale.length > 0) changes.push(`移除 ${stale.length} 个陈旧模型块(已不在网关模型列表)`);
  if (sameKeyUserBlocks.length > 0) {
    changes.push(`跳过 ${sameKeyUserBlocks.length} 个模型(如 ${sameKeyUserBlocks[0].id}):config 已有同 key 其他 provider 块,保留用户配置`);
  }
  return { text: out, changes };
}

/**
 * 生成/更新 grok-build config.toml(magene 或自定义网关):
 * - [model_providers.<name>] 块:base_url + api_backend(chat_completions)+ api_key(明文,同 Codex 先例);
 *   只 upsert 这三个管理键,段内用户键保留
 * - [models].default = 默认模型(段内其他键保留;缺段时追加)
 * - 每个网关模型一个 [model.<id>] 块(含点号 ID 自动加引号键),model_provider 指向本 provider,
 *   带上 context_window / max_completion_tokens;已有自有块只改管理键,块内用户键保留
 * - 只接管 model_provider 属于本 provider 的块:陈旧块移除;key 相同但属于用户的块保留并跳过
 *   (避免 TOML 重复段);其他 [model.*] 块与顶层键原样不动
 */
export function patchGrokBuildConfigToml(
  text: string,
  input: GrokBuildPatchInput,
): { text: string; changes: string[] } {
  const { providerName, label, baseUrl, apiKey, defaultModel, models } = input;
  const sorted = [...models].sort((a, b) => a.id.localeCompare(b.id));
  if (sorted.length === 0) return { text, changes: [] };

  const changes: string[] = [];
  const liveIds = new Set(sorted.map((m) => m.id));

  // 1) 模型块:按 id 合并/新增/移除
  const merged = applyModelBlocks(text, providerName, label, sorted);
  let out = merged.text;

  // 2) [model_providers.<name>] 段:已有段只 upsert 管理键,段内用户键保留
  const providerSection = locateSection(out, new RegExp(`^\\[model_providers\\.${escapeRegExp(providerName)}\\]\\s*$`, "m"));
  if (providerSection) {
    const next = applyTextOps(
      out,
      planManagedKeyUpserts(
        out,
        { start: providerSection.bodyStart, end: providerSection.bodyEnd },
        { separator: "=", indent: 0, keys: providerSectionKeys(baseUrl, apiKey) },
      ),
    );
    if (next !== out) {
      changes.push(`[model_providers.${providerName}] 已更新(base_url + api_key)`);
      out = next;
    }
  } else {
    const providerBody = providerSectionKeys(baseUrl, apiKey).map((k) => k.lines![0]).join("\n") + "\n";
    out = (out.trim() ? out.replace(/\s+$/, "") + "\n\n" : "") + `[model_providers.${providerName}]\n${providerBody}`;
    changes.push(`[model_providers.${providerName}] 已新增(base_url + api_key)`);
  }

  // 3) [models].default:段内 upsert,缺段时追加
  const def = defaultModel && liveIds.has(defaultModel) ? defaultModel : sorted[0].id;
  const defaultLine = `default = ${JSON.stringify(def)}`;
  const defaultKeyRe = new RegExp(`^default\\s*=.*$`, "m");
  const modelsSection = locateSection(out, MODELS_SECTION_RE);
  if (modelsSection) {
    const body = out.slice(modelsSection.bodyStart, modelsSection.bodyEnd);
    if (!defaultKeyRe.test(body)) {
      out = out.slice(0, modelsSection.bodyStart) + defaultLine + "\n" + out.slice(modelsSection.bodyStart);
      changes.push(`默认模型 = "${def}"`);
    } else if (!new RegExp(`^default\\s*=\\s*${JSON.stringify(def)}\\s*$`, "m").test(body)) {
      out = out.slice(0, modelsSection.bodyStart) + body.replace(defaultKeyRe, defaultLine) + out.slice(modelsSection.bodyEnd);
      changes.push(`默认模型 = "${def}"`);
    }
  } else {
    out = (out.trim() ? out.replace(/\s+$/, "") + "\n\n" : "") + `[models]\n${defaultLine}\n`;
    changes.push(`默认模型 = "${def}"`);
  }

  changes.push(...merged.changes);
  return { text: out, changes };
}

/**
 * 「仅更新模型列表」:只合并 [model.<id>] 块;provider 段(base_url/api_key)与
 * [models] 其他键一概不动。仅当 [models].default 指向的模型已不在新列表时修正。
 * 未接入(无 [model_providers.<name>] 段)时 providerFound=false。
 */
export function patchGrokBuildModels(
  text: string,
  input: { providerName: string; label: string; models: GrokBuildModel[] },
): { text: string; changes: string[]; providerFound: boolean } {
  const providerRe = escapeRegExp(input.providerName);
  const providerFound = locateSection(text, new RegExp(`^\\[model_providers\\.${providerRe}\\]\\s*$`, "m")) !== null;
  if (!providerFound) return { text, changes: [], providerFound: false };

  const sorted = [...input.models].sort((a, b) => a.id.localeCompare(b.id));
  if (sorted.length === 0) return { text, changes: [], providerFound: true };
  const liveIds = new Set(sorted.map((m) => m.id));
  const merged = applyModelBlocks(text, input.providerName, input.label, sorted);
  let out = merged.text;
  const changes = [...merged.changes];

  const modelsSection = locateSection(out, MODELS_SECTION_RE);
  if (modelsSection) {
    const body = out.slice(modelsSection.bodyStart, modelsSection.bodyEnd);
    const current = body.match(/^default\s*=\s*"([^"]+)"/m)?.[1] ?? null;
    if (current && !liveIds.has(current)) {
      const def = sorted[0]!.id;
      out = out.slice(0, modelsSection.bodyStart) + body.replace(/^default\s*=.*$/m, `default = ${JSON.stringify(def)}`) + out.slice(modelsSection.bodyEnd);
      changes.push(`默认模型 = "${def}"(原 "${current}" 已不在列表)`);
    }
  }
  return { text: out, changes, providerFound: true };
}

// ---------------------------------------------------------------------------
// 状态诊断
// ---------------------------------------------------------------------------

/** 脱敏展示 api_key:保留首尾便于辨认。 */
export function maskApiKey(key: string | null | undefined): string | null {
  if (!key) return null;
  if (key.length <= 10) return "****";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

export type GrokBuildStatus = {
  grokBuildHome: string;
  configExists: boolean;
  cliPath: string | null;
  authJsonExists: boolean;
  providerConfigured: boolean;
  providerBaseUrl: string | null;
  providerApiKeySet: boolean;
  providerApiKeyMasked: string | null;
  providerModels: number;
  defaultModel: string | null;
};

/** 读取 grok-build 当前配置状态(只读诊断;providerName 默认 magene 团队配置)。 */
export async function grokBuildStatus(providerName: string = GROK_BUILD_PROVIDER_NAME): Promise<GrokBuildStatus> {
  const home = grokBuildHome();
  const cfgPath = path.join(home, "config.toml");
  const cfgText = await readFileOrEmpty(cfgPath);
  const providerRe = escapeRegExp(providerName);

  const providerBlock = locateSection(cfgText, new RegExp(`^\\[model_providers\\.${providerRe}\\]\\s*$`, "m"));
  const providerBody = providerBlock ? cfgText.slice(providerBlock.bodyStart, providerBlock.bodyEnd) : "";
  const apiKey = providerBody.match(/^api_key\s*=\s*"([^"]*)"/m)?.[1] ?? null;
  const modelsSection = locateSection(cfgText, MODELS_SECTION_RE);
  const modelsBody = modelsSection ? cfgText.slice(modelsSection.bodyStart, modelsSection.bodyEnd) : "";

  return {
    grokBuildHome: home,
    configExists: existsSync(cfgPath),
    cliPath: findGrokCli(),
    authJsonExists: existsSync(path.join(home, "auth.json")),
    providerConfigured: Boolean(providerBlock),
    providerBaseUrl: providerBody.match(/^base_url\s*=\s*"([^"]+)"/m)?.[1] ?? null,
    providerApiKeySet: Boolean(apiKey),
    providerApiKeyMasked: maskApiKey(apiKey),
    providerModels: scanModelBlocks(cfgText).filter((b) => b.provider === providerName).length,
    defaultModel: modelsBody.match(/^default\s*=\s*"([^"]+)"/m)?.[1] ?? null,
  };
}