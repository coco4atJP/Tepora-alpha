import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const localesDir = path.resolve(__dirname, '../../../public/locales');

describe('Locales', () => {
	it('should contain valid JSON files', () => {
		if (!fs.existsSync(localesDir)) {
			return;
		}

		const languages = fs.readdirSync(localesDir).filter((file: string) => {
			return fs.statSync(path.join(localesDir, file)).isDirectory();
		});

		languages.forEach((lang: string) => {
			const filePath = path.join(localesDir, lang, 'translation.json');
			if (fs.existsSync(filePath)) {
				const content = fs.readFileSync(filePath, 'utf-8');
				expect(() => JSON.parse(content)).not.toThrow();
			}
		});
	});
});
