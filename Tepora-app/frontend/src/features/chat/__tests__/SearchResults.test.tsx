import { describe, expect, it } from "vitest";
import { render, screen } from "../../../test/test-utils";

import type { SearchResult } from "../../../types";
import SearchResults from "../SearchResults";

describe("SearchResults", () => {
	it("renders empty state", () => {
		render(<SearchResults results={[]} />);
		expect(screen.getByText("検索結果待機中...")).toBeInTheDocument();
	});

	it("renders results correctly", () => {
		const mockResults: SearchResult[] = [
			{
				title: "Test Result",
				url: "https://example.com",
				snippet: "This is a test snippet",
			},
		];

		render(<SearchResults results={mockResults} />);

		expect(screen.getByText("Test Result")).toBeInTheDocument();
		expect(screen.getByText("This is a test snippet")).toBeInTheDocument();
		expect(screen.getByText("1 results")).toBeInTheDocument();

		const link = screen.getByRole("link");
		expect(link).toHaveAttribute("href", "https://example.com");
		expect(link).toHaveAttribute("target", "_blank");
	});
	it("handles backend inconsistency (link property)", () => {
		const mockResults = [
			{
				title: "Legacy Result",
				link: "https://legacy.com", // Old format
				snippet: "Old snippet",
			},
		] as unknown as SearchResult[];

		render(<SearchResults results={mockResults} />);

		const link = screen.getByRole("link");
		expect(link).toHaveAttribute("href", "https://legacy.com");
		expect(screen.getByText(/legacy\.com/)).toBeInTheDocument();
	});

	it("safely handles invalid URLs", () => {
		const mockResults = [
			{
				title: "Invalid URL Result",
				url: "not-a-url",
				snippet: "Snippet",
			},
		] as SearchResult[];

		render(<SearchResults results={mockResults} />);

		// Should not crash, and should display "Unknown Source" or similar fallback
		expect(screen.getByText("Unknown Source")).toBeInTheDocument();
		const link = screen.getByRole("link");
		expect(link).toHaveAttribute("href", "not-a-url");
	});

	it("safely handles missing URL", () => {
		const mockResults = [
			{
				title: "Missing URL Result",
				snippet: "Snippet",
			},
		] as unknown as SearchResult[];

		render(<SearchResults results={mockResults} />);

		// Should not crash
		const link = screen.getByRole("link");
		expect(link).toHaveAttribute("href", "#");
	});
});
