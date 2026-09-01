// 桌面客户端主进程：拉起本地 Node 后端（pi RPC + lark-cli），托盘常驻，退出时回收。
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, RunEvent};

pub struct Backend(Mutex<Option<Child>>);

/// 定位 node 解释器：GUI 经 Finder/`open` 启动时 PATH 不含用户 shell 的路径（homebrew/nvm/fnm/volta 等），
/// 必须显式探测。优先级：$GUI_NODE > 当前 PATH > 登录 shell（zsh/bash -lc）。
fn find_node() -> Option<String> {
    if let Ok(n) = std::env::var("GUI_NODE") {
        let n = n.trim().to_string();
        if !n.is_empty() && std::path::Path::new(&n).exists() {
            return Some(n);
        }
    }
    if let Ok(p) = std::env::var("PATH") {
        for dir in p.split(':') {
            if dir.is_empty() {
                continue;
            }
            let c = std::path::Path::new(dir).join("node");
            if c.exists() {
                return Some(c.to_string_lossy().into_owned());
            }
        }
    }
    // 常见版本管理器目录（员工机器可能只用 fnm/nvm/volta，登录 shell 探测不到）
    if let Some(home) = std::env::var_os("HOME") {
        let home = std::path::Path::new(&home);
        let mut dirs: Vec<std::path::PathBuf> = Vec::new();
        if let Ok(entries) = std::fs::read_dir(home.join(".local/share/fnm/node-versions")) {
            for e in entries.flatten() {
                dirs.push(e.path().join("installation/bin"));
            }
        }
        if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            for e in entries.flatten() {
                dirs.push(e.path().join("bin"));
            }
        }
        dirs.push(home.join(".volta/bin"));
        dirs.push(home.join(".asdf/shims"));
        for d in dirs {
            let c = d.join("node");
            if c.exists() {
                return Some(c.to_string_lossy().into_owned());
            }
        }
    }
    for shell in ["/bin/zsh", "/bin/bash"] {
        if let Ok(out) = std::process::Command::new(shell).args(["-lc", "command -v node"]).output() {
            let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !p.is_empty() && std::path::Path::new(&p).exists() {
                return Some(p);
            }
        }
    }
    None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // 运行资源目录：打包形态 = Contents/Resources（bundle.resources 已打包 backend/agent/…）；
            // 开发形态 = 仓库根（CARGO_MANIFEST_DIR 的父目录）。按「存在 backend/src/index.ts」判定。
            let bundle_root = app.path().resource_dir().ok();
            let runtime_root = bundle_root.clone();
            let dev_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .map(|p| p.to_path_buf());
            // 打包形态：Resources/gui/backend/src/index.ts；开发形态：仓库根 backend/src/index.ts
            let (repo_root, backend_script) = bundle_root
                .filter(|d| d.join("gui/backend/src/index.ts").exists())
                .map(|d| (d, "gui/backend/src/index.ts".to_string()))
                .or_else(|| {
                    dev_root
                        .clone()
                        .filter(|d| d.join("backend/src/index.ts").exists())
                        .map(|d| (d, "backend/src/index.ts".to_string()))
                })
                .unwrap_or_else(|| (std::path::PathBuf::from("."), "backend/src/index.ts".to_string()));
            let port = std::env::var("GUI_PORT").unwrap_or_else(|_| "17331".to_string());
            // pi 二进制：优先用打包进资源的启动器（Resources/pi/pi.mjs，node 运行自包含 bundle）；
            // 开发形态用仓库内生成的 resources/pi/pi.mjs；都没有则回退到 PATH 上的 pi。
            let pi_bin = [
                Some(repo_root.join("pi/pi.mjs")),
                dev_root
                    .as_ref()
                    .map(|d| d.join("src-tauri/resources/pi/pi.mjs")),
            ]
            .into_iter()
            .flatten()
            .find(|p| p.exists())
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| "pi".to_string());
            let node = [
                // 内置 Node runtime（Windows 安装包自带，彻底解决新设备无 node）
                runtime_root
                    .as_ref()
                    .map(|d| d.join("runtime/node.exe"))
                    .filter(|p| p.exists()),
                // 开发形态的 runtime
                dev_root
                    .as_ref()
                    .map(|d| d.join("src-tauri/resources/runtime/node.exe"))
                    .filter(|p| p.exists()),
            ]
            .into_iter()
            .flatten()
            .next()
            .map(|p| p.to_string_lossy().into_owned())
            .or_else(find_node);
            let node = if let Some(n) = node { n } else { find_node().unwrap_or_else(|| "node".to_string()) };
            // 让后端/lark-cli 优先用内置的运行时
            let runtime_dir = runtime_root
                .as_ref()
                .map(|d| d.join("runtime"))
                .filter(|d| d.exists());
            let child = Command::new(&node)
                .args([&backend_script])
                .current_dir(&repo_root)
                .env("GUI_PORT", &port)
                .env("PI_BIN", &pi_bin)
                .env("LARK_CLI_RUNTIME_DIR", runtime_dir.as_ref().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default())
                .stdout(std::process::Stdio::inherit())
                .stderr(std::process::Stdio::inherit())
                .spawn()
                .map_err(|e| {
                    eprintln!(
                        "[coworker-gui] 启动后端失败（需要 Node.js ≥ 22）：{e}（node={node}，repo_root={}）；可通过环境变量 GUI_NODE 指定 node 绝对路径",
                        repo_root.display()
                    );
                    e
                })
                .ok();
            app.manage(Backend(Mutex::new(child)));

            // 托盘
            let open = MenuItem::with_id(app, "open", "打开 Coworker", true, None::<&str>)?;
            let start = MenuItem::with_id(app, "daemon-start", "启动守护进程", true, None::<&str>)?;
            let stop = MenuItem::with_id(app, "daemon-stop", "停止守护进程", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &start, &stop, &quit])?;
            let _tray = TrayIconBuilder::with_id("coworker-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                    "daemon-start" => {
                        let _ = app.emit("daemon-start", ());
                    }
                    "daemon-stop" => {
                        let _ = app.emit("daemon-stop", ());
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("构建 Tauri 应用失败")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<Backend>() {
                    if let Some(mut child) = state.0.lock().ok().and_then(|mut g| g.take()) {
                        let _ = child.kill();
                    }
                }
            }
        });
}
