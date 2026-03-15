use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::Path;

use serde_json::Value;

use crate::core::errors::ApiError;

use super::types::OllamaModelDetails;

pub(crate) fn has_embedding_name_hint(name: &str) -> bool {
    const EMBEDDING_NAME_HINTS: &[&str] =
        &["embedding", "embed", "nomic-embed", "e5", "bge", "gte"];
    let lowered = name.to_ascii_lowercase();
    EMBEDDING_NAME_HINTS
        .iter()
        .any(|hint| lowered.contains(hint))
}

pub(crate) fn extract_architecture_from_model_info(
    model_info: Option<&HashMap<String, Value>>,
) -> Option<String> {
    model_info
        .and_then(|info| info.get("general.architecture"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

pub(crate) fn infer_role_from_gguf_metadata(
    model_name: &str,
    model_info: &HashMap<String, Value>,
) -> Option<String> {
    if let Some(general_type) = model_info
        .get("general.type")
        .and_then(|v| v.as_str())
        .map(|s| s.to_ascii_lowercase())
    {
        if general_type.contains("embedding") || general_type.contains("embed") {
            return Some("embedding".to_string());
        }
        if general_type.contains("text") || general_type.contains("causal") {
            return Some("text".to_string());
        }
    }

    let has_embedding_pooling = model_info.iter().any(|(k, v)| {
        if !k.ends_with(".pooling_type") {
            return false;
        }
        v.as_u64().is_some_and(|n| n > 0)
            || v.as_i64().is_some_and(|n| n > 0)
            || v.as_str()
                .map(|s| {
                    let lowered = s.to_ascii_lowercase();
                    lowered.contains("mean") || lowered.contains("cls") || lowered.contains("last")
                })
                .unwrap_or(false)
    });
    if has_embedding_pooling {
        return Some("embedding".to_string());
    }

    let has_text_decoder_hint = model_info
        .keys()
        .any(|k| k.ends_with(".block_count") || k.contains("attention.head_count"));
    if has_text_decoder_hint {
        return Some("text".to_string());
    }

    if has_embedding_name_hint(model_name) {
        return Some("embedding".to_string());
    }

    None
}

pub(crate) fn determine_ollama_role(
    model_name: &str,
    details: &OllamaModelDetails,
    capabilities: Option<&[String]>,
    model_info: Option<&HashMap<String, Value>>,
) -> String {
    const EMBEDDING_FAMILIES: &[&str] = &["bert", "nomic-bert", "clip"];
    const EMBEDDING_CAPABILITY_HINTS: &[&str] = &["embedding", "embed"];
    const TEXT_CAPABILITY_HINTS: &[&str] = &["completion", "chat", "generate"];

    if let Some(role) = model_info.and_then(|info| infer_role_from_gguf_metadata(model_name, info))
    {
        return role;
    }

    let family = details.family.as_deref().unwrap_or("").to_ascii_lowercase();
    let families = details.families.as_deref().unwrap_or(&[]);

    let is_embedding_by_family = EMBEDDING_FAMILIES
        .iter()
        .any(|&ef| family == ef || families.iter().any(|f| f.to_ascii_lowercase() == ef));

    let has_embedding_capability = capabilities
        .map(|caps| {
            caps.iter().any(|cap| {
                let cap = cap.to_ascii_lowercase();
                EMBEDDING_CAPABILITY_HINTS
                    .iter()
                    .any(|hint| cap.contains(hint))
            })
        })
        .unwrap_or(true);
    let has_text_capability = capabilities
        .map(|caps| {
            caps.iter().any(|cap| {
                let cap = cap.to_ascii_lowercase();
                TEXT_CAPABILITY_HINTS.iter().any(|hint| cap.contains(hint))
            })
        })
        .unwrap_or(true);

    if is_embedding_by_family || has_embedding_capability {
        "embedding".to_string()
    } else if has_text_capability {
        "text".to_string()
    } else if has_embedding_name_hint(model_name) {
        "embedding".to_string()
    } else {
        "text".to_string()
    }
}

pub(crate) fn read_gguf_metadata(path: &Path) -> Result<HashMap<String, Value>, ApiError> {
    let mut file = fs::File::open(path).map_err(ApiError::internal)?;
    let mut magic = [0u8; 4];
    file.read_exact(&mut magic).map_err(ApiError::internal)?;
    if &magic != b"GGUF" {
        return Err(ApiError::BadRequest(
            "Invalid GGUF magic header".to_string(),
        ));
    }

    let version = read_u32_le(&mut file)?;
    if !(1..=3).contains(&version) {
        return Err(ApiError::BadRequest(format!(
            "Unsupported GGUF version: {}",
            version
        )));
    }

    let _ = read_gguf_count(&mut file, version)?;
    let kv_count = read_gguf_count(&mut file, version)?;

    let mut model_info = HashMap::new();
    for _ in 0..kv_count {
        let key = read_gguf_string(&mut file, version)?;
        let value_type = read_u32_le(&mut file)?;
        let value = read_gguf_value(&mut file, version, value_type)?;
        model_info.insert(key, value);
    }

    Ok(model_info)
}

fn read_gguf_count<R: Read>(reader: &mut R, version: u32) -> Result<u64, ApiError> {
    if version == 1 {
        Ok(read_u32_le(reader)? as u64)
    } else {
        read_u64_le(reader)
    }
}

fn read_gguf_string<R: Read>(reader: &mut R, version: u32) -> Result<String, ApiError> {
    let len = read_gguf_count(reader, version)?;
    if len > 1_000_000 {
        return Err(ApiError::BadRequest(
            "GGUF string length is too large".to_string(),
        ));
    }
    let mut buf = vec![0u8; len as usize];
    reader.read_exact(&mut buf).map_err(ApiError::internal)?;
    String::from_utf8(buf).map_err(ApiError::internal)
}

fn read_gguf_value<R: Read>(
    reader: &mut R,
    version: u32,
    value_type: u32,
) -> Result<Value, ApiError> {
    match value_type {
        0 => Ok(Value::from(read_u8_le(reader)?)),
        1 => Ok(Value::from(read_i8_le(reader)?)),
        2 => Ok(Value::from(read_u16_le(reader)?)),
        3 => Ok(Value::from(read_i16_le(reader)?)),
        4 => Ok(Value::from(read_u32_le(reader)?)),
        5 => Ok(Value::from(read_i32_le(reader)?)),
        6 => Ok(serde_json::Number::from_f64(read_f32_le(reader)? as f64)
            .map(Value::Number)
            .unwrap_or(Value::Null)),
        7 => Ok(Value::Bool(read_u8_le(reader)? != 0)),
        8 => Ok(Value::String(read_gguf_string(reader, version)?)),
        9 => {
            let array_type = read_u32_le(reader)?;
            let len = read_gguf_count(reader, version)?;
            if len > 100_000 {
                return Err(ApiError::BadRequest(
                    "GGUF array length is too large".to_string(),
                ));
            }
            let mut values = Vec::with_capacity(len as usize);
            for _ in 0..len {
                values.push(read_gguf_value(reader, version, array_type)?);
            }
            Ok(Value::Array(values))
        }
        10 => Ok(Value::from(read_u64_le(reader)?)),
        11 => Ok(Value::from(read_i64_le(reader)?)),
        12 => Ok(serde_json::Number::from_f64(read_f64_le(reader)?)
            .map(Value::Number)
            .unwrap_or(Value::Null)),
        other => Err(ApiError::BadRequest(format!(
            "Unsupported GGUF value type: {}",
            other
        ))),
    }
}

fn read_u8_le<R: Read>(reader: &mut R) -> Result<u8, ApiError> {
    let mut buf = [0u8; 1];
    reader.read_exact(&mut buf).map_err(ApiError::internal)?;
    Ok(buf[0])
}

fn read_i8_le<R: Read>(reader: &mut R) -> Result<i8, ApiError> {
    Ok(read_u8_le(reader)? as i8)
}

fn read_u16_le<R: Read>(reader: &mut R) -> Result<u16, ApiError> {
    let mut buf = [0u8; 2];
    reader.read_exact(&mut buf).map_err(ApiError::internal)?;
    Ok(u16::from_le_bytes(buf))
}

fn read_i16_le<R: Read>(reader: &mut R) -> Result<i16, ApiError> {
    let mut buf = [0u8; 2];
    reader.read_exact(&mut buf).map_err(ApiError::internal)?;
    Ok(i16::from_le_bytes(buf))
}

fn read_u32_le<R: Read>(reader: &mut R) -> Result<u32, ApiError> {
    let mut buf = [0u8; 4];
    reader.read_exact(&mut buf).map_err(ApiError::internal)?;
    Ok(u32::from_le_bytes(buf))
}

fn read_i32_le<R: Read>(reader: &mut R) -> Result<i32, ApiError> {
    let mut buf = [0u8; 4];
    reader.read_exact(&mut buf).map_err(ApiError::internal)?;
    Ok(i32::from_le_bytes(buf))
}

fn read_u64_le<R: Read>(reader: &mut R) -> Result<u64, ApiError> {
    let mut buf = [0u8; 8];
    reader.read_exact(&mut buf).map_err(ApiError::internal)?;
    Ok(u64::from_le_bytes(buf))
}

fn read_i64_le<R: Read>(reader: &mut R) -> Result<i64, ApiError> {
    let mut buf = [0u8; 8];
    reader.read_exact(&mut buf).map_err(ApiError::internal)?;
    Ok(i64::from_le_bytes(buf))
}

fn read_f32_le<R: Read>(reader: &mut R) -> Result<f32, ApiError> {
    let mut buf = [0u8; 4];
    reader.read_exact(&mut buf).map_err(ApiError::internal)?;
    Ok(f32::from_le_bytes(buf))
}

fn read_f64_le<R: Read>(reader: &mut R) -> Result<f64, ApiError> {
    let mut buf = [0u8; 8];
    reader.read_exact(&mut buf).map_err(ApiError::internal)?;
    Ok(f64::from_le_bytes(buf))
}

pub(crate) fn parse_ollama_parameters(parameters: &str) -> (Option<Vec<String>>, Option<f32>) {
    let mut stop_tokens: Vec<String> = Vec::new();
    let mut temperature: Option<f32> = None;

    for line in parameters.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        if let Some(rest) = line.strip_prefix("stop") {
            let value = rest.trim().trim_matches('"').to_string();
            if !value.is_empty() {
                stop_tokens.push(value);
            }
        } else if let Some(rest) = line.strip_prefix("temperature") {
            if let Ok(t) = rest.trim().parse::<f32>() {
                temperature = Some(t);
            }
        }
    }

    let stop_tokens = if stop_tokens.is_empty() {
        None
    } else {
        Some(stop_tokens)
    };

    (stop_tokens, temperature)
}

pub(crate) fn extract_context_length(
    model_info: Option<&HashMap<String, Value>>,
    architecture: Option<&str>,
) -> Option<u64> {
    let info = model_info?;

    if let Some(arch) = architecture {
        let key = format!("{}.context_length", arch);
        if let Some(v) = info.get(&key).and_then(|v| v.as_u64()) {
            return Some(v);
        }
    }

    info.iter()
        .filter(|(k, _)| k.contains("context_length"))
        .find_map(|(_, v)| v.as_u64())
}

pub(crate) fn sanitize_model_filename(filename: &str) -> Option<&str> {
    if filename.is_empty()
        || filename.contains("..")
        || filename.contains('/')
        || filename.contains('\\')
        || has_windows_drive_prefix(filename)
        || filename.starts_with("//")
        || filename.starts_with("\\\\")
    {
        return None;
    }

    Some(filename)
}

fn has_windows_drive_prefix(filename: &str) -> bool {
    let bytes = filename.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ollama_parameters_extracts_stop_tokens_and_temperature() {
        let input =
            "stop \"<|start_header_id|>\"\nstop \"<|end_header_id|>\"\nstop \"<|eot_id|>\"\ntemperature 0.2";
        let (stops, temp) = parse_ollama_parameters(input);
        let stops = stops.expect("stop tokens should be present");
        assert_eq!(stops.len(), 3);
        assert!(stops.contains(&"<|eot_id|>".to_string()));
        assert_eq!(temp, Some(0.2));
    }

    #[test]
    fn parse_ollama_parameters_returns_none_when_empty() {
        let (stops, temp) = parse_ollama_parameters("");
        assert!(stops.is_none());
        assert!(temp.is_none());
    }

    #[test]
    fn determine_ollama_role_detects_embedding_by_family() {
        let details = OllamaModelDetails {
            family: Some("bert".to_string()),
            ..Default::default()
        };
        let role = determine_ollama_role("nomic-embed-text", &details, None, None);
        assert_eq!(role, "embedding");
    }

    #[test]
    fn determine_ollama_role_detects_embedding_by_capability() {
        let details = OllamaModelDetails::default();
        let capabilities = vec!["embedding".to_string()];
        let role = determine_ollama_role("mystery-model", &details, Some(&capabilities), None);
        assert_eq!(role, "embedding");
    }

    #[test]
    fn determine_ollama_role_detects_embeddinggemma_by_name() {
        let details = OllamaModelDetails {
            family: Some("gemma3".to_string()),
            ..Default::default()
        };
        let role = determine_ollama_role("embeddinggemma:latest", &details, None, None);
        assert_eq!(role, "embedding");
    }

    #[test]
    fn determine_ollama_role_prefers_gguf_metadata_when_available() {
        let details = OllamaModelDetails {
            family: Some("bert".to_string()),
            ..Default::default()
        };
        let mut info = HashMap::new();
        info.insert(
            "general.type".to_string(),
            Value::String("text".to_string()),
        );
        let role = determine_ollama_role("some-embed-model", &details, None, Some(&info));
        assert_eq!(role, "text");
    }

    #[test]
    fn infer_role_from_gguf_metadata_detects_pooling_as_embedding() {
        let mut info = HashMap::new();
        info.insert(
            "general.architecture".to_string(),
            Value::String("llama".to_string()),
        );
        info.insert("llama.pooling_type".to_string(), Value::Number(1u64.into()));

        let role = infer_role_from_gguf_metadata("custom-model.gguf", &info);
        assert_eq!(role, Some("embedding".to_string()));
    }

    #[test]
    fn read_gguf_metadata_parses_basic_string_entry() {
        fn push_u32(buf: &mut Vec<u8>, v: u32) {
            buf.extend_from_slice(&v.to_le_bytes());
        }
        fn push_u64(buf: &mut Vec<u8>, v: u64) {
            buf.extend_from_slice(&v.to_le_bytes());
        }
        fn push_gguf_string(buf: &mut Vec<u8>, s: &str) {
            push_u64(buf, s.len() as u64);
            buf.extend_from_slice(s.as_bytes());
        }

        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"GGUF");
        push_u32(&mut bytes, 3);
        push_u64(&mut bytes, 0);
        push_u64(&mut bytes, 1);
        push_gguf_string(&mut bytes, "general.type");
        push_u32(&mut bytes, 8);
        push_gguf_string(&mut bytes, "embedding");

        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sample.gguf");
        fs::write(&path, bytes).expect("write gguf");

        let metadata = read_gguf_metadata(&path).expect("metadata should parse");
        assert_eq!(
            metadata
                .get("general.type")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
            "embedding"
        );
    }

    #[test]
    fn extract_context_length_uses_arch_specific_key() {
        let mut info = HashMap::new();
        info.insert(
            "gemma3.context_length".to_string(),
            Value::Number(32768.into()),
        );
        let result = extract_context_length(Some(&info), Some("gemma3"));
        assert_eq!(result, Some(32768));
    }

    #[test]
    fn extract_context_length_falls_back_to_generic_key() {
        let mut info = HashMap::new();
        info.insert("llm.context_length".to_string(), Value::Number(4096.into()));
        let result = extract_context_length(Some(&info), None);
        assert_eq!(result, Some(4096));
    }

    #[test]
    fn sanitize_model_filename_accepts_normal_name() {
        assert_eq!(sanitize_model_filename("model.gguf"), Some("model.gguf"));
        assert_eq!(
            sanitize_model_filename("my-model-v2.gguf"),
            Some("my-model-v2.gguf")
        );
    }

    #[test]
    fn sanitize_model_filename_rejects_traversal() {
        assert_eq!(sanitize_model_filename("../config.json"), None);
        assert_eq!(sanitize_model_filename("..\\config.json"), None);
        assert_eq!(sanitize_model_filename("sub/model.gguf"), None);
        assert_eq!(sanitize_model_filename("sub\\model.gguf"), None);
    }

    #[test]
    fn sanitize_model_filename_rejects_absolute_path() {
        assert_eq!(sanitize_model_filename("/etc/passwd"), None);
        assert_eq!(sanitize_model_filename("C:\\Windows\\foo.gguf"), None);
    }

    #[test]
    fn sanitize_model_filename_rejects_empty() {
        assert_eq!(sanitize_model_filename(""), None);
    }
}
