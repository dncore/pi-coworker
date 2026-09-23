// 各 agent 配置补丁纯函数测试(node:test,零依赖)。
// 用例移植自 axon-llm-dispenser src/core/core.test.ts,聚焦「不破坏原有配置」:
// 保留其他 provider / 注释 / 顶层键、flow-style 报错、幂等、保留他人模型条目。
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CODEX_DEFAULT_MODEL,
  patchCodexConfigToml,
  syncCodexCatalog,
  type CodexResolvedModel,
} from "./codex.ts";
import { patchReasonixModels, patchReasonixProvider, patchReasonixServeAuth } from "./reasonix.ts";
import {
  patchDshDefaultModel,
  patchDshProvider,
  patchDshProviderModels,
  upsertDshCredentialYaml,
  type DshModelEntry,
} from "./dsh.ts";
import { deriveAnthropicUrl, formatClaudeModel, patchClaudeSettings, parseClaudeStatus } from "./claude.ts";
import { patchOmpConfigYml, patchOmpModelsList, patchOmpModelsYml, parseOmpStatus, ompBaseUrl } from "./omp.ts";
import { patchOpenCodeAuth, patchOpenCodeConfig, patchOpenCodeModels, parseOpenCodeStatus } from "./opencode.ts";
import { deriveKeyRef, normalizeProviderName, pickDefaultModel } from "./custom-provider.ts";
import { maskApiKey, patchGrokBuildConfigToml, patchGrokBuildModels, type GrokBuildModel } from "./grok-build.ts";
import type { ResolvedModel } from "./model-resolution.ts";

/** 构造 ResolvedModel 字面量(测试 fixture,不依赖 KNOWN_MODELS 表)。 */
function model(id: string, overrides?: Partial<ResolvedModel>): ResolvedModel {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    compat: {},
    ...overrides,
  };
}

const DEEPSEEK = (id = "deepseek-v4-pro"): ResolvedModel =>
  model(id, {
    name: id === "deepseek-v4-pro" ? "DeepSeek V4 Pro" : id,
    reasoning: true,
    input: ["text"],
    contextWindow: 1000000,
    maxTokens: 384000,
    thinkingLevelMap: { high: "high", xhigh: "max" },
    compat: { supportsReasoningEffort: true, thinkingFormat: "deepseek", reasoningEffortMap: { high: "high", xhigh: "max" } },
  });

// ---------------------------------------------------------------------------
// Codex(默认 magene 团队策略;自定义网关经 opts 覆写 provider 名/默认模型/排除名单)
// ---------------------------------------------------------------------------

describe("patchCodexConfigToml", () => {
  it("空文件创建 magene provider 段", () => {
    const r = patchCodexConfigToml("", "https://gateway.example/v1", "sk-test");
    assert.ok(r.text.includes('model_provider = "magene"'));
    assert.ok(r.text.includes("[model_providers.magene]"));
    assert.ok(r.text.includes('wire_api = "responses"'));
    assert.ok(r.text.includes("requires_openai_auth = false"));
    assert.ok(r.text.includes('experimental_bearer_token = "sk-test"'));
    assert.ok(r.text.includes(`model = "${CODEX_DEFAULT_MODEL}"`));
    assert.ok(/^model_catalog_json = "/m.test(r.text));
  });

  it("已有其他 provider 段与顶层键时保留,只更新 magene 段;已有 model 不覆盖", () => {
    const existing = [
      'model = "gpt-5"',
      "# 顶层注释",
      "",
      "[model_providers.other]",
      'name = "other"',
      'base_url = "https://x"',
      "",
      "[model_providers.magene]",
      'name = "magene"',
      'base_url = "https://old"',
      "",
    ].join("\n");
    const r = patchCodexConfigToml(existing, "https://gateway.example/v1", "sk-test");
    assert.ok(r.text.includes('model = "gpt-5"'), "已有顶层 model 不覆盖");
    assert.ok(r.text.includes("[model_providers.other]"));
    assert.ok(r.text.includes("# 顶层注释"));
    assert.ok(r.text.includes('base_url = "https://gateway.example/v1"'));
    assert.ok(!r.text.includes('base_url = "https://old"'));
    assert.equal((r.text.match(/\[model_providers\.magene\]/g) ?? []).length, 1, "无重复段");
  });

  it("幂等:同参数重复应用输出稳定", () => {
    const r1 = patchCodexConfigToml("", "https://gateway.example/v1", "sk-test");
    const r2 = patchCodexConfigToml(r1.text, "https://gateway.example/v1", "sk-test");
    assert.equal(r2.text, r1.text);
    assert.deepEqual(r2.changes, []);
  });

  it("自定义 provider:段名/model_provider 用 opts.provider,magene 段保留,alwaysSetModel 覆写 model", () => {
    const existing = [
      'model = "deepseek-v4-pro"',
      "",
      "[model_providers.magene]",
      'name = "magene"',
      'base_url = "https://magene.example/v1"',
      "",
    ].join("\n");
    const r = patchCodexConfigToml(existing, "https://custom.example/v1", "sk-custom", {
      provider: "my-gw",
      defaultModel: "glm-5",
      alwaysSetModel: true,
    });
    assert.ok(r.text.includes('model_provider = "my-gw"'));
    assert.ok(r.text.includes('model = "glm-5"'), "alwaysSetModel 强制覆写旧 model");
    assert.ok(r.text.includes("[model_providers.my-gw]"));
    assert.ok(r.text.includes('experimental_bearer_token = "sk-custom"'));
    assert.ok(r.text.includes("[model_providers.magene]"), "magene 段保留(两网关共存)");
    assert.ok(r.text.includes('base_url = "https://magene.example/v1"'), "magene 段内容不动");
  });

  it("自定义 provider 幂等", () => {
    const opts = { provider: "my-gw", defaultModel: "glm-5", alwaysSetModel: true };
    const r1 = patchCodexConfigToml("", "https://custom.example/v1", "sk-custom", opts);
    const r2 = patchCodexConfigToml(r1.text, "https://custom.example/v1", "sk-custom", opts);
    assert.equal(r2.text, r1.text);
    assert.deepEqual(r2.changes, []);
  });
});

describe("syncCodexCatalog", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "codex-catalog-"));
    process.env.CODEX_HOME = home;
  });
  afterEach(() => {
    delete process.env.CODEX_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  function readCatalog(): Record<string, { visibility?: string; description?: string }> {
    const doc = JSON.parse(readFileSync(path.join(home, "models.json"), "utf8")) as {
      models: Array<{ slug: string; visibility?: string; description?: string }>;
    };
    return Object.fromEntries(doc.models.map((m) => [m.slug, m]));
  }

  const codexModel = (id: string): CodexResolvedModel => ({
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
  });
  // deepseek-v4-pro / qwen3.8-max 在 CODEX_OK_MODELS,glm-test 不在,Doubao 在团队排除名单
  const MODELS = ["Doubao-Seed-2.0-pro", "deepseek-v4-pro", "glm-test", "qwen3.8-max"].map(codexModel);

  it("默认(白名单模式):白名单 list,其余 hide,排除名单不写入", async () => {
    const r = await syncCodexCatalog(MODELS);
    const catalog = readCatalog();
    assert.equal(catalog["deepseek-v4-pro"].visibility, "list");
    assert.ok(catalog["deepseek-v4-pro"].description?.includes("OK"));
    assert.equal(catalog["qwen3.8-max"].visibility, "list");
    assert.equal(catalog["glm-test"].visibility, "hide");
    assert.ok(catalog["glm-test"].description?.includes("unavailable"));
    assert.equal("Doubao-Seed-2.0-pro" in catalog, false);
    assert.equal(r.total, 3);
    assert.equal(r.list, 2);
    assert.equal(r.hide, 1);
    assert.equal(r.excluded, 1);
  });

  it("selectedIds(自选):勾选即 list(白名单外描述标注 user-selected),未勾选 hide,排除名单勾选也不写入", async () => {
    const r = await syncCodexCatalog(MODELS, {
      selectedIds: new Set(["deepseek-v4-pro", "glm-test", "Doubao-Seed-2.0-pro"]),
    });
    const catalog = readCatalog();
    assert.equal(catalog["deepseek-v4-pro"].visibility, "list");
    assert.ok(catalog["deepseek-v4-pro"].description?.includes("OK"));
    assert.equal(catalog["glm-test"].visibility, "list", "白名单外但用户勾选 → list");
    assert.ok(catalog["glm-test"].description?.includes("user-selected"));
    assert.equal(catalog["qwen3.8-max"].visibility, "hide", "白名单内但未勾选 → hide");
    assert.ok(catalog["qwen3.8-max"].description?.includes("unavailable"));
    assert.equal("Doubao-Seed-2.0-pro" in catalog, false);
    assert.equal(r.list, 2);
    assert.equal(r.hide, 1);
  });

  it("reasoning 模型写 effort 档位(desktop 下拉依据),非 reasoning 模型留空", async () => {
    const models: CodexResolvedModel[] = [
      { ...codexModel("deepseek-v4-pro"), reasoning: true },
      codexModel("qwen3.8-flash"), // reasoning: false
    ];
    await syncCodexCatalog(models, { selectedIds: new Set(["deepseek-v4-pro"]), okOverride: new Set(["deepseek-v4-pro"]) });
    const doc = JSON.parse(readFileSync(path.join(home, "models.json"), "utf8")) as {
      models: Array<{ slug: string; supported_reasoning_levels: Array<{ effort: string }> }>;
    };
    const bySlug = Object.fromEntries(doc.models.map((m) => [m.slug, m]));
    assert.deepEqual(
      bySlug["deepseek-v4-pro"].supported_reasoning_levels.map((l) => l.effort),
      ["low", "high", "max"],
      "reasoning 模型应带 low/high/max 三档(不含 off/none)",
    );
    assert.ok(!bySlug["deepseek-v4-pro"].supported_reasoning_levels.some((l) => l.effort === "off"));
    assert.deepEqual(bySlug["qwen3.8-flash"].supported_reasoning_levels, [], "非 reasoning 模型不留档位");
  });

  it("keepOthers 按全量 live 判定:保留非 magene 条目,未勾选的 magene 模型不作为「非 magene」保留", async () => {
    writeFileSync(
      path.join(home, "models.json"),
      JSON.stringify({ models: [{ slug: "gpt-5", visibility: "list" }, { slug: "qwen3.8-max", visibility: "list" }] }),
    );
    const r = await syncCodexCatalog(MODELS, { keepOthers: true, selectedIds: new Set(["deepseek-v4-pro"]) });
    const catalog = readCatalog();
    assert.ok("gpt-5" in catalog, "非 magene 条目按需保留");
    assert.equal(catalog["qwen3.8-max"].visibility, "hide", "未勾选 magene 模型按 hide 重建而非保留旧条目");
    assert.equal(r.kept, 1);
  });

  it("自定义网关模式:空排除集合不剔除,providerLabel 进描述,勾选 list / 未勾选 hide", async () => {
    const selectedIds = new Set(["Doubao-Seed-2.0-pro", "glm-test"]);
    const r = await syncCodexCatalog(MODELS, {
      selectedIds,
      okOverride: selectedIds,
      excluded: new Set<string>(),
      providerLabel: "my-gw",
      hideNote: "not selected (hidden; codex -m still works)",
    });
    const catalog = readCatalog();
    assert.equal(catalog["Doubao-Seed-2.0-pro"].visibility, "list", "团队排除名单不约束自定义网关");
    assert.ok(catalog["Doubao-Seed-2.0-pro"].description?.includes("my-gw proxy"), "描述前缀用自定义 label");
    assert.ok(catalog["Doubao-Seed-2.0-pro"].description?.includes("OK"), "okOverride=勾选集,选中即 OK 不标白名单语义");
    assert.equal(catalog["glm-test"].visibility, "list");
    assert.equal(catalog["deepseek-v4-pro"].visibility, "hide");
    assert.ok(catalog["deepseek-v4-pro"].description?.includes("not selected"), "hide 描述用自定义 hideNote");
    assert.ok(!catalog["deepseek-v4-pro"].description?.includes("404"), "不再出现 magene 探测语义");
    assert.equal(r.list, 2);
    assert.equal(r.hide, 2);
    assert.equal(r.excluded, 0);
  });
});

// ---------------------------------------------------------------------------
// Reasonix
// ---------------------------------------------------------------------------

describe("patchReasonixProvider", () => {
  it("provider 块 + 鉴权 token", () => {
    const p = patchReasonixProvider("", {
      providerName: "axon",
      baseUrl: "https://gateway.example/v1",
      apiKeyEnv: "AXON_API_KEY",
      modelIds: ["deepseek-v4-flash"],
      defaultModel: "deepseek-v4-flash",
      modelContexts: { "deepseek-v4-flash": 1000000 },
    });
    assert.ok(p.text.includes('name = "axon"'));
    assert.ok(p.text.includes('kind = "openai"'));
    assert.ok(p.text.includes('default_model = "axon"'));
    assert.ok(p.text.includes("context_window = 1000000"));

    const auth = patchReasonixServeAuth(p.text, "token", "tok123");
    assert.ok(auth.text.includes('auth_mode = "token"'));
    assert.ok(auth.text.includes('token = "tok123"'));
  });

  it("保留已有其他 provider 块与块内未知 key", () => {
    const existing = [
      "[[providers]]",
      'name = "deepseek"',
      'kind = "openai"',
      'base_url = "https://api.deepseek.com"',
      'models = ["deepseek-v4-flash"]',
      'api_key_env = "DEEPSEEK_API_KEY"',
      'unknown_extra = "keep-me"',
      "",
    ].join("\n");
    const r = patchReasonixProvider(existing, {
      providerName: "axon",
      baseUrl: "https://gateway.example/v1",
      apiKeyEnv: "AXON_API_KEY",
      modelIds: ["deepseek-v4-flash"],
    });
    assert.ok(r.text.includes('name = "deepseek"'));
    assert.ok(r.text.includes('unknown_extra = "keep-me"'), "块内未知 key 保留");
    assert.ok(r.text.includes('name = "axon"'));
  });
});

// ---------------------------------------------------------------------------
// dsh
// ---------------------------------------------------------------------------

describe("patchDshProvider", () => {
  it("空文件创建 llm-pi-ai.providers.<name>;DeepSeek 网关写方言与默认思考档", () => {
    const r = patchDshProvider("", {
      providerName: "axon",
      displayName: "Axon",
      apiKeyEnv: "AXON_API_KEY",
      baseUrl: "https://gateway.example/v1",
      models: [
        { id: "deepseek-v4-flash", contextWindow: 1000000, maxTokens: 384000, reasoning: true, reasoningEfforts: { low: "high", high: "high" } },
        { id: "qwen3.8-max", contextWindow: 983616, maxTokens: 131072, reasoning: true, reasoningEfforts: {} },
      ],
    });
    assert.ok(r.text.includes("providers:"));
    assert.ok(r.text.includes("axon:"));
    assert.ok(r.text.includes("reasoningEfforts:"));
    assert.ok(r.text.includes("low: high"));
    assert.ok(r.text.includes("reasoning: high"), "DeepSeek 网关带 route 级默认思考档");
    assert.ok(r.text.includes("thinkingFormat: deepseek"));
    // 空 efforts(qwen 只传了空 map)不产生 reasoningEfforts 段
    assert.equal((r.text.match(/reasoningEfforts:/g) ?? []).length, 1);
  });

  it("非 DeepSeek 网关不写思考方言", () => {
    const r = patchDshProvider("", {
      providerName: "qwen-gw",
      displayName: "Qwen GW",
      apiKeyEnv: "QWEN_GW_API_KEY",
      baseUrl: "https://gateway.example/v1",
      models: [{ id: "qwen3.8-max", contextWindow: 983616, maxTokens: 131072, reasoning: true, reasoningEfforts: { high: "high" } }],
    });
    assert.ok(!r.text.includes("thinkingFormat"), "不写 deepseek 方言");
    assert.ok(!r.text.includes("reasoning: high"), "不写 route 级默认思考档");
  });

  it("已有其他 provider 路由时保留,只 upsert 目标块", () => {
    const existing = [
      "llm-pi-ai:",
      "  providers:",
      "    other:",
      "      displayName: Other",
      "      baseURL: https://x",
      "      models: []",
      "",
    ].join("\n");
    const r = patchDshProvider(existing, {
      providerName: "axon",
      displayName: "Axon",
      apiKeyEnv: "AXON_API_KEY",
      baseUrl: "https://gateway.example/v1",
      models: [{ id: "m1", contextWindow: 128000, maxTokens: 8192 }],
    });
    assert.ok(r.text.includes("other:"));
    assert.ok(r.text.includes("axon:"));
    assert.ok(r.text.includes("baseURL: https://x"));
  });

  it("flow style 段直接报错,不盲写", () => {
    assert.throws(() =>
      patchDshProvider("llm-pi-ai: {}", {
        providerName: "axon",
        displayName: "Axon",
        apiKeyEnv: "AXON_API_KEY",
        baseUrl: "https://g/v1",
        models: [],
      }),
    );
  });
});

describe("patchDshDefaultModel", () => {
  it("缺失时创建;已配置时切换到目标 provider(旧 reasoningEffort 一并清除)", () => {
    const r1 = patchDshDefaultModel("", "axon", "deepseek-v4-flash");
    assert.ok(r1.text.includes("agent-default-model:"));
    assert.ok(r1.text.includes("provider: axon"));
    const existing = "agent-default-model:\n  provider: deepseek-official\n  model: old-model\n  reasoningEffort: high\n";
    const r2 = patchDshDefaultModel(existing, "axon", "deepseek-v4-flash");
    assert.ok(r2.text.includes("provider: axon"));
    assert.ok(!r2.text.includes("reasoningEffort"), "旧档位清除");
    assert.ok(r2.changes.length > 0);
  });
});

describe("upsertDshCredentialYaml", () => {
  it("官方裸格式 upsert;空值拒绝", () => {
    const r = upsertDshCredentialYaml("", "AXON_API_KEY", "sk-x");
    assert.equal(r.text, "AXON_API_KEY: sk-x\n");
    assert.throws(() => upsertDshCredentialYaml("", "AXON_API_KEY", ""));
  });

  it("兼容 refs: 包裹(新增 key 按子项缩进)", () => {
    const existing = "version: 1\nrefs:\n  DEEPSEEK_API_KEY: xxxx\n";
    const r = upsertDshCredentialYaml(existing, "AXON_API_KEY", "user_xxx");
    assert.equal(r.text, "version: 1\nrefs:\n  DEEPSEEK_API_KEY: xxxx\n  AXON_API_KEY: user_xxx\n");
  });

  it("修复顶格错位的 key,移到 refs: 之下;refs 内已存在时覆盖不追加", () => {
    const misplaced = "version: 1\nrefs:\n  DEEPSEEK_API_KEY: xxxx\nAXON_API_KEY: user_xxx\n";
    const r1 = upsertDshCredentialYaml(misplaced, "AXON_API_KEY", "user_xxx");
    assert.equal(r1.text, "version: 1\nrefs:\n  DEEPSEEK_API_KEY: xxxx\n  AXON_API_KEY: user_xxx\n");
    const r2 = upsertDshCredentialYaml(r1.text, "AXON_API_KEY", "user_xxx");
    assert.equal(r2.text, r1.text);
    assert.equal(r2.changed, false);
  });
});

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

describe("claude", () => {
  it("推导 Anthropic 端点", () => {
    assert.equal(deriveAnthropicUrl("http://host:8080/api/v1"), "http://host:8080/api/anthropic");
    assert.equal(deriveAnthropicUrl("https://gw.example/v1"), "https://gw.example/api/anthropic");
    assert.equal(deriveAnthropicUrl("https://gw.example/base"), "https://gw.example/base/api/anthropic");
  });

  it("合并 env 到 settings.json,保留其它键,删除弃用变量", () => {
    const r = patchClaudeSettings('{"permissions":{"allow":["Bash(ls *)"]},"env":{"ANTHROPIC_SMALL_FAST_MODEL":"old"}}', {
      anthropicBaseUrl: "http://host/api/anthropic",
      apiKey: "sk-x",
      mainModel: "m1[1m]",
      roles: { haiku: "m2[200k]", sonnet: "m3", opus: "m4", fable: "m5", subagent: "m6" },
    });
    const doc = JSON.parse(r.text) as { permissions: unknown; env: Record<string, string> };
    assert.deepEqual(doc.permissions, { allow: ["Bash(ls *)"] });
    assert.equal(doc.env.ANTHROPIC_BASE_URL, "http://host/api/anthropic");
    assert.equal(doc.env.ANTHROPIC_AUTH_TOKEN, "sk-x");
    assert.equal(doc.env.ANTHROPIC_MODEL, "m1[1m]");
    assert.equal(doc.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "m2[200k]");
    assert.equal(doc.env.CLAUDE_CODE_SUBAGENT_MODEL, "m6");
    assert.equal("ANTHROPIC_SMALL_FAST_MODEL" in doc.env, false);
    assert.equal(doc.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined, "后缀足够时不设全局兜底");
  });

  it("主模型 <200k 无后缀时设置 MAX_CONTEXT_TOKENS 兜底", () => {
    const r = patchClaudeSettings("", {
      anthropicBaseUrl: "http://h",
      apiKey: "k",
      mainModel: "small",
      roles: { haiku: "h", sonnet: "s", opus: "o", fable: "f", subagent: "sa" },
      maxContextTokens: 128000,
    });
    const doc = JSON.parse(r.text) as { env: Record<string, string> };
    assert.equal(doc.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "128000");
  });

  it("按真实上下文窗口加官方后缀", () => {
    assert.equal(formatClaudeModel("deepseek-v4-flash", 1000000), "deepseek-v4-flash[1m]");
    assert.equal(formatClaudeModel("glm-5", 200000), "glm-5[200k]");
    assert.equal(formatClaudeModel("small-model", 128000), "small-model");
  });

  it("状态解析", () => {
    const s = parseClaudeStatus('{"env":{"ANTHROPIC_BASE_URL":"http://h","ANTHROPIC_AUTH_TOKEN":"t","ANTHROPIC_MODEL":"m"}}');
    assert.equal(s.baseUrl, "http://h");
    assert.equal(s.authTokenSet, true);
    assert.equal(s.model, "m");
    assert.equal(parseClaudeStatus("bad").baseUrl, null);
  });
});

// ---------------------------------------------------------------------------
// omp
// ---------------------------------------------------------------------------

describe("omp", () => {
  it("baseUrl 去尾 /v1(官方指南:不带 /v1)", () => {
    assert.equal(ompBaseUrl("https://gateway.example/v1"), "https://gateway.example");
    assert.equal(ompBaseUrl("https://gateway.example/v1/"), "https://gateway.example");
    assert.equal(ompBaseUrl("https://gateway.example"), "https://gateway.example");
  });

  it("DeepSeek 模型带官方 thinking+完整 compat,非 DeepSeek 不带", () => {
    const r = patchOmpModelsYml("", {
      providerName: "axon",
      baseUrl: "https://gateway.example/v1",
      apiKey: "sk-test",
      models: [DEEPSEEK(), model("qwen3.8-max", { reasoning: true })],
    });
    assert.ok(r.text.includes("baseUrl: https://gateway.example"));
    assert.ok(r.text.includes("api: openai-completions"));
    assert.ok(r.text.includes("apiKey: sk-test"));
    assert.ok(r.text.includes("authHeader: true"));
    assert.ok(r.text.includes("minLevel: high"));
    assert.ok(r.text.includes("maxLevel: xhigh"));
    assert.ok(r.text.includes("mode: effort"));
    assert.ok(r.text.includes("supportsToolChoice: false"));
    assert.ok(r.text.includes("requiresReasoningContentForToolCalls: true"));
    assert.ok(r.text.includes("requiresAssistantContentForToolCalls: true"));
    assert.ok(r.text.includes("type: enabled"));
    // 非 DeepSeek 条目不写 compat 块
    const qwenIdx = r.text.indexOf("qwen3.8-max");
    assert.ok(qwenIdx > -1);
    assert.ok(!r.text.slice(qwenIdx).includes("compat:"));
  });

  it("已有其它 provider 时只更新目标段", () => {
    const existing = [
      "providers:",
      "  other:",
      "    baseUrl: https://x",
      "    api: openai-completions",
      "    apiKey: k",
      "    authHeader: true",
      "    models: []",
      "",
    ].join("\n");
    const r = patchOmpModelsYml(existing, {
      providerName: "axon",
      baseUrl: "https://gateway.example/v1",
      apiKey: "sk-test",
      models: [DEEPSEEK("deepseek-v4-flash")],
    });
    assert.ok(r.text.includes("other:"));
    assert.ok(r.text.includes("axon:"));
    assert.ok(r.text.includes("baseUrl: https://x"));
  });

  it("config.yml modelRoles.default upsert 与替换", () => {
    const r1 = patchOmpConfigYml("", "axon", "deepseek-v4-pro");
    assert.ok(r1.text.includes("modelRoles:"));
    assert.ok(r1.text.includes("default: axon/deepseek-v4-pro"));
    const r2 = patchOmpConfigYml(r1.text, "axon", "deepseek-v4-flash");
    assert.ok(r2.text.includes("default: axon/deepseek-v4-flash"));
    assert.ok(!r2.text.includes("deepseek-v4-pro"));
  });

  it("状态解析", () => {
    const modelsText = patchOmpModelsYml("", {
      providerName: "axon",
      baseUrl: "https://gateway.example/v1",
      apiKey: "sk",
      models: [DEEPSEEK(), model("qwen3.8-max", { reasoning: true })],
    }).text;
    const configText = patchOmpConfigYml("", "axon", "deepseek-v4-pro").text;
    const s = parseOmpStatus(modelsText, configText, "axon");
    assert.equal(s.providerConfigured, true);
    assert.equal(s.providerBaseUrl, "https://gateway.example");
    assert.equal(s.providerModels, 2);
    assert.equal(s.defaultRole, "axon/deepseek-v4-pro");
  });
});

// ---------------------------------------------------------------------------
// OpenCode
// ---------------------------------------------------------------------------

describe("opencode", () => {
  const base = {
    providerName: "axon",
    displayName: "Axon",
    baseUrl: "https://gateway.example/v1",
    defaultModel: "deepseek-v4-pro",
    models: [DEEPSEEK(), model("qwen3-coder-plus", { name: "Qwen3 Coder Plus", reasoning: true, contextWindow: 1000000, maxTokens: 65536 })],
  };

  it("空文件创建 provider 块 + 顶层 model,模型 key=id", () => {
    const r = patchOpenCodeConfig("", base);
    const doc = JSON.parse(r.text) as {
      provider: Record<string, { name: string; npm: string; options: { baseURL: string }; models: Record<string, { name?: string }> }>;
      model: string;
    };
    assert.equal(doc.provider.axon.name, "Axon");
    assert.equal(doc.provider.axon.npm, "@ai-sdk/openai-compatible");
    assert.equal(doc.provider.axon.options.baseURL, "https://gateway.example/v1");
    assert.deepEqual(Object.keys(doc.provider.axon.models), ["deepseek-v4-pro", "qwen3-coder-plus"]);
    assert.deepEqual(doc.provider.axon.models["deepseek-v4-pro"], { name: "DeepSeek V4 Pro" });
    assert.equal(doc.model, "axon/deepseek-v4-pro");
    assert.ok(r.changes.join(",").includes("新增 provider axon"));
  });

  it("保留其它 provider 与顶层键", () => {
    const existing = JSON.stringify({
      model: "other/model",
      theme: "dark",
      provider: { ollama: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://localhost:11434/v1" }, models: {} } },
    });
    const r = patchOpenCodeConfig(existing, base);
    const doc = JSON.parse(r.text) as { model: string; theme: string; provider: Record<string, unknown> };
    assert.ok(doc.provider.ollama);
    assert.equal(doc.theme, "dark");
    assert.equal(doc.model, "axon/deepseek-v4-pro");
  });

  it("幂等:同参数重复应用输出稳定", () => {
    const r1 = patchOpenCodeConfig("", base);
    const r2 = patchOpenCodeConfig(r1.text, base);
    assert.equal(r2.text, r1.text);
    const a1 = patchOpenCodeAuth("", "axon", "sk-x");
    const a2 = patchOpenCodeAuth(a1.text, "axon", "sk-x");
    assert.equal(a2.text, a1.text);
  });

  it("auth.json 保留其它条目(含 OAuth),同名覆盖 type/key", () => {
    const r = patchOpenCodeAuth(JSON.stringify({ anthropic: { type: "oauth", access: "tok", refresh: "r", expires: 1 } }), "axon", "sk-new");
    const doc = JSON.parse(r.text) as Record<string, { type: string; key?: string; access?: string }>;
    assert.equal(doc.anthropic.type, "oauth");
    assert.deepEqual(doc.axon, { type: "api", key: "sk-new" });
    const r2 = patchOpenCodeAuth(r.text, "axon", "sk-rotated");
    const doc2 = JSON.parse(r2.text) as Record<string, { type: string; key: string }>;
    assert.deepEqual(doc2.axon, { type: "api", key: "sk-rotated" });
  });

  it("状态解析", () => {
    const config = patchOpenCodeConfig("", base).text;
    const auth = patchOpenCodeAuth("", "axon", "sk-x").text;
    const s = parseOpenCodeStatus(config, auth, "axon");
    assert.equal(s.configExists, true);
    assert.equal(s.providerConfigured, true);
    assert.equal(s.providerBaseUrl, "https://gateway.example/v1");
    assert.equal(s.providerModels, 2);
    assert.equal(s.keySet, true);
    assert.equal(s.model, "axon/deepseek-v4-pro");
    const empty = parseOpenCodeStatus("", "", "axon");
    assert.equal(empty.providerConfigured, false);
    assert.equal(empty.keySet, false);
  });
});

// ---------------------------------------------------------------------------
// custom-provider 工具
// ---------------------------------------------------------------------------

describe("custom-provider 工具", () => {
  it("deriveKeyRef 大写并去非法字符,追加 _API_KEY", () => {
    assert.equal(deriveKeyRef("axon"), "AXON_API_KEY");
    assert.equal(deriveKeyRef("my-gateway"), "MY_GATEWAY_API_KEY");
    assert.equal(deriveKeyRef("a.b_c"), "A_B_C_API_KEY");
  });

  it("normalizeProviderName 规范为 slug,拒绝非法与保留名", () => {
    assert.equal(normalizeProviderName("My Gateway"), "my-gateway");
    assert.equal(normalizeProviderName("  gw_1 "), "gw_1");
    assert.throws(() => normalizeProviderName("magene"));
    assert.throws(() => normalizeProviderName(""));
    assert.throws(() => normalizeProviderName("-"));
    assert.throws(() => normalizeProviderName("a".repeat(33)));
  });

  it("pickDefaultModel:已配置优先,其次 deepseek-v4-flash,再退回第一个", () => {
    const ids = ["glm-5", "deepseek-v4-flash", "kimi-k3"];
    assert.equal(pickDefaultModel(ids, "kimi-k3"), "kimi-k3");
    assert.equal(pickDefaultModel(ids, "not-exist"), "deepseek-v4-flash");
    assert.equal(pickDefaultModel(["glm-5", "kimi-k3"]), "glm-5");
    assert.equal(pickDefaultModel([]), "");
  });
});

// ---------------------------------------------------------------------------
// grok-build
// ---------------------------------------------------------------------------

function grokModel(id: string, overrides?: Partial<GrokBuildModel>): GrokBuildModel {
  return { id, contextWindow: 128000, maxTokens: 8192, ...overrides };
}

const GROK_INPUT = {
  providerName: "magene",
  label: "magene",
  baseUrl: "https://gateway.example/v1",
  apiKey: "sk-test",
  defaultModel: "glm-5.3",
} as const;

describe("patchGrokBuildConfigToml", () => {
  it("空文件创建 [model_providers.<name>] + [models] default + 模型块(含点号引号键)", () => {
    const r = patchGrokBuildConfigToml("", {
      ...GROK_INPUT,
      models: [
        grokModel("deepseek-v4-flash", { contextWindow: 1000000, maxTokens: 384000 }),
        grokModel("glm-5.3", { contextWindow: 1048576, maxTokens: 131072 }),
      ],
    });
    assert.ok(r.text.includes("[model_providers.magene]"));
    assert.ok(r.text.includes('base_url = "https://gateway.example/v1"'));
    assert.ok(r.text.includes('api_backend = "chat_completions"'));
    assert.ok(r.text.includes('api_key = "sk-test"'));
    assert.ok(r.text.includes("[models]\ndefault = \"glm-5.3\""));
    assert.ok(r.text.includes("[model.deepseek-v4-flash]"), "无点号 ID 用裸键");
    assert.ok(r.text.includes('[model."glm-5.3"]'), "含点号 ID 必须引号键(裸键会被 TOML 解析成嵌套表)");
    assert.ok(r.text.includes('model_provider = "magene"'));
    assert.ok(r.text.includes("context_window = 1048576"));
    assert.ok(r.text.includes("max_completion_tokens = 131072"));
    assert.ok(r.changes.length === 3, `应有 3 条变更,实际: ${r.changes.join("; ")}`);
  });

  it("幂等:重复 patch 输出不变且无变更", () => {
    const input = {
      ...GROK_INPUT,
      models: [grokModel("deepseek-v4-flash"), grokModel("glm-5.3")],
    };
    const r1 = patchGrokBuildConfigToml("", input);
    const r2 = patchGrokBuildConfigToml(r1.text, input);
    assert.equal(r2.text, r1.text);
    assert.deepEqual(r2.changes, []);
  });

  it("default 不在模型列表时回退到字母序第一个模型", () => {
    const r = patchGrokBuildConfigToml("", {
      ...GROK_INPUT,
      defaultModel: "not-in-list",
      models: [grokModel("kimi-k3"), grokModel("glm-5.3")],
    });
    assert.ok(r.text.includes('default = "glm-5.3"'));
  });

  it("模型列表为空时原样返回", () => {
    const r = patchGrokBuildConfigToml("some existing\n", { ...GROK_INPUT, models: [] });
    assert.equal(r.text, "some existing\n");
    assert.deepEqual(r.changes, []);
  });

  it("保留 [models] 段其他键、其他 [model.*] 块与顶层注释", () => {
    const existing = [
      "# user config",
      "[models]",
      'web_search = "grok-4.6"',
      "",
      "[model.grok-4.6]",
      "temperature = 0.5",
      "",
    ].join("\n");
    const r = patchGrokBuildConfigToml(existing, {
      ...GROK_INPUT,
      defaultModel: "deepseek-v4-flash",
      models: [grokModel("deepseek-v4-flash")],
    });
    assert.ok(r.text.startsWith("# user config"), "注释保留");
    assert.ok(r.text.includes('web_search = "grok-4.6"'), "[models] 其他键保留");
    assert.ok(r.text.includes("[model.grok-4.6]"), "其他 [model.*] 块保留");
    assert.ok(r.text.includes("temperature = 0.5"));
    assert.ok(r.text.includes('default = "deepseek-v4-flash"'), "[models] default 更新");
  });

  it("重写自有块并移除陈旧块(网关下架模型)", () => {
    const once = patchGrokBuildConfigToml("", {
      ...GROK_INPUT,
      models: [grokModel("deepseek-v4-flash"), grokModel("glm-5.3"), grokModel("qwen3.8-flash")],
    });
    assert.equal(once.text.match(/\[model\.[^\]]+\]/g)!.length, 3);
    const twice = patchGrokBuildConfigToml(once.text, {
      ...GROK_INPUT,
      models: [grokModel("deepseek-v4-flash"), grokModel("glm-5.3", { contextWindow: 999 })],
    });
    assert.ok(!twice.text.includes("qwen3.8-flash"), "陈旧模型块移除");
    assert.ok(twice.text.includes("context_window = 999"), "自有块按新元数据重写");
    assert.ok(twice.changes.some((c) => c.includes("移除 1 个陈旧模型块")));
  });

  it("同 key 已存在用户块(非本 provider)时保留并跳过,避免 TOML 重复段", () => {
    const existing = ['[model.deepseek-v4-flash]', 'model = "deepseek-v4-flash"', 'base_url = "http://localhost:8080/v1"', "",].join("\n");
    const r = patchGrokBuildConfigToml(existing, {
      ...GROK_INPUT,
      models: [grokModel("deepseek-v4-flash"), grokModel("glm-5.3")],
    });
    assert.ok(r.text.includes('base_url = "http://localhost:8080/v1"'), "用户块保留");
    assert.ok(r.text.includes('model_provider = "magene"'), "无冲突的 glm-5.3 正常写入");
    const count = (r.text.match(/\[model\.deepseek-v4-flash\]/g) ?? []).length;
    assert.equal(count, 1, "同 key 块不重复");
  });

  it("api_key 更换时 provider 块更新,模型块不动", () => {
    const once = patchGrokBuildConfigToml("", { ...GROK_INPUT, models: [grokModel("glm-5.3")] });
    const twice = patchGrokBuildConfigToml(once.text, { ...GROK_INPUT, apiKey: "sk-new", models: [grokModel("glm-5.3")] });
    assert.ok(twice.text.includes('api_key = "sk-new"'));
    assert.ok(twice.changes.length === 1, `仅 provider 块变更,实际: ${twice.changes.join("; ")}`);
  });

  it("maskApiKey 脱敏", () => {
    assert.equal(maskApiKey(null), null);
    assert.equal(maskApiKey("short"), "****");
    const m = maskApiKey("abcdefghijk")!;
    assert.ok(m.startsWith("abcdef"));
    assert.ok(m.endsWith("hijk"));
    assert.ok(!m.includes("ghij")); // 中段已隐藏
  });
});

// ---------------------------------------------------------------------------
// 块内合并(只 upsert 管理键,块内用户键/注释保留)与「仅更新模型列表」
// ---------------------------------------------------------------------------

describe("codex provider 段块内合并", () => {
  it("段内用户键与注释保留,管理键更新,幂等", () => {
    const existing = [
      "# 顶层注释",
      "[model_providers.magene]",
      "# 段内注释",
      'name = "magene"',
      'base_url = "https://old.example/v1"',
      "request_max_retries = 3",
      "",
    ].join("\n");
    const r = patchCodexConfigToml(existing, "https://new.example/v1", "sk-new");
    assert.ok(r.text.includes("# 段内注释"), "段内注释保留");
    assert.ok(r.text.includes("request_max_retries = 3"), "段内用户键保留");
    assert.ok(r.text.includes('base_url = "https://new.example/v1"'));
    assert.ok(r.text.includes('experimental_bearer_token = "sk-new"'), "缺失的管理键补写");
    const r2 = patchCodexConfigToml(r.text, "https://new.example/v1", "sk-new");
    assert.equal(r2.text, r.text, "幂等");
    assert.deepEqual(r2.changes, []);
  });
});

describe("syncCodexCatalog refresh(仅更新模型列表)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "codex-refresh-"));
    process.env.CODEX_HOME = home;
  });
  afterEach(() => {
    delete process.env.CODEX_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  const codexModel = (id: string): CodexResolvedModel => ({
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
  });

  it("沿用可见性与描述,新增按白名单,下架移除,非网关条目保留;无变化不写", async () => {
    writeFileSync(
      path.join(home, "models.json"),
      JSON.stringify(
        {
          models: [
            { slug: "gpt-5", visibility: "list", description: "OpenAI 官方条目" },
            { slug: "deepseek-v4-pro", visibility: "list", description: "Magene proxy: 上次勾选描述" },
            { slug: "qwen3.8-max", visibility: "hide", description: "Magene proxy: unavailable (404/403 upstream)" },
            { slug: "deepseek-v4-flash-vision-exp", visibility: "hide", description: "Magene proxy: stale" },
          ],
        },
        null,
        2,
      ) + "\n",
    );
    const models = ["deepseek-v4-pro", "qwen3.8-max", "qwen3.8-flash", "glm-test"].map(codexModel);
    const r = await syncCodexCatalog(models, { refresh: true });
    const doc = JSON.parse(readFileSync(path.join(home, "models.json"), "utf8")) as {
      models: Array<{ slug: string; visibility: string; description: string }>;
    };
    const by = Object.fromEntries(doc.models.map((m) => [m.slug, m]));
    assert.equal(by["deepseek-v4-pro"].visibility, "list", "list 沿用");
    assert.equal(by["deepseek-v4-pro"].description, "Magene proxy: 上次勾选描述", "描述沿用不重生成");
    assert.equal(by["qwen3.8-max"].visibility, "hide", "hide 沿用");
    assert.equal(by["qwen3.8-flash"].visibility, "list", "白名单新模型 → list");
    assert.equal(by["glm-test"].visibility, "hide", "非白名单新模型 → hide");
    assert.ok(by["gpt-5"], "非网关条目保留");
    assert.ok(!("deepseek-v4-flash-vision-exp" in by), "下架条目移除");
    assert.deepEqual(r.removed, ["deepseek-v4-flash-vision-exp"]);
    assert.deepEqual([...r.added].sort(), ["glm-test", "qwen3.8-flash"]);
    assert.equal(r.kept, 1);

    const before = readFileSync(path.join(home, "models.json"), "utf8");
    const r2 = await syncCodexCatalog(models, { refresh: true });
    assert.equal(r2.unchanged, true, "第二次刷新无变化");
    assert.equal(r2.backup, undefined, "无变化不产生备份");
    assert.equal(readFileSync(path.join(home, "models.json"), "utf8"), before);
  });
});

describe("dsh 块内合并 / 仅更新模型列表", () => {
  const DSH_EXISTING = [
    "llm-pi-ai:",
    "  providers:",
    "    magene:",
    "      displayName: Magene",
    "      apiKeyEnv: MAGENE_API_KEY",
    "      api: openai-completions",
    "      baseURL: https://old.example/v1",
    "      # 用户注释",
    "      extraHeaders:",
    "        X-Trace: on",
    "      compat:",
    "        thinkingFormat: deepseek",
    "      reasoning: high",
    "      models:",
    "        - id: deepseek-v4-flash",
    "          contextWindow: 1",
    "          maxTokens: 2",
    "          customFlag: true",
    "        - id: old-model",
    "          contextWindow: 1",
    "          maxTokens: 1",
    "    other:",
    "      baseURL: https://other.example/v1",
    "",
  ].join("\n");

  const NEW_MODELS: DshModelEntry[] = [
    { id: "deepseek-v4-flash", contextWindow: 1000000, maxTokens: 384000, reasoning: true, reasoningEfforts: { high: "max" } },
    { id: "qwen3.8-max", contextWindow: 983616, maxTokens: 131072 },
  ];

  it("models-only:按 id 合并,用户键/注释保留,下架删除,baseURL 不动,幂等", () => {
    const r = patchDshProviderModels(DSH_EXISTING, { providerName: "magene", models: NEW_MODELS });
    assert.equal(r.providerFound, true);
    assert.ok(r.text.includes("baseURL: https://old.example/v1"), "baseURL 不动");
    assert.ok(r.text.includes("displayName: Magene"), "displayName 不动");
    assert.ok(r.text.includes("# 用户注释"));
    assert.ok(r.text.includes("X-Trace: on"));
    assert.ok(r.text.includes("customFlag: true"), "条目内用户子键保留");
    assert.ok(r.text.includes("contextWindow: 1000000"), "元数据更新");
    assert.ok(r.text.includes("reasoningEfforts:"));
    assert.ok(!r.text.includes("old-model"), "下架条目移除");
    assert.ok(r.text.includes("- id: qwen3.8-max"), "新条目写入");
    assert.ok(r.text.includes("other:"), "其他 provider 保留");
    const r2 = patchDshProviderModels(r.text, { providerName: "magene", models: NEW_MODELS });
    assert.equal(r2.text, r.text, "幂等");
    assert.deepEqual(r2.changes, []);
  });

  it("全量 patch:管理键更新、块内用户键保留;无 DeepSeek 模型时移除方言条件键", () => {
    const r = patchDshProvider(DSH_EXISTING, {
      providerName: "magene",
      displayName: "New Name",
      apiKeyEnv: "MAGENE_API_KEY",
      baseUrl: "https://new.example/v1",
      models: [{ id: "qwen3.8-max", contextWindow: 983616, maxTokens: 131072 }],
    });
    assert.ok(r.text.includes("baseURL: https://new.example/v1"));
    assert.ok(r.text.includes("displayName: New Name"));
    assert.ok(r.text.includes("X-Trace: on"), "块内用户键保留");
    assert.ok(!r.text.includes("thinkingFormat"), "非 DeepSeek 网关移除方言键");
    assert.ok(!/^ +reasoning: high$/m.test(r.text), "移除 route 级思考档");
    assert.ok(!r.text.includes("customFlag"), "下架条目(含其用户子键)整体移除");
    const r2 = patchDshProvider(r.text, {
      providerName: "magene",
      displayName: "New Name",
      apiKeyEnv: "MAGENE_API_KEY",
      baseUrl: "https://new.example/v1",
      models: [{ id: "qwen3.8-max", contextWindow: 983616, maxTokens: 131072 }],
    });
    assert.equal(r2.text, r.text, "幂等");
  });

  it("provider 块不存在时 models-only 返回 providerFound=false 且不改文本", () => {
    const text = "llm-pi-ai:\n  providers:\n    other:\n      baseURL: https://x.example/v1\n";
    const r = patchDshProviderModels(text, { providerName: "magene", models: NEW_MODELS });
    assert.equal(r.providerFound, false);
    assert.equal(r.text, text);
    assert.deepEqual(r.changes, []);
  });
});

describe("omp 块内合并 / 仅更新模型列表", () => {
  const OMP_EXISTING = [
    "providers:",
    "  others:",
    "    baseUrl: https://other.example/v1",
    "    api: openai-completions",
    "  mygw:",
    "    baseUrl: https://old.example/v1",
    "    api: openai-completions",
    "    apiKey: sk-old",
    "    authHeader: true",
    "    headers:",
    "      X-Trace: on",
    "    models:",
    "      - id: glm-5.3",
    "        reasoning: true",
    "        contextWindow: 1",
    "        maxTokens: 2",
    "        temperature: 0.3",
    "      - id: old-model",
    "        reasoning: false",
    "        contextWindow: 1",
    "        maxTokens: 1",
    "",
  ].join("\n");

  const NEW_MODELS = [model("glm-5.3", { reasoning: true, contextWindow: 1048576, maxTokens: 131072 }), model("kimi-k3", { reasoning: true })];

  it("models-only:条目按 id 合并,用户键保留,下架删除,apiKey/baseUrl 不动", () => {
    const r = patchOmpModelsList(OMP_EXISTING, { providerName: "mygw", models: NEW_MODELS });
    assert.equal(r.providerFound, true);
    assert.ok(r.text.includes("apiKey: sk-old"), "apiKey 不动");
    assert.ok(r.text.includes("baseUrl: https://old.example/v1"), "baseUrl 不动");
    assert.ok(r.text.includes("X-Trace: on"));
    assert.ok(r.text.includes("temperature: 0.3"), "条目内用户子键保留");
    assert.ok(r.text.includes("contextWindow: 1048576"), "元数据更新");
    assert.ok(!r.text.includes("old-model"), "下架条目移除");
    assert.ok(r.text.includes("- id: kimi-k3"), "新条目写入");
    assert.ok(r.text.includes("others:"), "其他 provider 保留");
    const r2 = patchOmpModelsList(r.text, { providerName: "mygw", models: NEW_MODELS });
    assert.equal(r2.text, r.text, "幂等");
    assert.deepEqual(r2.changes, []);
  });

  it("全量 patch:baseUrl/apiKey 更新、块内用户键保留", () => {
    const r = patchOmpModelsYml(OMP_EXISTING, {
      providerName: "mygw",
      baseUrl: "https://new.example/v1",
      apiKey: "sk-new",
      models: [model("glm-5.3", { reasoning: true })],
    });
    assert.ok(r.text.includes("baseUrl: https://new.example"), "baseUrl 更新(官方指南去 /v1)");
    assert.ok(r.text.includes("apiKey: sk-new"));
    assert.ok(r.text.includes("X-Trace: on"));
    assert.ok(r.text.includes("temperature: 0.3"));
  });
});

describe("grok-build 块内合并 / 仅更新模型列表", () => {
  const GROK_EXISTING = [
    "# 用户配置",
    "[model_providers.other]",
    'base_url = "https://other.example/v1"',
    "",
    "[model_providers.magene]",
    'base_url = "https://old.example/v1"',
    'api_backend = "chat_completions"',
    'api_key = "sk-old"',
    "user_retry = 5",
    "",
    '[model."glm-5.3"]',
    'model = "glm-5.3"',
    'model_provider = "magene"',
    "temperature = 0.3",
    "context_window = 111",
    "",
    "[models]",
    'default = "glm-5.3"',
    "",
  ].join("\n");

  it("models-only:模型块按 id 合并,块内用户键保留;provider 段与 api_key 不动", () => {
    const r = patchGrokBuildModels(GROK_EXISTING, {
      providerName: "magene",
      label: "magene",
      models: [grokModel("glm-5.3", { contextWindow: 999 }), grokModel("kimi-k3")],
    });
    assert.equal(r.providerFound, true);
    assert.ok(r.text.includes('base_url = "https://old.example/v1"'), "provider 段不动");
    assert.ok(r.text.includes('api_key = "sk-old"'), "api_key 不动");
    assert.ok(r.text.includes("user_retry = 5"), "段内用户键保留");
    assert.ok(r.text.includes("temperature = 0.3"), "模型块内用户键保留");
    assert.ok(r.text.includes("context_window = 999"), "元数据更新");
    assert.ok(r.text.includes('default = "glm-5.3"'), "default 仍在列表 → 不动");
    assert.ok(r.text.includes("[model.kimi-k3]"), "新模型块写入");
    assert.ok(r.text.includes("# 用户配置"), "顶层注释保留");
    const input = {
      providerName: "magene",
      label: "magene",
      models: [grokModel("glm-5.3", { contextWindow: 999 }), grokModel("kimi-k3")],
    };
    const r2 = patchGrokBuildModels(r.text, input);
    assert.equal(r2.text, r.text, "幂等");
    assert.deepEqual(r2.changes, []);
  });

  it("models-only:default 指向已下架模型时修正为列表首个;未接入时 providerFound=false", () => {
    const withStaleDefault = GROK_EXISTING.replace('default = "glm-5.3"', 'default = "gone-model"');
    const r = patchGrokBuildModels(withStaleDefault, {
      providerName: "magene",
      label: "magene",
      models: [grokModel("kimi-k3")],
    });
    assert.ok(r.text.includes('default = "kimi-k3"'), "失效 default 修正");
    const missing = patchGrokBuildModels("[models]\n", {
      providerName: "magene",
      label: "magene",
      models: [grokModel("kimi-k3")],
    });
    assert.equal(missing.providerFound, false);
    assert.equal(missing.text, "[models]\n");
  });

  it("全量 patch:provider 段用户键保留,陈旧自有块移除", () => {
    const r = patchGrokBuildConfigToml(GROK_EXISTING, {
      providerName: "magene",
      label: "magene",
      baseUrl: "https://new.example/v1",
      apiKey: "sk-new",
      defaultModel: "glm-5.3",
      models: [grokModel("glm-5.3")],
    });
    assert.ok(r.text.includes('base_url = "https://new.example/v1"'));
    assert.ok(r.text.includes('api_key = "sk-new"'));
    assert.ok(r.text.includes("user_retry = 5"), "segment 内用户键保留");
    assert.ok(r.text.includes("temperature = 0.3"), "模型块内用户键保留");
    assert.ok(r.text.includes("[model_providers.other]"), "其他 provider 保留");
  });
});

describe("opencode 块内合并 / 仅更新模型列表", () => {
  const EXISTING = JSON.stringify(
    {
      model: "other/model",
      theme: "dark",
      provider: {
        mygw: {
          name: "Old Name",
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "https://old.example/v1", headers: { "X-Trace": "on" } },
          models: {
            "glm-5.3": { name: "GLM", limit: { context: 1 } },
            "old-model": { name: "Old" },
          },
          customKey: "keep",
        },
      },
    },
    null,
    2,
  ) + "\n";

  it("models-only:只合并 models,条目内用户字段保留,provider 元数据与顶层 model 不动", () => {
    const r = patchOpenCodeModels(EXISTING, {
      providerName: "mygw",
      models: [model("glm-5.3", { name: "GLM 5.3" }), model("kimi-k3")],
    });
    assert.equal(r.providerFound, true);
    const doc = JSON.parse(r.text) as {
      model: string;
      provider: Record<string, { name: string; options: { baseURL: string; headers: Record<string, string> }; models: Record<string, Record<string, unknown>>; customKey: string }>;
    };
    assert.equal(doc.model, "other/model", "顶层 model 不动");
    assert.equal(doc.provider.mygw.name, "Old Name", "provider name 不动");
    assert.equal(doc.provider.mygw.options.baseURL, "https://old.example/v1", "baseURL 不动");
    assert.equal(doc.provider.mygw.options.headers["X-Trace"], "on", "options 用户键保留");
    assert.equal(doc.provider.mygw.customKey, "keep", "provider 用户键保留");
    assert.equal(doc.provider.mygw.models["glm-5.3"].name, "GLM 5.3", "name 更新");
    assert.deepEqual(doc.provider.mygw.models["glm-5.3"].limit, { context: 1 }, "条目内用户字段保留");
    assert.ok(doc.provider.mygw.models["kimi-k3"], "新模型写入");
    assert.ok(!doc.provider.mygw.models["old-model"], "下架条目移除");
    const r2 = patchOpenCodeModels(r.text, {
      providerName: "mygw",
      models: [model("glm-5.3", { name: "GLM 5.3" }), model("kimi-k3")],
    });
    assert.equal(r2.text, r.text, "幂等");
  });

  it("全量 patch:provider 对象用户键保留", () => {
    const r = patchOpenCodeConfig(EXISTING, {
      providerName: "mygw",
      displayName: "New Name",
      baseUrl: "https://new.example/v1",
      models: [model("glm-5.3", { name: "GLM 5.3" })],
      defaultModel: "glm-5.3",
    });
    const doc = JSON.parse(r.text) as {
      provider: Record<string, { name: string; options: { headers: Record<string, string> }; customKey: string; models: Record<string, unknown> }>;
    };
    assert.equal(doc.provider.mygw.name, "New Name");
    assert.equal(doc.provider.mygw.options.headers["X-Trace"], "on", "options 用户键保留");
    assert.equal(doc.provider.mygw.customKey, "keep", "provider 用户键保留");
    assert.ok(!doc.provider.mygw.models["old-model"], "下架条目移除");
  });
});

describe("reasonix 块内合并 / 仅更新模型列表", () => {
  const EXISTING = [
    "[[providers]]",
    'name = "axon"',
    "# 用户注释",
    'kind = "openai"',
    'base_url = "https://user-set.example/v1"',
    'models = ["glm-5.3"]',
    'api_key_env = "AXON_API_KEY"',
    'model_overrides = { "glm-5.3" = { context_window = 1, custom = "keep" } }',
    'default = "glm-5.3"',
    'custom_key = "keep"',
    "",
  ].join("\n");

  it("models-only:只改 models 与 model_overrides,其余键与注释保留", () => {
    const r = patchReasonixModels(EXISTING, {
      providerName: "axon",
      modelIds: ["glm-5.3", "kimi-k3"],
      modelContexts: { "glm-5.3": 1048576, "kimi-k3": 256000 },
    });
    assert.equal(r.providerFound, true);
    assert.ok(r.text.includes('base_url = "https://user-set.example/v1"'), "base_url 不动");
    assert.ok(r.text.includes('api_key_env = "AXON_API_KEY"'), "api_key_env 不动");
    assert.ok(r.text.includes('default = "glm-5.3"'), "default 不动");
    assert.ok(r.text.includes("# 用户注释"), "块内注释保留");
    assert.ok(r.text.includes('custom_key = "keep"'), "块内用户键保留");
    assert.ok(r.text.includes('models = ["glm-5.3", "kimi-k3"]'), "models 更新");
    assert.ok(r.text.includes('"glm-5.3" = { context_window = 1048576, custom = "keep" }'), "override 内用户键保留");
    assert.ok(r.text.includes('"kimi-k3" = { context_window = 256000 }'), "新 override 写入");
    const r2 = patchReasonixModels(r.text, {
      providerName: "axon",
      modelIds: ["glm-5.3", "kimi-k3"],
      modelContexts: { "glm-5.3": 1048576, "kimi-k3": 256000 },
    });
    assert.equal(r2.text, r.text, "幂等");
    assert.deepEqual(r2.changes, []);
  });

  it("未配置时 providerFound=false 且不改文本", () => {
    const text = '[[providers]]\nname = "other"\n';
    const r = patchReasonixModels(text, { providerName: "axon", modelIds: ["m"] });
    assert.equal(r.providerFound, false);
    assert.equal(r.text, text);
  });
});
