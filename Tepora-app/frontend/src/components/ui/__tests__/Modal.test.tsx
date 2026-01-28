import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "../../../test/test-utils";
import Modal from "../Modal";

describe("Modal", () => {
	const defaultProps = {
		isOpen: true,
		onClose: vi.fn(),
		title: "Test Modal",
		children: <div>Modal Content</div>,
	};

	it("renders correctly when open", () => {
		render(<Modal {...defaultProps} />);
		expect(screen.getByText("Test Modal")).toBeInTheDocument();
		expect(screen.getByText("Modal Content")).toBeInTheDocument();
		expect(screen.getByRole("dialog")).toBeInTheDocument();
	});

	it("does not render when closed", () => {
		render(<Modal {...defaultProps} isOpen={false} />);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(screen.queryByText("Test Modal")).not.toBeInTheDocument();
	});

	it("calls onClose when close button is clicked", () => {
		render(<Modal {...defaultProps} />);
		const closeButton = screen.getByLabelText("Close");
		fireEvent.click(closeButton);
		expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
	});

	it("calls onClose when backdrop is clicked", () => {
		render(<Modal {...defaultProps} />);
		// The backdrop is the parent div of the dialog content, or specifically the one with the click handler
		// In the component implementation:
		// <div className="fixed inset-0 bg-theme-overlay..." onClick={handleBackdropClick} />
		// We can find it by generic queries since it doesn't have a role, or we can use the structure.
		// Detailed analysis of Modal.tsx shows the backdrop has onClick.

		// To safely find backdrop, we can look for the element that is NOT the dialog container but covers the screen.
		// However, since we are using portals, it might be slightly tricky.
		// A safer way in this specific component structure:
		// The Modal renders:
		// <div role="dialog">
		//   <div onClick={handleBackdropClick} />  <-- Backdrop
		//   <div>...content...</div>
		// </div>

		// Wait, the outer div has role="dialog". The backdrop is inside it.
		// Let's verify the structure from Modal.tsx:
		// <div role="dialog">
		//    <div className="fixed inset-0..." onClick={handleBackdropClick} /> --> Backdrop
		//    <div className="relative..."> --> Content Container

		const dialog = screen.getByRole("dialog");
		// The first child is the backdrop
		const backdrop = dialog.firstChild;

		fireEvent.click(backdrop as Element);
		expect(defaultProps.onClose).toHaveBeenCalled();
	});

	it("calls onClose when Escape key is pressed", () => {
		render(<Modal {...defaultProps} />);
		fireEvent.keyDown(document, { key: "Escape" });
		expect(defaultProps.onClose).toHaveBeenCalled();
	});

	it("applies size classes correctly", () => {
		const { rerender } = render(<Modal {...defaultProps} size="lg" />);
		// Current structure: dialog -> backdrop + container
		// The container has the size classes.
		// It's the second child of the dialog role div.
		const dialog = screen.getByRole("dialog");
		const container = dialog.lastChild as HTMLElement;

		expect(container.className).toContain("max-w-2xl");

		rerender(<Modal {...defaultProps} size="xl" />);
		const containerXl = screen.getByRole("dialog").lastChild as HTMLElement;
		expect(containerXl.className).toContain("max-w-4xl");
	});

	it("renders custom content without default padding container when customContent is true", () => {
		render(
			<Modal {...defaultProps} customContent={true}>
				<div data-testid="custom-inner">Custom</div>
			</Modal>,
		);
		const customElement = screen.getByTestId("custom-inner");
		// Check that it's rendered
		expect(customElement).toBeInTheDocument();
		// Verify parent doesn't have the p-4 overflow-y-auto classes associated with default mode
		// The immediate parent of customElement should be the modal container div
		expect(customElement.parentElement?.className).toContain("relative w-full");
	});
});
