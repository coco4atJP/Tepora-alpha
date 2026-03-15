mod external_loader_common;
mod lmstudio_native_client;
mod model_resolution;
mod ollama_native_client;
mod openai_compatible_client;

pub mod llama_service;
pub mod service;
pub mod types;

pub use llama_service::LlamaService;
pub use service::LlmService;
pub use types::{ChatMessage, ChatRequest};
