use thiserror::Error;

#[derive(Debug, Error)]
pub enum InitializationError {
    #[error("Failed to initialize history store: {0}")]
    History(#[source] anyhow::Error),

    #[error("Failed to initialize RAG store: {0}")]
    Rag(#[source] anyhow::Error),

    #[error("Failed to initialize EM Memory service: {0}")]
    EmMemory(#[source] anyhow::Error),

    #[error("Failed to build agent graph: {0}")]
    Graph(#[source] anyhow::Error),

    #[error("Failed to initialize LLM service: {0}")]
    Llm(#[source] anyhow::Error),
}
