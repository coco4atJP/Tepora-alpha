// Agentic Search Node
// 4-stage pipeline with RAG-centric retrieval and artifact accumulation.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::context::pipeline::ContextPipeline;
use crate::context::pipeline_context::{PipelineContext, PipelineMode, PipelineStage, RagChunk};
use crate::graph::node::{GraphError, Node, NodeContext, NodeOutput};
use crate::graph::state::{AgentState, Artifact};
use crate::llm::ChatRequest;
use crate::rag::{ChunkSearchResult, StoredChunk};
use crate::search::{EvidenceClaim, EvidenceGap, SearchEvidenceState, SearchMode};
use crate::tools::execute_tool;
use crate::tools::search::SearchResult;

use super::search_agentic_support::{
    build_explored_sources, build_final_constraints, build_report_brief,
    build_selected_chunk_briefs, dedupe_search_results, parse_json_payload,
    render_query_plan_brief, render_report_brief, render_selected_chunk_briefs,
    shared_artifacts_to_pipeline, sub_query_structured_spec, truncate_text, RagArtifactChunk,
    ReportBrief, SelectedChunkBrief,
};

pub struct AgenticSearchNode;

impl AgenticSearchNode {
    pub fn new() -> Self {
        Self
    }
}

impl Default for AgenticSearchNode {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Node for AgenticSearchNode {
    fn id(&self) -> &'static str {
        "search_agentic"
    }

    fn name(&self) -> &'static str {
        "Agentic Search"
    }

    async fn execute(
        &self,
        state: &mut AgentState,
        ctx: &mut NodeContext<'_>,
    ) -> Result<NodeOutput, GraphError> {
        let should_rebuild = state
            .pipeline_context
            .as_ref()
            .map(|pipeline| pipeline.mode != PipelineMode::SearchAgentic)
            .unwrap_or(true);
        if should_rebuild {
            let app_state = Arc::new(ctx.app_state.clone());
            let pipeline_ctx = ContextPipeline::build_v4(
                &app_state,
                &state.session_id,
                &state.input,
                PipelineMode::SearchAgentic,
                true,
            )
            .await
            .map_err(|err| GraphError::new(self.id(), err.to_string()))?;
            state.pipeline_context = Some(pipeline_ctx);
        }

        self.send_activity(
            ctx,
            "agentic_query_gen",
            "processing",
            "Generating search sub-queries...",
        )
        .await;

        let sub_queries = self.generate_sub_queries(state, ctx).await?;
        state.search_queries = sub_queries.clone();
        state.shared_context.artifacts.push(Artifact {
            artifact_type: "query_plan_brief".to_string(),
            content: render_query_plan_brief(&sub_queries),
            metadata: HashMap::from([(
                "queries".to_string(),
                serde_json::to_value(&sub_queries).unwrap_or(Value::Null),
            )]),
        });

        self.send_activity(
            ctx,
            "agentic_query_gen",
            "done",
            format!("Generated {} sub-queries", sub_queries.len()),
        )
        .await;

        self.send_activity(
            ctx,
            "agentic_chunk_select",
            "processing",
            "Collecting and selecting relevant chunks...",
        )
        .await;

        let (selected_chunks, display_results) =
            self.search_and_select(state, ctx, &sub_queries).await?;
        let chunk_briefs = build_selected_chunk_briefs(&selected_chunks);

        state.search_results = Some(display_results.clone());
        state.search_evidence = SearchEvidenceState {
            strategy: SearchMode::Deep,
            query_plan: sub_queries.clone(),
            explored_sources: build_explored_sources(
                &state.search_attachments,
                ctx.config
                    .get("privacy")
                    .and_then(|v| v.get("allow_web_search"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
                    && !state.skip_web_search
                    && !ctx
                        .config
                        .get("privacy")
                        .and_then(|v| v.get("isolation_mode"))
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false),
            ),
            results: display_results.clone(),
            claims: chunk_briefs
                .iter()
                .map(|brief| EvidenceClaim {
                    topic: brief.source.clone(),
                    summary: brief.claim.clone(),
                    citations: vec![brief.chunk_id.clone(), brief.source.clone()],
                    confidence: brief.evidence_strength,
                })
                .collect(),
            gaps: Vec::new(),
        };
        let _ = ctx
            .sender
            .send_json(json!({ "type": "search_results", "data": display_results }))
            .await;

        let chunk_ids = selected_chunks
            .iter()
            .map(|chunk| Value::String(chunk.chunk_id.clone()))
            .collect::<Vec<_>>();
        let sources = selected_chunks
            .iter()
            .map(|chunk| Value::String(chunk.source.clone()))
            .collect::<Vec<_>>();

        let mut metadata = HashMap::new();
        metadata.insert("chunk_ids".to_string(), Value::Array(chunk_ids));
        metadata.insert("sources".to_string(), Value::Array(sources));
        metadata.insert(
            "query_count".to_string(),
            Value::Number(serde_json::Number::from(sub_queries.len() as u64)),
        );
        metadata.insert(
            "briefs".to_string(),
            serde_json::to_value(
                chunk_briefs
                    .iter()
                    .map(|brief| {
                        json!({
                            "source": brief.source,
                            "chunk_id": brief.chunk_id,
                            "claim": brief.claim,
                            "evidence_strength": brief.evidence_strength,
                        })
                    })
                    .collect::<Vec<_>>(),
            )
            .unwrap_or(Value::Null),
        );

        state.shared_context.artifacts.push(Artifact {
            artifact_type: "selected_chunk_briefs".to_string(),
            content: render_selected_chunk_briefs(&chunk_briefs),
            metadata,
        });

        self.send_activity(
            ctx,
            "agentic_chunk_select",
            "done",
            format!("Selected {} chunks", selected_chunks.len()),
        )
        .await;

        self.send_activity(
            ctx,
            "agentic_report",
            "processing",
            "Generating artifact report...",
        )
        .await;

        let report = self.generate_report(state, ctx, &selected_chunks).await?;
        let report_brief = build_report_brief(&report, &chunk_briefs);
        state.search_evidence.gaps = report_brief
            .open_uncertainties
            .iter()
            .map(|item| EvidenceGap {
                topic: state.input.clone(),
                reason: item.clone(),
            })
            .collect();

        state.shared_context.artifacts.push(Artifact {
            artifact_type: "report_brief".to_string(),
            content: render_report_brief(&report_brief),
            metadata: HashMap::from([
                (
                    "key_findings".to_string(),
                    serde_json::to_value(&report_brief.key_findings).unwrap_or(Value::Null),
                ),
                (
                    "open_uncertainties".to_string(),
                    serde_json::to_value(&report_brief.open_uncertainties).unwrap_or(Value::Null),
                ),
                (
                    "citation_map".to_string(),
                    serde_json::to_value(&report_brief.citation_map).unwrap_or(Value::Null),
                ),
            ]),
        });
        state.shared_context.artifacts.push(Artifact {
            artifact_type: "final_constraints".to_string(),
            content: build_final_constraints(&state.input),
            metadata: HashMap::new(),
        });

        self.send_activity(ctx, "agentic_report", "done", "Research report complete")
            .await;

        self.send_activity(
            ctx,
            "agentic_synthesize",
            "processing",
            "Synthesizing final answer...",
        )
        .await;

        let final_answer = self
            .synthesize_answer(state, ctx, &chunk_briefs, &report_brief)
            .await?;

        self.send_activity(ctx, "agentic_synthesize", "done", "Answer synthesized")
            .await;

        let _ = ctx.sender.send_json(json!({"type": "done"})).await;

        state.output = Some(final_answer);
        Ok(NodeOutput::Final)
    }
}

impl AgenticSearchNode {
    async fn generate_sub_queries(
        &self,
        state: &AgentState,
        ctx: &mut NodeContext<'_>,
    ) -> Result<Vec<String>, GraphError> {
        let messages = if let Some(pipeline_ctx) = state.pipeline_context.as_ref() {
            let mut staged = pipeline_ctx.clone();
            staged.stage = PipelineStage::SearchQueryGenerate;
            staged.add_system_part(
                "query_generation_instruction",
                concat!(
                    "You are a search query decomposition expert. ",
                    "Generate 2-4 focused search sub-queries that jointly cover the user request. ",
                    "Return only the structured sub-query array."
                ),
                130,
            );
            staged.to_messages()
        } else {
            vec![crate::llm::ChatMessage {
                role: "user".to_string(),
                content: state.input.clone(),
                multimodal_parts: None,
            }]
        };

        let model_id = self.resolve_model_id_best_effort(ctx);

        let request = ChatRequest::new(messages)
            .with_config(ctx.config)
            .with_structured_response(sub_query_structured_spec());
        let parsed = ctx
            .app_state
            .ai()
            .llm
            .chat_structured::<Vec<String>>(request, &model_id)
            .await
            .map_err(|err| {
                GraphError::new(self.id(), format!("sub-query generation failed: {err}"))
            })?;

        let mut queries = vec![state.input.clone()];
        for query in parsed {
            let query = query.trim().to_string();
            if !query.is_empty() && !queries.iter().any(|existing| existing == &query) {
                queries.push(query);
            }
        }
        queries.truncate(5);
        Ok(queries)
    }

    async fn search_and_select(
        &self,
        state: &AgentState,
        ctx: &mut NodeContext<'_>,
        sub_queries: &[String],
    ) -> Result<(Vec<RagArtifactChunk>, Vec<SearchResult>), GraphError> {
        let mut merged: HashMap<String, RagArtifactChunk> = HashMap::new();

        for query in sub_queries {
            self.merge_similarity_results(state, ctx, query, &mut merged)
                .await?;
            self.merge_text_results(state, ctx, query, &mut merged)
                .await?;
        }

        let web_results = if self.can_use_web_search(state, ctx) {
            self.collect_web_results(state, ctx, sub_queries).await
        } else {
            Vec::new()
        };

        self.merge_similarity_results(state, ctx, &state.input, &mut merged)
            .await?;

        let mut ranked = merged.into_values().collect::<Vec<_>>();
        ranked.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        self.expand_chunk_windows(state, ctx, &mut ranked).await;

        let display_results = ranked
            .iter()
            .take(15)
            .map(|chunk| SearchResult {
                title: format!("RAG Chunk {}", chunk.chunk_id),
                url: chunk.source.clone(),
                snippet: truncate_text(&chunk.content, 240),
            })
            .collect::<Vec<_>>();

        Ok((ranked, dedupe_search_results(web_results, display_results)))
    }

    fn can_use_web_search(&self, state: &AgentState, ctx: &NodeContext<'_>) -> bool {
        ctx.config
            .get("privacy")
            .and_then(|v| v.get("allow_web_search"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
            && !state.skip_web_search
            && !ctx
                .config
                .get("privacy")
                .and_then(|v| v.get("isolation_mode"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
    }

    async fn collect_web_results(
        &self,
        state: &AgentState,
        ctx: &mut NodeContext<'_>,
        sub_queries: &[String],
    ) -> Vec<SearchResult> {
        let mut web_results = Vec::new();

        for query in sub_queries.iter().take(3) {
            let search = execute_tool(
                Some(ctx.app_state),
                ctx.config,
                Some(&ctx.app_state.integration.mcp),
                Some(&state.session_id),
                "native_search",
                &json!({ "query": query, "limit": 5 }),
            )
            .await;

            let Ok(search) = search else {
                continue;
            };

            if let Some(results) = search.search_results {
                for result in results.iter().take(2) {
                    web_results.push(result.clone());
                    self.ingest_web_result(state, ctx, query, result).await;
                }
            }
        }

        web_results
    }

    async fn ingest_web_result(
        &self,
        state: &AgentState,
        ctx: &mut NodeContext<'_>,
        query: &str,
        result: &SearchResult,
    ) {
        let fetched = execute_tool(
            Some(ctx.app_state),
            ctx.config,
            Some(&ctx.app_state.integration.mcp),
            Some(&state.session_id),
            "native_web_fetch",
            &json!({ "url": result.url }),
        )
        .await;

        let Ok(fetched) = fetched else {
            return;
        };
        if fetched.output.trim().is_empty() {
            return;
        }

        let _ = execute_tool(
            Some(ctx.app_state),
            ctx.config,
            Some(&ctx.app_state.integration.mcp),
            Some(&state.session_id),
            "native_rag_ingest",
            &json!({
                "content": fetched.output,
                "source": result.url,
                "metadata": {
                    "title": result.title,
                    "snippet": result.snippet,
                    "query": query,
                }
            }),
        )
        .await;
    }

    async fn expand_chunk_windows(
        &self,
        state: &AgentState,
        ctx: &NodeContext<'_>,
        ranked: &mut [RagArtifactChunk],
    ) {
        for chunk in ranked.iter_mut().take(5) {
            let window = execute_tool(
                Some(ctx.app_state),
                ctx.config,
                Some(&ctx.app_state.integration.mcp),
                Some(&state.session_id),
                "native_rag_get_chunk_window",
                &json!({
                    "chunk_id": chunk.chunk_id,
                    "chars": 1500,
                }),
            )
            .await;

            let Ok(window) = window else {
                continue;
            };
            let Some(window_chunks) = parse_json_payload::<Vec<StoredChunk>>(&window.output) else {
                continue;
            };
            if window_chunks.is_empty() {
                continue;
            }

            let merged_text = window_chunks
                .iter()
                .map(|item| item.content.as_str())
                .collect::<Vec<_>>()
                .join("\n\n");
            if !merged_text.trim().is_empty() {
                chunk.content = merged_text;
            }
        }
    }

    async fn merge_similarity_results(
        &self,
        state: &AgentState,
        ctx: &NodeContext<'_>,
        query: &str,
        merged: &mut HashMap<String, RagArtifactChunk>,
    ) -> Result<(), GraphError> {
        let result = execute_tool(
            Some(ctx.app_state),
            ctx.config,
            Some(&ctx.app_state.integration.mcp),
            Some(&state.session_id),
            "native_rag_search",
            &json!({ "query": query, "limit": 12 }),
        )
        .await
        .map_err(|err| GraphError::new(self.id(), err.to_string()))?;

        let Some(chunks) = parse_json_payload::<Vec<ChunkSearchResult>>(&result.output) else {
            return Ok(());
        };

        for item in chunks {
            let entry = merged
                .entry(item.chunk.chunk_id.clone())
                .or_insert_with(|| RagArtifactChunk {
                    chunk_id: item.chunk.chunk_id.clone(),
                    source: item.chunk.source.clone(),
                    content: item.chunk.content.clone(),
                    score: item.score,
                });

            if item.score > entry.score {
                entry.score = item.score;
                entry.source = item.chunk.source;
                entry.content = item.chunk.content;
            }
        }

        Ok(())
    }

    async fn merge_text_results(
        &self,
        state: &AgentState,
        ctx: &NodeContext<'_>,
        query: &str,
        merged: &mut HashMap<String, RagArtifactChunk>,
    ) -> Result<(), GraphError> {
        let result = execute_tool(
            Some(ctx.app_state),
            ctx.config,
            Some(&ctx.app_state.integration.mcp),
            Some(&state.session_id),
            "native_rag_text_search",
            &json!({ "pattern": query, "limit": 12 }),
        )
        .await
        .map_err(|err| GraphError::new(self.id(), err.to_string()))?;

        let Some(chunks) = parse_json_payload::<Vec<StoredChunk>>(&result.output) else {
            return Ok(());
        };

        for chunk in chunks {
            merged
                .entry(chunk.chunk_id.clone())
                .or_insert_with(|| RagArtifactChunk {
                    chunk_id: chunk.chunk_id,
                    source: chunk.source,
                    content: chunk.content,
                    score: 0.45,
                });
        }

        Ok(())
    }

    async fn generate_report(
        &self,
        state: &AgentState,
        ctx: &mut NodeContext<'_>,
        chunks: &[RagArtifactChunk],
    ) -> Result<String, GraphError> {
        if chunks.is_empty() {
            return Ok("No RAG chunks available for report generation.".to_string());
        }

        let mut stage_ctx = self
            .build_shared_stage_context(state, ctx, PipelineStage::SearchReportBuild)
            .await?;
        stage_ctx.rag_chunks = self.pipeline_rag_chunks(chunks);

        stage_ctx.add_system_part(
            "report_generation_instruction",
            concat!(
                "You are a research analyst. ",
                "Generate a concise, evidence-grounded report from chunk artifacts.\n",
                "1. Summarize key findings\n",
                "2. Note uncertainties or conflicts\n",
                "3. Reference chunk IDs as [chunk_id]\n",
                "4. Use the user's language"
            )
            .to_string(),
            130,
        );
        stage_ctx.add_artifact(
            "selected_chunk_sources",
            self.render_selected_chunk_sources(chunks),
            HashMap::new(),
        );

        let messages = stage_ctx.to_messages();

        let model_id = self.resolve_model_id_best_effort(ctx);

        let request = ChatRequest::new(messages).with_config(ctx.config);
        ctx.app_state
            .ai()
            .llm
            .chat(request, &model_id)
            .await
            .map_err(|err| GraphError::new(self.id(), format!("report generation failed: {err}")))
    }

    async fn synthesize_answer(
        &self,
        state: &AgentState,
        ctx: &mut NodeContext<'_>,
        chunk_briefs: &[SelectedChunkBrief],
        report_brief: &ReportBrief,
    ) -> Result<String, GraphError> {
        let mut stage_ctx = self
            .build_shared_stage_context(state, ctx, PipelineStage::SearchFinalSynthesis)
            .await?;
        self.attach_final_synthesis_inputs(&mut stage_ctx, chunk_briefs, report_brief);

        let messages = stage_ctx.to_messages();

        let model_id = self.resolve_model_id(ctx)?;

        let request = ChatRequest::new(messages).with_config(ctx.config);
        let mut stream = ctx
            .app_state
            .ai()
            .llm
            .stream_chat_normalized(request, &model_id)
            .await
            .map_err(|err| GraphError::new(self.id(), err.to_string()))?;

        let mut full_response = String::new();
        while let Some(chunk_result) = stream.recv().await {
            match chunk_result {
                Ok(chunk) => {
                    if !chunk.model_thinking.is_empty() {
                        let _ = ctx
                            .sender
                            .send_json(json!({
                                "type": "thought",
                                "content": chunk.model_thinking,
                                "mode": "search",
                            }))
                            .await;
                    }

                    if chunk.visible_text.is_empty() {
                        continue;
                    }
                    full_response.push_str(&chunk.visible_text);
                    let _ = ctx
                        .sender
                        .send_json(json!({
                            "type": "chunk",
                            "message": chunk.visible_text,
                            "mode": "search",
                        }))
                        .await;
                }
                Err(err) => {
                    return Err(GraphError::new(self.id(), err.to_string()));
                }
            }
        }

        Ok(full_response)
    }

    async fn build_stage_context(
        &self,
        state: &AgentState,
        ctx: &NodeContext<'_>,
        stage: PipelineStage,
    ) -> Result<PipelineContext, GraphError> {
        if let Some(base_ctx) = state.pipeline_context.as_ref() {
            let mut staged = base_ctx.clone();
            staged.stage = stage;
            staged.user_input = state.input.clone();
            return Ok(staged);
        }

        let app_state = Arc::new(ctx.app_state.clone());
        ContextPipeline::build_v4(
            &app_state,
            &state.session_id,
            &state.input,
            PipelineMode::SearchAgentic,
            true,
        )
        .await
        .map(|mut pipeline_ctx| {
            pipeline_ctx.stage = stage;
            pipeline_ctx
        })
        .map_err(|err| GraphError::new(self.id(), err.to_string()))
    }

    async fn build_shared_stage_context(
        &self,
        state: &AgentState,
        ctx: &NodeContext<'_>,
        stage: PipelineStage,
    ) -> Result<PipelineContext, GraphError> {
        let mut stage_ctx = self.build_stage_context(state, ctx, stage).await?;
        stage_ctx.artifacts = shared_artifacts_to_pipeline(&state.shared_context.artifacts);
        Ok(stage_ctx)
    }

    fn pipeline_rag_chunks(&self, chunks: &[RagArtifactChunk]) -> Vec<RagChunk> {
        chunks
            .iter()
            .map(|chunk| RagChunk {
                chunk_id: chunk.chunk_id.clone(),
                content: chunk.content.clone(),
                source: chunk.source.clone(),
                score: chunk.score,
                metadata: HashMap::new(),
            })
            .collect()
    }

    fn render_selected_chunk_sources(&self, chunks: &[RagArtifactChunk]) -> String {
        chunks
            .iter()
            .take(20)
            .enumerate()
            .map(|(index, chunk)| {
                format!(
                    "[{}] chunk_id={} source={} score={:.3}\n{}",
                    index + 1,
                    chunk.chunk_id,
                    chunk.source,
                    chunk.score,
                    chunk.content
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    fn attach_final_synthesis_inputs(
        &self,
        stage_ctx: &mut PipelineContext,
        chunk_briefs: &[SelectedChunkBrief],
        report_brief: &ReportBrief,
    ) {
        stage_ctx.add_system_part(
            "final_synthesis_instruction",
            concat!(
                "You have completed deep research. ",
                "Use the context bundle to provide the final user-facing answer.\n",
                "Do not assume you can inspect raw chunks or a full report.\n",
                "Keep citations tied to chunk IDs or source URLs when possible."
            )
            .to_string(),
            130,
        );
        stage_ctx.add_artifact(
            "selected_chunk_briefs",
            render_selected_chunk_briefs(chunk_briefs),
            HashMap::new(),
        );
        stage_ctx.add_artifact(
            "report_brief",
            render_report_brief(report_brief),
            HashMap::new(),
        );
    }

    fn configured_active_profile<'a>(&self, ctx: &'a NodeContext<'_>) -> Option<&'a str> {
        ctx.config
            .get("active_character")
            .or_else(|| ctx.config.get("active_agent_profile"))
            .and_then(|v| v.as_str())
    }

    fn resolve_model_id_best_effort(&self, ctx: &NodeContext<'_>) -> String {
        ctx.app_state
            .ai()
            .models
            .resolve_character_model_id(self.configured_active_profile(ctx))
            .ok()
            .flatten()
            .unwrap_or_else(|| "default".to_string())
    }

    fn resolve_model_id(&self, ctx: &NodeContext<'_>) -> Result<String, GraphError> {
        ctx.app_state
            .ai()
            .models
            .resolve_character_model_id(self.configured_active_profile(ctx))
            .map_err(|err| GraphError::new(self.id(), err.to_string()))
            .map(|model_id| model_id.unwrap_or_else(|| "default".to_string()))
    }

    async fn send_activity(
        &self,
        ctx: &mut NodeContext<'_>,
        activity_id: &str,
        status: &str,
        message: impl Into<String>,
    ) {
        let _ = ctx
            .sender
            .send_json(json!({
                "type": "activity",
                "data": {
                    "id": activity_id,
                    "status": status,
                    "message": message.into(),
                    "agentName": self.name(),
                }
            }))
            .await;
    }
}
