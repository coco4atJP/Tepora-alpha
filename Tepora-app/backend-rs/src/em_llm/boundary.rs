//! EM-LLM boundary refinement.
//!
//! This module provides boundary refinement functionality using
//! graph-theoretic metrics (modularity and conductance).
//!
//! # Algorithm Overview
//!
//! After initial segmentation, boundaries can be refined by:
//! 1. Constructing a similarity graph from embeddings
//! 2. Evaluating boundary positions using modularity or conductance
//! 3. Adjusting boundaries to optimize the chosen metric

use crate::em_llm::types::{EMConfig, EpisodicEvent};

/// Refines event boundaries using graph-theoretic metrics.
///
/// This class optimizes segmentation quality by:
/// 1. Evaluating boundary positions with modularity or conductance
/// 2. Adjusting boundaries within a search range to improve metrics
pub struct EMBoundaryRefiner {
    config: EMConfig,
}

impl EMBoundaryRefiner {
    /// Create a new boundary refiner with the given configuration.
    pub fn new(config: EMConfig) -> Self {
        Self { config }
    }

    /// Calculate similarity matrix from embeddings (cosine similarity).
    ///
    /// # Arguments
    /// * `embeddings` - Matrix of embedding vectors (one per item)
    ///
    /// # Returns
    /// Similarity matrix (n x n)
    pub fn calculate_similarity_matrix(&self, embeddings: &[Vec<f32>]) -> Vec<Vec<f64>> {
        let n = embeddings.len();
        let mut similarity = vec![vec![0.0; n]; n];

        for i in 0..n {
            for j in 0..n {
                if i == j {
                    similarity[i][j] = 1.0;
                } else {
                    similarity[i][j] = cosine_similarity(&embeddings[i], &embeddings[j]);
                }
            }
        }

        similarity
    }

    /// Calculate modularity (Equation 3 from paper).
    ///
    /// Modularity measures how well boundaries partition the similarity graph
    /// into communities with dense internal connections.
    ///
    /// # Arguments
    /// * `similarity_matrix` - Similarity matrix between items
    /// * `boundaries` - Boundary indices defining communities
    ///
    /// # Returns
    /// Modularity score (higher is better)
    pub fn calculate_modularity(
        &self,
        similarity_matrix: &[Vec<f64>],
        boundaries: &[usize],
    ) -> f64 {
        let n = similarity_matrix.len();
        if n == 0 || boundaries.is_empty() {
            return 0.0;
        }

        // Calculate total edge weight (sum of all similarities)
        let total_weight: f64 = similarity_matrix
            .iter()
            .flat_map(|row| row.iter())
            .sum::<f64>()
            / 2.0;

        if total_weight == 0.0 {
            return 0.0;
        }

        // Calculate degree for each node
        let degrees: Vec<f64> = similarity_matrix
            .iter()
            .map(|row| row.iter().sum::<f64>())
            .collect();

        // Assign community labels based on boundaries
        let community = assign_communities(n, boundaries);

        // Calculate modularity
        let mut modularity = 0.0;
        for i in 0..n {
            for j in 0..n {
                if community[i] == community[j] {
                    let expected = degrees[i] * degrees[j] / (2.0 * total_weight);
                    modularity += similarity_matrix[i][j] - expected;
                }
            }
        }

        modularity / (2.0 * total_weight)
    }

    /// Calculate conductance (Equation 4 from paper).
    ///
    /// Conductance measures the ratio of edges leaving a community
    /// to the total edges incident to the community (lower is better).
    ///
    /// # Arguments
    /// * `similarity_matrix` - Similarity matrix between items
    /// * `boundaries` - Boundary indices defining communities
    ///
    /// # Returns
    /// Average conductance across all communities (lower is better)
    pub fn calculate_conductance(
        &self,
        similarity_matrix: &[Vec<f64>],
        boundaries: &[usize],
    ) -> f64 {
        let n = similarity_matrix.len();
        if n == 0 || boundaries.is_empty() {
            return 1.0;
        }

        let community = assign_communities(n, boundaries);
        let num_communities = boundaries.len();

        let mut total_conductance = 0.0;
        let mut valid_communities = 0;

        for c in 0..num_communities {
            let members: Vec<usize> = (0..n).filter(|&i| community[i] == c).collect();

            if members.is_empty() || members.len() == n {
                continue;
            }

            // Calculate cut (edges leaving community)
            let mut cut = 0.0;
            // Calculate volume (total edges incident to community)
            let mut volume = 0.0;

            for &i in &members {
                for j in 0..n {
                    if community[j] != c {
                        cut += similarity_matrix[i][j];
                    }
                    volume += similarity_matrix[i][j];
                }
            }

            // Calculate volume of complement
            let complement_volume: f64 = (0..n)
                .filter(|&i| community[i] != c)
                .flat_map(|i| similarity_matrix[i].iter())
                .sum();

            let min_volume = volume.min(complement_volume);
            if min_volume > 0.0 {
                total_conductance += cut / min_volume;
                valid_communities += 1;
            }
        }

        if valid_communities > 0 {
            total_conductance / valid_communities as f64
        } else {
            1.0
        }
    }

    /// Refine boundaries using graph-theoretic metrics.
    ///
    /// Tries different boundary positions within the search range
    /// and selects the configuration that optimizes the chosen metric.
    ///
    /// # Arguments
    /// * `events` - List of initial events
    /// * `embeddings` - Embedding vectors for each sentence/token
    ///
    /// # Returns
    /// List of events with refined boundaries
    pub fn refine_boundaries(
        &self,
        events: Vec<EpisodicEvent>,
        embeddings: &[Vec<f32>],
    ) -> Vec<EpisodicEvent> {
        if !self.config.use_boundary_refinement || events.len() < 2 {
            return events;
        }

        let similarity_matrix = self.calculate_similarity_matrix(embeddings);

        // Extract current boundaries
        let mut boundaries: Vec<usize> = events.iter().map(|e| e.start_position).collect();

        let search_range = self.config.refinement_search_range;
        let use_modularity = self.config.refinement_metric == "modularity";

        // Evaluate initial score
        let mut best_score = if use_modularity {
            self.calculate_modularity(&similarity_matrix, &boundaries)
        } else {
            -self.calculate_conductance(&similarity_matrix, &boundaries) // Negate for maximization
        };

        let mut improved = true;
        let max_iterations = 10;
        let mut iteration = 0;

        while improved && iteration < max_iterations {
            improved = false;
            iteration += 1;

            // Try adjusting each boundary (except first and last)
            for b_idx in 1..boundaries.len() {
                let original_pos = boundaries[b_idx];
                let min_pos = boundaries[b_idx - 1] + self.config.min_event_size;
                let max_pos = if b_idx + 1 < boundaries.len() {
                    boundaries[b_idx + 1].saturating_sub(self.config.min_event_size)
                } else {
                    embeddings.len()
                };

                // Search within range
                let search_start = original_pos.saturating_sub(search_range).max(min_pos);
                let search_end = (original_pos + search_range).min(max_pos);

                for new_pos in search_start..=search_end {
                    if new_pos == original_pos {
                        continue;
                    }

                    boundaries[b_idx] = new_pos;

                    let score = if use_modularity {
                        self.calculate_modularity(&similarity_matrix, &boundaries)
                    } else {
                        -self.calculate_conductance(&similarity_matrix, &boundaries)
                    };

                    if score > best_score {
                        best_score = score;
                        improved = true;
                    } else {
                        boundaries[b_idx] = original_pos;
                    }
                }
            }
        }

        // Rebuild events from refined boundaries
        self.rebuild_events_from_boundaries(&events, &boundaries)
    }

    /// Rebuild events from refined boundary positions.
    fn rebuild_events_from_boundaries(
        &self,
        original_events: &[EpisodicEvent],
        boundaries: &[usize],
    ) -> Vec<EpisodicEvent> {
        if original_events.is_empty() {
            return vec![];
        }

        // Collect all tokens and scores from original events
        let all_tokens: Vec<String> = original_events
            .iter()
            .flat_map(|e| e.tokens.clone())
            .collect();
        let all_scores: Vec<f64> = original_events
            .iter()
            .flat_map(|e| e.surprise_scores.clone())
            .collect();

        let mut new_events = Vec::new();
        let mut boundary_pairs: Vec<(usize, usize)> = Vec::new();

        // Create boundary pairs
        for i in 0..boundaries.len() {
            let start = boundaries[i];
            let end = if i + 1 < boundaries.len() {
                boundaries[i + 1]
            } else {
                all_tokens.len()
            };
            if start < end && end <= all_tokens.len() {
                boundary_pairs.push((start, end));
            }
        }

        // Create new events from boundary pairs
        for (start, end) in boundary_pairs {
            if start < all_tokens.len() && end <= all_tokens.len() {
                let tokens = all_tokens[start..end].to_vec();
                let scores = all_scores[start..end.min(all_scores.len())].to_vec();

                let event = EpisodicEvent::new(
                    uuid::Uuid::new_v4().to_string(),
                    tokens,
                    start,
                    end,
                    scores,
                );
                new_events.push(event);
            }
        }

        new_events
    }
}

/// Calculate cosine similarity between two vectors.
fn cosine_similarity(a: &[f32], b: &[f32]) -> f64 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }

    let dot: f64 = a
        .iter()
        .zip(b.iter())
        .map(|(x, y)| (*x as f64) * (*y as f64))
        .sum();
    let norm_a: f64 = a.iter().map(|x| (*x as f64).powi(2)).sum::<f64>().sqrt();
    let norm_b: f64 = b.iter().map(|x| (*x as f64).powi(2)).sum::<f64>().sqrt();

    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }

    (dot / (norm_a * norm_b)).clamp(-1.0, 1.0)
}

/// Assign community labels based on boundary positions.
fn assign_communities(n: usize, boundaries: &[usize]) -> Vec<usize> {
    let mut community = vec![0; n];
    let mut current_community = 0;

    for (i, comm) in community.iter_mut().enumerate() {
        if boundaries.contains(&i) && i > 0 {
            current_community += 1;
        }
        *comm = current_community;
    }

    community
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_similarity_matrix() {
        let refiner = EMBoundaryRefiner::new(EMConfig::default());
        let embeddings = vec![vec![1.0, 0.0], vec![0.9, 0.1], vec![0.0, 1.0]];

        let sim = refiner.calculate_similarity_matrix(&embeddings);

        // Diagonal should be 1.0
        assert!((sim[0][0] - 1.0).abs() < 0.01);
        assert!((sim[1][1] - 1.0).abs() < 0.01);

        // Similar vectors should have high similarity
        assert!(sim[0][1] > 0.9);

        // Orthogonal vectors should have low similarity
        assert!(sim[0][2].abs() < 0.1);
    }

    #[test]
    fn test_modularity_calculation() {
        let refiner = EMBoundaryRefiner::new(EMConfig::default());

        // Create a similarity matrix with two clear clusters
        let similarity = vec![
            vec![1.0, 0.9, 0.1, 0.1],
            vec![0.9, 1.0, 0.1, 0.1],
            vec![0.1, 0.1, 1.0, 0.9],
            vec![0.1, 0.1, 0.9, 1.0],
        ];

        // Good boundary (splits clusters correctly)
        let good_boundaries = vec![0, 2];
        let good_mod = refiner.calculate_modularity(&similarity, &good_boundaries);

        // Bad boundary (splits within clusters)
        let bad_boundaries = vec![0, 1, 3];
        let bad_mod = refiner.calculate_modularity(&similarity, &bad_boundaries);

        // Good boundaries should have higher modularity
        assert!(good_mod > bad_mod);
    }
}
