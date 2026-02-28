const fs = require('fs');
const path = require('path');

function walkDir(dir, callback) {
    fs.readdirSync(dir).forEach(f => {
        let dirPath = path.join(dir, f);
        let isDirectory = fs.statSync(dirPath).isDirectory();
        isDirectory ? walkDir(dirPath, callback) : callback(path.join(dir, f));
    });
}

// Japanese regex
const jpregex = /[一-龠ぁ-んァ-ヴ]/;
const results = [];

walkDir('e:/Tepora_Project/Tepora-app/frontend/src', function (filePath) {
    if (!filePath.endsWith('.tsx') && !filePath.endsWith('.ts')) return;
    if (filePath.replace(/\\/g, '/').includes('/test/') || filePath.includes('.test.')) return; // Ignore tests
    if (filePath.replace(/\\/g, '/').includes('/types/')) return; // Ignore types with comments

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    let inCommentBlock = false;

    lines.forEach((line, index) => {
        const trimmed = line.trim();

        // Multi-line comment tracking
        if (trimmed.startsWith('/*')) inCommentBlock = true;
        if (inCommentBlock) {
            if (trimmed.includes('*/')) inCommentBlock = false;
            return;
        }

        // Ignore single line comments
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;

        // Ignore console logs
        if (trimmed.includes('console.log') || trimmed.includes('console.error') || trimmed.includes('console.warn')) return;

        // Find Japanese text
        if (jpregex.test(line)) {
            // Ignore lines that just contain Japanese in comments at the end of the line
            const codePart = line.split('//')[0].trim();
            if (jpregex.test(codePart)) {
                results.push(`${filePath}:${index + 1}: ${codePart}`);
            }
        }
    });
});

console.log(results.join('\n'));
