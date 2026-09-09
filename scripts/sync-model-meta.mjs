// 从 canonical gist 拉取统一模型表(models.json),重新生成 extensions/core/magene.ts 的
// KNOWN_MODELS 表段 + vendor 副本 scripts/model-meta.json。
//
// 用法: node scripts/sync-model-meta.mjs [--check]
//   默认   : 拉取 gist → 生成 → 写回表段与 vendor 副本
//   --check: 只对比不写回;有差异退出 1(CI 漂移门禁);网络不可达时用 vendor
//            副本本地重生成对比(仍能拦住手改表段类漂移)
//
// canonical: https://gist.github.com/dncore/b8931f4ca3833698be0a4a091f91c0e2
// pi 侧对端校验:cd ../pi-agent-dispenser && node scripts/check-table-sync.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const GIST_ID = "b8931f4ca3833698be0a4a091f91c0e2";
const API_URL = `https://api.github.com/gists/${GIST_ID}`;
const TARGET = join(REPO, "extensions/core", "magene.ts");
const VENDOR = join(REPO, "scripts", "model-meta.json");
const BEGIN = "// @model-meta:begin";
const END = "// @model-meta:end";
const PRINT_WIDTH = 80; // 与库内既有 prettier 风格一致(短对象内联,超宽展开)

const check = process.argv.includes("--check");

async function fetchCanonical() {
  try {
    const res = await fetch(API_URL, { signal: AbortSignal.timeout(15000), headers: { "User-Agent": "sync-model-meta" } });
    if (!res.ok) throw new Error(String(res.status));
    const gist = await res.json();
    const text = gist.files?.["models.json"]?.content;
    if (!text) throw new Error("gist 缺 models.json");
    let rev = gist.history?.[0]?.version?.slice(0, 8) ?? "";
    return { doc: JSON.parse(text), rev, online: true };
  } catch {
    return { doc: JSON.parse(readFileSync(VENDOR, "utf8")), rev: "", online: false };
  }
}


/** 结构校验:canonical 必须满足 agent 配置生成所需的字段规范(生成前把关)。 */
function validate(doc) {
  const ids = Object.keys(doc.models ?? {});
  if (!ids.length) throw new Error("models 为空");
  const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
  const inputs = new Set(["text", "image", "video", "file", "audio"]);
  const compatKeys = new Set([
    "supportsDeveloperRole", "supportsReasoningEffort", "maxTokensField",
    "thinkingFormat", "requiresReasoningContentOnAssistantMessages", "reasoningEffortMap",
  ]);
  for (const id of ids) {
    const m = doc.models[id];
    if (!Number.isInteger(m.contextWindow) || m.contextWindow <= 0) throw new Error(`${id}: contextWindow 非法`);
    if (!Number.isInteger(m.maxTokens) || m.maxTokens <= 0) throw new Error(`${id}: maxTokens 非法`);
    if (m.maxTokens > m.contextWindow) throw new Error(`${id}: maxTokens(${m.maxTokens}) > contextWindow(${m.contextWindow})`);
    for (const x of m.input ?? []) if (!inputs.has(x)) throw new Error(`${id}: input 非法 ${x}`);
    for (const k of Object.keys(m.thinkingLevelMap ?? {})) if (!levels.has(k)) throw new Error(`${id}: thinkingLevelMap 非法档位 ${k}`);
    for (const [k, v] of Object.entries(m.compat ?? {})) {
      if (!compatKeys.has(k)) throw new Error(`${id}: compat 未知键 ${k}`);
      if (k === "maxTokensField" && !["max_completion_tokens", "max_tokens"].includes(v)) throw new Error(`${id}: maxTokensField 非法`);
      if (k === "thinkingFormat" && !["deepseek", "qwen"].includes(v)) throw new Error(`${id}: thinkingFormat 非法`);
    }
    if (m.cost) for (const [k, v] of Object.entries(m.cost)) if (typeof v !== "number" || v < 0) throw new Error(`${id}: cost.${k} 非法`);
    if (m.deprecated !== undefined && typeof m.deprecated !== "boolean") throw new Error(`${id}: deprecated 非法`);
  }
}

function scalar(v) {
  if (typeof v === "string") return JSON.stringify(v);
  return String(v);
}

/** 对象值:整行(含缩进与尾逗号)不超宽则内联,否则逐键展开(递归)。 */
function tsValue(v, indent) {
  if (Array.isArray(v)) return `[${v.map(scalar).join(", ")}]`;
  if (v === null || typeof v !== "object") return scalar(v);
  const pad = " ".repeat(indent);
  const inner = Object.entries(v).map(([k, val]) => `${k}: ${tsValue(val, indent + 2)}`);
  const inline = `{ ${inner.join(", ")} }`;
  if (pad.length + inline.length + 1 <= PRINT_WIDTH) return inline;
  return `{\n${inner.map((l) => " ".repeat(indent + 2) + l + ",").join("\n")}\n${pad}}`;
}

function renderTable(doc, rev) {
  const ids = Object.keys(doc.models);
  const head = [
    `${BEGIN} — 由 scripts/sync-model-meta.mjs 从 canonical gist 生成,勿手改`,
    // 头部只放 rev 与数量:内容不变则重生成逐字节稳定(--check 跨日不假红)
    `// canonical: gist ${GIST_ID.slice(0, 8)}${rev ? ` @ ${rev}` : ""} · ${ids.length} models`,
  ];
  const entries = ids
    .map((id) => `  ${JSON.stringify(id)}: ${tsValue(doc.models[id], 2)},`)
    .flatMap((line) => line.split("\n"));
  return [
    ...head,
    "export const KNOWN_MODELS: Record<string, MageneModelMeta> = {",
    ...entries,
    "};",
    END,
  ].join("\n");
}

const src = readFileSync(TARGET, "utf8");
const { doc, rev, online } = await fetchCanonical();
validate(doc);
const block = renderTable(doc, rev);
const vendorJson = JSON.stringify(doc, null, 2) + "\n";

let next;
if (src.includes(BEGIN) && src.includes(END)) {
  const begin = src.indexOf(BEGIN);
  const end = src.indexOf(END) + END.length;
  next = src.slice(0, begin) + block + src.slice(end);
} else {
  const decl = src.indexOf("export const KNOWN_MODELS");
  if (decl < 0) throw new Error("未找到 KNOWN_MODELS 声明");
  const close = src.indexOf("\n};", decl);
  if (close < 0) throw new Error("未找到表闭合");
  next = src.slice(0, decl) + block + src.slice(close + 3);
}

if (check) {
  if (next !== src) {
    console.log("❌ KNOWN_MODELS 表与 canonical gist 有漂移,运行 npm run sync:models 重新生成");
    process.exit(1);
  }
  if (readFileSync(VENDOR, "utf8") !== vendorJson) {
    console.log("❌ scripts/model-meta.json 与 gist 不一致,运行 npm run sync:models");
    process.exit(1);
  }
  console.log(`✅ 模型表与 canonical 一致(${online ? "gist 在线校验" : "离线,按 vendor 副本校验"})`);
  process.exit(0);
}

writeFileSync(TARGET, next);
writeFileSync(VENDOR, vendorJson);
console.log(`✓ 已生成(${online ? `gist ${rev}` : "离线 vendor 副本"},${Object.keys(doc.models).length} models)→ ${TARGET} + ${VENDOR}`);
