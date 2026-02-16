//! ContextWorker trait and WorkerPipeline execution engine.
//!
//! Workers are composable units that each enrich a `PipelineContext` with one
//! type of context (system prompt, persona, memory, tools, search, RAG, …).
//! `WorkerPipeline` chains them together and executes them sequentially.

use std::sync::Arc;

use async_trait::async_trait;
use thiserror::Error;

use super::pipeline_context::PipelineContext;
use crate::state::AppState;

// ---------------------------------------------------------------------------
// WorkerError
// ---------------------------------------------------------------------------

#[derive(Debug, Error)]
pub enum WorkerError {
    #[error("Worker '{name}' failed: {message}")]
    ExecutionFailed { name: String, message: String },

    #[error("Worker '{name}' skipped: {reason}")]
    Skipped { name: String, reason: String },

    #[error("Worker '{name}' retryable failure: {message}")]
    Retryable { name: String, message: String },
}

impl WorkerError {
    pub fn failed(name: impl Into<String>, message: impl Into<String>) -> Self {
        Self::ExecutionFailed {
            name: name.into(),
            message: message.into(),
        }
    }

    pub fn skipped(name: impl Into<String>, reason: impl Into<String>) -> Self {
        Self::Skipped {
            name: name.into(),
            reason: reason.into(),
        }
    }

    pub fn retryable(name: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Retryable {
            name: name.into(),
            message: message.into(),
        }
    }

    /// Whether this error is retryable.
    pub fn is_retryable(&self) -> bool {
        matches!(self, Self::Retryable { .. })
    }

    /// Whether this error is a skip (non-fatal).
    pub fn is_skip(&self) -> bool {
        matches!(self, Self::Skipped { .. })
    }
}

// ---------------------------------------------------------------------------
// ContextWorker Trait
// ---------------------------------------------------------------------------

/// A single unit of context enrichment.
///
/// Implementations mutate the provided `PipelineContext` in place, e.g. by
/// adding system prompt parts, persona config, memory chunks, etc.
#[async_trait]
pub trait ContextWorker: Send + Sync {
    /// Unique name for logging / diagnostics.
    fn name(&self) -> &str;

    /// Execute this worker, enriching `ctx`.
    async fn execute(
        &self,
        ctx: &mut PipelineContext,
        state: &Arc<AppState>,
    ) -> Result<(), WorkerError>;
}

// ---------------------------------------------------------------------------
// WorkerPipeline
// ---------------------------------------------------------------------------

/// Configuration for the worker pipeline execution.
#[derive(Debug, Clone)]
pub struct PipelineConfig {
    /// Maximum retries for retryable worker failures.
    pub max_retries: usize,
    /// Whether to continue on non-fatal (skip) errors.
    pub continue_on_skip: bool,
}

impl Default for PipelineConfig {
    fn default() -> Self {
        Self {
            max_retries: 2,
            continue_on_skip: true,
        }
    }
}

/// Chains multiple `ContextWorker`s and executes them sequentially.
pub struct WorkerPipeline {
    workers: Vec<Box<dyn ContextWorker>>,
    config: PipelineConfig,
}

impl WorkerPipeline {
    pub fn new() -> Self {
        Self {
            workers: Vec::new(),
            config: PipelineConfig::default(),
        }
    }

    pub fn with_config(mut self, config: PipelineConfig) -> Self {
        self.config = config;
        self
    }

    /// Add a worker to the end of the pipeline.
    pub fn add_worker(mut self, worker: Box<dyn ContextWorker>) -> Self {
        self.workers.push(worker);
        self
    }

    /// Execute all workers in order, enriching the given `PipelineContext`.
    ///
    /// - **Retryable** errors are retried up to `max_retries` times.
    /// - **Skipped** errors are logged and optionally continued.
    /// - **Fatal** errors abort the pipeline immediately.
    pub async fn run(
        &self,
        ctx: &mut PipelineContext,
        state: &Arc<AppState>,
    ) -> Result<(), WorkerError> {
        for worker in &self.workers {
            let mut attempts = 0;

            loop {
                match worker.execute(ctx, state).await {
                    Ok(()) => {
                        tracing::debug!("Worker '{}' completed successfully", worker.name());
                        break;
                    }
                    Err(e) if e.is_skip() => {
                        tracing::info!("Worker '{}' skipped: {}", worker.name(), e);
                        if self.config.continue_on_skip {
                            break;
                        } else {
                            return Err(e);
                        }
                    }
                    Err(e) if e.is_retryable() && attempts < self.config.max_retries => {
                        attempts += 1;
                        tracing::warn!(
                            "Worker '{}' retryable error (attempt {}/{}): {}",
                            worker.name(),
                            attempts,
                            self.config.max_retries,
                            e
                        );
                        continue;
                    }
                    Err(e) => {
                        tracing::error!("Worker '{}' failed fatally: {}", worker.name(), e);
                        return Err(e);
                    }
                }
            }
        }

        Ok(())
    }

    /// Number of workers in the pipeline.
    pub fn len(&self) -> usize {
        self.workers.len()
    }

    /// Whether the pipeline has no workers.
    pub fn is_empty(&self) -> bool {
        self.workers.is_empty()
    }
}

impl Default for WorkerPipeline {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// A test worker that always succeeds and adds a system part.
    struct SuccessWorker;

    #[async_trait]
    impl ContextWorker for SuccessWorker {
        fn name(&self) -> &str {
            "success"
        }

        async fn execute(
            &self,
            ctx: &mut PipelineContext,
            _state: &Arc<AppState>,
        ) -> Result<(), WorkerError> {
            ctx.add_system_part("test", "成功しました", 50);
            Ok(())
        }
    }

    /// A test worker that always skips.
    struct SkipWorker;

    #[async_trait]
    impl ContextWorker for SkipWorker {
        fn name(&self) -> &str {
            "skip"
        }

        async fn execute(
            &self,
            _ctx: &mut PipelineContext,
            _state: &Arc<AppState>,
        ) -> Result<(), WorkerError> {
            Err(WorkerError::skipped("skip", "not needed"))
        }
    }

    /// A test worker that always fails.
    struct FailWorker;

    #[async_trait]
    impl ContextWorker for FailWorker {
        fn name(&self) -> &str {
            "fail"
        }

        async fn execute(
            &self,
            _ctx: &mut PipelineContext,
            _state: &Arc<AppState>,
        ) -> Result<(), WorkerError> {
            Err(WorkerError::failed("fail", "critical failure"))
        }
    }

    #[test]
    fn test_worker_error_traits() {
        let retryable = WorkerError::retryable("w1", "transient");
        assert!(retryable.is_retryable());
        assert!(!retryable.is_skip());

        let skip = WorkerError::skipped("w2", "not needed");
        assert!(skip.is_skip());
        assert!(!skip.is_retryable());

        let fatal = WorkerError::failed("w3", "bad");
        assert!(!fatal.is_retryable());
        assert!(!fatal.is_skip());
    }

    #[test]
    fn test_pipeline_builder() {
        let pipeline = WorkerPipeline::new()
            .add_worker(Box::new(SuccessWorker))
            .add_worker(Box::new(SkipWorker));

        assert_eq!(pipeline.len(), 2);
        assert!(!pipeline.is_empty());
    }
}
