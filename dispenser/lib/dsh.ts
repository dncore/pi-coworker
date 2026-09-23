// DeepSeek Harness (dsh) 配置管理:provider 接入(官方配置规范,任意 provider 名)。
// dsh 官方配置位于 <dsh home>/settings.yaml(默认 ~/.dsh,可用 $DSH_HOME 覆盖),
// 真实密钥只写 <dsh home>/.credentials.yaml(文件 0600),settings.yaml 仅保存
// apiKeyEnv 引用变量名。见 https://github.com/deepseek-ai/deepseek-harness
// docs/user/guide/providers.md 与 packages/llm/llm-pi-ai/README.md。

import { existsSync } from "node:fs";
import { chmod, mkdir, rename, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  applyTextOps,
  blockBodyEnd,
  findKeyInRegion,
  headerHasInlineContent,
  lineAfter,
  planManagedKeyUpserts,
  preserveTrailingBlanks,
  readFileOrEmpty,
  scanYamlListItems,
  timestamp,
  trailingBlankStart,
  unquoteYaml,
  yamlQuote,
  escapeRegExp,
  type ManagedKey,
  type TextOp,
} from "./config-io.ts";

/** magene provider 写入 dsh 时使用的 API Key 环境变量名(引用,不写真实密钥到 settings.yaml)。 */
export const DSH_API_KEY_ENV = "MAGENE_API_KEY";

/** dsh settings.yaml 中 magene 的 provider 路由名(providers 字典的 key)。 */
export const DSH_PROVIDER_NAME = "magene";

/** dsh Web UI 默认地址(webserver 默认 127.0.0.1:3080)。 */
export const DSH_WEB_URL = "http://127.0.0.1:3080";

/** 启动 dsh Web UI 的推荐命令(npm 安装方式)。 */
export const DSH_WEB_COMMAND = "npx @deepseek-ai/dsh web";

const DSH_NAMESPACE = "llm-pi-ai";
const DSH_PROVIDERS_KEY = "providers";
const DSH_API = "openai-completions";

/** 写入 dsh 模型目录的单个模型条目。 */
export type DshModelEntry = {
  id: string;
  /** 显示名;与 id 相同时可省略。 */
  name?: string;
  contextWindow: number;
  maxTokens: number;
  reasoning?: boolean;
  /** pi-ai 思考等级 → 线上拼写(level → wire spelling);off 用空串表示「发送 nothing」。 */
  reasoningEfforts?: Record<string, string | null>;
  /** 输入模态;仅当包含 image 时需要显式声明(官方默认 [text])。 */
  input?: string[];
};

export type DshProviderInput = {
  providerName: string;
  displayName: string;
  apiKeyEnv: string;
  baseUrl: string;
  models: DshModelEntry[];
};

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

/** 解析 dsh home:显式 $DSH_HOME(非空白)优先,否则 ~/.dsh;支持 ~ 前缀展开。 */
export function dshHome(): string {
  const fromEnv = process.env.DSH_HOME;
  const selected =
    fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : path.join(os.homedir(), ".dsh");
  if (selected === "~") return os.homedir();
  if (selected.startsWith("~/") || selected.startsWith("~\\")) {
    return path.join(os.homedir(), selected.slice(2));
  }
  return path.resolve(selected);
}

/** 在 PATH 中查找 dsh CLI(不执行任何命令,纯文件系统检查)。 */
export function findDshCli(): string | null {
  const names = process.platform === "win32" ? ["dsh.cmd", "dsh.exe", "dsh"] : ["dsh"];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir.trim()) continue;
    for (const name of names) {
      const full = path.join(dir, name);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

export async function readDshSettingsYaml(): Promise<string> {
  return readFileOrEmpty(path.join(dshHome(), "settings.yaml"));
}

export async function readDshCredentialsYaml(): Promise<string> {
  return readFileOrEmpty(path.join(dshHome(), ".credentials.yaml"));
}

async function ensureDshHome(): Promise<string> {
  const home = dshHome();
  await mkdir(home, { recursive: true, mode: 0o700 });
  return home;
}

/** 写入 settings.yaml(非密钥文件,写入前自动备份为 settings.yaml.bak-<时间戳>;权限 0600)。 */
export async function writeDshSettings(text: string): Promise<{ path: string; backup?: string }> {
  const home = await ensureDshHome();
  const settingsPath = path.join(home, "settings.yaml");
  let backup: string | undefined;
  if (existsSync(settingsPath)) {
    backup = `${settingsPath}.bak-${timestamp()}`;
    await rename(settingsPath, backup);
  }
  await writeFile(settingsPath, text, { mode: 0o600 });
  await chmod(settingsPath, 0o600);
  return { path: settingsPath, backup };
}

/** 写入 .credentials.yaml(密钥文件,不备份;权限 0600,dsh 在 POSIX 上拒绝任何 group/other 位)。 */
export async function writeDshCredentials(text: string): Promise<{ path: string }> {
  const home = await ensureDshHome();
  const credPath = path.join(home, ".credentials.yaml");
  await writeFile(credPath, text, { mode: 0o600 });
  await chmod(credPath, 0o600);
  return { path: credPath };
}

// ---------------------------------------------------------------------------
// settings.yaml 补丁
// ---------------------------------------------------------------------------

/** 推理等级的规范展示顺序(与 pi-ai 等级集一致)。 */
const LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** 模型条目的管理子键(reasoningEfforts/input 不适用时移除,避免残留旧元数据)。 */
function modelItemManagedKeys(itemIndent: number, m: DshModelEntry): ManagedKey[] {
  const sp = " ".repeat(itemIndent + 2);
  const efforts = m.reasoning && m.reasoningEfforts ? m.reasoningEfforts : undefined;
  const effortLines: string[] | null = (() => {
    if (!efforts) return null;
    const entries = Object.entries(efforts).sort(([a], [b]) => LEVEL_ORDER.indexOf(a) - LEVEL_ORDER.indexOf(b));
    if (entries.length === 0) return null;
    const out = [`${sp}reasoningEfforts:`];
    for (const [level, wire] of entries) {
      out.push(`${sp}  ${level}:${wire == null || wire === "" ? "" : ` ${yamlQuote(wire)}`}`);
    }
    return out;
  })();
  return [
    { key: "name", lines: m.name && m.name !== m.id ? [`${sp}name: ${yamlQuote(m.name)}`] : null },
    { key: "contextWindow", lines: [`${sp}contextWindow: ${m.contextWindow}`] },
    { key: "maxTokens", lines: [`${sp}maxTokens: ${m.maxTokens}`] },
    { key: "reasoningEfforts", lines: effortLines, block: true },
    { key: "input", lines: m.input && m.input.includes("image") ? [`${sp}input: [text, image]`] : null },
  ];
}

/** 渲染单个模型条目(itemIndent 为 `- id:` 行的缩进)。 */
function renderModelItemLines(itemIndent: number, m: DshModelEntry): string[] {
  const sp = " ".repeat(itemIndent);
  const out = [`${sp}- id: ${yamlQuote(m.id)}`];
  for (const k of modelItemManagedKeys(itemIndent, m)) {
    if (k.lines) out.push(...k.lines);
  }
  return out;
}

/** 渲染 `models:` 键行 + 全部条目(provider 缩进;条目缩进 +4)。 */
function renderModelsLines(providerIndent: number, models: DshModelEntry[]): string[] {
  const keyLine = `${" ".repeat(providerIndent + 2)}models:`;
  const out = [keyLine];
  for (const m of models) out.push(...renderModelItemLines(providerIndent + 4, m));
  return out;
}

/** provider 块标量键(displayName / apiKeyEnv / api / baseURL)。 */
function providerScalarKeys(indent: number, opts: DshProviderInput): ManagedKey[] {
  const sp = " ".repeat(indent + 2);
  return [
    { key: "displayName", lines: [`${sp}displayName: ${yamlQuote(opts.displayName)}`] },
    { key: "apiKeyEnv", lines: [`${sp}apiKeyEnv: ${yamlQuote(opts.apiKeyEnv)}`] },
    { key: "api", lines: [`${sp}api: ${DSH_API}`] },
    { key: "baseURL", lines: [`${sp}baseURL: ${yamlQuote(opts.baseUrl)}`] },
  ];
}

/** DeepSeek 方言条件键(compat 子块 + route 级 reasoning)。仅网关含 DeepSeek 系模型时写入;
 *  纯 qwen/claude 等网关写错方言会导致请求 400,因此不适用时返回 null(存在则移除)。 */
function providerConditionalKeys(indent: number, models: DshModelEntry[]): ManagedKey[] {
  const pad = (n: number) => " ".repeat(indent + n);
  const hasDeepseek = models.some((m) => /deepseek/i.test(m.id));
  if (!hasDeepseek) {
    return [
      { key: "compat", lines: null, block: true },
      { key: "reasoning", lines: null },
    ];
  }
  // route 级 reasoning:部署默认思考档位。缺省时请求不带 reasoningEffort,
  // pi-ai 的 thinkingFormat=deepseek 分支不发 thinking 开关,模型走非思考模式、
  // 不返回 reasoning_content,多轮工具调用后网关 400。
  return [
    { key: "compat", lines: [`${pad(2)}compat:`, `${pad(4)}thinkingFormat: deepseek`], block: true },
    { key: "reasoning", lines: [`${pad(2)}reasoning: high`] },
  ];
}

/** provider 块整块(表头行 `<name>:` + 子内容),indent 为 provider 的缩进。 */
function renderProviderBlock(indent: number, opts: DshProviderInput): string[] {
  const header = " ".repeat(indent) + opts.providerName + ":";
  const keys = [...providerScalarKeys(indent, opts), ...providerConditionalKeys(indent, opts.models)];
  const children: string[] = [];
  for (const k of keys) if (k.lines) children.push(...k.lines);
  children.push(...renderModelsLines(indent, opts.models));
  return [header, ...children];
}

/** 定位 llm-pi-ai.providers.<name> 块;返回其表头行与体区间。 */
export function locateProviderBlock(
  text: string,
  providerName: string,
): { headerStart: number; headerEnd: number; bodyStart: number; bodyEnd: number; indent: number } | null {
  const llm = findKeyInRegion(text, 0, text.length, DSH_NAMESPACE, 0);
  if (!llm) return null;
  const llmBodyStart = lineAfter(text, llm.end);
  const llmBodyEnd = blockBodyEnd(text, llmBodyStart, llm.indent, text.length);
  const prov = findKeyInRegion(text, llmBodyStart, llmBodyEnd, DSH_PROVIDERS_KEY);
  if (!prov) return null;
  const provBodyStart = lineAfter(text, prov.end);
  const provBodyEnd = blockBodyEnd(text, provBodyStart, prov.indent, llmBodyEnd);
  const provider = findKeyInRegion(text, provBodyStart, provBodyEnd, providerName);
  if (!provider) return null;
  const bodyStart = lineAfter(text, provider.end);
  const bodyEnd = blockBodyEnd(text, bodyStart, provider.indent, provBodyEnd);
  return { headerStart: provider.start, headerEnd: provider.end, bodyStart, bodyEnd, indent: provider.indent };
}

type ModelsMerge = { ops: TextOp[]; added: number; removed: number };

/** 在 provider 块内按 id 合并 models 列表:已有条目只 upsert 管理子键(用户键保留),
 *  远端已不存在的条目删除,新条目按字母序插入。models 键缺失/内联时整块写入。 */
function planModelsMerge(
  text: string,
  providerBody: { start: number; end: number },
  providerIndent: number,
  models: DshModelEntry[],
): ModelsMerge {
  const modelsKey = findKeyInRegion(text, providerBody.start, providerBody.end, "models", providerIndent + 2);
  if (!modelsKey || headerHasInlineContent(text, modelsKey.start, modelsKey.end)) {
    const block = renderModelsLines(providerIndent, models).join("\n") + "\n";
    const op: TextOp = modelsKey
      ? { start: modelsKey.start, end: lineAfter(text, modelsKey.end), replacement: block }
      : { start: providerBody.start, end: providerBody.start, replacement: block };
    return { ops: [op], added: modelsKey ? 0 : models.length, removed: 0 };
  }
  const listStart = lineAfter(text, modelsKey.end);
  const listEnd = blockBodyEnd(text, listStart, modelsKey.indent, providerBody.end);
  const items = scanYamlListItems(text, listStart, listEnd);
  const byId = new Map(items.map((it) => [it.id, it]));
  const wanted = new Set(models.map((m) => m.id));
  const mergeOps: TextOp[] = [];
  const deletes: TextOp[] = [];
  const inserts: TextOp[] = [];
  let removed = 0;
  for (const it of items) {
    if (wanted.has(it.id)) continue;
    deletes.push({ start: it.start, end: it.end, replacement: preserveTrailingBlanks(text, it) });
    removed++;
  }
  for (const m of models) {
    const it = byId.get(m.id);
    if (!it) continue;
    mergeOps.push(
      ...planManagedKeyUpserts(
        text,
        { start: it.bodyStart, end: it.end },
        { separator: ":", indent: it.indent + 2, keys: modelItemManagedKeys(it.indent, m) },
      ),
    );
  }
  const fresh = models.filter((m) => !byId.has(m.id)).sort((a, b) => a.id.localeCompare(b.id));
  let added = 0;
  if (fresh.length > 0) {
    const itemIndent = items[0]?.indent ?? providerIndent + 4;
    const anchors = new Map<number, string[]>();
    for (const m of fresh) {
      const idx = items.findIndex((it) => it.id.localeCompare(m.id) > 0);
      let pos = idx >= 0 ? items[idx]!.start : trailingBlankStart(text, listStart, listEnd);
      // 锚点若落在被删除条目的区间内,收拢到删除区间起点(同点删除先于插入,顺序稳定)
      for (const d of deletes) {
        if (pos > d.start && pos < d.end) {
          pos = d.start;
          break;
        }
      }
      const lines = anchors.get(pos) ?? [];
      lines.push(...renderModelItemLines(itemIndent, m));
      anchors.set(pos, lines);
      added++;
    }
    for (const [pos, lines] of anchors) {
      inserts.push({ start: pos, end: pos, replacement: lines.join("\n") + "\n" });
    }
  }
  // 顺序:同位置时删除先于插入(applyTextOps 对同 start 保持数组顺序)
  return { ops: [...mergeOps, ...deletes, ...inserts], added, removed };
}

/**
 * 在 settings.yaml 中 upsert llm-pi-ai.providers.<name> 段(官方配置规范,任意 provider 名)。
 * 只改动目标 provider 块(或缺失时新增 llm-pi-ai / providers / <name>),其余段、注释与格式保留。
 */
export function patchDshProvider(text: string, opts: DshProviderInput): { text: string; changes: string[] } {
  const changes: string[] = [];
  const modelCount = opts.models.length;

  // 1) 顶层 llm-pi-ai 段不存在:整段追加
  const llm = findKeyInRegion(text, 0, text.length, DSH_NAMESPACE, 0);
  if (!llm) {
    const block =
      `${DSH_NAMESPACE}:\n` +
      `  ${DSH_PROVIDERS_KEY}:\n` +
      renderProviderBlock(4, opts).join("\n") +
      "\n";
    const next = (text.trim() ? text.replace(/\s+$/, "") + "\n\n" : "") + block;
    return {
      text: next,
      changes: [`新建 ${DSH_NAMESPACE}: 段(providers.${opts.providerName},${modelCount} 个模型)`],
    };
  }
  if (headerHasInlineContent(text, llm.start, llm.end)) {
    throw new Error(`${DSH_NAMESPACE}: 使用内联样式(flow style),请手动编辑 settings.yaml`);
  }
  const llmBodyStart = lineAfter(text, llm.end);
  const llmBodyEnd = blockBodyEnd(text, llmBodyStart, llm.indent, text.length);

  // 2) providers 子段不存在:在 llm-pi-ai 体首插入
  const prov = findKeyInRegion(text, llmBodyStart, llmBodyEnd, DSH_PROVIDERS_KEY);
  let provIndent = llm.indent + 2;
  let provBodyStart = llmBodyStart;
  let provBodyEnd = llmBodyEnd;
  if (!prov) {
    const block =
      " ".repeat(provIndent) + DSH_PROVIDERS_KEY + ":\n" +
      renderProviderBlock(provIndent + 2, opts).join("\n") +
      "\n";
    const next = text.slice(0, llmBodyStart) + block + text.slice(llmBodyStart);
    return {
      text: next,
      changes: [`${DSH_NAMESPACE}: 段新增 providers.${opts.providerName}(${modelCount} 个模型)`],
    };
  }
  if (headerHasInlineContent(text, prov.start, prov.end)) {
    throw new Error(`providers: 使用内联样式(flow style),请手动编辑 settings.yaml`);
  }
  provIndent = prov.indent;
  provBodyStart = lineAfter(text, prov.end);
  provBodyEnd = blockBodyEnd(text, provBodyStart, provIndent, llmBodyEnd);

  // 3) 目标 provider 块不存在:在 providers 体首插入
  const provider = findKeyInRegion(text, provBodyStart, provBodyEnd, opts.providerName);
  if (!provider) {
    const block = renderProviderBlock(provIndent + 2, opts).join("\n") + "\n";
    const next = text.slice(0, provBodyStart) + block + text.slice(provBodyStart);
    return {
      text: next,
      changes: [`providers 段新增 ${opts.providerName}(${modelCount} 个模型)`],
    };
  }
  if (headerHasInlineContent(text, provider.start, provider.end)) {
    throw new Error(`providers.${opts.providerName}: 使用内联样式(flow style),请手动编辑 settings.yaml`);
  }
  const providerBodyStart = lineAfter(text, provider.end);
  const providerBodyEnd = blockBodyEnd(text, providerBodyStart, provider.indent, provBodyEnd);

  // 4) 已有块:只 upsert 管理键(models 按 id 合并),块内用户键与注释原样保留
  const next = applyProviderMerge(
    text,
    { start: providerBodyStart, end: providerBodyEnd },
    provider.indent,
    opts.models,
    providerScalarKeys(provider.indent, opts),
  );
  return {
    text: next,
    changes: next === text ? [] : [`providers.${opts.providerName} 已更新(${modelCount} 个模型)`],
  };
}

/**
 * 应用已有 provider 块的管理键合并:scalarKeys(可为空)+ 条件键 + models 列表。
 * scalarKeys=null 时只处理「模型派生」部分(models + compat/reasoning 条件键),
 * 供「仅更新模型列表」使用——base_url、apiKeyEnv、displayName 等一律不动。
 */
function applyProviderMerge(
  text: string,
  providerBody: { start: number; end: number },
  providerIndent: number,
  models: DshModelEntry[],
  scalarKeys: ManagedKey[] | null,
): string {
  const keys: ManagedKey[] = [...(scalarKeys ?? []), ...providerConditionalKeys(providerIndent, models)];
  const keyOps = planManagedKeyUpserts(text, providerBody, {
    separator: ":",
    indent: providerIndent + 2,
    keys,
  });
  const merge = planModelsMerge(text, providerBody, providerIndent, models);
  return applyTextOps(text, [...keyOps, ...merge.ops]);
}

/**
 * 「仅更新模型列表」:只刷新既有 provider 块的 models 列表与 DeepSeek 条件键
 * (二者都由模型集派生),base_url / apiKeyEnv / displayName 等一概不动。
 * 块不存在时 providerFound=false,由调用方提示先跑一键配置。
 */
export function patchDshProviderModels(
  text: string,
  opts: { providerName: string; models: DshModelEntry[] },
): { text: string; changes: string[]; providerFound: boolean } {
  const provider = locateProviderBlock(text, opts.providerName);
  if (!provider) return { text, changes: [], providerFound: false };
  const next = applyProviderMerge(
    text,
    { start: provider.bodyStart, end: provider.bodyEnd },
    provider.indent,
    opts.models,
    null,
  );
  const changes: string[] = [];
  if (next !== text) changes.push(`models 已更新(${opts.models.length} 个模型)`);
  return { text: next, changes, providerFound: true };
}

// ---------------------------------------------------------------------------
// agent-default-model 补丁
// ---------------------------------------------------------------------------

/** dsh 默认模型设置命名空间(官方 agent-default-model 段)。 */
const DSH_DEFAULT_MODEL_NS = "agent-default-model";

/**
 * 在 settings.yaml 中 upsert 顶层 `agent-default-model:` 段,把默认模型指向
 * 指定 provider 路由。dsh 组合层默认是 deepseek-official(未配 DEEPSEEK_API_KEY 时一发消息
 * 就报 no API key),一键配置后改为目标 provider。
 */
export function patchDshDefaultModel(
  text: string,
  provider: string,
  model: string,
): { text: string; changes: string[] } {
  const block = findKeyInRegion(text, 0, text.length, DSH_DEFAULT_MODEL_NS, 0);
  if (!block) {
    const section =
      `${DSH_DEFAULT_MODEL_NS}:\n` +
      `  provider: ${yamlQuote(provider)}\n` +
      `  model: ${yamlQuote(model)}\n`;
    const next = (text.trim() ? text.replace(/\s+$/, "") + "\n\n" : "") + section;
    return {
      text: next,
      changes: [`新建 ${DSH_DEFAULT_MODEL_NS}: 段(provider=${provider}, model=${model})`],
    };
  }
  if (headerHasInlineContent(text, block.start, block.end)) {
    throw new Error(`${DSH_DEFAULT_MODEL_NS}: 使用内联样式(flow style),请手动编辑 settings.yaml`);
  }
  const bodyStart = lineAfter(text, block.end);
  const bodyEnd = blockBodyEnd(text, bodyStart, block.indent, text.length);
  const body = `  provider: ${yamlQuote(provider)}\n  model: ${yamlQuote(model)}\n`;
  const next = text.slice(0, bodyStart) + body + text.slice(bodyEnd);
  return {
    text: next,
    changes: next === text ? [] : [`${DSH_DEFAULT_MODEL_NS} 已更新(provider=${provider}, model=${model})`],
  };
}

// ---------------------------------------------------------------------------
// .credentials.yaml 补丁
// ---------------------------------------------------------------------------

/**
 * 在 .credentials.yaml 中 upsert 一个凭据(写入方自行负责 0600 权限)。兼容两种格式:
 *  - 顶层裸 `KEY: value`(dsh 官方默认);
 *  - 顶层 `refs:` 包裹(`refs:\n  KEY: value`,部分 dsh 版本),此时把 key 缩进写到 refs 之下。
 * 若顶层已有该 key(旧版错位写法),会把它移到 refs 之下。
 */
export function upsertDshCredentialYaml(text: string, key: string, value: string): { text: string; changed: boolean } {
  if (!value) throw new Error("凭据值不能为空(dsh 规范拒绝空字符串)");
  const refs = findKeyInRegion(text, 0, text.length, "refs", 0);
  if (refs && !headerHasInlineContent(text, refs.start, refs.end)) {
    return upsertDshCredentialInRefs(text, refs, key, value);
  }
  // 顶层裸 key(官方格式)
  const line = `${key}: ${yamlQuote(value)}`;
  const keyRe = new RegExp(`^${escapeRegExp(key)}:(?:[ \\t].*)?$`, "m");
  if (keyRe.test(text)) {
    const next = text.replace(keyRe, line);
    return { text: next, changed: next !== text };
  }
  return { text: (text.trim() ? text.replace(/\s+$/, "") + "\n" : "") + line + "\n", changed: true };
}

/** 把凭据写进顶层 `refs:` 块:key 缩进到 refs 子项层级(通常 2 空格)。 */
function upsertDshCredentialInRefs(
  text: string,
  refs: { start: number; end: number; indent: number },
  key: string,
  value: string,
): { text: string; changed: boolean } {
  const bodyStart = lineAfter(text, refs.end);
  const bodyEnd = blockBodyEnd(text, bodyStart, refs.indent, text.length);
  const childIndent = refs.indent + 2;
  const pad = " ".repeat(childIndent);
  const childLine = `${pad}${key}: ${yamlQuote(value)}`;
  const bodyText = text.slice(bodyStart, bodyEnd);

  // 在 refs 块体内 upsert
  const childKeyRe = new RegExp(`^${escapeRegExp(pad)}${escapeRegExp(key)}:(?:[ \\t].*)?$`, "m");
  let newBody: string;
  if (childKeyRe.test(bodyText)) {
    newBody = bodyText.replace(childKeyRe, childLine);
  } else {
    const trimmed = bodyText.trim();
    newBody = trimmed ? `${bodyText.replace(/\s+$/, "")}\n${childLine}\n` : `${childLine}\n`;
  }

  // 移除顶层(错位)的旧写法,再拼回
  const topKeyRe = new RegExp(`^${escapeRegExp(key)}:(?:[ \\t].*)?$\\n?`, "m");
  const before = text.slice(0, bodyStart).replace(topKeyRe, "");
  const after = text.slice(bodyEnd).replace(topKeyRe, "");

  const next = before + newBody + after;
  return { text: next, changed: next !== text };
}

// ---------------------------------------------------------------------------
// 状态诊断
// ---------------------------------------------------------------------------

export type DshStatus = {
  dshHome: string;
  settingsExists: boolean;
  credentialsExists: boolean;
  providerConfigured: boolean;
  providerDisplayName: string | null;
  providerApiKeyEnv: string | null;
  providerBaseUrl: string | null;
  providerModels: number;
  providerThinkingFormat: string | null;
  credentialStored: boolean;
  dshCli: string | null;
};

/** 读取 dsh 当前配置状态(只读诊断;providerName/apiKeyEnv 默认 magene 团队配置)。 */
export async function dshStatus(
  providerName: string = DSH_PROVIDER_NAME,
  apiKeyEnv: string = DSH_API_KEY_ENV,
): Promise<DshStatus> {
  const home = dshHome();
  const settingsText = await readDshSettingsYaml();
  const credText = await readDshCredentialsYaml();

  const provider = locateProviderBlock(settingsText, providerName);
  const body = provider ? settingsText.slice(provider.bodyStart, provider.bodyEnd) : "";
  const grab = (re: RegExp): string | null => {
    const m = body.match(re);
    return m ? unquoteYaml(m[1]) : null;
  };
  const modelCount = (body.match(/^ *- id:/gm) ?? []).length;

  return {
    dshHome: home,
    settingsExists: existsSync(path.join(home, "settings.yaml")),
    credentialsExists: existsSync(path.join(home, ".credentials.yaml")),
    providerConfigured: Boolean(provider),
    providerDisplayName: grab(/^ *displayName: *(.*)$/m),
    providerApiKeyEnv: grab(/^ *apiKeyEnv: *(.*)$/m),
    providerBaseUrl: grab(/^ *baseURL: *(.*)$/m),
    providerModels: modelCount,
    providerThinkingFormat: grab(/^ *thinkingFormat: *(.*)$/m),
    credentialStored: new RegExp(`^${escapeRegExp(apiKeyEnv)}:`).test(credText),
    dshCli: findDshCli(),
  };
}
