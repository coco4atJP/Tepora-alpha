const fs = require('fs');
const path = require('path');

function walkDir(dir, callback) {
    fs.readdirSync(dir).forEach(f => {
        let dirPath = path.join(dir, f);
        if (fs.statSync(dirPath).isDirectory()) {
            walkDir(dirPath, callback);
        } else {
            callback(dirPath);
        }
    });
}

const results = [];
walkDir('e:/Tepora_Project/Tepora-app/frontend/src', function (filePath) {
    if (!filePath.endsWith('.tsx')) return;
    if (filePath.replace(/\\/g, '/').includes('/test/') || filePath.includes('.test.')) return;

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    lines.forEach((line, i) => {
        // Match text inside > ... <
        const matches = line.match(/>([^<>{}]*[\wぁ-んァ-ヶ亜-熙]+[^<>{}]*)</g); // \w includes english letters
        if (matches) {
            matches.forEach(m => {
                const text = m.substring(1, m.length - 1).trim();
                // ignore if too short or likely code
                if (text.length > 1 && /[a-zA-Z一-龠ぁ-んァ-ヴ]/.test(text)) {
                    results.push(`${filePath}:${i + 1}: ${text}`);
                }
            });
        }
    });
});
fs.writeFileSync('missing_jsx_text.txt', results.join('\n'));
