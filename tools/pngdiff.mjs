// Pixel-diff two PNGs, write a diff image, print changed-pixel stats.
// Usage: node tools/pngdiff.mjs <a.png> <b.png> <out_diff.png>
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
const [ap, bp, outp] = process.argv.slice(2);
const a = PNG.sync.read(readFileSync(ap));
const b = PNG.sync.read(readFileSync(bp));
if (a.width !== b.width || a.height !== b.height) {
  console.error(`size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  process.exit(1);
}
const { width, height } = a;
const diff = new PNG({ width, height });
const n = pixelmatch(a.data, b.data, diff.data, width, height, { threshold: 0.1 });
if (outp) writeFileSync(outp, PNG.sync.write(diff));
console.log(JSON.stringify({ changed: n, pct: Number((100 * n / (width * height)).toFixed(4)) }));
