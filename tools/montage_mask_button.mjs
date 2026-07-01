// Compose a before/after montage of the JS mask button (normal|hover|selected)
// into one PNG for a quick glance. Usage: node tools/montage_mask_button.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PNG } from 'pngjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dir = path.join(root, 'artifacts/mask_button');
const load = (p) => PNG.sync.read(readFileSync(p));
const states = ['normal', 'hover', 'selected'];
const rows = [['before', 'BEFORE'], ['after', 'AFTER']];

const imgs = {};
let cw = 0, ch = 0;
for (const [d] of rows) for (const s of states) {
  const im = load(path.join(dir, d, `${s}.png`));
  imgs[`${d}/${s}`] = im; cw = Math.max(cw, im.width); ch = Math.max(ch, im.height);
}
const pad = 16, labelH = 26;
const W = pad + states.length * (cw + pad);
const H = labelH + rows.length * (ch + pad + labelH);
const out = new PNG({ width: W, height: H });
for (let i = 0; i < out.data.length; i += 4) { out.data[i] = out.data[i + 1] = out.data[i + 2] = 24; out.data[i + 3] = 255; }

function blit(im, ox, oy) {
  for (let y = 0; y < im.height; y++) for (let x = 0; x < im.width; x++) {
    const s = (y * im.width + x) * 4, d = ((oy + y) * W + (ox + x)) * 4;
    if (d < 0 || d + 3 >= out.data.length) continue;
    out.data[d] = im.data[s]; out.data[d + 1] = im.data[s + 1];
    out.data[d + 2] = im.data[s + 2]; out.data[d + 3] = 255;
  }
}
let ry = labelH;
for (const [d] of rows) {
  let rx = pad;
  for (const s of states) { blit(imgs[`${d}/${s}`], rx, ry + labelH); rx += cw + pad; }
  ry += ch + pad + labelH;
}
const outPath = path.join(dir, 'before_after_montage.png');
writeFileSync(outPath, PNG.sync.write(out));
console.log('montage:', outPath, `${W}x${H}`);
console.log('rows: top=BEFORE bottom=AFTER; cols: normal | hover | selected');
