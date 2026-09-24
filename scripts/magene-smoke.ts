/** magene 模块冒烟测试：不触碰真实凭证，仅验证纯逻辑路径 */
import { createJiti } from "jiti";
import { join } from "node:path";

const jiti = createJiti(import.meta.url);
const M = await jiti.import(join(process.cwd(), "extensions/core/magene.ts")) as typeof import("../extensions/core/magene.ts");

let failed = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) console.log(`  ✅ ${name}`);
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}

console.log("== parseDotEnv ==");
const tmp = "/tmp/magene-smoke.env";
const { writeFileSync, rmSync } = await import("node:fs");
writeFileSync(tmp, `# comment\nMAGENE_BASE_URL="http://gw.example.com/api/v1"\nMAGENE_API_KEY=abc123\n\n`);
const parsed = M.parseDotEnv(tmp);
check("解析 Base URL", parsed.MAGENE_BASE_URL === "http://gw.example.com/api/v1", JSON.stringify(parsed));
check("解析 API Key", parsed.MAGENE_API_KEY === "abc123");
rmSync(tmp);

console.log("== resolveMageneConfig ==");
const dflt = M.resolveMageneConfig({});
check("默认解析来源合法（file/default）", dflt.baseUrlSource === "file" || dflt.baseUrlSource === "default", dflt.baseUrlSource);
if (dflt.baseUrlSource === "default") {
  // 仅当本机无 .env 时验证占位符路径
  check("无配置时是占位符且 key 缺失", dflt.baseUrl.includes("<") && dflt.apiKey === "" && dflt.apiKeySource === "missing");
}
const envCfg = M.resolveMageneConfig({ MAGENE_BASE_URL: "http://gw.example.com/api/v1", MAGENE_API_KEY: "k1" });
check("env 优先且来源正确", envCfg.baseUrlSource === "env" && envCfg.apiKeySource === "env");

console.log("== resolveModelMeta / buildResolvedModels ==");
const r1 = M.resolveModelMeta("deepseek-r1");
check("deepseek-r1 推理+deepseek compat", r1.reasoning && r1.compat?.thinkingFormat === "deepseek" && r1.contextWindow === 131072);
const qwen = M.resolveModelMeta("qwen-max");
check("qwen compat", qwen.compat?.thinkingFormat === "qwen");
const custom = M.resolveModelMeta("internal-model-x");
check("未知模型走默认", custom.contextWindow === 128000 && custom.maxTokens === 16384);
const built = M.buildResolvedModels(["deepseek-r1", "qwen-max", "internal-model-x"]);
check("解析 3 个模型", built.length === 3);
check("source 标记正确", built[0].source === "known" && built[2].source === "default", built.map(b => b.source).join(","));

console.log("== 网关兼容层 ==");
// 显式传 {} 而不是用默认的 loadMageneOverrides():否则本机上真实的
// magene-model-overrides.json 会接管结果,断言就变成"测这台机器"而不是"测这段代码"。
const g6 = M.resolveModelMeta("gpt-6-luna", {});
check(
  "gpt-6-luna 一律显式 none(该网关 chat 路由省略 reasoning_effort 即带工具 400)",
  g6.compat?.supportsReasoningEffort === true &&
    g6.thinkingLevelMap?.off === "none" && g6.thinkingLevelMap?.high === "none" && g6.thinkingLevelMap?.max === "none" &&
    Object.keys(g6.thinkingLevelMap ?? {}).length === 7,
  JSON.stringify(g6.thinkingLevelMap),
);
check("兼容层保留 canonical 的 maxTokensField", g6.compat?.maxTokensField === "max_completion_tokens");
check("未命中模型不被改写", M.resolveModelMeta("gpt-5.6-luna", {}).compat?.supportsReasoningEffort === undefined);
check(
  "用户 override 压过兼容层",
  M.resolveModelMeta("gpt-6-luna", { "gpt-6-luna": { contextWindow: 1, maxTokens: 1, thinkingLevelMap: { high: "high" } } }).thinkingLevelMap?.high === "high",
);
check("每条 overlay 的 id 都在已知表内(否则修正分支走不到,静默失效)", M.gatewayOverlayIds().length > 0 && M.gatewayOverlayIds().every((id) => !!M.KNOWN_MODELS[id]));
check("每条 overlay 都带失效条件(后人可判断能否删)", (M.gatewayOverlayFor("gpt-6-luna")?.reason ?? "").includes("失效条件"));

console.log("== fetchMageneModels 失败路径（占位符）==");
try {
  await M.fetchMageneModels(M.DEFAULT_MAGENE_BASE_URL, "k", 2000);
  check("占位符应失败", false);
} catch (e: any) {
  check("占位符 URL 快速失败", /(ENOTFOUND|EAI_AGAIN|fetch failed|HTTP|timed out)/i.test(String(e?.message ?? e)), String(e?.message));
}

console.log(failed === 0 ? "\n全部通过 ✅" : `\n${failed} 项失败 ❌`);
process.exit(failed === 0 ? 0 : 1);
