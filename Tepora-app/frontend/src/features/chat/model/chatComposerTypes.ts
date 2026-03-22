import type { ChatScreenViewProps } from "../view/props";

export type ComposerAttachmentRecord =
	ChatScreenViewProps["composer"]["attachments"][number] & {
		content: string;
		piiConfirmed?: boolean;
		piiFindings?: Array<{
			category: string;
			preview: string;
		}>;
	};
