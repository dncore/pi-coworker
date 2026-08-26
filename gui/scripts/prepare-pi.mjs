#!/usr/bin/env node
/**
 * 构建步骤：把 pi CLI（自包含 bundle）打进 GUI 资源目录，随安装包分发。
 *
 * pi 的 `dist/bundle/` 是自包含产物（cli.js + chunks，仅依赖 node 内置模块），
 * 不需要额外 node_modules。GUI 后端已要求 Node.js ≥ 18，因此直接以 node 运行该 bundle。
 *
 * 来源解析优先级：
 *   1. $PI_BIN 环境变量（指向 pi cli.js 所在目录或 dist/bundle 目录）
 *   2. 全局安装的 pi（`which pi` → realpath → dist/bundle）
 *   3. 仓库 devDependency（node_modules/@earendil-works/pi-coding-agent/dist/bundle）
 *
 * 产物：gui/src-tauri/resources/pi/
 *   ├─ dist/bundle/   pi CLI 自包含 bundle
 *   ├─ pi.mjs         启动器（转发 argv 到 bundle，供 spawn 使用）
 *   └─ VERSION        pi 版本号
 */
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // gui/scripts
const guiRoot = resolve(here, "..");
const repoRoot = resolve(guiRoot, "..");
const outDir = join(guiRoot, "src-tauri", "resources", "pi");

const LAUNCHER = `#!/usr/bin/env node
// pi 启动器（随 GUI 打包）—— 把命令行参数转发给自包含的 pi bundle。
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = join(dirname(fileURLToPath(import.meta.url)), "dist", "bundle", "cli.js");
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
`;

/** 检查目录是否为合法的 pi bundle（含 cli.js 与 chunks/） */
function isBundleDir(d) {
  return existsSync(join(d, "cli.js")) && existsSync(join(d, "chunks"));
}

/**
 * 从某个 pi 入口（文件或目录）定位 bundle 目录。
 * 兼容两种布局：
 *   bundle 布局：<pkg>/dist/bundle/cli.js（自包含，npm 全局安装 0.84.3+）
 *   源码布局：  <pkg>/dist/cli.js（无 bundle，npm 包源码布局）→ 向上找 dist/bundle
 */
function locateBundle(entry) {
  let e = entry;
  try {
    e = realpathSync(entry);
  } catch {
    return null;
  }
  const dir = statSync(e).isDirectory() ? e : dirname(e);
  // 1) 入口本身是 bundle
  if (isBundleDir(dir)) return dir;
  // 2) 向上逐级找 <pkg>/dist/bundle
  for (let d = dir; d !== dirname(d); d = dirname(d)) {
    const b = join(d, "dist", "bundle");
    if (isBundleDir(b)) return b;
  }
  return null;
}

/** 解析 pi bundle 目录 */
function resolveBundle() {
  const entries = [];
  // 1) $PI_BIN（可指向 cli.js、目录或 dist/bundle 目录）
  if (process.env.PI_BIN) entries.push(resolve(process.env.PI_BIN));
  // 2) PATH 上所有 pi（which -a；npm run 会把 node_modules/.bin 放最前，
  //    可能命中仓库 devDependency 的源码布局，需逐个尝试向上找 bundle）
  try {
    const out = execSync("which -a pi 2>/dev/null || type -a pi 2>/dev/null", { encoding: "utf8" });
    for (const line of out.split("\n")) {
      const p = line.trim().replace(/^pi is /, "");
      if (p) entries.push(resolve(p));
    }
  } catch {
    /* 无 pi 命令 */
  }
  // 3) 仓库 devDependency 的 dist/bundle
  entries.push(join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle"));

  for (const entry of entries) {
    const b = locateBundle(entry);
    if (b) return b;
  }
  return null;
}

const src = resolveBundle();
if (!src) {
  console.error(
    "❌ 未找到 pi bundle。请先安装 pi：npm install -g @earendil-works/pi-coding-agent（或设置 PI_BIN 指向 dist/bundle 目录）",
  );
  process.exit(1);
}

// 拷贝 bundle（只拷贝 cli.js + chunks/）与运行时资源（主题/导出模板/交互资源）
rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, "dist", "bundle", "chunks"), { recursive: true });
cpSync(join(src, "cli.js"), join(outDir, "dist", "bundle", "cli.js"));
cpSync(join(src, "chunks"), join(outDir, "dist", "bundle", "chunks"), { recursive: true });
// 运行时按 packageDir/dist/… 解析的静态资源（源包同路径拷贝）
for (const rel of ["modes/interactive/theme", "modes/interactive/assets", "core/export-html/template.css", "core/export-html/template.html"]) {
  const from = join(src, "..", rel);
  if (existsSync(from)) cpSync(from, join(outDir, "dist", rel), { recursive: true });
}
writeFileSync(join(outDir, "pi.mjs"), LAUNCHER);

// 真实 pi 版本（读源包 package.json；pi 会向上查找脚本所在目录的 package.json 报告版本）
let version = "unknown";
try {
  const srcPkg = join(src, "..", "..", "package.json");
  version = JSON.parse(readFileSync(srcPkg, "utf8")).version || version;
} catch {
  /* 读取失败不阻塞构建 */
}
// 让打包后的 pi 报告真实版本，而不是向上误认到应用目录的 package.json
writeFileSync(
  join(outDir, "package.json"),
  JSON.stringify({ name: "@earendil-works/pi-coding-agent", version, type: "module", private: true }, null, 2) + "\n",
);
writeFileSync(join(outDir, "VERSION"), `${version}\n`);

const sizeMb = (statSync(join(outDir, "dist", "bundle", "cli.js")).size / 1024 / 1024).toFixed(1);
console.log(`✅ pi bundle 已准备：${outDir} (pi v${version}, ${sizeMb}MB 主文件)`);
