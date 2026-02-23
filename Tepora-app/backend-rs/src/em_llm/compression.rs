use serde::Serialize;

use crate::core::errors::ApiError;
use crate::em_llm::store::{EmMemoryStore, MemoryEventRecord};
use crate::em_llm::types::MemoryLayer;
use crate::llm::{ChatMessage, ChatRequest, LlmService};
use crate::memory_v2::types::{MemoryEvent, MemoryLayer as V2MemoryLayer};
use crate::memory_v2::repository::MemoryRepository;

/// Result of a user-triggered memory compression run.
#[derive(Debug, Clone, Serialize)]
pub struct CompressionResult {
    pub scanned_events: usize,
    pub merged_groups: usize,
    pub replaced_events: usize,
    pub created_events: usize,
}

/// Memory compression engine (explicitly user-triggered).
#[derive(Debug, Clone)]
pub struct MemoryCompressor {
    similarity_threshold: f32,
}

impl Default for MemoryCompressor {
    fn default() -> Self {
        Self {
            similarity_threshold: 0.9,
        }
    }
}

impl MemoryCompressor {
    pub fn new(similarity_threshold: f32) -> Self {
        Self {
            similarity_threshold,
        }
    }

    /// Execute compression for one session.
    pub async fn compress(
        &self,
        session_id: &str,
        store: &EmMemoryStore,
        llm: &LlmService,
        model_id: &str,
    ) -> Result<CompressionResult, ApiError> {
        let events = store.get_all_events_with_metadata(Some(session_id)).await?;
        if events.len() < 2 {
            return Ok(CompressionResult {
                scanned_events: events.len(),
                merged_groups: 0,
                replaced_events: 0,
                created_events: 0,
            });
        }

        let groups = self.build_candidate_groups(&events);
        let mut merged_groups = 0usize;
        let mut replaced_events = 0usize;
        let mut created_events = 0usize;

        for group in groups {
            if group.len() < 2 {
                continue;
            }

            let selected = group
                .into_iter()
                .map(|idx| events[idx].clone())
                .collect::<Vec<_>>();

            let merged_content = match self.fuse_group_with_llm(&selected, llm, model_id).await {
                Ok(text) if !text.trim().is_empty() => text,
                Ok(_) => fallback_merge_content(&selected),
                Err(err) => {
                    tracing::warn!(
                        "Memory compression LLM step failed; using fallback merge: {}",
                        err
                    );
                    fallback_merge_content(&selected)
                }
            };

            let merged_embedding = average_embedding(&selected);
            if merged_embedding.is_empty() {
                continue;
            }

            let new_id = uuid::Uuid::new_v4().to_string();
            store
                .insert_event(
                    &new_id,
                    session_id,
                    "[compressed]",
                    "[compressed]",
                    &merged_content,
                    &merged_embedding,
                )
                .await?;

            let mean_strength =
                selected.iter().map(|e| e.strength).sum::<f64>() / selected.len() as f64;
            store.update_memory_strength(&new_id, mean_strength).await?;

            let merged_layer = if selected.iter().any(|e| e.memory_layer == MemoryLayer::LML) {
                MemoryLayer::LML
            } else {
                MemoryLayer::SML
            };
            store.update_memory_layer(&new_id, merged_layer).await?;

            let old_ids = selected.iter().map(|e| e.id.clone()).collect::<Vec<_>>();
            let deleted = store.delete_events_by_ids(&old_ids).await?;

            merged_groups += 1;
            replaced_events += deleted;
            created_events += 1;
        }

        Ok(CompressionResult {
            scanned_events: events.len(),
            merged_groups,
            replaced_events,
            created_events,
        })
    }

    fn build_candidate_groups(&self, events: &[MemoryEventRecord]) -> Vec<Vec<usize>> {
        let mut used = vec![false; events.len()];
        let mut groups = Vec::new();

        for i in 0..events.len() {
            if used[i] {
                continue;
            }

            let mut group = vec![i];
            for j in (i + 1)..events.len() {
                if used[j] {
                    continue;
                }

                let similarity = cosine_similarity(&events[i].embedding, &events[j].embedding);
                if similarity >= self.similarity_threshold {
                    group.push(j);
                }
            }

            if group.len() >= 2 {
                for idx in &group {
                    used[*idx] = true;
                }
                groups.push(group);
            }
        }

        groups
    }

    async fn fuse_group_with_llm(
        &self,
        group: &[MemoryEventRecord],
        llm: &LlmService,
        model_id: &str,
    ) -> Result<String, ApiError> {
        let memory_text = group
            .iter()
            .enumerate()
            .map(|(idx, event)| format!("[{}] {}", idx + 1, event.content))
            .collect::<Vec<_>>()
            .join("\n\n");

        let messages = vec![
            ChatMessage {
                role: "system".to_string(),
                content: "あなたは会話メモリ圧縮エンジンです。重複や表現揺れを統合し、矛盾がある場合は最新情報を優先してください。".to_string(),
            },
            ChatMessage {
                role: "user".to_string(),
                content: format!(
                    "以下のメモリ群を1つの短い統合メモリにまとめてください。事実は保持し、冗長性を除去してください。\n\n{}",
                    memory_text
                ),
            },
        ];

        let mut request = ChatRequest::new(messages);
        request.max_tokens = Some(256);
        llm.chat(request, model_id).await
    }

    pub async fn compress_v2(
        &self,
        session_id: &str,
        v2_store: &dyn MemoryRepository,
        llm: &LlmService,
        model_id: &str,
    ) -> Result<CompressionResult, ApiError> {
        let events = v2_store.get_all_events(Some(session_id), None).await?;
        if events.len() < 2 {
            return Ok(CompressionResult {
                scanned_events: events.len(),
                merged_groups: 0,
                replaced_events: 0,
                created_events: 0,
            });
        }

        let groups = self.build_candidate_groups_v2(&events);
        let mut merged_groups = 0usize;
        let mut replaced_events = 0usize;
        let mut created_events = 0usize;

        for group in groups {
            if group.len() < 2 {
                continue;
            }

            let selected = group
                .into_iter()
                .map(|idx| events[idx].clone())
                .collect::<Vec<_>>();

            let merged_content = match self.fuse_group_with_llm_v2(&selected, llm, model_id).await {
                Ok(text) if !text.trim().is_empty() => text,
                Ok(_) => fallback_merge_content_v2(&selected),
                Err(err) => {
                    tracing::warn!(
                        "Memory compression LLM step failed; using fallback merge: {}",
                        err
                    );
                    fallback_merge_content_v2(&selected)
                }
            };

            let merged_embedding = average_embedding_v2(&selected);
            if merged_embedding.is_empty() {
                continue;
            }

            let new_id = uuid::Uuid::new_v4().to_string();
            let mean_strength =
                selected.iter().map(|e| e.strength).sum::<f64>() / selected.len() as f64;
            let merged_layer = if selected.iter().any(|e| e.layer == V2MemoryLayer::LML) {
                V2MemoryLayer::LML
            } else {
                V2MemoryLayer::SML
            };
            let max_importance = selected.iter().map(|e| e.importance).fold(0.0, f64::max);
            let latest_anchor = selected.iter().map(|e| e.decay_anchor_at).max().unwrap_or_else(chrono::Utc::now);
            let first_scope = selected.first().map(|e| e.scope.clone()).unwrap_or_else(crate::memory_v2::types::MemoryScope::default);

            // In Phase 3, we simply insert a new synthesized MemoryEvent.
            // A genuine CompactionJob with provenance tracking is planned for Phase 4.
            let new_event = MemoryEvent {
                id: new_id.clone(),
                session_id: session_id.to_string(),
                scope: first_scope,
                episode_id: "[compressed]".to_string(),
                event_seq: 0,
                source_turn_id: None,
                source_role: Some(crate::memory_v2::types::SourceRole::System),
                content: merged_content,
                summary: None,
                embedding: merged_embedding,
                surprise_mean: None,
                surprise_max: None,
                importance: max_importance,
                strength: mean_strength,
                layer: merged_layer,
                access_count: 0,
                created_at: chrono::Utc::now(),
                updated_at: chrono::Utc::now(),
                last_accessed_at: Some(chrono::Utc::now()), // effectively touching it
                decay_anchor_at: latest_anchor,
                is_deleted: false,
            };

            v2_store.insert_events(&[new_event]).await?;

            let old_ids = selected.iter().map(|e| e.id.clone()).collect::<Vec<_>>();
            let deleted = v2_store.soft_delete_events(&old_ids).await?;

            merged_groups += 1;
            replaced_events += deleted;
            created_events += 1;
        }

        Ok(CompressionResult {
            scanned_events: events.len(),
            merged_groups,
            replaced_events,
            created_events,
        })
    }

    fn build_candidate_groups_v2(&self, events: &[MemoryEvent]) -> Vec<Vec<usize>> {
        let mut used = vec![false; events.len()];
        let mut groups = Vec::new();

        for i in 0..events.len() {
            if used[i] {
                continue;
            }

            let mut group = vec![i];
            for j in (i + 1)..events.len() {
                if used[j] {
                    continue;
                }

                let similarity = cosine_similarity(&events[i].embedding, &events[j].embedding);
                if similarity >= self.similarity_threshold {
                    group.push(j);
                }
            }

            if group.len() >= 2 {
                for idx in &group {
                    used[*idx] = true;
                }
                groups.push(group);
            }
        }

        groups
    }

    async fn fuse_group_with_llm_v2(
        &self,
        group: &[MemoryEvent],
        llm: &LlmService,
        model_id: &str,
    ) -> Result<String, ApiError> {
        let memory_text = group
            .iter()
            .enumerate()
            .map(|(idx, event)| format!("[{}][{}] {}", idx + 1, event.created_at.to_rfc3339(), event.content))
            .collect::<Vec<_>>()
            .join("\n\n");

        let messages = vec![
            ChatMessage {
                role: "system".to_string(),
                content: "あなたは会話記憶の統合エンジンです。\n与えられた複数の事象を分析し、以下の関係分類に基づいて統合してください：\n1. 互換 (Compatible): 同じ話題や事実を補完し合っている。情報を統合せよ。\n2. 包含 (Subsumes): 一方が他方の詳細を含んでいる。詳細な方を残せ。\n3. 矛盾 (Contradictory): 内容が対立している。タイムスタンプが新しい情報を「最新の事実」として優先し、古い内容を破棄せよ。\n\n分析過程は省き、最終的な【統合された事実のみのテキスト】を、文脈を損なわず簡潔な1つの段落で出力してください。".to_string(),
            },
            ChatMessage {
                role: "user".to_string(),
                content: format!(
                    "情報を分析・統合してください:\n\n{}",
                    memory_text
                ),
            },
        ];

        let mut request = ChatRequest::new(messages);
        request.max_tokens = Some(256);
        llm.chat(request, model_id).await
    }
}

fn fallback_merge_content(group: &[MemoryEventRecord]) -> String {
    group
        .iter()
        .map(|event| event.content.trim())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n---\n")
}

fn average_embedding(group: &[MemoryEventRecord]) -> Vec<f32> {
    let Some(first) = group.first() else {
        return Vec::new();
    };
    let dim = first.embedding.len();
    if dim == 0 || group.iter().any(|e| e.embedding.len() != dim) {
        return Vec::new();
    }

    let mut out = vec![0.0f32; dim];
    for event in group {
        for (i, value) in event.embedding.iter().enumerate() {
            out[i] += *value;
        }
    }
    let denom = group.len() as f32;
    for value in &mut out {
        *value /= denom;
    }
    out
}

fn fallback_merge_content_v2(group: &[MemoryEvent]) -> String {
    group
        .iter()
        .map(|event| event.content.trim())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n---\n")
}

fn average_embedding_v2(group: &[MemoryEvent]) -> Vec<f32> {
    let Some(first) = group.first() else {
        return Vec::new();
    };
    let dim = first.embedding.len();
    if dim == 0 || group.iter().any(|e| e.embedding.len() != dim) {
        return Vec::new();
    }

    let mut out = vec![0.0f32; dim];
    for event in group {
        for (i, value) in event.embedding.iter().enumerate() {
            out[i] += *value;
        }
    }
    let denom = group.len() as f32;
    for value in &mut out {
        *value /= denom;
    }
    out
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }

    let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    let denom = norm_a * norm_b;

    if denom <= f32::EPSILON {
        0.0
    } else {
        dot / denom
    }
}
