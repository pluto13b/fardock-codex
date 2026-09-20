const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');

const outputDir = path.resolve(__dirname, '../apps/client/sources/assets/images');

function color(hex, alpha = 255) {
    const value = hex.replace('#', '');
    return {
        r: Number.parseInt(value.slice(0, 2), 16),
        g: Number.parseInt(value.slice(2, 4), 16),
        b: Number.parseInt(value.slice(4, 6), 16),
        a: alpha,
    };
}

function blend(png, x, y, next, coverage = 1) {
    if (x < 0 || y < 0 || x >= png.width || y >= png.height || coverage <= 0) return;
    const index = (png.width * y + x) << 2;
    const sourceAlpha = (next.a / 255) * Math.min(1, coverage);
    const targetAlpha = png.data[index + 3] / 255;
    const outAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
    if (outAlpha === 0) return;
    png.data[index] = Math.round((next.r * sourceAlpha + png.data[index] * targetAlpha * (1 - sourceAlpha)) / outAlpha);
    png.data[index + 1] = Math.round((next.g * sourceAlpha + png.data[index + 1] * targetAlpha * (1 - sourceAlpha)) / outAlpha);
    png.data[index + 2] = Math.round((next.b * sourceAlpha + png.data[index + 2] * targetAlpha * (1 - sourceAlpha)) / outAlpha);
    png.data[index + 3] = Math.round(outAlpha * 255);
}

function fill(png, next) {
    for (let y = 0; y < png.height; y += 1) {
        for (let x = 0; x < png.width; x += 1) blend(png, x, y, next);
    }
}

function line(png, x1, y1, x2, y2, width, next) {
    const radius = width / 2;
    const minX = Math.max(0, Math.floor(Math.min(x1, x2) - radius - 1));
    const maxX = Math.min(png.width - 1, Math.ceil(Math.max(x1, x2) + radius + 1));
    const minY = Math.max(0, Math.floor(Math.min(y1, y2) - radius - 1));
    const maxY = Math.min(png.height - 1, Math.ceil(Math.max(y1, y2) + radius + 1));
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSquared = dx * dx + dy * dy;
    for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
            const px = x + 0.5;
            const py = y + 0.5;
            const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSquared));
            const nearestX = x1 + t * dx;
            const nearestY = y1 + t * dy;
            const distance = Math.hypot(px - nearestX, py - nearestY);
            blend(png, x, y, next, radius + 0.5 - distance);
        }
    }
}

function glyph(png, next, scale = 1) {
    const centerX = png.width / 2;
    const centerY = png.height / 2;
    const unit = Math.min(png.width, png.height) * scale;
    const left = centerX - unit * 0.24;
    const mid = centerX - unit * 0.045;
    const top = centerY - unit * 0.2;
    const bottom = centerY + unit * 0.2;
    const stroke = unit * 0.064;
    line(png, left, top, mid, centerY, stroke, next);
    line(png, mid, centerY, left, bottom, stroke, next);
    line(png, centerX + unit * 0.04, bottom, centerX + unit * 0.26, bottom, stroke, next);
}

function write(name, size, background, foreground, scale = 1) {
    const png = new PNG({ width: size, height: size, colorType: 6 });
    if (background) fill(png, color(background));
    glyph(png, color(foreground), scale);
    fs.writeFileSync(path.join(outputDir, name), PNG.sync.write(png));
}

fs.mkdirSync(outputDir, { recursive: true });
write('icon.png', 1024, '#17171B', '#F7F7F8', 1);
write('icon-adaptive.png', 1024, null, '#F7F7F8', 0.72);
write('icon-monochrome.png', 1024, null, '#FFFFFF', 0.72);
write('icon-notification.png', 96, null, '#FFFFFF', 0.88);
write('favicon.png', 128, '#17171B', '#F7F7F8', 0.9);
write('splash-android-light.png', 1024, null, '#17171B', 0.58);
write('splash-android-dark.png', 1024, null, '#F7F7F8', 0.58);

console.log('Generated Codex Plus brand assets in', outputDir);
