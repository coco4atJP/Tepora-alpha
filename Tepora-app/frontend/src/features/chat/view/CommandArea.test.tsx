import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommandArea } from "./CommandArea";

describe("CommandArea", () => {
	it("renders the updated send hint", () => {
		render(
			<CommandArea
				draft=""
				onDraftChange={vi.fn()}
				onSend={vi.fn()}
				onStop={vi.fn()}
				onRegenerate={vi.fn()}
				activeMode="chat"
				onModeChange={vi.fn()}
				onSearchModeChange={vi.fn()}
				onThinkingBudgetChange={vi.fn()}
				onRemoveAttachment={vi.fn()}
				composer={{
					attachments: [],
					thinkingBudget: 0,
					searchMode: "quick",
					canSend: true,
					canStop: false,
					canRegenerate: false,
					isSending: false,
					canAttachImages: true,
				}}
			/>,
		);

		expect(
			screen.getByText("Enter to send, Shift+Enter for newline"),
		).toBeInTheDocument();
	});
});
