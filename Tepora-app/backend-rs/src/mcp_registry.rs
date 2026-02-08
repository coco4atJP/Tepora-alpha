use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use reqwest::Client;
use semver::Version;
use serde_json::Value;
use tokio::sync::RwLock;

use crate::config::AppPaths;
use crate::errors::ApiError;

const REGISTRY_API_URL: &str = "https://registry.modelcontextprotocol.io/v0.1/servers";
const CACHE_DURATION: Duration = Duration::from_secs(60 * 60);
const OFFICIAL_REGISTRY_MAX_LIMIT: usize = 100;
const DEFAULT_VERSION_FILTER: &str = "latest";

#[derive(Debug, Clone)]
pub struct McpEnvVar {
    pub name: String,
    pub description: Option<String>,
    pub is_required: bool,
    pub is_secret: bool,
    pub default: Option<String>,
}

#[derive(Debug, Clone)]
pub struct McpRegistryPackage {
    pub name: Option<String>,
    pub identifier: Option<String>,
    pub version: Option<String>,
    pub registry: Option<String>,
    pub registry_type: Option<String>,
    pub runtime_hint: Option<String>,
    pub environment_variables: Vec<McpEnvVar>,
}

impl McpRegistryPackage {
    pub fn package_name(&self) -> String {
        self.name
            .clone()
            .or_else(|| self.identifier.clone())
            .unwrap_or_default()
    }

    pub fn package_registry(&self) -> Option<String> {
        self.registry.clone().or_else(|| self.registry_type.clone())
    }
}

#[derive(Debug, Clone)]
pub struct McpRegistryServer {
    pub id: String,
    pub name: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub version: Option<String>,
    pub vendor: Option<String>,
    pub source_url: Option<String>,
    pub homepage: Option<String>,
    pub website_url: Option<String>,
    #[allow(dead_code)]
    pub license: Option<String>,
    pub packages: Vec<McpRegistryPackage>,
    pub environment_variables: Vec<McpEnvVar>,
    pub icon: Option<String>,
    pub category: Option<String>,
}

#[derive(Clone)]
pub struct McpRegistry {
    client: Client,
    seed_path: PathBuf,
    cache: std::sync::Arc<RwLock<Vec<McpRegistryServer>>>,
    cache_time: std::sync::Arc<RwLock<Option<Instant>>>,
}

impl McpRegistry {
    pub fn new(paths: &AppPaths) -> Self {
        let seed_path = resolve_seed_path(paths);
        Self {
            client: Client::new(),
            seed_path,
            cache: std::sync::Arc::new(RwLock::new(Vec::new())),
            cache_time: std::sync::Arc::new(RwLock::new(None)),
        }
    }

    pub async fn fetch_servers(
        &self,
        force_refresh: bool,
        search: Option<&str>,
        version: Option<&str>,
    ) -> Result<Vec<McpRegistryServer>, ApiError> {
        let version = version.unwrap_or(DEFAULT_VERSION_FILTER);
        if !force_refresh && version == DEFAULT_VERSION_FILTER && self.is_cache_valid().await {
            let cached = self.cache.read().await.clone();
            return Ok(search_servers_local(cached, search));
        }

        match self.fetch_from_api(search, version).await {
            Ok(mut servers) => {
                if version == DEFAULT_VERSION_FILTER {
                    self.update_cache(&servers).await;
                }
                if search.is_some() {
                    servers = search_servers_local(servers, search);
                }
                Ok(servers)
            }
            Err(_err) => {
                let servers = self.load_from_seed().await.unwrap_or_default();
                if version == DEFAULT_VERSION_FILTER {
                    self.update_cache(&servers).await;
                }
                let filtered = if search.is_some() {
                    search_servers_local(servers, search)
                } else {
                    servers
                };
                Ok(filtered)
            }
        }
    }

    pub async fn get_server_by_id(
        &self,
        server_id: &str,
    ) -> Result<Option<McpRegistryServer>, ApiError> {
        let servers = self.fetch_servers(false, None, None).await?;
        Ok(servers.into_iter().find(|s| s.id == server_id))
    }

    async fn fetch_from_api(
        &self,
        search: Option<&str>,
        version: &str,
    ) -> Result<Vec<McpRegistryServer>, ApiError> {
        let mut servers = Vec::new();
        let mut cursor: Option<String> = None;
        let mut seen: HashSet<String> = HashSet::new();

        loop {
            let mut params = Vec::new();
            params.push(("limit", OFFICIAL_REGISTRY_MAX_LIMIT.to_string()));
            params.push(("version", version.to_string()));
            if let Some(search) = search {
                params.push(("search", search.to_string()));
            }
            if let Some(cursor_value) = cursor.clone() {
                if seen.contains(&cursor_value) {
                    break;
                }
                seen.insert(cursor_value.clone());
                params.push(("cursor", cursor_value));
            }

            let response = self
                .client
                .get(REGISTRY_API_URL)
                .query(&params)
                .send()
                .await
                .map_err(ApiError::internal)?;
            let response = response.error_for_status().map_err(ApiError::internal)?;
            let data: Value = response.json().await.map_err(ApiError::internal)?;

            if let Some(items) = data.get("servers").and_then(|v| v.as_array()) {
                for item in items {
                    let server_data = item.get("server").unwrap_or(item);
                    if let Some(server) = parse_server(server_data) {
                        servers.push(server);
                    }
                }
            }

            let next_cursor = data
                .get("metadata")
                .and_then(|v| v.get("nextCursor"))
                .and_then(|v| v.as_str())
                .or_else(|| data.get("nextCursor").and_then(|v| v.as_str()));
            match next_cursor {
                Some(value) => cursor = Some(value.to_string()),
                None => break,
            }
        }

        Ok(dedupe_latest(servers))
    }

    async fn load_from_seed(&self) -> Result<Vec<McpRegistryServer>, ApiError> {
        if !self.seed_path.exists() {
            return Ok(Vec::new());
        }
        let contents = tokio::fs::read_to_string(&self.seed_path)
            .await
            .map_err(ApiError::internal)?;
        let value: Value = serde_json::from_str(&contents).map_err(ApiError::internal)?;

        let mut servers = Vec::new();

        if let Some(items) = value.get("servers").and_then(|v| v.as_array()) {
            for item in items {
                let server_data = item.get("server").unwrap_or(item);
                if let Some(server) = parse_server(server_data) {
                    servers.push(server);
                }
            }
        } else if let Some(items) = value.as_array() {
            for item in items {
                if let Some(server) = parse_server(item) {
                    servers.push(server);
                }
            }
        }

        Ok(dedupe_latest(servers))
    }

    async fn is_cache_valid(&self) -> bool {
        let cache = self.cache.read().await;
        let cache_time = self.cache_time.read().await;
        if cache.is_empty() {
            return false;
        }
        cache_time
            .as_ref()
            .map(|time| time.elapsed() < CACHE_DURATION)
            .unwrap_or(false)
    }

    async fn update_cache(&self, servers: &[McpRegistryServer]) {
        let mut cache = self.cache.write().await;
        let mut cache_time = self.cache_time.write().await;
        *cache = servers.to_vec();
        *cache_time = Some(Instant::now());
    }
}

fn resolve_seed_path(paths: &AppPaths) -> PathBuf {
    let candidate = paths
        .project_root
        .join("src")
        .join("core")
        .join("mcp")
        .join("seed.json");
    if candidate.exists() {
        return candidate;
    }
    let fallback = paths
        .project_root
        .join("core")
        .join("mcp")
        .join("seed.json");
    if fallback.exists() {
        return fallback;
    }
    paths.project_root.join("config").join("seed.json")
}

fn parse_server(data: &Value) -> Option<McpRegistryServer> {
    let server_name = get_str(data, "name")
        .or_else(|| get_str(data, "id"))
        .unwrap_or_default();
    if server_name.is_empty() {
        return None;
    }

    let server_id = get_str(data, "id").unwrap_or_else(|| server_name.clone());
    let title = get_str(data, "title");
    let description = get_str(data, "description");
    let version = get_str(data, "version");

    let packages = parse_packages(data.get("packages"));

    let mut env_vars: HashMap<String, McpEnvVar> = HashMap::new();
    if let Some(env_list) = data.get("environmentVariables").and_then(|v| v.as_array()) {
        for env in env_list {
            if let Some(parsed) = parse_env_var(env) {
                merge_env_var(&mut env_vars, parsed);
            }
        }
    }

    for pkg in &packages {
        for env in &pkg.environment_variables {
            merge_env_var(&mut env_vars, env.clone());
        }
    }

    let repository = data.get("repository");
    let source_url = get_str(data, "sourceUrl").or_else(|| {
        repository
            .and_then(|v| v.get("url"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    });

    let mut icon = get_str(data, "icon");
    if icon.is_none() {
        if let Some(icons) = data.get("icons").and_then(|v| v.as_array()) {
            if let Some(first) = icons.first() {
                icon = first
                    .get("src")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
            }
        }
    }

    let homepage = get_str(data, "homepage").or_else(|| get_str(data, "websiteUrl"));

    let display_name = title.clone().unwrap_or_else(|| server_name.clone());

    Some(McpRegistryServer {
        id: server_id,
        name: display_name,
        title,
        description,
        version,
        vendor: get_str(data, "vendor"),
        source_url,
        homepage,
        website_url: get_str(data, "websiteUrl"),
        license: get_str(data, "license"),
        packages,
        environment_variables: env_vars.into_values().collect(),
        icon,
        category: get_str(data, "category"),
    })
}

fn parse_packages(value: Option<&Value>) -> Vec<McpRegistryPackage> {
    let mut packages = Vec::new();
    let Some(items) = value.and_then(|v| v.as_array()) else {
        return packages;
    };
    for item in items {
        let registry = get_str(item, "registry");
        let registry_type = get_str(item, "registryType");
        let mut runtime_hint = get_str(item, "runtimeHint");
        if runtime_hint.is_none() {
            let source = registry_type.clone().or_else(|| registry.clone());
            runtime_hint = source.as_deref().and_then(runtime_from_registry);
        }

        let env_vars = item
            .get("environmentVariables")
            .and_then(|v| v.as_array())
            .map(|list| {
                list.iter()
                    .filter_map(parse_env_var)
                    .collect::<Vec<McpEnvVar>>()
            })
            .unwrap_or_default();

        packages.push(McpRegistryPackage {
            name: get_str(item, "name"),
            identifier: get_str(item, "identifier"),
            version: get_str(item, "version"),
            registry,
            registry_type,
            runtime_hint,
            environment_variables: env_vars,
        });
    }
    packages
}

fn runtime_from_registry(registry: &str) -> Option<String> {
    match registry {
        "npm" => Some("npx".to_string()),
        "pypi" => Some("uvx".to_string()),
        "oci" => Some("docker".to_string()),
        "nuget" => Some("dnx".to_string()),
        _ => None,
    }
}

fn parse_env_var(value: &Value) -> Option<McpEnvVar> {
    let name = get_str(value, "name")?;
    Some(McpEnvVar {
        name,
        description: get_str(value, "description"),
        is_required: value
            .get("isRequired")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        is_secret: value
            .get("isSecret")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        default: get_str(value, "default"),
    })
}

fn merge_env_var(target: &mut HashMap<String, McpEnvVar>, incoming: McpEnvVar) {
    let entry = target
        .entry(incoming.name.clone())
        .or_insert_with(|| incoming.clone());
    if entry.description.is_none() {
        entry.description = incoming.description.clone();
    }
    entry.is_required |= incoming.is_required;
    entry.is_secret |= incoming.is_secret;
    if entry.default.is_none() {
        entry.default = incoming.default.clone();
    }
}

fn get_str(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn dedupe_latest(servers: Vec<McpRegistryServer>) -> Vec<McpRegistryServer> {
    let mut latest: HashMap<String, McpRegistryServer> = HashMap::new();
    for server in servers {
        let replace = match latest.get(&server.id) {
            None => true,
            Some(existing) => should_replace(existing, &server),
        };
        if replace {
            latest.insert(server.id.clone(), server);
        }
    }
    latest.into_values().collect()
}

fn should_replace(existing: &McpRegistryServer, candidate: &McpRegistryServer) -> bool {
    let current = existing
        .version
        .as_ref()
        .and_then(|v| Version::parse(v).ok());
    let next = candidate
        .version
        .as_ref()
        .and_then(|v| Version::parse(v).ok());

    match (current, next) {
        (Some(cur), Some(next)) => next > cur,
        (None, Some(_)) => true,
        (Some(_), None) => false,
        (None, None) => false,
    }
}

fn search_servers_local(
    servers: Vec<McpRegistryServer>,
    search: Option<&str>,
) -> Vec<McpRegistryServer> {
    let Some(query) = search else {
        return servers;
    };
    let needle = query.to_lowercase();
    servers
        .into_iter()
        .filter(|server| {
            server.name.to_lowercase().contains(&needle)
                || server
                    .title
                    .as_ref()
                    .map(|v| v.to_lowercase().contains(&needle))
                    .unwrap_or(false)
                || server
                    .description
                    .as_ref()
                    .map(|v| v.to_lowercase().contains(&needle))
                    .unwrap_or(false)
                || server.id.to_lowercase().contains(&needle)
        })
        .collect()
}
