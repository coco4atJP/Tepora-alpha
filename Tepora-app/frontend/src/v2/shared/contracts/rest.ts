import { z } from "zod";

export const isoDatetimeSchema = z.string().min(1);

export const chatModeSchema = z.enum(["chat", "search", "agent"]);
export const agentModeSchema = z.enum(["high", "fast", "low", "direct"]);

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
			.passthrough(),
		active_agent_profile: z.string().optional(),
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

export const apiErrorResponseSchema = z
	.object({
		error: z.string().optional(),
		status: z.number().int().optional(),
	})
	.passthrough();

export type ChatMode = z.infer<typeof chatModeSchema>;
export type AgentMode = z.infer<typeof agentModeSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type SessionHistoryMessage = z.infer<typeof sessionHistoryMessageSchema>;
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;
export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;
export type V2Config = z.infer<typeof configResponseSchema>;
