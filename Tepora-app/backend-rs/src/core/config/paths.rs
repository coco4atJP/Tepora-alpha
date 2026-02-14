use std::env;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct AppPaths {
    pub project_root: PathBuf,
    pub user_data_dir: PathBuf,
    pub log_dir: PathBuf,
    pub db_path: PathBuf,
    pub secrets_path: PathBuf,
}

impl AppPaths {
    pub fn new() -> Self {
        let project_root = discover_project_root();
        let user_data_dir = discover_user_data_dir(&project_root);
        let log_dir = user_data_dir.join("logs");
        let db_path = user_data_dir.join("tepora_core.db");
        let secrets_path = user_data_dir.join("secrets.yaml");
        let legacy_db_path = user_data_dir.join("tepora_chat.db");
        let legacy_chroma_dir = user_data_dir.join("chroma_db");
        let legacy_rag_db = user_data_dir.join("rag.db");

        for dir in [&user_data_dir, &log_dir] {
            let _ = fs::create_dir_all(dir);
        }

        // Clean up legacy storage files (migrated to LanceDB in v5.0)
        if legacy_db_path.exists() {
            let _ = fs::remove_file(&legacy_db_path);
        }
        if legacy_chroma_dir.exists() {
            let _ = fs::remove_dir_all(&legacy_chroma_dir);
        }
        if legacy_rag_db.exists() {
            let _ = fs::remove_file(&legacy_rag_db);
        }

        AppPaths {
            project_root,
            user_data_dir,
            log_dir,
            db_path,
            secrets_path,
        }
    }
}

fn discover_project_root() -> PathBuf {
    if let Ok(root) = env::var("TEPORA_ROOT") {
        return PathBuf::from(root);
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if manifest_dir.join("config.yml").exists() {
        return manifest_dir;
    }

    let sibling_backend = manifest_dir.join("..").join("backend");
    if sibling_backend.join("config.yml").exists() {
        return sibling_backend;
    }

    env::current_dir().unwrap_or(manifest_dir)
}

fn discover_user_data_dir(project_root: &Path) -> PathBuf {
    if let Ok(dir) = env::var("TEPORA_DATA_DIR") {
        return PathBuf::from(dir);
    }

    if cfg!(debug_assertions) {
        return project_root.to_path_buf();
    }

    if cfg!(target_os = "windows") {
        let base = env::var("LOCALAPPDATA")
            .unwrap_or_else(|_| env::var("USERPROFILE").unwrap_or_else(|_| ".".to_string()));
        return PathBuf::from(base).join("Tepora");
    }

    if cfg!(target_os = "macos") {
        return home_dir()
            .join("Library")
            .join("Application Support")
            .join("Tepora");
    }

    let xdg = env::var("XDG_DATA_HOME").unwrap_or_else(|_| {
        home_dir()
            .join(".local/share")
            .to_string_lossy()
            .to_string()
    });
    PathBuf::from(xdg).join("tepora")
}

fn home_dir() -> PathBuf {
    env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}
