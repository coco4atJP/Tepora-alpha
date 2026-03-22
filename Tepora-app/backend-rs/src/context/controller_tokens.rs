use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use tokenizers::Tokenizer;

use super::controller::TokenEstimateSource;

type TokenizerCache = Mutex<HashMap<String, Arc<Tokenizer>>>;

pub(super) fn heuristic_token_estimate(text: &str) -> usize {
    let mut ascii = 0usize;
    let mut non_ascii = 0usize;
    for ch in text.chars() {
        if ch.is_ascii() {
            ascii += 1;
        } else {
            non_ascii += 1;
        }
    }
    let base = ascii.div_ceil(4) + non_ascii.div_ceil(2);
    (base.saturating_mul(135)).div_ceil(100)
}

pub(super) fn select_estimation_source(
    current: TokenEstimateSource,
    candidate: TokenEstimateSource,
) -> TokenEstimateSource {
    match (current, candidate) {
        (TokenEstimateSource::Tokenizer, _) | (_, TokenEstimateSource::Tokenizer) => {
            TokenEstimateSource::Tokenizer
        }
        (TokenEstimateSource::Runtime, _) | (_, TokenEstimateSource::Runtime) => {
            TokenEstimateSource::Runtime
        }
        _ => TokenEstimateSource::Heuristic,
    }
}

pub(super) fn load_tokenizer_cached(path: &str) -> Option<Arc<Tokenizer>> {
    if path.trim().is_empty() || !Path::new(path).exists() {
        return None;
    }

    if let Some(existing) = tokenizer_cache().lock().ok()?.get(path).cloned() {
        return Some(existing);
    }

    let tokenizer = Tokenizer::from_file(path).ok()?;
    let tokenizer = Arc::new(tokenizer);
    if let Ok(mut cache) = tokenizer_cache().lock() {
        cache.insert(path.to_string(), tokenizer.clone());
    }
    Some(tokenizer)
}

fn tokenizer_cache() -> &'static TokenizerCache {
    static CACHE: OnceLock<TokenizerCache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}
