use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;

use crate::core::config::AppPaths;
use crate::core::errors::ApiError;

use super::discovery::DiscoveredModel;
use super::metadata::{
    extract_architecture_from_model_info, extract_context_length, has_embedding_name_hint,
    infer_role_from_gguf_metadata, read_gguf_metadata,
};
use super::selection::validate_assignment_role;
use super::types::{ModelEntry, ModelRegistry};

#[derive(Clone)]
pub(crate) struct ModelRegistryStore {
    path: PathBuf,
}

impl ModelRegistryStore {
    pub(crate) fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub(crate) fn load(&self) -> Result<ModelRegistry, ApiError> {
        if !self.path.exists() {
            return Ok(ModelRegistry::default());
        }
        let contents = fs::read_to_string(&self.path).map_err(ApiError::internal)?;
        if contents.trim().is_empty() {
            return Ok(ModelRegistry::default());
        }
        let mut registry: ModelRegistry =
            serde_json::from_str(&contents).map_err(ApiError::internal)?;
        if migrate_legacy_loader_roles(&mut registry) {
            self.save(&registry)?;
        }
        Ok(registry)
    }

    pub(crate) fn save(&self, registry: &ModelRegistry) -> Result<(), ApiError> {
        let data = serde_json::to_string_pretty(registry).map_err(ApiError::internal)?;
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        fs::write(&self.path, data).map_err(ApiError::internal)?;
        Ok(())
    }

    pub(crate) fn list_models(&self) -> Result<Vec<ModelEntry>, ApiError> {
        Ok(self.load()?.models)
    }

    pub(crate) fn get_model(&self, model_id: &str) -> Result<Option<ModelEntry>, ApiError> {
        Ok(self.load()?.models.into_iter().find(|m| m.id == model_id))
    }

    pub(crate) fn insert_model(&self, entry: ModelEntry) -> Result<ModelEntry, ApiError> {
        let mut registry = self.load()?;
        registry.models.push(entry.clone());
        self.save(&registry)?;
        Ok(entry)
    }

    pub(crate) fn next_unique_id(&self, base: &str) -> Result<String, ApiError> {
        let registry = self.load()?;
        Ok(unique_model_id(base, &registry.models))
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn upsert_downloaded_model(
        &self,
        repo_id: &str,
        filename: &str,
        role: &str,
        display_name: &str,
        path: &Path,
        file_size: u64,
        revision: Option<String>,
        sha256: Option<String>,
    ) -> Result<ModelEntry, ApiError> {
        let mut registry = self.load()?;
        let file_path_str = path.to_string_lossy().to_string();
        let gguf_model_info = read_gguf_metadata(path).ok();
        let effective_role = gguf_model_info
            .as_ref()
            .and_then(|info| infer_role_from_gguf_metadata(filename, info))
            .unwrap_or_else(|| role.to_string());
        let architecture = extract_architecture_from_model_info(gguf_model_info.as_ref());
        let context_length =
            extract_context_length(gguf_model_info.as_ref(), architecture.as_deref());

        if let Some(existing) = registry.models.iter_mut().find(|m| {
            m.repo_id.as_deref() == Some(repo_id)
                && m.filename == filename
                && m.role == effective_role
        }) {
            existing.display_name = display_name.to_string();
            existing.file_path = file_path_str;
            existing.file_size = file_size;
            existing.role = effective_role.clone();
            existing.architecture = architecture.clone();
            existing.context_length = context_length;
            existing.revision = revision;
            existing.sha256 = sha256;
            existing.added_at = Utc::now().to_rfc3339();
            let updated = existing.clone();
            self.save(&registry)?;
            return Ok(updated);
        }

        let base_id = format!("{}-{}", effective_role, filename);
        let id = unique_model_id(&base_id, &registry.models);

        let entry = ModelEntry {
            id,
            display_name: display_name.to_string(),
            role: effective_role,
            file_size,
            filename: filename.to_string(),
            source: repo_id.to_string(),
            file_path: file_path_str,
            repo_id: Some(repo_id.to_string()),
            revision,
            sha256,
            added_at: Utc::now().to_rfc3339(),
            loader: "llama_cpp".to_string(),
            loader_model_name: None,
            parameter_size: None,
            quantization: None,
            context_length,
            architecture,
            chat_template: None,
            stop_tokens: None,
            default_temperature: None,
            capabilities: None,
            publisher: None,
            description: None,
            format: Some("gguf".to_string()),
            tokenizer_path: None,
            tokenizer_format: None,
        };

        registry.models.push(entry.clone());
        self.save(&registry)?;
        Ok(entry)
    }

    pub(crate) fn delete_model(&self, paths: &AppPaths, model_id: &str) -> Result<bool, ApiError> {
        let mut registry = self.load()?;
        let before = registry.models.len();
        let mut remove_path: Option<PathBuf> = None;
        registry.models.retain(|model| {
            if model.id == model_id {
                remove_path = Some(PathBuf::from(&model.file_path));
                false
            } else {
                true
            }
        });
        if before == registry.models.len() {
            return Ok(false);
        }

        if let Some(ref path) = remove_path {
            let path_str = path.to_string_lossy();
            let still_referenced = registry
                .models
                .iter()
                .any(|m| m.file_path == path_str.as_ref());
            if !still_referenced && path.starts_with(&paths.user_data_dir) {
                let _ = fs::remove_file(path);
            }
        }

        registry
            .role_assignments
            .retain(|_, value| value != model_id);
        for order in registry.role_order.values_mut() {
            order.retain(|id| id != model_id);
        }

        self.save(&registry)?;
        Ok(true)
    }

    pub(crate) fn set_assignment_model(
        &self,
        assignment_key: &str,
        model_id: &str,
    ) -> Result<bool, ApiError> {
        let mut registry = self.load()?;
        let Some(_) = registry.models.iter().find(|m| m.id == model_id) else {
            return Ok(false);
        };
        validate_assignment_role(&registry, assignment_key, model_id)?;
        registry
            .role_assignments
            .insert(assignment_key.to_string(), model_id.to_string());
        self.save(&registry)?;
        Ok(true)
    }

    pub(crate) fn remove_assignment(&self, assignment_key: &str) -> Result<bool, ApiError> {
        let mut registry = self.load()?;
        let removed = registry.role_assignments.remove(assignment_key).is_some();
        self.save(&registry)?;
        Ok(removed)
    }

    pub(crate) fn reorder_models(
        &self,
        role: &str,
        model_ids: Vec<String>,
    ) -> Result<bool, ApiError> {
        let mut registry = self.load()?;
        registry.role_order.insert(role.to_string(), model_ids);
        self.save(&registry)?;
        Ok(true)
    }

    pub(crate) fn apply_discovered_models(
        &self,
        loader: &str,
        discovered: Vec<DiscoveredModel>,
    ) -> Result<usize, ApiError> {
        let mut registry = self.load()?;
        let now = Utc::now().to_rfc3339();
        let mut count = 0;

        let mut removed_ids = Vec::new();
        registry.models.retain(|m| {
            if m.loader == loader && !discovered.iter().any(|d| d.id == m.id) {
                removed_ids.push(m.id.clone());
                false
            } else {
                true
            }
        });

        for id in &removed_ids {
            registry.role_assignments.retain(|_, value| value != id);
            for order in registry.role_order.values_mut() {
                order.retain(|v| v != id);
            }
        }
        
        count += removed_ids.len();

        for discovered_model in discovered {
            if let Some(existing) = registry
                .models
                .iter_mut()
                .find(|m| m.id == discovered_model.id)
            {
                let changed = existing.display_name != discovered_model.display_name
                    || existing.role != discovered_model.role
                    || existing.file_size != discovered_model.file_size
                    || existing.filename != discovered_model.filename
                    || existing.source != discovered_model.source
                    || existing.file_path != discovered_model.file_path
                    || existing.loader != discovered_model.loader
                    || existing.loader_model_name != discovered_model.loader_model_name
                    || existing.sha256 != discovered_model.sha256
                    || existing.parameter_size != discovered_model.parameter_size
                    || existing.quantization != discovered_model.quantization
                    || existing.context_length != discovered_model.context_length
                    || existing.architecture != discovered_model.architecture
                    || existing.chat_template != discovered_model.chat_template
                    || existing.stop_tokens != discovered_model.stop_tokens
                    || existing.default_temperature != discovered_model.default_temperature
                    || existing.capabilities != discovered_model.capabilities
                    || existing.publisher != discovered_model.publisher
                    || existing.description != discovered_model.description
                    || existing.format != discovered_model.format;

                existing.display_name = discovered_model.display_name;
                existing.role = discovered_model.role;
                existing.file_size = discovered_model.file_size;
                existing.filename = discovered_model.filename;
                existing.source = discovered_model.source;
                existing.file_path = discovered_model.file_path;
                existing.loader = discovered_model.loader;
                existing.loader_model_name = discovered_model.loader_model_name;
                existing.sha256 = discovered_model.sha256;
                existing.parameter_size = discovered_model.parameter_size;
                existing.quantization = discovered_model.quantization;
                existing.context_length = discovered_model.context_length;
                existing.architecture = discovered_model.architecture;
                existing.chat_template = discovered_model.chat_template;
                existing.stop_tokens = discovered_model.stop_tokens;
                existing.default_temperature = discovered_model.default_temperature;
                existing.capabilities = discovered_model.capabilities;
                existing.publisher = discovered_model.publisher;
                existing.description = discovered_model.description;
                existing.format = discovered_model.format;

                if changed {
                    count += 1;
                }
                continue;
            }

            registry
                .models
                .push(discovered_model.into_model_entry(now.clone()));
            count += 1;
        }

        if count > 0 {
            self.save(&registry)?;
        }

        Ok(count)
    }
}

fn unique_model_id(base: &str, models: &[ModelEntry]) -> String {
    if !models.iter().any(|m| m.id == base) {
        return base.to_string();
    }
    let mut idx = 2;
    loop {
        let candidate = format!("{}-{}", base, idx);
        if !models.iter().any(|m| m.id == candidate) {
            return candidate;
        }
        idx += 1;
    }
}

fn migrate_legacy_loader_roles(registry: &mut ModelRegistry) -> bool {
    let mut changed = false;

    for model in &mut registry.models {
        if model.role == "embedding" {
            continue;
        }
        let is_ollama_model = model.loader == "ollama" || model.source == "ollama";
        if !is_ollama_model {
            continue;
        }

        let name = model
            .loader_model_name
            .as_deref()
            .filter(|v| !v.is_empty())
            .unwrap_or(&model.filename);
        let has_name_hint = has_embedding_name_hint(name);
        let has_embedding_like_caps = model
            .capabilities
            .as_ref()
            .map(|caps| !caps.completion && !caps.tool_use && !caps.vision)
            .unwrap_or(true);

        if has_name_hint || has_embedding_like_caps {
            model.role = "embedding".to_string();
            changed = true;
        }
    }

    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::types::ModelCapabilities;
    use crate::models::types::ModelRegistry;

    fn make_model_entry(
        id: &str,
        role: &str,
        source: &str,
        loader: &str,
        filename: &str,
        capabilities: Option<ModelCapabilities>,
    ) -> ModelEntry {
        ModelEntry {
            id: id.to_string(),
            display_name: id.to_string(),
            role: role.to_string(),
            file_size: 1,
            filename: filename.to_string(),
            source: source.to_string(),
            file_path: format!("{}://{}", source, filename),
            loader: loader.to_string(),
            loader_model_name: Some(filename.to_string()),
            repo_id: None,
            revision: None,
            sha256: None,
            added_at: "2026-01-01T00:00:00Z".to_string(),
            parameter_size: None,
            quantization: None,
            context_length: None,
            architecture: None,
            chat_template: None,
            stop_tokens: None,
            default_temperature: None,
            capabilities,
            publisher: None,
            description: None,
            format: Some("gguf".to_string()),
            tokenizer_path: None,
            tokenizer_format: None,
        }
    }

    #[test]
    fn migrate_legacy_loader_roles_reclassifies_embedding_name() {
        let mut registry = ModelRegistry {
            models: vec![make_model_entry(
                "ollama-embeddinggemma:latest",
                "text",
                "ollama",
                "ollama",
                "embeddinggemma:latest",
                None,
            )],
            ..Default::default()
        };

        let changed = migrate_legacy_loader_roles(&mut registry);

        assert!(changed);
        assert_eq!(registry.models[0].role, "embedding");
    }

    #[test]
    fn migrate_legacy_loader_roles_reclassifies_embedding_like_capabilities() {
        let mut registry = ModelRegistry {
            models: vec![make_model_entry(
                "ollama-unknown",
                "text",
                "ollama",
                "ollama",
                "custom-model",
                Some(ModelCapabilities {
                    completion: false,
                    tool_use: false,
                    vision: false,
                }),
            )],
            ..Default::default()
        };

        let changed = migrate_legacy_loader_roles(&mut registry);

        assert!(changed);
        assert_eq!(registry.models[0].role, "embedding");
    }

    #[test]
    fn apply_discovered_models_updates_existing_entry() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = ModelRegistryStore::new(dir.path().join("models.json"));
        let existing = make_model_entry("ollama-m1", "text", "ollama", "ollama", "m1", None);
        store
            .save(&ModelRegistry {
                models: vec![existing],
                ..Default::default()
            })
            .expect("seed registry");

        let count = store
            .apply_discovered_models("ollama", vec![DiscoveredModel {
                id: "ollama-m1".to_string(),
                display_name: "M1 (Ollama)".to_string(),
                role: "embedding".to_string(),
                file_size: 42,
                filename: "m1".to_string(),
                source: "ollama".to_string(),
                file_path: "ollama://m1".to_string(),
                loader: "ollama".to_string(),
                loader_model_name: Some("m1".to_string()),
                sha256: Some("abc".to_string()),
                parameter_size: None,
                quantization: None,
                context_length: Some(1024),
                architecture: Some("llama".to_string()),
                chat_template: None,
                stop_tokens: None,
                default_temperature: None,
                capabilities: None,
                publisher: None,
                description: None,
                format: Some("gguf".to_string()),
                tokenizer_path: None,
                tokenizer_format: None,
            }])
            .expect("apply discovered");

        assert_eq!(count, 1);
        let updated = store
            .get_model("ollama-m1")
            .expect("get model")
            .expect("existing model");
        assert_eq!(updated.role, "embedding");
        assert_eq!(updated.file_size, 42);
    }

    #[test]
    fn delete_model_keeps_shared_file_if_other_entry_references_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let shared_path = dir.path().join("shared.gguf");
        fs::write(&shared_path, b"model").expect("write shared");
        let store = ModelRegistryStore::new(dir.path().join("models.json"));
        store
            .save(&ModelRegistry {
                models: vec![
                    ModelEntry {
                        id: "a".to_string(),
                        display_name: "a".to_string(),
                        role: "text".to_string(),
                        file_size: 1,
                        filename: "shared.gguf".to_string(),
                        source: "local".to_string(),
                        file_path: shared_path.to_string_lossy().to_string(),
                        loader: "llama_cpp".to_string(),
                        loader_model_name: None,
                        repo_id: None,
                        revision: None,
                        sha256: None,
                        added_at: "2026-01-01T00:00:00Z".to_string(),
                        parameter_size: None,
                        quantization: None,
                        context_length: None,
                        architecture: None,
                        chat_template: None,
                        stop_tokens: None,
                        default_temperature: None,
                        capabilities: None,
                        publisher: None,
                        description: None,
                        format: Some("gguf".to_string()),
                        tokenizer_path: None,
                        tokenizer_format: None,
                    },
                    ModelEntry {
                        id: "b".to_string(),
                        display_name: "b".to_string(),
                        role: "text".to_string(),
                        file_size: 1,
                        filename: "shared.gguf".to_string(),
                        source: "local".to_string(),
                        file_path: shared_path.to_string_lossy().to_string(),
                        loader: "llama_cpp".to_string(),
                        loader_model_name: None,
                        repo_id: None,
                        revision: None,
                        sha256: None,
                        added_at: "2026-01-01T00:00:00Z".to_string(),
                        parameter_size: None,
                        quantization: None,
                        context_length: None,
                        architecture: None,
                        chat_template: None,
                        stop_tokens: None,
                        default_temperature: None,
                        capabilities: None,
                        publisher: None,
                        description: None,
                        format: Some("gguf".to_string()),
                        tokenizer_path: None,
                        tokenizer_format: None,
                    },
                ],
                ..Default::default()
            })
            .expect("seed registry");

        let paths = AppPaths {
            project_root: dir.path().to_path_buf(),
            user_data_dir: dir.path().to_path_buf(),
            log_dir: dir.path().join("logs"),
            db_path: dir.path().join("db.sqlite"),
            secrets_path: dir.path().join("secrets.yaml"),
        };

        assert!(store.delete_model(&paths, "a").expect("delete"));
        assert!(shared_path.exists());
    }
}
