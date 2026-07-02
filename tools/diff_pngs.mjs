// Pixel-diff two arbitrary same-size PNGs (unlike tools/diff.mjs, which is bound
// to the <artifactDir>/reference.png-vs-js.png convention). Prints the mismatch
// count and the bounding box of differing pixels, and writes a diff image.
//
// Usage: node tools/diff_pngs.mjs <a.png> <b.png> <diff_out.png>

import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const [aPath, bPath, outPath] = process.argv.slice(2);
if (!aPath || !bPath || !outPath) {
  console.error('usage: node tools/diff_pngs.mjs <a.png> <b.png> <diff_out.png>');
  process.exit(2);
}

const a = PNG.sync.read(readFileSync(aPath));
const b = PNG.sync.read(readFileSync(bPath));
if (a.width !== b.width || a.height !== b.height) {
  console.error(`size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  process.exit(1);
}
const d = new PNG({ width: a.width, height: a.height });
const n = pixelmatch(a.data, b.data, d.data, a.width, a.height, { threshold: 0.05 });
writeFileSync(outPath, PNG.sync.write(d));

let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
for (let y = 0; y < a.height; y++) {
  for (let x = 0; x < a.width; x++) {
    const i = (y * a.width + x) * 4;
    if (d.data[i] === 255 && d.data[i + 1] === 0) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}
console.log('diff pixels:', n, n ? `bbox: ${minX},${minY} -> ${maxX},${maxY}` : '(identical)');
process.exit(0);
