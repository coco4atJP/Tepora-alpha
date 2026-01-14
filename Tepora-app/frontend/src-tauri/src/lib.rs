use std::path::PathBuf;
use tauri::RunEvent;
use tauri_plugin_log::{Target, TargetKind};

#[tauri::command]
fn read_session_token() -> Option<String> {
    if let Ok(token) = std::env::var("TEPORA_SESSION_TOKEN") {
        let token = token.trim().to_string();
        if !token.is_empty() {
            return Some(token);
        }
    }

    let home_dir = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)?;
    let token_path = home_dir.join(".tepora").join(".session_token");
    let token = std::fs::read_to_string(token_path).ok()?;
    let token = token.trim().to_string();
    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .target(Target::new(TargetKind::LogDir {
                    file_name: Some("tepora".to_string()),
                }))
                .build())
        .invoke_handler(tauri::generate_handler![read_session_token])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, event| {
        match event {
            RunEvent::ExitRequested { api: _, code: _, .. } => {
                // ウィンドウが閉じられた時、アプリ終了を許可
                // 何もしなければデフォルトで終了する
                log::info!("Exit requested, allowing application to exit");
            }
            RunEvent::Exit => {
                // アプリ終了時のクリーンアップ
                log::info!("Application exiting");
                // 念のため強制終了して、サイドカープロセス等の残留を防ぐ
                std::process::exit(0);
            }
            _ => {}
        }
    });
}
