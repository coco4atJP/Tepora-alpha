use tauri_plugin_log::{Target, TargetKind};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(
      tauri_plugin_log::Builder::new()
        .level(log::LevelFilter::Info)
        .target(Target::new(TargetKind::LogDir {
          file_name: Some("tepora".to_string()),
        }))
        .build(),
    )
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
