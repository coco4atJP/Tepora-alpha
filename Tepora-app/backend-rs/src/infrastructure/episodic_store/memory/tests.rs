//! Integration tests for the memory module.

#[path = "tests_algorithm.rs"]
mod tests_algorithm;

#[cfg(test)]
mod sqlite_repository_tests {
    use std::path::PathBuf;

    use chrono::{Duration, Utc};
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use crate::memory::repository::MemoryRepository;
    use crate::memory::sqlite_repository::SqliteMemoryRepository;
    use crate::memory::types::*;

    fn make_repo_path(prefix: &str) -> PathBuf {
        std::env::temp_dir().join(format!("{prefix}-{}.db", uuid::Uuid::new_v4()))
    }

    async fn make_repo() -> SqliteMemoryRepository {
        let path = make_repo_path("tepora-memory-v2-test");
        SqliteMemoryRepository::new(path).await.unwrap()
    }

    async fn create_table(path: &PathBuf, table_name: &str) {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();

        let ddl = format!(
            "CREATE TABLE {table_name} (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, content TEXT)"
        );
        sqlx::query(&ddl).execute(&pool).await.unwrap();
        sqlx::query(&format!(
            "INSERT INTO {table_name} (id, session_id, content) VALUES ('legacy-1', 's1', 'legacy')"
        ))
        .execute(&pool)
        .await
        .unwrap();
    }

    async fn list_table_names(path: &PathBuf, like_pattern: &str) -> Vec<String> {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();

        sqlx::query_scalar::<_, String>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ?1 ORDER BY name",
        )
        .bind(like_pattern)
        .fetch_all(&pool)
        .await
        .unwrap()
    }

    fn make_event(
        id: &str,
        session_id: &str,
        scope: MemoryScope,
        episode_id: &str,
        seq: u32,
        content: &str,
        embedding: &[f32],
    ) -> MemoryEvent {
        let now = Utc::now();
        MemoryEvent {
            id: id.to_string(),
            session_id: session_id.to_string(),
            character_id: None,
            scope,
            episode_id: episode_id.to_string(),
            event_seq: seq,
            source_turn_id: None,
            source_role: Some(SourceRole::User),
            content: content.to_string(),
            summary: None,
            embedding: embedding.to_vec(),
            surprise_mean: None,
            surprise_max: None,
            importance: 0.5,
            strength: 1.0,
            layer: MemoryLayer::SML,
            access_count: 0,
            last_accessed_at: None,
            decay_anchor_at: now,
            created_at: now,
            updated_at: now,
            is_deleted: false,
        }
    }

    fn make_edge(
        id: &str,
        session_id: &str,
        from: &str,
        to: &str,
        edge_type: MemoryEdgeType,
    ) -> MemoryEdge {
        MemoryEdge {
            id: id.to_string(),
            session_id: session_id.to_string(),
            from_event_id: from.to_string(),
            to_event_id: to.to_string(),
            edge_type,
            weight: 1.0,
            created_at: Utc::now(),
        }
    }

    // =================================================================
    // Schema init
    // =================================================================

    #[tokio::test]
    async fn schema_init_creates_tables() {
        let repo = make_repo().await;
        // If we get here without error, schema init succeeded.
        let count = repo.count_events(None, None).await.unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn schema_init_retires_legacy_v1_table() {
        let path = make_repo_path("tepora-memory-v2-retire");
        create_table(&path, "episodic_events").await;

        let repo = SqliteMemoryRepository::new(path.clone()).await.unwrap();
        assert_eq!(repo.count_events(None, None).await.unwrap(), 0);

        let retired_tables = list_table_names(&path, "episodic_events_retired_%").await;
        assert_eq!(retired_tables.len(), 1);
        assert_eq!(
            list_table_names(&path, "episodic_events").await,
            Vec::<String>::new()
        );
    }

    #[tokio::test]
    async fn schema_init_drops_expired_retired_tables() {
        let path = make_repo_path("tepora-memory-v2-drop-retired");
        let old_suffix = (Utc::now() - Duration::days(31)).format("%Y%m%d").to_string();
        let old_table = format!("episodic_events_retired_{old_suffix}");
        create_table(&path, &old_table).await;

        let _repo = SqliteMemoryRepository::new(path.clone()).await.unwrap();

        assert_eq!(
            list_table_names(&path, &old_table).await,
            Vec::<String>::new()
        );
    }

    // =================================================================
    // Event CRUD
    // =================================================================

    #[tokio::test]
    async fn insert_and_get_event() {
        let repo = make_repo().await;
        let event = make_event(
            "e1",
            "s1",
            MemoryScope::Char,
            "ep1",
            0,
            "Hello",
            &[1.0, 0.0, 0.0],
        );
        repo.insert_event(&event).await.unwrap();

        let fetched = repo
            .get_event("e1")
            .await
            .unwrap()
            .expect("event should exist");
        assert_eq!(fetched.id, "e1");
        assert_eq!(fetched.session_id, "s1");
        assert_eq!(fetched.scope, MemoryScope::Char);
        assert_eq!(fetched.episode_id, "ep1");
        assert_eq!(fetched.content, "Hello");
        assert!(!fetched.is_deleted);
    }

    #[tokio::test]
    async fn get_event_returns_none_for_missing() {
        let repo = make_repo().await;
        assert!(repo.get_event("nonexistent").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn insert_events_batch() {
        let repo = make_repo().await;
        let events = vec![
            make_event(
                "b1",
                "s1",
                MemoryScope::Char,
                "ep1",
                0,
                "First",
                &[1.0, 0.0],
            ),
            make_event(
                "b2",
                "s1",
                MemoryScope::Char,
                "ep1",
                1,
                "Second",
                &[0.0, 1.0],
            ),
        ];
        repo.insert_events(&events).await.unwrap();
        assert_eq!(repo.count_events(None, None).await.unwrap(), 2);
    }

    // =================================================================
    // Scope isolation
    // =================================================================

    #[tokio::test]
    async fn scope_isolation() {
        let repo = make_repo().await;
        repo.insert_event(&make_event(
            "c1",
            "s1",
            MemoryScope::Char,
            "ep1",
            0,
            "char content",
            &[1.0, 0.0],
        ))
        .await
        .unwrap();
        repo.insert_event(&make_event(
            "p1",
            "s1",
            MemoryScope::Prof,
            "ep2",
            0,
            "prof content",
            &[0.0, 1.0],
        ))
        .await
        .unwrap();

        let char_events = repo
            .get_events_by_scope("s1", MemoryScope::Char, 10, 0)
            .await
            .unwrap();
        assert_eq!(char_events.len(), 1);
        assert_eq!(char_events[0].id, "c1");

        let prof_events = repo
            .get_events_by_scope("s1", MemoryScope::Prof, 10, 0)
            .await
            .unwrap();
        assert_eq!(prof_events.len(), 1);
        assert_eq!(prof_events[0].id, "p1");

        assert_eq!(
            repo.count_events(Some("s1"), Some(MemoryScope::Char))
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            repo.count_events(Some("s1"), Some(MemoryScope::Prof))
                .await
                .unwrap(),
            1
        );
        assert_eq!(repo.count_events(Some("s1"), None).await.unwrap(), 2);
    }

    // =================================================================
    // Similarity search
    // =================================================================

    #[tokio::test]
    async fn retrieve_similar_returns_top_k() {
        let repo = make_repo().await;
        repo.insert_event(&make_event(
            "sim1",
            "s1",
            MemoryScope::Char,
            "ep1",
            0,
            "similar",
            &[1.0, 0.0, 0.0],
        ))
        .await
        .unwrap();
        repo.insert_event(&make_event(
            "sim2",
            "s1",
            MemoryScope::Char,
            "ep1",
            1,
            "somewhat similar",
            &[0.9, 0.1, 0.0],
        ))
        .await
        .unwrap();
        repo.insert_event(&make_event(
            "sim3",
            "s1",
            MemoryScope::Char,
            "ep1",
            2,
            "dissimilar",
            &[0.0, 0.0, 1.0],
        ))
        .await
        .unwrap();

        let results = repo
            .retrieve_similar(Some("s1"), Some(MemoryScope::Char), &[1.0, 0.0, 0.0], 2)
            .await
            .unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].event.id, "sim1");
        assert_eq!(results[1].event.id, "sim2");
        assert!(results[0].score > results[1].score);
    }

    #[tokio::test]
    async fn retrieve_similar_excludes_deleted() {
        let repo = make_repo().await;
        repo.insert_event(&make_event(
            "alive",
            "s1",
            MemoryScope::Char,
            "ep1",
            0,
            "alive",
            &[1.0, 0.0],
        ))
        .await
        .unwrap();
        repo.insert_event(&make_event(
            "dead",
            "s1",
            MemoryScope::Char,
            "ep1",
            1,
            "dead",
            &[1.0, 0.0],
        ))
        .await
        .unwrap();
        repo.soft_delete_events(&["dead".to_string()])
            .await
            .unwrap();

        let results = repo
            .retrieve_similar(Some("s1"), None, &[1.0, 0.0], 10)
            .await
            .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].event.id, "alive");
    }

    #[tokio::test]
    async fn retrieve_similar_empty_query_returns_empty() {
        let repo = make_repo().await;
        repo.insert_event(&make_event(
            "e1",
            "s1",
            MemoryScope::Char,
            "ep1",
            0,
            "c",
            &[1.0, 0.0],
        ))
        .await
        .unwrap();
        let results = repo
            .retrieve_similar(Some("s1"), None, &[], 10)
            .await
            .unwrap();
        assert!(results.is_empty());
    }

    // =================================================================
    // Soft delete
    // =================================================================

    #[tokio::test]
    async fn soft_delete_events_marks_deleted() {
        let repo = make_repo().await;
        repo.insert_event(&make_event(
            "d1",
            "s1",
            MemoryScope::Char,
            "ep1",
            0,
            "delete me",
            &[1.0, 0.0],
        ))
        .await
        .unwrap();
        repo.insert_event(&make_event(
            "d2",
            "s1",
            MemoryScope::Char,
            "ep1",
            1,
            "keep me",
            &[0.0, 1.0],
        ))
        .await
        .unwrap();

        let deleted = repo.soft_delete_events(&["d1".to_string()]).await.unwrap();
        assert_eq!(deleted, 1);

        // Still exists when fetched directly (including soft-deleted)
        let fetched = repo
            .get_event("d1")
            .await
            .unwrap()
            .expect("should still exist");
        assert!(fetched.is_deleted);

        // Not counted in active events
        assert_eq!(repo.count_events(None, None).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn soft_delete_empty_ids() {
        let repo = make_repo().await;
        let deleted = repo.soft_delete_events(&[]).await.unwrap();
        assert_eq!(deleted, 0);
    }

    // =================================================================
    // Update operations
    // =================================================================

    #[tokio::test]
    async fn update_strength_clamps() {
        let repo = make_repo().await;
        repo.insert_event(&make_event(
            "u1",
            "s1",
            MemoryScope::Char,
            "ep1",
            0,
            "c",
            &[1.0],
        ))
        .await
        .unwrap();

        repo.update_strength("u1", 0.42).await.unwrap();
        let ev = repo.get_event("u1").await.unwrap().unwrap();
        assert!((ev.strength - 0.42).abs() < 1e-9);

        // clamp to max 1.0
        repo.update_strength("u1", 1.5).await.unwrap();
        let ev = repo.get_event("u1").await.unwrap().unwrap();
        assert!((ev.strength - 1.0).abs() < 1e-9);
    }

    #[tokio::test]
    async fn update_layer() {
        let repo = make_repo().await;
        repo.insert_event(&make_event(
            "l1",
            "s1",
            MemoryScope::Char,
            "ep1",
            0,
            "c",
            &[1.0],
        ))
        .await
        .unwrap();

        repo.update_layer("l1", MemoryLayer::LML).await.unwrap();
        let ev = repo.get_event("l1").await.unwrap().unwrap();
        assert_eq!(ev.layer, MemoryLayer::LML);
    }

    #[tokio::test]
    async fn update_importance() {
        let repo = make_repo().await;
        repo.insert_event(&make_event(
            "i1",
            "s1",
            MemoryScope::Char,
            "ep1",
            0,
            "c",
            &[1.0],
        ))
        .await
        .unwrap();

        repo.update_importance("i1", 0.85).await.unwrap();
        let ev = repo.get_event("i1").await.unwrap().unwrap();
        assert!((ev.importance - 0.85).abs() < 1e-9);
    }

    #[tokio::test]
    async fn record_access_increments_count_and_updates_strength() {
        let repo = make_repo().await;
        repo.insert_event(&make_event(
            "a1",
            "s1",
            MemoryScope::Char,
            "ep1",
            0,
            "c",
            &[1.0],
        ))
        .await
        .unwrap();

        repo.record_access("a1", 0.8).await.unwrap();
        let ev = repo.get_event("a1").await.unwrap().unwrap();
        assert_eq!(ev.access_count, 1);
        assert!((ev.strength - 0.8).abs() < 1e-9);
        assert!(ev.last_accessed_at.is_some());

        // decay_anchor_at should have been updated to the exact same time as last_accessed_at
        assert_eq!(ev.decay_anchor_at, ev.last_accessed_at.unwrap());

        repo.record_access("a1", 0.85).await.unwrap();
        let ev2 = repo.get_event("a1").await.unwrap().unwrap();
        assert_eq!(ev2.access_count, 2);
        assert_eq!(ev2.decay_anchor_at, ev2.last_accessed_at.unwrap());
    }

    // =================================================================
    // Aggregates
    // =================================================================

    #[tokio::test]
    async fn count_by_layer_counts_correctly() {
        let repo = make_repo().await;
        repo.insert_event(&make_event(
            "lc1",
            "s1",
            MemoryScope::Char,
            "ep1",
            0,
            "c",
            &[1.0],
        ))
        .await
        .unwrap();
        repo.insert_event(&make_event(
            "lc2",
            "s1",
            MemoryScope::Char,
            "ep1",
            1,
            "c",
            &[1.0],
        ))
        .await
        .unwrap();
        repo.update_layer("lc2", MemoryLayer::LML).await.unwrap();

        let counts = repo
            .count_by_layer(Some("s1"), Some(MemoryScope::Char))
            .await
            .unwrap();
        assert_eq!(counts.sml, 1);
        assert_eq!(counts.lml, 1);
    }

    #[tokio::test]
    async fn average_strength_computes_mean() {
        let repo = make_repo().await;
        repo.insert_event(&make_event(
            "avg1",
            "s1",
            MemoryScope::Char,
            "ep1",
            0,
            "c",
            &[1.0],
        ))
        .await
        .unwrap();
        repo.insert_event(&make_event(
            "avg2",
            "s1",
            MemoryScope::Char,
            "ep1",
            1,
            "c",
            &[1.0],
        ))
        .await
        .unwrap();
        repo.update_strength("avg1", 0.6).await.unwrap();
        repo.update_strength("avg2", 0.4).await.unwrap();

        let avg = repo.average_strength(Some("s1"), None).await.unwrap();
        assert!((avg - 0.5).abs() < 1e-9);
    }

    #[tokio::test]
    async fn scope_stats_returns_combined() {
        let repo = make_repo().await;
        repo.insert_event(&make_event(
            "ss1",
            "s1",
            MemoryScope::Char,
            "ep1",
            0,
            "c",
            &[1.0],
        ))
        .await
        .unwrap();
        repo.insert_event(&make_event(
            "ss2",
            "s1",
            MemoryScope::Char,
            "ep1",
            1,
            "c",
            &[1.0],
        ))
        .await
        .unwrap();
        repo.update_layer("ss2", MemoryLayer::LML).await.unwrap();

        let stats = repo
            .scope_stats(Some("s1"), MemoryScope::Char)
            .await
            .unwrap();
        assert_eq!(stats.total_events, 2);
        assert_eq!(stats.layer_counts.sml, 1);
        assert_eq!(stats.layer_counts.lml, 1);
    }

    // =================================================================
    // Edges
    // =================================================================

    #[tokio::test]
    async fn insert_and_get_edge() {
        let repo = make_repo().await;
        repo.insert_event(&make_event(
            "from",
            "s1",
            MemoryScope::Char,
            "ep1",
            0,
            "c",
            &[1.0],
        ))
        .await
        .unwrap();
        repo.insert_event(&make_event(
            "to",
            "s1",
            MemoryScope::Char,
            "ep1",
            1,
            "c",
            &[1.0],
        ))
        .await
        .unwrap();

        let edge = make_edge("edge1", "s1", "from", "to", MemoryEdgeType::TemporalNext);
        repo.insert_edge(&edge).await.unwrap();

        let from_edges = repo.get_edges_from("from", None).await.unwrap();
        assert_eq!(from_edges.len(), 1);
        assert_eq!(from_edges[0].to_event_id, "to");
        assert_eq!(from_edges[0].edge_type, MemoryEdgeType::TemporalNext);

        let to_edges = repo.get_edges_to("to", None).await.unwrap();
        assert_eq!(to_edges.len(), 1);
        assert_eq!(to_edges[0].from_event_id, "from");
    }

    #[tokio::test]
    async fn edge_type_filter() {
        let repo = make_repo().await;
        repo.insert_event(&make_event(
            "f1",
            "s1",
            MemoryScope::Char,
            "ep1",
            0,
            "c",
            &[1.0],
        ))
        .await
        .unwrap();
        repo.insert_event(&make_event(
            "f2",
            "s1",
            MemoryScope::Char,
            "ep1",
            1,
            "c",
            &[1.0],
        ))
        .await
        .unwrap();

        let temporal = make_edge("et1", "s1", "f1", "f2", MemoryEdgeType::TemporalNext);
        let semantic = make_edge("et2", "s1", "f1", "f2", MemoryEdgeType::SemanticNeighbor);
        repo.insert_edges(&[temporal, semantic]).await.unwrap();

        let temporal_only = repo
            .get_edges_from("f1", Some(MemoryEdgeType::TemporalNext))
            .await
            .unwrap();
        assert_eq!(temporal_only.len(), 1);

        let semantic_only = repo
            .get_edges_from("f1", Some(MemoryEdgeType::SemanticNeighbor))
            .await
            .unwrap();
        assert_eq!(semantic_only.len(), 1);

        let all = repo.get_edges_from("f1", None).await.unwrap();
        assert_eq!(all.len(), 2);
    }

    // =================================================================
    // Compaction
    // =================================================================

    #[tokio::test]
    async fn compaction_job_crud() {
        let repo = make_repo().await;

        let job = CompactionJob {
            id: "job1".to_string(),
            session_id: "s1".to_string(),
            scope: MemoryScope::Char,
            status: CompactionStatus::Queued,
            scanned_events: 0,
            merged_groups: 0,
            replaced_events: 0,
            created_events: 0,
            created_at: Utc::now(),
            finished_at: None,
        };
        repo.create_compaction_job(&job).await.unwrap();

        let jobs = repo
            .list_compaction_jobs(Some("s1"), None, Some(CompactionStatus::Queued))
            .await
            .unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].status, CompactionStatus::Queued);

        // Update
        let mut updated_job = job.clone();
        updated_job.status = CompactionStatus::Done;
        updated_job.scanned_events = 10;
        updated_job.merged_groups = 2;
        updated_job.replaced_events = 4;
        updated_job.created_events = 2;
        updated_job.finished_at = Some(Utc::now());
        repo.update_compaction_job(&updated_job).await.unwrap();

        let jobs = repo
            .list_compaction_jobs(Some("s1"), None, Some(CompactionStatus::Done))
            .await
            .unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].scanned_events, 10);
        assert!(jobs[0].finished_at.is_some());
    }

    #[tokio::test]
    async fn compaction_member_tracking() {
        let repo = make_repo().await;

        let job = CompactionJob {
            id: "job-m".to_string(),
            session_id: "s1".to_string(),
            scope: MemoryScope::Char,
            status: CompactionStatus::Done,
            scanned_events: 3,
            merged_groups: 1,
            replaced_events: 2,
            created_events: 1,
            created_at: Utc::now(),
            finished_at: Some(Utc::now()),
        };
        repo.create_compaction_job(&job).await.unwrap();

        let members = vec![
            CompactionMember {
                id: "cm1".to_string(),
                job_id: "job-m".to_string(),
                original_event_id: "old1".to_string(),
                new_event_id: "new1".to_string(),
            },
            CompactionMember {
                id: "cm2".to_string(),
                job_id: "job-m".to_string(),
                original_event_id: "old2".to_string(),
                new_event_id: "new1".to_string(),
            },
        ];
        repo.add_compaction_members(&members).await.unwrap();
        // No assertion needed — if it didn't panic/error, the insert worked.
    }

    // =================================================================
    // get_all_events
    // =================================================================

    #[tokio::test]
    async fn get_all_events_filters_correctly() {
        let repo = make_repo().await;
        repo.insert_event(&make_event(
            "ga1",
            "s1",
            MemoryScope::Char,
            "ep1",
            0,
            "c",
            &[1.0],
        ))
        .await
        .unwrap();
        repo.insert_event(&make_event(
            "ga2",
            "s1",
            MemoryScope::Prof,
            "ep2",
            0,
            "p",
            &[1.0],
        ))
        .await
        .unwrap();
        repo.insert_event(&make_event(
            "ga3",
            "s2",
            MemoryScope::Char,
            "ep3",
            0,
            "c2",
            &[1.0],
        ))
        .await
        .unwrap();

        // All
        assert_eq!(repo.get_all_events(None, None).await.unwrap().len(), 3);
        // By session
        assert_eq!(
            repo.get_all_events(Some("s1"), None).await.unwrap().len(),
            2
        );
        // By scope
        assert_eq!(
            repo.get_all_events(None, Some(MemoryScope::Char))
                .await
                .unwrap()
                .len(),
            2
        );
        // By both
        assert_eq!(
            repo.get_all_events(Some("s1"), Some(MemoryScope::Char))
                .await
                .unwrap()
                .len(),
            1
        );
    }
}
