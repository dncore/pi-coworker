// Codex 配置与模型目录同步(magene provider 直连 Codex)。

import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { applyTextOps, lineAfter, planManagedKeyUpserts } from "./config-io.ts";

// 实测(2026-09-06,两轮复测)在 Magene /responses 上以 **Codex 真实请求形态**
// (数组 input + function tools + reasoning.effort + store:false + stream)可用的可信模型。
// ⚠️ 网关 /responses 适配层存在 content-type 翻译 bug:结构化数组 input 下
// deepseek-v4-flash / glm-* / grok-4.6 / kimi-k2.6 / kimi-k3 / kimi-lastest / hy3 /
// MiMo-* / step-3.7-flash 全部 400/502(字符串 input 正常,Codex 不发字符串,无法绕过);
// claude-* / gpt-5.6-* / gemini-* 另因七牛渠道假/存疑不入表(hide 后仍可 codex -m)。
// 网关修复后需按上述形态重测更新本表。
export const CODEX_OK_MODELS = new Set([
  "deepseek-v4-pro", "deepseek-v4-flash-vision-exp",
  "qwen3.8-max", "qwen3.8-flash", "qwen3.7-plus", "qwen3.7-flash", "qwen-lastest",
  "kimi-k2.7-code",
  "MiniMax-M3", "MiniMax-lastest",
  "Recommend",
]);

// 团队策略:整体剔除的模型(勿擅自加回)。
export const CODEX_EXCLUDED_MODELS = new Set([
  "Doubao-Seed-2.0-pro", "Doubao-Seed-2.0-Code", "Doubao-Seed-2.0-lite",
]);

// 注意:deepseek-v4-flash 虽渠道可信,但在 Codex 数组 input 形态下 400(网关适配 bug),不能作默认。
export const CODEX_DEFAULT_MODEL = "deepseek-v4-pro";

/** Codex 目录 reasoning effort 预设(与 axon-llm-dispenser 同源实测):
 *  网关对所有模型接受 low/high/max 三档;**不含 off/none**——claude 系 / gemini-3.x /
 *  grok 拒收 none→400,且转换层不发送 none。desktop 端 effort 下拉据此渲染,
 *  缺省为空数组时桌面端无法选择 effort。 */
export const CODX_REASONING_LEVELS: Array<{ effort: string; description: string }> = [
  { effort: "low", description: "Low" },
  { effort: "high", description: "High" },
  { effort: "max", description: "Max" },
];

// 与 index.ts 中 ResolvedModel 结构兼容(结构类型)。
export type CodexResolvedModel = {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
};

export function codexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

export async function readCodexConfigToml(): Promise<string> {
  try {
    return await readFile(path.join(codexHome(), "config.toml"), "utf8");
  } catch {
    return "";
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function upsertKey(text: string, key: string, value: string): { text: string; changed: boolean } {
  const line = `${key} = ${JSON.stringify(value)}`;
  const re = new RegExp(`^${escapeRegExp(key)}\\s*=.*$`, "m");
  if (re.test(text)) {
    const next = text.replace(re, line);
    return { text: next, changed: next !== text };
  }
  return { text: line + "\n" + text, changed: true };
}

function upsertProviderSection(
  text: string,
  name: string,
  kv: Record<string, string | boolean>,
): { text: string; changed: boolean } {
  const body = Object.entries(kv)
    .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
    .join("\n");
  const headerRe = new RegExp(`^\\[model_providers\\.${escapeRegExp(name)}\\]\\s*$`, "m");
  const header = text.match(headerRe);
  if (!header || header.index === undefined) {
    const block = `[model_providers.${name}]\n${body}\n`;
    return { text: text.replace(/\s+$/, "") + "\n\n" + block, changed: true };
  }
  // 只 upsert 本段的键,段内用户自己加的键与注释原样保留(不再整段重写)。
  const headerLineEnd = text.indexOf("\n", header.index);
  const bodyStart = headerLineEnd === -1 ? text.length : headerLineEnd + 1;
  const nextHeader = text.slice(bodyStart).match(/^\[/m);
  const bodyEnd = nextHeader ? bodyStart + nextHeader.index! : text.length;
  const ops = planManagedKeyUpserts(
    text,
    { start: bodyStart, end: bodyEnd },
    {
      separator: "=",
      indent: 0,
      keys: Object.entries(kv).map(([k, v]) => ({ key: k, lines: [`${k} = ${JSON.stringify(v)}`] })),
    },
  );
  const next = applyTextOps(text, ops);
  return { text: next, changed: next !== text };
}

/** 生成 codex config.toml 的 provider 配置(文本级修改,幂等)。
 *  默认按 magene 团队策略(provider 名 / 默认模型);自定义网关经 opts 覆写:
 *  provider=路由名、defaultModel=网关默认模型、alwaysSetModel=切网关时强制覆写顶层 model。 */
export function patchCodexConfigToml(
  text: string,
  baseUrl: string,
  apiKey: string,
  opts?: { provider?: string; defaultModel?: string; alwaysSetModel?: boolean },
): { text: string; changes: string[] } {
  const changes: string[] = [];
  let out = text;

  const providerName = opts?.provider ?? "magene";
  const defaultModel = opts?.defaultModel ?? CODEX_DEFAULT_MODEL;

  const provider = upsertKey(out, "model_provider", providerName);
  out = provider.text;
  if (provider.changed) changes.push(`model_provider = ${providerName}`);

  if (opts?.alwaysSetModel || !/^model\s*=.*$/m.test(out)) {
    const model = upsertKey(out, "model", defaultModel);
    out = model.text;
    if (model.changed) changes.push(`model = ${defaultModel}`);
  }

  // 顶层 model_catalog_json 必须写:codex-cli 不写它就读不到 ~/.codex/models.json,
  // 模型选择器只剩内置 gpt 模型(metadata 也查不到)。注意必须放顶层,不能放 provider 表内。
  const catalogJson = path.join(codexHome(), "models.json");
  const catalog = upsertKey(out, "model_catalog_json", catalogJson);
  out = catalog.text;
  if (catalog.changed) changes.push(`model_catalog_json = ${catalogJson}`);

  // requires_openai_auth 必须为 false:置 true 时 Codex 会强制去 ~/.codex/auth.json
  // 找凭据,全新安装没有 auth.json 就直接弹「Sign in with ChatGPT」,experimental_bearer_token
  // 写了也没用。置 false 后 Codex 直接用本段 experimental_bearer_token 发请求,不依赖 auth.json。
  const section = upsertProviderSection(out, providerName, {
    name: providerName,
    base_url: baseUrl,
    wire_api: "responses",
    requires_openai_auth: false,
    experimental_bearer_token: apiKey,
  });
  out = section.text;
  if (section.changed) changes.push(`[model_providers.${providerName}] updated`);

  return { text: out, changes };
}

export async function writeCodexConfigToml(text: string): Promise<{ path: string; backup?: string }> {
  const home = codexHome();
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

export type CodexBackup = {
  kind: "config.toml" | "models.json";
  path: string;
  label: string;
  size: number;
  mtimeMs: number;
};

/** 列出 ~/.codex 下 config.toml / models.json 的备份,按时间倒序。 */
export async function listCodexBackups(): Promise<CodexBackup[]> {
  const home = codexHome();
  const out: CodexBackup[] = [];
  try {
    const names = await readdir(home);
    for (const name of names) {
      const m = name.match(/^(config\.toml|models\.json)\.bak-(.+)$/);
      if (!m) continue;
      const p = path.join(home, name);
      try {
        const st = await stat(p);
        if (st.isFile()) {
          out.push({ kind: m[1] as CodexBackup["kind"], path: p, label: name, size: st.size, mtimeMs: st.mtimeMs });
        }
      } catch {
        // 跳过不可读条目
      }
    }
  } catch {
    // home 缺失——无备份
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** 用备份覆盖目标文件;还原前先把当前文件备份为 .bak-pre-restore-<ts>,防止手滑。 */
export async function restoreCodexBackup(backupPath: string): Promise<{ target: string; backup?: string }> {
  const kind: CodexBackup["kind"] = path.basename(backupPath).startsWith("models.json")
    ? "models.json"
    : "config.toml";
  const target = path.join(codexHome(), kind);
  let backup: string | undefined;
  if (existsSync(target)) {
    backup = `${target}.bak-pre-restore-${timestamp()}`;
    await rename(target, backup);
  }
  await copyFile(backupPath, target);
  return { target, backup };
}

function buildCodexEntry(
  m: CodexResolvedModel,
  providerLabel: string,
  status: "ok" | "user-selected" | "hidden",
  hideNote = "unavailable (404/403 upstream)",
) {
  const cw = m.contextWindow || 128000;
  return {
    base_instructions: "",
    context_window: cw,
    description: `${providerLabel} proxy: ${m.name} — /responses ${
      status === "ok" ? "OK" : status === "user-selected" ? "not in tested whitelist (user-selected)" : hideNote
    }`,
    display_name: m.name,
    experimental_supported_tools: [],
    max_context_window: cw,
    priority: 0,
    shell_type: "shell_command",
    slug: m.id,
    support_verbosity: false,
    supported_in_api: true,
    // reasoning 模型带 effort 档位(desktop effort 下拉依据);非 reasoning 模型留空(无思考能力不提供档位)。
    supported_reasoning_levels: m.reasoning ? CODX_REASONING_LEVELS.map((l) => ({ ...l })) : [],
    supports_images: m.input.includes("image"),
    supports_parallel_tool_calls: true,
    supports_reasoning_summaries: false,
    supports_tools: true,
    truncation_policy: { limit: cw, mode: "tokens" },
    visibility: status === "hidden" ? "hide" : "list",
  };
}

export type CodexSyncResult = {
  catalogPath: string;
  backup?: string;
  total: number;
  list: number;
  hide: number;
  excluded: number;
  kept: number;
  /** refresh 模式:新增/移除的网关条目 id(字母序)。 */
  added: string[];
  removed: string[];
  /** 生成内容与现有文件一致,未写入也未备份。 */
  unchanged: boolean;
};

/** 读取现有 models.json 中非 magene 的条目数(用于覆盖前提示)。 */
export async function countNonMageneCatalogEntries(liveIds: string[]): Promise<number> {
  try {
    const data = JSON.parse(await readFile(path.join(codexHome(), "models.json"), "utf8")) as {
      models?: Array<{ slug?: string }>;
    };
    const live = new Set(liveIds);
    return (data.models ?? []).filter((m) => m.slug && !live.has(m.slug)).length;
  } catch {
    return 0;
  }
}

/** 生成/覆盖 codex models.json。
 *  list(选择器可见)判定:默认按白名单(okOverride ?? CODEX_OK_MODELS);
 *  传入 selectedIds(Codex 向导「自选模型」)时改为按用户勾选——勾选但白名单外的模型
 *  也置 list(用户明知标注仍勾选),描述如实标注 user-selected。
 *  未入选模型仍以 hide 写入(codex -m 显式指定可用)。
 *  默认只保留 magene 模型;keepOthers=true 时合并现有非 magene 条目。
 *  refresh=true(「仅更新模型列表」):读现有目录识别存量——已有条目沿用其可见性与描述,
 *  新条目按 selectedIds/白名单默认;非本网关条目(slug 不在网关列表且无本网关描述前缀)原样保留;
 *  本网关已下架条目移除。内容与现有文件一致时不写入(也不产生备份)。
 *  自定义网关经 providerLabel(描述前缀)与 excluded(默认团队排除名单,可传空)参数化。 */
export async function syncCodexCatalog(
  models: CodexResolvedModel[],
  opts?: {
    dryRun?: boolean;
    okOverride?: Set<string>;
    keepOthers?: boolean;
    selectedIds?: Set<string>;
    providerLabel?: string;
    excluded?: Set<string>;
    /** hide 条目描述注记(默认 magene 白名单探测语义;自定义网关传「未勾选」语义)。 */
    hideNote?: string;
    /** 仅增量刷新(见上方说明)。 */
    refresh?: boolean;
  },
): Promise<CodexSyncResult> {
  const home = codexHome();
  await mkdir(home, { recursive: true });
  const catalogPath = path.join(home, "models.json");
  const okSet = opts?.okOverride ?? CODEX_OK_MODELS;
  const excludedSet = opts?.excluded ?? CODEX_EXCLUDED_MODELS;
  const providerLabel = opts?.providerLabel ?? "Magene";
  const refresh = opts?.refresh ?? false;

  // 现有目录:refresh 据此识别「本网关条目」(描述前缀)与「非本网关条目」(原样保留)
  type CatalogEntry = { slug?: string; visibility?: string; description?: string };
  let existing: CatalogEntry[] = [];
  let existingText = "";
  try {
    existingText = await readFile(catalogPath, "utf8");
    existing = (JSON.parse(existingText) as { models?: CatalogEntry[] }).models ?? [];
  } catch {
    // 目录缺失/损坏——视为无
  }
  const prevById = new Map<string, CatalogEntry>();
  const ours = new Set<string>();
  const foreign: CatalogEntry[] = [];
  for (const e of existing) {
    if (!e.slug) continue;
    prevById.set(e.slug, e);
    if (typeof e.description === "string" && e.description.startsWith(`${providerLabel} proxy: `)) ours.add(e.slug);
    else foreign.push(e);
  }

  const live = models.filter((m) => !excludedSet.has(m.id));
  const liveIds = new Set(live.map((m) => m.id));

  let listSet: Set<string>;
  let selectedIds: Set<string> | undefined;
  if (refresh) {
    // 已有可见性优先;新出现的模型按白名单/勾选默认
    listSet = new Set(live.filter((m) => prevById.get(m.id)?.visibility === "list").map((m) => m.id));
    const defaultSet = opts?.selectedIds ?? okSet;
    for (const m of live) if (!prevById.has(m.id) && defaultSet.has(m.id)) listSet.add(m.id);
    selectedIds = listSet;
  } else {
    listSet = opts?.selectedIds ?? okSet;
    selectedIds = opts?.selectedIds;
  }
  const listModels = live.filter((m) => listSet.has(m.id)).sort((a, b) => a.id.localeCompare(b.id));
  const hideModels = live.filter((m) => !listSet.has(m.id)).sort((a, b) => a.id.localeCompare(b.id));

  const entries: ReturnType<typeof buildCodexEntry>[] = [];
  listModels.forEach((m, i) => {
    const e = buildCodexEntry(m, providerLabel, selectedIds && !okSet.has(m.id) ? "user-selected" : "ok");
    e.priority = 20 + i;
    // 刷新时保留原描述(响应性标注是上次探测/勾选的结果)
    const prev = refresh ? prevById.get(m.id)?.description : undefined;
    if (prev) e.description = prev;
    entries.push(e);
  });
  hideModels.forEach((m, i) => {
    const e = buildCodexEntry(m, providerLabel, "hidden", opts?.hideNote);
    e.priority = 100 + i;
    const prev = refresh ? prevById.get(m.id)?.description : undefined;
    if (prev) e.description = prev;
    entries.push(e);
  });

  // 保留现有目录里的非本网关条目(如 OpenAI gpt/o3 等)。
  // 常规模式:keepOthers=true 时保留;判定用全量 live(未勾选的本网关模型不算「非本网关条目」)。
  // 刷新模式:always 保留非本网关条目;本网关下架条目移除。
  let kept: unknown[] = [];
  if (refresh) {
    kept = foreign.filter((m) => !liveIds.has(m.slug!) && !excludedSet.has(m.slug!));
  } else if (opts?.keepOthers) {
    kept = existing.filter((m) => Boolean(m.slug) && !liveIds.has(m.slug!) && !excludedSet.has(m.slug!));
  }
  const added = refresh ? live.filter((m) => !prevById.has(m.id)).map((m) => m.id).sort((a, b) => a.localeCompare(b)) : [];
  const removed = refresh ? [...ours].filter((slug) => !liveIds.has(slug)).sort((a, b) => a.localeCompare(b)) : [];

  const catalog = { models: [...kept, ...entries] };
  const serialized = `${JSON.stringify(catalog, null, 2)}\n`;
  const unchanged = existingText === serialized; // 内容一致:不写、不备份,避免 .bak 泛滥
  let backup: string | undefined;
  if (!opts?.dryRun && !unchanged) {
    if (existsSync(catalogPath)) {
      backup = `${catalogPath}.bak-${timestamp()}`;
      await rename(catalogPath, backup);
    }
    await writeFile(catalogPath, serialized);
  }

  return {
    catalogPath,
    backup,
    total: entries.length,
    list: listModels.length,
    hide: hideModels.length,
    excluded: models.length - live.length,
    kept: kept.length,
    added,
    removed,
    unchanged,
  };
}

/** 读取 codex 当前配置与目录状态(诊断用;providerName 默认 magene 团队配置)。 */
export async function codexStatus(providerName: string = "magene") {
  const home = codexHome();
  const cfgText = await readCodexConfigToml();
  const catalogPath = path.join(home, "models.json");
  let catalog: { count: number; list: number; hide: number } = { count: 0, list: 0, hide: 0 };
  try {
    const data = JSON.parse(await readFile(catalogPath, "utf8")) as {
      models?: Array<{ visibility?: string }>;
    };
    const models = data.models ?? [];
    catalog = {
      count: models.length,
      list: models.filter((m) => m.visibility === "list").length,
      hide: models.filter((m) => m.visibility === "hide").length,
    };
  } catch {
    // missing / invalid catalog — leave zeros
  }
  const authPath = path.join(home, "auth.json");
  const authExists = existsSync(authPath);
  // requires_openai_auth=false 时 Codex 用 experimental_bearer_token 直连,不需要 auth.json。
  // 诊断展示该字段,方便定位「全新安装无 auth.json 仍能登录」这类问题。
  const requiresOpenaiAuth = /^requires_openai_auth\s*=\s*true\s*$/m.test(cfgText);
  // model_catalog_json 缺失会导致选择器只剩内置 gpt 模型,必须存在且指向已有文件。
  const modelCatalogJson = cfgText.match(/^model_catalog_json\s*=\s*"([^"]+)"/m)?.[1] ?? null;
  return {
    codexHome: home,
    configExists: existsSync(path.join(home, "config.toml")),
    authJsonExists: authExists,
    requiresOpenaiAuth,
    modelCatalogJson,
    modelCatalogJsonExists: modelCatalogJson ? existsSync(modelCatalogJson) : false,
    provider: cfgText.match(/^model_provider\s*=\s*"([^"]+)"/m)?.[1] ?? null,
    model: cfgText.match(/^model\s*=\s*"([^"]+)"/m)?.[1] ?? null,
    providerConfigured: new RegExp(`^\\[model_providers\\.${escapeRegExp(providerName)}\\]\\s*$`, "m").test(cfgText),
    catalogPath,
    catalogCount: catalog.count,
    catalogList: catalog.list,
    catalogHide: catalog.hide,
  };
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
}
