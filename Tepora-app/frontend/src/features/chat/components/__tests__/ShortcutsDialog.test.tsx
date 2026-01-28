import { fireEvent, render, screen } from "../../../../test/test-utils";
import { describe, expect, it, vi } from "vitest";
import { ShortcutsDialog } from "../ShortcutsDialog";

describe("ShortcutsDialog", () => {
    it("does not render when closed", () => {
        render(<ShortcutsDialog isOpen={false} onClose={vi.fn()} />);
        expect(screen.queryByText("Keyboard Shortcuts")).not.toBeInTheDocument();
    });

    it("renders when open", () => {
        render(<ShortcutsDialog isOpen={true} onClose={vi.fn()} />);
        expect(screen.getByText("Keyboard Shortcuts")).toBeInTheDocument();
        expect(screen.getByText("New Session / Search")).toBeInTheDocument();
    });

    it("calls onClose when close button clicked", () => {
        const onClose = vi.fn();
        render(<ShortcutsDialog isOpen={true} onClose={onClose} />);

        const closeBtn = screen.getByRole("button");
        fireEvent.click(closeBtn);
        expect(onClose).toHaveBeenCalled();
    });

    // Optional: test backdrop click if feasible
});
