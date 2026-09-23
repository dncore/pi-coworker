#!/usr/bin/env node
/**
 * 构建步骤：把公司指定的 pi 扩展包（npm 包）打进 GUI 资源目录，随安装包分发。
 *
 * 员工机通常没有 npm / 无外网：这里在**构建机**用 npm 把依赖树解析好，
 * 运行时由后端离线「装配」进 app 专属 pi 环境（~/.coworker/pi-agent/npm/ + settings.json）。
 *
 * 产物：gui/src-tauri/resources/pi-packages/
 *   node_modules/…    完整依赖树（npm install --omit=dev 产出）
 *   packages.json     { packages: [{name, version}], builtAt, registry }
 *
 * 包清单来源：环境变量 PI_PACKAGES（逗号分隔）覆盖，默认如下三个。
 * 镜像：NPM_REGISTRY 可覆盖（默认 https://registry.npmjs.org）。
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // gui/scripts
const outDir = resolve(here, "..", "src-tauri", "resources", "pi-packages");

if (process.env.SKIP_PI_PACKAGES === "1") {
  console.log("⏭  SKIP_PI_PACKAGES=1，跳过 pi 扩展包打包");
  process.exit(0);
}

const DEFAULT_PACKAGES = ["@juicesharp/rpiv-ask-user-question", "@juicesharp/rpiv-todo"];
const packages = (process.env.PI_PACKAGES ?? DEFAULT_PACKAGES.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
const registry = (process.env.NPM_REGISTRY ?? "https://registry.npmjs.org").replace(/\/+$/, "");

console.log(`== 打包 pi 扩展包（${packages.length} 个，registry=${registry}）==`);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

execFileSync("npm", [
  "install",
  "--prefix", outDir,
  "--omit=dev",
  // peerDependencies 指向宿主 pi 的 SDK（@earendil-works/*，400MB+），由宿主提供，
  // 绝不能打进安装包——npm 7+ 默认自动装 peer，这里显式关掉。
  "--omit=peer",
  "--no-audit",
  "--no-fund",
  "--registry", registry,
  "--loglevel", "error",
  ...packages,
], { stdio: "inherit" });

// 记录实际版本（含间接依赖，用于幂等装配判断）
const installed = [];
for (const name of packages) {
  const pj = join(outDir, "node_modules", ...name.split("/"), "package.json");
  if (!existsSync(pj)) throw new Error(`安装后找不到 ${name}`);
  const j = JSON.parse(readFileSync(pj, "utf8"));
  installed.push({ name: j.name, version: j.version });
}
const manifest = { packages: installed, builtAt: new Date().toISOString(), registry };
writeFileSync(join(outDir, "packages.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`✅ ${installed.map((p) => `${p.name}@${p.version}`).join(", ")} → ${outDir}`);
