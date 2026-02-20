import { describe, it, expect } from 'vitest';

// Vitestのimport.meta.globを使用してlocalesディレクトリのJSONファイルを静的に読み込む
// これによりNode.js固有のAPIを使用しなくても済む
const translationModules = import.meta.glob('/public/locales/*/translation.json', {
    eager: true,
    import: 'default',
});

describe('Locale Translation Files', () => {
    it('should have at least one locale defined', () => {
        expect(Object.keys(translationModules).length).toBeGreaterThan(0);
    });

    it.each(Object.entries(translationModules))(
        'should have valid JSON object for locale file: %s',
        (_filePath: string, moduleContent: unknown) => {
            expect(typeof moduleContent).toBe('object');
            expect(moduleContent).not.toBeNull();
        },
    );
});
