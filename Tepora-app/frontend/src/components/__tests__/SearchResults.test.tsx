import { describe, expect, it } from "vitest";
import { render, screen } from "../../test/test-utils";
import type { SearchResult } from "../../types";
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
});
