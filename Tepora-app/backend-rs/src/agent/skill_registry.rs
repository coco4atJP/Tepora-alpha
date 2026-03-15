//! SkillRegistry - Manages Agent Skills packages using the standard SKILL.md layout.
//!
//! A skill package is stored under `<root>/<skill-id>/` and may contain:
//! - `SKILL.md` with YAML frontmatter (`name`, `description`, ...)
//! - `agents/openai.yaml`
//! - `references/`, `scripts/`, `assets/`

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::core::config::{AppPaths, ConfigService};
use crate::core::errors::ApiError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillRootConfig {
    pub path: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillRootInfo {
    pub path: String,
    pub enabled: bool,
    pub label: Option<String>,
    pub writable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillFileEntry {
    pub path: String,
    pub kind: String,
    pub content: String,
    #[serde(default = "default_utf8_encoding")]
    pub encoding: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSkillSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub package_dir: String,
    pub root_path: String,
    #[serde(default)]
    pub root_label: Option<String>,
    #[serde(default)]
    pub metadata: Value,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub short_description: Option<String>,
    #[serde(default)]
    pub valid: bool,
    #[serde(default)]
    pub writable: bool,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSkillPackage {
    #[serde(flatten)]
    pub summary: AgentSkillSummary,
    pub skill_markdown: String,
    pub skill_body: String,
    #[serde(default)]
    pub openai_yaml: Option<String>,
    #[serde(default)]
    pub references: Vec<SkillFileEntry>,
    #[serde(default)]
    pub scripts: Vec<SkillFileEntry>,
    #[serde(default)]
    pub assets: Vec<SkillFileEntry>,
    #[serde(default)]
    pub other_files: Vec<SkillFileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSkillSaveRequest {
    pub id: String,
    #[serde(default)]
    pub root_path: Option<String>,
    pub skill_markdown: String,
    #[serde(default)]
    pub openai_yaml: Option<String>,
    #[serde(default)]
    pub references: Vec<SkillFileEntry>,
    #[serde(default)]
    pub scripts: Vec<SkillFileEntry>,
    #[serde(default)]
    pub assets: Vec<SkillFileEntry>,
    #[serde(default)]
    pub other_files: Vec<SkillFileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillExportBundle {
    #[serde(default)]
    pub roots: Vec<SkillRootConfig>,
    #[serde(default)]
    pub skills: Vec<AgentSkillPackage>,
}

#[derive(Clone)]
pub struct SkillRegistry {
    paths: Arc<AppPaths>,
    config: ConfigService,
}

impl SkillRegistry {
    pub fn new(paths: &AppPaths, config: ConfigService) -> Self {
        Self {
            paths: Arc::new(paths.clone()),
            config,
        }
    }

    pub fn list_roots(&self) -> Vec<SkillRootInfo> {
        self.configured_roots()
            .into_iter()
            .map(|root| {
                let path = PathBuf::from(&root.path);
                let writable = root.enabled && fs::create_dir_all(&path).is_ok();
                SkillRootInfo {
                    path: root.path,
                    enabled: root.enabled,
                    label: root.label,
                    writable,
                }
            })
            .collect()
    }

    pub fn list_all(&self) -> Vec<AgentSkillSummary> {
        let mut seen = HashSet::new();
        let mut skills = Vec::new();

        for root in self
            .configured_roots()
            .into_iter()
            .filter(|root| root.enabled)
        {
            let root_path = PathBuf::from(&root.path);
            let writable = fs::create_dir_all(&root_path).is_ok();
            let entries = match fs::read_dir(&root_path) {
                Ok(entries) => entries,
                Err(_) => continue,
            };

            for entry in entries.filter_map(Result::ok) {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let Some(id) = path.file_name().and_then(|value| value.to_str()) else {
                    continue;
                };
                if !seen.insert(id.to_string()) {
                    continue;
                }
                if let Some(summary) = self
                    .load_skill_summary(&path, &root, writable)
                    .ok()
                    .flatten()
                {
                    skills.push(summary);
                }
            }
        }

        skills.sort_by(|left, right| {
            left.name
                .cmp(&right.name)
                .then_with(|| left.id.cmp(&right.id))
        });
        skills
    }

    pub fn get(&self, skill_id: &str) -> Option<AgentSkillPackage> {
        self.find_skill_path(skill_id)
            .and_then(|(path, root, writable)| self.load_skill_package(&path, &root, writable).ok())
            .flatten()
    }

    pub fn choose_skill(
        &self,
        requested_skill_id: Option<&str>,
        user_input: &str,
    ) -> Option<AgentSkillSummary> {
        let requested_skill_id = requested_skill_id
            .map(str::trim)
            .filter(|value| !value.is_empty());

        if let Some(skill_id) = requested_skill_id {
            if let Some(skill) = self.get(skill_id).filter(|skill| skill.summary.valid) {
                return Some(skill.summary);
            }
        }

        let query = user_input.to_lowercase();
        let mut ranked = self
            .list_all()
            .into_iter()
            .filter(|skill| skill.valid)
            .map(|skill| {
                let score = score_skill_summary(&skill, &query);
                (skill, score)
            })
            .collect::<Vec<_>>();
        ranked.sort_by(|left, right| {
            right
                .1
                .cmp(&left.1)
                .then_with(|| left.0.name.cmp(&right.0.name))
                .then_with(|| left.0.id.cmp(&right.0.id))
        });
        ranked.into_iter().next().map(|(skill, _)| skill)
    }

    pub fn save_package(
        &self,
        request: AgentSkillSaveRequest,
    ) -> Result<AgentSkillPackage, ApiError> {
        let target_root = if let Some(root_path) = request.root_path.as_deref() {
            let root = self
                .configured_roots()
                .into_iter()
                .find(|root| root.path == root_path && root.enabled)
                .ok_or_else(|| {
                    ApiError::BadRequest("Selected skill root is not enabled".to_string())
                })?;
            PathBuf::from(root.path)
        } else if let Some(existing) = self.find_skill_path(&request.id) {
            existing.0.parent().map(Path::to_path_buf).ok_or_else(|| {
                ApiError::BadRequest("Existing skill package path is invalid".to_string())
            })?
        } else {
            self.first_writable_root()?
        };

        let target_dir = target_root.join(&request.id);
        fs::create_dir_all(&target_dir).map_err(ApiError::internal)?;
        validate_skill_markdown(&request.skill_markdown)?;

        fs::write(
            target_dir.join("SKILL.md"),
            request.skill_markdown.as_bytes(),
        )
        .map_err(ApiError::internal)?;
        write_optional_text_file(
            target_dir.join("agents").join("openai.yaml"),
            request.openai_yaml.as_deref(),
        )?;
        write_skill_files(&target_dir, "references", &request.references)?;
        write_skill_files(&target_dir, "scripts", &request.scripts)?;
        write_skill_files(&target_dir, "assets", &request.assets)?;
        write_other_files(&target_dir, &request.other_files)?;

        let root = SkillRootConfig {
            path: target_root.to_string_lossy().to_string(),
            enabled: true,
            label: self
                .configured_roots()
                .into_iter()
                .find(|item| item.path == target_root.to_string_lossy())
                .and_then(|item| item.label),
        };
        self.load_skill_package(&target_dir, &root, true)?
            .ok_or_else(|| {
                ApiError::Internal("Saved skill package could not be reloaded".to_string())
            })
    }

    pub fn delete(&self, skill_id: &str) -> Result<bool, ApiError> {
        let Some((path, _, _)) = self.find_skill_path(skill_id) else {
            return Ok(false);
        };
        fs::remove_dir_all(path).map_err(ApiError::internal)?;
        Ok(true)
    }

    pub fn export_bundle(&self) -> SkillExportBundle {
        SkillExportBundle {
            roots: self.configured_roots(),
            skills: self
                .list_all()
                .into_iter()
                .filter_map(|skill| self.get(&skill.id))
                .collect(),
        }
    }

    pub fn import_bundle(&self, bundle: &SkillExportBundle) -> Result<(), ApiError> {
        self.save_roots(&bundle.roots)?;
        let roots = if bundle.roots.is_empty() {
            self.configured_roots()
        } else {
            bundle.roots.clone()
        };
        let target_root = roots
            .into_iter()
            .find(|root| root.enabled)
            .map(|root| PathBuf::from(root.path))
            .ok_or_else(|| {
                ApiError::BadRequest("No enabled Agent Skills root is configured".to_string())
            })?;

        for skill in &bundle.skills {
            self.save_package(AgentSkillSaveRequest {
                id: skill.summary.id.clone(),
                root_path: Some(target_root.to_string_lossy().to_string()),
                skill_markdown: skill.skill_markdown.clone(),
                openai_yaml: skill.openai_yaml.clone(),
                references: skill.references.clone(),
                scripts: skill.scripts.clone(),
                assets: skill.assets.clone(),
                other_files: skill.other_files.clone(),
            })?;
        }

        Ok(())
    }

    pub fn save_roots(&self, roots: &[SkillRootConfig]) -> Result<(), ApiError> {
        let mut config = self.config.load_config()?;
        let root = config
            .as_object_mut()
            .ok_or_else(|| ApiError::BadRequest("Invalid config root".to_string()))?;
        let agent_skills = ensure_object(root, "agent_skills");
        agent_skills.insert(
            "roots".to_string(),
            serde_json::to_value(roots).map_err(ApiError::internal)?,
        );
        self.config.update_config(config, false)
    }

    fn configured_roots(&self) -> Vec<SkillRootConfig> {
        let config = self.config.load_config().unwrap_or(Value::Null);
        let Some(root) = config.as_object() else {
            return self.default_roots();
        };
        let Some(agent_skills) = root.get("agent_skills").and_then(|value| value.as_object())
        else {
            return self.default_roots();
        };
        let Some(roots) = agent_skills.get("roots").and_then(|value| value.as_array()) else {
            return self.default_roots();
        };

        let parsed = roots
            .iter()
            .filter_map(|value| serde_json::from_value::<SkillRootConfig>(value.clone()).ok())
            .filter(|root| !root.path.trim().is_empty())
            .collect::<Vec<_>>();
        if parsed.is_empty() {
            self.default_roots()
        } else {
            parsed
        }
    }

    fn default_roots(&self) -> Vec<SkillRootConfig> {
        vec![
            SkillRootConfig {
                path: self
                    .paths
                    .project_root
                    .join(".agents")
                    .join("skills")
                    .to_string_lossy()
                    .to_string(),
                enabled: true,
                label: Some("Project Skills".to_string()),
            },
            SkillRootConfig {
                path: self
                    .paths
                    .user_data_dir
                    .join("skills")
                    .to_string_lossy()
                    .to_string(),
                enabled: true,
                label: Some("User Skills".to_string()),
            },
        ]
    }

    fn first_writable_root(&self) -> Result<PathBuf, ApiError> {
        for root in self
            .configured_roots()
            .into_iter()
            .filter(|root| root.enabled)
        {
            let path = PathBuf::from(&root.path);
            if fs::create_dir_all(&path).is_ok() {
                return Ok(path);
            }
        }
        Err(ApiError::BadRequest(
            "No writable Agent Skills root is configured".to_string(),
        ))
    }

    fn find_skill_path(&self, skill_id: &str) -> Option<(PathBuf, SkillRootConfig, bool)> {
        for root in self
            .configured_roots()
            .into_iter()
            .filter(|root| root.enabled)
        {
            let path = PathBuf::from(&root.path).join(skill_id);
            if path.is_dir() {
                let writable = fs::create_dir_all(path.parent().unwrap_or(path.as_path())).is_ok();
                return Some((path, root, writable));
            }
        }
        None
    }

    fn load_skill_summary(
        &self,
        package_dir: &Path,
        root: &SkillRootConfig,
        writable: bool,
    ) -> Result<Option<AgentSkillSummary>, ApiError> {
        let Some(package) = self.load_skill_package(package_dir, root, writable)? else {
            return Ok(None);
        };
        Ok(Some(package.summary))
    }

    fn load_skill_package(
        &self,
        package_dir: &Path,
        root: &SkillRootConfig,
        writable: bool,
    ) -> Result<Option<AgentSkillPackage>, ApiError> {
        let skill_path = package_dir.join("SKILL.md");
        if !skill_path.exists() {
            return Ok(None);
        }

        let skill_markdown = fs::read_to_string(&skill_path).map_err(ApiError::internal)?;
        let parsed = parse_skill_markdown(&skill_markdown);
        let mut warnings = Vec::new();
        let (name, description, metadata, skill_body, valid) = match parsed {
            Ok(parsed) => (
                parsed.name,
                parsed.description,
                parsed.metadata,
                parsed.body,
                true,
            ),
            Err(err) => {
                warnings.push(err.to_string());
                (
                    package_dir
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("invalid-skill")
                        .to_string(),
                    "Invalid SKILL.md frontmatter".to_string(),
                    Value::Object(Map::new()),
                    String::new(),
                    false,
                )
            }
        };

        let openai_yaml_path = package_dir.join("agents").join("openai.yaml");
        let openai_yaml = fs::read_to_string(&openai_yaml_path).ok();
        let (display_name, short_description) =
            parse_openai_yaml_summary(openai_yaml.as_deref()).unwrap_or_default();

        let references = collect_skill_files(package_dir, "references")?;
        let scripts = collect_skill_files(package_dir, "scripts")?;
        let assets = collect_skill_files(package_dir, "assets")?;
        let other_files = collect_other_files(package_dir)?;

        let summary = AgentSkillSummary {
            id: package_dir
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_string(),
            name,
            description,
            package_dir: package_dir.to_string_lossy().to_string(),
            root_path: root.path.clone(),
            root_label: root.label.clone(),
            metadata,
            display_name,
            short_description,
            valid,
            writable,
            warnings,
        };

        Ok(Some(AgentSkillPackage {
            summary,
            skill_markdown,
            skill_body,
            openai_yaml,
            references,
            scripts,
            assets,
            other_files,
        }))
    }
}

fn default_true() -> bool {
    true
}

fn default_utf8_encoding() -> String {
    "utf8".to_string()
}

fn ensure_object<'a>(root: &'a mut Map<String, Value>, key: &str) -> &'a mut Map<String, Value> {
    let value = root
        .entry(key.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    value.as_object_mut().expect("object ensured")
}

fn validate_skill_markdown(markdown: &str) -> Result<(), ApiError> {
    parse_skill_markdown(markdown)
        .map(|_| ())
        .map_err(|err| ApiError::BadRequest(format!("Invalid SKILL.md content: {}", err)))
}

struct ParsedSkillMarkdown {
    name: String,
    description: String,
    metadata: Value,
    body: String,
}

fn parse_skill_markdown(markdown: &str) -> Result<ParsedSkillMarkdown, ApiError> {
    let (frontmatter, body) = split_frontmatter(markdown).ok_or_else(|| {
        ApiError::BadRequest("SKILL.md must start with YAML frontmatter".to_string())
    })?;
    let yaml_value: serde_yaml::Value =
        serde_yaml::from_str(&frontmatter).map_err(ApiError::internal)?;
    let metadata = serde_json::to_value(yaml_value).map_err(ApiError::internal)?;
    let object = metadata.as_object().ok_or_else(|| {
        ApiError::BadRequest("SKILL.md frontmatter must be a mapping".to_string())
    })?;
    let name = object
        .get("name")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::BadRequest("SKILL.md frontmatter requires 'name'".to_string()))?
        .to_string();
    let description = object
        .get("description")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ApiError::BadRequest("SKILL.md frontmatter requires 'description'".to_string())
        })?
        .to_string();

    Ok(ParsedSkillMarkdown {
        name,
        description,
        metadata,
        body,
    })
}

fn split_frontmatter(markdown: &str) -> Option<(String, String)> {
    let normalized = markdown.replace("\r\n", "\n");
    let mut lines = normalized.lines();
    if lines.next()? != "---" {
        return None;
    }

    let mut frontmatter = Vec::new();
    let mut body = Vec::new();
    let mut in_frontmatter = true;
    for line in lines {
        if in_frontmatter && line == "---" {
            in_frontmatter = false;
            continue;
        }
        if in_frontmatter {
            frontmatter.push(line);
        } else {
            body.push(line);
        }
    }

    if in_frontmatter {
        return None;
    }

    Some((frontmatter.join("\n"), body.join("\n").trim().to_string()))
}

fn parse_openai_yaml_summary(
    input: Option<&str>,
) -> Result<(Option<String>, Option<String>), ApiError> {
    let Some(input) = input else {
        return Ok((None, None));
    };
    let value: serde_yaml::Value = serde_yaml::from_str(input).map_err(ApiError::internal)?;
    let json_value = serde_json::to_value(value).map_err(ApiError::internal)?;
    let object = json_value.as_object().cloned().unwrap_or_default();
    Ok((
        object
            .get("display_name")
            .and_then(|value| value.as_str())
            .map(ToOwned::to_owned),
        object
            .get("short_description")
            .and_then(|value| value.as_str())
            .map(ToOwned::to_owned),
    ))
}

fn collect_skill_files(package_dir: &Path, folder: &str) -> Result<Vec<SkillFileEntry>, ApiError> {
    let root = package_dir.join(folder);
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    collect_files_recursive(&root, &root, folder, &mut files)?;
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

fn collect_other_files(package_dir: &Path) -> Result<Vec<SkillFileEntry>, ApiError> {
    let mut files = Vec::new();
    let entries = match fs::read_dir(package_dir) {
        Ok(entries) => entries,
        Err(err) => return Err(ApiError::internal(err)),
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if name == "SKILL.md"
            || name == "agents"
            || name == "references"
            || name == "scripts"
            || name == "assets"
        {
            continue;
        }
        if path.is_dir() {
            collect_files_recursive(&path, package_dir, "other", &mut files)?;
        } else if path.is_file() {
            files.push(read_file_entry(&path, package_dir, "other")?);
        }
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

fn collect_files_recursive(
    current: &Path,
    base: &Path,
    kind: &str,
    target: &mut Vec<SkillFileEntry>,
) -> Result<(), ApiError> {
    let entries = fs::read_dir(current).map_err(ApiError::internal)?;
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if path.is_dir() {
            collect_files_recursive(&path, base, kind, target)?;
            continue;
        }
        if path.is_file() {
            target.push(read_file_entry(&path, base, kind)?);
        }
    }
    Ok(())
}

fn read_file_entry(path: &Path, base: &Path, kind: &str) -> Result<SkillFileEntry, ApiError> {
    let bytes = fs::read(path).map_err(ApiError::internal)?;
    let relative = path
        .strip_prefix(base)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/");
    match String::from_utf8(bytes.clone()) {
        Ok(content) => Ok(SkillFileEntry {
            path: relative,
            kind: kind.to_string(),
            content,
            encoding: "utf8".to_string(),
        }),
        Err(_) => Ok(SkillFileEntry {
            path: relative,
            kind: kind.to_string(),
            content: hex::encode(bytes),
            encoding: "hex".to_string(),
        }),
    }
}

fn write_optional_text_file(path: PathBuf, content: Option<&str>) -> Result<(), ApiError> {
    if let Some(content) = content {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(ApiError::internal)?;
        }
        fs::write(path, content.as_bytes()).map_err(ApiError::internal)?;
    } else if path.exists() {
        fs::remove_file(path).map_err(ApiError::internal)?;
    }
    Ok(())
}

fn write_skill_files(
    package_dir: &Path,
    folder: &str,
    files: &[SkillFileEntry],
) -> Result<(), ApiError> {
    let root = package_dir.join(folder);
    if root.exists() {
        fs::remove_dir_all(&root).map_err(ApiError::internal)?;
    }
    if files.is_empty() {
        return Ok(());
    }
    fs::create_dir_all(&root).map_err(ApiError::internal)?;
    for file in files {
        write_file_entry(&root, file)?;
    }
    Ok(())
}

fn write_other_files(package_dir: &Path, files: &[SkillFileEntry]) -> Result<(), ApiError> {
    let existing = collect_other_files(package_dir)?
        .into_iter()
        .map(|file| package_dir.join(file.path))
        .collect::<Vec<_>>();
    for path in existing {
        if path.exists() {
            let _ = fs::remove_file(&path);
        }
    }
    for file in files {
        write_file_entry(package_dir, file)?;
    }
    Ok(())
}

fn write_file_entry(root: &Path, file: &SkillFileEntry) -> Result<(), ApiError> {
    let target = root.join(file.path.replace('/', "\\"));
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(ApiError::internal)?;
    }
    let bytes = match file.encoding.as_str() {
        "utf8" => file.content.as_bytes().to_vec(),
        "hex" => hex::decode(&file.content).map_err(ApiError::internal)?,
        other => {
            return Err(ApiError::BadRequest(format!(
                "Unsupported skill file encoding '{}'",
                other
            )))
        }
    };
    fs::write(target, bytes).map_err(ApiError::internal)
}

fn score_skill_summary(skill: &AgentSkillSummary, query: &str) -> i32 {
    let mut score = 0i32;
    let corpus = format!(
        "{} {} {} {}",
        skill.id,
        skill.name,
        skill.description,
        skill.short_description.clone().unwrap_or_default()
    )
    .to_lowercase();

    for token in query
        .split(|value: char| !value.is_alphanumeric() && value != '_' && value != '-')
        .filter(|token| token.len() >= 3)
        .take(20)
    {
        if corpus.contains(token) {
            score += 2;
        }
    }

    if let Some(tags) = skill
        .metadata
        .as_object()
        .and_then(|metadata| metadata.get("tags"))
        .and_then(|value| value.as_array())
    {
        for tag in tags.iter().filter_map(|value| value.as_str()) {
            if query.contains(&tag.to_lowercase()) {
                score += 5;
            }
        }
    }

    score
}

pub fn build_skill_resource_prompt(skill: &AgentSkillPackage) -> Option<String> {
    let mut sections = Vec::new();
    if !skill.references.is_empty() {
        sections.push(format!(
            "references: {}",
            skill
                .references
                .iter()
                .map(|file| file.path.clone())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if !skill.scripts.is_empty() {
        sections.push(format!(
            "scripts: {}",
            skill
                .scripts
                .iter()
                .map(|file| file.path.clone())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if !skill.assets.is_empty() {
        sections.push(format!(
            "assets: {}",
            skill
                .assets
                .iter()
                .map(|file| file.path.clone())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }

    if sections.is_empty() {
        return None;
    }

    Some(format!(
        "Selected Agent Skill package: {}\nPackage path: {}\nAvailable packaged resources:\n- {}",
        skill.summary.name,
        skill.summary.package_dir,
        sections.join("\n- ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup_registry(temp: &TempDir) -> SkillRegistry {
        let root = temp.path().to_path_buf();
        let paths = AppPaths {
            project_root: root.clone(),
            user_data_dir: root.join("data"),
            log_dir: root.join("data").join("logs"),
            db_path: root.join("data").join("tepora.db"),
            secrets_path: root.join("data").join("secrets.yml"),
        };
        fs::create_dir_all(paths.user_data_dir.join("skills")).unwrap();
        let config = ConfigService::new(Arc::new(paths.clone()));
        SkillRegistry::new(&paths, config)
    }

    #[test]
    fn parses_standard_skill_markdown() {
        let parsed = parse_skill_markdown(
            "---\nname: code-review\ndescription: Review code changes.\n---\n# Body\nHello",
        )
        .unwrap();
        assert_eq!(parsed.name, "code-review");
        assert_eq!(parsed.description, "Review code changes.");
        assert_eq!(parsed.body, "# Body\nHello");
    }

    #[test]
    fn loads_skill_package_from_default_root() {
        let temp = TempDir::new().unwrap();
        let registry = setup_registry(&temp);
        let skill_dir = temp
            .path()
            .join(".agents")
            .join("skills")
            .join("code-review");
        fs::create_dir_all(skill_dir.join("references")).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: code-review\ndescription: Review code changes.\n---\n# Review\n",
        )
        .unwrap();
        fs::write(skill_dir.join("references").join("guide.md"), "guide").unwrap();

        let skills = registry.list_all();
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].id, "code-review");
        let package = registry.get("code-review").unwrap();
        assert_eq!(package.references.len(), 1);
    }
}
