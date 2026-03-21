import { z } from "zod";
import {
	agentModeSchema,
	chatModeSchema,
	searchModeSchema,
	sessionHistoryMessageSchema,
} from "./rest";

export const approvalDecisionSchema = z.enum([
	"deny",
	"once",
	"always_until_expiry",
]);

export const permissionScopeKindSchema = z.enum(["native_tool", "mcp_server"]);
export const permissionRiskLevelSchema = z.enum([
	"low",
	"medium",
	"high",
	"critical",
]);

export const attachmentSchema = z
	.object({
		name: z.string().min(1),
		content: z.string(),
		type: z.string().min(1),
		path: z.string().optional(),
		url: z.string().optional(),
		piiConfirmed: z.boolean().optional(),
		piiFindings: z
			.array(
				z.object({
					category: z.string(),
					preview: z.string(),
				}),
			)
			.optional(),
	})
	.passthrough();

const wsEnvelopeSchema = z.object({
	eventId: z.string().optional(),
	streamId: z.string().optional(),
	seq: z.number().int().nonnegative().optional(),
	emittedAt: z.string().optional(),
	requestId: z.string().optional(),
	replay: z.boolean().optional(),
});

const toolConfirmationRequestSchema = z.object({
	requestId: z.string().min(1),
	toolName: z.string().min(1),
	toolArgs: z.record(z.string(), z.unknown()),
	description: z.string().optional(),
	scope: permissionScopeKindSchema,
	scopeName: z.string().min(1),
	riskLevel: permissionRiskLevelSchema,
	expiryOptions: z.array(z.number().int().nonnegative()),
});

const activityPayloadSchema = z.object({
	id: z.string().min(1),
	status: z.string().min(1),
	message: z.string(),
	agentName: z.string().optional(),
});

const wsChunkMessageSchema = wsEnvelopeSchema.extend({
	type: z.literal("chunk"),
	message: z.string().optional(),
	mode: chatModeSchema.optional(),
	nodeId: z.string().optional(),
	agentName: z.string().optional(),
});

const wsThoughtMessageSchema = wsEnvelopeSchema.extend({
	type: z.literal("thought"),
	content: z.string(),
});

const wsDoneMessageSchema = wsEnvelopeSchema.extend({
	type: z.literal("done"),
});

const wsStoppedMessageSchema = wsEnvelopeSchema.extend({
	type: z.literal("stopped"),
});

const wsStatusMessageSchema = wsEnvelopeSchema.extend({
	type: z.literal("status"),
	message: z.string(),
});

const wsErrorMessageSchema = wsEnvelopeSchema.extend({
	type: z.literal("error"),
	message: z.string(),
});

const wsActivityMessageSchema = wsEnvelopeSchema.extend({
	type: z.literal("activity"),
	data: activityPayloadSchema,
});

const wsHistoryMessageSchema = wsEnvelopeSchema.extend({
	type: z.literal("history"),
	messages: z.array(sessionHistoryMessageSchema),
});

const wsSearchResultsMessageSchema = wsEnvelopeSchema.extend({
	type: z.literal("search_results"),
	data: z.array(
		z.object({
			title: z.string(),
			url: z.string(),
			snippet: z.string(),
		}),
	),
});

const wsToolConfirmationMessageSchema = wsEnvelopeSchema.extend({
	type: z.literal("tool_confirmation_request"),
	data: toolConfirmationRequestSchema,
});

const wsSessionChangedMessageSchema = wsEnvelopeSchema.extend({
	type: z.literal("session_changed"),
	sessionId: z.string().min(1),
});

const wsDownloadProgressMessageSchema = wsEnvelopeSchema.extend({
	type: z.literal("download_progress"),
	data: z.unknown(),
});

const wsInteractionCompleteMessageSchema = wsEnvelopeSchema.extend({
	type: z.literal("interaction_complete"),
	sessionId: z.string().min(1),
});

const wsMemoryGenerationMessageSchema = wsEnvelopeSchema.extend({
	type: z.literal("memory_generation"),
	status: z.enum(["started", "completed", "error"]),
	sessionId: z.string().optional(),
});

const wsStatsMessageSchema = wsEnvelopeSchema.extend({
	type: z.literal("stats"),
	data: z.unknown(),
});

const wsRegenerateStartedMessageSchema = wsEnvelopeSchema.extend({
	type: z.literal("regenerate_started"),
});

export const wsIncomingMessageSchema = z.discriminatedUnion("type", [
	wsActivityMessageSchema,
	wsChunkMessageSchema,
	wsDoneMessageSchema,
	wsDownloadProgressMessageSchema,
	wsErrorMessageSchema,
	wsHistoryMessageSchema,
	wsInteractionCompleteMessageSchema,
	wsMemoryGenerationMessageSchema,
	wsRegenerateStartedMessageSchema,
	wsSearchResultsMessageSchema,
	wsSessionChangedMessageSchema,
	wsStatsMessageSchema,
	wsStatusMessageSchema,
	wsStoppedMessageSchema,
	wsThoughtMessageSchema,
	wsToolConfirmationMessageSchema,
]);

export const wsMessagePayloadSchema = z
	.object({
		type: z.undefined().optional(),
		clientMessageId: z.string().min(1),
		message: z.string().min(1),
		mode: chatModeSchema,
		sessionId: z.string().optional(),
		attachments: z.array(attachmentSchema).optional(),
		skipWebSearch: z.boolean().optional(),
		searchMode: searchModeSchema.optional(),
		thinkingBudget: z.number().int().min(0).max(3).optional(),
		agentId: z.string().optional(),
		agentMode: agentModeSchema.optional(),
		timeout: z.number().int().positive().optional(),
	})
	.strict();

export const wsStopMessageSchema = z
	.object({
		type: z.literal("stop"),
		sessionId: z.string().optional(),
	})
	.strict();

export const wsSetSessionMessageSchema = z
	.object({
		type: z.literal("set_session"),
		sessionId: z.string().min(1),
	})
	.strict();

export const wsRegenerateMessageSchema = z
	.object({
		type: z.literal("regenerate"),
		sessionId: z.string().optional(),
	})
	.strict();

export const wsStatsRequestMessageSchema = z
	.object({
		type: z.literal("get_stats"),
	})
	.strict();

export const wsToolConfirmationResponseSchema = z
	.object({
		type: z.literal("tool_confirmation_response"),
		requestId: z.string().min(1),
		decision: approvalDecisionSchema,
		ttlSeconds: z.number().int().positive().optional(),
	})
	.strict();

export const wsOutgoingMessageSchema = z.union([
	wsMessagePayloadSchema,
	wsRegenerateMessageSchema,
	wsSetSessionMessageSchema,
	wsStatsRequestMessageSchema,
	wsStopMessageSchema,
	wsToolConfirmationResponseSchema,
]);

export type V2Attachment = z.infer<typeof attachmentSchema>;
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;
export type ToolConfirmationRequest = z.infer<
	typeof toolConfirmationRequestSchema
>;
export type V2WsIncomingMessage = z.infer<typeof wsIncomingMessageSchema>;
export type V2WsOutgoingMessage = z.infer<typeof wsOutgoingMessageSchema>;
