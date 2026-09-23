// Oh My Pi (omp) 配置:写入 ~/.omp/agent/models.yml(providers)+ config.yml(modelRoles)。
// 纯文本变换(缩进感知的 YAML 块补丁),不做文件 I/O。
// DeepSeek 模型按 DeepSeek 官方 awesome-deepseek-agent 指南的优化配置写入
// (thinking 等级锁定 + 完整 compat 块:官方明示 compat 整体替换不合并,必须写全)。
// 移植自 axon-llm-dispenser src/core/omp.ts。

import type { ResolvedModel } from "./model-resolution.ts";
import { isDeepseekModel } from "./model-resolution.ts";
import {
  applyTextOps,
  blockBodyEnd,
  findKeyInRegion,
  headerHasInlineContent,
  lineAfter,
  planManagedKeyUpserts,
  preserveTrailingBlanks,
  scanYamlListItems,
  trailingBlankStart,
  unquoteYaml,
  yamlQuote,
  type ManagedKey,
  type TextOp,
} from "./config-io.ts";

export type OmpProviderInput = {
  providerName: string;
  baseUrl: string;
  apiKey: string;
  models: ResolvedModel[];
};

const LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** omp 的 baseUrl 不带 /v1(官方指南明示)。 */
export function ompBaseUrl(url: string): string {
  return url.replace(/\/v1\/?$/, "");
}

/** 由 thinkingLevelMap 推导 omp 的 thinking 等级范围(首个非空等级 ~ 末个非空等级)。 */
function thinkingRange(map?: Partial<Record<string, string | null>>): { minLevel: string; maxLevel: string } | null {
  if (!map) return null;
  const levels = LEVEL_ORDER.filter((l) => typeof map[l] === "string" && (map[l] as string).length > 0);
  if (levels.length === 0) return null;
  return { minLevel: levels[0], maxLevel: levels[levels.length - 1] };
}

/** DeepSeek 官方完整 compat 块(缺少三关键字段会导致思考模式下工具调用 400)。
 *  compatIndent 为 `compat:` 键的缩进宽度。 */
function renderCompatLines(compatIndent: number, m: ResolvedModel): string[] {
  const pad = " ".repeat(compatIndent);
  const map = m.compat?.reasoningEffortMap ?? {};
  const out: string[] = [`${pad}compat:`];
  out.push(`${pad}  supportsDeveloperRole: false`);
  out.push(`${pad}  supportsReasoningEffort: ${m.compat?.supportsReasoningEffort ?? true}`);
  out.push(`${pad}  maxTokensField: max_tokens`);
  const entries = Object.entries(map).filter(([, v]) => typeof v === "string" && v.length > 0);
  if (entries.length > 0) {
    out.push(`${pad}  reasoningEffortMap:`);
    for (const [level, wire] of entries) out.push(`${pad}    ${level}: ${yamlQuote(wire as string)}`);
  }
  out.push(`${pad}  supportsToolChoice: false`);
  out.push(`${pad}  requiresReasoningContentForToolCalls: true`);
  out.push(`${pad}  requiresAssistantContentForToolCalls: true`);
  out.push(`${pad}  extraBody:`);
  out.push(`${pad}    thinking:`);
  out.push(`${pad}      type: enabled`);
  return out;
}

/** DeepSeek 推理模型的官方 thinking 块(minLevel/maxLevel 由 thinkingLevelMap 推导)。 */
function renderThinkingLines(thinkingIndent: number, m: ResolvedModel): string[] {
  const pad = " ".repeat(thinkingIndent);
  const range = thinkingRange(m.thinkingLevelMap) ?? { minLevel: "high", maxLevel: "xhigh" };
  return [
    `${pad}thinking:`,
    `${pad}  minLevel: ${range.minLevel}`,
    `${pad}  maxLevel: ${range.maxLevel}`,
    `${pad}  mode: effort`,
  ];
}

/** 模型条目的管理子键(thinking/compat 不适用时移除,避免残留旧特配)。 */
function modelItemManagedKeys(itemIndent: number, m: ResolvedModel): ManagedKey[] {
  const keyIndent = itemIndent + 2;
  const sp = " ".repeat(keyIndent);
  const dsReasoning = isDeepseekModel(m.id) && m.reasoning;
  return [
    { key: "name", lines: m.name && m.name !== m.id ? [`${sp}name: ${yamlQuote(m.name)}`] : null },
    { key: "reasoning", lines: [`${sp}reasoning: ${m.reasoning}`] },
    { key: "thinking", lines: dsReasoning ? renderThinkingLines(keyIndent, m) : null, block: true },
    { key: "input", lines: [`${sp}input: [${m.input.includes("image") ? "text, image" : "text"}]`] },
    { key: "contextWindow", lines: [`${sp}contextWindow: ${m.contextWindow}`] },
    { key: "maxTokens", lines: [`${sp}maxTokens: ${m.maxTokens}`] },
    { key: "compat", lines: dsReasoning ? renderCompatLines(keyIndent, m) : null, block: true },
  ];
}

/** 渲染单个模型条目(itemIndent 为 `- id:` 行的缩进;DeepSeek 推理模型带官方特配)。 */
function renderModelItemLines(itemIndent: number, m: ResolvedModel): string[] {
  const out = [`${" ".repeat(itemIndent)}- id: ${yamlQuote(m.id)}`];
  for (const k of modelItemManagedKeys(itemIndent, m)) {
    if (k.lines) out.push(...k.lines);
  }
  return out;
}

/** 渲染 `models:` 键行 + 全部条目(provider 缩进;条目缩进 +4)。 */
function renderModelsLines(providerIndent: number, models: ResolvedModel[]): string[] {
  const out = [`${" ".repeat(providerIndent + 2)}models:`];
  for (const m of models) out.push(...renderModelItemLines(providerIndent + 4, m));
  return out;
}

/** provider 块标量键(baseUrl / api / apiKey / authHeader)。 */
function providerScalarKeys(indent: number, opts: OmpProviderInput): ManagedKey[] {
  const sp = " ".repeat(indent + 2);
  return [
    { key: "baseUrl", lines: [`${sp}baseUrl: ${yamlQuote(ompBaseUrl(opts.baseUrl))}`] },
    { key: "api", lines: [`${sp}api: openai-completions`] },
    { key: "apiKey", lines: [`${sp}apiKey: ${yamlQuote(opts.apiKey)}`] },
    { key: "authHeader", lines: [`${sp}authHeader: true`] },
  ];
}

function renderProviderBlock(indent: number, opts: OmpProviderInput): string[] {
  const out = [`${" ".repeat(indent)}${opts.providerName}:`];
  for (const k of providerScalarKeys(indent, opts)) if (k.lines) out.push(...k.lines);
  out.push(...renderModelsLines(indent, opts.models));
  return out;
}

type ModelsMerge = { ops: TextOp[]; added: number; removed: number };

/** 在 provider 块内按 id 合并 models 列表(用户键保留;下架条目删除;新条目按字母序插入)。 */
function planModelsMerge(
  text: string,
  providerBody: { start: number; end: number },
  providerIndent: number,
  models: ResolvedModel[],
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

/** 在 ~/.omp/agent/models.yml 中 upsert providers.<name> 段(保留其它 provider)。 */
export function patchOmpModelsYml(text: string, opts: OmpProviderInput): { text: string; changes: string[] } {
  const modelCount = opts.models.length;
  const prov = findKeyInRegion(text, 0, text.length, "providers", 0);
  if (!prov) {
    const block = "providers:\n" + renderProviderBlock(2, opts).join("\n") + "\n";
    const next = (text.trim() ? text.replace(/\s+$/, "") + "\n\n" : "") + block;
    return { text: next, changes: [`新建 providers.${opts.providerName}(${modelCount} 个模型)`] };
  }
  if (headerHasInlineContent(text, prov.start, prov.end)) throw new Error("providers: 使用内联样式(flow style),请手动编辑 models.yml");
  const provBodyStart = lineAfter(text, prov.end);
  const provBodyEnd = blockBodyEnd(text, provBodyStart, prov.indent, text.length);

  const provider = findKeyInRegion(text, provBodyStart, provBodyEnd, opts.providerName);
  if (!provider) {
    const block = renderProviderBlock(prov.indent + 2, opts).join("\n") + "\n";
    const next = text.slice(0, provBodyStart) + block + text.slice(provBodyStart);
    return { text: next, changes: [`providers 段新增 ${opts.providerName}(${modelCount} 个模型)`] };
  }
  if (headerHasInlineContent(text, provider.start, provider.end)) throw new Error(`providers.${opts.providerName}: 使用内联样式,请手动编辑 models.yml`);
  const bodyStart = lineAfter(text, provider.end);
  const bodyEnd = blockBodyEnd(text, bodyStart, provider.indent, provBodyEnd);
  // 只 upsert 管理键(models 按 id 合并),块内用户键与注释原样保留
  const next = applyOmpProviderMerge(
    text,
    { start: bodyStart, end: bodyEnd },
    provider.indent,
    opts.models,
    providerScalarKeys(provider.indent, opts),
  );
  return { text: next, changes: next === text ? [] : [`providers.${opts.providerName} 已更新(${modelCount} 个模型)`] };
}

/** 应用已有 provider 块的管理键合并:scalarKeys(可为 null=只处理 models)+ models 列表。 */
function applyOmpProviderMerge(
  text: string,
  providerBody: { start: number; end: number },
  providerIndent: number,
  models: ResolvedModel[],
  scalarKeys: ManagedKey[] | null,
): string {
  const keyOps = planManagedKeyUpserts(text, providerBody, {
    separator: ":",
    indent: providerIndent + 2,
    keys: scalarKeys ?? [],
  });
  const merge = planModelsMerge(text, providerBody, providerIndent, models);
  return applyTextOps(text, [...keyOps, ...merge.ops]);
}

/**
 * 「仅更新模型列表」:只刷新既有 providers.<name> 块的 models 列表,
 * baseUrl / api / apiKey / authHeader 等一概不动。块不存在时 providerFound=false。
 */
export function patchOmpModelsList(
  text: string,
  opts: { providerName: string; models: ResolvedModel[] },
): { text: string; changes: string[]; providerFound: boolean } {
  const prov = findKeyInRegion(text, 0, text.length, "providers", 0);
  if (!prov || headerHasInlineContent(text, prov.start, prov.end)) {
    return { text, changes: [], providerFound: false };
  }
  const provBodyStart = lineAfter(text, prov.end);
  const provBodyEnd = blockBodyEnd(text, provBodyStart, prov.indent, text.length);
  const provider = findKeyInRegion(text, provBodyStart, provBodyEnd, opts.providerName);
  if (!provider || headerHasInlineContent(text, provider.start, provider.end)) {
    return { text, changes: [], providerFound: false };
  }
  const bodyStart = lineAfter(text, provider.end);
  const bodyEnd = blockBodyEnd(text, bodyStart, provider.indent, provBodyEnd);
  const next = applyOmpProviderMerge(text, { start: bodyStart, end: bodyEnd }, provider.indent, opts.models, null);
  const changes: string[] = [];
  if (next !== text) changes.push(`models 已更新(${opts.models.length} 个模型)`);
  return { text: next, changes, providerFound: true };
}

/** 在 ~/.omp/agent/config.yml 中 upsert modelRoles.default。 */
export function patchOmpConfigYml(text: string, providerName: string, defaultModel: string): { text: string; changes: string[] } {
  const role = `${providerName}/${defaultModel}`;
  const mr = findKeyInRegion(text, 0, text.length, "modelRoles", 0);
  if (!mr) {
    const block = `modelRoles:\n  default: ${yamlQuote(role)}\n`;
    const next = (text.trim() ? text.replace(/\s+$/, "") + "\n\n" : "") + block;
    return { text: next, changes: [`新建 modelRoles.default = ${role}`] };
  }
  if (headerHasInlineContent(text, mr.start, mr.end)) throw new Error("modelRoles: 使用内联样式,请手动编辑 config.yml");
  const bodyStart = lineAfter(text, mr.end);
  const bodyEnd = blockBodyEnd(text, bodyStart, mr.indent, text.length);
  const line = `  default: ${yamlQuote(role)}`;
  const def = findKeyInRegion(text, bodyStart, bodyEnd, "default");
  const next = def
    ? text.slice(0, def.start) + line + text.slice(lineAfter(text, def.end))
    : text.slice(0, bodyStart) + line + "\n" + text.slice(bodyStart);
  return { text: next, changes: next === text ? [] : [`modelRoles.default = ${role}`] };
}

// ---------------------------------------------------------------------------
// 状态诊断
// ---------------------------------------------------------------------------

export type OmpStatus = {
  modelsExists: boolean;
  providerConfigured: boolean;
  providerBaseUrl: string | null;
  providerModels: number;
  configExists: boolean;
  defaultRole: string | null;
};

/** 从 models.yml / config.yml 文本解析 omp 状态(纯)。 */
export function parseOmpStatus(modelsText: string, configText: string, providerName: string): OmpStatus {
  let providerBaseUrl: string | null = null;
  let providerModels = 0;
  const prov = findKeyInRegion(modelsText, 0, modelsText.length, "providers", 0);
  if (prov) {
    const provBodyStart = lineAfter(modelsText, prov.end);
    const provBodyEnd = blockBodyEnd(modelsText, provBodyStart, prov.indent, modelsText.length);
    const p = findKeyInRegion(modelsText, provBodyStart, provBodyEnd, providerName);
    if (p) {
      const bodyStart = lineAfter(modelsText, p.end);
      const bodyEnd = blockBodyEnd(modelsText, bodyStart, p.indent, provBodyEnd);
      const body = modelsText.slice(bodyStart, bodyEnd);
      const bm = body.match(/^ *baseUrl: *(.*)$/m);
      providerBaseUrl = bm ? unquoteYaml(bm[1]) : null;
      providerModels = (body.match(/^ *- id:/gm) ?? []).length;
    }
  }
  let defaultRole: string | null = null;
  const mr = findKeyInRegion(configText, 0, configText.length, "modelRoles", 0);
  if (mr) {
    const bodyStart = lineAfter(configText, mr.end);
    const bodyEnd = blockBodyEnd(configText, bodyStart, mr.indent, configText.length);
    const dm = configText.slice(bodyStart, bodyEnd).match(/^ *default: *(.*)$/m);
    defaultRole = dm ? unquoteYaml(dm[1]) : null;
  }
  return {
    modelsExists: modelsText.length > 0,
    providerConfigured: providerBaseUrl !== null,
    providerBaseUrl,
    providerModels,
    configExists: configText.length > 0,
    defaultRole,
  };
}
