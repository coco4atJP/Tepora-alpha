import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionSidebarView } from "./SessionSidebarView";

describe("SessionSidebarView", () => {
	it("opens the menu and routes rename and delete actions", async () => {
		const onRenameSession = vi.fn().mockResolvedValue(undefined);
		const onDeleteSession = vi.fn().mockResolvedValue(undefined);

		render(
			<SessionSidebarView
				state="ready"
				errorMessage={null}
				pendingSessionId={null}
				onSelectSession={vi.fn()}
				onCreateSession={vi.fn().mockResolvedValue(undefined)}
				onRenameSession={onRenameSession}
				onDeleteSession={onDeleteSession}
				sessions={[
					{
						id: "session-1",
						title: "First session",
						preview: "Preview",
						updatedAt: "2026-03-23T10:00:00.000Z",
						messageCount: 3,
						isSelected: true,
					},
				]}
			/>,
		);

		fireEvent.click(screen.getByLabelText("Session actions"));
		fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
		fireEvent.change(screen.getByDisplayValue("First session"), {
			target: { value: "Renamed session" },
		});
		await act(async () => {
			fireEvent.submit(screen.getByRole("button", { name: "Save" }).closest("form")!);
		});

		expect(onRenameSession).toHaveBeenCalledWith("session-1", "Renamed session");

		fireEvent.click(screen.getByLabelText("Session actions"));
		fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		});

		expect(onDeleteSession).toHaveBeenCalledWith("session-1");
	});
});
