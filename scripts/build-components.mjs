#!/usr/bin/env node
/**
 * 构建「内嵌组件更新源」产物目录（供公司内网静态托管，配合 deploy.json.componentFeedUrl）。
 *
 * 用法（在仓库根、对应平台的构建机上跑；Windows 用 Win10 自带 tar.exe）：
 *   node scripts/build-components.mjs --out dist/components \
 *     [--lark-cli <lark-cli 二进制路径>]      # 不给则跳过 lark-cli 组件
 *     [--lark-cli-version 1.0.96]            # 不给则跑 --version 探测
 *     [--pi-dir gui/src-tauri/resources/pi]  # 默认取仓库内已构建的 pi（含 VERSION）
 *     [--skills-dir skills]
 *     [--skills-version 2026.09.23]          # 不给则取当天日期（YYYY.MM.DD）
 *
 * 产物：<out>/<platform>/
 *   manifest.json            组件清单（version/file/sha256/kind）——客户端据此校验安装
 *   lark-cli[.exe]           kind=file 的裸二进制
 *   pi-<ver>.tar.gz          kind=targz 的文件树（pi.mjs + dist/ + VERSION）
 *   skills-<ver>.tar.gz      kind=targz（coworker/SKILL.md 等）
 *
 * 托管示例：把 <out>/ 整个目录放到 https://<portal>/components/，
 * deploy.json 写 { "componentFeedUrl": "https://<portal>/components" }。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, copyFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const outBase = resolve(repoRoot, arg("out", "dist/components"));
const platform = `${process.platform}-${process.arch}`;
const out = join(outBase, platform);
mkdirSync(out, { recursive: true });

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }).trim();

const components = {};

// ---- lark-cli（裸二进制） ----
const larkSrc = arg("lark-cli", "");
if (larkSrc) {
  const src = resolve(larkSrc);
  if (!existsSync(src)) throw new Error(`找不到 lark-cli：${src}`);
  const ver = arg("lark-cli-version", "") || run(src, ["--version"]).replace(/^\s*(lark-cli\s+)?(version\s+)?/i, "").split("\n")[0].trim();
  if (!/^\d+\.\d+\.\d+/.test(ver)) throw new Error(`lark-cli 版本探测失败：${ver}`);
  const entry = process.platform === "win32" ? "lark-cli.exe" : "lark-cli";
  copyFileSync(src, join(out, entry));
  components["lark-cli"] = { version: ver, file: entry, sha256: sha(join(out, entry)), kind: "file", entry };
  console.log(`✔ lark-cli ${ver} → ${entry}`);
} else {
  console.log("⏭  未提供 --lark-cli，跳过（托管目录将不含该项，客户端保持随包版本）");
}

// ---- pi（tar.gz） ----
const piDir = resolve(repoRoot, arg("pi-dir", "gui/src-tauri/resources/pi"));
if (existsSync(join(piDir, "pi.mjs"))) {
  if (!existsSync(join(piDir, "VERSION"))) throw new Error(`pi 目录缺 VERSION 文件：${piDir}`);
  const ver = readFileSync(join(piDir, "VERSION"), "utf8").trim();
  const file = `pi-${ver}.tar.gz`;
  execFileSync("tar", ["czf", join(out, file), "-C", piDir, "."]);
  components.pi = { version: ver, file, sha256: sha(join(out, file)), kind: "targz" };
  console.log(`✔ pi ${ver} → ${file}`);
} else {
  console.log(`⏭  无 pi 产物（${piDir}），跳过`);
}

// ---- skills（tar.gz） ----
const skDir = resolve(repoRoot, arg("skills-dir", "skills"));
if (existsSync(skDir) && statSync(skDir).isDirectory()) {
  const ver = arg("skills-version", "") || new Date().toISOString().slice(0, 10).replace(/-/g, ".");
  const file = `skills-${ver}.tar.gz`;
  execFileSync("tar", ["czf", join(out, file), "-C", skDir, "."]);
  components.skills = { version: ver, file, sha256: sha(join(out, file)), kind: "targz" };
  console.log(`✔ skills ${ver} → ${file}`);
} else {
  console.log(`⏭  无 skills 目录（${skDir}），跳过`);
}

// ---- dispenser（授权分发 CLI；tar.gz，版本取 dispenser/package.json） ----
const dispDir = resolve(repoRoot, arg("dispenser-dir", "dispenser"));
if (existsSync(join(dispDir, "cli.ts"))) {
  const ver = arg("dispenser-version", "") || JSON.parse(readFileSync(join(dispDir, "package.json"), "utf8")).version;
  const file = `dispenser-${ver}.tar.gz`;
  execFileSync("tar", ["czf", join(out, file), "-C", dispDir, "."]);
  components.dispenser = { version: ver, file, sha256: sha(join(out, file)), kind: "targz" };
  console.log(`✔ dispenser ${ver} → ${file}`);
} else {
  console.log(`⏭  无 dispenser 目录（${dispDir}），跳过`);
}

if (Object.keys(components).length === 0) throw new Error("没有任何组件可打包（至少给一个来源）");

const manifest = { platform, generatedAt: new Date().toISOString(), components };
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`\n✅ 组件源已生成：${out}`);
console.log(JSON.stringify(manifest, null, 2));
console.log(`\n托管后 deploy.json 写：{ "componentFeedUrl": "https://<host>/<组件源根路径>" }`);
