#!/usr/bin/env node
/**
 * 构建步骤：把 Node 运行时（v24）与 lark-cli 原生二进制打进 GUI 资源目录，随安装包分发。
 *
 * 员工机零运行时依赖，且与系统已装的 node / pi / lark-cli 完全隔离：
 *   resources/runtime/
 *     node / node.exe      Node 24 自包含二进制（仅 bin/node，无其余符号）
 *     lark-cli / lark-cli.exe   lark-cli 原生二进制（Go 编译，独立可执行，无需 node）
 *     versions.json        版本戳（幂等判断用）
 *
 * 来源与固定版本（环境变量可覆盖，利于内网镜像 / 复现构建）：
 *   NODE_RUNTIME_VERSION   默认 24.20.0
 *   LARK_CLI_VERSION       默认 1.0.93
 *   NODE_MIRROR            默认 https://nodejs.org/dist
 *   LARK_CLI_MIRROR        默认 https://github.com/larksuite/cli/releases/download
 *                          （GitHub 失败时自动回退 registry.npmmirror.com 二进制镜像）
 *
 * 幂等：runtime/<out> 存在且 versions.json 版本匹配则跳过；--force 强制重下。
 * 校验：node 按官方 SHASUMS256.txt 校验 SHA-256；lark-cli 解包后跑 --version 冒烟。
 * 跳过：SKIP_RUNTIME=1 时直接退出（纯开发构建不想拉二进制时用）。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // gui/scripts
const runtimeDir = resolve(here, "..", "src-tauri", "resources", "runtime");

if (process.env.SKIP_RUNTIME === "1") {
  console.log("⏭  SKIP_RUNTIME=1，跳过运行时打包");
  process.exit(0);
}

const NODE_VERSION = process.env.NODE_RUNTIME_VERSION ?? "24.20.0";
const LARK_VERSION = process.env.LARK_CLI_VERSION ?? "1.0.93";
const NODE_MIRROR = (process.env.NODE_MIRROR ?? "https://nodejs.org/dist").replace(/\/+$/, "");
const LARK_MIRROR = (process.env.LARK_CLI_MIRROR ?? "https://github.com/larksuite/cli/releases/download").replace(/\/+$/, "");
const LARK_FALLBACK_MIRROR = "https://registry.npmmirror.com/-/binary/lark-cli";

const PLATFORM = process.platform;
const ARCH = process.arch;

/** 平台 → 归档/入口/输出文件名映射 */
function layout() {
  if (PLATFORM === "darwin") {
    if (ARCH !== "arm64" && ARCH !== "x64") fail(`macOS 暂不支持架构 ${ARCH}`);
    const nv = `node-v${NODE_VERSION}-darwin-${ARCH}`;
    // lark-cli 发布归档的架构命名：x64 → amd64（见其 scripts/install.js ARCH_MAP）
    const larkArch = ARCH === "x64" ? "amd64" : ARCH;
    return {
      label: `${PLATFORM}-${ARCH}`,
      node: { archive: `${nv}.tar.gz`, entry: `${nv}/bin/node`, out: "node" },
      lark: {
        archive: `lark-cli-${LARK_VERSION}-darwin-${larkArch}.tar.gz`,
        entry: "lark-cli",
        out: "lark-cli",
        verify: ["--version"],
      },
    };
  }
  if (PLATFORM === "win32") {
    if (ARCH !== "x64") fail(`Windows 暂不支持架构 ${ARCH}（请用 x64 构建机）`);
    return {
      label: `${PLATFORM}-${ARCH}`,
      node: { archive: `node-v${NODE_VERSION}-win-x64.zip`, entry: "node.exe", out: "node.exe" },
      lark: {
        archive: `lark-cli-${LARK_VERSION}-windows-amd64.zip`,
        entry: "lark-cli.exe",
        out: "lark-cli.exe",
        verify: ["--version"],
      },
    };
  }
  fail(`prepare-runtime 仅支持 macOS / Windows 构建（当前 ${PLATFORM}）`);
}

const L = layout();
const VERSION_FILE = join(runtimeDir, "versions.json");
const expectedVersions = { node: NODE_VERSION, larkCli: LARK_VERSION, platform: L.label };

/** 幂等：目标文件 + 版本戳齐全则跳过 */
function upToDate() {
  if (process.argv.includes("--force")) return false;
  for (const { out } of [L.node, L.lark]) {
    if (!existsSync(join(runtimeDir, out))) return false;
  }
  try {
    const v = JSON.parse(readFileSync(VERSION_FILE, "utf8"));
    return v.node === expectedVersions.node && v.larkCli === expectedVersions.larkCli && v.platform === expectedVersions.platform;
  } catch {
    return false;
  }
}

async function fetchBuffer(url, label) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      process.stderr.write(`  ↓ ${label}${attempt > 1 ? " (重试)" : ""}: ${url}\n`);
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw lastErr;
}

/** 下载 →（可选校验）→ 解包 → 拷出目标文件 */
async function stage(meta, { url, checksumUrl }, verifyCmd) {
  const outPath = join(runtimeDir, meta.out);
  const tmpDir = join(runtimeDir, ".tmp-" + meta.out);
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  const archivePath = join(tmpDir, meta.archive);
  try {
    let buf = await fetchBuffer(url, meta.archive);
    if (checksumUrl) {
      const shas = await fetchBuffer(checksumUrl, "SHASUMS256.txt").catch(() => null);
      if (shas) {
        const want = shas
          .toString("utf8")
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l.endsWith(`  ${meta.archive}`) || l.endsWith(` *${meta.archive}`))
          ?.split(/\s+/)[0];
        if (want) {
          const got = createHash("sha256").update(buf).digest("hex");
          if (got !== want) fail(`SHA-256 校验失败: ${meta.archive}\n  期望 ${want}\n  实际 ${got}`);
          process.stderr.write(`  ✓ sha256 校验通过\n`);
        } else {
          process.stderr.write(`  ⚠ SHASUMS256.txt 中未找到 ${meta.archive}，跳过校验\n`);
        }
      } else {
        process.stderr.write(`  ⚠ 无法获取校验清单（${checksumUrl}），跳过 SHA-256 校验\n`);
      }
    }
    writeFileSync(archivePath, buf);

    // 解包（bsdtar/GNU tar 都支持 .tar.gz 与 .zip；Windows 10+ 自带 tar.exe）
    const isZip = meta.archive.endsWith(".zip");
    const cmd = PLATFORM === "win32" ? "tar.exe" : "tar";
    execFileSync(cmd, [isZip ? "-xf" : "-xzf", archivePath, "-C", tmpDir], { stdio: "pipe" });

    // 找目标入口（zip 顶层目录可能带版本号前缀）
    let entry = join(tmpDir, meta.entry);
    if (!existsSync(entry)) {
      const top = directoryEntries(tmpDir).find((d) => !d.startsWith("."));
      const alt = top ? join(tmpDir, top, meta.entry) : null;
      if (alt && existsSync(alt)) entry = alt;
      else fail(`解包后未找到 ${meta.entry}`);
    }

    mkdirSync(runtimeDir, { recursive: true });
    rmSync(outPath, { force: true });
    copyWithMode(entry, outPath, 0o755);
    process.stderr.write(`  ✓ ${meta.out} (${(statSync(outPath).size / 1024 / 1024).toFixed(1)} MB)\n`);

    if (verifyCmd) {
      try {
        const r = execFileSync(outPath, verifyCmd, { encoding: "utf8", timeout: 30_000 });
        process.stderr.write(`  ✓ 冒烟: ${outPath} ${verifyCmd.join(" ")} → ${r.trim().split("\n")[0]}\n`);
      } catch (e) {
        fail(`冒烟失败: ${outPath} ${verifyCmd.join(" ")} — ${e?.message ?? String(e)}`);
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function directoryEntries(dir) {
  return readdirSync(dir);
}

function copyWithMode(src, dst, mode) {
  copyFileSync(src, dst);
  if (PLATFORM !== "win32") {
    try {
      chmodSync(dst, mode);
    } catch {
      /* windows 无 chmod 语义 */
    }
  }
}

function fail(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

async function main() {
  if (upToDate()) {
    console.log(`✅ 运行时已就绪（node v${NODE_VERSION} + lark-cli v${LARK_VERSION} @ ${L.label}），跳过下载`);
    return;
  }

  console.log(`📦 准备内置运行时（${L.label}）：node v${NODE_VERSION}，lark-cli v${LARK_VERSION}`);
  const svc = await Promise.allSettled([
    (async () => {
      const url = `${NODE_MIRROR}/v${NODE_VERSION}/${L.node.archive}`;
      await stage(L.node, { url, checksumUrl: `${NODE_MIRROR}/v${NODE_VERSION}/SHASUMS256.txt` }, null);
    })(),
    (async () => {
      const primary = `${LARK_MIRROR}/v${LARK_VERSION}/${L.lark.archive}`;
      const fallback = `${LARK_FALLBACK_MIRROR}/v${LARK_VERSION}/${L.lark.archive}`;
      try {
        await stage(L.lark, { url: primary, checksumUrl: null }, L.lark.verify);
      } catch (e) {
        process.stderr.write(`  ⚠ GitHub 下载失败（${e?.message ?? e}），回退 npmmirror 镜像…\n`);
        await stage(L.lark, { url: fallback, checksumUrl: null }, L.lark.verify);
      }
    })(),
  ]);

  for (const [i, s] of svc.entries()) {
    if (s.status === "rejected") {
      fail(`${i === 0 ? "Node" : "lark-cli"} 下载失败：${s.reason?.message ?? String(s.reason)}`);
    }
  }

  writeFileSync(VERSION_FILE, JSON.stringify(expectedVersions, null, 2) + "\n");
  const totalMb = (statSync(join(runtimeDir, L.node.out)).size + statSync(join(runtimeDir, L.lark.out)).size) / 1024 / 1024;
  console.log(`✅ 内置运行时已准备：${runtimeDir}（共 ${totalMb.toFixed(1)} MB，node v${NODE_VERSION} + lark-cli v${LARK_VERSION}）`);
}

main().catch((e) => {
  console.error("❌ prepare-runtime 失败:", e?.message ?? e);
  process.exit(1);
});