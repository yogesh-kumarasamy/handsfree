use std::fs::OpenOptions;
use std::io::Read;
use std::net::TcpListener;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

/// The Node engine (polling, worktrees, agents, PRs) runs as a child process of the app.
struct Engine {
    child: Mutex<Option<Child>>,
    port: u16,
    token: String,
}

#[derive(serde::Serialize)]
struct EngineInfo {
    port: u16,
    token: String,
}

#[tauri::command]
fn get_engine_info(engine: tauri::State<Engine>) -> EngineInfo {
    EngineInfo { port: engine.port, token: engine.token.clone() }
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only http(s) links can be opened".into());
    }
    Command::new("open").arg(&url).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

fn random_token() -> String {
    let mut b = [0u8; 16];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut b))
        .expect("read /dev/urandom");
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(47821)
}

fn spawn_engine(app: &AppHandle, port: u16, token: &str) -> std::io::Result<Child> {
    let script = app
        .path()
        .resolve("engine/handsfree-engine.mjs", tauri::path::BaseDirectory::Resource)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::NotFound, e.to_string()))?;

    let log_dir = dirs_home().join("Library/Logs/HandsFree");
    let _ = std::fs::create_dir_all(&log_dir);
    let log = OpenOptions::new().create(true).append(true).open(log_dir.join("engine.log"))?;

    // Apps opened from Finder get a minimal PATH, so let the user's login shell find `node`.
    Command::new("/bin/zsh")
        .args(["-ilc", "exec node \"$HF_ENGINE\""])
        .env("HF_ENGINE", script)
        .env("HF_PORT", port.to_string())
        .env("HF_TOKEN", token)
        // stdin stays open while the app lives; the engine shuts down (and stops its agents) when it closes.
        .stdin(Stdio::piped())
        .stdout(Stdio::from(log.try_clone()?))
        .stderr(Stdio::from(log))
        .spawn()
}

fn dirs_home() -> std::path::PathBuf {
    std::env::var_os("HOME").map(Into::into).unwrap_or_else(|| "/tmp".into())
}

fn stop_engine(app: &AppHandle) {
    if let Some(engine) = app.try_state::<Engine>() {
        if let Some(mut child) = engine.child.lock().unwrap().take() {
            // SIGTERM lets the engine stop running agents cleanly; closing stdin is the backup signal.
            let _ = Command::new("kill").arg("-TERM").arg(child.id().to_string()).status();
            drop(child.stdin.take());
            std::thread::sleep(std::time::Duration::from_millis(400));
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .invoke_handler(tauri::generate_handler![get_engine_info, open_url])
        .setup(|app| {
            let handle = app.handle().clone();
            let port = free_port();
            let token = random_token();
            let child = match spawn_engine(&handle, port, &token) {
                Ok(c) => Some(c),
                Err(e) => {
                    eprintln!("[handsfree] could not start engine: {e}");
                    None
                }
            };
            app.manage(Engine { child: Mutex::new(child), port, token });

            // Menu bar icon
            let show = MenuItem::with_id(app, "show", "Open HandsFree", true, None::<&str>)?;
            let pause = MenuItem::with_id(app, "pause", "Pause / Resume", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit HandsFree", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &pause, &sep, &quit])?;
            TrayIconBuilder::with_id("main")
                .icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .icon_as_template(true)
                .tooltip("HandsFree")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "pause" => {
                        let _ = app.emit("tray-toggle-pause", ());
                    }
                    "quit" => {
                        stop_engine(app);
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            // Started at login → stay in the menu bar.
            if std::env::args().any(|a| a == "--hidden") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps HandsFree running in the menu bar.
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building HandsFree");

    app.run(|app, event| match event {
        RunEvent::ExitRequested { .. } | RunEvent::Exit => stop_engine(app),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_main(app),
        _ => {}
    });
}
