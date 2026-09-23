#!/usr/bin/env node
/**
 * 构建步骤：把「授权分发」CLI（仓库根 dispenser/）打进 GUI 资源目录，随安装包分发。
 *
 * 产物：gui/src-tauri/resources/dispenser/
 *   cli.ts            入口（用内置 node 24 的 TS type-stripping 直接跑，无需构建）
 *   lib/*.ts          从 pi-agent-dispenser 移植的纯逻辑（原样）
 *   VERSION           版本戳（取自 dispenser/package.json，供组件升级比较）
 *   README.md         设计与移植说明
 *
 * 运行期解析优先级（见 agent/src/runtime.ts resolveDispenserCli）：
 *   组件覆盖层 ~/.coworker/components/dispenser/current > 随包资源（本目录）。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // gui/scripts
const repoRoot = resolve(here, "..", "..");
const srcDir = join(repoRoot, "dispenser");
const outDir = resolve(here, "..", "src-tauri", "resources", "dispenser");

if (process.env.SKIP_DISPENSER === "1") {
  console.log("⏭  SKIP_DISPENSER=1，跳过授权分发 CLI 打包");
  process.exit(0);
}
if (!existsSync(join(srcDir, "cli.ts"))) throw new Error(`找不到 dispenser/cli.ts：${srcDir}`);

const pkg = JSON.parse(readFileSync(join(srcDir, "package.json"), "utf8"));
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
for (const item of ["cli.ts", "lib", "README.md", "package.json"]) {
  cpSync(join(srcDir, item), join(outDir, item), { recursive: true });
}
writeFileSync(join(outDir, "VERSION"), `${pkg.version}\n`);
console.log(`✅ 授权分发 CLI v${pkg.version} → ${outDir}`);
