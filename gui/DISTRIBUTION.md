# 桌面客户端分发与签名

> 面向终端用户交付的安装包（macOS `.dmg` / Windows `.exe`）。分发前必须完成签名，否则系统会拦截/告警。

## 构建

```bash
cd gui
npm install            # 安装 @tauri-apps/cli
npm run build          # = prepare:pi（打包 pi bundle）→ cargo tauri build → 产出 dmg / nsis 安装包
npm run dev            # 开发模式（自动拉起 Node 后端 + 开窗）
```

产物位置：`gui/src-tauri/target/release/bundle/`（`dmg/`、`nsis/`）。

> **pi 已随应用打包**：构建时 `npm run prepare:pi` 会把 pi CLI 的自包含 bundle（`dist/bundle`，仅依赖 node 内置模块）拷入 `gui/src-tauri/resources/pi/`，并随安装包分发。后端与守护进程通过 `PI_BIN` 环境变量指向它（无则回退到 PATH 上的 `pi`），员工机器**无需单独安装 pi**。
>
> **Node 24 与 lark-cli 也已随应用打包**（`npm run prepare:runtime` → `gui/src-tauri/resources/runtime/`）：
> - `node` / `node.exe`：Node 24 自包含二进制（macOS arm64/x64、Windows x64，按构建机架构自动选择）
> - `lark-cli` / `lark-cli.exe`：lark-cli 原生二进制（Go 编译，独立可执行，无需 node）
> 运行时解析优先级：**内置 → 环境变量（`GUI_NODE`/`LARK_CLI_BIN`）→ PATH → fnm/nvm/volta/asdf → 登录 shell**，兼容 Finder/`open` 启动（无用户 PATH）的场景。
>
> **三组件与用户系统安装完全隔离，互不影响**：
> 1. **node**：App 用自己的内置二进制，不动用户 PATH 上的 node；
> 2. **pi**：用打包 bundle + 独立配置目录 `~/.coworker/pi-agent`（不读/不写 `~/.pi/agent`）；
> 3. **lark-cli**：用打包原生二进制 + 独立配置目录 `~/.coworker/lark-cli`（`LARKSUITE_CLI_CONFIG_DIR`；首次运行自动把已有 `~/.lark-cli` 登录态迁移过来，此后 App 内登录与用户自己的 lark-cli 互不影响）。

## macOS 签名与公证（notarization）

```bash
# 1) 签名（需要 Apple Developer ID Application 证书）
export CODESIGN_IDENTITY="Developer ID Application: 公司名 (TEAMID)"
cargo tauri build        # tauri.conf 中 bundle.macOS.signingIdentity 可指定

# 2) 公证（提交给 Apple 校验）
xcrun notarytool submit \
  --apple-id "$APPLE_ID" --team-id "$TEAMID" --password "$APP_SPECIFIC_PW" \
  gui/src-tauri/target/release/bundle/dmg/*.dmg

# 3) 装订（把公证票据打进安装包）
xcrun stapler staple gui/src-tauri/target/release/bundle/dmg/*.dmg
```

## Windows 代码签名

```bash
# 需要企业代码签名证书（OV/EV）
signtool sign /f company.pfx /p <password> /tr http://timestamp.digicert.com /td sha256 /fd sha256 app.exe
```

## 分发前检查清单

1. 图标：当前为占位图标，`npm run icons` 可重新生成；正式图标需设计。
2. 更新通道：可接 GitHub Releases（`tauri-plugin-updater`）或公司内网源。
3. 首次运行引导：安装后打开 App 会走「安装向导」（环境→登录→Bot→守护进程→完成）。
4. 安装包分发：内网共享 / MDM 推送；未签名包仅用于内部测试（需手动允许）。
