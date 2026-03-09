import type { PiiFinding } from "../types";

const textExtensions = new Set([
	"txt",
	"md",
	"json",
	"xml",
	"csv",
	"log",
	"py",
	"js",
	"ts",
	"tsx",
	"jsx",
	"html",
	"css",
	"yml",
	"yaml",
	"toml",
	"ini",
	"cfg",
	"conf",
	"sh",
	"bat",
	"ps1",
	"c",
	"cpp",
	"h",
	"hpp",
	"java",
	"go",
	"rs",
	"rb",
	"php",
	"sql",
	"r",
	"m",
	"swift",
	"kt",
]);

const emailPattern = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi;
const phonePattern = /(?:\+?\d[\d\-\s().]{7,}\d)/g;
const apiKeyPattern = /\b(?:sk-[a-z0-9]{20,}|ghp_[a-z0-9]{20,}|AIza[0-9A-Za-z\-_]{20,}|AKIA[0-9A-Z]{16})\b/gi;
const tokenPattern = /\b(?:token|bearer|jwt)[=: ]+[a-z0-9._-]{16,}\b/gi;
const cardPattern = /\b(?:\d[ -]*?){13,19}\b/g;

const preview = (value: string) => {
	const trimmed = value.trim();
	if (trimmed.length <= 12) return trimmed;
	return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
};

const pushUnique = (target: PiiFinding[], category: string, value: string) => {
	const finding = { category, preview: preview(value) };
	if (!target.some((entry) => entry.category === finding.category && entry.preview === finding.preview)) {
		target.push(finding);
	}
};

const luhnValid = (digits: string) => {
	let sum = 0;
	let alternate = false;
	for (let index = digits.length - 1; index >= 0; index -= 1) {
		let value = Number.parseInt(digits[index] || "0", 10);
		if (alternate) {
			value *= 2;
			if (value > 9) value -= 9;
		}
		sum += value;
		alternate = !alternate;
	}
	return sum % 10 === 0;
};

export const isTextLikeFile = (fileName: string, mimeType?: string) => {
	if (mimeType) {
		const normalized = mimeType.toLowerCase();
		if (
			normalized.startsWith("text/") ||
			normalized === "application/json" ||
			normalized === "application/xml" ||
			normalized === "application/yaml" ||
			normalized === "application/toml"
		) {
			return true;
		}
	}
	const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
	return textExtensions.has(extension);
};

export const detectPii = (input: string): PiiFinding[] => {
	const text = input.trim();
	if (!text) return [];

	const findings: PiiFinding[] = [];
	for (const match of text.matchAll(emailPattern)) {
		pushUnique(findings, "email", match[0]);
	}
	for (const match of text.matchAll(phonePattern)) {
		const digits = (match[0] || "").replace(/\D/g, "");
		if (digits.length >= 10) pushUnique(findings, "phone", match[0]);
	}
	for (const match of text.matchAll(apiKeyPattern)) {
		pushUnique(findings, "api_key", match[0]);
	}
	for (const match of text.matchAll(tokenPattern)) {
		pushUnique(findings, "token", match[0]);
	}
	for (const match of text.matchAll(cardPattern)) {
		const digits = (match[0] || "").replace(/\D/g, "");
		if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
			pushUnique(findings, "card", match[0]);
		}
	}
	return findings;
};
