# pi-coworker-gui · 桌面客户端（Tauri + pi RPC）

员工本机的「企业 AI 助手」桌面应用：对话问答、权限申请、环境/登录，复用 coworker 内核。

## 架构

```
Tauri 壳 (src-tauri)          —— 开窗口 + 拉起本地 Node 后端，退出回收
   ↓
Webview 前端 (src/)           —— 三视图：对话 / 权限 / 状态（纯 HTML/JS，无构建链）
   ↓ fetch http://127.0.0.1:17331
Node 后端 (backend/)          —— 本机服务（用户身份）
   ├─ /env /login /qr /perm   —— 直接复用 extensions/core（runLark/catalog/审计）
   └─ /ask                    —— pi --mode rpc（全 coworker 工具，禁本地工具）
```

安全：仅监听 127.0.0.1；agent 禁本地工具（bash/write/edit）；写操作前端二次确认。

## 运行（开发）

```bash
# 1) 启动后端（可选，单独调试）
cd backend && node src/index.ts          # 默认端口 17331

# 2) 启动桌面壳（自动拉起后端）
cd src-tauri && cargo run                # 首次编译较慢（~3min）
# 或 tauri dev
```

浏览器调试前端（无需 Rust）：直接用浏览器打开 `src/index.html` 即可（后端需已启动）。

## 构建安装包

```bash
cd src-tauri
cargo tauri build        # 产出 dmg（mac）/ msi/nsis（win）
```

> 分发前需：企业签名（macOS notarization / Windows code signing）、更新源、真实图标（当前为占位）。

## 目录

```
src/           前端（index.html / app.js / styles.css）
src-tauri/     Tauri 2 壳（Rust 只做拉起后端 + 开窗）
backend/       本机 Node 后端（复用 ../../extensions/core + server agent 池）
scripts/       图标生成等工具
```

## 与 Bot Agent 的分工

| 能力 | 桌面 GUI（本机用户身份） | Bot Agent（个人本地 Bot / 共享机器人） |
|---|---|---|
| 知识问答 | ✅ | ✅（飞书内交互） |
| 权限申请直授 | ✅ 写前确认 | ✅ 卡片按钮（自服务直授/审批链接） |
| 我的权限盘点 | ✅ | ⚠️ 仅目录/引导（本地 Bot 可用用户身份） |
| 登录/扫码 | ✅ 本机 | ✅ 本地 Bot 可引导 |
| 本地文档处理 | ✅（后续） | ✅ local 模式可开 |

> 结论：GUI 已降级为可选项（守护进程托盘/启动器）；交互以飞书内 Bot 为主。
