#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// Thin native host. The webview receives no unrestricted shell/filesystem capability.
use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};
use std::time::Duration;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent}};
use tauri_plugin_shell::{ShellExt, process::{CommandChild, CommandEvent}};

struct Backend {
    child: Mutex<Option<CommandChild>>,
    closing: AtomicBool,
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn request_exit(app: tauri::AppHandle, state: Arc<Backend>) {
    if state.closing.swap(true, Ordering::SeqCst) { return; }
    let child = state.child.lock().unwrap().take();
    std::thread::spawn(move || {
        if let Some(mut child) = child {
            let _ = child.write(b"shutdown\n");
            std::thread::sleep(Duration::from_millis(1200));
            let _ = child.kill();
        }
        app.exit(0);
    });
}

fn main() {
    let state = Arc::new(Backend { child: Mutex::new(None), closing: AtomicBool::new(false) });
    let setup_state = state.clone();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(move |app| {
            let root = app.path().resource_dir()?;
            let source = root.join("v3/core/server.mjs");
            let web = root.join("v3/web");
            let data = app.path().app_local_data_dir()?;
            std::fs::create_dir_all(&data)?;
            let command = app.shell().sidecar("node-runtime")?
                .args([source.to_string_lossy().to_string(), "--sidecar".to_owned()])
                .env("TEPORA_WEB_DIR", web.to_string_lossy().to_string())
                .env("TEPORA_DATA_DIR", data.to_string_lossy().to_string());
            let (mut events, child) = command.spawn()?;
            *setup_state.child.lock().unwrap() = Some(child);

            let show = MenuItem::with_id(app, "show", "Teporaを表示", true, None::<&str>)?;
            let stop = MenuItem::with_id(app, "stop", "すべての仕事を停止", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Teporaを終了", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &stop, &quit])?;
            let menu_state = setup_state.clone();
            let mut tray = TrayIconBuilder::new()
                .tooltip("Tepora")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "stop" => {
                        if let Some(child) = menu_state.child.lock().unwrap().as_mut() {
                            let _ = child.write(b"stop\n");
                        }
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.eval("window.dispatchEvent(new Event('tepora-stop'))");
                        }
                    }
                    "quit" => request_exit(app.clone(), menu_state.clone()),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left, button_state: MouseButtonState::Up, ..
                    } = event { show_main(tray.app_handle()); }
                });
            if let Some(icon) = app.default_window_icon() { tray = tray.icon(icon.clone()); }
            tray.build(app)?;

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut opened = false;
                while let Some(event) = events.recv().await {
                    match event {
                        CommandEvent::Stdout(bytes) if !opened => {
                            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                                if value["type"] == "ready" {
                                    if let Some(raw) = value["url"].as_str() {
                                        if let Ok(url) = url::Url::parse(raw) {
                                            if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") { continue; }
                                            let port = url.port();
                                            let result = WebviewWindowBuilder::new(&handle, "main", WebviewUrl::External(url))
                                                .title("Tepora · Your quiet monitor")
                                                .inner_size(1440.0, 960.0)
                                                .min_inner_size(390.0, 640.0)
                                                .on_navigation(move |next| next.scheme() == "http" && next.host_str() == Some("127.0.0.1") && next.port() == port)
                                                .build();
                                            if result.is_ok() { opened = true; }
                                            else { eprintln!("Failed to create the Tepora window"); handle.exit(1); }
                                        }
                                    }
                                }
                            }
                        }
                        CommandEvent::Terminated(_) => { handle.exit(0); break; }
                        CommandEvent::Error(error) => { eprintln!("Tepora backend: {error}"); handle.exit(1); break; }
                        _ => {}
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Failed to start Tepora native host");
    app.run(move |handle, event| {
        match event {
            tauri::RunEvent::WindowEvent {
                label, event: tauri::WindowEvent::CloseRequested { api, .. }, ..
            } => {
                api.prevent_close();
                if let Some(window) = handle.get_webview_window(&label) {
                    let _ = window.eval("window.dispatchEvent(new Event('tepora-hide'))");
                    let _ = window.hide();
                }
            }
            tauri::RunEvent::ExitRequested { api, .. } if !state.closing.load(Ordering::SeqCst) => {
                api.prevent_exit();
                request_exit(handle.clone(), state.clone());
            }
            _ => {}
        }
    });
}
