import { describe, expect, it } from "vitest";
import { prepareComposerFiles } from "./attachmentFiles";

describe("prepareComposerFiles", () => {
	it("reads text attachments and returns detected pii findings", async () => {
		const file = new File(
			["contact me at test@example.com"],
			"note.txt",
			{ type: "text/plain" },
		);

		const result = await prepareComposerFiles([file]);

		expect(result).toHaveLength(1);
		expect(result[0].name).toBe("note.txt");
		expect(result[0].content).toContain("test@example.com");
		expect(result[0].piiFindings).toEqual([
			{
				category: "email",
				preview: "test....com",
			},
		]);
	});

	it("reads binary attachments as base64 and skips pii detection", async () => {
		const file = new File(
			[new Uint8Array([137, 80, 78, 71])],
			"image.bin",
			{ type: "application/octet-stream" },
		);

		const result = await prepareComposerFiles([file]);

		expect(result).toHaveLength(1);
		expect(result[0].name).toBe("image.bin");
		expect(result[0].content.length).toBeGreaterThan(0);
		expect(result[0].piiFindings).toEqual([]);
	});
});
