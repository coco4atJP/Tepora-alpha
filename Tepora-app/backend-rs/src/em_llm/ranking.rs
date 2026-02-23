use crate::em_llm::types::{DecayConfig, MemoryLayer};

fn recency_factor(recency_days: f64, memory_layer: MemoryLayer, config: &DecayConfig) -> f64 {
    let days = recency_days.max(0.0);
    let beta = match memory_layer {
        MemoryLayer::LML => config.beta_lml,
        MemoryLayer::SML => config.beta_sml,
    };
    (-(config.lambda_base * days.powf(beta))).exp().clamp(0.0, 1.0)
}

pub fn compute_retrieval_score(
    cosine_similarity: f32,
    memory_strength: f64,
    recency_days: f64,
    memory_layer: MemoryLayer,
    config: &DecayConfig,
) -> f64 {
    let recency = recency_factor(recency_days, memory_layer, config);
    cosine_similarity as f64 * memory_strength.clamp(0.0, 1.0) * recency
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranking_score_prefers_strong_memories() {
        let cfg = DecayConfig::default();
        let weak = compute_retrieval_score(0.9, 0.2, 1.0, MemoryLayer::SML, &cfg);
        let strong = compute_retrieval_score(0.9, 0.9, 1.0, MemoryLayer::SML, &cfg);
        assert!(strong > weak);
    }
}
