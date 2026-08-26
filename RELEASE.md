# pi-coworker 发布手册（RELEASE）

> 面向**管理员/维护者**：如何打版本、打包、分发、配置更新源。员工侧不接触本手册。

## 1. 版本约定

- 版本号统一维护在三个文件：`package.json`、`agent/package.json`、`gui/package.json`（发布时同步 bump）。
- 语义化：`0.1.0` → `0.2.0`（功能）→ `0.2.1`（修复）。

## 2. 发布前检查清单

1. **脱敏**：`git grep -nE "wonl[a]p|mage[n]e\.cn|19[2]\.168\.|cl[i]_[a-zA-Z0-9]{10,}|basc[n]_"` 应无输出；`.env`、密钥、内网地址不得入库。
2. **测试**：`npm test`（tsc + 扩展冒烟 + magene 冒烟）全绿。
3. **agent 编译**：`npx tsc -p agent/tsconfig.json`；**gui 后端**：`cd gui && npx tsc -p backend/tsconfig.json`。
4. `config/catalog.json`、`config/knowledge.json` 保持占位符（真实资源 ID 由部署方填，不提交）。

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
| `gui-macos` | `pi-coworker-gui-macos-<tag>.zip`（ad-hoc 签名 .app） |
| `gui-windows` | `pi-coworker-gui-setup-<tag>.exe`（NSIS）+ 便携 zip |
| `release` | 合并产物发布到 GitHub Release（自动生成 release notes） |

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
| 一键脚本 | `bash <(curl -fsSL <公司内网脚本地址>/bootstrap.sh)` | 默认推荐：装依赖 + 注册自启 + 启动守护进程 |
| Git 安装 | `pi install git:github.com/dncore/pi-coworker@v0.2.0` | 有 GitHub 访问权限 |
| 离线包 | 解压 `pi-coworker-<v>.tar.gz` → `pi install .` | 无外网/内网环境 |

## 6. 员工机更新（N 台机器怎么更）

1. 守护进程发现新版本 → 给员工发通知卡片「助手有新版本」。
2. 更新动作（本机）：`pi update --extensions` → `node agent/bin/coworker-daemon.ts restart`（或桌面助手「更新」按钮）。
3. 规模化建议：IT 用 MDM / 远程执行批量跑更新命令；或直接把 bootstrap 脚本重跑一次（幂等）。

## 7. GUI 桌面端分发

见 [`gui/DISTRIBUTION.md`](./gui/DISTRIBUTION.md)：构建 dmg/msi、macOS 签名公证、Windows 代码签名、更新通道（可接 GitHub Releases 或内网源）。
