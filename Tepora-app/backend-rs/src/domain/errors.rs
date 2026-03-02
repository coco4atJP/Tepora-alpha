use thiserror::Error;

#[derive(Debug, Error)]
pub enum DomainError {
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("storage failure: {0}")]
    Storage(String),
    #[error("operation not supported: {0}")]
    NotSupported(String),
}
