import type { ZodType } from "zod";
import { logger } from "../../utils/logger";

export function safeParseWithSchema<T>(
	schema: ZodType<T>,
	payload: unknown,
	context: string,
) {
	const result = schema.safeParse(payload);
	if (!result.success) {
		logger.error(`[Validation] Failed to parse ${context}`, result.error.flatten());
	}
	return result;
}
