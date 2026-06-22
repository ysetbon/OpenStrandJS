import type { RGBA } from '../model/types';

// RGBA editor: native <input type=color> for the RGB (gives the OS color picker)
// + an alpha slider, since native color inputs have no alpha channel.
const hex2 = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
const toHex = (c: RGBA) => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
const fromHex = (h: string) => ({
  r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16),
});

export function ColorField(
  { label, value, onChange }: { label: string; value: RGBA; onChange: (c: RGBA) => void },
) {
  return (
    <div className="cf">
      <span className="cf-label">{label}</span>
      <input
        type="color"
        value={toHex(value)}
        onChange={(e) => { const { r, g, b } = fromHex(e.target.value); onChange({ r, g, b, a: value.a }); }}
      />
      <input
        type="range" min={0} max={255} value={value.a}
        title={`alpha ${value.a}`}
        onChange={(e) => onChange({ ...value, a: Number(e.target.value) })}
      />
      <span className="cf-a">{value.a}</span>
    </div>
  );
}
