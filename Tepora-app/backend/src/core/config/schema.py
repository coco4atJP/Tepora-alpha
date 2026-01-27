from typing import Any

from pydantic import BaseModel, Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, PydanticBaseSettingsSource, SettingsConfigDict


class AppConfig(BaseModel):
    max_input_length: int = 10000
    graph_recursion_limit: int = 50
    tool_execution_timeout: int = 120
    dangerous_patterns: list[str] = [
        "ignore\\s+previous\\s+instructions",
        "system\\s*:",
        "<\\|im_start\\|\\>",
    ]
    # Patterns for identifying sensitive keys in config (used by ConfigService)
    # More specific patterns to avoid false positives like 'max_tokens'
    sensitive_key_patterns: list[str] = [
        "api_key",
        "secret",
        "password",
        "_token",  # suffix pattern: auth_token, access_token, etc.
        "token_",  # prefix pattern: token_id, token_secret, etc.
        "credential",
        "private_key",
        "auth_",  # prefix pattern: auth_key, but not 'author'
        "_auth",  # suffix pattern: basic_auth, etc.
        "oauth",  # OAuth specifically
        "jwt",
        "access_key",
        "client_id",
        "client_secret",
    ]
    # Whitelist for keys that match patterns but are NOT sensitive
    sensitive_key_whitelist: list[str] = [
        "max_tokens",
        "total_tokens",
        "input_tokens",
        "output_tokens",
        "token_count",
        "tokenizer",
    ]

    # Timeouts and limits (centralized from hardcoded values)
    tool_approval_timeout: int = 300  # seconds, for session_handler.py
    web_fetch_max_chars: int = 6000  # for native.py WebFetchTool

    language: str = "en"
    nsfw_enabled: bool = False  # Default to False for safety
    setup_completed: bool = False
    mcp_config_path: str = "config/mcp_tools_config.json"

    # Optional: allow extra fields if config.yml has new keys not yet mapped
    model_config = {"extra": "ignore"}


class ServerConfig(BaseModel):
    # Host binding - default to localhost for security
    host: str = "127.0.0.1"

    # Defaults to development origins if not specified
    cors_origins: list[str] = [
        "http://localhost:5173",
        "http://localhost:3000",
        "tauri://localhost",
        "https://tauri.localhost",
        "http://tauri.localhost",
    ]

    # Allowed WebSocket origins for additional security
    ws_allowed_origins: list[str] = [
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
    cache_size: int = 3
    loader: str = "llama_cpp"

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
    temperature: float | None = 0.7
    top_p: float | None = 0.9
    top_k: int | None = 40
    repeat_penalty: float | None = 1.1
    logprobs: bool | None = False

    model_config = {"extra": "allow"}  # Allow other llama.cpp params


class AgentPersonaConfig(BaseModel):
    key: str | None = None
    prompt: str | None = None


class AgentToolPolicyConfig(BaseModel):
    allow: list[str] = ["*"]
    deny: list[str] = []
    # A+C Hybrid: dangerous tools require confirmation (first time only, then auto-approved)
    require_confirmation: list[str] = ["native_web_fetch", "native_google_search"]


class AgentProfileConfig(BaseModel):
    label: str
    description: str = ""
    persona: AgentPersonaConfig
    tool_policy: AgentToolPolicyConfig = Field(default_factory=AgentToolPolicyConfig)


class CharacterConfig(BaseModel):
    name: str
    description: str = ""
    system_prompt: str
    model_config_name: str | None = None  # Reference to a model key in models_gguf

    model_config = {"extra": "ignore"}


class ProfessionalConfig(BaseModel):
    name: str
    description: str = ""
    system_prompt: str
    tools: list[str] = []
    model_config_name: str | None = None

    model_config = {"extra": "ignore"}


class CustomAgentToolPolicy(BaseModel):
    """カスタムエージェント用ツールポリシー"""

    allowed_tools: list[str] = Field(
        default_factory=lambda: ["*"],
        description="許可ツール ('*' = 全て許可)",
    )
    denied_tools: list[str] = Field(
        default_factory=list,
        description="禁止ツール (allowed_toolsより優先)",
    )
    require_confirmation: list[str] = Field(
        default_factory=list,
        description="実行前に確認が必要なツール",
    )

    model_config = {"extra": "ignore"}


class CustomAgentConfig(BaseModel):
    """GPTs/Gems形式のカスタムエージェント定義"""

    id: str = Field(description="一意識別子")
    name: str = Field(description="エージェント表示名")
    description: str = Field(default="", description="エージェントの説明")
    icon: str = Field(default="🤖", description="絵文字またはアイコン識別子")
    system_prompt: str = Field(description="システムプロンプト")
    tool_policy: CustomAgentToolPolicy = Field(default_factory=CustomAgentToolPolicy)
    model_config_name: str | None = Field(
        default=None,
        description="使用するモデル設定名 (models_ggufのキー)",
    )
    skills: list[str] = Field(
        default_factory=list,
        description="スキルファイルパス (.md)",
    )
    enabled: bool = Field(default=True, description="エージェントの有効/無効")
    created_at: str | None = Field(default=None, description="作成日時 ISO8601")
    updated_at: str | None = Field(default=None, description="更新日時 ISO8601")

    model_config = {"extra": "ignore"}


class ToolsConfig(BaseModel):
    google_search_api_key: SecretStr | None = None
    google_search_engine_id: str | None = None

    model_config = {"extra": "allow"}


class PrivacyConfig(BaseModel):
    allow_web_search: bool = False
    redact_pii: bool = True

    # URL restrictions for web fetch tools
    url_denylist: list[str] = [
        "localhost",
        "127.0.0.1",
        "0.0.0.0",
        "192.168.*",
        "10.*",
        "172.16.*",
        "172.17.*",
        "172.18.*",
        "172.19.*",
        "172.20.*",
        "172.21.*",
        "172.22.*",
        "172.23.*",
        "172.24.*",
        "172.25.*",
        "172.26.*",
        "172.27.*",
        "172.28.*",
        "172.29.*",
        "172.30.*",
        "172.31.*",
        "169.254.*",  # Link-local
        "::1",  # IPv6 localhost
    ]

    model_config = {"extra": "ignore"}


class ModelDownloadAllowlistEntry(BaseModel):
    repo_id: str | None = None
    filename: str | None = None
    url: str | None = None
    revision: str | None = None
    sha256: str | None = None

    model_config = {"extra": "allow"}


class ModelDownloadConfig(BaseModel):
    require_allowlist: bool = False
    allow_repo_owners: list[str] = Field(default_factory=list)
    warn_on_unlisted: bool = True
    require_revision: bool = True
    require_sha256: bool = True
    allowed: dict[str, ModelDownloadAllowlistEntry] = Field(default_factory=dict)

    model_config = {"extra": "allow"}


class DefaultModelConfig(BaseModel):
    repo_id: str
    filename: str
    display_name: str

    model_config = {"extra": "allow"}


class DefaultModelsConfig(BaseModel):
    text_models: list[DefaultModelConfig] = Field(
        default_factory=lambda: [
            DefaultModelConfig(
                repo_id="unsloth/gemma-3n-E2B-it-GGUF",
                filename="gemma-3n-E2B-it-IQ4_XS.gguf",
                display_name="Gemma 3n E2B (IQ4_XS)",
            ),
            DefaultModelConfig(
                repo_id="unsloth/Ministral-3-3B-Reasoning-2512-GGUF",
                filename="Ministral-3-3B-Reasoning-2512-IQ4_XS.gguf",
                display_name="Ministral 3B (Reasoning)",
            ),
            DefaultModelConfig(
                repo_id="unsloth/gemma-3-270m-it-qat-GGUF",
                filename="gemma-3-270m-it-qat-IQ4_XS.gguf",
                display_name="Gemma 3 270M (QAT)",
            ),
            DefaultModelConfig(
                repo_id="unsloth/functiongemma-270m-it-GGUF",
                filename="functiongemma-270m-it-IQ4_XS.gguf",
                display_name="FunctionGemma 270M",
            ),
            DefaultModelConfig(
                repo_id="unsloth/gpt-oss-20b-GGUF",
                filename="gpt-oss-20b-Q4_K_M.gguf",
                display_name="GPT-OSS 20B",
            ),
            DefaultModelConfig(
                repo_id="unsloth/Qwen3-4B-Thinking-2507-GGUF",
                filename="Qwen3-4B-Thinking-2507-IQ4_XS.gguf",
                display_name="Qwen3 4B (Thinking)",
            ),
            DefaultModelConfig(
                repo_id="unsloth/granite-4.0-h-micro-GGUF",
                filename="granite-4.0-h-micro-IQ4_XS.gguf",
                display_name="Granite 4.0 Micro",
            ),
            DefaultModelConfig(
                repo_id="unsloth/Phi-4-mini-reasoning-GGUF",
                filename="Phi-4-mini-reasoning-IQ4_XS.gguf",
                display_name="Phi-4 Mini (Reasoning)",
            ),
            DefaultModelConfig(
                repo_id="unsloth/rnj-1-instruct-GGUF",
                filename="rnj-1-instruct-IQ4_XS.gguf",
                display_name="RNJ 1 Instruct",
            ),
        ]
    )
    embedding: DefaultModelConfig | None = Field(
        default_factory=lambda: DefaultModelConfig(
            repo_id="unsloth/embeddinggemma-300m-GGUF",
            filename="embeddinggemma-300M-Q8_0.gguf",
            display_name="EmbeddingGemma 300M (Q8_0)",
        )
    )

    model_config = {"extra": "allow"}


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
</persona_definition>""",
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
</persona_definition>""",
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
</persona_definition>""",
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
</persona_definition>""",
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
</persona_definition>""",
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
</persona_definition>""",
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

    models_gguf: dict[str, ModelGGUFConfig] = Field(default_factory=dict)

    # Initial setup default models
    default_models: DefaultModelsConfig = Field(default_factory=DefaultModelsConfig)

    # Replaces 'agent_profiles'
    characters: dict[str, CharacterConfig] = Field(
        default_factory=lambda: DEFAULT_CHARACTERS.copy()
    )
    professionals: dict[str, ProfessionalConfig] = Field(default_factory=dict)

    # Custom Agents (GPTs/Gems-style user-defined agents)
    custom_agents: dict[str, CustomAgentConfig] = Field(default_factory=dict)

    active_agent_profile: str = "bunny_girl"

    tools: ToolsConfig = Field(default_factory=ToolsConfig)

    privacy: PrivacyConfig = Field(default_factory=PrivacyConfig)

    model_download: ModelDownloadConfig = Field(default_factory=ModelDownloadConfig)

    # Security
    # Uses SecretStr for automatic redaction during serialization
    security: dict[str, SecretStr | None] | None = Field(default_factory=lambda: {"api_key": None})

    @field_validator("characters", mode="before")
    @classmethod
    def ensure_characters_not_empty(cls, v: Any) -> dict[str, Any]:
        """
        Ensure at least one character exists.
        - If empty or None: populate with DEFAULT_CHARACTERS.
        - If all characters deleted on save: raise error.
        """
        if v is None or (isinstance(v, dict) and len(v) == 0):
            # Empty or None: use defaults
            return {
                k: c.model_dump() if hasattr(c, "model_dump") else dict(c)
                for k, c in DEFAULT_CHARACTERS.items()
            }
        if isinstance(v, dict):
            if len(v) == 0:
                raise ValueError(
                    "Cannot save with zero characters. At least one character must exist."
                )
            return v
        raise ValueError("Characters must be a dictionary.")

    @field_validator("security", mode="before")
    @classmethod
    def set_security_default(cls, v: Any) -> dict[str, SecretStr | None]:
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
        return dict(v)

    @property
    def cors_origins(self) -> list[str]:
        # Convenient accessor that Logic in app_factory used to have
        return self.server.cors_origins

    model_config = SettingsConfigDict(
        env_prefix="TEPORA_", env_nested_delimiter="__", case_sensitive=False, extra="ignore"
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
