// OSS button icons (copied verbatim from OpenStrandStudio src/layer_panel_icons).
// The desktop app renders every control-column / indicator button from these
// PNGs; using them here (instead of unicode emoji) keeps the buttons looking
// identical on every OS — native emoji fonts (notably macOS) render the glyphs
// completely differently.
export function ossIcon(name: string): string {
  return `${import.meta.env.BASE_URL}layer_panel_icons/${name}.png`;
}
