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

console.log("== fetchMageneModels 失败路径（占位符）==");
try {
  await M.fetchMageneModels(M.DEFAULT_MAGENE_BASE_URL, "k", 2000);
  check("占位符应失败", false);
} catch (e: any) {
  check("占位符 URL 快速失败", /(ENOTFOUND|EAI_AGAIN|fetch failed|HTTP|timed out)/i.test(String(e?.message ?? e)), String(e?.message));
}

console.log(failed === 0 ? "\n全部通过 ✅" : `\n${failed} 项失败 ❌`);
process.exit(failed === 0 ? 0 : 1);
