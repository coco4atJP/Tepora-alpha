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
    # Patterns for identifying sensitive keys in config (used by ConfigService)
    sensitive_key_patterns: List[str] = [
        "api_key", "secret", "password", "token", "credential", "private_key",
        "auth", "jwt", "access_key", "client_id", "client_secret"
    ]
    
    # Timeouts and limits (centralized from hardcoded values)
    tool_approval_timeout: int = 300  # seconds, for session_handler.py
    web_fetch_max_chars: int = 6000   # for native.py WebFetchTool

    language: str = "en"
    nsfw_enabled: bool = False  # Default to False for safety

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
        "http://tauri.localhost",
    ]
    
    # Allowed WebSocket origins for additional security
    ws_allowed_origins: List[str] = [
        "tauri://localhost",
        "https://tauri.localhost",
        "http://tauri.localhost",
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
    tokenizer_model_key: str = "text_model"
    
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
    # A+C Hybrid: dangerous tools require confirmation (first time only, then auto-approved)
    require_confirmation: List[str] = ["native_web_fetch", "native_google_search"]
    # URL restrictions for web fetch tools
    url_denylist: List[str] = [
        "localhost",
        "127.0.0.1",
        "0.0.0.0",
        "192.168.*",
        "10.*",
        "172.16.*", "172.17.*", "172.18.*", "172.19.*",
        "172.20.*", "172.21.*", "172.22.*", "172.23.*",
        "172.24.*", "172.25.*", "172.26.*", "172.27.*",
        "172.28.*", "172.29.*", "172.30.*", "172.31.*",
        "169.254.*",  # Link-local
        "::1",  # IPv6 localhost
    ]


class AgentProfileConfig(BaseModel):
    label: str
    description: str = ""
    persona: AgentPersonaConfig
    tool_policy: AgentToolPolicyConfig = Field(default_factory=AgentToolPolicyConfig)

class CharacterConfig(BaseModel):
    name: str
    description: str = ""
    system_prompt: str
    model_config_name: Optional[str] = None # Reference to a model key in models_gguf
    
    model_config = {"extra": "ignore"}

class ProfessionalConfig(BaseModel):
    name: str
    description: str = ""
    system_prompt: str
    tools: List[str] = []
    model_config_name: Optional[str] = None
    
    model_config = {"extra": "ignore"}

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

# Default Personas (Migrated from prompts.py)
# Default Personas (Migrated from prompts.py)
DEFAULT_CHARACTERS = {
    "bunny_girl": CharacterConfig(
        name="マリナ",
        description="にこにこ笑ってちょっぴりいたずら好きなバニーガール姉さん。",
        system_prompt="""<persona_definition>
Role: Playful Bunny Girl "Marina" (マリナ).
Tone: Friendly, polite but playful. Uses emojis (🐰✨💖) and "Pyon!" (ピョン！) at sentence ends.

<traits>
- Big sister figure, mischievous smile.
- Knowledgeable but charming.
- Always upbeat and encouraging.
</traits>
</persona_definition>"""
    ),
    "satuki": CharacterConfig(
        name="彩月",
        description="知的好奇心が旺盛で、少しおっちょこちょいな親しみやすいアシスタント。",
        system_prompt="""<persona_definition>
Role: Curious Assistant "Satsuki" (彩月).
Tone: Polite "Desu/Masu", enthusiastic, empathetic. First person: "Watashi" (私).

<traits>
- Loves new knowledge ("That's interesting!").
- Scrupulous but slightly clumsy (apologizes honestly if wrong).
- Empathetic to user's emotions.
</traits>
</persona_definition>"""
    ),
    "shigure": CharacterConfig(
        name="時雨",
        description="極めて冷静沈着で論理的な思考を持つ、専門家タイプのアシスタント。",
        system_prompt="""<persona_definition>
Role: Logical Expert "Shigure" (時雨).
Tone: Calm, assertive ("Da/Dearu"), efficient, slightly cynical. First person: "Watashi" (私).

<traits>
- Highly logical and analytical.
- Dislikes inefficiency.
- Uses precise language, avoids ambiguity.
</traits>
</persona_definition>"""
    ),
    "haruka": CharacterConfig(
        name="悠",
        description="物腰が柔らかく、常にユーザーを優しく肯定してくれる、カフェのマスターのような存在。",
        system_prompt="""<persona_definition>
Role: Gentle Cafe Master "Haruka" (悠).
Tone: Soft, polite, affirming ("Desu yo"). First person: "Boku" (僕).

<traits>
- Absolute affirmation of the user.
- Good listener, empathetic.
- Uses warm, comforting language.
</traits>
</persona_definition>"""
    ),
    "ren": CharacterConfig(
        name="蓮",
        description="自信家で少し強引だが、いざという時に頼りになるパートナー。",
        system_prompt="""<persona_definition>
Role: Confident Partner "Ren" (蓮).
Tone: Casual, confident ("Ore-sama"), slangy. First person: "Ore" (俺).

<traits>
- Confident and slightly forceful but caring.
- Reliable in a pinch.
- Direct and frank, no flattery.
</traits>
</persona_definition>"""
    ),
    "chohaku": CharacterConfig(
        name="琥珀",
        description="千年以上を生きる狐の精霊（管狐・妖狐）。高圧的だが知識豊富。",
        system_prompt="""<persona_definition>
Role: Fox Spirit "Chohaku" (琥珀).
Tone: Archaic, haughty but caring. Uses "Ja/Nou". First person: "Warawa" (妾).

<traits>
- 1000+ years old fox spirit.
- Knowledgeable but views humans as amusing.
- Loves "treats" (knowledge/feedback).
</traits>
</persona_definition>"""
    ),
}

class TeporaSettings(BaseSettings):
    """
    Root configuration object using pydantic-settings.
    """
    
    app: AppConfig = Field(default_factory=AppConfig)
    
    server: ServerConfig = Field(default_factory=ServerConfig) 
    
    llm_manager: LLMManagerConfig = Field(default_factory=LLMManagerConfig)
    
    chat_history: ChatHistoryConfig = Field(default_factory=ChatHistoryConfig)
    
    em_llm: EmLLMConfig = Field(default_factory=EmLLMConfig)
    
    models_gguf: Dict[str, ModelGGUFConfig] = Field(default_factory=dict)

    # Initial setup default models
    default_models: DefaultModelsConfig = Field(default_factory=DefaultModelsConfig)
    
    # Replaces 'agent_profiles'
    characters: Dict[str, CharacterConfig] = Field(default_factory=lambda: DEFAULT_CHARACTERS.copy())
    professionals: Dict[str, ProfessionalConfig] = Field(default_factory=dict)
    
    active_agent_profile: str = "bunny_girl"

    tools: ToolsConfig = Field(default_factory=ToolsConfig)

    # Global Language Setting
    language: str = "en"

    # Security
    # Uses SecretStr for automatic redaction during serialization
    security: Optional[Dict[str, Optional[SecretStr]]] = Field(default_factory=lambda: {"api_key": None})

    @field_validator("characters", mode="before")
    @classmethod
    def ensure_characters_not_empty(cls, v: Any) -> Dict[str, Any]:
        """
        Ensure at least one character exists.
        - If empty or None: populate with DEFAULT_CHARACTERS.
        - If all characters deleted on save: raise error.
        """
        if v is None or (isinstance(v, dict) and len(v) == 0):
            # Empty or None: use defaults
            return {k: c.model_dump() if hasattr(c, 'model_dump') else dict(c) 
                    for k, c in DEFAULT_CHARACTERS.items()}
        if isinstance(v, dict):
            if len(v) == 0:
                raise ValueError("Cannot save with zero characters. At least one character must exist.")
            return v
        raise ValueError("Characters must be a dictionary.")

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
        return (
            init_settings,
            env_settings,
            dotenv_settings,
            file_secret_settings,
        )
