use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::config::AppPaths;
use crate::errors::ApiError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetupProgress {
    pub status: String,
    pub progress: f32,
    pub message: String,
}

impl Default for SetupProgress {
    fn default() -> Self {
        Self {
            status: "idle".to_string(),
            progress: 0.0,
            message: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetupStateData {
    pub language: String,
    pub loader: String,
    pub job_id: Option<String>,
    pub progress: SetupProgress,
    pub updated_at: String,
}

#[derive(Clone)]
pub struct SetupState {
    inner: Arc<Mutex<SetupStateData>>,
    state_path: PathBuf,
}

impl SetupState {
    pub fn new(paths: &AppPaths) -> Self {
        let state_path = paths.user_data_dir.join("setup_state.json");
        let data = load_state(&state_path).unwrap_or_else(|| SetupStateData {
            language: "en".to_string(),
            loader: "llama_cpp".to_string(),
            job_id: None,
            progress: SetupProgress::default(),
            updated_at: Utc::now().to_rfc3339(),
        });

        Self {
            inner: Arc::new(Mutex::new(data)),
            state_path,
        }
    }

    pub fn set_language(&self, language: String) -> Result<(), ApiError> {
        let mut guard = self.inner.lock().map_err(ApiError::internal)?;
        guard.language = language;
        guard.updated_at = Utc::now().to_rfc3339();
        drop(guard);
        self.save_state()
    }

    pub fn set_loader(&self, loader: String) -> Result<(), ApiError> {
        let mut guard = self.inner.lock().map_err(ApiError::internal)?;
        guard.loader = loader;
        guard.updated_at = Utc::now().to_rfc3339();
        drop(guard);
        self.save_state()
    }

    pub fn set_job_id(&self, job_id: Option<String>) -> Result<(), ApiError> {
        let mut guard = self.inner.lock().map_err(ApiError::internal)?;
        guard.job_id = job_id;
        guard.updated_at = Utc::now().to_rfc3339();
        drop(guard);
        self.save_state()
    }

    pub fn update_progress(
        &self,
        status: &str,
        progress: f32,
        message: &str,
    ) -> Result<(), ApiError> {
        let mut guard = self.inner.lock().map_err(ApiError::internal)?;
        guard.progress = SetupProgress {
            status: status.to_string(),
            progress,
            message: message.to_string(),
        };
        guard.updated_at = Utc::now().to_rfc3339();
        drop(guard);
        self.save_state()
    }

    pub fn snapshot(&self) -> Result<SetupStateData, ApiError> {
        let guard = self.inner.lock().map_err(ApiError::internal)?;
        Ok(guard.clone())
    }

    pub fn clear(&self) -> Result<(), ApiError> {
        {
            let mut guard = self.inner.lock().map_err(ApiError::internal)?;
            guard.job_id = None;
            guard.progress = SetupProgress::default();
            guard.updated_at = Utc::now().to_rfc3339();
        }
        if self.state_path.exists() {
            let _ = fs::remove_file(&self.state_path);
        }
        Ok(())
    }

    fn save_state(&self) -> Result<(), ApiError> {
        if let Some(parent) = self.state_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let guard = self.inner.lock().map_err(ApiError::internal)?;
        let data = serde_json::to_string_pretty(&*guard).map_err(ApiError::internal)?;
        fs::write(&self.state_path, data).map_err(ApiError::internal)?;
        Ok(())
    }
}

fn load_state(path: &PathBuf) -> Option<SetupStateData> {
    let contents = fs::read_to_string(path).ok()?;
    serde_json::from_str::<SetupStateData>(&contents).ok()
}
