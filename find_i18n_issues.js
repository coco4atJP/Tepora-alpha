const fs = require('fs');
const path = require('path');

function walk(dir, files = []) {
    const list = fs.readdirSync(dir);
    for (const file of list) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            walk(filePath, files);
        } else if (file.endsWith('.tsx') || file.endsWith('.ts')) {
            files.push(filePath);
        }
    }
    return files;
}

const REQUIRED_PATHS = [
    path.join('src'),
    path.join('public', 'locales', 'ja', 'translation.json'),
    path.join('public', 'locales', 'en', 'translation.json'),
];

function isValidFrontendRoot(dir) {
    return REQUIRED_PATHS.every((requiredPath) => fs.existsSync(path.join(dir, requiredPath)));
}

function resolveFrontendRoot(cliArg) {
    const scriptDir = __dirname;
    const candidates = [];

    if (cliArg) {
        candidates.push(path.resolve(process.cwd(), cliArg));
    }

    candidates.push(path.resolve(process.cwd(), 'Tepora-app/frontend'));
    candidates.push(path.resolve(scriptDir, 'Tepora-app/frontend'));
    candidates.push(path.resolve(process.cwd(), 'frontend'));
    candidates.push(path.resolve(scriptDir, 'frontend'));

    const uniqueCandidates = [...new Set(candidates)];
    const resolved = uniqueCandidates.find((candidate) => isValidFrontendRoot(candidate));

    if (!resolved) {
        const attempted = uniqueCandidates.map((candidate) => `  - ${candidate}`).join('\n');
        throw new Error(
            `Frontend directory could not be resolved.\nChecked:\n${attempted}\n\n` +
            'Use: node find_i18n_issues.js <path-to-frontend-root>'
        );
    }

    return resolved;
}

const rootDir = resolveFrontendRoot(process.argv[2]);

const files = walk(path.join(rootDir, 'src'));
const jaTranslationPath = path.join(rootDir, 'public/locales/ja/translation.json');
const enTranslationPath = path.join(rootDir, 'public/locales/en/translation.json');

const jaJson = JSON.parse(fs.readFileSync(jaTranslationPath, 'utf8'));
const enJson = JSON.parse(fs.readFileSync(enTranslationPath, 'utf8'));

function flattenObj(obj, parent = '', res = {}) {
    for (let key in obj) {
        let propName = parent ? parent + '.' + key : key;
        if (typeof obj[key] == 'object') {
            flattenObj(obj[key], propName, res);
        } else {
            res[propName] = obj[key];
        }
    }
    return res;
}

const flatJa = flattenObj(jaJson);
const flatEn = flattenObj(enJson);

// Regex
const tFunctionRegex = /t\([\"']([^\"']+)[\"']/g;
const hardcodedEnglishJSXRegex = />\s*([A-Za-z][A-Za-z0-9\s,\.\?\!]{2,})\s*<\/?[a-zA-Z]/g;
const placeholderRegex = /placeholder=[\"']([^\"'\{]+)[\"']/g;
const titleRegex = /title=[\"']([^\"'\{]+)[\"']/g;

const ignoreList = ['src/locales', 'src/test'];

const missingKeys = new Set();
const hardcodedTexts = [];

for (const file of files) {
    if (ignoreList.some(ignore => file.replace(/\\/g, '/').includes(ignore))) continue;

    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');

    lines.forEach((line, i) => {
        const lineNum = i + 1;
        const cleanLine = line.trim();
        if (cleanLine.startsWith('//') || cleanLine.startsWith('*')) return;

        // Check missing translation keys
        let match;
        while ((match = tFunctionRegex.exec(line)) !== null) {
            const key = match[1];
            if (!flatJa[key]) {
                missingKeys.add(`Missing JA: ${key} (in ${file}:${lineNum})`);
            }
            if (!flatEn[key]) {
                missingKeys.add(`Missing EN: ${key} (in ${file}:${lineNum})`);
            }
        }

        // Check hardcoded texts in JSX tags
        while ((match = hardcodedEnglishJSXRegex.exec(line)) !== null) {
            const text = match[1].trim();
            // Ignore simple class names or common keywords if they mistakenly match
            if (text.length > 2 && !text.includes('export ')) {
                hardcodedTexts.push(`[JSX Text] ${file}:${lineNum} - "${text}"`);
            }
        }

        // Check placeholders properly not being translated
        while ((match = placeholderRegex.exec(line)) !== null) {
            if (!match[1].startsWith('{')) {
                hardcodedTexts.push(`[Placeholder target] ${file}:${lineNum} - "${match[1]}"`);
            }
        }

        // Check titles properly not being translated
        while ((match = titleRegex.exec(line)) !== null) {
            if (!match[1].startsWith('{')) {
                hardcodedTexts.push(`[Title attribute] ${file}:${lineNum} - "${match[1]}"`);
            }
        }
    });
}

console.log("=== MISSING TRANSLATION KEYS ===");
missingKeys.forEach(k => console.log(k));

console.log("\n=== POTENTIAL HARDCODED UI STRINGS ===");
hardcodedTexts.forEach(t => console.log(t));
