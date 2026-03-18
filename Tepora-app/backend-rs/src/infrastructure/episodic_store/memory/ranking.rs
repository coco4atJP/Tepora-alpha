pub fn compute_retrieval_score(cosine_similarity: f32, effective_memory_strength: f64) -> f64 {
    cosine_similarity as f64 * effective_memory_strength.clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranking_score_prefers_strong_memories() {
        let weak = compute_retrieval_score(0.9, 0.2);
        let strong = compute_retrieval_score(0.9, 0.9);
        assert!(strong > weak);
    }
}
