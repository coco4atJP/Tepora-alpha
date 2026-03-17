import { detectPii, isTextLikeFile } from "../../../shared/lib/piiDetection";

export interface PreparedComposerAttachment {
	name: string;
	type: string;
	content: string;
	piiFindings: Array<{
		category: string;
		preview: string;
	}>;
}

function readFileAsBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			if (typeof reader.result !== "string") {
				reject(new Error(`Failed to read ${file.name}`));
				return;
			}

			const commaIndex = reader.result.indexOf(",");
			if (commaIndex === -1) {
				reject(new Error(`Invalid file payload for ${file.name}`));
				return;
			}

			resolve(reader.result.slice(commaIndex + 1));
		};
		reader.onerror = () => {
			reject(new Error(`Failed to read ${file.name}`));
		};
		reader.readAsDataURL(file);
	});
}

function readFileAsText(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			if (typeof reader.result !== "string") {
				reject(new Error(`Failed to read ${file.name}`));
				return;
			}

			resolve(reader.result);
		};
		reader.onerror = () => {
			reject(new Error(`Failed to read ${file.name}`));
		};
		reader.readAsText(file);
	});
}

export async function prepareComposerFiles(
	files: readonly File[],
): Promise<PreparedComposerAttachment[]> {
	const prepared: PreparedComposerAttachment[] = [];

	for (const file of files) {
		const textLike = isTextLikeFile(file.name, file.type);
		const content = textLike
			? await readFileAsText(file)
			: await readFileAsBase64(file);
		prepared.push({
			name: file.name,
			type:
				file.type || (textLike ? "text/plain" : "application/octet-stream"),
			content,
			piiFindings: textLike ? detectPii(content) : [],
		});
	}

	return prepared;
}
