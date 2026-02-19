import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

describe('Locale Translation Files', () => {
    const localesDir = path.resolve(__dirname, '../../../public/locales');

    // Skip test if locales directory doesn't exist (e.g. in some CI environments or if path is wrong)
    // But for this task checking existence is part of the test value.
    it('should have a locales directory', () => {
        expect(fs.existsSync(localesDir)).toBe(true);
    });

    // Get all language directories
    const languages = fs.readdirSync(localesDir).filter(file => {
        return fs.statSync(path.join(localesDir, file)).isDirectory();
    });

    it.each(languages)('should have valid JSON for locale: %s', (lang) => {
        const translationFile = path.join(localesDir, lang, 'translation.json');

        // Check file exists
        expect(fs.existsSync(translationFile), `translation.json should exist for ${lang}`).toBe(true);

        // Read and parse file
        const content = fs.readFileSync(translationFile, 'utf-8');
        try {
            const json = JSON.parse(content);
            expect(typeof json).toBe('object');
            expect(json).not.toBeNull();
        } catch (error) {
            throw new Error(`Failed to parse ${translationFile}: ${(error as Error).message}`);
        }
    });
});
