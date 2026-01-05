use tauri::RunEvent;
use tauri_plugin_log::{Target, TargetKind};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .target(Target::new(TargetKind::LogDir {
                    file_name: Some("tepora".to_string()),
                }))
                .build(),
        )
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
