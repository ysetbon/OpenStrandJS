// Compose several equal-height PNGs side by side into one montage PNG, with a
// thin white gutter between panels. Used to place OSS (Qt oracle) | JS | diff
// next to each other for a PR fidelity comment.
//
// Usage: node tools/montage.mjs <out.png> <panel1.png> [panel2.png ...]
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const [outPath, ...panelPaths] = process.argv.slice(2);
if (!outPath || panelPaths.length === 0) {
  console.error('usage: node tools/montage.mjs <out.png> <panel1.png> [panel2.png ...]');
  process.exit(2);
}

const GUTTER = 8; // px of white between panels
const panels = panelPaths.map((p) => PNG.sync.read(readFileSync(p)));
const height = Math.max(...panels.map((p) => p.height));
const width = panels.reduce((w, p) => w + p.width, 0) + GUTTER * (panels.length - 1);

const out = new PNG({ width, height, fill: true });
// white background
for (let i = 0; i < out.data.length; i += 4) {
  out.data[i] = 255; out.data[i + 1] = 255; out.data[i + 2] = 255; out.data[i + 3] = 255;
}

let x = 0;
for (const p of panels) {
  // vertically center panels shorter than the tallest
  const dy = Math.floor((height - p.height) / 2);
  PNG.bitblt(p, out, 0, 0, p.width, p.height, x, dy);
  x += p.width + GUTTER;
}

writeFileSync(outPath, PNG.sync.write(out));
console.log(`montage -> ${outPath} ${width}x${height} (${panels.length} panels)`);
