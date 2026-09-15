const fs = require('fs');
const path = require('path');

const targetFile = path.join(__dirname, '..', 'node_modules', 'helios-core', 'dist', 'mojang', 'net', 'ServerStatusAPI.js');

if (fs.existsSync(targetFile)) {
    let content = fs.readFileSync(targetFile, 'utf8');
    if (content.includes('const maxTries = 5;')) {
        content = content.replace('const maxTries = 5;', 'const maxTries = 50;');
        fs.writeFileSync(targetFile, content, 'utf8');
        console.log('[Patch] Applied server ping maxTries patch to helios-core.');
    } else {
        console.log('[Patch] Server ping maxTries already patched or not found.');
    }
} else {
    console.log('[Patch] Target file not found, skipping patch.');
}
