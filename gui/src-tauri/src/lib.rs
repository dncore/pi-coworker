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
            let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .expect("src-tauri 应有父目录（仓库根）");
            let port = std::env::var("GUI_PORT").unwrap_or_else(|_| "17331".to_string());
            let child = Command::new("node")
                .args(["backend/src/index.ts"])
                .current_dir(repo_root)
                .env("GUI_PORT", &port)
                .stdout(std::process::Stdio::inherit())
                .stderr(std::process::Stdio::inherit())
                .spawn()
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
