// Browser file save/open helpers. Save uses a Blob download (works everywhere);
// open uses a hidden file input. Kept separate from saveLoad.ts (the format
// logic) so the UI just wires buttons to these.

export function downloadJSON(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.json') ? filename : `${filename}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function readJSONFile(file: File): Promise<unknown> {
  return JSON.parse(await file.text());
}

export function downloadDataURL(filename: string, dataUrl: string): void {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename.endsWith('.png') ? filename : `${filename}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Result of a project save: OSS save_project returns True only when a file was
// actually written (False when the user cancels the Save dialog), and callers
// (tab close / load prompts) rely on that to avoid discarding work.
export interface SaveResult { saved: boolean; filename: string; }

// Save a project JSON, reporting whether it really happened. Where the browser
// offers a real Save dialog (File System Access API: Chrome/Edge), use it — the
// user picks the name, and cancelling is observable. Elsewhere fall back to a
// download, which cannot be cancelled once triggered, so it counts as saved.
export async function saveProjectFile(suggestedName: string, data: unknown): Promise<SaveResult> {
  const name = suggestedName.endsWith('.json') ? suggestedName : `${suggestedName}.json`;
  const picker = (window as unknown as {
    showSaveFilePicker?: (opts: unknown) => Promise<{
      name: string;
      createWritable: () => Promise<{ write: (d: string) => Promise<void>; close: () => Promise<void> }>;
    }>;
  }).showSaveFilePicker;
  if (typeof picker === 'function') {
    try {
      const handle = await picker.call(window, {
        suggestedName: name,
        types: [{ description: 'JSON Files', accept: { 'application/json': ['.json'] } }],
      });
      const w = await handle.createWritable();
      await w.write(JSON.stringify(data, null, 2));
      await w.close();
      return { saved: true, filename: handle.name };
    } catch (err) {
      // AbortError = the user cancelled the dialog. Anything else (a denied
      // permission, a write failure) is also "not saved".
      if (!(err instanceof DOMException && err.name === 'AbortError')) console.error('Save failed:', err);
      return { saved: false, filename: name };
    }
  }
  downloadJSON(name, data);
  return { saved: true, filename: name };
}
