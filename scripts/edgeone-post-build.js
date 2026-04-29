const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const src = path.join(rootDir, 'static');
const dest = path.join(rootDir, '.edgeone', 'cloud-functions', 'api-go', 'static');

if (fs.existsSync(src)) {
    console.log(`[post-build] Copying ${src} to ${dest}`);
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(src, dest, { recursive: true, force: true });
    console.log('[post-build] Static files copied to cloud-function successfully.');
} else {
    console.log(`[post-build] Source ${src} not found, nothing to copy.`);
}
