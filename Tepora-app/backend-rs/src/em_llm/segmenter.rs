//! EM-LLM event segmentation.
//!
//! This module provides semantic segmentation of text into episodic events
//! based on surprise scores and semantic change detection.
//!
//! # Algorithm Overview
//!
//! The segmentation follows the EM-LLM paper:
//! 1. Calculate surprise scores from LLM logprobs: -log P(x_t | x_{<t})
//! 2. Compute rolling mean (μ) and standard deviation (σ)
//! 3. Identify boundaries where surprise exceeds threshold: T = μ + γσ
//! 4. Create events between boundaries

use crate::em_llm::types::{EMConfig, EpisodicEvent};

/// Event segmenter based on surprise scores and semantic change.
///
/// Implements the segmentation algorithm from the EM-LLM paper,
/// identifying event boundaries based on:
/// - Surprise scores from LLM logprobs
/// - Rolling threshold: T = μ_{t-τ} + γσ_{t-τ}
pub struct EMEventSegmenter {
    config: EMConfig,
}

impl EMEventSegmenter {
    /// Create a new event segmenter with the given configuration.
    pub fn new(config: EMConfig) -> Self {
        Self { config }
    }

    /// Calculate surprise scores from LLM logprobs.
    ///
    /// Surprise is defined as -log P(x_t | x_{<t}), which equals the negative logprob.
    ///
    /// # Arguments
    /// * `logprobs` - List of (token, logprob) pairs from LLM output
    ///
    /// # Returns
    /// Vector of surprise scores (one per token)
    pub fn calculate_surprise_from_logprobs(&self, logprobs: &[(String, f64)]) -> Vec<f64> {
        logprobs.iter().map(|(_, lp)| -lp).collect()
    }

    /// Identify event boundaries from surprise scores.
    ///
    /// Uses rolling statistics with threshold: T = μ + γσ
    ///
    /// # Arguments
    /// * `surprise_scores` - Surprise score for each token
    ///
    /// # Returns
    /// Vector of boundary indices (positions where new events start)
    pub fn identify_boundaries(&self, surprise_scores: &[f64]) -> Vec<usize> {
        if surprise_scores.is_empty() {
            return vec![];
        }

        let window = self.config.surprise_window;
        let gamma = self.config.surprise_gamma;
        let min_size = self.config.min_event_size;
        let max_size = self.config.max_event_size;

        let mut boundaries = vec![0]; // Always start with position 0
        let mut last_boundary = 0;

        for i in 1..surprise_scores.len() {
            // Calculate rolling mean and std for the window
            let window_start = i.saturating_sub(window);
            let window_scores: Vec<f64> = surprise_scores[window_start..i].to_vec();

            if window_scores.is_empty() {
                continue;
            }

            let mean = window_scores.iter().sum::<f64>() / window_scores.len() as f64;
            let variance = window_scores
                .iter()
                .map(|x| (x - mean).powi(2))
                .sum::<f64>()
                / window_scores.len() as f64;
            let std = variance.sqrt();

            // Threshold from paper
            let threshold = mean + gamma * std;

            // Check if current surprise exceeds threshold
            let current_surprise = surprise_scores[i];
            let tokens_since_boundary = i - last_boundary;

            // Create boundary if:
            // 1. Surprise exceeds threshold AND
            // 2. Minimum event size is satisfied
            // OR
            // 3. Maximum event size is exceeded
            if (current_surprise > threshold && tokens_since_boundary >= min_size)
                || tokens_since_boundary >= max_size
            {
                boundaries.push(i);
                last_boundary = i;
            }
        }

        boundaries
    }

    /// Segment tokens into episodic events based on surprise scores.
    ///
    /// # Arguments
    /// * `tokens` - List of tokens to segment
    /// * `surprise_scores` - Corresponding surprise scores
    ///
    /// # Returns
    /// Vector of EpisodicEvent structures
    pub fn segment_tokens(&self, tokens: &[String], surprise_scores: &[f64]) -> Vec<EpisodicEvent> {
        if tokens.is_empty() || tokens.len() != surprise_scores.len() {
            return vec![];
        }

        let boundaries = self.identify_boundaries(surprise_scores);
        let mut events = Vec::new();

        // Create events between boundaries
        for window in boundaries.windows(2) {
            let start = window[0];
            let end = window[1];

            let event_tokens = tokens[start..end].to_vec();
            let event_scores = surprise_scores[start..end].to_vec();

            let event = EpisodicEvent::new(
                uuid::Uuid::new_v4().to_string(),
                event_tokens,
                start,
                end,
                event_scores,
            );

            events.push(event);
        }

        // Handle the last segment (from last boundary to end)
        if let Some(&last_boundary) = boundaries.last() {
            if last_boundary < tokens.len() {
                let event_tokens = tokens[last_boundary..].to_vec();
                let event_scores = surprise_scores[last_boundary..].to_vec();

                // Only create if it meets minimum size
                if event_tokens.len() >= self.config.min_event_size {
                    let event = EpisodicEvent::new(
                        uuid::Uuid::new_v4().to_string(),
                        event_tokens,
                        last_boundary,
                        tokens.len(),
                        event_scores,
                    );

                    events.push(event);
                }
            }
        }

        events
    }

    /// Segment text into events using semantic embeddings.
    ///
    /// This is an alternative segmentation approach for when logprobs
    /// are not available. It uses cosine distance between sentence
    /// embeddings to detect semantic changes.
    ///
    /// # Arguments
    /// * `sentences` - List of sentences to segment
    /// * `embeddings` - Corresponding embedding vectors
    ///
    /// # Returns
    /// Vector of boundary indices
    pub fn segment_by_semantic_change(
        &self,
        sentences: &[String],
        embeddings: &[Vec<f32>],
    ) -> Vec<usize> {
        if sentences.len() != embeddings.len() || sentences.is_empty() {
            return vec![0];
        }

        let mut boundaries = vec![0];
        let gamma = self.config.surprise_gamma;
        let min_size = self.config.min_event_size;

        // Calculate cosine distances between consecutive sentences
        let mut distances: Vec<f64> = Vec::new();
        for i in 1..embeddings.len() {
            let dist = cosine_distance(&embeddings[i - 1], &embeddings[i]);
            distances.push(dist);
        }

        if distances.is_empty() {
            return boundaries;
        }

        // Use rolling threshold similar to surprise-based approach
        let window = self.config.surprise_window.min(distances.len());
        let mut last_boundary = 0;

        for i in 0..distances.len() {
            let window_start = i.saturating_sub(window);
            let window_dists: Vec<f64> = distances[window_start..=i].to_vec();

            let mean = window_dists.iter().sum::<f64>() / window_dists.len() as f64;
            let variance = window_dists.iter().map(|x| (x - mean).powi(2)).sum::<f64>()
                / window_dists.len() as f64;
            let std = variance.sqrt();

            let threshold = mean + gamma * std;
            let items_since_boundary = (i + 1) - last_boundary;

            if distances[i] > threshold && items_since_boundary >= min_size {
                // Boundary is at sentence index i+1 (after the high-distance gap)
                boundaries.push(i + 1);
                last_boundary = i + 1;
            }
        }

        boundaries
    }
}

/// Calculate cosine distance between two vectors.
fn cosine_distance(a: &[f32], b: &[f32]) -> f64 {
    if a.len() != b.len() || a.is_empty() {
        return 1.0; // Maximum distance for invalid input
    }

    let dot: f64 = a
        .iter()
        .zip(b.iter())
        .map(|(x, y)| (*x as f64) * (*y as f64))
        .sum();
    let norm_a: f64 = a.iter().map(|x| (*x as f64).powi(2)).sum::<f64>().sqrt();
    let norm_b: f64 = b.iter().map(|x| (*x as f64).powi(2)).sum::<f64>().sqrt();

    if norm_a == 0.0 || norm_b == 0.0 {
        return 1.0;
    }

    let similarity = dot / (norm_a * norm_b);
    1.0 - similarity.clamp(-1.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_surprise_calculation() {
        let segmenter = EMEventSegmenter::new(EMConfig::default());
        let logprobs = vec![
            ("Hello".to_string(), -0.5),
            (" ".to_string(), -0.1),
            ("world".to_string(), -2.0),
        ];

        let surprise = segmenter.calculate_surprise_from_logprobs(&logprobs);
        assert_eq!(surprise, vec![0.5, 0.1, 2.0]);
    }

    #[test]
    fn test_boundary_identification() {
        let config = EMConfig {
            surprise_window: 4,
            surprise_gamma: 1.0,
            min_event_size: 2,
            max_event_size: 10,
            ..Default::default()
        };
        let segmenter = EMEventSegmenter::new(config);

        // Create a sequence with a clear spike at position 5
        let surprise_scores = vec![0.5, 0.6, 0.5, 0.4, 0.5, 3.0, 0.6, 0.5, 0.4];

        let boundaries = segmenter.identify_boundaries(&surprise_scores);

        // Should have boundary at 0 and around position 5
        assert!(boundaries.contains(&0));
        assert!(boundaries.len() >= 2);
    }

    #[test]
    fn test_cosine_distance() {
        let a = vec![1.0, 0.0, 0.0];
        let b = vec![0.0, 1.0, 0.0];
        let c = vec![1.0, 0.0, 0.0];

        // Orthogonal vectors should have distance ~1.0
        let dist_ab = cosine_distance(&a, &b);
        assert!((dist_ab - 1.0).abs() < 0.01);

        // Identical vectors should have distance ~0.0
        let dist_ac = cosine_distance(&a, &c);
        assert!((dist_ac - 0.0).abs() < 0.01);
    }
}
