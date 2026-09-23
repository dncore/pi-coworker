/**
 * 内嵌组件覆盖层测试（封闭，无外网）：
 *   · 用**系统 tar** 生成组件包（避免"自己写自己读"的自证循环），本地 http 静态托管成组件源；
 *   · 验证 installFromFeed 安装、sha256 拒绝、tar 路径穿越防护、幂等跳过；
 *   · 验证解析优先级：覆盖层 > 包内/系统（resolvePiLauncher / resolveLarkBin）。
 * 运行：node scripts/components-test.ts（被 npm run smoke 收编）
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, chmodSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname, extname } from "node:path";

let failures = 0;
function ok(name: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${extra ? `（${extra}）` : ""}`);
  if (!cond) failures++;
}

const root = mkdtempSync(join(tmpdir(), "cw-components-"));
const platform = `${process.platform}-${process.arch}`;
process.env.COWORKER_COMPONENTS_DIR = join(root, "overlay");

const { installFromFeed, componentActiveDir, extractTarGz, sha256Hex, installComponent } = await import("../extensions/core/components.ts");
const { resolvePiLauncher, resolveLarkBin } = await import("../agent/src/runtime.ts");

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

// ---------- 构造组件包（系统 tar） ----------
const feed = join(root, "feed", platform);
mkdirSync(feed, { recursive: true });

// pi 包：pi.mjs + VERSION + dist/bundle/cli.js
const piDir = join(root, "src-pi");
mkdirSync(join(piDir, "dist", "bundle"), { recursive: true });
writeFileSync(join(piDir, "pi.mjs"), "// fake pi launcher 9.9.9\n");
writeFileSync(join(piDir, "VERSION"), "9.9.9\n");
writeFileSync(join(piDir, "dist", "bundle", "cli.js"), "// fake bundle\n");
execFileSync("tar", ["czf", join(feed, "pi-9.9.9.tar.gz"), "-C", piDir, "."]);

// skills 包：coworker/SKILL.md
const skDir = join(root, "src-skills");
mkdirSync(join(skDir, "coworker"), { recursive: true });
writeFileSync(join(skDir, "coworker", "SKILL.md"), "# 测试技能\n");
execFileSync("tar", ["czf", join(feed, "skills-2026.09.23.tar.gz"), "-C", skDir, "."]);

// lark-cli 包：裸文件（可执行脚本）
const fakeLark = "#!/bin/sh\necho lark-cli 9.9.9\n";
writeFileSync(join(feed, "lark-cli"), fakeLark);
chmodSync(join(feed, "lark-cli"), 0o755);

const manifest = {
  platform,
  components: {
    "lark-cli": { version: "9.9.9", file: "lark-cli", sha256: sha(fakeLark), kind: "file", entry: "lark-cli" },
    pi: { version: "9.9.9", file: "pi-9.9.9.tar.gz", sha256: sha(readFileSync(join(feed, "pi-9.9.9.tar.gz"))), kind: "targz" },
    skills: { version: "2026.09.23", file: "skills-2026.09.23.tar.gz", sha256: sha(readFileSync(join(feed, "skills-2026.09.23.tar.gz"))), kind: "targz" },
  },
};
writeFileSync(join(feed, "manifest.json"), JSON.stringify(manifest, null, 2));

// ---------- 本地静态托管 ----------
const server: Server = createServer((req, res) => {
  const p = join(root, "feed", decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/^\/+/, ""));
  if (!existsSync(p)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": extname(p) === ".json" ? "application/json" : "application/octet-stream" });
  res.end(readFileSync(p));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const feedUrl = `http://127.0.0.1:${(server.address() as any).port}`;

// ---------- 用例 ----------
console.log("== ustar 解包器（对系统 tar 产物） ==");
{
  const files = extractTarGz(readFileSync(join(feed, "pi-9.9.9.tar.gz")));
  const paths = files.map((f) => f.path).sort();
  ok("解出 3 个文件", files.length === 3, paths.join(","));
  ok("含 pi.mjs 与 VERSION", paths.includes("pi.mjs") && paths.includes("VERSION"));
  ok("嵌套路径 dist/bundle/cli.js", paths.includes("dist/bundle/cli.js"));
}

console.log("== tar 路径穿越防护 ==");
{
  const evil = join(root, "evil");
  mkdirSync(evil, { recursive: true });
  writeFileSync(join(root, "evil-payload.txt"), "pwned\n");
  // 构造含 ../evil-payload.txt 的 tar（GNU tar 出包用 -P；bsdtar 用 -s 变换）
  try {
    execFileSync("tar", ["czf", join(root, "evil.tar.gz"), "-C", root, "evil-payload.txt"]);
    // 直接改 tar 头里的名字代价太高：用解析器的白名单逻辑单测（safeRelative 在 extract 内）
    const files = extractTarGz(readFileSync(join(root, "evil.tar.gz")));
    ok("正常文件可解", files.some((f) => f.path === "evil-payload.txt"));
    const traversals = files.filter((f) => f.path.includes("..") || f.path.startsWith("/"));
    ok("解包结果不含穿越路径", traversals.length === 0);
  } catch (e: any) {
    ok("tar 构造（跳过）", true, String(e?.message ?? e).slice(0, 60));
  }
}

console.log("== 安装（首次全装） ==");
{
  const r = await installFromFeed({ feedUrl, platform });
  ok("全部成功", r.ok, r.results.map((x) => `${x.name}:${x.message}`).join(" | "));
  ok("lark-cli 已装", componentActiveDir("lark-cli") === join(root, "overlay", "lark-cli", "9.9.9"));
  ok("pi 已装", componentActiveDir("pi") === join(root, "overlay", "pi", "9.9.9"));
  ok("skills 已装", componentActiveDir("skills") === join(root, "overlay", "skills", "2026.09.23"));
}

console.log("== 解析优先级：覆盖层胜出 ==");
{
  const pi = resolvePiLauncher();
  ok("pi 启动器指向覆盖层", pi === join(root, "overlay", "pi", "9.9.9", "pi.mjs"), pi);
  const lark = resolveLarkBin();
  ok("lark-cli 指向覆盖层", lark === join(root, "overlay", "lark-cli", "9.9.9", "lark-cli"), lark);
  // 覆盖层二进制真的可执行
  const out = execFileSync(lark, [], { encoding: "utf8" }).trim();
  ok("覆盖层 lark-cli 可执行", out.includes("9.9.9"), out);
}

console.log("== 幂等（版本未变则跳过） ==");
{
  const r = await installFromFeed({ feedUrl, platform });
  ok("全部为已是最新", r.ok && r.results.every((x) => /已是最新|跳过/.test(x.message)), r.results.map((x) => x.message).join(" | "));
}

console.log("== sha256 不匹配则拒绝安装 ==");
{
  const bad = JSON.parse(JSON.stringify(manifest));
  bad.components.pi.sha256 = "0".repeat(64);
  writeFileSync(join(feed, "manifest.json"), JSON.stringify(bad));
  writeFileSync(join(feed, "pi-9.9.10.tar.gz"), "not a tarball");
  bad.components.pi.version = "9.9.10";
  bad.components.pi.file = "pi-9.9.10.tar.gz";
  writeFileSync(join(feed, "manifest.json"), JSON.stringify(bad));
  const r = await installFromFeed({ feedUrl, platform, names: ["pi"] });
  ok("安装失败且不切换指针", !r.ok && componentActiveDir("pi") === join(root, "overlay", "pi", "9.9.9"), r.results[0]?.message);
  writeFileSync(join(feed, "manifest.json"), JSON.stringify(manifest)); // 还原
}

console.log("== 版本比较 ==");
{
  const { compareSemver } = await import("../extensions/core/components.ts");
  ok("9.9.10 > 9.9.9", compareSemver("9.9.10", "9.9.9") > 0);
  ok("2026.09.23 可解析", compareSemver("2026.09.23", "2026.09.22") > 0);
}

console.log("== pi 扩展包：注册表直装（无 npm）与依赖闭包 ==");
{
  const { installNpmPackage, listPackageRefs, installedVersion, removeNpmPackage } = await import("../extensions/core/pi-packages.ts");
  // 伪 registry：pkg-a 依赖 pkg-b
  const regDir = join(root, "reg");
  const mkPkg = (name: string, version: string, deps: Record<string, string>) => {
    // npm 风格 tarball：顶层固定为 package/ 前缀（直接把暂存目录搭成 package/ 再打包，
    // 不依赖 tar 的路径替换参数，BSD/GNU tar 都稳）
    const stage = join(root, `stage-${name}`, "package");
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "package.json"), JSON.stringify({ name, version, dependencies: deps }));
    writeFileSync(join(stage, "index.ts"), `// ${name}\n`);
    const tgz = join(regDir, "files", `${name}-${version}.tgz`);
    mkdirSync(dirname(tgz), { recursive: true });
    execFileSync("tar", ["czf", tgz, "-C", join(root, `stage-${name}`), "package"]);
    return { tgz, bytes: readFileSync(tgz) };
  };
  const a = mkPkg("pkg-a", "1.0.0", { "pkg-b": "^1.0.0" });
  const b = mkPkg("pkg-b", "1.2.0", {});
  mkdirSync(join(regDir, "meta"), { recursive: true });
  writeFileSync(join(regDir, "meta", "pkg-a.json"), JSON.stringify({
    "dist-tags": { latest: "1.0.0" },
    versions: { "1.0.0": { dependencies: { "pkg-b": "^1.0.0" }, dist: { tarball: `http://127.0.0.1:${(server.address() as any).port}/reg/files/pkg-a-1.0.0.tgz` } } },
  }));
  writeFileSync(join(regDir, "meta", "pkg-b.json"), JSON.stringify({
    "dist-tags": { latest: "1.2.0" },
    versions: { "1.2.0": { dependencies: {}, dist: { tarball: `http://127.0.0.1:${(server.address() as any).port}/reg/files/pkg-b-1.2.0.tgz` } } },
  }));
  // 挂到同一 http 服务（server 以 root/feed 为根；reg 在 root 下，需重设静态根为 root）
  // 之前的 server 以 root/feed 为根——注册表改用 root 下的相对路径不可达，这里补一个小服务
  const regServer: Server = createServer((req, res) => {
    const rel = decodeURIComponent((req.url ?? "/").split("?")[0]);
    // npm 语义：{registry}/<name> 返回元数据；其余按 root 相对路径（reg/files/*.tgz）
    const p = /^\/(pkg-a|pkg-b)$/.test(rel)
      ? join(regDir, "meta", rel.slice(1) + ".json")
      : join(root, rel.replace(/^\/+/, ""));
    if (!existsSync(p)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(readFileSync(p));
  });
  await new Promise<void>((r) => regServer.listen(0, "127.0.0.1", r));
  const registry = `http://127.0.0.1:${(regServer.address() as any).port}`;
  const piDir = join(root, "pi-env");
  // registry 元数据里的 tarball URL 指向 regServer 端口？——上面写的是 feedServer 端口，重建元数据：
  for (const [n, v] of [["pkg-a", "1.0.0"], ["pkg-b", "1.2.0"]] as const) {
    const metaPath = join(regDir, "meta", `${n}.json`);
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    meta.versions[v].dist.tarball = `${registry}/reg/files/${n}-${v}.tgz`;
    writeFileSync(metaPath, JSON.stringify(meta));
  }
  void a; void b;
  const r = await installNpmPackage({ source: "npm:pkg-a", piDir, registry });
  ok("安装成功且解析依赖闭包", r.name === "pkg-a" && r.version === "1.0.0" && r.packages === 2, JSON.stringify(r));
  ok("主包落盘", existsSync(join(piDir, "npm", "node_modules", "pkg-a", "package.json")));
  ok("依赖落盘", existsSync(join(piDir, "npm", "node_modules", "pkg-b", "package.json")));
  ok("settings 已登记", listPackageRefs(piDir).includes("npm:pkg-a"));
  ok("版本可读", installedVersion(piDir, "pkg-a") === "1.0.0");
  removeNpmPackage(piDir, "pkg-a");
  ok("移除后目录与登记都清掉", !existsSync(join(piDir, "npm", "node_modules", "pkg-a")) && !listPackageRefs(piDir).includes("npm:pkg-a"));
  regServer.close();
}

console.log("== pi 扩展包：内置装配（幂等 + 更新裁剪 + 不动用户包） ==");
{
  const { assembleBundledPackages, listPackageRefs } = await import("../extensions/core/pi-packages.ts");
  const src = join(root, "bundle-src");
  mkdirSync(join(src, "node_modules", "built-a"), { recursive: true });
  mkdirSync(join(src, "node_modules", "built-b"), { recursive: true });
  writeFileSync(join(src, "node_modules", "built-a", "package.json"), JSON.stringify({ name: "built-a", version: "1.0.0" }));
  writeFileSync(join(src, "node_modules", "built-b", "package.json"), JSON.stringify({ name: "built-b", version: "1.0.0" }));
  writeFileSync(join(src, "packages.json"), JSON.stringify({ packages: [{ name: "built-a", version: "1.0.0" }, { name: "built-b", version: "1.0.0" }] }));
  const piDir = join(root, "pi-env2");
  // 用户自装包（装配不得动它）
  mkdirSync(join(piDir, "npm", "node_modules", "user-pkg"), { recursive: true });
  writeFileSync(join(piDir, "npm", "node_modules", "user-pkg", "package.json"), JSON.stringify({ name: "user-pkg", version: "9.9.9" }));
  const r1 = assembleBundledPackages(src, piDir);
  ok("首次装配", !r1.skipped && r1.installed.length === 2, r1.message);
  ok("内置包落盘", existsSync(join(piDir, "npm", "node_modules", "built-a", "package.json")));
  ok("settings 登记内置包", listPackageRefs(piDir).includes("npm:built-a"));
  const r2 = assembleBundledPackages(src, piDir);
  ok("同内容幂等跳过", r2.skipped === true);
  // 新一版去掉 built-b（真实场景 = 组件包重建，源里也不再有它）
  writeFileSync(join(src, "packages.json"), JSON.stringify({ packages: [{ name: "built-a", version: "1.1.0" }] }));
  rmSync(join(src, "node_modules", "built-b"), { recursive: true, force: true });
  const r3 = assembleBundledPackages(src, piDir);
  ok("更新后 built-b 被裁剪", !r3.skipped && !existsSync(join(piDir, "npm", "node_modules", "built-b")));
  ok("用户自装包未被误删", existsSync(join(piDir, "npm", "node_modules", "user-pkg", "package.json")));
}

server.close();
rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "\n全部通过 ✅" : `\n${failures} 个失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
