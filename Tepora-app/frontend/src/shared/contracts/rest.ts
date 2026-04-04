import { z } from "zod";

export const isoDatetimeSchema = z.string().min(1);

const stringRecordSchema = z.record(z.string(), z.string());
export const skillFileEntrySchema = z
	.object({
		path: z.string(),
		kind: z.string(),
		content: z.string(),
		encoding: z.string(),
	})
	.passthrough();
export const skillRootConfigSchema = z
	.object({
		path: z.string(),
		enabled: z.boolean().optional(),
		label: z.string().optional(),
	})
	.passthrough();
export const skillRootInfoSchema = skillRootConfigSchema.extend({
	writable: z.boolean(),
});
export const agentSkillSummarySchema = z
	.object({
		id: z.string().min(1),
		name: z.string().min(1),
		description: z.string(),
		package_dir: z.string(),
		root_path: z.string(),
		root_label: z.string().optional(),
		metadata: z.record(z.string(), z.unknown()).optional(),
		display_name: z.string().optional(),
		short_description: z.string().optional(),
		valid: z.boolean(),
		writable: z.boolean(),
		warnings: z.array(z.string()),
	})
	.passthrough();
export const agentSkillPackageSchema = agentSkillSummarySchema.extend({
	skill_markdown: z.string(),
	skill_body: z.string(),
	openai_yaml: z.string().nullable().optional(),
	references: z.array(skillFileEntrySchema),
	scripts: z.array(skillFileEntrySchema),
	assets: z.array(skillFileEntrySchema),
	other_files: z.array(skillFileEntrySchema),
});
export const credentialStatusSchema = z
	.object({
		provider: z.string().min(1),
		status: z.string().min(1),
		present: z.boolean(),
		expires_at: z.string().nullable().optional(),
		last_rotated_at: z.string().nullable().optional(),
	})
	.passthrough();
export const mcpServerStatusSchema = z
	.object({
		status: z.enum(["connected", "disconnected", "error", "connecting"]),
		tools_count: z.number().int().nonnegative(),
		error_message: z.string().nullable().optional(),
		last_connected: z.string().nullable().optional(),
	})
	.passthrough();
export const mcpServerConfigSchema = z
	.object({
		command: z.string().min(1),
		args: z.array(z.string()),
		env: stringRecordSchema,
		enabled: z.boolean(),
		metadata: z
			.object({
				name: z.string().optional(),
				description: z.string().optional(),
			})
			.passthrough()
			.nullable()
			.optional(),
	})
	.passthrough();
export const mcpEnvVarSchema = z
	.object({
		name: z.string().min(1),
		description: z.string().optional(),
		isRequired: z.boolean(),
		isSecret: z.boolean(),
		default: z.string().optional(),
	})
	.passthrough();
export const mcpPackageSchema = z
	.object({
		name: z.string().min(1),
		runtimeHint: z.string().optional(),
		registry: z.string().optional(),
		version: z.string().optional(),
	})
	.passthrough();
export const mcpStoreServerSchema = z
	.object({
		id: z.string().min(1),
		name: z.string().min(1),
		title: z.string().optional(),
		description: z.string().optional(),
		version: z.string().optional(),
		vendor: z.string().optional(),
		packages: z.array(mcpPackageSchema),
		environmentVariables: z.array(mcpEnvVarSchema),
		icon: z.string().optional(),
		category: z.string().optional(),
		sourceUrl: z.string().optional(),
		homepage: z.string().optional(),
		websiteUrl: z.string().optional(),
	})
	.passthrough();

export const chatModeSchema = z.enum(["chat", "search", "agent"]);
export const agentModeSchema = z.enum(["high", "fast", "low", "direct"]);
export const searchModeSchema = z.enum(["quick", "deep"]);

export const sessionSchema = z
	.object({
		id: z.string().min(1),
		title: z.string().nullable(),
		created_at: isoDatetimeSchema,
		updated_at: isoDatetimeSchema,
		message_count: z.number().int().nonnegative().optional(),
		preview: z.string().nullable().optional(),
	})
	.passthrough();

export const sessionsResponseSchema = z.object({
	sessions: z.array(sessionSchema),
});

export const createSessionRequestSchema = z
	.object({
		title: z.string().nullable().optional(),
	})
	.strict();

export const createSessionResponseSchema = z.object({
	session: sessionSchema,
});

export const sessionHistoryMessageSchema = z
	.object({
		id: z.string().min(1),
		role: z.enum(["user", "assistant", "system"]),
		content: z.string(),
		timestamp: isoDatetimeSchema,
		mode: chatModeSchema.optional(),
		isComplete: z.boolean().optional(),
	})
	.passthrough();

export const sessionMessagesResponseSchema = z.object({
	messages: z.array(sessionHistoryMessageSchema),
});

export const configResponseSchema = z
	.object({
		app: z
			.object({
				language: z.string().optional(),
				setup_completed: z.boolean().optional(),
				max_input_length: z.number().int().positive().optional(),
				nsfw_enabled: z.boolean().optional(),
				tool_execution_timeout: z.number().int().positive().optional(),
				graph_execution_timeout: z.number().int().positive().optional(),
			})
			.passthrough()
			.optional(),
		active_character: z.string().optional(),
		tools: z
			.object({
				search_provider: z
					.enum(["google", "duckduckgo", "brave", "bing"])
					.optional(),
			})
			.passthrough()
			.optional(),
		privacy: z
			.object({
				allow_web_search: z.boolean().optional(),
				redact_pii: z.boolean().optional(),
			})
			.passthrough()
			.optional(),
		thinking: z
			.object({
				chat_default: z.boolean().optional(),
				search_default: z.boolean().optional(),
			})
			.passthrough()
			.optional(),
		features: z
			.object({
				redesign: z
					.object({
						frontend_logging: z.boolean().optional(),
						transport_mode: z.enum(["ipc", "websocket"]).optional(),
					})
					.passthrough()
					.optional(),
			})
			.passthrough()
			.optional(),
		server: z
			.object({
				host: z.string().optional(),
				allowed_origins: z.array(z.string()).optional(),
				cors_allowed_origins: z.array(z.string()).optional(),
				ws_allowed_origins: z.array(z.string()).optional(),
			})
			.passthrough()
			.optional(),
		model_download: z
			.object({
				require_allowlist: z.boolean().optional(),
				warn_on_unlisted: z.boolean().optional(),
				require_revision: z.boolean().optional(),
				require_sha256: z.boolean().optional(),
				allow_repo_owners: z.array(z.string()).optional(),
			})
			.passthrough()
			.optional(),
		credentials: z.record(
			z.string(),
			z
				.object({
					expires_at: z.string().nullable().optional(),
					last_rotated_at: z.string().nullable().optional(),
					status: z.string().nullable().optional(),
				})
				.passthrough(),
		).optional(),
		ui: z
			.object({
				theme: z.string().optional(),
				font_size: z.number().optional(),
				code_block: z
					.object({
						syntax_theme: z.string().optional(),
						wrap_lines: z.boolean().optional(),
						show_line_numbers: z.boolean().optional(),
					})
					.passthrough()
					.optional(),
			})
			.passthrough()
			.optional(),
		storage: z
			.object({
				location: z.string().optional(),
				chunk_size_chars: z.number().optional(),
				chunk_size_tokens: z.number().optional(),
				chunk_overlap: z.number().optional(),
				watch_folders: z.array(z.string()).optional(),
				vector_store_dir: z.string().optional(),
				model_files_dir: z.string().optional(),
			})
			.passthrough()
			.optional(),
		cache: z
			.object({
				webfetch_clear_on_startup: z.boolean().optional(),
				cleanup_old_embeddings: z.boolean().optional(),
				cleanup_temp_files: z.boolean().optional(),
				capacity_limit_mb: z.number().optional(),
			})
			.passthrough()
			.optional(),
		notifications: z
			.object({
				background_task: z
					.object({
						os_notification: z.boolean().optional(),
						sound: z.boolean().optional(),
					})
					.passthrough()
					.optional(),
			})
			.passthrough()
			.optional(),
		agent_skills: z
			.object({
				roots: z.array(skillRootConfigSchema).optional(),
			})
			.passthrough()
			.optional(),
	})
	.passthrough();

export const requirementsResponseSchema = z
	.object({
		is_ready: z.boolean(),
		has_missing: z.boolean(),
	})
	.passthrough();

export const setupModelSchema = z
	.object({
		id: z.string().min(1),
		display_name: z.string().min(1),
		role: z.string().min(1),
		file_size: z.number().nonnegative(),
		filename: z.string().optional(),
		file_path: z.string().optional(),
		source: z.string().min(1),
		loader: z.string().optional(),
		is_active: z.boolean().optional(),
		active_assignment_keys: z.array(z.string()).optional(),
		repo_id: z.string().nullable().optional(),
		revision: z.string().nullable().optional(),
		sha256: z.string().nullable().optional(),
		capabilities: z.object({
			completion: z.boolean().optional(),
			tool_use: z.boolean().optional(),
			vision: z.boolean().optional(),
		}).passthrough().nullable().optional(),
	})
	.passthrough();

export const setupModelsResponseSchema = z.object({
	models: z.array(setupModelSchema),
});

export const modelUpdateReasonSchema = z.enum([
	"revision_mismatch",
	"sha256_mismatch",
	"up_to_date",
	"insufficient_data",
	"unknown",
]);

export const modelUpdateCheckResponseSchema = z.object({
	update_available: z.boolean(),
	reason: modelUpdateReasonSchema,
	current_revision: z.string().nullable().optional(),
	latest_revision: z.string().nullable().optional(),
	current_sha256: z.string().nullable().optional(),
	latest_sha256: z.string().nullable().optional(),
});

export const startModelDownloadRequestSchema = z.object({
	repo_id: z.string().min(1),
	filename: z.string().min(1),
	modality: z.string().min(1),
	assignment_key: z.string().optional(),
	display_name: z.string().min(1),
	revision: z.string().optional(),
	sha256: z.string().optional(),
	acknowledge_warnings: z.boolean().optional(),
});

export const startModelDownloadResponseSchema = z.object({
	success: z.boolean(),
	job_id: z.string().min(1).optional(),
});

export const setupProgressResponseSchema = z.object({
	status: z.string().min(1),
	progress: z.number(),
	message: z.string(),
});

export const binaryUpdateInfoResponseSchema = z.object({
	has_update: z.boolean(),
	current_version: z.string().min(1),
	latest_version: z.string().nullable().optional(),
	release_notes: z.string().nullable().optional(),
});

export const startBinaryUpdateRequestSchema = z.object({
	variant: z.string().optional(),
});

export const startBinaryUpdateResponseSchema = z.object({
	success: z.boolean(),
	job_id: z.string().min(1).optional(),
});

export const consentWarningSchema = z.union([
	z.string(),
	z
		.object({
			repo_id: z.string().optional(),
			filename: z.string().optional(),
			warnings: z.array(z.string()).optional(),
		})
		.passthrough(),
]);

export const consentRequiredErrorResponseSchema = z
	.object({
		error: z.string().optional(),
		requires_consent: z.literal(true),
		warnings: z.array(consentWarningSchema),
	})
	.passthrough();

export const apiErrorResponseSchema = z
	.object({
		error: z.string().optional(),
		status: z.number().int().optional(),
	})
	.passthrough();

export const credentialStatusesResponseSchema = z.object({
	credentials: z.array(credentialStatusSchema),
});

export const rotateCredentialRequestSchema = z.object({
	provider: z.string().min(1),
	secret: z.string().min(1),
	expires_at: z.string().optional(),
});

export const agentSkillsResponseSchema = z.object({
	roots: z.array(skillRootInfoSchema),
	skills: z.array(agentSkillSummarySchema),
});

export const saveAgentSkillRequestSchema = z.object({
	id: z.string().min(1),
	root_path: z.string().optional(),
	skill_markdown: z.string(),
	openai_yaml: z.string().nullable().optional(),
	references: z.array(skillFileEntrySchema),
	scripts: z.array(skillFileEntrySchema),
	assets: z.array(skillFileEntrySchema),
	other_files: z.array(skillFileEntrySchema),
});

export const saveAgentSkillResponseSchema = z.object({
	success: z.boolean(),
	skill: agentSkillPackageSchema,
});

export const mcpStatusResponseSchema = z.object({
	servers: z.record(z.string(), mcpServerStatusSchema).optional(),
	initialized: z.boolean().optional(),
	config_path: z.string().optional(),
	error: z.string().nullable().optional(),
});

export const mcpConfigResponseSchema = z.object({
	mcpServers: z.record(z.string(), mcpServerConfigSchema).optional(),
	initialized: z.boolean().optional(),
	config_path: z.string().optional(),
	error: z.string().nullable().optional(),
});

export const mcpStoreResponseSchema = z.object({
	servers: z.array(mcpStoreServerSchema),
	total: z.number().int(),
	page: z.number().int(),
	page_size: z.number().int(),
	has_more: z.boolean(),
});

export const mcpInstallPreviewRequestSchema = z.object({
	server_id: z.string().min(1),
	runtime: z.string().optional(),
	env_values: stringRecordSchema.optional(),
	server_name: z.string().optional(),
});

export const mcpInstallPreviewResponseSchema = z.object({
	consent_id: z.string().min(1),
	expires_in_seconds: z.number().int(),
	server_id: z.string().min(1).optional(),
	server_name: z.string().min(1).optional(),
	description: z.string().optional(),
	command: z.string().min(1),
	args: z.array(z.string()),
	env: stringRecordSchema,
	full_command: z.string(),
	warnings: z.array(z.string()),
	requires_consent: z.boolean(),
	runtime: z.string().nullable().optional(),
});

export const mcpInstallConfirmResponseSchema = z.object({
	status: z.string().min(1),
	server_name: z.string().min(1),
	message: z.string().min(1),
});

export const successResponseSchema = z.object({
	success: z.boolean(),
});

export type ChatMode = z.infer<typeof chatModeSchema>;
export type AgentMode = z.infer<typeof agentModeSchema>;
export type SearchMode = z.infer<typeof searchModeSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type SessionHistoryMessage = z.infer<typeof sessionHistoryMessageSchema>;
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;
export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;
export type V2Config = z.infer<typeof configResponseSchema>;
export type SetupModel = z.infer<typeof setupModelSchema>;
export type SetupModelsResponse = z.infer<typeof setupModelsResponseSchema>;
export type ModelUpdateCheckResponse = z.infer<typeof modelUpdateCheckResponseSchema>;
export type ModelUpdateReason = z.infer<typeof modelUpdateReasonSchema>;
export type StartModelDownloadRequest = z.infer<typeof startModelDownloadRequestSchema>;
export type StartModelDownloadResponse = z.infer<typeof startModelDownloadResponseSchema>;
export type SetupProgressResponse = z.infer<typeof setupProgressResponseSchema>;
export type BinaryUpdateInfoResponse = z.infer<typeof binaryUpdateInfoResponseSchema>;
export type StartBinaryUpdateRequest = z.infer<typeof startBinaryUpdateRequestSchema>;
export type StartBinaryUpdateResponse = z.infer<typeof startBinaryUpdateResponseSchema>;
export type ConsentRequiredErrorResponse = z.infer<typeof consentRequiredErrorResponseSchema>;
export type CredentialStatus = z.infer<typeof credentialStatusSchema>;
export type CredentialStatusesResponse = z.infer<typeof credentialStatusesResponseSchema>;
export type SkillFileEntry = z.infer<typeof skillFileEntrySchema>;
export type SkillRootConfig = z.infer<typeof skillRootConfigSchema>;
export type SkillRootInfo = z.infer<typeof skillRootInfoSchema>;
export type AgentSkillSummary = z.infer<typeof agentSkillSummarySchema>;
export type AgentSkillPackage = z.infer<typeof agentSkillPackageSchema>;
export type AgentSkillsResponse = z.infer<typeof agentSkillsResponseSchema>;
export type SaveAgentSkillRequest = z.infer<typeof saveAgentSkillRequestSchema>;
export type SaveAgentSkillResponse = z.infer<typeof saveAgentSkillResponseSchema>;
export type McpServerStatus = z.infer<typeof mcpServerStatusSchema>;
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;
export type McpEnvVar = z.infer<typeof mcpEnvVarSchema>;
export type McpPackage = z.infer<typeof mcpPackageSchema>;
export type McpStoreServer = z.infer<typeof mcpStoreServerSchema>;
export type McpStatusResponse = z.infer<typeof mcpStatusResponseSchema>;
export type McpConfigResponse = z.infer<typeof mcpConfigResponseSchema>;
export type McpStoreResponse = z.infer<typeof mcpStoreResponseSchema>;
export type McpInstallPreviewRequest = z.infer<typeof mcpInstallPreviewRequestSchema>;
export type McpInstallPreviewResponse = z.infer<typeof mcpInstallPreviewResponseSchema>;
export type McpInstallConfirmResponse = z.infer<typeof mcpInstallConfirmResponseSchema>;
