import { describe, expect, it } from "vitest";
import { sanitizeUrl } from "../../../utils/sanitizeUrl";

describe("sanitizeUrl", () => {
    it("allows https URLs", () => {
        expect(sanitizeUrl("https://example.com")).toBe("https://example.com");
    });

    it("allows http URLs", () => {
        expect(sanitizeUrl("http://example.com")).toBe("http://example.com");
    });

    it("rejects javascript: scheme", () => {
        expect(sanitizeUrl("javascript:alert('xss')")).toBe("#");
    });

    it("rejects data: scheme", () => {
        expect(sanitizeUrl("data:text/html,<script>alert('xss')</script>")).toBe("#");
    });

    it("returns # for empty string", () => {
        expect(sanitizeUrl("")).toBe("#");
    });

    it("returns # for hash-only", () => {
        expect(sanitizeUrl("#")).toBe("#");
    });

    it("returns # for invalid URL", () => {
        expect(sanitizeUrl("not-a-url")).toBe("#");
    });

    it("rejects ftp: scheme", () => {
        expect(sanitizeUrl("ftp://example.com/file")).toBe("#");
    });

    it("handles URLs with paths and params", () => {
        expect(sanitizeUrl("https://example.com/path?q=1&b=2#hash")).toBe(
            "https://example.com/path?q=1&b=2#hash",
        );
    });
});
