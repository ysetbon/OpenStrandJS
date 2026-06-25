// Browser file save/open helpers.
//
// Save prefers the File System Access API (showSaveFilePicker) — the closest
// analogue to OSS's QFileDialog: the user picks name + location and the browser
// handles overwrite natively, so repeat exports don't pile up as "export(1).png".
// Falls back to a Blob anchor-download on browsers without it (Firefox/Safari).
// Open is done by callers via a hidden <input type=file>; readJSONFile parses it.

interface SaveOpts {
  description?: string;
  // MIME type -> allowed extensions, e.g. { 'image/png': ['.png'] }.
  accept?: Record<string, string[]>;
}

type FsWritable = { write: (b: Blob) => Promise<void>; close: () => Promise<void> };
type FsHandle = { createWritable: () => Promise<FsWritable> };
type Picker = (o: {
  suggestedName?: string;
  types?: { description?: string; accept: Record<string, string[]> }[];
}) => Promise<FsHandle>;

function isAbort(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { name?: string }).name === 'AbortError';
}

// Core: save a Blob, preferring the native Save As dialog. Returns false ONLY when
// the user cancels the picker; true when written or downloaded. Throws if the
// native write fails AFTER a file was chosen (the caller surfaces the error) — we
// deliberately do NOT fall back to an anchor download there, which would emit a
// second, duplicate file on top of the partially-written one.
export async function saveBlob(suggestedName: string, blob: Blob, opts?: SaveOpts): Promise<boolean> {
  const picker = (window as unknown as { showSaveFilePicker?: Picker }).showSaveFilePicker;
  if (typeof picker === 'function') {
    // Only the picker() call itself falls back to a download (abort => give up;
    // any other error => the API is unavailable/blocked in this context).
    let handle: FsHandle | null = null;
    try {
      handle = await picker({
        suggestedName,
        types: opts?.accept ? [{ description: opts.description ?? '', accept: opts.accept }] : undefined,
      });
    } catch (e) {
      if (isAbort(e)) return false; // user cancelled — do nothing
      handle = null;                // picker blocked/unsupported here — use the fallback
    }
    if (handle) {
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

export function saveText(suggestedName: string, text: string, mime = 'text/plain', opts?: SaveOpts): Promise<boolean> {
  return saveBlob(suggestedName, new Blob([text], { type: mime }), opts);
}

export function saveJSON(suggestedName: string, data: unknown): Promise<boolean> {
  const name = suggestedName.endsWith('.json') ? suggestedName : `${suggestedName}.json`;
  return saveText(name, JSON.stringify(data, null, 2), 'application/json', {
    description: 'JSON', accept: { 'application/json': ['.json'] },
  });
}

export async function savePng(suggestedName: string, dataUrl: string): Promise<boolean> {
  const name = suggestedName.endsWith('.png') ? suggestedName : `${suggestedName}.png`;
  const blob = await (await fetch(dataUrl)).blob();
  return saveBlob(name, blob, { description: 'PNG Image', accept: { 'image/png': ['.png'] } });
}

export async function readJSONFile(file: File): Promise<unknown> {
  return JSON.parse(await file.text());
}
