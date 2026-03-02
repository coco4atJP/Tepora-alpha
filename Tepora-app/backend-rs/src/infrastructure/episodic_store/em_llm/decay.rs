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
        let frequency = 1.0 - (-self.config.frequency_growth_rate * access_count as f64).exp();
        
        // Convert days to the configured time unit
        let time_since_creation = match self.config.time_unit {
            crate::em_llm::types::TimeUnit::Days => time_since_creation_days,
            crate::em_llm::types::TimeUnit::Hours => time_since_creation_days * 24.0,
        };
        
        // Newer memories get higher recency signal.
        let recency = (-time_since_creation.max(0.0) / self.config.recency_time_constant).exp();

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
        let elapsed = match self.config.time_unit {
            crate::em_llm::types::TimeUnit::Days => elapsed_days.max(0.0),
            crate::em_llm::types::TimeUnit::Hours => (elapsed_days * 24.0).max(0.0),
        };
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

    /// Determine layer transition from current importance and current layer.
    pub fn determine_layer(&self, importance: f64, current_layer: MemoryLayer) -> Option<MemoryLayer> {
        let importance = importance.clamp(0.0, 1.0);
        let hysteresis = self.config.transition_hysteresis;
        
        match current_layer {
            MemoryLayer::SML => {
                // To promote from SML to LML, need to overcome threshold + hysteresis
                if importance >= self.config.promote_threshold + hysteresis {
                    Some(MemoryLayer::LML)
                } else {
                    None
                }
            }
            MemoryLayer::LML => {
                // To demote from LML to SML, need to drop below threshold - hysteresis
                if importance <= self.config.demote_threshold - hysteresis {
                    Some(MemoryLayer::SML)
                } else {
                    None
                }
            }
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

    #[test]
    fn test_time_unit_parameterization() {
        let mut config_days = DecayConfig::default();
        config_days.time_unit = crate::em_llm::types::TimeUnit::Days;
        
        let mut config_hours = DecayConfig::default();
        config_hours.time_unit = crate::em_llm::types::TimeUnit::Hours;

        let engine_days = DecayEngine::new(config_days);
        let engine_hours = DecayEngine::new(config_hours);

        // 1 day in Days unit should equal 24 hours in Hours unit
        // Or rather, if time_unit is Hours, elapsed_days=1.0 is treated as 24 units.
        let str_day = engine_days.compute_strength(1.0, 0.5, MemoryLayer::SML, 1.0);
        let str_hour = engine_hours.compute_strength(1.0, 0.5, MemoryLayer::SML, 1.0);
        
        // Since Hours multiplies the delta space by 24, decay is much faster (result is smaller)
        assert!(str_hour < str_day);
    }

    #[test]
    fn test_layer_transition_hysteresis() {
        let mut config = DecayConfig::default();
        config.promote_threshold = 0.7;
        config.demote_threshold = 0.3;
        config.transition_hysteresis = 0.05;

        let engine = DecayEngine::new(config);

        // Current SML, importance 0.72 => 0.72 < 0.7 + 0.05 = 0.75, so no promote
        assert_eq!(engine.determine_layer(0.72, MemoryLayer::SML), None);
        
        // Current SML, importance 0.76 => 0.76 >= 0.75, promote to LML
        assert_eq!(engine.determine_layer(0.76, MemoryLayer::SML), Some(MemoryLayer::LML));

        // Current LML, importance 0.28 => 0.28 > 0.3 - 0.05 = 0.25, so no demote
        assert_eq!(engine.determine_layer(0.28, MemoryLayer::LML), None);

        // Current LML, importance 0.24 => 0.24 <= 0.25, demote to SML
        assert_eq!(engine.determine_layer(0.24, MemoryLayer::LML), Some(MemoryLayer::SML));
    }
}
