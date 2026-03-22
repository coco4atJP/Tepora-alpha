import type { Dispatch, SetStateAction } from "react";
import { prepareComposerFiles } from "./attachmentFiles";
import type { ComposerAttachmentRecord } from "./chatComposerTypes";

interface UseChatAttachmentActionsParams {
	setComposerAttachments: Dispatch<SetStateAction<ComposerAttachmentRecord[]>>;
	setActionError: Dispatch<SetStateAction<string | null>>;
}

export function useChatAttachmentActions({
	setComposerAttachments,
	setActionError,
}: UseChatAttachmentActionsParams) {
	const handleAddFiles = async (files: readonly File[] | null) => {
		if (!files || files.length === 0) {
			return;
		}

		setActionError(null);

		try {
			const prepared = await prepareComposerFiles(files);
			const blocked = prepared.filter(
				(attachment) => attachment.piiFindings.length > 0,
			);
			const safeAttachments = prepared.filter(
				(attachment) => attachment.piiFindings.length === 0,
			);

			if (blocked.length > 0) {
				setActionError(
					`Attachment blocked by PII detection: ${blocked
						.map((attachment) => attachment.name)
						.join(", ")}`,
				);
			}

			if (safeAttachments.length === 0) {
				return;
			}

			setComposerAttachments((current) => [
				...current,
				...safeAttachments.map((attachment) => ({
					id: crypto.randomUUID(),
					name: attachment.name,
					type: attachment.type,
					status: "attached" as const,
					content: attachment.content,
					piiConfirmed: false,
					piiFindings: attachment.piiFindings,
				})),
			]);
		} catch (error) {
			setActionError(
				error instanceof Error ? error.message : "Failed to read attachments",
			);
		}
	};

	const handleRemoveAttachment = (attachmentId: string) => {
		setComposerAttachments((current) =>
			current.filter((attachment) => attachment.id !== attachmentId),
		);
	};

	return {
		handleAddFiles,
		handleRemoveAttachment,
	};
}
