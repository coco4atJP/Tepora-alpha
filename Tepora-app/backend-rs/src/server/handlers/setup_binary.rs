use std::fs;
use std::io::Write;
use std::path::{Component, Path as FsPath, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::http::header;
use chrono::Utc;
use flate2::read::GzDecoder;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tar::Archive;
use uuid::Uuid;
use zip::ZipArchive;

use crate::core::config::AppPaths;
use crate::core::errors::ApiError;
use crate::state::AppState;

const LLAMA_RELEASE_LATEST_URL: &str =
    "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest";
const LLAMA_RELEASE_USER_AGENT: &str = "tepora-backend-rs";

#[derive(Debug, Clone, Serialize)]
pub struct BinaryUpdateInfo {
    pub has_update: bool,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub release_notes: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct GithubRelease {
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    assets: Vec<GithubReleaseAsset>,
}

#[derive(Debug, Clone, Deserialize)]
struct GithubReleaseAsset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: Option<u64>,
    #[serde(default)]
    digest: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct BinaryInstallRegistry {
    #[serde(default)]
    current_version: Option<String>,
    #[serde(default)]
    current_variant: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
}

pub async fn fetch_binary_update_info(
    paths: &AppPaths,
    requested_variant: Option<&str>,
) -> Result<BinaryUpdateInfo, ApiError> {
    let requested_variant = normalize_binary_variant(requested_variant);
    let release = fetch_latest_llama_release().await?;
    let current_version = current_binary_version_snapshot(paths);
    let has_update = select_release_asset(&release, &requested_variant)
        .map(|_| is_newer_llama_release(current_version.as_deref(), &release.tag_name))
        .unwrap_or(false);

    Ok(BinaryUpdateInfo {
        has_update,
        current_version: current_version.unwrap_or_else(|| "unknown".to_string()),
        latest_version: if has_update {
            Some(release.tag_name)
        } else {
            None
        },
        release_notes: release.body,
    })
}

pub async fn install_latest_llama_binary(
    state: Arc<AppState>,
    requested_variant: Option<&str>,
) -> Result<String, ApiError> {
    let requested_variant = normalize_binary_variant(requested_variant);

    state
        .core()
        .setup
        .update_progress("pending", 0.05, "Checking latest llama.cpp release...")?;
    let release = fetch_latest_llama_release().await?;
    let (resolved_variant, asset) =
        select_release_asset(&release, &requested_variant).ok_or_else(|| {
            ApiError::NotFound(format!(
                "No matching release asset found for variant '{}'",
                requested_variant
            ))
        })?;

    let install_root = binary_root_dir(&state.core().paths);
    let downloads_dir = binary_download_dir(&state.core().paths);
    let tmp_dir = binary_tmp_dir(&state.core().paths);
    fs::create_dir_all(&downloads_dir).map_err(ApiError::internal)?;
    fs::create_dir_all(&tmp_dir).map_err(ApiError::internal)?;

    let archive_name = FsPath::new(&asset.name)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("llama-release.bin")
        .to_string();
    let archive_path = downloads_dir.join(&archive_name);
    let partial_path = downloads_dir.join(format!("{}.part", archive_name));

    let state_for_progress = state.clone();
    let downloaded_sha = download_release_asset(&asset, &partial_path, move |progress, message| {
        let stage_progress = 0.1 + (progress * 0.6);
        let _ =
            state_for_progress
                .core()
                .setup
                .update_progress("downloading", stage_progress, message);
    })
    .await?;

    if archive_path.exists() {
        let _ = fs::remove_file(&archive_path);
    }
    fs::rename(&partial_path, &archive_path).map_err(ApiError::internal)?;

    state
        .core()
        .setup
        .update_progress("verifying", 0.75, "Verifying SHA256 digest...")?;
    let expected_sha = parse_sha256_digest(asset.digest.as_deref()).ok_or_else(|| {
        ApiError::BadRequest("Release asset is missing a valid SHA256 digest".to_string())
    })?;
    if downloaded_sha != expected_sha {
        let _ = fs::remove_file(&archive_path);
        return Err(ApiError::BadRequest(
            "SHA256 verification failed for downloaded binary".to_string(),
        ));
    }

    state
        .core()
        .setup
        .update_progress("extracting", 0.82, "Extracting archive...")?;
    let extract_dir = tmp_dir.join(format!("extract_{}", Uuid::new_v4()));
    if extract_dir.exists() {
        let _ = fs::remove_dir_all(&extract_dir);
    }
    fs::create_dir_all(&extract_dir).map_err(ApiError::internal)?;
    extract_binary_archive(&archive_path, &extract_dir)?;
    let _ = fs::remove_file(&archive_path);

    let current_dir = binary_current_dir(&state.core().paths);
    state
        .core()
        .setup
        .update_progress("extracting", 0.92, "Installing binary files...")?;
    replace_current_binary_dir(&extract_dir, &current_dir)?;

    if find_llama_server_executable(&current_dir).is_none() {
        return Err(ApiError::Internal(
            "Installed archive does not contain llama-server executable".to_string(),
        ));
    }

    fs::create_dir_all(&install_root).map_err(ApiError::internal)?;
    save_binary_registry(
        &state.core().paths,
        &BinaryInstallRegistry {
            current_version: Some(release.tag_name.clone()),
            current_variant: Some(resolved_variant),
            updated_at: Some(Utc::now().to_rfc3339()),
        },
    )?;

    state
        .core()
        .setup
        .update_progress("finalizing", 0.97, "Refreshing runtime paths...")?;
    let _ = state
        .ai()
        .llama
        .refresh_binary_path(&state.core().paths)
        .await;

    Ok(release.tag_name)
}

fn binary_root_dir(paths: &AppPaths) -> PathBuf {
    paths.user_data_dir.join("bin").join("llama.cpp")
}

fn binary_current_dir(paths: &AppPaths) -> PathBuf {
    binary_root_dir(paths).join("current")
}

fn binary_download_dir(paths: &AppPaths) -> PathBuf {
    binary_root_dir(paths).join("downloads")
}

fn binary_tmp_dir(paths: &AppPaths) -> PathBuf {
    binary_root_dir(paths).join("tmp")
}

fn binary_registry_path(paths: &AppPaths) -> PathBuf {
    binary_root_dir(paths).join("binary_registry.json")
}

fn load_binary_registry(paths: &AppPaths) -> BinaryInstallRegistry {
    let path = binary_registry_path(paths);
    let Ok(contents) = fs::read_to_string(path) else {
        return BinaryInstallRegistry::default();
    };
    serde_json::from_str::<BinaryInstallRegistry>(&contents).unwrap_or_default()
}

fn save_binary_registry(
    paths: &AppPaths,
    registry: &BinaryInstallRegistry,
) -> Result<(), ApiError> {
    let path = binary_registry_path(paths);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(ApiError::internal)?;
    }
    let serialized = serde_json::to_string_pretty(registry).map_err(ApiError::internal)?;
    fs::write(path, serialized).map_err(ApiError::internal)
}

fn current_binary_version_snapshot(paths: &AppPaths) -> Option<String> {
    let registry = load_binary_registry(paths);
    let current = registry
        .current_version
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if current.is_some() {
        return current;
    }
    let current_dir = binary_current_dir(paths);
    if find_llama_server_executable(&current_dir).is_some() {
        return Some("installed".to_string());
    }
    None
}

fn normalize_binary_variant(value: Option<&str>) -> String {
    let normalized = value.unwrap_or("auto").trim().to_ascii_lowercase();
    match normalized.as_str() {
        "auto" | "cuda-12.4" | "cuda-11.8" | "vulkan" | "cpu-avx2" | "cpu-avx" | "cpu-sse42"
        | "metal" => normalized,
        _ => "auto".to_string(),
    }
}

fn resolve_binary_variant(normalized_variant: &str) -> String {
    if normalized_variant == "auto" {
        if cfg!(target_os = "macos") {
            "metal".to_string()
        } else {
            "cpu-avx2".to_string()
        }
    } else {
        normalized_variant.to_string()
    }
}

fn release_asset_patterns(normalized_variant: &str) -> Vec<String> {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    match os {
        "macos" => match normalized_variant {
            "metal" | "auto" => {
                if arch == "aarch64" {
                    vec!["macos-arm64.tar.gz".to_string()]
                } else {
                    vec!["macos-x64.tar.gz".to_string()]
                }
            }
            _ => vec!["macos-x64.tar.gz".to_string()],
        },
        "windows" => match normalized_variant {
            "cuda-12.4" => vec!["win-cuda-12.4-x64.zip".to_string()],
            "cuda-11.8" => vec!["win-cuda-cu11".to_string(), "win-cuda-11.".to_string()],
            "vulkan" => vec!["win-vulkan-x64.zip".to_string()],
            "cpu-avx2" | "cpu-avx" | "cpu-sse42" => vec!["win-cpu-x64.zip".to_string()],
            _ => {
                if arch == "aarch64" {
                    vec!["win-cpu-arm64.zip".to_string()]
                } else {
                    vec!["win-cpu-x64.zip".to_string()]
                }
            }
        },
        _ => match normalized_variant {
            "cuda-12.4" => vec!["linux-cuda-12.4-x64.tar.gz".to_string()],
            "cuda-11.8" => vec!["linux-cuda-11.".to_string()],
            "vulkan" => vec!["ubuntu-vulkan-x64.tar.gz".to_string()],
            _ => {
                if arch == "aarch64" {
                    vec![
                        "ubuntu-arm64.tar.gz".to_string(),
                        "ubuntu-x64.tar.gz".to_string(),
                        "ubuntu-22.04-arm64.tar.gz".to_string(),
                    ]
                } else {
                    vec![
                        "ubuntu-x64.tar.gz".to_string(),
                        "ubuntu-22.04-x64.tar.gz".to_string(),
                    ]
                }
            }
        },
    }
}

fn select_release_asset(
    release: &GithubRelease,
    requested_variant: &str,
) -> Option<(String, GithubReleaseAsset)> {
    let normalized_variant = normalize_binary_variant(Some(requested_variant));
    let patterns = release_asset_patterns(&normalized_variant);
    for asset in &release.assets {
        let name = asset.name.to_ascii_lowercase();
        if patterns.iter().any(|pattern| name.contains(pattern)) {
            return Some((resolve_binary_variant(&normalized_variant), asset.clone()));
        }
    }
    None
}

fn parse_llama_build_number(version: &str) -> Option<u64> {
    let trimmed = version.trim();
    if trimmed.is_empty() {
        return None;
    }
    let number = trimmed
        .strip_prefix('b')
        .or_else(|| trimmed.strip_prefix('B'))
        .unwrap_or(trimmed);
    if number.chars().all(|c| c.is_ascii_digit()) {
        return number.parse::<u64>().ok();
    }
    None
}

fn is_newer_llama_release(current: Option<&str>, latest: &str) -> bool {
    let latest_num = parse_llama_build_number(latest);
    let current_num = current.and_then(parse_llama_build_number);
    match (current_num, latest_num) {
        (Some(current), Some(latest)) => latest > current,
        _ => current
            .map(|value| value.trim() != latest.trim())
            .unwrap_or(true),
    }
}

fn parse_sha256_digest(digest: Option<&str>) -> Option<String> {
    let raw = digest?.trim();
    if let Some(value) = raw.strip_prefix("sha256:") {
        return normalize_sha256_hex(value);
    }
    normalize_sha256_hex(raw)
}

fn normalize_sha256_hex(value: &str) -> Option<String> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.len() == 64 && normalized.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Some(normalized);
    }
    None
}

async fn fetch_latest_llama_release() -> Result<GithubRelease, ApiError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(ApiError::internal)?;
    let response = client
        .get(LLAMA_RELEASE_LATEST_URL)
        .header(header::ACCEPT, "application/vnd.github+json")
        .header(header::USER_AGENT, LLAMA_RELEASE_USER_AGENT)
        .send()
        .await
        .map_err(ApiError::internal)?
        .error_for_status()
        .map_err(ApiError::internal)?;
    response
        .json::<GithubRelease>()
        .await
        .map_err(ApiError::internal)
}

async fn download_release_asset(
    asset: &GithubReleaseAsset,
    target_path: &FsPath,
    mut progress_cb: impl FnMut(f32, &str),
) -> Result<String, ApiError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(ApiError::internal)?;
    let response = client
        .get(&asset.browser_download_url)
        .header(header::ACCEPT, "application/octet-stream")
        .header(header::USER_AGENT, LLAMA_RELEASE_USER_AGENT)
        .send()
        .await
        .map_err(ApiError::internal)?
        .error_for_status()
        .map_err(ApiError::internal)?;

    let total = response.content_length().or(asset.size).unwrap_or(0);
    let mut stream = response.bytes_stream();
    let mut file = fs::File::create(target_path).map_err(ApiError::internal)?;
    let mut downloaded: u64 = 0;
    let mut hasher = Sha256::new();

    while let Some(chunk) = stream.next().await {
        let data = chunk.map_err(ApiError::internal)?;
        file.write_all(&data).map_err(ApiError::internal)?;
        hasher.update(&data);
        downloaded += data.len() as u64;
        let progress = if total > 0 {
            downloaded as f32 / total as f32
        } else {
            0.0
        };
        let message = if total > 0 {
            format!(
                "Downloading binary... {:.1} MB / {:.1} MB",
                downloaded as f64 / (1024_f64 * 1024_f64),
                total as f64 / (1024_f64 * 1024_f64)
            )
        } else {
            "Downloading binary...".to_string()
        };
        progress_cb(progress, &message);
    }

    Ok(hex::encode(hasher.finalize()))
}

fn normalize_archive_member_path(raw: &FsPath) -> Option<PathBuf> {
    let mut normalized = PathBuf::new();
    for component in raw.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => normalized.push(part),
            Component::RootDir | Component::ParentDir | Component::Prefix(_) => return None,
        }
    }
    if normalized.as_os_str().is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn extract_zip_archive(archive_path: &FsPath, destination: &FsPath) -> Result<(), ApiError> {
    let file = fs::File::open(archive_path).map_err(ApiError::internal)?;
    let mut zip = ZipArchive::new(file).map_err(ApiError::internal)?;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(ApiError::internal)?;
        let Some(relative) = entry.enclosed_name() else {
            return Err(ApiError::BadRequest(format!(
                "Unsafe archive entry: {}",
                entry.name()
            )));
        };
        if relative.as_os_str().is_empty() {
            continue;
        }
        let target = destination.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(ApiError::internal)?;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(ApiError::internal)?;
            }
            let mut outfile = fs::File::create(&target).map_err(ApiError::internal)?;
            std::io::copy(&mut entry, &mut outfile).map_err(ApiError::internal)?;
        }
    }
    Ok(())
}

fn extract_tar_gz_archive(archive_path: &FsPath, destination: &FsPath) -> Result<(), ApiError> {
    let file = fs::File::open(archive_path).map_err(ApiError::internal)?;
    let decoder = GzDecoder::new(file);
    let mut archive = Archive::new(decoder);
    for item in archive.entries().map_err(ApiError::internal)? {
        let mut entry = item.map_err(ApiError::internal)?;
        let raw_path = entry.path().map_err(ApiError::internal)?.into_owned();
        let Some(relative) = normalize_archive_member_path(&raw_path) else {
            return Err(ApiError::BadRequest(format!(
                "Unsafe archive entry: {}",
                raw_path.to_string_lossy()
            )));
        };
        let target = destination.join(relative);
        let entry_type = entry.header().entry_type();
        if entry_type.is_symlink() || entry_type.is_hard_link() {
            return Err(ApiError::BadRequest(
                "Unsupported archive symlink entry".to_string(),
            ));
        }
        if entry_type.is_dir() {
            fs::create_dir_all(&target).map_err(ApiError::internal)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(ApiError::internal)?;
        }
        entry.unpack(&target).map_err(ApiError::internal)?;
    }
    Ok(())
}

fn find_llama_server_executable(root: &FsPath) -> Option<PathBuf> {
    let exe_name = if cfg!(target_os = "windows") {
        "llama-server.exe"
    } else {
        "llama-server"
    };
    if !root.exists() {
        return None;
    }
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.file_name().and_then(|name| name.to_str()) == Some(exe_name) {
                return Some(path);
            }
        }
    }
    None
}

fn copy_dir_recursive(source: &FsPath, destination: &FsPath) -> Result<(), ApiError> {
    fs::create_dir_all(destination).map_err(ApiError::internal)?;
    for item in fs::read_dir(source).map_err(ApiError::internal)? {
        let entry = item.map_err(ApiError::internal)?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if source_path.is_dir() {
            copy_dir_recursive(&source_path, &destination_path)?;
        } else {
            if let Some(parent) = destination_path.parent() {
                fs::create_dir_all(parent).map_err(ApiError::internal)?;
            }
            fs::copy(&source_path, &destination_path).map_err(ApiError::internal)?;
        }
    }
    Ok(())
}

fn replace_current_binary_dir(source: &FsPath, current_dir: &FsPath) -> Result<(), ApiError> {
    if current_dir.exists() {
        fs::remove_dir_all(current_dir).map_err(ApiError::internal)?;
    }

    match fs::rename(source, current_dir) {
        Ok(_) => Ok(()),
        Err(_) => {
            copy_dir_recursive(source, current_dir)?;
            fs::remove_dir_all(source).map_err(ApiError::internal)?;
            Ok(())
        }
    }
}

fn is_zip_archive(path: &FsPath) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.to_ascii_lowercase().ends_with(".zip"))
        .unwrap_or(false)
}

fn is_tar_gz_archive(path: &FsPath) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| {
            let lower = name.to_ascii_lowercase();
            lower.ends_with(".tar.gz") || lower.ends_with(".tgz")
        })
        .unwrap_or(false)
}

fn extract_binary_archive(archive_path: &FsPath, destination: &FsPath) -> Result<(), ApiError> {
    if is_zip_archive(archive_path) {
        return extract_zip_archive(archive_path, destination);
    }
    if is_tar_gz_archive(archive_path) {
        return extract_tar_gz_archive(archive_path, destination);
    }
    Err(ApiError::BadRequest(format!(
        "Unsupported archive format: {}",
        archive_path.display()
    )))
}

#[cfg(test)]
mod tests {
    use super::{is_newer_llama_release, normalize_binary_variant, parse_sha256_digest};

    #[test]
    fn normalize_binary_variant_defaults_unknown_values_to_auto() {
        assert_eq!(normalize_binary_variant(Some("metal")), "metal");
        assert_eq!(normalize_binary_variant(Some("CUDA-12.4")), "cuda-12.4");
        assert_eq!(normalize_binary_variant(Some("weird")), "auto");
        assert_eq!(normalize_binary_variant(None), "auto");
    }

    #[test]
    fn parse_sha256_digest_accepts_prefixed_values() {
        let digest = "a".repeat(64);
        assert_eq!(
            parse_sha256_digest(Some(&format!("sha256:{digest}"))),
            Some(digest.clone())
        );
        assert_eq!(parse_sha256_digest(Some("invalid")), None);
    }

    #[test]
    fn newer_release_prefers_build_number_comparison() {
        assert!(is_newer_llama_release(Some("b1200"), "b1201"));
        assert!(!is_newer_llama_release(Some("b1201"), "b1200"));
        assert!(is_newer_llama_release(Some("installed"), "b1200"));
    }
}
