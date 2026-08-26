// 桌面客户端主进程：拉起本地 Node 后端（pi RPC + lark-cli），托盘常驻，退出时回收。
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, RunEvent};

pub struct Backend(Mutex<Option<Child>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // 运行资源目录：打包形态 = Contents/Resources（bundle.resources 已打包 backend/agent/…）；
            // 开发形态 = 仓库根（CARGO_MANIFEST_DIR 的父目录）。按「存在 backend/src/index.ts」判定。
            let bundle_root = app.path().resource_dir().ok();
            let dev_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .map(|p| p.to_path_buf());
            // 打包形态：Resources/gui/backend/src/index.ts；开发形态：仓库根 backend/src/index.ts
            let (repo_root, backend_script) = bundle_root
                .filter(|d| d.join("gui/backend/src/index.ts").exists())
                .map(|d| (d, "gui/backend/src/index.ts".to_string()))
                .or_else(|| {
                    dev_root
                        .filter(|d| d.join("backend/src/index.ts").exists())
                        .map(|d| (d, "backend/src/index.ts".to_string()))
                })
                .unwrap_or_else(|| (std::path::PathBuf::from("."), "backend/src/index.ts".to_string()));
            let port = std::env::var("GUI_PORT").unwrap_or_else(|_| "17331".to_string());
            let child = Command::new("node")
                .args([&backend_script])
                .current_dir(&repo_root)
                .env("GUI_PORT", &port)
                .stdout(std::process::Stdio::inherit())
                .stderr(std::process::Stdio::inherit())
                .spawn()
                .map_err(|e| {
                    eprintln!("[coworker-gui] 启动后端失败（需要 Node.js ≥ 18）：{e}（repo_root={}）", repo_root.display());
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
