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
        let user_data_dir = discover_user_data_dir();
        let log_dir = user_data_dir.join("logs");
        let db_path = user_data_dir.join("tepora_core.db");
        let secrets_path = user_data_dir.join("secrets.yaml");
        let legacy_db_path = user_data_dir.join("tepora_chat.db");
        let legacy_chroma_dir = user_data_dir.join("chroma_db");

        for dir in [&user_data_dir, &log_dir] {
            let _ = fs::create_dir_all(dir);
        }

        if legacy_db_path.exists() {
            let _ = fs::remove_file(&legacy_db_path);
        }
        if legacy_chroma_dir.exists() {
            let _ = fs::remove_dir_all(&legacy_chroma_dir);
        }

        AppPaths {
            project_root,
            user_data_dir,
            log_dir,
            db_path,
            secrets_path,
        }
    }

    pub fn tepora_home(&self) -> PathBuf {
        self.user_data_dir
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| self.user_data_dir.clone())
    }

    pub fn project_dir(&self, project_id: &str) -> PathBuf {
        self.tepora_home().join(project_id)
    }

    pub fn project_contexts_dir(&self, project_id: &str) -> PathBuf {
        self.project_dir(project_id).join("contexts")
    }

    pub fn project_skills_dir(&self, project_id: &str) -> PathBuf {
        self.project_dir(project_id).join("skills")
    }

    pub fn project_workspace_dir(&self, project_id: &str) -> PathBuf {
        self.project_dir(project_id).join("workspace")
    }

    pub fn project_rag_db_path(&self, project_id: &str) -> PathBuf {
        self.project_dir(project_id).join("rag.db")
    }
}

impl Default for AppPaths {
    fn default() -> Self {
        Self::new()
    }
}

fn discover_project_root() -> PathBuf {
    if let Ok(root) = env::var("TEPORA_ROOT") {
        return PathBuf::from(root);
    }

    #[cfg(debug_assertions)]
    {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        if manifest_dir.join("config.yml").exists() {
            return manifest_dir;
        }

        let sibling_backend = manifest_dir.join("..").join("backend");
        if sibling_backend.join("config.yml").exists() {
            return sibling_backend;
        }
    }

    if let Ok(exe_path) = env::current_exe() {
        if let Some(parent) = exe_path.parent() {
            return parent.to_path_buf();
        }
    }

    env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn discover_user_data_dir() -> PathBuf {
    if let Ok(dir) = env::var("TEPORA_DATA_DIR") {
        return PathBuf::from(dir);
    }

    discover_tepora_home().join("default")
}

fn discover_tepora_home() -> PathBuf {
    if let Ok(dir) = env::var("TEPORA_HOME") {
        return PathBuf::from(dir);
    }

    home_dir().join(".tepora")
}

fn home_dir() -> PathBuf {
    env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}
