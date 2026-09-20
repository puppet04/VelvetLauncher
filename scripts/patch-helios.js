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
    console.log('[Patch] Target file not found, skipping ping patch.');
}

const dlEngineFile = path.join(__dirname, '..', 'node_modules', 'helios-core', 'dist', 'dl', 'DownloadEngine.js');
if (fs.existsSync(dlEngineFile)) {
    let content = fs.readFileSync(dlEngineFile, 'utf8');
    let modified = false;

    if (/fastq\.promise\(wrap,\s*(?:15|25)\)/.test(content)) {
        content = content.replace(/fastq\.promise\(wrap,\s*(?:15|25)\)/, 'fastq.promise(wrap, 5)');
        modified = true;
        console.log('[Patch] Converted DownloadEngine concurrency to 5 to prevent download failures.');
    } else {
        console.log('[Patch] DownloadEngine concurrency already safe or not found.');
    }

    if (content.includes("error.name === 'RequestError'") && !content.includes('error instanceof got_1.HTTPError')) {
        content = content.replace(
            "return error.name === 'RequestError' || error instanceof got_1.ReadError && error.code === 'ECONNRESET';",
            "return error.name === 'RequestError' || (error instanceof got_1.ReadError && error.code === 'ECONNRESET') || (error instanceof got_1.HTTPError && [500, 502, 503, 504].includes(error.response ? error.response.statusCode : 0));"
        );
        modified = true;
        console.log('[Patch] Added HTTP 5xx retry logic to DownloadEngine.');
    }

    if (modified) {
        fs.writeFileSync(dlEngineFile, content, 'utf8');
    }
}
