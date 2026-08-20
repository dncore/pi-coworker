// 桌面客户端主进程：拉起本地 Node 后端（pi RPC + lark-cli），退出时回收。
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::Manager;

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
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("构建 Tauri 应用失败")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<Backend>() {
                    if let Some(mut child) = state.0.lock().ok().and_then(|mut g| g.take()) {
                        let _ = child.kill();
                    }
                }
            }
        });
}
