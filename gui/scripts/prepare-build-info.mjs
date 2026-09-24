#!/usr/bin/env node
/**
 * 构建步骤：把「这是哪一版」写进产物，随包分发。
 *
 * 动机：打包后的 App 里没有 .git，后端算不出 commit；而调试/中间构建（改了代码直接打包，
 * 版本号没 bump）必须能和正式发版区分开——否则"本机这个到底是哪一版"无从判断。
 *
 * 产物：gui/src-tauri/resources/version.json
 *   { version, commit, dirty, builtAt, dev }
 *   dev=true 表示构建时工作区有未提交改动（即调试中间版本）。
 *
 * 运行期（gui/backend readVersionInfo）：优先读这个文件；开发形态（仓库里有 .git）实时用 git 算。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // gui/scripts
const repoRoot = resolve(here, "..", "..");
const outDir = resolve(here, "..", "src-tauri", "resources");

const version = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;

function git(args) {
  try {
    return execFileSync("git", args, { cwd: repoRoot }).toString().trim();
  } catch {
    return "";
  }
}

const commit = git(["rev-parse", "--short", "HEAD"]);
const dirty = git(["status", "--porcelain"]).length > 0;
const info = {
  version,
  commit,
  dirty,
  dev: dirty,
  builtAt: new Date().toISOString(),
};

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "version.json"), JSON.stringify(info, null, 2) + "\n");
console.log(
  `✅ 构建信息：v${version}${commit ? `+${commit}${dirty ? ".dirty" : ""}` : "（无 git 信息）"} → ${join(outDir, "version.json")}`,
);
void existsSync;
