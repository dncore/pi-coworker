/**
 * 把 DESIGN.md + docs/PRODUCT-PLAN.md 合并为一个飞书 markdown 文件。
 * 对代码块/行内代码外的 `<` 转义为 `\<`（否则会被飞书当作 XML 标签解析）。
 * 输出：<root>/.coworker/feishu-design-combined.md（供 lark-cli @./ 相对路径导入）
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const plan = readFileSync(join(root, "docs", "PRODUCT-PLAN.md"), "utf8");
const design = readFileSync(join(root, "DESIGN.md"), "utf8");

const COVER =
  "# coworker 企业 AI 助手 · 设计方案\n\n" +
  "> 本文档由产品方案（docs/PRODUCT-PLAN.md）与技术设计（DESIGN.md）合并导入。\n\n---\n\n";

/** 仅对代码围栏外且不在行内代码反引号内的 `<` 转义 */
function escapeMarkdown(text) {
  const lines = text.split("\n");
  const out = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    out.push(escapeAngleOutsideBackticks(line));
  }
  return out.join("\n");
}

function escapeAngleOutsideBackticks(line) {
  let res = "";
  let inTick = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "`") {
      inTick = !inTick;
      res += ch;
      continue;
    }
    if (ch === "<" && !inTick) {
      res += "\\<";
      continue;
    }
    res += ch;
  }
  return res;
}

const combined = COVER + escapeMarkdown(plan) + "\n\n---\n\n" + escapeMarkdown(design) + "\n";

const outPath = join(root, ".coworker", "feishu-design-combined.md");
mkdirSync(join(root, ".coworker"), { recursive: true });
writeFileSync(outPath, combined, "utf8");
console.log("✅ 已生成:", outPath, "(", combined.length, "字符 )");
