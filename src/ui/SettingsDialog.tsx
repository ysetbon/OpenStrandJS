import { useEditorStore } from '../store/editorStore';
import { t } from './i18n';
import type { Language, Theme } from '../model/types';

// Settings modal: theme, language (RTL for Hebrew), grid + snap, curve params.
// Every change goes through setSettings, which persists to localStorage.
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const settings = useEditorStore((s) => s.settings);
  const setSettings = useEditorStore((s) => s.setSettings);
  const lang = settings.language;
  const cp = settings.curve_params;
  const setCurve = (patch: Partial<typeof cp>) => setSettings({ curve_params: { ...cp, ...patch } });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{t('settings', lang)}</h2>

        <label className="mrow"><span>{t('theme', lang)}</span>
          <select value={settings.theme} onChange={(e) => setSettings({ theme: e.target.value as Theme })}>
            <option value="default">Default</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>

        <label className="mrow"><span>{t('language', lang)}</span>
          <select value={lang} onChange={(e) => setSettings({ language: e.target.value as Language })}>
            <option value="en">English</option>
            <option value="fr">Français</option>
            <option value="it">Italiano</option>
            <option value="es">Español</option>
            <option value="pt">Português</option>
            <option value="he">עברית</option>
          </select>
        </label>

        <label className="mrow"><span>{t('showGrid', lang)}</span>
          <input type="checkbox" checked={settings.show_grid} onChange={(e) => setSettings({ show_grid: e.target.checked })} />
        </label>
        <label className="mrow"><span>{t('gridSize', lang)}</span>
          <input type="number" min={4} value={settings.grid_size} onChange={(e) => setSettings({ grid_size: Math.max(4, Number(e.target.value)) })} />
        </label>
        <label className="mrow"><span>{t('snap', lang)}</span>
          <input type="checkbox" checked={settings.snap_to_grid_enabled} onChange={(e) => setSettings({ snap_to_grid_enabled: e.target.checked })} />
        </label>

        <fieldset className="mcurve">
          <legend>{t('curve', lang)}</legend>
          <label className="mrow"><span>base_fraction</span>
            <input type="number" step={0.1} value={cp.base_fraction} onChange={(e) => setCurve({ base_fraction: Number(e.target.value) })} /></label>
          <label className="mrow"><span>dist_multiplier</span>
            <input type="number" step={0.1} value={cp.dist_multiplier} onChange={(e) => setCurve({ dist_multiplier: Number(e.target.value) })} /></label>
          <label className="mrow"><span>exponent</span>
            <input type="number" step={0.1} value={cp.exponent} onChange={(e) => setCurve({ exponent: Number(e.target.value) })} /></label>
        </fieldset>

        <button onClick={onClose}>{t('close', lang)}</button>
      </div>
    </div>
  );
}
