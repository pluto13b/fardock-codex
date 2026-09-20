const fs = require('node:fs');
const path = require('node:path');

const outputArg = process.argv[2];
if (!outputArg) {
  throw new Error('Usage: node scripts/finalize-web-html.cjs <output-dir>');
}

const indexPath = path.resolve(outputArg, 'index.html');
const original = fs.readFileSync(indexPath, 'utf8');
const finalized = original
  .replace('<html lang="en">', '<html lang="zh-CN">')
  .replace('initial-scale=1, shrink-to-fit=no', 'initial-scale=1, shrink-to-fit=no, viewport-fit=cover');

if (!finalized.includes('<html lang="zh-CN">') || !finalized.includes('viewport-fit=cover')) {
  throw new Error('Expo index template changed; Web language/safe-area finalization was not applied');
}
if (finalized !== original) {
  fs.writeFileSync(indexPath, finalized);
}
