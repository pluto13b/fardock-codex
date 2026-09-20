const fs = require('node:fs');
const path = require('node:path');

const [outputArg, mode] = process.argv.slice(2);
if (!outputArg || !['production', 'preview'].includes(mode)) {
  throw new Error('Usage: node scripts/verify-web-build.cjs <output-dir> <production|preview>');
}

const outputDir = path.resolve(outputArg);
const indexPath = path.join(outputDir, 'index.html');
const indexHtml = fs.readFileSync(indexPath, 'utf8');
const expectedTitle = mode === 'production' ? 'Codex Plus' : 'Codex Plus (preview)';
if (!indexHtml.includes(`<title>${expectedTitle}</title>`)) {
  throw new Error(`${mode} export has the wrong title; Metro/App config cache may be stale`);
}
if (!indexHtml.includes('<html lang="zh-CN">') || !indexHtml.includes('viewport-fit=cover')) {
  throw new Error(`${mode} export is missing the mobile language or safe-area HTML metadata`);
}

const scriptPaths = [...indexHtml.matchAll(/<script[^>]+src="([^"]+\.js)"/g)]
  .map((match) => path.join(outputDir, match[1].replace(/^\//, '').replaceAll('/', path.sep)));
const bundle = scriptPaths.map((scriptPath) => fs.readFileSync(scriptPath, 'utf8')).join('\n');
const expectedFlag = mode === 'preview' ? 'frontendPreviewEnabled=!0' : 'frontendPreviewEnabled=!1';
const forbiddenFlag = mode === 'preview' ? 'frontendPreviewEnabled=!1' : 'frontendPreviewEnabled=!0';
if (!bundle.includes(expectedFlag) || bundle.includes(forbiddenFlag)) {
  throw new Error(`${mode} export has the wrong preview flag; rebuild with an isolated or cleared Metro cache`);
}

console.log(`Verified ${mode} Web export: title and preview flag are correct.`);
