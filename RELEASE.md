# pi-coworker 发布手册（RELEASE）

> 面向**管理员/维护者**：如何打版本、打包、分发、配置更新源。员工侧不接触本手册。

## 1. 版本约定

- 版本号统一维护在三个文件：`package.json`、`agent/package.json`、`gui/package.json`（发布时同步 bump）。
- 语义化：`0.1.0` → `0.2.0`（功能）→ `0.2.1`（修复）。

## 2. 发布前检查清单

1. **脱敏**：`git grep -n -I -E "wonl[a]p|mage[n]e\.cn|19[2]\.168\.|cl[i]_[a-zA-Z0-9]{10,}|basc[n]_|[0-9]{15,}"` 应无输出
   （最后一档是飞书资源 ID 的雪花号形态，与 CI 门禁一致）；`.env`、密钥、内网地址不得入库。
2. **测试**：`npm test`（tsc + 扩展冒烟 + lark-cli 形状契约 + bot 侧回归 + 总线回归 + magene/update 冒烟）全绿。
2b. **上游形状**：`npm run live-check`（`scripts/lark-live-check.ts`，需真实登录）应全 ✅；
   它对着真 lark-cli 校验我们依赖的字段路径，出现 ⚠️ 说明上游变了，
   对照 `scripts/fixtures/lark-shapes.json` + `scripts/contract-test.ts` 更新解析逻辑后再发版。
3. **agent 编译**：`npx tsc -p agent/tsconfig.json`；**gui 后端**：`cd gui && npx tsc -p backend/tsconfig.json`。
4. `config/catalog.json`、`config/knowledge.json` 保持占位符（真实资源 ID 不提交）。
   真实值放在**用户级覆盖**里，部署时随安装包一起下发到员工机（`deploy-win.sh` 会自动同步这三个文件到测试机）：
   ```
   ~/.coworker/catalog.json      # 权限目录（真实 spaceId/url/approvalCode）
   ~/.coworker/knowledge.json    # 知识源（真实 baseToken/spaceId/url）
   ~/.coworker/deploy.json       # portal / 网关地址（向导预填 + 门户取 Key）
   ```
   覆盖文件存在即优先生效（`extensions/core/catalog.ts` / `knowledge.ts`），因此改目录/知识源不必等 App 发新版。

## 3. 打 tag 与发布（GitHub Actions 自动）

发布流水线：`.github/workflows/release.yml`（打 tag 自动触发）。

```bash
# 1) bump 版本（三处 package.json 或交给流水线：tag 版本会覆盖）
# 2) 提交并打 tag
npm test && git add -A && git commit -m "release: v0.2.0"
git tag v0.2.0
git push origin main --tags
```

流水线自动完成：

| Job | 产物 |
|---|---|
| `core`（测试 + 打包） | `pi-coworker-<v>.tar.gz`（离线安装）+ `version.json`（更新源） |
| `gui-macos`（arm64 + x64 矩阵） | `pi-coworker-gui-macos-{arm64,x64}-<tag>.zip`（ad-hoc 签名 .app） |
| `gui-windows` | `pi-coworker-gui-setup-<tag>.exe`（NSIS）+ 便携 zip |
| `release` | 合并产物发布到 GitHub Release（自动生成 release notes） |

> **桌面 App 零运行时依赖**：`gui-macos`/`gui-windows` 构建时经 `npm run prepare:pi` + `npm run prepare:runtime` 内置 **pi bundle + Node 24 二进制 + lark-cli 原生二进制**（版本可固定/镜像，见 `gui/README.md`）。员工机双击即用，无需安装 node/pi/lark-cli；且与用户系统里自己装的这些组件**完全隔离**（独立配置目录 `~/.coworker/pi-agent` 与 `~/.coworker/lark-cli`，首次自动迁移旧 `~/.lark-cli` 登录态）。

**发布后推送测试机（可选）**：`scripts/deploy-win.sh [tag]` 自动下载最新 Windows 安装包并 SCP 到内部 Win10 测试机 `C:\Users\dean\Downloads`（主机别名/路径见脚本内 `WIN_HOST` 等环境变量）。

推送后 PR 也会跑 `.github/workflows/ci.yml`：tsc + 冒烟测试 + **脱敏门禁**（发现内网地址/密钥/真实资源 ID 直接失败）。

## 4. 更新源（UPDATE_URL）

守护进程支持**可选自更新检查**：更新源返回 `version.json`，发现新版本时日志 + 审计 + 通知绑定用户（不自动升级）。

**发布流水线已自动生成更新源**：Release 资产里的 `version.json` 指向 `latest/download`，员工机只需配置：

```bash
UPDATE_URL=https://github.com/dncore/pi-coworker/releases/latest/download/version.json
```

- 手动检查：`node agent/bin/coworker-daemon.ts check-update --url <源>`
- 自定义内网源：格式见 `scripts/update/version.sample.json`。

## 5. 员工机安装（三种方式）

| 方式 | 命令 | 适合 |
|---|---|---|
| **桌面 App**（推荐给员工） | 下载/分发包中的 `PiCoworker.app` / `pi-coworker-gui-setup.exe`，双击安装 | **零依赖**：内置 node24 + pi + lark-cli，与系统组件隔离；适合无命令行能力/受限环境的员工机 |
| 一键脚本 | `bash <(curl -fsSL <公司内网脚本地址>/bootstrap.sh)` | 默认推荐：装依赖 + 注册自启 + 启动守护进程 |
| Git 安装 | `pi install git:github.com/dncore/pi-coworker@v0.2.0` | 有 GitHub 访问权限 |
| 离线包 | 解压 `pi-coworker-<v>.tar.gz` → `pi install .` | 无外网/内网环境 |

## 6. 员工机更新（N 台机器怎么更）

1. 守护进程发现新版本 → 给员工发通知卡片「助手有新版本」。
2. 更新动作（本机）：`pi update --extensions` → `node agent/bin/coworker-daemon.ts restart`（或桌面助手「更新」按钮）。
3. 规模化建议：IT 用 MDM / 远程执行批量跑更新命令；或直接把 bootstrap 脚本重跑一次（幂等）。

## 7. GUI 桌面端分发

见 [`gui/DISTRIBUTION.md`](./gui/DISTRIBUTION.md)：构建 dmg/msi、macOS 签名公证、Windows 代码签名、更新通道（可接 GitHub Releases 或内网源）。

## 8. 内嵌组件源的发布（lark-cli / pi / skills）

App 内置组件可通过覆盖层独立更新，不必发新版安装包（机制见 HANDOFF §11）：

```bash
# 在对应平台的构建机上（版本号从产物自动探测）
node scripts/build-components.mjs --out dist/components \
  --lark-cli /path/to/lark-cli[.exe]        # 新 lark-cli（npm/GitHub release 产物）
# pi 默认取 gui/src-tauri/resources/pi（先 npm run prepare:pi），skills 默认取 ./skills
```

把 `dist/components/` 整个目录托管为静态文件（门户/内网 nginx 均可），
员工机 `~/.coworker/deploy.json` 增加：

```json
{ "componentFeedUrl": "https://<host>/<组件源根路径>" }
```

员工在 App「环境与登录 → 内嵌组件」点「检查更新」即可升级；sha256 校验不通过一律拒绝。
回滚：删掉 `~/.coworker/components/<name>/current` 即回到随包版本。

## 9. 授权分发组件（dispenser）的发布

`dispenser/`（授权分发 CLI）随安装包发布，也可经组件源独立更新（机制见 HANDOFF §13.3）：

```bash
# 改 dispenser/package.json 的 version → 打组件源（含 dispenser tar.gz）
node scripts/build-components.mjs --out dist/components
```

客户端「环境与登录 → 内嵌组件」检测到新版后更新即可；更新后稳定入口
`~/.coworker/bin/dispenser.mjs` 自动指向覆盖层新版本（无需重启 App）。
回滚：删掉 `~/.coworker/components/dispenser/current`。
注意：组件包的入口必须是 `cli.ts`（launcher 约定），`lib/` 必须与 `cli.ts` 同级随包。
