// Pixel-diff reference.png vs js.png in <artifactDir>, write diff.png, and print
// a JSON summary (mismatch count + percentages). Drives the tuning loop.
//
// Usage: node tools/diff.mjs <artifactDir>

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const artifactDir = process.argv[2];
if (!artifactDir) {
  console.error('usage: node tools/diff.mjs <artifactDir>');
  process.exit(2);
}

const ref = PNG.sync.read(readFileSync(path.join(artifactDir, 'reference.png')));
const js = PNG.sync.read(readFileSync(path.join(artifactDir, 'js.png')));

if (ref.width !== js.width || ref.height !== js.height) {
  console.error(
    `size mismatch: reference ${ref.width}x${ref.height} vs js ${js.width}x${js.height}`,
  );
  process.exit(1);
}

const { width, height } = ref;
const diff = new PNG({ width, height });
const mismatch = pixelmatch(ref.data, js.data, diff.data, width, height, {
  threshold: 0.1,
});
writeFileSync(path.join(artifactDir, 'diff.png'), PNG.sync.write(diff));

const total = width * height;
const pct = (mismatch / total) * 100;
console.log(
  JSON.stringify({
    width,
    height,
    total_pixels: total,
    mismatch_pixels: mismatch,
    mismatch_pct: Number(pct.toFixed(3)),
    match_pct: Number((100 - pct).toFixed(3)),
  }),
);
