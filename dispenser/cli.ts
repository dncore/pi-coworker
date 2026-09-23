#!/usr/bin/env node
/**
 * coworker 授权分发 CLI（auth-dispenser）——把公司网关（magene）/ 自定义 OpenAI 兼容网关
 * 接入本机其它 agent 工具（Codex / Claude Code / Reasonix / dsh / Grok Build / omp / OpenCode）。
 *
 * 移植来源：pi-agent-dispenser（lib/ 原样搬运：纯函数、无 pi 依赖；交互式 pi TUI 流程重写为
 * 「非交互命令 + JSON」，供 app 内置 agent 在对话里驱动）。设计见同目录 README.md。
 *
 * 命令（一律输出单行 JSON；人读摘要放 summary）：
 *   agents                            探测本机有哪些 agent（只读）
 *   status   --agent <id>             现状与问题（只读）
 *   plan     --agent <id> [...]       变更预览，不落盘（只读）
 *   apply    --agent <id> [...] --yes 落盘（写前自动备份）
 *   models   --agent <id> --yes       仅刷新模型列表
 *   restore  --agent <id> [--backup <文件>] --yes   还原（还原前再备份当前文件）
 *   backups  --agent <id>             列出可用备份（只读）
 *   repair   --agent <id> --yes       诊断并修复（= status 定位问题 + 幂等重写托管块）
 *   doctor                            凭证来源 + 网关连通性体检（只读）
 *
 * 门禁（写路径统一实现，见 commitWrites）：
 *   1. 写操作必须显式 --yes；缺失时返回 code=confirm_required 并附完整计划（供上层征求用户确认）；
 *   2. 写前自动备份，写后返回备份路径；密钥文件固定 0600 且不备份（避免凭据多副本）；
 *   3. 密钥只从环境变量 / 标准输入读取，任何输出一律掩码（另有全局兜底替换），绝不明文回显；
 *   4. 每次写操作追加审计 ~/.coworker/audit/dispenser.jsonl（不含密钥）；
 *   5. 幂等：重复 apply 无变更也不产生备份；只改「托管块/托管键」，用户其它配置原样保留。
 *
 * 退出码：0 成功；2 需确认（confirm_required）；1 失败。
 */
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readFileOrEmpty, restoreBackup, listBackups, writeWithBackup, upsertEnvKeyText } from "./lib/config-io.ts";
import { loadMageneCredentials } from "./lib/credentials.ts";
import { resolveMageneConfigFromSources, normalizeApiKey } from "./lib/core.ts";
import { buildResolvedModels, type ModelOverride, type ResolvedModel } from "./lib/model-resolution.ts";
import { fetchModelIds, pickDefaultModel, normalizeProviderName } from "./lib/custom-provider.ts";
import {
  CODEX_DEFAULT_MODEL,
  CODEX_OK_MODELS,
  CODEX_EXCLUDED_MODELS,
  codexHome,
  codexStatus,
  listCodexBackups,
  patchCodexConfigToml,
  readCodexConfigToml,
  restoreCodexBackup,
  syncCodexCatalog,
  writeCodexConfigToml,
} from "./lib/codex.ts";
import { deriveAnthropicUrl, formatClaudeModel, parseClaudeStatus, patchClaudeSettings } from "./lib/claude.ts";
import {
  REASONIX_API_KEY_ENV,
  patchReasonixModels,
  patchReasonixProvider,
  reasonixHome,
  reasonixStatus,
  readReasonixConfigToml,
  writeReasonixConfigToml,
  upsertReasonixEnvKey,
} from "./lib/reasonix.ts";
import {
  DSH_API_KEY_ENV,
  dshHome,
  dshStatus,
  patchDshDefaultModel,
  patchDshProvider,
  patchDshProviderModels,
  readDshCredentialsYaml,
  readDshSettingsYaml,
  upsertDshCredentialYaml,
  writeDshCredentials,
  writeDshSettings,
} from "./lib/dsh.ts";
import {
  GROK_BUILD_DEFAULT_MODEL,
  grokBuildHome,
  grokBuildStatus,
  patchGrokBuildConfigToml,
  patchGrokBuildModels,
  readGrokBuildConfigToml,
  writeGrokBuildConfigToml,
} from "./lib/grok-build.ts";
import { ompBaseUrl, parseOmpStatus, patchOmpConfigYml, patchOmpModelsList, patchOmpModelsYml } from "./lib/omp.ts";
import { parseOpenCodeStatus, patchOpenCodeAuth, patchOpenCodeConfig, patchOpenCodeModels } from "./lib/opencode.ts";

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): { command: string; flags: Flags } {
  const [command = "help", ...rest] = argv;
  const flags: Flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { command, flags };
}

function str(flags: Flags, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** 标准输入整读（密钥用 --api-key-stdin，避免进 argv / 进程表） */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8").trim();
}

// ---------------------------------------------------------------------------
// 输出 / 掩码 / 审计
// ---------------------------------------------------------------------------

let SECRET = ""; // 输出兜底：任何位置出现明文密钥一律替换成掩码
const OUT: Record<string, unknown> = {};

function mask(secret: string | null | undefined): string | null {
  if (!secret) return null;
  const s = String(secret);
  if (s.length <= 8) return "****";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function scrub<T>(value: T): T {
  if (!SECRET) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v.split(SECRET).join(mask(SECRET) ?? "****");
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

function emit(ok: boolean, extra: Record<string, unknown> = {}, exitCode?: number): void {
  process.stdout.write(JSON.stringify(scrub({ ok, ...OUT, ...extra })) + "\n");
  if (exitCode !== undefined) process.exitCode = exitCode;
}

function fail(code: string, message: string): void {
  emit(false, { code, message }, code === "confirm_required" ? 2 : 1);
}

const AUDIT_PATH = path.join(os.homedir(), ".coworker", "audit", "dispenser.jsonl");

/** 写操作审计（JSONL 追加；密钥永不入审计） */
async function audit(entry: Record<string, unknown>): Promise<void> {
  try {
    await mkdir(path.dirname(AUDIT_PATH), { recursive: true });
    await appendFile(AUDIT_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 });
  } catch {
    /* 审计失败不阻断操作 */
  }
}

// ---------------------------------------------------------------------------
// 网关凭证：环境变量 > app 隔离 pi 目录（magene-provider/.env > magene-credentials.json）> 系统 pi 目录
// ---------------------------------------------------------------------------

function piDirs(): string[] {
  const out: string[] = [];
  const envDir = process.env.PI_CODING_AGENT_DIR?.trim();
  if (envDir) out.push(envDir);
  out.push(path.join(os.homedir(), ".coworker", "pi-agent"));
  out.push(path.join(os.homedir(), ".pi", "agent"));
  return [...new Set(out)];
}

function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

interface Gateway {
  kind: "magene" | "custom";
  baseUrl: string;
  apiKey: string;
  /** 凭证来源（供汇报；不含密钥本身） */
  source: string;
  providerName: string;
  label: string;
}

async function resolveGateway(flags: Flags): Promise<Gateway> {
  const kind = str(flags, "gateway") === "custom" ? "custom" : "magene";
  const providerFlag = str(flags, "provider-name");
  const label = str(flags, "label") ?? (kind === "magene" ? "公司网关（magene）" : "自定义网关");

  const envBase = process.env.MAGENE_BASE_URL?.trim() ?? "";
  const envKey = normalizeApiKey(process.env.MAGENE_API_KEY);
  const flagBase = str(flags, "base-url") ?? "";
  const stdinKey = flags["api-key-stdin"] ? normalizeApiKey(await readStdin()) : "";

  if (kind === "custom") {
    const baseUrl = (flagBase || envBase).replace(/\/+$/, "");
    const apiKey = stdinKey || envKey;
    if (!baseUrl) throw new Error("自定义网关需要 --base-url（或在环境里设 MAGENE_BASE_URL）");
    if (!apiKey) throw new Error("自定义网关需要密钥：用 --api-key-stdin 从标准输入传入，或设环境变量 MAGENE_API_KEY（不要把密钥发到对话里）");
    return { kind, baseUrl, apiKey, source: stdinKey ? "stdin" : "env", providerName: normalizeProviderName(providerFlag ?? "custom"), label };
  }

  // magene：复用 app 已配置凭证（员工无需再次输入 Key）
  const providerName = providerFlag ?? "magene";
  if (envKey && envBase) return { kind, baseUrl: envBase.replace(/\/+$/, ""), apiKey: envKey, source: "env", providerName, label };
  for (const dir of piDirs()) {
    const envFile = path.join(dir, "extensions", "magene-provider", ".env");
    if (!existsSync(envFile)) continue;
    const kv = parseDotEnv(await readFileOrEmpty(envFile));
    const baseUrl = kv.MAGENE_BASE_URL?.trim() ?? "";
    const apiKey = normalizeApiKey(kv.MAGENE_API_KEY);
    if (baseUrl && apiKey) return { kind, baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, source: envFile, providerName, label };
  }
  for (const dir of piDirs()) {
    const credPath = path.join(dir, "magene-credentials.json");
    const creds = await loadMageneCredentials(credPath);
    if (!creds?.apiKey) continue;
    const cfg = resolveMageneConfigFromSources({ env: {}, envFile: {}, stored: creds, defaultBaseUrl: flagBase || "" });
    if (cfg.baseUrl && !cfg.baseUrl.includes("<") && cfg.apiKey) {
      return { kind, baseUrl: cfg.baseUrl.replace(/\/+$/, ""), apiKey: cfg.apiKey, source: credPath, providerName, label };
    }
  }
  throw new Error("未找到公司网关凭证：请先在 app 里完成「获取 API Key」（或让用户运行 coworker_magene_setup），再执行分发");
}

async function resolveGatewaySafe(flags: Flags): Promise<Gateway | null> {
  try {
    return await resolveGateway(flags);
  } catch {
    return null;
  }
}

/** 拉网关模型 + 解析元数据（overrides 优先，未命中的按 known / 按 id 推断） */
async function loadModels(gateway: Gateway): Promise<ResolvedModel[]> {
  const ids = await fetchModelIds(gateway.baseUrl, gateway.apiKey);
  let overrides: Record<string, ModelOverride> = {};
  for (const dir of piDirs()) {
    const p = path.join(dir, "magene-model-overrides.json");
    if (!existsSync(p)) continue;
    try {
      overrides = JSON.parse(await readFile(p, "utf8")) as Record<string, ModelOverride>;
      break;
    } catch {
      /* 坏文件忽略 */
    }
  }
  return buildResolvedModels(ids, overrides).map((x) => x.model);
}

// ---------------------------------------------------------------------------
// Agent 注册表
// ---------------------------------------------------------------------------

type AgentId = "codex" | "claude" | "reasonix" | "dsh" | "grok" | "omp" | "opencode";

const AGENT_IDS: AgentId[] = ["codex", "claude", "reasonix", "dsh", "grok", "omp", "opencode"];
const ROLES = ["haiku", "sonnet", "opus", "fable", "subagent"] as const;
type Role = (typeof ROLES)[number];

const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const OMP_MODELS_PATH = path.join(os.homedir(), ".omp", "agent", "models.yml");
const OMP_CONFIG_PATH = path.join(os.homedir(), ".omp", "agent", "config.yml");
const OPENCODE_CONFIG_PATH = path.join(os.homedir(), ".config", "opencode", "opencode.json");
const OPENCODE_AUTH_PATH = path.join(os.homedir(), ".local", "share", "opencode", "auth.json");

function onPath(bin: string): boolean {
  const dirs = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
  const exts = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  return dirs.some((d) => d && exts.some((e) => existsSync(path.join(d, bin + e))));
}

interface AgentProbe {
  installed: boolean;
  evidence: string;
  configFiles: string[];
}

function probe(id: AgentId): AgentProbe {
  const home = os.homedir();
  const cliOrDir = (bin: string, dir: string): { installed: boolean; evidence: string } => {
    if (onPath(bin)) return { installed: true, evidence: `PATH 上有 ${bin}` };
    if (existsSync(dir)) return { installed: true, evidence: `配置目录 ${dir}` };
    return { installed: false, evidence: "未发现" };
  };
  const dirOf = (p: string): string => path.dirname(p);
  switch (id) {
    case "codex": {
      const dir = codexHome();
      return { ...cliOrDir("codex", dir), configFiles: [path.join(dir, "config.toml"), path.join(dir, "models.json")] };
    }
    case "claude":
      return { ...cliOrDir("claude", path.join(home, ".claude")), configFiles: [CLAUDE_SETTINGS_PATH] };
    case "reasonix": {
      const dir = reasonixHome();
      return { ...cliOrDir("reasonix", dir), configFiles: [path.join(dir, "config.toml"), path.join(dir, ".env")] };
    }
    case "dsh": {
      const dir = dshHome();
      return { ...cliOrDir("dsh", dir), configFiles: [path.join(dir, "settings.yaml"), path.join(dir, ".credentials.yaml")] };
    }
    case "grok": {
      const dir = grokBuildHome();
      return { ...cliOrDir("grok", dir), configFiles: [path.join(dir, "config.toml")] };
    }
    case "omp":
      return { ...cliOrDir("omp", dirOf(OMP_MODELS_PATH)), configFiles: [OMP_MODELS_PATH, OMP_CONFIG_PATH] };
    case "opencode":
      return { ...cliOrDir("opencode", dirOf(OPENCODE_CONFIG_PATH)), configFiles: [OPENCODE_CONFIG_PATH, OPENCODE_AUTH_PATH] };
  }
}

// ---------------------------------------------------------------------------
// 计划/状态的数据结构
// ---------------------------------------------------------------------------

/** 一个待写入项：commit 为空走通用「备份后写」；secret=true 固定 0600 且不备份 */
interface WritePlan {
  path: string;
  changes: string[];
  text?: string;
  secret?: boolean;
  /** lib 自带写入器（含备份语义）优先 */
  commit?: () => Promise<{ path: string; backup?: string }>;
}

interface StatusReport {
  status: Record<string, unknown>;
  issues: string[];
  /** 配置文件损坏（非法 JSON 等），脚本无法安全改写——只能还原 */
  blocked?: boolean;
}

interface Outcome {
  summary: string;
  writes: WritePlan[];
  status: Record<string, unknown>;
  issues: string[];
  nextSteps: string[];
  blocked?: boolean;
  /** 计划外的写盘（自带备份逻辑），apply 时执行 */
  applyExtra?: () => Promise<string[]>;
}

function jsonValid(text: string): boolean {
  if (!text.trim()) return true;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 现状（只读；不需要凭证）
// ---------------------------------------------------------------------------

async function collectStatus(id: AgentId, providerName: string): Promise<StatusReport> {
  switch (id) {
    case "codex": {
      const s = await codexStatus(providerName);
      const issues: string[] = [];
      if (!s.providerConfigured) issues.push(`未配置 provider「${providerName}」（model_providers 段缺失）`);
      if (!s.modelCatalogJson) issues.push("config.toml 缺 model_catalog_json（Codex 选择器会只剩内置 gpt 模型）");
      else if (!s.modelCatalogJsonExists) issues.push(`model_catalog_json 指向的文件不存在：${s.modelCatalogJson}`);
      if (s.requiresOpenaiAuth) issues.push("requires_openai_auth=true：会强制走 ChatGPT 登录，应置 false");
      if (s.catalogCount === 0) issues.push("models.json 为空或缺失（Codex 选不到网关模型）");
      return { status: s as unknown as Record<string, unknown>, issues };
    }
    case "claude": {
      const text = await readFileOrEmpty(CLAUDE_SETTINGS_PATH);
      const s = parseClaudeStatus(text);
      const issues: string[] = [];
      if (text.trim() && !jsonValid(text)) {
        issues.push("settings.json 不是合法 JSON（Claude Code 会忽略全部配置）");
        return { status: { settingsPath: CLAUDE_SETTINGS_PATH, invalidJson: true }, issues, blocked: true };
      }
      if (!s.settingsExists) issues.push("settings.json 不存在（Claude Code 未接入网关）");
      if (!s.baseUrl) issues.push("未设置 ANTHROPIC_BASE_URL");
      if (!s.authTokenSet) issues.push("未设置 ANTHROPIC_AUTH_TOKEN");
      return { status: s as unknown as Record<string, unknown>, issues };
    }
    case "reasonix": {
      const s = await reasonixStatus(providerName);
      const issues: string[] = [];
      if (!s.providerConfigured) issues.push(`未配置 provider「${providerName}」`);
      else if (s.providerModels === 0) issues.push("provider 模型列表为空");
      if (!s.providerKeyInEnvFile) issues.push(`凭据 .env 缺 ${REASONIX_API_KEY_ENV}`);
      return { status: s as unknown as Record<string, unknown>, issues };
    }
    case "dsh": {
      const s = await dshStatus(providerName, DSH_API_KEY_ENV);
      const issues: string[] = [];
      if (!s.providerConfigured) issues.push(`未配置 provider「${providerName}」`);
      else if (s.providerModels === 0) issues.push("provider 模型列表为空");
      if (!s.credentialStored) issues.push(`凭据文件缺 ${DSH_API_KEY_ENV}`);
      return { status: s as unknown as Record<string, unknown>, issues };
    }
    case "grok": {
      const s = await grokBuildStatus(providerName);
      const issues: string[] = [];
      if (!s.providerConfigured) issues.push(`未配置 provider「${providerName}」`);
      else if (s.providerModels === 0) issues.push("provider 模型列表为空");
      if (s.providerConfigured && !s.providerApiKeySet) issues.push("provider 缺 api key");
      return { status: s as unknown as Record<string, unknown>, issues };
    }
    case "omp": {
      const modelsYml = await readFileOrEmpty(OMP_MODELS_PATH);
      const configYml = await readFileOrEmpty(OMP_CONFIG_PATH);
      const s = parseOmpStatus(modelsYml, configYml, providerName);
      const issues: string[] = [];
      if (!s.modelsExists) issues.push(`models.yml 不存在（${OMP_MODELS_PATH}）`);
      if (s.providerModels === 0) issues.push(`provider「${providerName}」模型列表为空或未配置`);
      return { status: s as unknown as Record<string, unknown>, issues };
    }
    case "opencode": {
      const configText = await readFileOrEmpty(OPENCODE_CONFIG_PATH);
      const authText = await readFileOrEmpty(OPENCODE_AUTH_PATH);
      if (configText.trim() && !jsonValid(configText)) {
        return { status: { invalidJson: true, configPath: OPENCODE_CONFIG_PATH }, issues: ["opencode.json 不是合法 JSON"], blocked: true };
      }
      const s = parseOpenCodeStatus(configText, authText, providerName);
      const issues: string[] = [];
      if (!s.configExists) issues.push("opencode.json 不存在");
      if (!s.providerConfigured) issues.push(`未配置 provider「${providerName}」`);
      else if (s.providerModels === 0) issues.push("provider 模型列表为空");
      if (s.providerConfigured && !s.keySet) issues.push("auth.json 缺该 provider 的凭据");
      return { status: s as unknown as Record<string, unknown>, issues };
    }
  }
}

// ---------------------------------------------------------------------------
// 接入计划（只读；plan/apply/repair 共用）
// ---------------------------------------------------------------------------

interface PlanOpts {
  mainModel?: string;
  roleModels?: Partial<Record<Role, string>>;
}

function pickMainModel(models: ResolvedModel[], preferred?: string, fallback?: string): string {
  const ids = models.map((m) => m.id);
  if (preferred && ids.includes(preferred)) return preferred;
  return pickDefaultModel(ids, fallback) || ids[0] || "";
}

async function buildPlan(id: AgentId, gateway: Gateway, models: ResolvedModel[], opts: PlanOpts): Promise<Outcome> {
  const st = await collectStatus(id, gateway.providerName);
  if (st.blocked) {
    return { summary: `${id} 配置文件损坏，无法安全改写（请先还原或人工修复）`, writes: [], status: st.status, issues: st.issues, nextSteps: ["用 restore 还原备份后重试"], blocked: true };
  }
  const p = gateway.providerName;
  const isMagene = gateway.kind === "magene";

  switch (id) {
    case "codex": {
      const cfgPath = path.join(codexHome(), "config.toml");
      const patched = patchCodexConfigToml(await readCodexConfigToml(), gateway.baseUrl, gateway.apiKey, {
        provider: p,
        defaultModel: opts.mainModel || CODEX_DEFAULT_MODEL,
        alwaysSetModel: !isMagene,
      });
      const writes: WritePlan[] = [];
      if (patched.changes.length) {
        writes.push({ path: cfgPath, changes: patched.changes, text: patched.text, commit: () => writeCodexConfigToml(patched.text) });
      }
      let catalogNote = "";
      const applyExtra = async (): Promise<string[]> => {
        const r = await syncCodexCatalog(models as unknown as Parameters<typeof syncCodexCatalog>[0], {
          providerLabel: isMagene ? "Magene" : gateway.label,
          okOverride: isMagene ? CODEX_OK_MODELS : undefined,
          excluded: isMagene ? CODEX_EXCLUDED_MODELS : new Set<string>(),
          keepOthers: true,
        });
        return [`models.json：可见 ${r.list} / 隐藏 ${r.hide}${r.backup ? `（备份 ${path.basename(r.backup)}）` : "（无变化，未写）"}${r.kept ? `；保留原有其它条目 ${r.kept}` : ""}`];
      };
      // 计划预览用 dryRun（不落盘）
      const dry = await syncCodexCatalog(models as unknown as Parameters<typeof syncCodexCatalog>[0], {
        dryRun: true,
        providerLabel: isMagene ? "Magene" : gateway.label,
        okOverride: isMagene ? CODEX_OK_MODELS : undefined,
        excluded: isMagene ? CODEX_EXCLUDED_MODELS : new Set<string>(),
        keepOthers: true,
      });
      catalogNote = `models.json：可见 ${dry.list} / 隐藏 ${dry.hide}（白名单）`;
      return {
        summary: `Codex：${patched.changes.length ? patched.changes.join("；") : "config.toml 无变化"}；${catalogNote}`,
        writes,
        applyExtra,
        status: st.status,
        issues: st.issues,
        nextSteps: ["重启 Codex 生效（选择器里选网关模型）"],
      };
    }

    case "claude": {
      const original = await readFileOrEmpty(CLAUDE_SETTINGS_PATH);
      const main = pickMainModel(models, opts.mainModel);
      if (!main) throw new Error("网关模型列表为空，无法配置 Claude Code");
      const cw = new Map(models.map((m) => [m.id, m.contextWindow]));
      const fmt = (v: string): string => formatClaudeModel(v, cw.get(v) ?? 0);
      const roleOf = (r: Role): string => fmt(opts.roleModels?.[r] || main);
      const mainCw = cw.get(main) ?? 0;
      const patched = patchClaudeSettings(original, {
        anthropicBaseUrl: deriveAnthropicUrl(gateway.baseUrl),
        apiKey: gateway.apiKey,
        mainModel: fmt(main),
        roles: { haiku: roleOf("haiku"), sonnet: roleOf("sonnet"), opus: roleOf("opus"), fable: roleOf("fable"), subagent: roleOf("subagent") },
        maxContextTokens: mainCw > 0 && mainCw < 200_000 ? mainCw : undefined,
      });
      const writes: WritePlan[] = patched.changes.length ? [{ path: CLAUDE_SETTINGS_PATH, changes: patched.changes, text: patched.text }] : [];
      return {
        summary: `Claude Code：主模型 ${fmt(main)}，Anthropic 端点 ${deriveAnthropicUrl(gateway.baseUrl)}；${patched.changes.length ? `${patched.changes.length} 项变更` : "无变化"}`,
        writes,
        status: st.status,
        issues: st.issues,
        nextSteps: ["新开终端重启 claude 生效"],
      };
    }

    case "reasonix": {
      const cfgPath = path.join(reasonixHome(), "config.toml");
      const envPath = path.join(reasonixHome(), ".env");
      const main = pickMainModel(models, opts.mainModel);
      const modelContexts = Object.fromEntries(models.map((m) => [m.id, m.contextWindow]));
      const patched = patchReasonixProvider(await readReasonixConfigToml(), {
        providerName: p,
        baseUrl: gateway.baseUrl,
        apiKeyEnv: REASONIX_API_KEY_ENV,
        modelIds: models.map((m) => m.id),
        defaultModel: main,
        modelContexts,
      });
      const writes: WritePlan[] = [];
      if (patched.changes.length) writes.push({ path: cfgPath, changes: patched.changes, text: patched.text, commit: () => writeReasonixConfigToml(patched.text) });
      writes.push({
        path: envPath,
        changes: [`${REASONIX_API_KEY_ENV} 写入/确认（幂等，值不回显）`],
        secret: true,
        commit: async () => ({ path: (await upsertReasonixEnvKey(REASONIX_API_KEY_ENV, gateway.apiKey)).path }),
      });
      return {
        summary: `Reasonix：provider=${p}，模型 ${models.length} 个，默认 ${main || "(未选)"}`,
        writes,
        status: st.status,
        issues: st.issues,
        nextSteps: ["重启 reasonix 生效"],
      };
    }

    case "dsh": {
      const settingsPath = path.join(dshHome(), "settings.yaml");
      const main = pickMainModel(models, opts.mainModel, CODEX_DEFAULT_MODEL);
      const patched = patchDshProvider(await readDshSettingsYaml(), {
        providerName: p,
        displayName: gateway.label,
        apiKeyEnv: DSH_API_KEY_ENV,
        baseUrl: gateway.baseUrl,
        models: models.map((m) => ({
          id: m.id,
          name: m.name,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          reasoning: m.reasoning,
          input: m.input.includes("image") ? ["text", "image"] : undefined,
        })),
      });
      const withDefault = patchDshDefaultModel(patched.text, p, main);
      const changes = [...patched.changes, ...withDefault.changes];
      const writes: WritePlan[] = [];
      if (changes.length) writes.push({ path: settingsPath, changes, text: withDefault.text, commit: () => writeDshSettings(withDefault.text) });
      const credText = upsertDshCredentialYaml(await readDshCredentialsYaml(), DSH_API_KEY_ENV, gateway.apiKey);
      writes.push({ path: path.join(dshHome(), ".credentials.yaml"), changes: [`${DSH_API_KEY_ENV} 写入/确认（0600，值不回显）`], secret: true, commit: () => writeDshCredentials(credText.text) });
      return {
        summary: `DeepSeek Harness：provider=${p}，模型 ${models.length} 个，默认 ${main}`,
        writes,
        status: st.status,
        issues: st.issues,
        nextSteps: ["重启 dsh 生效"],
      };
    }

    case "grok": {
      const cfgPath = path.join(grokBuildHome(), "config.toml");
      const main = pickMainModel(models, opts.mainModel, GROK_BUILD_DEFAULT_MODEL);
      const patched = patchGrokBuildConfigToml(await readGrokBuildConfigToml(), {
        providerName: p,
        label: isMagene ? "magene" : gateway.label,
        baseUrl: gateway.baseUrl,
        apiKey: gateway.apiKey,
        defaultModel: main,
        models: models.map((m) => ({ id: m.id, contextWindow: m.contextWindow, maxTokens: m.maxTokens })),
      });
      const writes: WritePlan[] = patched.changes.length ? [{ path: cfgPath, changes: patched.changes, text: patched.text, commit: () => writeGrokBuildConfigToml(patched.text) }] : [];
      return {
        summary: `Grok Build：provider=${p}，模型 ${models.length} 个，默认 ${main}`,
        writes,
        status: st.status,
        issues: st.issues,
        nextSteps: ["重启 grok 生效"],
      };
    }

    case "omp": {
      const main = pickMainModel(models, opts.mainModel);
      const p1 = patchOmpModelsYml(await readFileOrEmpty(OMP_MODELS_PATH), { providerName: p, baseUrl: ompBaseUrl(gateway.baseUrl), apiKey: gateway.apiKey, models });
      const p2 = patchOmpConfigYml(await readFileOrEmpty(OMP_CONFIG_PATH), p, main);
      const writes: WritePlan[] = [];
      if (p1.changes.length) writes.push({ path: OMP_MODELS_PATH, changes: p1.changes, text: p1.text });
      if (p2.changes.length) writes.push({ path: OMP_CONFIG_PATH, changes: p2.changes, text: p2.text });
      return {
        summary: `omp：providers.${p}，模型 ${models.length} 个，默认 ${p}/${main}`,
        writes,
        status: st.status,
        issues: st.issues,
        nextSteps: [`omp --model ${p}/${main}`],
      };
    }

    case "opencode": {
      const main = pickMainModel(models, opts.mainModel);
      const p1 = patchOpenCodeConfig(await readFileOrEmpty(OPENCODE_CONFIG_PATH), {
        providerName: p,
        displayName: gateway.label,
        baseUrl: gateway.baseUrl,
        models,
        defaultModel: main,
      });
      const p2 = patchOpenCodeAuth(await readFileOrEmpty(OPENCODE_AUTH_PATH), p, gateway.apiKey);
      const writes: WritePlan[] = [];
      if (p1.changes.length) writes.push({ path: OPENCODE_CONFIG_PATH, changes: p1.changes, text: p1.text });
      if (p2.changes.length) writes.push({ path: OPENCODE_AUTH_PATH, changes: [`provider.${p} 凭据写入/确认（0600，值不回显）`], secret: true, text: p2.text });
      return {
        summary: `OpenCode：provider.${p}，模型 ${models.length} 个，默认 ${p}/${main}`,
        writes,
        status: st.status,
        issues: st.issues,
        nextSteps: ["重启 opencode 生效"],
      };
    }
  }
}

/** 仅刷新模型列表：只动模型条目，provider/凭据/默认模型结构不变 */
async function buildModelsOnlyPlan(id: AgentId, gateway: Gateway, models: ResolvedModel[]): Promise<Outcome> {
  const st = await collectStatus(id, gateway.providerName);
  if (st.blocked) return { summary: `${id} 配置文件损坏，无法安全改写`, writes: [], status: st.status, issues: st.issues, nextSteps: ["用 restore 还原备份后重试"], blocked: true };
  const p = gateway.providerName;

  switch (id) {
    case "codex": {
      const applyExtra = async (): Promise<string[]> => {
        const r = await syncCodexCatalog(models as unknown as Parameters<typeof syncCodexCatalog>[0], { refresh: true, providerLabel: gateway.kind === "magene" ? "Magene" : gateway.label });
        return [`models.json 增量刷新：可见 ${r.list} / 隐藏 ${r.hide}${r.added.length ? `，新增 ${r.added.length}` : ""}${r.removed.length ? `，下架移除 ${r.removed.length}` : ""}`];
      };
      return { summary: `Codex 模型目录：增量刷新（网关 ${models.length} 个模型）`, writes: [], applyExtra, status: st.status, issues: st.issues, nextSteps: [] };
    }
    case "reasonix": {
      const cfgPath = path.join(reasonixHome(), "config.toml");
      const r = patchReasonixModels(await readReasonixConfigToml(), { providerName: p, modelIds: models.map((m) => m.id), modelContexts: Object.fromEntries(models.map((m) => [m.id, m.contextWindow])) });
      if (!r.providerFound) throw new Error(`reasonix provider「${p}」未配置，无法仅更新模型（先 apply）`);
      const writes: WritePlan[] = r.changes.length ? [{ path: cfgPath, changes: r.changes, text: r.text, commit: () => writeReasonixConfigToml(r.text) }] : [];
      return { summary: `Reasonix 模型列表：${r.changes.length ? "更新" : "无变化"}（${models.length} 个）`, writes, status: st.status, issues: st.issues, nextSteps: [] };
    }
    case "dsh": {
      const settingsPath = path.join(dshHome(), "settings.yaml");
      const r = patchDshProviderModels(await readDshSettingsYaml(), {
        providerName: p,
        models: models.map((m) => ({ id: m.id, name: m.name, contextWindow: m.contextWindow, maxTokens: m.maxTokens, reasoning: m.reasoning })),
      });
      if (!r.providerFound) throw new Error(`dsh provider「${p}」未配置，无法仅更新模型（先 apply）`);
      const writes: WritePlan[] = r.changes.length ? [{ path: settingsPath, changes: r.changes, text: r.text, commit: () => writeDshSettings(r.text) }] : [];
      return { summary: `dsh 模型列表：${r.changes.length ? "更新" : "无变化"}（${models.length} 个）`, writes, status: st.status, issues: st.issues, nextSteps: [] };
    }
    case "grok": {
      const cfgPath = path.join(grokBuildHome(), "config.toml");
      const r = patchGrokBuildModels(await readGrokBuildConfigToml(), { providerName: p, label: gateway.kind === "magene" ? "magene" : gateway.label, models: models.map((m) => ({ id: m.id, contextWindow: m.contextWindow, maxTokens: m.maxTokens })) });
      if (!r.providerFound) throw new Error(`grok provider「${p}」未配置，无法仅更新模型（先 apply）`);
      const writes: WritePlan[] = r.changes.length ? [{ path: cfgPath, changes: r.changes, text: r.text, commit: () => writeGrokBuildConfigToml(r.text) }] : [];
      return { summary: `grok-build 模型列表：${r.changes.length ? "更新" : "无变化"}（${models.length} 个）`, writes, status: st.status, issues: st.issues, nextSteps: [] };
    }
    case "omp": {
      const r = patchOmpModelsList(await readFileOrEmpty(OMP_MODELS_PATH), { providerName: p, models });
      if (!r.providerFound) throw new Error(`omp providers.${p} 未配置，无法仅更新模型（先 apply）`);
      const writes: WritePlan[] = r.changes.length ? [{ path: OMP_MODELS_PATH, changes: r.changes, text: r.text }] : [];
      return { summary: `omp 模型列表：${r.changes.length ? "更新" : "无变化"}（${models.length} 个）`, writes, status: st.status, issues: st.issues, nextSteps: [] };
    }
    case "opencode": {
      const r = patchOpenCodeModels(await readFileOrEmpty(OPENCODE_CONFIG_PATH), { providerName: p, models });
      if (!r.providerFound) throw new Error(`opencode provider.${p} 未配置，无法仅更新模型（先 apply）`);
      const writes: WritePlan[] = r.changes.length ? [{ path: OPENCODE_CONFIG_PATH, changes: r.changes, text: r.text }] : [];
      return { summary: `opencode 模型列表：${r.changes.length ? "更新" : "无变化"}（${models.length} 个）`, writes, status: st.status, issues: st.issues, nextSteps: [] };
    }
    case "claude":
      throw new Error("Claude Code 的模型名写在 settings.json 的 env 里（含上下文后缀），没有独立模型列表；请用 apply 重配");
  }
}

// ---------------------------------------------------------------------------
// 写门禁：统一「备份 → 写 → 审计」
// ---------------------------------------------------------------------------

async function commitWrites(agent: AgentId, command: string, writes: WritePlan[], gateway: Gateway): Promise<string[]> {
  const lines: string[] = [];
  for (const w of writes) {
    if (w.commit) {
      const r = await w.commit();
      lines.push(`${path.basename(w.path)}：${w.changes.join("；")}${r.backup ? `（备份 ${path.basename(r.backup)}）` : w.secret ? "（0600，不备份）" : ""}`);
      continue;
    }
    if (!w.text) continue;
    if (w.secret) {
      const { writeSecretFile } = await import("./lib/config-io.ts");
      await writeSecretFile(w.path, w.text);
      lines.push(`${path.basename(w.path)}：${w.changes.join("；")}（0600，不备份）`);
      continue;
    }
    const r = await writeWithBackup(w.path, w.text);
    lines.push(`${path.basename(w.path)}：${w.changes.join("；")}${r.backup ? `（备份 ${path.basename(r.backup)}）` : ""}`);
  }
  await audit({ action: command, agent, gateway: gateway.kind, baseUrl: gateway.baseUrl, credSource: gateway.source, files: writes.map((w) => w.path) });
  return lines;
}

// ---------------------------------------------------------------------------
// 命令实现
// ---------------------------------------------------------------------------

async function cmdAgents(): Promise<void> {
  const list = AGENT_IDS.map((id) => ({ id, ...probe(id) }));
  const found = list.filter((a) => a.installed).map((a) => a.id);
  emit(true, { command: "agents", agents: list, summary: `发现 ${found.length}/${list.length} 个 agent：${found.join(", ") || "无"}` });
}

function requireAgent(flags: Flags): AgentId {
  const id = str(flags, "agent") as AgentId | undefined;
  if (!id || !AGENT_IDS.includes(id)) throw new Error(`需要 --agent <${AGENT_IDS.join("|")}>`);
  return id;
}

async function cmdStatus(flags: Flags): Promise<void> {
  const agent = requireAgent(flags);
  const providerName = str(flags, "provider-name") ?? "magene";
  const st = await collectStatus(agent, providerName);
  const probeInfo = probe(agent);
  emit(true, {
    command: "status",
    agent,
    installed: probeInfo.installed,
    evidence: probeInfo.evidence,
    configFiles: probeInfo.configFiles,
    checkedProvider: providerName,
    status: st.status,
    issues: st.issues,
    blocked: st.blocked ?? false,
    summary: `【${agent}】${probeInfo.evidence}；${st.issues.length ? `发现 ${st.issues.length} 个问题：${st.issues.join("；")}` : "未发现配置问题"}`,
  });
}

async function cmdPlanApplyModels(command: "plan" | "apply" | "models", flags: Flags): Promise<void> {
  const agent = requireAgent(flags);
  const gateway = await resolveGateway(flags);
  SECRET = gateway.apiKey;
  const models = await loadModels(gateway);
  if (!models.length) throw new Error("网关返回的模型列表为空，无法配置（确认网关可达 / Key 有效）");

  const opts: PlanOpts = {
    mainModel: str(flags, "main-model"),
    roleModels: Object.fromEntries(ROLES.map((r) => [r, str(flags, `${r}-model`)]).filter(([, v]) => v)) as Partial<Record<Role, string>>,
  };
  const outcome = command === "models" ? await buildModelsOnlyPlan(agent, gateway, models) : await buildPlan(agent, gateway, models, opts);

  const base = {
    command,
    agent,
    gateway: { kind: gateway.kind, baseUrl: gateway.baseUrl, apiKeyMasked: mask(gateway.apiKey), source: gateway.source, provider: gateway.providerName },
    modelsFromGateway: models.length,
    plan: outcome.writes.map((w) => ({ path: w.path, changes: w.changes })),
    status: outcome.status,
    issues: outcome.issues,
    nextSteps: outcome.nextSteps,
  };

  if (command === "plan") {
    emit(true, { ...base, summary: `${outcome.summary}。${outcome.writes.length ? `将写入 ${outcome.writes.length} 个文件（写前备份）` : "无需写入（已是最新）"}` });
    return;
  }
  if (flags.yes !== true) {
    emit(false, { ...base, code: "confirm_required", message: `写操作需用户确认：${outcome.writes.length} 项变更。请把 plan 摘要给用户确认后，加 --yes 重试。`, summary: outcome.summary }, 2);
    return;
  }

  const written = await commitWrites(agent, command, outcome.writes, gateway);
  const extra = outcome.applyExtra ? await outcome.applyExtra() : [];
  await audit({ action: `${command}:done`, agent, filesChanged: written.length });
  emit(true, {
    ...base,
    written,
    extra,
    summary: `${outcome.writes.length ? `已写入 ${outcome.writes.length} 个文件（写前已备份）：` : "无变化，未写入："}${[...written, ...extra].join("；") || outcome.summary}`,
  });
}

async function cmdBackups(flags: Flags): Promise<void> {
  const agent = requireAgent(flags);
  const files = probe(agent).configFiles;
  const out: Array<{ path: string; backups: Array<{ name: string; size: number; mtime: string }> }> = [];
  for (const f of files) {
    if (agent === "codex") {
      const bs = (await listCodexBackups()).filter((b) => b.path.startsWith(codexHome()) && path.basename(b.path).startsWith(path.basename(f)));
      out.push({ path: f, backups: bs.map((b) => ({ name: b.label, size: b.size, mtime: new Date(b.mtimeMs).toISOString() })) });
      continue;
    }
    const bs = await listBackups(f);
    out.push({ path: f, backups: bs.map((b) => ({ name: b.name, size: b.size, mtime: new Date(b.mtimeMs).toISOString() })) });
  }
  const total = out.reduce((n, x) => n + x.backups.length, 0);
  const sample = out.flatMap((x) => x.backups.slice(0, 2).map((b) => `${path.basename(x.path)}←${b.name}`));
  emit(true, {
    command: "backups",
    agent,
    files: out,
    summary: total ? `${agent} 共 ${total} 个备份，最近：${sample.slice(0, 3).join("，")}${sample.length > 3 ? " …" : ""}` : `${agent} 没有可用备份`,
  });
}

async function cmdRestore(flags: Flags): Promise<void> {
  const agent = requireAgent(flags);
  const files = probe(agent).configFiles;
  const want = str(flags, "backup");
  const targets: Array<{ target: string; backup: string; name: string }> = [];
  for (const f of files) {
    const backups = agent === "codex"
      ? (await listCodexBackups()).filter((b) => path.basename(b.path).startsWith(path.basename(f))).map((b) => ({ path: b.path, name: b.label }))
      : (await listBackups(f)).map((b) => ({ path: b.path, name: b.name }));
    const hit = want ? backups.find((b) => b.name === want || b.path === want) : backups[0];
    if (hit) targets.push({ target: f, backup: hit.path, name: hit.name });
  }
  if (!targets.length) {
    emit(false, { command: "restore", agent, code: "no_backup", message: `${agent} 没有可用备份${want ? `（未找到 ${want}）` : ""}；未做任何改动` }, 1);
    return;
  }
  const plan = targets.map((t) => ({ file: t.target, from: t.name }));
  if (flags.yes !== true) {
    emit(false, { command: "restore", agent, code: "confirm_required", plan, message: "还原会覆盖当前配置（覆盖前自动再备份一份）。请向用户确认后加 --yes。" }, 2);
    return;
  }
  const done: string[] = [];
  for (const t of targets) {
    if (agent === "codex") await restoreCodexBackup(t.backup);
    else await restoreBackup(t.target, t.backup);
    done.push(`${path.basename(t.target)} ← ${t.name}`);
  }
  await audit({ action: "restore", agent, restored: done });
  emit(true, { command: "restore", agent, restored: done, summary: `已还原：${done.join("；")}（还原前的当前文件已再备份为 .bak-pre-restore-*）` });
}

async function cmdRepair(flags: Flags): Promise<void> {
  const agent = requireAgent(flags);
  const before = await collectStatus(agent, str(flags, "provider-name") ?? "magene");
  if (before.blocked) {
    const files = probe(agent).configFiles;
    const backups = (await Promise.all(files.map((f) => listBackups(f)))).flat().slice(0, 3).map((b) => b.name);
    emit(false, {
      command: "repair",
      agent,
      code: "needs_restore",
      issues: before.issues,
      backups,
      message: "配置文件不是合法 JSON，脚本无法安全改写。请先还原备份（restore），或让用户人工修复后重试。",
    }, 1);
    return;
  }
  if (!before.issues.length) {
    emit(true, { command: "repair", agent, issuesBefore: [], issuesRemaining: [], changed: false, summary: `${agent} 未发现需要修复的问题` });
    return;
  }
  const gateway = await resolveGateway(flags);
  SECRET = gateway.apiKey;
  const models = await loadModels(gateway);
  const outcome = await buildPlan(agent, gateway, models, { mainModel: str(flags, "main-model") });
  const base = {
    command: "repair",
    agent,
    issuesBefore: before.issues,
    plan: outcome.writes.map((w) => ({ path: w.path, changes: w.changes })),
    summary: `发现 ${before.issues.length} 个问题：${before.issues.join("；")}；计划重写 ${outcome.writes.length} 个文件的托管块（幂等，写前备份）`,
  };
  if (flags.yes !== true) {
    emit(false, { ...base, code: "confirm_required", message: "修复会重写托管块（只动托管键，写前备份）。请确认后加 --yes。" }, 2);
    return;
  }
  const written = await commitWrites(agent, "repair", outcome.writes, gateway);
  const extra = outcome.applyExtra ? await outcome.applyExtra() : [];
  const after = await collectStatus(agent, gateway.providerName);
  await audit({ action: "repair:done", agent, remainingIssues: after.issues });
  emit(true, {
    ...base,
    written,
    extra,
    issuesRemaining: after.issues,
    summary: `修复完成：${[...written, ...extra].join("；") || "无写入"}；剩余问题 ${after.issues.length} 个${after.issues.length ? `（${after.issues.join("；")}）` : ""}`,
  });
}

async function cmdDoctor(flags: Flags): Promise<void> {
  let gateway: Gateway;
  try {
    gateway = await resolveGateway(flags);
  } catch (e: unknown) {
    // 保留具体原因（缺 key / 缺 base-url / 未取过 Key），不要笼统报「无凭证」
    emit(false, { command: "doctor", code: "no_credentials", message: e instanceof Error ? e.message : String(e) }, 1);
    return;
  }
  SECRET = gateway.apiKey;
  let models: string[] = [];
  let error = "";
  try {
    models = await fetchModelIds(gateway.baseUrl, gateway.apiKey);
  } catch (e: unknown) {
    error = e instanceof Error ? e.message : String(e);
  }
  const reachable = !error;
  const found = AGENT_IDS.filter((id) => probe(id).installed);
  emit(reachable, {
    command: "doctor",
    gateway: { kind: gateway.kind, baseUrl: gateway.baseUrl, apiKeyMasked: mask(gateway.apiKey), source: gateway.source },
    reachable,
    models: models.length,
    sample: models.slice(0, 5),
    error: error || undefined,
    agents: AGENT_IDS.map((id) => ({ id, ...probe(id) })),
    summary: reachable
      ? `网关可达（${gateway.baseUrl}，凭证来源 ${gateway.source}，模型 ${models.length} 个）；本机 agent：${found.join(", ") || "无"}`
      : `网关不可达：${error}`,
  }, reachable ? 0 : 1);
}

function usage(): void {
  emit(false, {
    command: "help",
    usage: [
      "node cli.ts agents",
      "node cli.ts doctor",
      "node cli.ts status  --agent <codex|claude|reasonix|dsh|grok|omp|opencode>",
      "node cli.ts plan    --agent <id> [--gateway magene|custom] [--base-url U] [--main-model M] [--haiku-model M …]",
      "node cli.ts apply   --agent <id> … --yes",
      "node cli.ts models  --agent <id> --yes",
      "node cli.ts backups --agent <id>",
      "node cli.ts restore --agent <id> [--backup <文件>] --yes",
      "node cli.ts repair  --agent <id> --yes",
    ],
    summary: "授权分发 CLI：把公司网关接入本机其它 agent（只读命令无需 --yes；写命令必须 --yes）",
  }, 1);
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "agents": return cmdAgents();
    case "doctor": return cmdDoctor(flags);
    case "status": return cmdStatus(flags);
    case "plan":
    case "apply":
    case "models": return cmdPlanApplyModels(command, flags);
    case "backups": return cmdBackups(flags);
    case "restore": return cmdRestore(flags);
    case "repair": return cmdRepair(flags);
    default: return usage();
  }
}

main().catch((e: unknown) => {
  fail("error", e instanceof Error ? e.message : String(e));
});
