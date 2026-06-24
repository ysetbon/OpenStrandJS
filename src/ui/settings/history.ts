// Session-history store for the History settings page. OSS persists per-session
// doc snapshots to temp_states/*.json on disk for crash recovery; the web port
// keeps the equivalent in IndexedDB, keyed by a per-page-load session id. The
// History page lists PAST sessions (excludes the current one), can load a past
// session's latest state, and can clear all non-current sessions. Retention: keep
// the most recent KEEP_SESSIONS, prune sessions older than MAX_AGE_MS on startup.
import type { EditorDocument } from '../../model/types';
import { useEditorStore } from '../../store/editorStore';

const DB_NAME = 'openstrandjs-history';
const STORE = 'snapshots';
const KEEP_SESSIONS = 10;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const PER_SESSION_CAP = 60;

// A fresh id per page load (this run == one "session").
export const SESSION_ID = `s${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

interface Snapshot { id?: number; sessionId: string; step: number; ts: number; doc: EditorDocument; }
export interface SessionInfo { sessionId: string; ts: number; steps: number }

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const os = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          os.createIndex('session', 'sessionId', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

const reqProm = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

async function getAll(db: IDBDatabase): Promise<Snapshot[]> {
  const t = db.transaction(STORE, 'readonly');
  return (await reqProm(t.objectStore(STORE).getAll())) as Snapshot[];
}

let stepCounter = 0;
let lastSerialized = '';

// Append a snapshot of `doc` for the current session (deduped, capped, debounced
// by the caller). Empty documents are skipped so a session only appears once it
// has content.
export async function recordSnapshot(doc: EditorDocument): Promise<void> {
  if (!doc || doc.order.length === 0) return;
  const serialized = JSON.stringify(doc);
  if (serialized === lastSerialized) return;
  lastSerialized = serialized;
  const db = await openDb();
  if (!db) return;
  try {
    const t = db.transaction(STORE, 'readwrite');
    const store = t.objectStore(STORE);
    stepCounter += 1;
    store.add({ sessionId: SESSION_ID, step: stepCounter, ts: Date.now(), doc: JSON.parse(serialized) } as Snapshot);
    // Enforce per-session cap: drop the oldest steps beyond PER_SESSION_CAP.
    const mine = ((await reqProm(store.index('session').getAll(SESSION_ID))) as Snapshot[])
      .sort((a, b) => a.step - b.step);
    for (let i = 0; i < mine.length - PER_SESSION_CAP; i++) if (mine[i].id != null) store.delete(mine[i].id!);
    await new Promise<void>((res) => { t.oncomplete = () => res(); t.onerror = () => res(); });
  } catch { /* ignore */ } finally { db.close(); }
}

// Past sessions (newest first), excluding the current one.
export async function listSessions(): Promise<SessionInfo[]> {
  const db = await openDb();
  if (!db) return [];
  try {
    const all = await getAll(db);
    const by = new Map<string, SessionInfo>();
    for (const s of all) {
      if (s.sessionId === SESSION_ID) continue;
      const cur = by.get(s.sessionId);
      if (!cur) by.set(s.sessionId, { sessionId: s.sessionId, ts: s.ts, steps: 1 });
      else { cur.steps += 1; if (s.ts > cur.ts) cur.ts = s.ts; }
    }
    return [...by.values()].sort((a, b) => b.ts - a.ts);
  } catch { return []; } finally { db.close(); }
}

// The latest (highest-step) doc for a session.
export async function getSessionLatestDoc(sessionId: string): Promise<EditorDocument | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    const rows = ((await reqProm(db.transaction(STORE, 'readonly').objectStore(STORE).index('session').getAll(sessionId))) as Snapshot[]);
    if (rows.length === 0) return null;
    rows.sort((a, b) => b.step - a.step);
    return rows[0].doc;
  } catch { return null; } finally { db.close(); }
}

// Delete every snapshot that is not part of the current session.
export async function clearOtherSessions(): Promise<number> {
  const db = await openDb();
  if (!db) return 0;
  try {
    const t = db.transaction(STORE, 'readwrite');
    const store = t.objectStore(STORE);
    const all = (await reqProm(store.getAll())) as Snapshot[];
    let n = 0;
    const sessions = new Set<string>();
    for (const s of all) {
      if (s.sessionId !== SESSION_ID && s.id != null) { store.delete(s.id); sessions.add(s.sessionId); n += 1; }
    }
    await new Promise<void>((res) => { t.oncomplete = () => res(); t.onerror = () => res(); });
    return sessions.size ? n : 0;
  } catch { return 0; } finally { db.close(); }
}

// Retention sweep: drop sessions older than MAX_AGE_MS and keep only the most
// recent KEEP_SESSIONS (never touches the current session).
async function prune(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const all = await getAll(db);
    const info = new Map<string, number>(); // sessionId -> latest ts
    for (const s of all) {
      if (s.sessionId === SESSION_ID) continue;
      info.set(s.sessionId, Math.max(info.get(s.sessionId) ?? 0, s.ts));
    }
    const now = Date.now();
    const sorted = [...info.entries()].sort((a, b) => b[1] - a[1]);
    const drop = new Set<string>();
    sorted.forEach(([id, ts], i) => { if (i >= KEEP_SESSIONS || now - ts > MAX_AGE_MS) drop.add(id); });
    if (drop.size === 0) return;
    const t = db.transaction(STORE, 'readwrite');
    const store = t.objectStore(STORE);
    for (const s of all) if (drop.has(s.sessionId) && s.id != null) store.delete(s.id);
    await new Promise<void>((res) => { t.oncomplete = () => res(); t.onerror = () => res(); });
  } catch { /* ignore */ } finally { db.close(); }
}

let started = false;

// Mount-once background recorder: prunes old sessions, then snapshots the live doc
// (debounced) whenever it changes. Wired from App so it runs for the whole session.
export function startHistoryRecorder(): () => void {
  if (started) return () => {};
  started = true;
  void prune();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastRev = -1;
  const schedule = () => {
    const st = useEditorStore.getState();
    if (st.docRevision === lastRev) return;
    lastRev = st.docRevision;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void recordSnapshot(useEditorStore.getState().doc); }, 2000);
  };
  const unsub = useEditorStore.subscribe(schedule);
  return () => { if (timer) clearTimeout(timer); unsub(); started = false; };
}
