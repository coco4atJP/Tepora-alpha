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

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB

async function compressImage(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const url = URL.createObjectURL(file);
		const img = new Image();
		img.onload = () => {
			URL.revokeObjectURL(url);
			const canvas = document.createElement("canvas");
			const ctx = canvas.getContext("2d");
			if (!ctx) {
				reject(new Error("Failed to get canvas context"));
				return;
			}

			// 段階的圧縮設定: [最大長辺px, JPEG/WebP品質]
			const steps = [
				{ maxDim: 2048, quality: 0.8 },
				{ maxDim: 1536, quality: 0.6 },
				{ maxDim: 1024, quality: 0.4 },
			];

			let lastBase64Payload = "";

			for (const step of steps) {
				let width = img.width;
				let height = img.height;

				if (width > step.maxDim || height > step.maxDim) {
					if (width > height) {
						height = Math.round((height * step.maxDim) / width);
						width = step.maxDim;
					} else {
						width = Math.round((width * step.maxDim) / height);
						height = step.maxDim;
					}
				}

				canvas.width = width;
				canvas.height = height;
				ctx.clearRect(0, 0, width, height);
				ctx.drawImage(img, 0, 0, width, height);

				// PNGなどは透過を維持するためそのままファイルタイプを使用するが、
				// サイズ削減効果が大きいのは image/jpeg か image/webp。
				// 現状は元のファイルタイプを利用して品質指定する。
				const type = file.type === "image/png" ? "image/png" : "image/jpeg";
				const dataUrl = canvas.toDataURL(type, step.quality);

				const commaIndex = dataUrl.indexOf(",");
				const base64Data = dataUrl.slice(commaIndex + 1);
				const approxBytes = Math.round((base64Data.length * 3) / 4);

				lastBase64Payload = base64Data;
				if (approxBytes <= MAX_IMAGE_BYTES) {
					break;
				}
			}

			resolve(lastBase64Payload);
		};
		img.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new Error(`Failed to load image ${file.name}`));
		};
		img.src = url;
	});
}

export async function prepareComposerFiles(
	files: readonly File[],
): Promise<PreparedComposerAttachment[]> {
	const prepared: PreparedComposerAttachment[] = [];

	for (const file of files) {
		const isImage = file.type.startsWith("image/");
		const textLike = !isImage && isTextLikeFile(file.name, file.type);
		
		let content = "";
		let type = file.type || "application/octet-stream";

		if (isImage) {
			// 画像の場合はCanvas経由で段階的圧縮し、5MB以下に収める
			content = await compressImage(file);
			// compressImage内でjpeg化するケースを考慮（PNG透過以外はJPEGへ強制）
			if (type !== "image/png") {
				type = "image/jpeg";
			}
		} else if (textLike) {
			content = await readFileAsText(file);
			type = file.type || "text/plain";
		} else {
			content = await readFileAsBase64(file);
		}

		prepared.push({
			name: file.name,
			type,
			content,
			piiFindings: textLike ? detectPii(content) : [],
		});
	}

	return prepared;
}
