# 桌面客户端分发与签名

> 面向终端用户交付的安装包（macOS `.dmg` / Windows `.exe`）。分发前必须完成签名，否则系统会拦截/告警。

## 构建

```bash
cd gui
npm install            # 安装 @tauri-apps/cli
npm run build          # = cargo tauri build → 产出 dmg / nsis 安装包
npm run dev            # 开发模式（自动拉起 Node 后端 + 开窗）
```

产物位置：`gui/src-tauri/target/release/bundle/`（`dmg/`、`nsis/`）。

> 运行时依赖：员工机器需安装 **Node.js ≥ 18**（后端与 pi 运行期）。生产化时可选把 Node 一起打包进应用（更重的改造，二期）。

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
