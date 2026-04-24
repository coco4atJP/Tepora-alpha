use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;

use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, RwLock};

use crate::core::config::{AppPaths, ConfigService};
use crate::core::errors::ApiError;
use crate::domain::errors::DomainError;
use crate::domain::knowledge::{
    ContextConfig, KnowledgeChunk, KnowledgeHit, KnowledgePort, KnowledgeSource,
};
use crate::history::{HistoryStore, SessionInfo};
use crate::infrastructure::knowledge_store::RagKnowledgeAdapter;
use crate::llm::LlamaService;
use crate::rag::{RagStore, SqliteRagStore};

const DEFAULT_PROJECT_ID: &str = "default";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceProjectInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceEntry {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub section: String,
    pub children: Vec<WorkspaceEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceFileDocument {
    pub path: String,
    pub section: String,
    pub content: String,
    pub editable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateProjectRequest {
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProjectManifest {
    pub name: String,
}

#[derive(Clone)]
pub struct WorkspaceManager {
    paths: Arc<AppPaths>,
    pub current_project_id: Arc<RwLock<String>>,
    revision: Arc<AtomicU64>,
    _watcher: Arc<StdMutex<Option<RecommendedWatcher>>>,
}

impl WorkspaceManager {
    pub fn new(paths: Arc<AppPaths>) -> Result<Self, ApiError> {
        fs::create_dir_all(paths.tepora_home()).map_err(ApiError::internal)?;
        ensure_project_layout(&paths, DEFAULT_PROJECT_ID)?;

        let revision = Arc::new(AtomicU64::new(1));
        let revision_clone = revision.clone();
        let root = paths.tepora_home();
        let watcher = RecommendedWatcher::new(
            move |result: Result<Event, notify::Error>| {
                if result.is_ok() {
                    revision_clone.fetch_add(1, Ordering::Relaxed);
                }
            },
            Config::default(),
        )
        .map_err(ApiError::internal)?;

        let watcher = Arc::new(StdMutex::new(Some(watcher)));
        if let Ok(mut guard) = watcher.lock() {
            if let Some(inner) = guard.as_mut() {
                let _ = inner.watch(&root, RecursiveMode::Recursive);
            }
        }

        Ok(Self {
            paths,
            current_project_id: Arc::new(RwLock::new(DEFAULT_PROJECT_ID.to_string())),
            revision,
            _watcher: watcher,
        })
    }

    pub async fn current_project_id(&self) -> String {
        self.current_project_id.read().await.clone()
    }

    pub async fn set_current_project(&self, project_id: &str) -> Result<(), ApiError> {
        ensure_project_layout(&self.paths, project_id)?;
        *self.current_project_id.write().await = project_id.to_string();
        self.revision.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    pub fn revision(&self) -> u64 {
        self.revision.load(Ordering::Relaxed)
    }

    pub fn list_projects(&self) -> Result<Vec<WorkspaceProjectInfo>, ApiError> {
        let mut projects = vec![self.project_info(DEFAULT_PROJECT_ID)?];
        let entries = fs::read_dir(self.paths.tepora_home()).map_err(ApiError::internal)?;
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(id) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            if id == DEFAULT_PROJECT_ID {
                continue;
            }
            if !path.join("workspace").exists() {
                continue;
            }
            projects.push(self.project_info(id)?);
        }
        projects.sort_by(|left, right| left.name.cmp(&right.name).then_with(|| left.id.cmp(&right.id)));
        Ok(projects)
    }

    pub fn create_project(&self, request: CreateProjectRequest) -> Result<WorkspaceProjectInfo, ApiError> {
        let project_id = format!("project-{}", uuid::Uuid::new_v4().simple());
        ensure_project_layout(&self.paths, &project_id)?;
        let project_dir = self.paths.project_dir(&project_id);
        let manifest = ProjectManifest {
            name: request
                .name
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "Untitled Project".to_string()),
        };
        let manifest_body = serde_json::to_string_pretty(&manifest).map_err(ApiError::internal)?;
        fs::write(project_dir.join("project.json"), manifest_body).map_err(ApiError::internal)?;
        self.revision.fetch_add(1, Ordering::Relaxed);
        self.project_info(&project_id)
    }

    pub fn project_dir(&self, project_id: &str) -> PathBuf {
        self.paths.project_dir(project_id)
    }

    pub fn read_document(&self, project_id: &str, relative_path: &str) -> Result<WorkspaceFileDocument, ApiError> {
        let resolved = resolve_project_file_path(&self.paths, project_id, relative_path)?;
        let content = fs::read_to_string(&resolved.path).map_err(ApiError::internal)?;
        Ok(WorkspaceFileDocument {
            path: relative_path.replace('\\', "/"),
            section: resolved.section,
            content,
            editable: true,
        })
    }

    pub fn write_document(
        &self,
        project_id: &str,
        relative_path: &str,
        content: &str,
    ) -> Result<WorkspaceFileDocument, ApiError> {
        let resolved = resolve_project_file_path(&self.paths, project_id, relative_path)?;
        if let Some(parent) = resolved.path.parent() {
            fs::create_dir_all(parent).map_err(ApiError::internal)?;
        }
        fs::write(&resolved.path, content).map_err(ApiError::internal)?;
        self.revision.fetch_add(1, Ordering::Relaxed);
        Ok(WorkspaceFileDocument {
            path: relative_path.replace('\\', "/"),
            section: resolved.section,
            content: content.to_string(),
            editable: true,
        })
    }

    pub fn create_directory(&self, project_id: &str, relative_path: &str) -> Result<(), ApiError> {
        let resolved = resolve_project_file_path(&self.paths, project_id, relative_path)?;
        fs::create_dir_all(&resolved.path).map_err(ApiError::internal)?;
        self.revision.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    pub fn rename_path(&self, project_id: &str, old_relative_path: &str, new_relative_path: &str) -> Result<(), ApiError> {
        let old_resolved = resolve_project_file_path(&self.paths, project_id, old_relative_path)?;
        let new_resolved = resolve_project_file_path(&self.paths, project_id, new_relative_path)?;
        if !old_resolved.path.exists() {
            return Err(ApiError::NotFound("Path not found".to_string()));
        }
        if let Some(parent) = new_resolved.path.parent() {
            fs::create_dir_all(parent).map_err(ApiError::internal)?;
        }
        fs::rename(&old_resolved.path, &new_resolved.path).map_err(ApiError::internal)?;
        self.revision.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    pub fn delete_path(&self, project_id: &str, relative_path: &str) -> Result<(), ApiError> {
        let resolved = resolve_project_file_path(&self.paths, project_id, relative_path)?;
        if !resolved.path.exists() {
            return Err(ApiError::NotFound("Path not found".to_string()));
        }
        if resolved.path.is_dir() {
            fs::remove_dir_all(&resolved.path).map_err(ApiError::internal)?;
        } else {
            fs::remove_file(&resolved.path).map_err(ApiError::internal)?;
        }
        self.revision.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }


    pub fn tree(&self, project_id: &str) -> Result<Vec<WorkspaceEntry>, ApiError> {
        ensure_project_layout(&self.paths, project_id)?;
        let sections = [
            ("contexts", self.paths.project_contexts_dir(project_id)),
            ("skills", self.paths.project_skills_dir(project_id)),
            ("workspace", self.paths.project_workspace_dir(project_id)),
        ];
        sections
            .into_iter()
            .map(|(section, root)| build_tree(section, &root, &root))
            .collect()
    }

    fn project_info(&self, project_id: &str) -> Result<WorkspaceProjectInfo, ApiError> {
        ensure_project_layout(&self.paths, project_id)?;
        let project_dir = self.paths.project_dir(project_id);
        let name = fs::read_to_string(project_dir.join("project.json"))
            .ok()
            .and_then(|body| serde_json::from_str::<ProjectManifest>(&body).ok())
            .map(|manifest| manifest.name)
            .unwrap_or_else(|| {
                if project_id == DEFAULT_PROJECT_ID {
                    "Default".to_string()
                } else {
                    project_id.to_string()
                }
            });
        Ok(WorkspaceProjectInfo {
            id: project_id.to_string(),
            name,
            path: project_dir.to_string_lossy().to_string(),
            is_default: project_id == DEFAULT_PROJECT_ID,
        })
    }
}

#[derive(Clone)]
pub struct ProjectHistoryStore {
    inner: HistoryStore,
    current_project_id: Arc<RwLock<String>>,
}

impl ProjectHistoryStore {
    pub fn new(inner: HistoryStore, current_project_id: Arc<RwLock<String>>) -> Self {
        Self {
            inner,
            current_project_id,
        }
    }

    pub async fn list_sessions(&self) -> Result<Vec<SessionInfo>, ApiError> {
        let project_id = self.current_project_id.read().await.clone();
        self.inner.list_sessions(Some(&project_id)).await
    }

    pub async fn create_session(&self, title: Option<String>) -> Result<String, ApiError> {
        let project_id = self.current_project_id.read().await.clone();
        self.inner.create_session(title, &project_id).await
    }

    pub async fn get_session(&self, session_id: &str) -> Result<Option<SessionInfo>, ApiError> {
        self.inner.get_session(session_id).await
    }

    pub async fn get_session_project_id(&self, session_id: &str) -> Result<Option<String>, ApiError> {
        self.inner.get_session_project_id(session_id).await
    }

    pub async fn sync_current_project_with_session(&self, session_id: &str) -> Result<Option<String>, ApiError> {
        let project_id = self.get_session_project_id(session_id).await?;
        if let Some(project_id) = &project_id {
            *self.current_project_id.write().await = project_id.clone();
        }
        Ok(project_id)
    }

    pub async fn update_session_title(&self, session_id: &str, title: &str) -> Result<(), ApiError> {
        self.inner.update_session_title(session_id, title).await
    }

    pub async fn delete_session(&self, session_id: &str) -> Result<(), ApiError> {
        self.inner.delete_session(session_id).await
    }

    pub async fn add_message(
        &self,
        session_id: &str,
        role: &str,
        content: &str,
        additional_kwargs: Option<serde_json::Value>,
    ) -> Result<i64, ApiError> {
        self.inner
            .add_message(session_id, role, content, additional_kwargs)
            .await
    }

    pub async fn get_history(&self, session_id: &str, limit: i64) -> Result<Vec<crate::history::HistoryMessage>, ApiError> {
        self.inner.get_history(session_id, limit).await
    }

    pub async fn touch_session(&self, session_id: &str) -> Result<(), ApiError> {
        self.inner.touch_session(session_id).await
    }

    pub async fn get_last_user_message(
        &self,
        session_id: &str,
    ) -> Result<Option<crate::history::HistoryMessage>, ApiError> {
        self.inner.get_last_user_message(session_id).await
    }

    pub async fn delete_trailing_assistant_messages(&self, session_id: &str) -> Result<(), ApiError> {
        self.inner.delete_trailing_assistant_messages(session_id).await
    }

    pub async fn save_agent_event(&self, event: &crate::models::event::AgentEvent) -> Result<(), ApiError> {
        self.inner.save_agent_event(event).await
    }

    pub async fn get_agent_events(&self, session_id: &str) -> Result<Vec<crate::models::event::AgentEvent>, ApiError> {
        self.inner.get_agent_events(session_id).await
    }

    pub async fn get_total_message_count(&self) -> Result<i64, ApiError> {
        self.inner.get_total_message_count().await
    }
}

#[derive(Clone)]
pub struct ProjectKnowledgePort {
    paths: Arc<AppPaths>,
    current_project_id: Arc<RwLock<String>>,
    history: ProjectHistoryStore,
    stores: Arc<Mutex<HashMap<String, Arc<dyn RagStore>>>>,
    llama: LlamaService,
    config: ConfigService,
}

impl ProjectKnowledgePort {
    pub fn new(
        paths: Arc<AppPaths>,
        current_project_id: Arc<RwLock<String>>,
        history: ProjectHistoryStore,
        llama: LlamaService,
        config: ConfigService,
    ) -> Self {
        Self {
            paths,
            current_project_id,
            history,
            stores: Arc::new(Mutex::new(HashMap::new())),
            llama,
            config,
        }
    }

    async fn project_id_for_session(&self, session_id: Option<&str>) -> Result<String, DomainError> {
        if let Some(session_id) = session_id {
            if let Some(project_id) = self
                .history
                .get_session_project_id(session_id)
                .await
                .map_err(api_error_to_domain_error)?
            {
                return Ok(project_id);
            }
        }
        Ok(self.current_project_id.read().await.clone())
    }

    async fn rag_store_for_project(&self, project_id: &str) -> Result<Arc<dyn RagStore>, DomainError> {
        let mut stores = self.stores.lock().await;
        if let Some(store) = stores.get(project_id) {
            return Ok(store.clone());
        }
        ensure_project_layout(&self.paths, project_id).map_err(api_error_to_domain_error)?;
        let db_path = self.paths.project_rag_db_path(project_id);
        let store = Arc::new(SqliteRagStore::with_path(db_path).await.map_err(api_error_to_domain_error)?)
            as Arc<dyn RagStore>;
        stores.insert(project_id.to_string(), store.clone());
        Ok(store)
    }

    async fn adapter_for_project(&self, project_id: &str) -> Result<RagKnowledgeAdapter, DomainError> {
        let store = self.rag_store_for_project(project_id).await?;
        Ok(RagKnowledgeAdapter::new(
            store,
            self.llama.clone(),
            self.config.clone(),
        ))
    }

}

#[async_trait::async_trait]
impl KnowledgePort for ProjectKnowledgePort {
    async fn ingest(&self, source: KnowledgeSource, session_id: &str) -> Result<Vec<String>, DomainError> {
        let project_id = self.project_id_for_session(Some(session_id)).await?;
        self.adapter_for_project(&project_id).await?.ingest(source, session_id).await
    }

    async fn search(
        &self,
        query_embedding: &[f32],
        limit: usize,
        session_id: Option<&str>,
    ) -> Result<Vec<KnowledgeHit>, DomainError> {
        let project_id = self.project_id_for_session(session_id).await?;
        self.adapter_for_project(&project_id)
            .await?
            .search(query_embedding, limit, session_id)
            .await
    }

    async fn text_search(
        &self,
        pattern: &str,
        limit: usize,
        session_id: Option<&str>,
    ) -> Result<Vec<KnowledgeChunk>, DomainError> {
        let project_id = self.project_id_for_session(session_id).await?;
        self.adapter_for_project(&project_id)
            .await?
            .text_search(pattern, limit, session_id)
            .await
    }

    async fn get_chunk(&self, chunk_id: &str) -> Result<Option<KnowledgeChunk>, DomainError> {
        let project_id = self.project_id_for_session(None).await?;
        self.adapter_for_project(&project_id).await?.get_chunk(chunk_id).await
    }

    async fn get_chunk_window(
        &self,
        chunk_id: &str,
        max_chars: usize,
        session_id: Option<&str>,
    ) -> Result<Vec<KnowledgeChunk>, DomainError> {
        let project_id = self.project_id_for_session(session_id).await?;
        self.adapter_for_project(&project_id)
            .await?
            .get_chunk_window(chunk_id, max_chars, session_id)
            .await
    }

    async fn build_context(
        &self,
        query: &str,
        query_embedding: &[f32],
        config: &ContextConfig,
    ) -> Result<String, DomainError> {
        let project_id = self.project_id_for_session(config.session_id.as_deref()).await?;
        self.adapter_for_project(&project_id)
            .await?
            .build_context(query, query_embedding, config)
            .await
    }

    async fn clear_session(&self, session_id: &str) -> Result<usize, DomainError> {
        let project_id = self.project_id_for_session(Some(session_id)).await?;
        self.adapter_for_project(&project_id).await?.clear_session(session_id).await
    }

    async fn reindex(&self, embedding_model: &str) -> Result<(), DomainError> {
        let project_id = self.project_id_for_session(None).await?;
        self.adapter_for_project(&project_id).await?.reindex(embedding_model).await
    }
}

struct ResolvedProjectFile {
    path: PathBuf,
    section: String,
}

fn resolve_project_file_path(
    paths: &AppPaths,
    project_id: &str,
    relative_path: &str,
) -> Result<ResolvedProjectFile, ApiError> {
    let normalized = relative_path.replace('\\', "/");
    let mut segments = normalized.split('/').filter(|value| !value.is_empty());
    let Some(section) = segments.next() else {
        return Err(ApiError::BadRequest("A workspace path is required".to_string()));
    };
    let root = match section {
        "contexts" => paths.project_contexts_dir(project_id),
        "skills" => paths.project_skills_dir(project_id),
        "workspace" => paths.project_workspace_dir(project_id),
        _ => {
            return Err(ApiError::BadRequest(
                "Workspace paths must start with contexts/, skills/, or workspace/".to_string(),
            ))
        }
    };
    let candidate = segments.fold(root.clone(), |acc, part| acc.join(part));
    let canonical_parent = root.canonicalize().unwrap_or(root.clone());
    let candidate_parent = candidate
        .parent()
        .unwrap_or(candidate.as_path())
        .canonicalize()
        .unwrap_or_else(|_| candidate.parent().unwrap_or(candidate.as_path()).to_path_buf());
    if !candidate_parent.starts_with(&canonical_parent) {
        return Err(ApiError::Forbidden);
    }
    Ok(ResolvedProjectFile {
        path: candidate,
        section: section.to_string(),
    })
}

fn build_tree(section: &str, root: &Path, current: &Path) -> Result<WorkspaceEntry, ApiError> {
    let name = current
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(section)
        .to_string();
    if !current.exists() {
        fs::create_dir_all(current).map_err(ApiError::internal)?;
    }
    let mut children = Vec::new();
    let entries = fs::read_dir(current).map_err(ApiError::internal)?;
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if path.is_dir() {
            children.push(build_tree(section, root, &path)?);
        } else {
            let rel = path
                .strip_prefix(root)
                .unwrap_or(path.as_path())
                .to_string_lossy()
                .replace('\\', "/");
            children.push(WorkspaceEntry {
                path: format!("{section}/{rel}"),
                name: path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or_default()
                    .to_string(),
                kind: "file".to_string(),
                section: section.to_string(),
                children: Vec::new(),
            });
        }
    }
    children.sort_by(|left, right| left.name.cmp(&right.name));
    let path = if current == root {
        section.to_string()
    } else {
        let rel = current
            .strip_prefix(root)
            .unwrap_or(current)
            .to_string_lossy()
            .replace('\\', "/");
        format!("{section}/{rel}")
    };
    Ok(WorkspaceEntry {
        path,
        name,
        kind: "directory".to_string(),
        section: section.to_string(),
        children,
    })
}

fn ensure_project_layout(paths: &AppPaths, project_id: &str) -> Result<(), ApiError> {
    let project_dir = paths.project_dir(project_id);
    for dir in [
        project_dir.clone(),
        paths.project_contexts_dir(project_id),
        paths.project_skills_dir(project_id),
        paths.project_workspace_dir(project_id),
    ] {
        fs::create_dir_all(dir).map_err(ApiError::internal)?;
    }
    Ok(())
}

fn api_error_to_domain_error(value: ApiError) -> DomainError {
    match value {
        ApiError::BadRequest(message) => DomainError::InvalidInput(message),
        ApiError::NotImplemented(message) => DomainError::NotSupported(message),
        other => DomainError::Storage(other.to_string()),
    }
}
