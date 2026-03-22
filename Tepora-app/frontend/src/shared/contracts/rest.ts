import { z } from "zod";

export const isoDatetimeSchema = z.string().min(1);

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

const namedRecordSchema = z.record(z.string(), z.record(z.string(), z.unknown()));

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
			.passthrough(),
		ui: z
			.object({
				theme: z.string().optional(),
				font_size: z.number().optional(),
			})
			.passthrough()
			.optional(),
		active_character: z.string().optional(),
		active_agent_profile: z.string().optional(),
		characters: namedRecordSchema.optional(),
		custom_agents: namedRecordSchema.optional(),
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
		repo_id: z.string().nullable().optional(),
		revision: z.string().nullable().optional(),
		sha256: z.string().nullable().optional(),
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
	role: z.string().min(1),
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
