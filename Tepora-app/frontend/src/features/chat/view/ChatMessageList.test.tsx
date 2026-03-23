import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatMessageList } from "./ChatMessageList";

vi.mock("../../settings/model/queries", () => ({
	useV2ConfigQuery: () => ({
		data: {
			active_character: "tea",
			characters: {
				tea: {
					name: "Tepora",
				},
			},
		},
	}),
}));

vi.mock("../../../utils/logger", () => ({
	logger: {
		error: vi.fn(),
	},
}));

describe("ChatMessageList", () => {
	const clipboardWriteText = vi.fn();

	beforeEach(() => {
		clipboardWriteText.mockReset();
		clipboardWriteText.mockResolvedValue(undefined);
		Object.defineProperty(window.navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: clipboardWriteText,
			},
		});
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.runOnlyPendingTimers();
		vi.useRealTimers();
	});

	it("copies a message and shows copied feedback only for the selected message", async () => {
		render(
			<ChatMessageList
				isEmpty={false}
				onRegenerate={vi.fn().mockResolvedValue(undefined)}
				messages={[
					{
						id: "user-1",
						role: "user",
						content: "hello",
						thinking: null,
						createdAt: "2026-03-23T10:00:00.000Z",
						status: "complete",
					},
					{
						id: "assistant-1",
						role: "assistant",
						content: "world",
						thinking: null,
						createdAt: "2026-03-23T10:01:00.000Z",
						status: "complete",
					},
				]}
			/>,
		);

		fireEvent.click(screen.getAllByLabelText("More actions")[0]);
		await act(async () => {
			fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }));
		});

		expect(clipboardWriteText).toHaveBeenCalledWith("hello");
		expect(screen.getByText("Copied")).toBeInTheDocument();
		expect(screen.getAllByText("Copied")).toHaveLength(1);

		act(() => {
			vi.advanceTimersByTime(2000);
		});

		expect(screen.queryByText("Copied")).not.toBeInTheDocument();
	});

	it("shows regenerate only for the latest complete assistant or system message", () => {
		const onRegenerate = vi.fn().mockResolvedValue(undefined);

		render(
			<ChatMessageList
				isEmpty={false}
				onRegenerate={onRegenerate}
				messages={[
					{
						id: "assistant-old",
						role: "assistant",
						content: "older answer",
						thinking: null,
						createdAt: "2026-03-23T10:00:00.000Z",
						status: "complete",
					},
					{
						id: "assistant-streaming",
						role: "assistant",
						content: "still going",
						thinking: null,
						createdAt: "2026-03-23T10:01:00.000Z",
						status: "streaming",
					},
					{
						id: "system-latest",
						role: "system",
						content: "latest complete",
						thinking: null,
						createdAt: "2026-03-23T10:02:00.000Z",
						status: "complete",
					},
				]}
			/>,
		);

		fireEvent.click(screen.getAllByLabelText("More actions")[0]);
		expect(screen.queryByRole("menuitem", { name: "Regenerate" })).not.toBeInTheDocument();

		fireEvent.click(screen.getAllByLabelText("More actions")[2]);
		fireEvent.click(screen.getByRole("menuitem", { name: "Regenerate" }));

		expect(onRegenerate).toHaveBeenCalledTimes(1);
	});
});
