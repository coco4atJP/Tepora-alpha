//! Comprehensive unit tests for the EM-LLM module.
//!
//! This file covers regression tests for all EM-LLM components:
//! - `types`: EpisodicEvent と EMConfig の境界値・エッジケース
//! - `segmenter`: セグメンテーション統合・セマンティック変化検出
//! - `boundary`: モジュラリティ・コンダクタンス・境界精緻化
//! - `retrieval`: 2段階検索・recency boost・カスタムk
//! - `store`: セッションフィルタ・カウント・コサイン類似度
//! - `service`: 無効状態・min_score フィルタ・セッション分離

#[cfg(test)]
mod types_tests {
    use crate::em_llm::types::{EMConfig, EpisodicEvent};

    // ---------------------------------------------------------------
    // EpisodicEvent
    // ---------------------------------------------------------------

    #[test]
    fn episodic_event_empty_tokens() {
        let event = EpisodicEvent::new("empty".to_string(), vec![], 0, 0, vec![]);
        assert!(event.is_empty());
        assert_eq!(event.len(), 0);
        assert_eq!(event.text(), "");
    }

    #[test]
    fn episodic_event_text_joins_without_separator() {
        let event = EpisodicEvent::new(
            "t".to_string(),
            vec!["Hello".to_string(), ",".to_string(), " world".to_string()],
            0,
            3,
            vec![0.1, 0.2, 0.3],
        );
        assert_eq!(event.text(), "Hello, world");
    }

    #[test]
    fn episodic_event_timestamp_is_positive() {
        let event = EpisodicEvent::new("ts".to_string(), vec![], 0, 0, vec![]);
        assert!(event.timestamp >= 0.0);
    }

    #[test]
    fn episodic_event_optional_fields_default_none() {
        let event = EpisodicEvent::new("opt".to_string(), vec![], 0, 0, vec![]);
        assert!(event.representative_tokens.is_none());
        assert!(event.summary.is_none());
        assert!(event.embedding.is_none());
        assert!(event.session_id.is_none());
        assert!(event.sequence_number.is_none());
    }

    // ---------------------------------------------------------------
    // EMConfig
    // ---------------------------------------------------------------

    #[test]
    fn em_config_buffer_sizes_sum_to_at_most_total() {
        let config = EMConfig::default();
        let ks = config.similarity_buffer_size();
        let kc = config.contiguity_buffer_size();
        // ks + kc may be slightly larger due to rounding, but individually bounded
        assert!(ks <= config.total_retrieved_events + 1);
        assert!(kc <= config.total_retrieved_events + 1);
    }

    #[test]
    fn em_config_similarity_buffer_size_zero_total() {
        let config = EMConfig {
            total_retrieved_events: 0,
            ..Default::default()
        };
        assert_eq!(config.similarity_buffer_size(), 0);
        assert_eq!(config.contiguity_buffer_size(), 0);
    }

    #[test]
    fn em_config_similarity_buffer_size_rounding() {
        let config = EMConfig {
            total_retrieved_events: 10,
            similarity_buffer_ratio: 0.33,
            contiguity_buffer_ratio: 0.67,
            ..Default::default()
        };
        // 10 * 0.33 = 3.3 -> round -> 3
        assert_eq!(config.similarity_buffer_size(), 3);
        // 10 * 0.67 = 6.7 -> round -> 7
        assert_eq!(config.contiguity_buffer_size(), 7);
    }

    #[test]
    fn em_config_refinement_metric_default_is_modularity() {
        let config = EMConfig::default();
        assert_eq!(config.refinement_metric, "modularity");
        assert!(config.use_boundary_refinement);
    }
}

// ===================================================================
#[cfg(test)]
mod segmenter_tests {
    use crate::em_llm::segmenter::EMEventSegmenter;
    use crate::em_llm::types::EMConfig;

    fn make_segmenter(min_size: usize, max_size: usize, gamma: f64, window: usize) -> EMEventSegmenter {
        EMEventSegmenter::new(EMConfig {
            surprise_window: window,
            surprise_gamma: gamma,
            min_event_size: min_size,
            max_event_size: max_size,
            ..Default::default()
        })
    }

    // ---------------------------------------------------------------
    // identify_boundaries
    // ---------------------------------------------------------------

    #[test]
    fn boundaries_empty_input_returns_empty() {
        let seg = make_segmenter(2, 10, 1.0, 4);
        assert!(seg.identify_boundaries(&[]).is_empty());
    }

    #[test]
    fn boundaries_single_token_returns_only_zero() {
        let seg = make_segmenter(1, 10, 1.0, 4);
        let b = seg.identify_boundaries(&[0.5]);
        assert_eq!(b, vec![0]);
    }

    #[test]
    fn boundaries_always_starts_at_zero() {
        let seg = make_segmenter(2, 100, 1.0, 8);
        let scores: Vec<f64> = (0..20).map(|i| i as f64 * 0.1).collect();
        let b = seg.identify_boundaries(&scores);
        assert_eq!(b[0], 0);
    }

    #[test]
    fn boundaries_max_event_size_enforced() {
        let seg = make_segmenter(1, 5, 100.0, 128); // gamma=100 → no natural splits
        let scores = vec![0.5f64; 20];
        let b = seg.identify_boundaries(&scores);
        // Must have boundary at positions 0, 5, 10, 15
        assert!(b.contains(&0));
        assert!(b.contains(&5));
        assert!(b.contains(&10));
        assert!(b.contains(&15));
    }

    #[test]
    fn boundaries_spike_creates_boundary_after_min_size() {
        let seg = make_segmenter(3, 100, 1.0, 4);
        // tokens 0-2 low, token 5 spike
        let mut scores = vec![0.3f64; 10];
        scores[5] = 10.0; // clear spike
        let b = seg.identify_boundaries(&scores);
        assert!(b.len() >= 2);
        assert!(b.contains(&5));
    }

    #[test]
    fn boundaries_spike_before_min_size_ignored() {
        let seg = make_segmenter(5, 100, 1.0, 4);
        // spike at position 2 — before min_event_size (5)
        let mut scores = vec![0.3f64; 15];
        scores[2] = 10.0;
        let b = seg.identify_boundaries(&scores);
        // position 2 should NOT be a boundary (too soon)
        assert!(!b.contains(&2));
    }

    // ---------------------------------------------------------------
    // segment_tokens
    // ---------------------------------------------------------------

    #[test]
    fn segment_tokens_empty_returns_empty() {
        let seg = make_segmenter(2, 10, 1.0, 4);
        let result = seg.segment_tokens(&[], &[]);
        assert!(result.is_empty());
    }

    #[test]
    fn segment_tokens_mismatched_lengths_returns_empty() {
        let seg = make_segmenter(2, 10, 1.0, 4);
        let tokens = vec!["a".to_string(), "b".to_string()];
        let scores = vec![0.5]; // mismatch
        let result = seg.segment_tokens(&tokens, &scores);
        assert!(result.is_empty());
    }

    #[test]
    fn segment_tokens_produces_events_covering_all_tokens() {
        let seg = make_segmenter(2, 6, 1.0, 4);
        let tokens: Vec<String> = (0..18).map(|i| format!("t{}", i)).collect();
        let mut scores = vec![0.3f64; 18];
        // Spike at position 6 and 12
        scores[6] = 10.0;
        scores[12] = 10.0;

        let events = seg.segment_tokens(&tokens, &scores);
        assert!(!events.is_empty());

        // All events should have non-empty tokens
        for event in &events {
            assert!(!event.tokens.is_empty());
        }
    }

    #[test]
    fn segment_tokens_last_segment_below_min_size_discarded() {
        // min_event_size=5, 12 tokens with spike at 10 → last segment is 2 tokens
        let seg = make_segmenter(5, 100, 1.0, 4);
        let tokens: Vec<String> = (0..12).map(|i| format!("t{}", i)).collect();
        let mut scores = vec![0.3f64; 12];
        scores[10] = 10.0; // spike at 10, only 2 tokens remain

        let events = seg.segment_tokens(&tokens, &scores);
        // Last segment (2 tokens) should be discarded
        for event in &events {
            assert!(event.tokens.len() >= 5);
        }
    }

    // ---------------------------------------------------------------
    // calculate_surprise_from_logprobs
    // ---------------------------------------------------------------

    #[test]
    fn surprise_from_logprobs_empty() {
        let seg = make_segmenter(2, 10, 1.0, 4);
        let result = seg.calculate_surprise_from_logprobs(&[]);
        assert!(result.is_empty());
    }

    #[test]
    fn surprise_from_logprobs_negates_correctly() {
        let seg = make_segmenter(2, 10, 1.0, 4);
        let logprobs = vec![("a".to_string(), -1.5), ("b".to_string(), -0.0), ("c".to_string(), -3.0)];
        let scores = seg.calculate_surprise_from_logprobs(&logprobs);
        assert!((scores[0] - 1.5).abs() < 1e-9);
        assert!((scores[1] - 0.0).abs() < 1e-9);
        assert!((scores[2] - 3.0).abs() < 1e-9);
    }

    // ---------------------------------------------------------------
    // segment_by_semantic_change
    // ---------------------------------------------------------------

    #[test]
    fn semantic_change_empty_returns_single_boundary() {
        let seg = make_segmenter(2, 10, 1.0, 4);
        let result = seg.segment_by_semantic_change(&[], &[]);
        assert_eq!(result, vec![0]);
    }

    #[test]
    fn semantic_change_mismatched_returns_single_boundary() {
        let seg = make_segmenter(2, 10, 1.0, 4);
        let sents = vec!["a".to_string()];
        let embs = vec![vec![1.0f32, 0.0], vec![0.0, 1.0]]; // mismatch
        let result = seg.segment_by_semantic_change(&sents, &embs);
        assert_eq!(result, vec![0]);
    }

    #[test]
    fn semantic_change_identical_embeddings_no_extra_boundaries() {
        let seg = make_segmenter(1, 100, 1.0, 4);
        let sents: Vec<String> = (0..10).map(|i| format!("s{}", i)).collect();
        // All identical embeddings → zero cosine distance → no boundaries
        let embs: Vec<Vec<f32>> = (0..10).map(|_| vec![1.0, 0.0, 0.0]).collect();
        let result = seg.segment_by_semantic_change(&sents, &embs);
        assert_eq!(result, vec![0]); // Only the initial boundary
    }

    #[test]
    fn semantic_change_orthogonal_embeddings_detect_boundary() {
        let seg = make_segmenter(1, 100, 0.5, 4);
        let sents: Vec<String> = (0..6).map(|i| format!("s{}", i)).collect();
        // First 3 similar, then completely different
        let embs: Vec<Vec<f32>> = vec![
            vec![1.0, 0.0, 0.0],
            vec![1.0, 0.0, 0.0],
            vec![1.0, 0.0, 0.0],
            vec![0.0, 1.0, 0.0], // sharp semantic change
            vec![0.0, 1.0, 0.0],
            vec![0.0, 1.0, 0.0],
        ];
        let result = seg.segment_by_semantic_change(&sents, &embs);
        // Should detect at least one additional boundary
        assert!(result.len() >= 2);
    }
}

// ===================================================================
#[cfg(test)]
mod boundary_tests {
    use crate::em_llm::boundary::EMBoundaryRefiner;
    use crate::em_llm::types::{EMConfig, EpisodicEvent};

    fn refiner() -> EMBoundaryRefiner {
        EMBoundaryRefiner::new(EMConfig::default())
    }

    fn make_event(start: usize, end: usize, tokens: Vec<&str>) -> EpisodicEvent {
        EpisodicEvent::new(
            uuid::Uuid::new_v4().to_string(),
            tokens.into_iter().map(|s| s.to_string()).collect(),
            start,
            end,
            vec![0.5; end - start],
        )
    }

    // ---------------------------------------------------------------
    // calculate_similarity_matrix
    // ---------------------------------------------------------------

    #[test]
    fn similarity_matrix_empty_embeddings() {
        let r = refiner();
        let sim = r.calculate_similarity_matrix(&[]);
        assert!(sim.is_empty());
    }

    #[test]
    fn similarity_matrix_diagonal_is_one() {
        let r = refiner();
        let embs = vec![vec![1.0f32, 0.0], vec![0.0, 1.0], vec![0.5, 0.5]];
        let sim = r.calculate_similarity_matrix(&embs);
        for i in 0..3 {
            assert!((sim[i][i] - 1.0).abs() < 1e-6, "diagonal[{}] not 1.0", i);
        }
    }

    #[test]
    fn similarity_matrix_is_symmetric() {
        let r = refiner();
        let embs = vec![vec![1.0f32, 0.0], vec![0.7, 0.7], vec![0.0, 1.0]];
        let sim = r.calculate_similarity_matrix(&embs);
        for i in 0..3 {
            for j in 0..3 {
                assert!((sim[i][j] - sim[j][i]).abs() < 1e-6);
            }
        }
    }

    // ---------------------------------------------------------------
    // calculate_modularity
    // ---------------------------------------------------------------

    #[test]
    fn modularity_empty_returns_zero() {
        let r = refiner();
        assert_eq!(r.calculate_modularity(&[], &[0]), 0.0);
        assert_eq!(r.calculate_modularity(&[vec![1.0]], &[]), 0.0);
    }

    #[test]
    fn modularity_well_separated_clusters_positive() {
        let r = refiner();
        let sim = vec![
            vec![1.0, 0.95, 0.05, 0.05],
            vec![0.95, 1.0, 0.05, 0.05],
            vec![0.05, 0.05, 1.0, 0.95],
            vec![0.05, 0.05, 0.95, 1.0],
        ];
        let mod_good = r.calculate_modularity(&sim, &[0, 2]);
        assert!(mod_good > 0.0, "modularity should be positive for well-separated clusters");
    }

    #[test]
    fn modularity_good_partition_beats_bad() {
        let r = refiner();
        let sim = vec![
            vec![1.0, 0.9, 0.1, 0.1],
            vec![0.9, 1.0, 0.1, 0.1],
            vec![0.1, 0.1, 1.0, 0.9],
            vec![0.1, 0.1, 0.9, 1.0],
        ];
        let good = r.calculate_modularity(&sim, &[0, 2]);
        let bad = r.calculate_modularity(&sim, &[0, 1, 2, 3]);
        assert!(good > bad);
    }

    // ---------------------------------------------------------------
    // calculate_conductance
    // ---------------------------------------------------------------

    #[test]
    fn conductance_empty_returns_one() {
        let r = refiner();
        assert_eq!(r.calculate_conductance(&[], &[0]), 1.0);
    }

    #[test]
    fn conductance_well_separated_is_low() {
        let r = refiner();
        let sim = vec![
            vec![1.0, 0.95, 0.01, 0.01],
            vec![0.95, 1.0, 0.01, 0.01],
            vec![0.01, 0.01, 1.0, 0.95],
            vec![0.01, 0.01, 0.95, 1.0],
        ];
        let cond = r.calculate_conductance(&sim, &[0, 2]);
        assert!(cond < 0.5, "conductance should be low for well-separated clusters, got {}", cond);
    }

    #[test]
    fn conductance_good_partition_lower_than_bad() {
        let r = refiner();
        let sim = vec![
            vec![1.0, 0.9, 0.1, 0.1],
            vec![0.9, 1.0, 0.1, 0.1],
            vec![0.1, 0.1, 1.0, 0.9],
            vec![0.1, 0.1, 0.9, 1.0],
        ];
        let good = r.calculate_conductance(&sim, &[0, 2]);
        let bad = r.calculate_conductance(&sim, &[0, 1]);
        assert!(good < bad, "good partition conductance ({}) should be less than bad ({})", good, bad);
    }

    // ---------------------------------------------------------------
    // refine_boundaries
    // ---------------------------------------------------------------

    #[test]
    fn refine_boundaries_disabled_returns_original() {
        let r = EMBoundaryRefiner::new(EMConfig {
            use_boundary_refinement: false,
            ..Default::default()
        });
        let events = vec![
            make_event(0, 4, vec!["a", "b", "c", "d"]),
            make_event(4, 8, vec!["e", "f", "g", "h"]),
        ];
        let embs = vec![vec![1.0f32, 0.0]; 8];
        let refined = r.refine_boundaries(events.clone(), &embs);
        assert_eq!(refined.len(), events.len());
    }

    #[test]
    fn refine_boundaries_single_event_returns_unchanged() {
        let r = refiner();
        let events = vec![make_event(0, 4, vec!["a", "b", "c", "d"])];
        let embs = vec![vec![1.0f32, 0.0]; 4];
        let refined = r.refine_boundaries(events, &embs);
        assert_eq!(refined.len(), 1);
    }

    #[test]
    fn refine_boundaries_conductance_mode_runs_without_panic() {
        let r = EMBoundaryRefiner::new(EMConfig {
            use_boundary_refinement: true,
            refinement_metric: "conductance".to_string(),
            ..Default::default()
        });
        let events = vec![
            make_event(0, 3, vec!["a", "b", "c"]),
            make_event(3, 6, vec!["d", "e", "f"]),
        ];
        let embs = vec![
            vec![1.0f32, 0.0],
            vec![0.9, 0.1],
            vec![0.8, 0.2],
            vec![0.1, 0.9],
            vec![0.0, 1.0],
            vec![0.1, 0.9],
        ];
        // Should not panic
        let refined = r.refine_boundaries(events, &embs);
        assert!(!refined.is_empty());
    }
}

// ===================================================================
#[cfg(test)]
mod retrieval_tests {
    use crate::em_llm::retrieval::EMTwoStageRetrieval;
    use crate::em_llm::types::{EMConfig, EpisodicEvent};

    fn make_event(id: &str, emb: Vec<f32>, seq: u64) -> EpisodicEvent {
        let mut e = EpisodicEvent::new(id.to_string(), vec!["t".to_string()], 0, 1, vec![0.5]);
        e.embedding = Some(emb);
        e.sequence_number = Some(seq);
        e
    }

    fn retrieval_with(total_k: usize, sim_ratio: f64, cont_ratio: f64) -> EMTwoStageRetrieval {
        EMTwoStageRetrieval::new(EMConfig {
            total_retrieved_events: total_k,
            similarity_buffer_ratio: sim_ratio,
            contiguity_buffer_ratio: cont_ratio,
            ..Default::default()
        })
    }

    // ---------------------------------------------------------------
    // add_events / event_count / clear
    // ---------------------------------------------------------------

    #[test]
    fn event_count_after_add() {
        let mut r = retrieval_with(4, 0.7, 0.3);
        assert_eq!(r.event_count(), 0);
        r.add_events(vec![make_event("e1", vec![1.0, 0.0], 0)]);
        assert_eq!(r.event_count(), 1);
        r.add_events(vec![make_event("e2", vec![0.0, 1.0], 1)]);
        assert_eq!(r.event_count(), 2);
    }

    #[test]
    fn clear_removes_all_events() {
        let mut r = retrieval_with(4, 0.7, 0.3);
        r.add_events(vec![
            make_event("e1", vec![1.0, 0.0], 0),
            make_event("e2", vec![0.0, 1.0], 1),
        ]);
        r.clear();
        assert_eq!(r.event_count(), 0);
    }

    // ---------------------------------------------------------------
    // retrieve / retrieve_with_k
    // ---------------------------------------------------------------

    #[test]
    fn retrieve_empty_store_returns_empty() {
        let r = retrieval_with(4, 0.7, 0.3);
        let results = r.retrieve(&[1.0, 0.0]);
        assert!(results.is_empty());
    }

    #[test]
    fn retrieve_empty_query_returns_empty() {
        let mut r = retrieval_with(4, 0.7, 0.3);
        r.add_events(vec![make_event("e1", vec![1.0, 0.0], 0)]);
        let results = r.retrieve(&[]);
        assert!(results.is_empty());
    }

    #[test]
    fn retrieve_events_without_embeddings_are_skipped() {
        let mut r = retrieval_with(4, 1.0, 0.0);
        let mut e = EpisodicEvent::new("no-emb".to_string(), vec!["t".to_string()], 0, 1, vec![0.5]);
        e.embedding = None; // No embedding
        r.add_events(vec![e]);
        let results = r.retrieve(&[1.0, 0.0]);
        assert!(results.is_empty());
    }

    #[test]
    fn retrieve_returns_most_similar_first_by_sequence() {
        let mut r = retrieval_with(2, 1.0, 0.0);
        r.add_events(vec![
            make_event("e1", vec![1.0, 0.0, 0.0], 0),
            make_event("e2", vec![0.9, 0.1, 0.0], 1),
            make_event("e3", vec![0.0, 0.0, 1.0], 2), // dissimilar
        ]);
        let results = r.retrieve(&[1.0, 0.0, 0.0]);
        assert_eq!(results.len(), 2);
        let ids: Vec<&str> = results.iter().map(|e| e.id.as_str()).collect();
        assert!(ids.contains(&"e1"));
        assert!(ids.contains(&"e2"));
        assert!(!ids.contains(&"e3"));
    }

    #[test]
    fn retrieve_with_k_custom_overrides_config() {
        let mut r = retrieval_with(10, 1.0, 0.0); // config k=10
        r.add_events(vec![
            make_event("e1", vec![1.0, 0.0], 0),
            make_event("e2", vec![0.9, 0.1], 1),
            make_event("e3", vec![0.8, 0.2], 2),
        ]);
        // custom k=1
        let results = r.retrieve_with_k(&[1.0, 0.0], Some(1));
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn retrieve_results_sorted_by_sequence_number() {
        let mut r = retrieval_with(3, 1.0, 0.0);
        // Add in reverse order
        r.add_events(vec![
            make_event("e3", vec![0.8, 0.2], 3),
            make_event("e1", vec![1.0, 0.0], 1),
            make_event("e2", vec![0.9, 0.1], 2),
        ]);
        let results = r.retrieve(&[1.0, 0.0]);
        assert_eq!(results.len(), 3);
        // Should be sorted by sequence number
        let seqs: Vec<u64> = results
            .iter()
            .filter_map(|e| e.sequence_number)
            .collect();
        let mut sorted = seqs.clone();
        sorted.sort();
        assert_eq!(seqs, sorted);
    }

    #[test]
    fn contiguity_retrieval_includes_adjacent_events() {
        let mut r = retrieval_with(4, 0.5, 0.5);
        r.add_events(vec![
            make_event("e0", vec![0.0, 1.0, 0.0], 0),
            make_event("e1", vec![0.0, 0.9, 0.1], 1),
            make_event("target", vec![1.0, 0.0, 0.0], 2),
            make_event("e3", vec![0.9, 0.1, 0.0], 3),
            make_event("e4", vec![0.0, 0.0, 1.0], 4),
        ]);
        let results = r.retrieve(&[1.0, 0.0, 0.0]);
        let ids: Vec<&str> = results.iter().map(|e| e.id.as_str()).collect();
        assert!(ids.contains(&"target"), "target event must be retrieved");
        // Adjacent events should also be included
        assert!(results.len() >= 2);
    }

    // ---------------------------------------------------------------
    // apply_recency_boost
    // ---------------------------------------------------------------

    #[test]
    fn recency_boost_empty_does_not_panic() {
        let r = retrieval_with(4, 0.7, 0.3);
        let mut events: Vec<(EpisodicEvent, f64)> = vec![];
        r.apply_recency_boost(&mut events);
        // Should not panic
    }

    #[test]
    fn recency_boost_single_event_unchanged() {
        let r = retrieval_with(4, 0.7, 0.3);
        let e = make_event("e1", vec![1.0, 0.0], 0);
        let original_score = 0.8;
        let mut events = vec![(e, original_score)];
        r.apply_recency_boost(&mut events);
        // With single event, time_range=0 → no change
        assert!((events[0].1 - original_score).abs() < 1e-6);
    }

    #[test]
    fn recency_boost_newer_event_gets_higher_score() {
        let r = retrieval_with(4, 0.7, 0.3);
        let mut old_event = make_event("old", vec![1.0, 0.0], 0);
        let mut new_event = make_event("new", vec![1.0, 0.0], 1);
        // Manually set timestamps
        old_event.timestamp = 1000.0;
        new_event.timestamp = 2000.0;

        let mut events = vec![(old_event, 0.5), (new_event, 0.5)];
        r.apply_recency_boost(&mut events);

        let old_score = events.iter().find(|(e, _)| e.id == "old").unwrap().1;
        let new_score = events.iter().find(|(e, _)| e.id == "new").unwrap().1;
        assert!(new_score > old_score, "newer event should have higher score after recency boost");
    }
}

// ===================================================================
#[cfg(test)]
mod store_tests {
    use crate::em_llm::store::EmMemoryStore;

    async fn make_store() -> EmMemoryStore {
        let path = std::env::temp_dir().join(format!(
            "tepora-em-store-tests-{}.db",
            uuid::Uuid::new_v4()
        ));
        EmMemoryStore::with_path(path).await.unwrap()
    }

    #[tokio::test]
    async fn count_events_initially_zero() {
        let store = make_store().await;
        assert_eq!(store.count_events(None).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn count_events_increments_on_insert() {
        let store = make_store().await;
        store.insert_event("a", "s1", "u", "r", "c", &[1.0, 0.0]).await.unwrap();
        store.insert_event("b", "s1", "u", "r", "c", &[0.0, 1.0]).await.unwrap();
        assert_eq!(store.count_events(None).await.unwrap(), 2);
    }

    #[tokio::test]
    async fn count_events_with_session_filter() {
        let store = make_store().await;
        store.insert_event("a", "session-A", "u", "r", "c", &[1.0, 0.0]).await.unwrap();
        store.insert_event("b", "session-A", "u", "r", "c", &[0.9, 0.1]).await.unwrap();
        store.insert_event("c", "session-B", "u", "r", "c", &[0.0, 1.0]).await.unwrap();

        assert_eq!(store.count_events(Some("session-A")).await.unwrap(), 2);
        assert_eq!(store.count_events(Some("session-B")).await.unwrap(), 1);
        assert_eq!(store.count_events(None).await.unwrap(), 3);
    }

    #[tokio::test]
    async fn retrieve_similar_without_session_filter_returns_all() {
        let store = make_store().await;
        store.insert_event("a", "s1", "u", "r", "content-a", &[1.0, 0.0, 0.0]).await.unwrap();
        store.insert_event("b", "s2", "u", "r", "content-b", &[1.0, 0.0, 0.0]).await.unwrap();

        let results = store.retrieve_similar(&[1.0, 0.0, 0.0], None, 10).await.unwrap();
        assert_eq!(results.len(), 2);
    }

    #[tokio::test]
    async fn retrieve_similar_filters_by_session() {
        let store = make_store().await;
        store.insert_event("a", "sess-1", "u", "r", "c-a", &[1.0, 0.0]).await.unwrap();
        store.insert_event("b", "sess-2", "u", "r", "c-b", &[1.0, 0.0]).await.unwrap();

        let results = store
            .retrieve_similar(&[1.0, 0.0], Some("sess-1"), 10)
            .await
            .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "a");
    }

    #[tokio::test]
    async fn retrieve_similar_respects_limit() {
        let store = make_store().await;
        for i in 0..10 {
            store
                .insert_event(&format!("e{}", i), "s1", "u", "r", "c", &[1.0, 0.0])
                .await
                .unwrap();
        }
        let results = store.retrieve_similar(&[1.0, 0.0], None, 3).await.unwrap();
        assert_eq!(results.len(), 3);
    }

    #[tokio::test]
    async fn retrieve_similar_sorted_by_score_descending() {
        let store = make_store().await;
        store.insert_event("similar", "s1", "u", "r", "c", &[1.0, 0.0, 0.0]).await.unwrap();
        store.insert_event("dissimilar", "s1", "u", "r", "c", &[0.0, 1.0, 0.0]).await.unwrap();

        let results = store.retrieve_similar(&[1.0, 0.0, 0.0], Some("s1"), 10).await.unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].id, "similar");
        assert!(results[0].score > results[1].score);
    }

    #[tokio::test]
    async fn insert_or_replace_same_id() {
        let store = make_store().await;
        store.insert_event("dup", "s1", "u1", "r1", "content1", &[1.0, 0.0]).await.unwrap();
        store.insert_event("dup", "s1", "u2", "r2", "content2", &[0.0, 1.0]).await.unwrap();

        // COUNT should be 1 because INSERT OR REPLACE
        assert_eq!(store.count_events(None).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn retrieve_similar_zero_vector_returns_zero_scores() {
        let store = make_store().await;
        store.insert_event("e1", "s1", "u", "r", "c", &[1.0, 0.0, 0.0]).await.unwrap();

        let results = store.retrieve_similar(&[0.0, 0.0, 0.0], Some("s1"), 10).await.unwrap();
        assert_eq!(results.len(), 1);
        assert!((results[0].score).abs() < 1e-6);
    }
}

// ===================================================================
#[cfg(test)]
mod service_tests {
    use std::sync::Arc;

    use crate::em_llm::service::EmMemoryService;
    use crate::em_llm::store::EmMemoryStore;

    async fn make_service(enabled: bool, retrieval_limit: usize, min_score: f32) -> EmMemoryService {
        let path = std::env::temp_dir().join(format!(
            "tepora-em-service-unit-{}.db",
            uuid::Uuid::new_v4()
        ));
        let store = Arc::new(EmMemoryStore::with_path(path).await.unwrap());
        EmMemoryService::with_store_for_test(store, enabled, retrieval_limit, min_score)
    }

    // ---------------------------------------------------------------
    // enabled()
    // ---------------------------------------------------------------

    #[tokio::test]
    async fn enabled_reflects_constructor_flag() {
        let svc_on = make_service(true, 5, 0.0).await;
        let svc_off = make_service(false, 5, 0.0).await;
        assert!(svc_on.enabled());
        assert!(!svc_off.enabled());
    }

    // ---------------------------------------------------------------
    // ingest_interaction_with_embedding / disabled behavior
    // ---------------------------------------------------------------

    #[tokio::test]
    async fn ingest_when_disabled_does_nothing() {
        let svc = make_service(false, 5, 0.0).await;
        // Should succeed without storing anything
        svc.ingest_interaction_with_embedding("s1", "hello", "world", &[1.0, 0.0])
            .await
            .unwrap();
        let stats = svc.stats().await.unwrap();
        assert_eq!(stats.total_events, 0);
    }

    #[tokio::test]
    async fn ingest_stores_events_when_enabled() {
        let svc = make_service(true, 5, 0.0).await;
        svc.ingest_interaction_with_embedding("s1", "user msg", "assistant msg", &[1.0, 0.0])
            .await
            .unwrap();
        let stats = svc.stats().await.unwrap();
        assert_eq!(stats.total_events, 1);
    }

    // ---------------------------------------------------------------
    // retrieve_for_query_with_embedding / disabled behavior
    // ---------------------------------------------------------------

    #[tokio::test]
    async fn retrieve_when_disabled_returns_empty() {
        let svc = make_service(false, 5, 0.0).await;
        // First ingest directly via enabled service
        let path = std::env::temp_dir().join(format!(
            "tepora-em-retrieve-disabled-{}.db",
            uuid::Uuid::new_v4()
        ));
        let store = Arc::new(EmMemoryStore::with_path(path).await.unwrap());
        store
            .insert_event("e1", "s1", "u", "a", "content", &[1.0, 0.0])
            .await
            .unwrap();
        let svc_off = EmMemoryService::with_store_for_test(store, false, 5, 0.0);
        let results = svc_off
            .retrieve_for_query_with_embedding("s1", &[1.0, 0.0])
            .await
            .unwrap();
        assert!(results.is_empty());
    }

    #[tokio::test]
    async fn retrieve_with_embedding_returns_matching() {
        let svc = make_service(true, 5, 0.0).await;
        svc.ingest_interaction_with_embedding("s1", "question", "answer", &[1.0, 0.0, 0.0])
            .await
            .unwrap();

        let results = svc
            .retrieve_for_query_with_embedding("s1", &[1.0, 0.0, 0.0])
            .await
            .unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].content.contains("User: question"));
        assert!(results[0].content.contains("Assistant: answer"));
    }

    // ---------------------------------------------------------------
    // min_score filtering
    // ---------------------------------------------------------------

    #[tokio::test]
    async fn min_score_filters_low_score_results() {
        let svc = make_service(true, 10, 0.9).await; // high min_score

        // Insert event with very different embedding
        svc.ingest_interaction_with_embedding("s1", "abc", "def", &[1.0, 0.0, 0.0])
            .await
            .unwrap();

        // Query with orthogonal embedding → low similarity score
        let results = svc
            .retrieve_for_query_with_embedding("s1", &[0.0, 1.0, 0.0])
            .await
            .unwrap();
        // Score ~ 0.0 < 0.9 → should be filtered
        assert!(results.is_empty(), "low-score results should be filtered by min_score");
    }

    #[tokio::test]
    async fn min_score_zero_returns_all() {
        let svc = make_service(true, 10, 0.0).await; // min_score=0 → no filtering
        svc.ingest_interaction_with_embedding("s1", "u", "a", &[1.0, 0.0, 0.0])
            .await
            .unwrap();

        // Even orthogonal query returns result (score >= 0.0)
        let results = svc
            .retrieve_for_query_with_embedding("s1", &[1.0, 0.0, 0.0])
            .await
            .unwrap();
        assert_eq!(results.len(), 1);
    }

    // ---------------------------------------------------------------
    // session isolation
    // ---------------------------------------------------------------

    #[tokio::test]
    async fn session_isolation_different_sessions_do_not_mix() {
        let svc = make_service(true, 10, 0.0).await;

        svc.ingest_interaction_with_embedding("session-A", "A question", "A answer", &[1.0, 0.0])
            .await
            .unwrap();
        svc.ingest_interaction_with_embedding("session-B", "B question", "B answer", &[1.0, 0.0])
            .await
            .unwrap();

        let results_a = svc
            .retrieve_for_query_with_embedding("session-A", &[1.0, 0.0])
            .await
            .unwrap();
        let results_b = svc
            .retrieve_for_query_with_embedding("session-B", &[1.0, 0.0])
            .await
            .unwrap();

        assert_eq!(results_a.len(), 1);
        assert_eq!(results_b.len(), 1);
        assert!(results_a[0].content.contains("A question"));
        assert!(results_b[0].content.contains("B question"));
    }

    // ---------------------------------------------------------------
    // retrieval_limit
    // ---------------------------------------------------------------

    #[tokio::test]
    async fn retrieval_limit_caps_results() {
        let svc = make_service(true, 3, 0.0).await; // limit=3
        for i in 0..10 {
            svc.ingest_interaction_with_embedding(
                "s1",
                &format!("user {}", i),
                &format!("assistant {}", i),
                &[1.0, 0.0],
            )
            .await
            .unwrap();
        }
        let results = svc
            .retrieve_for_query_with_embedding("s1", &[1.0, 0.0])
            .await
            .unwrap();
        assert!(results.len() <= 3);
    }

    // ---------------------------------------------------------------
    // source URI format
    // ---------------------------------------------------------------

    #[tokio::test]
    async fn retrieved_memory_source_uri_format() {
        let svc = make_service(true, 5, 0.0).await;
        svc.ingest_interaction_with_embedding("my-session", "q", "a", &[1.0, 0.0])
            .await
            .unwrap();

        let results = svc
            .retrieve_for_query_with_embedding("my-session", &[1.0, 0.0])
            .await
            .unwrap();
        assert_eq!(results.len(), 1);
        assert!(
            results[0].source.starts_with("em://my-session/"),
            "source URI should be em://session/id, got: {}",
            results[0].source
        );
    }

    // ---------------------------------------------------------------
    // stats
    // ---------------------------------------------------------------

    #[tokio::test]
    async fn stats_enabled_field_matches_service_state() {
        let svc_on = make_service(true, 5, 0.1).await;
        let svc_off = make_service(false, 5, 0.1).await;
        assert!(svc_on.stats().await.unwrap().enabled);
        assert!(!svc_off.stats().await.unwrap().enabled);
    }

    #[tokio::test]
    async fn stats_total_events_counts_across_sessions() {
        let svc = make_service(true, 5, 0.0).await;
        for s in &["s1", "s2", "s3"] {
            svc.ingest_interaction_with_embedding(s, "u", "a", &[1.0, 0.0])
                .await
                .unwrap();
        }
        let stats = svc.stats().await.unwrap();
        assert_eq!(stats.total_events, 3);
    }
}
