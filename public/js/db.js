// IndexedDB storage layer. Mirrors the original Laravel tables:
//   media_sources: id, title(100), category(50), description(255)?, link(255)?, timestamps
//   media_entries: id, title(100), type(50), cover_image?, description(255)?, release_date?,
//                  chapter_count (default 1), content (raw html)?, media_source_id? -> media_sources
//                  (on delete: set null), timestamps
// plus cover_aspect (cover width / height, used to lay out portrait vs landscape covers)
// plus tracking columns on media_entries: status, progress, score, started_at, completed_at.
import { STATUS_VALUES, isISODate, todayISO } from './util.js';

const DB_NAME = 'medialog';
const DB_VERSION = 2;
export const SOURCES = 'media_sources';
export const ENTRIES = 'media_entries';
const META = 'meta'; // app settings, e.g. the auto-backup file handle

// Fires "change" after every committed write to entries/sources.
export const changes = new EventTarget();

let dbPromise;

function openDB() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SOURCES)) {
        const sources = db.createObjectStore(SOURCES, { keyPath: 'id', autoIncrement: true });
        sources.createIndex('category', 'category');
      }
      if (!db.objectStoreNames.contains(ENTRIES)) {
        const entries = db.createObjectStore(ENTRIES, { keyPath: 'id', autoIncrement: true });
        entries.createIndex('type', 'type');
        entries.createIndex('status', 'status');
        entries.createIndex('media_source_id', 'media_source_id');
      }
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const wrap = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

// Runs fn inside one transaction; only await IndexedDB requests inside fn,
// otherwise the transaction auto-commits early.
async function withTx(stores, mode, fn) {
  const db = await openDB();
  const tx = db.transaction(stores, mode);
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'));
  });
  done.catch(() => {});
  let result;
  try {
    result = await fn(tx);
  } catch (err) {
    try { tx.abort(); } catch { /* already finished */ }
    throw err;
  }
  await done;
  if (mode === 'readwrite' && stores.some((s) => s !== META)) changes.dispatchEvent(new Event('change'));
  return result;
}

export const Meta = {
  get: (key) => withTx([META], 'readonly', (tx) => wrap(tx.objectStore(META).get(key))),
  set: (key, value) => withTx([META], 'readwrite', (tx) => wrap(tx.objectStore(META).put(value, key))),
  remove: (key) => withTx([META], 'readwrite', (tx) => wrap(tx.objectStore(META).delete(key))),
};

// ---------------------------------------------------------------- validation

export class ValidationError extends Error {
  constructor(field, message) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }
}

function text(data, field, { label, max, required = false }) {
  const value = (data[field] ?? '').toString().trim();
  if (!value) {
    if (required) throw new ValidationError(field, `${label} is required.`);
    return null;
  }
  if (max && value.length > max) throw new ValidationError(field, `${label} must be at most ${max} characters.`);
  return value;
}

function uint(data, field, { label, fallback }) {
  const raw = data[field];
  if (raw === '' || raw == null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new ValidationError(field, `${label} must be a whole number of 0 or more.`);
  return n;
}

function date(data, field, { label }) {
  const value = (data[field] ?? '').toString().trim();
  if (!value) return null;
  if (!isISODate(value)) throw new ValidationError(field, `${label} must be a valid date.`);
  return value;
}

function normalizeSource(data) {
  return {
    title: text(data, 'title', { label: 'Title', max: 100, required: true }),
    category: text(data, 'category', { label: 'Category', max: 50, required: true }),
    description: text(data, 'description', { label: 'Description', max: 255 }),
    link: text(data, 'link', { label: 'Link', max: 255 }),
  };
}

function normalizeEntry(data) {
  const chapter_count = uint(data, 'chapter_count', { label: 'Chapter count', fallback: 1 });
  let progress = uint(data, 'progress', { label: 'Progress', fallback: 0 });
  if (chapter_count > 0) progress = Math.min(progress, chapter_count);

  let score = null;
  if (data.score !== '' && data.score != null) {
    const n = Number(data.score);
    if (!Number.isFinite(n) || n < 0 || n > 10) throw new ValidationError('score', 'Score must be between 0 and 10.');
    score = Math.round(n * 10) / 10;
  }

  const sourceId = data.media_source_id === '' || data.media_source_id == null ? null : Number(data.media_source_id);
  const cover_image = text(data, 'cover_image', { label: 'Cover image' });
  const aspect = Number(data.cover_aspect);

  return {
    title: text(data, 'title', { label: 'Title', max: 100, required: true }),
    type: text(data, 'type', { label: 'Type', max: 50, required: true }),
    // No 255 limit here (unlike the SQL column) because uploaded covers are stored as data URLs.
    cover_image,
    cover_aspect: cover_image && Number.isFinite(aspect) && aspect > 0 ? Math.round(aspect * 1000) / 1000 : null,
    description: text(data, 'description', { label: 'Description', max: 255 }),
    release_date: date(data, 'release_date', { label: 'Release date' }),
    chapter_count,
    content: text(data, 'content', { label: 'Content' }),
    media_source_id: Number.isInteger(sourceId) && sourceId > 0 ? sourceId : null,
    status: STATUS_VALUES.includes(data.status) ? data.status : 'planning',
    progress,
    score,
    started_at: date(data, 'started_at', { label: 'Start date' }),
    completed_at: date(data, 'completed_at', { label: 'Completion date' }),
  };
}

// AniList-style conveniences: finishing the last chapter completes the entry,
// starting a planned entry moves it to "In Progress", and dates fill themselves in.
function applyTrackingRules(next, prev, autoDates) {
  const statusChanged = next.status !== prev.status;
  const progressChanged = next.progress !== prev.progress;

  if (statusChanged && next.status === 'completed' && next.chapter_count > 0) {
    next.progress = next.chapter_count;
  } else if (statusChanged && next.status === 'repeating' && prev.status === 'completed' && !progressChanged) {
    next.progress = 0;
  } else if (progressChanged && next.chapter_count > 0 && next.progress >= next.chapter_count) {
    next.status = 'completed';
  } else if (progressChanged && next.progress > prev.progress && next.status === 'planning') {
    next.status = 'current';
  }

  if (autoDates && next.status !== prev.status) {
    const today = todayISO();
    if (['current', 'repeating', 'completed'].includes(next.status) && !next.started_at) next.started_at = today;
    if (next.status === 'completed' && !next.completed_at) next.completed_at = today;
  }
  return next;
}

// ---------------------------------------------------------------- sources

export const Sources = {
  all() {
    return withTx([SOURCES], 'readonly', (tx) => wrap(tx.objectStore(SOURCES).getAll()));
  },

  async get(id) {
    return (await withTx([SOURCES], 'readonly', (tx) => wrap(tx.objectStore(SOURCES).get(Number(id))))) ?? null;
  },

  async save(data, id = null) {
    const fields = normalizeSource(data);
    return withTx([SOURCES], 'readwrite', async (tx) => {
      const store = tx.objectStore(SOURCES);
      const now = new Date().toISOString();
      let prev = null;
      if (id != null) {
        prev = await wrap(store.get(Number(id)));
        if (!prev) throw new Error('Source not found.');
      }
      const record = { ...(prev ?? {}), ...fields, created_at: prev?.created_at ?? now, updated_at: now };
      const key = await wrap(store.put(record));
      return { ...record, id: key };
    });
  },

  // Equivalent of ->onDelete('set null'): unlink entries, then delete the source.
  remove(id) {
    return withTx([SOURCES, ENTRIES], 'readwrite', async (tx) => {
      const entries = tx.objectStore(ENTRIES);
      const linked = await wrap(entries.index('media_source_id').getAll(Number(id)));
      for (const entry of linked) entries.put({ ...entry, media_source_id: null });
      await wrap(tx.objectStore(SOURCES).delete(Number(id)));
      return linked.length;
    });
  },
};

// ---------------------------------------------------------------- entries

export const Entries = {
  all() {
    return withTx([ENTRIES], 'readonly', (tx) => wrap(tx.objectStore(ENTRIES).getAll()));
  },

  async get(id) {
    return (await withTx([ENTRIES], 'readonly', (tx) => wrap(tx.objectStore(ENTRIES).get(Number(id))))) ?? null;
  },

  bySource(sourceId) {
    return withTx([ENTRIES], 'readonly', (tx) =>
      wrap(tx.objectStore(ENTRIES).index('media_source_id').getAll(Number(sourceId))),
    );
  },

  async save(data, id = null) {
    const fields = normalizeEntry(data);
    return withTx([ENTRIES, SOURCES], 'readwrite', async (tx) => {
      const store = tx.objectStore(ENTRIES);
      const now = new Date().toISOString();
      let prev = null;
      if (id != null) {
        prev = await wrap(store.get(Number(id)));
        if (!prev) throw new Error('Entry not found.');
      }
      if (fields.media_source_id != null) {
        const source = await wrap(tx.objectStore(SOURCES).get(fields.media_source_id));
        if (!source) fields.media_source_id = null;
      }
      const record = applyTrackingRules(
        { ...(prev ?? {}), ...fields },
        prev ?? { status: 'planning', progress: 0 },
        prev != null,
      );
      record.created_at = prev?.created_at ?? now;
      record.updated_at = now;
      const key = await wrap(store.put(record));
      return { ...record, id: key };
    });
  },

  // Partial update (used by quick tracking controls).
  async update(id, patch) {
    const current = await this.get(id);
    if (!current) throw new Error('Entry not found.');
    return this.save({ ...current, ...patch }, id);
  },

  remove(id) {
    return withTx([ENTRIES], 'readwrite', (tx) => wrap(tx.objectStore(ENTRIES).delete(Number(id))));
  },
};

// ---------------------------------------------------------------- backup

export function counts() {
  return withTx([SOURCES, ENTRIES], 'readonly', async (tx) => ({
    sources: await wrap(tx.objectStore(SOURCES).count()),
    entries: await wrap(tx.objectStore(ENTRIES).count()),
  }));
}

export function exportData() {
  return withTx([SOURCES, ENTRIES], 'readonly', async (tx) => ({
    app: 'medialog',
    version: 1,
    exported_at: new Date().toISOString(),
    media_sources: await wrap(tx.objectStore(SOURCES).getAll()),
    media_entries: await wrap(tx.objectStore(ENTRIES).getAll()),
  }));
}

// mode "merge": adds everything as new rows (ids remapped). mode "replace": wipes first, keeps ids.
export async function importData(data, mode = 'merge') {
  if (!data || !Array.isArray(data.media_sources) || !Array.isArray(data.media_entries)) {
    throw new Error('This is not a valid Medialog backup file.');
  }
  const now = new Date().toISOString();
  const stamp = (row, fields) => ({ ...fields, created_at: row.created_at ?? now, updated_at: row.updated_at ?? now });
  const prepare = (rows, normalize, label) =>
    rows.map((row, i) => {
      try {
        return { oldId: row.id, record: stamp(row, normalize(row)) };
      } catch (err) {
        throw new Error(`${label} #${i + 1} (${row?.title ?? 'untitled'}): ${err.message}`);
      }
    });

  const sources = prepare(data.media_sources, normalizeSource, 'Source');
  const entries = prepare(data.media_entries, normalizeEntry, 'Entry');
  const keepIds = mode === 'replace';

  return withTx([SOURCES, ENTRIES], 'readwrite', async (tx) => {
    const sourceStore = tx.objectStore(SOURCES);
    const entryStore = tx.objectStore(ENTRIES);
    if (keepIds) {
      sourceStore.clear();
      entryStore.clear();
    }

    const idMap = new Map();
    for (const { oldId, record } of sources) {
      const newId = keepIds && Number.isInteger(oldId)
        ? await wrap(sourceStore.put({ ...record, id: oldId }))
        : await wrap(sourceStore.add(record));
      idMap.set(oldId, newId);
    }
    for (const { oldId, record } of entries) {
      record.media_source_id = record.media_source_id != null ? idMap.get(record.media_source_id) ?? null : null;
      if (keepIds && Number.isInteger(oldId)) await wrap(entryStore.put({ ...record, id: oldId }));
      else await wrap(entryStore.add(record));
    }
    return { sources: sources.length, entries: entries.length };
  });
}

export function clearAll() {
  return withTx([SOURCES, ENTRIES], 'readwrite', async (tx) => {
    await wrap(tx.objectStore(ENTRIES).clear());
    await wrap(tx.objectStore(SOURCES).clear());
  });
}
