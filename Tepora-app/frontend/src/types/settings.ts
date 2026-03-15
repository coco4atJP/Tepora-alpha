import type {
    AgentSkillPackage,
    AgentSkillSaveRequest,
    AgentSkillSummary,
    CharacterConfig,
    SkillRootConfig,
    SkillRootInfo,
} from ".";

export type {
    AgentSkillPackage,
    AgentSkillSaveRequest,
    AgentSkillSummary,
    CharacterConfig,
    SkillRootConfig,
    SkillRootInfo,
};

export interface ModelConfig {
    path: string;
    port: number;
    n_ctx: number;
    n_gpu_layers: number;
    temperature?: number;
    top_p?: number;
    top_k?: number;
    repeat_penalty?: number;
    logprobs?: boolean;
    max_tokens?: number;
    predict_len?: number;
}

export interface Config {
    app: {
        max_input_length: number;
        graph_recursion_limit: number;
        tool_execution_timeout: number;
        tool_approval_timeout: number;
        graph_execution_timeout: number;
        web_fetch_max_chars: number;
        web_fetch_max_bytes: number;
        web_fetch_timeout_secs: number;
        dangerous_patterns: string[];
        language: string;
        nsfw_enabled: boolean;
        setup_completed?: boolean;
        mcp_config_path: string;
    };
    llm_manager: {
        loader?: string;
        process_terminate_timeout: number;
        health_check_timeout: number;
        health_check_interval: number;
        tokenizer_model_key: string;
        cache_size: number;
    };
    chat_history: {
        max_tokens: number;
        default_limit: number;
    };
    em_llm: {
        surprise_gamma: number;
        min_event_size: number;
        max_event_size: number;
        total_retrieved_events: number;
        repr_topk: number;
        use_boundary_refinement: boolean;
        decay?: {
            lambda_base?: number;
            importance_modulation?: number;
            beta_lml?: number;
            beta_sml?: number;
            promote_threshold?: number;
            demote_threshold?: number;
            prune_threshold?: number;
            reinforcement_delta?: number;
            alpha?: number;
            beta?: number;
            gamma?: number;
        };
    };
    models_gguf: Record<string, ModelConfig>;
    characters: Record<string, CharacterConfig>;
    active_agent_profile: string;
    tools: {
        google_search_api_key?: string;
        google_search_engine_id?: string;
        brave_search_api_key?: string;
        bing_search_api_key?: string;
        search_provider?: "google" | "duckduckgo" | "brave" | "bing";
    };
    privacy: {
        allow_web_search: boolean;
        redact_pii: boolean;
        isolation_mode?: boolean;
        url_denylist?: string[];
    };
    search?: {
        embedding_rerank?: boolean;
    };
    model_download?: {
        allow_repo_owners?: string[];
        require_allowlist?: boolean;
        warn_on_unlisted?: boolean;
        require_revision?: boolean;
        require_sha256?: boolean;
    };
    server?: {
        host?: string;
        allowed_origins?: string[];
        cors_allowed_origins?: string[];
        ws_allowed_origins?: string[];
    };
    loaders?: Record<string, { base_url?: string }>;
    thinking?: {
        chat_default?: boolean;
        search_default?: boolean;
    };
    agent_skills?: {
        roots?: SkillRootConfig[];
    };
    features?: {
        redesign?: Record<string, unknown>;
    };
}
