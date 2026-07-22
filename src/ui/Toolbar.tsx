import { useRef, useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { SettingsDialog } from './SettingsDialog';
import { LayerStateDialog } from './LayerStateDialog';
import { t } from './i18n';
import { ossIcon } from './icons';
import { loadProject, serializeProject } from '../io/saveLoad';
import { downloadJSON } from '../io/fileDialog';
import { exportPng } from '../io/exportPng';
import { fitPan } from '../interaction/viewTransform';
import type { ModeName } from '../model/types';

// The OSS toolbar (main_window.py). A horizontal row of colored mode/toggle/action
// buttons, then a flex spacer, then the State + Settings buttons. Colors, order and
// checkable-ness are an exact transcription of UI_PORT_PLAN.md §2.2.
type ToggleId = 'grid' | 'points' | 'shadow' | 'tabs';
type ActionId = 'save' | 'load' | 'image';
interface Btn {
  key: string;
  label?: string;                 // override when no translation key exists
  c: [string, string, string];    // [normal, hover, pressed]
  mode?: ModeName;                 // exclusive mode button (checked == active mode)
  toggle?: ToggleId;              // checkable toggle bound to a flag
  action?: ActionId;             // one-shot, non-checkable
}

const BTNS: Btn[] = [
  { key: 'view_mode',   c: ['#ccbaba', '#E2C4C4', '#B88A8A'], mode: 'view' },
  { key: 'mask_mode',   c: ['#199693', '#4CCBC8', '#0F625F'], mode: 'mask' },
  { key: 'select_mode', c: ['#F1C40F', '#F9E287', '#BB9A0C'], mode: 'select' },
  { key: 'attach_mode', c: ['#9B59B6', '#D5A6E6', '#703D80'], mode: 'attach' },
  { key: 'move_mode',   c: ['#D35400', '#FFA366', '#A84300'], mode: 'move' },
  { key: 'rotate_mode', c: ['#3498DB', '#92C9F0', '#216B97'], mode: 'rotate' },
  { key: 'toggle_grid', c: ['#E93E3E', '#FF7070', '#ab2e2e'], toggle: 'grid' },
  { key: 'angle_adjust_mode', c: ['#B89EE6', '#D4C2F2', '#9B84C9'], mode: 'angle' },
  { key: 'save',        c: ['#E75480', '#FF9FBB', '#B64064'], action: 'save' },
  { key: 'load',        c: ['#8D6E63', '#BEA499', '#8D6E63'], action: 'load' },
  { key: 'save_image',  c: ['#7D344D', '#B36E89', '#7D344D'], action: 'image' },
  { key: 'toggle_control_points', c: ['#4CAF50', '#81C784', '#388E3C'], toggle: 'points' },
  { key: 'toggle_shadow', c: ['rgba(176,190,197,.7)', 'rgba(196,207,212,.7)', 'rgba(156,173,182,.7)'], toggle: 'shadow' },
  { key: 'tabs', c: ['#a34d92', '#b85baa', '#833a75'], toggle: 'tabs' },
];

const btnVars = (c: [string, string, string]): React.CSSProperties =>
  ({ ['--bg' as string]: c[0], ['--bgh' as string]: c[1], ['--bgp' as string]: c[2] });

export function Toolbar() {
  const fileRef = useRef<HTMLInputElement>(null);
  const mode = useEditorStore((s) => s.mode);
  const setMode = useEditorStore((s) => s.setMode);
  const showGrid = useEditorStore((s) => s.settings.show_grid);
  const showCP = useEditorStore((s) => s.doc.show_control_points);
  const shadowEnabled = useEditorStore((s) => s.doc.shadow_enabled);
  const showTabs = useEditorStore((s) => s.showTabs);
  const toggleTabs = useEditorStore((s) => s.toggleTabs);
  const setSettings = useEditorStore((s) => s.setSettings);
  const mutateDoc = useEditorStore((s) => s.mutateDoc);
  const lang = useEditorStore((s) => s.settings.language);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [stateOpen, setStateOpen] = useState(false);

  function applyDoc(json: unknown) {
    const doc = loadProject(json);
    const st = useEditorStore.getState();
    st.loadDocument(doc);
    const { panX, panY } = fitPan(doc, st.view);
    st.setView({ panX, panY });
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try { applyDoc(JSON.parse(await file.text())); }
    catch (err) { console.error('Failed to load file:', err); alert('Could not load that file — see console.'); }
    e.target.value = '';
  }

  function onSave() {
    downloadJSON('openstrand_project.json', serializeProject(useEditorStore.getState().doc));
  }

  const checked = (b: Btn): boolean => {
    if (b.mode) return mode === b.mode;
    if (b.toggle === 'grid') return showGrid;
    if (b.toggle === 'points') return showCP;
    if (b.toggle === 'shadow') return shadowEnabled;
    if (b.toggle === 'tabs') return showTabs;
    return false;
  };

  const onClick = (b: Btn) => {
    if (b.mode) { setMode(b.mode); return; }
    if (b.toggle === 'grid') { setSettings({ show_grid: !showGrid }); return; }
    if (b.toggle === 'points') { mutateDoc((d) => { d.show_control_points = !d.show_control_points; }); return; }
    if (b.toggle === 'shadow') { mutateDoc((d) => { d.shadow_enabled = !d.shadow_enabled; }); return; }
    if (b.toggle === 'tabs') { toggleTabs(); return; }
    if (b.action === 'save') { onSave(); return; }
    if (b.action === 'load') { fileRef.current?.click(); return; }
    if (b.action === 'image') { exportPng(); return; }
  };

  return (
    <div className="toolbar">
      {BTNS.map((b) => (
        <button
          key={b.key}
          className={`tb-btn${checked(b) ? ' checked' : ''}`}
          style={btnVars(b.c)}
          onClick={() => onClick(b)}
          title={b.label ?? t(b.key, lang)}
        >
          {b.label ?? t(b.key, lang)}
        </button>
      ))}

      <span className="tb-spacer" />

      <button className="tb-state" onClick={() => setStateOpen(true)} title={t('layer_state', lang)}>{t('layer_state', lang)}</button>
      {/* OSS settings button uses settings_icon.png (main_window.py:296+ — the
          ⚙ character is only its missing-file fallback). */}
      <button className="tb-gear" onClick={() => setSettingsOpen(true)} title={t('settings', lang)}>
        <img className="tb-gear-img" src={ossIcon('settings_icon')} alt="" draggable={false} />
      </button>

      {stateOpen && <LayerStateDialog onClose={() => setStateOpen(false)} />}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={onFile} />
    </div>
  );
}
