import os
from typing import Dict, List, Optional, Any
from pathlib import Path
from pydantic import BaseModel, Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict, PydanticBaseSettingsSource

class AppConfig(BaseModel):
    max_input_length: int = 10000
    graph_recursion_limit: int = 50
    tool_execution_timeout: int = 120
    dangerous_patterns: List[str] = [
        'ignore\\s+previous\\s+instructions',
        'system\\s*:',
        '<\\|im_start\\|\\>'
    ]
    language: str = "en"

    # Optional: allow extra fields if config.yml has new keys not yet mapped
    model_config = {"extra": "ignore"}

class ServerConfig(BaseModel):
    # Host binding - default to localhost for security
    host: str = "127.0.0.1"
    
    # Defaults to development origins if not specified
    cors_origins: List[str] = [
        "http://localhost:5173",
        "http://localhost:3000",
        "tauri://localhost",
        "https://tauri.localhost",
    ]
    
    # Allowed WebSocket origins for additional security
    ws_allowed_origins: List[str] = [
        "tauri://localhost",
        "https://tauri.localhost",
        "http://localhost:5173",
        "http://localhost:3000",
        "http://localhost:8000",
        "http://localhost",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:8000",
        "http://127.0.0.1",
    ]
    
    # Optional: allow extra fields
    model_config = {"extra": "ignore"}

class LLMManagerConfig(BaseModel):
    process_terminate_timeout: int = 10
    health_check_timeout: int = 60
    health_check_interval: float = 1.0
    tokenizer_model_key: str = "character_model"
    
    # Optional: allow extra fields
    model_config = {"extra": "ignore"}

class ChatHistoryConfig(BaseModel):
    max_tokens: int = 8192
    default_limit: int = 50

    model_config = {"extra": "ignore"}

class EmLLMConfig(BaseModel):
    surprise_gamma: float = 0.1
    min_event_size: int = 10
    max_event_size: int = 512
    total_retrieved_events: int = 5
    repr_topk: int = 5
    use_boundary_refinement: bool = True
    
    # Allow extra for dynamic EM parameters
    model_config = {"extra": "allow"}

class ModelGGUFConfig(BaseModel):
    path: str
    port: int
    n_ctx: int = 4096
    n_gpu_layers: int = -1
    temperature: Optional[float] = 0.7
    top_p: Optional[float] = 0.9
    top_k: Optional[int] = 40
    repeat_penalty: Optional[float] = 1.1
    logprobs: Optional[bool] = False

    model_config = {"extra": "allow"} # Allow other llama.cpp params

class AgentPersonaConfig(BaseModel):
    key: Optional[str] = None
    prompt: Optional[str] = None

class AgentToolPolicyConfig(BaseModel):
    allow: List[str] = ["*"]
    deny: List[str] = []

class AgentProfileConfig(BaseModel):
    label: str
    description: str = ""
    persona: AgentPersonaConfig
    tool_policy: AgentToolPolicyConfig = Field(default_factory=AgentToolPolicyConfig)

class ToolsConfig(BaseModel):
    google_search_api_key: Optional[SecretStr] = None
    google_search_engine_id: Optional[str] = None
    
    model_config = {"extra": "allow"}

class DefaultModelConfig(BaseModel):
    repo_id: str
    filename: str
    display_name: str
    
    model_config = {"extra": "allow"}

class DefaultModelsConfig(BaseModel):
    character: Optional[DefaultModelConfig] = None
    executor: Optional[DefaultModelConfig] = None
    embedding: Optional[DefaultModelConfig] = None
    
    model_config = {"extra": "allow"}

class TeporaSettings(BaseSettings):
    """
    Root configuration object using pydantic-settings.
    
    Loads from:
    1. Environment variables (prefixed with TEPORA_, e.g., TEPORA_APP__MAX_INPUT_LENGTH)
    2. config.yml (if configured via source loader, or defaults + manual merge)
    3. Defaults defined here
    """
    
    # Environment variables are prioritized automatically by pydantic-settings.
    # However, for complex nested dicts like models_gguf, merging simply from env vars 
    # can be tricky. We primarily rely on config.yml for structure, but simple overrides work.
    
    app: AppConfig = Field(default_factory=AppConfig)
    
    # Note: 'server' key exists in our plan but wasn't in original config.yml root (derived logic).
    # We will map it properly.
    server: ServerConfig = Field(default_factory=ServerConfig) 
    
    llm_manager: LLMManagerConfig = Field(default_factory=LLMManagerConfig)
    
    chat_history: ChatHistoryConfig = Field(default_factory=ChatHistoryConfig)
    
    em_llm: EmLLMConfig = Field(default_factory=EmLLMConfig)
    
    models_gguf: Dict[str, ModelGGUFConfig] = Field(default_factory=dict)

    # Initial setup default models
    default_models: DefaultModelsConfig = Field(default_factory=DefaultModelsConfig)
    
    agent_profiles: Dict[str, AgentProfileConfig] = Field(default_factory=dict)
    
    active_agent_profile: str = "default"

    tools: ToolsConfig = Field(default_factory=ToolsConfig)

    # Global Language Setting
    language: str = "en"

    # Security
    # Uses SecretStr for automatic redaction during serialization
    security: Optional[Dict[str, Optional[SecretStr]]] = Field(default_factory=lambda: {"api_key": None})

    @field_validator("security", mode="before")
    @classmethod
    def set_security_default(cls, v: Any) -> Dict[str, Optional[SecretStr]]:
        if v is None:
            return {"api_key": None}
        if isinstance(v, dict):
            # Convert string values to SecretStr if needed
            result = {}
            for key, value in v.items():
                if isinstance(value, str):
                    result[key] = SecretStr(value)
                else:
                    result[key] = value
            return result
        return v

    @property
    def cors_origins(self) -> List[str]:
        # Convenient accessor that Logic in app_factory used to have
        return self.server.cors_origins

    model_config = SettingsConfigDict(
        env_prefix="TEPORA_",
        env_nested_delimiter="__",
        case_sensitive=False,
        extra="ignore"
    )

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        """
        Customise the settings sources to include a Yaml source.
        Precedence: Init > Env > Dotenv > Yaml > Defaults
        """
        # We will inject the Yaml source from the loader later
        # For now, we return the standard ones. 
        # The loader will override this or pass the yaml data.
        return (
            init_settings,
            env_settings,
            dotenv_settings,
            file_secret_settings,
        )
