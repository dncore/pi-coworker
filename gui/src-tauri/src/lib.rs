// 桌面客户端主进程：拉起本地 Node 后端（pi RPC + lark-cli），托盘常驻，退出时回收。
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, RunEvent};

pub struct Backend(Mutex<Option<Child>>);

/// 取 Key 探针（注入到主窗口内的外部页面，取代早先的独立 portal-login 窗口）：
/// - 悬浮「返回应用」按钮：任何外部页面上的逃生口（不依赖目标页自身 UI）；
/// - 取 Key：轮询同源 /api/user，200 才动作（即本页确实是公司门户），拿到
///   /api/tops/user/api-key 后带 nonce POST 回本地后端，成功后整窗跳回应用。
/// 占位符：__GUI_PORT__ / __GUI_NONCE__ / __APP_ORIGIN__（on_page_load 时替换；nonce 实时读文件，无竞态）。
const PORTAL_MAIN_PROBE: &str = r#"
(function () {
  if (window.__piPortalProbe) return; window.__piPortalProbe = 1;
  var appOrigin = "__APP_ORIGIN__";

  // 悬浮「返回应用」：外部页面上的逃生口
  try {
    var attach = function () {
      if (!document.body || document.getElementById("__cw_back")) return;
      var btn = document.createElement("button");
      btn.id = "__cw_back";
      btn.textContent = "← 返回应用";
      btn.setAttribute("style",
        "position:fixed;right:16px;bottom:16px;z-index:2147483647;padding:8px 14px;border-radius:999px;" +
        "border:1px solid rgba(0,0,0,.12);background:rgba(255,255,255,.94);color:#1f2329;" +
        "font:13px/1.2 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;" +
        "box-shadow:0 4px 14px rgba(0,0,0,.16);cursor:pointer");
      btn.addEventListener("click", function () { location.replace(appOrigin); });
      document.body.appendChild(btn);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", attach);
    else attach();
  } catch (e) {}

  // 取 Key：仅当本页确实是门户（同源 /api/user 200）时才动作，其余页面静默空转
  var tries = 0;
  var timer = setInterval(async function () {
    if (++tries > 400) { clearInterval(timer); return; } // ~10 分钟封顶
    try {
      var r = await fetch("/api/user", { credentials: "same-origin" });
      if (!r.ok) return;
      var user = await r.json();
      var kr = await fetch("/api/tops/user/api-key", { credentials: "same-origin" });
      var api_key = kr.ok ? ((await kr.json()).api_key || "") : "";
      if (!api_key) return; // 已登录但还没 Key（可能需在门户控制台创建）：继续等，不打断
      clearInterval(timer);
      var ok = false;
      try {
        var pr = await fetch("http://127.0.0.1:__GUI_PORT__/portal/key-callback", {
          method: "POST",
          headers: { "content-type": "application/json", "x-cw-nonce": "__GUI_NONCE__" },
          body: JSON.stringify({
            api_key: api_key,
            cookie: document.cookie,
            user: { name: user.username, department: user.department },
          }),
        });
        ok = (await pr.json()).ok === true;
      } catch (e) { /* 网络/来源校验失败：按未获取处理，返回应用后引导手动方式 */ }
      document.title = ok ? "✅ 已获取 API Key，正在返回应用…" : "⚠️ Key 校验未通过，正在返回应用…";
      setTimeout(function () { location.replace(appOrigin); }, 800);
    } catch (e) { /* 网络抖动等，下个周期重试 */ }
  }, 1500);
})();
"#;

/// 应用自身页面在 webview 里的 origin（探针完成后跳回这里）。
/// tauri://localhost 是 macOS 的资产协议；Windows 上是 http://tauri.localhost。
fn app_origin() -> &'static str {
    if cfg!(windows) {
        "http://tauri.localhost/"
    } else {
        "tauri://localhost/"
    }
}

/// Tauri 的 resource_dir 在 Windows 上返回 `\\?\C:\...`（verbatim 扩展路径）。
/// node 解析脚本参数（argv[1]）时无法处理该前缀：path.resolve 把它截成 "C:" →
/// `EISDIR: lstat 'C:'`，进程启动即崩（实测 pi 子进程因此永远起不来）。
/// 传给子进程的参数/环境变量必须换成普通 DOS 路径。
fn dos_path(p: std::path::PathBuf) -> std::path::PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return std::path::PathBuf::from(format!(r"\\{}", rest));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return std::path::PathBuf::from(rest.to_string());
    }
    p
}

/// 打开后端日志文件（~/.coworker/gui-backend.log，追加；超过 5MB 滚动为 .1）。
/// 失败返回 None（此时后端输出丢弃，但不影响功能）。
fn open_backend_log() -> Option<std::fs::File> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()?;
    let dir = std::path::Path::new(&home).join(".coworker");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("gui-backend.log");
    if let Ok(m) = std::fs::metadata(&path) {
        if m.len() > 5 * 1024 * 1024 {
            let _ = std::fs::rename(&path, dir.join("gui-backend.log.1"));
        }
    }
    std::fs::OpenOptions::new().create(true).append(true).open(&path).ok()
}

/// 读取后端写入的一次性 nonce（~/.coworker/gui-portal-nonce，0600）。
/// 回调端点对来源不设限，靠这个 nonce 证明请求来自后端自己打开的窗口。
fn read_portal_nonce() -> String {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    if home.is_empty() {
        return String::new();
    }
    std::fs::read_to_string(
        std::path::Path::new(&home)
            .join(".coworker")
            .join("gui-portal-nonce"),
    )
    .map(|s| s.trim().to_string())
    .unwrap_or_default()
}

// （原 portal-login 独立窗口已移除：取 Key 全程改在主窗口内完成——
//   前端整窗跳转到飞书授权页，Rust 侧 on_page_load 注入探针，取到 Key 后跳回应用。）

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
        // Windows 的 PATH 分隔符是 ';'（用 ':' 会被盘符切割，永远找不到 node）
        for dir in p.split(if cfg!(windows) { ';' } else { ':' }) {
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
            let bundle_root = app.path().resource_dir().ok().map(dos_path);
            let runtime_root = bundle_root.clone();
            let dev_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .map(|p| p.to_path_buf())
                .map(dos_path);
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
                // 内置 Node runtime（v24，Windows node.exe / macOS node；安装包自带，彻底解决新设备无 node）
                runtime_root
                    .as_ref()
                    .map(|d| if cfg!(windows) { d.join("runtime/node.exe") } else { d.join("runtime/node") })
                    .filter(|p| p.exists()),
                // 开发形态的 runtime
                dev_root
                    .as_ref()
                    .map(|d| if cfg!(windows) { d.join("src-tauri/resources/runtime/node.exe") } else { d.join("src-tauri/resources/runtime/node") })
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
                .filter(|d| d.exists())
                .or_else(|| {
                    dev_root
                        .as_ref()
                        .map(|d| d.join("src-tauri/resources/runtime"))
                        .filter(|d| d.exists())
                });
            // 内置运行时目录前置到 PATH：lark-cli 等 node 脚本的 `env node` shebang 也能解析到内置 node
            let mut child_env: Vec<(String, String)> = Vec::new();
            if let Some(rd) = &runtime_dir {
                if let Ok(cur) = std::env::var("PATH") {
                    let sep = if cfg!(windows) { ";" } else { ":" };
                    child_env.push((
                        "PATH".into(),
                        format!("{}{}{}", rd.to_string_lossy(), sep, cur),
                    ));
                }
            }
            let mut backend_cmd = Command::new(&node);
            backend_cmd
                .args([&backend_script])
                .current_dir(&repo_root)
                .env("GUI_PORT", &port)
                .env("PI_BIN", &pi_bin)
                .env("LARK_CLI_RUNTIME_DIR", runtime_dir.as_ref().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default())
                .envs(child_env);
            // pi 配置隔离目录必须**从一开始**就在环境里：后端里 magene 配置路径是模块加载期
            // 从 PI_CODING_AGENT_DIR 快照的常量，后端自己再设就晚了（读 ~/.pi/agent 写一套、
            // pi 子进程读 ~/.coworker/pi-agent 另一套，新机器取到的 Key 到不了 agent）。
            if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
                let pi_dir = std::path::Path::new(&home).join(".coworker").join("pi-agent");
                backend_cmd.env("PI_CODING_AGENT_DIR", pi_dir);
            }
            // 后端日志落文件：GUI 进程没有控制台，stdout/stderr 必须有去处，
            // 否则（如 pi 子进程崩溃、扩展异常）现场无从诊断。>5MB 时滚动为 .1。
            match open_backend_log() {
                Some(f) => {
                    let f2 = f.try_clone().ok();
                    backend_cmd.stdout(std::process::Stdio::from(f));
                    match f2 {
                        Some(f2) => {
                            backend_cmd.stderr(std::process::Stdio::from(f2));
                        }
                        None => {
                            backend_cmd.stderr(std::process::Stdio::null());
                        }
                    }
                }
                None => {
                    backend_cmd.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
                }
            }
            // Windows：GUI 应用的无控制台进程默认会给 console 子进程新开终端窗口，
            // CREATE_NO_WINDOW 让内置 node 后端隐藏窗口运行
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                backend_cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
            }
            let child = backend_cmd
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

            // 主窗口：在代码里创建（而非 tauri.conf.json），为了挂 on_page_load——
            // 取 Key 流程中主窗口会整窗跳到飞书授权页/门户页，每次页面加载时向外部页面
            // 注入探针（取 Key + 「返回应用」悬浮按钮）。注入用 eval（页面加载完成后执行，
            // 无需 document-start；nonce 此时实时读文件，避免后端写入竞态）。
            {
                let gui_port = port.clone();
                // 应用页 origin 运行时捕获（见 on_page_load 注释）：探针取到 Key 后必须跳回
                // 同一 origin——收尾标记存在 localStorage，跳错 origin（dev 形态尤其）会丢状态。
                type OriginKey = (String, String, Option<u16>);
                let origin_cell: std::sync::Arc<std::sync::Mutex<Option<(OriginKey, String)>>> =
                    std::sync::Arc::new(std::sync::Mutex::new(None));
                let win = tauri::WebviewWindowBuilder::new(
                    app,
                    "main",
                    tauri::WebviewUrl::App("index.html".into()),
                )
                .title("公司企业 AI 助手")
                .inner_size(980.0, 700.0)
                .min_inner_size(760.0, 540.0)
                .on_page_load(move |webview, payload| {
                    if payload.event() != tauri::webview::PageLoadEvent::Finished {
                        return;
                    }
                    let url = payload.url();
                    // 应用自身页面的判定：**窗口的第一次加载就是应用页本身**（打包形态是
                    // tauri://localhost/，dev 形态是本地 http 服务器、端口随机），此后第一次
                    // 加载的 (scheme,host,port) 即应用 origin；同 origin 一律视为应用页，不注入。
                    let origin_key = (
                        url.scheme().to_string(),
                        url.host_str().unwrap_or("").to_string(),
                        url.port_or_known_default(),
                    );
                    let is_app_page = {
                        match origin_cell.lock() {
                            Ok(mut g) => match g.as_ref() {
                                Some((first, _)) => *first == origin_key,
                                None => {
                                    *g = Some((origin_key, url.to_string()));
                                    true
                                }
                            },
                            Err(_) => false,
                        }
                    };
                    if is_app_page {
                        // 应用页自身不注入探针
                        return;
                    }
                    if !matches!(url.scheme(), "http" | "https") {
                        return;
                    }
                    // 探针取到 Key 后跳回应用：用运行时记住的应用页地址（dev/打包两种形态都对）
                    let back = origin_cell
                        .lock()
                        .ok()
                        .and_then(|g| g.as_ref().map(|(_, u)| u.clone()))
                        .unwrap_or_else(|| app_origin().to_string());
                    let script = PORTAL_MAIN_PROBE
                        .replace("__GUI_PORT__", &gui_port)
                        .replace("__GUI_NONCE__", &read_portal_nonce())
                        .replace("__APP_ORIGIN__", &back);
                    let _ = webview.eval(&script);
                })
                .build()?;
                // 关键：必须保活窗口句柄——WebviewWindow 的 Drop 会关掉窗口（丢出作用域即可复现
                // “进程在跑但无窗口”）。交给 app 托管，生命周期到进程结束。
                app.manage(win.clone());
            }

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
