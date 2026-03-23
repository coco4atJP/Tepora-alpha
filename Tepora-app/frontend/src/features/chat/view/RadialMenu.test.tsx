import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RadialMenu } from "./RadialMenu";

describe("RadialMenu", () => {
	it("opens from the center button and selects a mode", async () => {
		const onModeChange = vi.fn();

		render(
			<RadialMenu
				currentMode="chat"
				onModeChange={onModeChange}
				onOpenSettings={vi.fn()}
			/>,
		);

		fireEvent.click(screen.getByLabelText("Open mode and settings menu"));
		fireEvent.click(screen.getByRole("button", { name: "Search" }));

		expect(onModeChange).toHaveBeenCalledWith("search");
		await waitFor(() =>
			expect(screen.getByLabelText("Open mode and settings menu")).toHaveAttribute(
				"aria-expanded",
				"false",
			),
		);
	});

	it("closes on escape", async () => {
		render(
			<RadialMenu
				currentMode="chat"
				onModeChange={vi.fn()}
				onOpenSettings={vi.fn()}
			/>,
		);

		const toggle = screen.getByLabelText("Open mode and settings menu");
		fireEvent.click(toggle);
		expect(toggle).toHaveAttribute("aria-expanded", "true");

		fireEvent.keyDown(document, { key: "Escape" });

		await waitFor(() =>
			expect(toggle).toHaveAttribute("aria-expanded", "false"),
		);
	});
});
