use crate::em_llm::types::{DecayConfig, MemoryLayer};

/// Memory decay engine based on FadeMem-style adaptive forgetting.
#[derive(Debug, Clone)]
pub struct DecayEngine {
    config: DecayConfig,
}

impl DecayEngine {
    pub fn new(config: DecayConfig) -> Self {
        Self { config }
    }

    /// Importance score I_i(t).
    pub fn importance_score(
        &self,
        semantic_relevance: f64,
        access_count: u32,
        time_since_creation_days: f64,
    ) -> f64 {
        let semantic = semantic_relevance.clamp(0.0, 1.0);
        // Saturating access signal in [0, 1).
        let frequency = 1.0 - (-0.2 * access_count as f64).exp();
        // Newer memories get higher recency signal.
        let recency = (-time_since_creation_days.max(0.0) / 7.0).exp();

        let denom = (self.config.alpha + self.config.beta + self.config.gamma).max(f64::EPSILON);
        ((self.config.alpha * semantic + self.config.beta * frequency + self.config.gamma * recency)
            / denom)
            .clamp(0.0, 1.0)
    }

    /// Decayed memory strength v_i(t).
    pub fn compute_strength(
        &self,
        initial_strength: f64,
        importance: f64,
        layer: MemoryLayer,
        elapsed_days: f64,
    ) -> f64 {
        let elapsed = elapsed_days.max(0.0);
        let importance = importance.clamp(0.0, 1.0);
        let lambda = self.config.lambda_base * (-self.config.importance_modulation * importance).exp();
        let beta = match layer {
            MemoryLayer::LML => self.config.beta_lml,
            MemoryLayer::SML => self.config.beta_sml,
        };

        let strength = initial_strength.max(0.0) * (-(lambda * elapsed.powf(beta))).exp();
        strength.clamp(0.0, 1.0)
    }

    /// Reinforcement when a memory is accessed.
    pub fn reinforce(&self, current_strength: f64, access_count_in_window: u32) -> f64 {
        let boost = self.config.reinforcement_delta * (1.0 + access_count_in_window as f64).ln();
        (current_strength + boost).clamp(0.0, 1.0)
    }

    /// Determine layer transition from current importance.
    pub fn determine_layer(&self, importance: f64) -> Option<MemoryLayer> {
        let importance = importance.clamp(0.0, 1.0);
        if importance >= self.config.promote_threshold {
            Some(MemoryLayer::LML)
        } else if importance <= self.config.demote_threshold {
            Some(MemoryLayer::SML)
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decay_engine_strength_decreases_over_time() {
        let engine = DecayEngine::new(DecayConfig::default());
        let now = engine.compute_strength(1.0, 0.5, MemoryLayer::SML, 0.0);
        let later = engine.compute_strength(1.0, 0.5, MemoryLayer::SML, 5.0);
        assert!(later < now);
    }

    #[test]
    fn decay_engine_lml_slower_than_sml() {
        let engine = DecayEngine::new(DecayConfig::default());
        let lml = engine.compute_strength(1.0, 0.5, MemoryLayer::LML, 3.0);
        let sml = engine.compute_strength(1.0, 0.5, MemoryLayer::SML, 3.0);
        assert!(lml > sml);
    }

    #[test]
    fn decay_engine_reinforcement_increases_strength() {
        let engine = DecayEngine::new(DecayConfig::default());
        let boosted = engine.reinforce(0.4, 2);
        assert!(boosted > 0.4);
    }
}
