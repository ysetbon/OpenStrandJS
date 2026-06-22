import { useRef } from 'react';
import { useEditorStore } from '../store/editorStore';
import { loadProject, serializeProject } from '../io/saveLoad';
import { downloadJSON } from '../io/fileDialog';
import { fitPan } from '../interaction/viewTransform';
import type { ModeName } from '../model/types';

const FIXTURES = ['single_strand', 'three_strand_braid', 'overhand_knot', 'closed_knot'];
const MODES: ModeName[] = ['select', 'move', 'attach', 'mask'];

export function Toolbar() {
  const fileRef = useRef<HTMLInputElement>(null);
  const mode = useEditorStore((s) => s.mode);
  const setMode = useEditorStore((s) => s.setMode);
  const shadowEnabled = useEditorStore((s) => s.doc.shadow_enabled);
  const mutateDoc = useEditorStore((s) => s.mutateDoc);

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
    try {
      applyDoc(JSON.parse(await file.text()));
    } catch (err) {
      console.error('Failed to load file:', err);
      alert('Could not load that file — see console.');
    }
    e.target.value = '';
  }

  async function loadFixture(name: string) {
    try {
      const res = await fetch(`/fixtures/${name}.json`);
      applyDoc(await res.json());
    } catch (err) {
      console.error('Failed to load fixture:', err);
    }
  }

  function onSave() {
    const doc = useEditorStore.getState().doc;
    downloadJSON('openstrand_project.json', serializeProject(doc));
  }

  return (
    <div className="toolbar">
      <strong>OpenStrandJS</strong>

      <div className="group">
        {MODES.map((m) => (
          <button
            key={m}
            className={mode === m ? 'active' : ''}
            onClick={() => setMode(m)}
          >
            {m}
          </button>
        ))}
      </div>

      <span className="spacer" />

      <label className="group">
        <input
          type="checkbox"
          checked={shadowEnabled}
          onChange={(e) => mutateDoc((d) => { d.shadow_enabled = e.target.checked; })}
        />
        shadows
      </label>

      <div className="group">
        <span style={{ color: '#888' }}>samples:</span>
        {FIXTURES.map((name) => (
          <button key={name} onClick={() => loadFixture(name)}>{name}</button>
        ))}
      </div>

      <button onClick={() => fileRef.current?.click()}>Load…</button>
      <button onClick={onSave}>Save</button>
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        style={{ display: 'none' }}
        onChange={onFile}
      />
    </div>
  );
}
