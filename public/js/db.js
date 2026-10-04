// IndexedDB storage layer. Mirrors the original Laravel tables:
//   media_sources: id, title(100), category(50), description(255)?, link(255)?, timestamps
//   media_entries: id, title(100), type(50), cover_image?, description(500)?, release_date?,
//                  chapter_count (default 0 = unknown / ongoing), content (raw html)?, media_source_id? -> media_sources
//                  (on delete: set null), timestamps
// plus cover_aspect (cover width / height, used to lay out portrait vs landscape covers)
//
// cover_image is either a web URL or a reference to an uploaded image, "cover:<sha256>.<ext>".
// Uploaded images live as binary Blobs in their own "covers" store (like files on a disk),
// keyed by a fingerprint of their content, so identical images are stored once.
// plus tracking columns on media_entries: status, progress, score, started_at, completed_at.
//
// Sync-friendly details:
// - ids are random UUID strings, so records created on different devices never collide;
// - deleting keeps a tombstone { id, created_at, updated_at, deleted_at } so the deletion
//   reaches other devices; tombstones are hidden from every normal query;
// - updated_at decides which copy wins when two devices changed the same record.
//
// Gallery: gallery_images holds one small synced record per image (the image itself is on
// Cloudinary); gallery_cache keeps downloaded/uploaded image files on this device only.
import { STATUS_VALUES, base64ToBytes, bytesToBase64, isISODate, todayISO } from './util.js';

const DB_NAME = 'medialog';
const DB_VERSION = 5;
export const SOURCES = 'media_sources';
export const ENTRIES = 'media_entries';
export const GALLERY = 'gallery_images'; // { id, entry_id, cloud, public_id, version, format, width, height, pending, timestamps }
const COVERS = 'covers'; // uploaded cover images: { id: "<sha256>.<ext>", blob, created_at }
const GALLERY_CACHE = 'gallery_cache'; // { key: "<image id>:thumb|full", image_id, blob } — this device only
const META = 'meta'; // device settings: backup file handle, sync config…
const SYNCED = [SOURCES, ENTRIES, GALLERY];

export const COVER_PREFIX = 'cover:';
const COVER_ID = /^[0-9a-f]{64}\.[a-z0-9]+$/;
export const coverIdOf = (ref) => ref.slice(COVER_PREFIX.length);
export const isCoverRef = (value) =>
  typeof value === 'string' && value.startsWith(COVER_PREFIX) && COVER_ID.test(coverIdOf(value));
const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/svg+xml': 'svg' };
export const mimeOfCover = (id) => Object.entries(MIME_EXT).find(([, ext]) => id.endsWith(`.${ext}`))?.[0] ?? 'application/octet-stream';

// Fires "change" after every committed write to entries/sources.
// event.detail.origin is "sync" when the write came from another device.
export const changes = new EventTarget();

export const newId = () =>
  crypto.randomUUID?.() ??
  '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
    (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16));

const live = (record) => (record && !record.deleted_at ? record : null);
const tombstone = (record, now) => ({ id: record.id, created_at: record.created_at ?? now, updated_at: now, deleted_at: now });

let dbPromise;

function createDataStores(db) {
  if (!db.objectStoreNames.contains(SOURCES)) {
    const sources = db.createObjectStore(SOURCES, { keyPath: 'id' });
    sources.createIndex('category', 'category');
  }
  if (!db.objectStoreNames.contains(ENTRIES)) {
    const entries = db.createObjectStore(ENTRIES, { keyPath: 'id' });
    entries.createIndex('type', 'type');
    entries.createIndex('status', 'status');
    entries.createIndex('media_source_id', 'media_source_id');
  }
  if (!db.objectStoreNames.contains(COVERS)) db.createObjectStore(COVERS, { keyPath: 'id' });
  if (!db.objectStoreNames.contains(GALLERY)) {
    db.createObjectStore(GALLERY, { keyPath: 'id' }).createIndex('entry_id', 'entry_id');
  }
  if (!db.objectStoreNames.contains(GALLERY_CACHE)) {
    db.createObjectStore(GALLERY_CACHE, { keyPath: 'key' }).createIndex('image_id', 'image_id');
  }
}

// v1/v2 used auto-increment numbers; move every record to a UUID and remap source links.
function migrateToUuids(db, tx) {
  const sourcesReq = tx.objectStore(SOURCES).getAll();
  sourcesReq.onsuccess = () => {
    const entriesReq = tx.objectStore(ENTRIES).getAll();
    entriesReq.onsuccess = () => {
      db.deleteObjectStore(SOURCES);
      db.deleteObjectStore(ENTRIES);
      createDataStores(db);
      const idMap = new Map();
      for (const source of sourcesReq.result) {
        const id = newId();
        idMap.set(source.id, id);
        tx.objectStore(SOURCES).put({ ...source, id });
      }
      for (const entry of entriesReq.result) {
        tx.objectStore(ENTRIES).put({ ...entry, id: newId(), media_source_id: idMap.get(entry.media_source_id) ?? null });
      }
    };
  };
}

function openDB() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      if (event.oldVersion >= 1 && event.oldVersion < 3) migrateToUuids(db, req.transaction);
      else createDataStores(db);
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
async function withTx(stores, mode, fn, origin = 'local') {
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
  if (mode === 'readwrite' && stores.some((s) => SYNCED.includes(s))) {
    changes.dispatchEvent(new CustomEvent('change', { detail: { origin } }));
  }
  return result;
}

const getAllLive = (tx, store) => wrap(tx.objectStore(store).getAll()).then((rows) => rows.filter((r) => !r.deleted_at));

export const Meta = {
  get: (key) => withTx([META], 'readonly', (tx) => wrap(tx.objectStore(META).get(key))),
  set: (key, value) => withTx([META], 'readwrite', (tx) => wrap(tx.objectStore(META).put(value, key))),
  remove: (key) => withTx([META], 'readwrite', (tx) => wrap(tx.objectStore(META).delete(key))),
};

// ---------------------------------------------------------------- covers

async function fingerprint(blob) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const Covers = {
  // Stores an uploaded image and returns the reference to put in cover_image.
  async add(blob) {
    const id = `${await fingerprint(blob)}.${MIME_EXT[blob.type] ?? 'img'}`;
    await this.put(id, blob);
    return COVER_PREFIX + id;
  },

  put(id, blob) {
    return withTx([COVERS], 'readwrite', (tx) => wrap(tx.objectStore(COVERS).put({ id, blob, created_at: new Date().toISOString() })));
  },

  async get(id) {
    return (await withTx([COVERS], 'readonly', (tx) => wrap(tx.objectStore(COVERS).get(id)))) ?? null;
  },

  async has(id) {
    return (await withTx([COVERS], 'readonly', (tx) => wrap(tx.objectStore(COVERS).count(id)))) > 0;
  },

  // Deletes images no entry uses anymore (after deleting an entry or changing its cover).
  prune() {
    return withTx([ENTRIES, COVERS], 'readwrite', async (tx) => {
      const used = new Set((await getAllLive(tx, ENTRIES)).filter((e) => isCoverRef(e.cover_image)).map((e) => coverIdOf(e.cover_image)));
      const store = tx.objectStore(COVERS);
      let removed = 0;
      for (const id of await wrap(store.getAllKeys())) {
        if (!used.has(id)) {
          store.delete(id);
          removed++;
        }
      }
      return removed;
    });
  },
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
  const chapter_count = uint(data, 'chapter_count', { label: 'Chapter count', fallback: 0 });
  let progress = uint(data, 'progress', { label: 'Progress', fallback: 0 });
  if (chapter_count > 0) progress = Math.min(progress, chapter_count);

  let score = null;
  if (data.score !== '' && data.score != null) {
    const n = Number(data.score);
    if (!Number.isFinite(n) || n < 0 || n > 10) throw new ValidationError('score', 'Score must be between 0 and 10.');
    score = Math.round(n * 10) / 10;
  }

  const cover_image = text(data, 'cover_image', { label: 'Cover image' });
  const aspect = Number(data.cover_aspect);

  return {
    title: text(data, 'title', { label: 'Title', max: 100, required: true }),
    type: text(data, 'type', { label: 'Type', max: 50, required: true }),
    // A web URL, or "cover:<id>" for an uploaded image (no 255 limit, so long CDN URLs still fit).
    cover_image,
    cover_aspect: cover_image && Number.isFinite(aspect) && aspect > 0 ? Math.round(aspect * 1000) / 1000 : null,
    description: text(data, 'description', { label: 'Description', max: 500 }),
    release_date: date(data, 'release_date', { label: 'Release date' }),
    chapter_count,
    content: text(data, 'content', { label: 'Content' }),
    media_source_id: data.media_source_id ? String(data.media_source_id) : null,
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
    return withTx([SOURCES], 'readonly', (tx) => getAllLive(tx, SOURCES));
  },

  async get(id) {
    if (!id) return null;
    return live(await withTx([SOURCES], 'readonly', (tx) => wrap(tx.objectStore(SOURCES).get(String(id)))));
  },

  async save(data, id = null) {
    const fields = normalizeSource(data);
    return withTx([SOURCES], 'readwrite', async (tx) => {
      const store = tx.objectStore(SOURCES);
      const now = new Date().toISOString();
      let prev = null;
      if (id != null) {
        prev = live(await wrap(store.get(String(id))));
        if (!prev) throw new Error('Source not found.');
      }
      const record = { ...(prev ?? { id: newId() }), ...fields, created_at: prev?.created_at ?? now, updated_at: now };
      await wrap(store.put(record));
      return record;
    });
  },

  // Equivalent of ->onDelete('set null'). Linked entries are unlinked locally without touching
  // their updated_at; on other devices a link to a deleted source simply resolves to "none".
  remove(id) {
    return withTx([SOURCES, ENTRIES], 'readwrite', async (tx) => {
      const sources = tx.objectStore(SOURCES);
      const entries = tx.objectStore(ENTRIES);
      const source = await wrap(sources.get(String(id)));
      if (!live(source)) return 0;
      const linked = await wrap(entries.index('media_source_id').getAll(String(id)));
      for (const entry of linked) entries.put({ ...entry, media_source_id: null });
      sources.put(tombstone(source, new Date().toISOString()));
      return linked.length;
    });
  },
};

// ---------------------------------------------------------------- entries

export const Entries = {
  all() {
    return withTx([ENTRIES], 'readonly', (tx) => getAllLive(tx, ENTRIES));
  },

  async get(id) {
    if (!id) return null;
    return live(await withTx([ENTRIES], 'readonly', (tx) => wrap(tx.objectStore(ENTRIES).get(String(id)))));
  },

  bySource(sourceId) {
    return withTx([ENTRIES], 'readonly', (tx) =>
      wrap(tx.objectStore(ENTRIES).index('media_source_id').getAll(String(sourceId))).then((rows) => rows.filter(live)),
    );
  },

  async save(data, id = null) {
    const fields = normalizeEntry(data);
    return withTx([ENTRIES, SOURCES], 'readwrite', async (tx) => {
      const store = tx.objectStore(ENTRIES);
      const now = new Date().toISOString();
      let prev = null;
      if (id != null) {
        prev = live(await wrap(store.get(String(id))));
        if (!prev) throw new Error('Entry not found.');
      }
      if (fields.media_source_id != null) {
        const source = live(await wrap(tx.objectStore(SOURCES).get(fields.media_source_id)));
        if (!source) fields.media_source_id = null;
      }
      const record = applyTrackingRules(
        { ...(prev ?? { id: newId() }), ...fields },
        prev ?? { status: 'planning', progress: 0 },
        prev != null,
      );
      record.created_at = prev?.created_at ?? now;
      record.updated_at = now;
      await wrap(store.put(record));
      return record;
    });
  },

  // Partial update (used by quick tracking controls).
  async update(id, patch) {
    const current = await this.get(id);
    if (!current) throw new Error('Entry not found.');
    return this.save({ ...current, ...patch }, id);
  },

  // Deleting an entry also deletes its gallery images.
  remove(id) {
    return withTx([ENTRIES, GALLERY], 'readwrite', async (tx) => {
      const store = tx.objectStore(ENTRIES);
      const entry = await wrap(store.get(String(id)));
      if (!live(entry)) return;
      const now = new Date().toISOString();
      store.put(tombstone(entry, now));
      const gallery = tx.objectStore(GALLERY);
      for (const image of await wrap(gallery.index('entry_id').getAll(String(id)))) {
        if (live(image)) gallery.put(tombstone(image, now));
      }
    });
  },
};

// ---------------------------------------------------------------- gallery

const intOrNull = (v) => (Number.isInteger(v) && v > 0 ? v : null);

function normalizeGalleryImage(data) {
  if (typeof data.entry_id !== 'string' || !data.entry_id) throw new Error('Gallery image without an entry.');
  return {
    entry_id: data.entry_id,
    cloud: typeof data.cloud === 'string' && /^[\w-]+$/.test(data.cloud) ? data.cloud : null,
    public_id: typeof data.public_id === 'string' && /^[\w\-/.]+$/.test(data.public_id) ? data.public_id : null,
    version: intOrNull(data.version),
    format: typeof data.format === 'string' && /^[a-z0-9]+$/.test(data.format) ? data.format : null,
    width: intOrNull(data.width),
    height: intOrNull(data.height),
    pending: Boolean(data.pending), // added on a device but not uploaded to Cloudinary yet
    missing: Boolean(data.missing), // a device found it gone from Cloudinary; one with the file re-uploads it
  };
}

const byCreated = (a, b) => a.created_at.localeCompare(b.created_at);

export const Gallery = {
  byEntry(entryId) {
    return withTx([GALLERY], 'readonly', (tx) =>
      wrap(tx.objectStore(GALLERY).index('entry_id').getAll(String(entryId))).then((rows) => rows.filter(live).sort(byCreated)),
    );
  },

  all() {
    return withTx([GALLERY], 'readonly', (tx) => getAllLive(tx, GALLERY));
  },

  async get(id) {
    return live(await withTx([GALLERY], 'readonly', (tx) => wrap(tx.objectStore(GALLERY).get(String(id)))));
  },

  async add(fields) {
    const now = new Date().toISOString();
    const record = { id: newId(), ...normalizeGalleryImage(fields), created_at: now, updated_at: now };
    await withTx([GALLERY], 'readwrite', (tx) => wrap(tx.objectStore(GALLERY).put(record)));
    return record;
  },

  async update(id, patch) {
    return withTx([GALLERY], 'readwrite', async (tx) => {
      const store = tx.objectStore(GALLERY);
      const current = live(await wrap(store.get(String(id))));
      if (!current) return null;
      const record = { ...current, ...normalizeGalleryImage({ ...current, ...patch }), updated_at: new Date().toISOString() };
      await wrap(store.put(record));
      return record;
    });
  },

  remove(id) {
    return withTx([GALLERY, GALLERY_CACHE], 'readwrite', async (tx) => {
      const store = tx.objectStore(GALLERY);
      const image = await wrap(store.get(String(id)));
      if (live(image)) store.put(tombstone(image, new Date().toISOString()));
      const cache = tx.objectStore(GALLERY_CACHE);
      for (const key of await wrap(cache.index('image_id').getAllKeys(String(id)))) cache.delete(key);
    });
  },

  // Live image count per entry id.
  async counts() {
    const map = new Map();
    for (const image of await this.all()) map.set(image.entry_id, (map.get(image.entry_id) ?? 0) + 1);
    return map;
  },
};

// Image files on this device: "thumb" and "full" per gallery image.
export const GalleryCache = {
  async get(imageId, size) {
    const row = await withTx([GALLERY_CACHE], 'readonly', (tx) => wrap(tx.objectStore(GALLERY_CACHE).get(`${imageId}:${size}`)));
    return row?.blob ?? null;
  },

  put(imageId, size, blob) {
    return withTx([GALLERY_CACHE], 'readwrite', (tx) =>
      wrap(tx.objectStore(GALLERY_CACHE).put({ key: `${imageId}:${size}`, image_id: imageId, blob })));
  },

  // Drops cached files of images that were deleted (here or on another device).
  prune() {
    return withTx([GALLERY, GALLERY_CACHE], 'readwrite', async (tx) => {
      const alive = new Set((await getAllLive(tx, GALLERY)).map((g) => g.id));
      const cache = tx.objectStore(GALLERY_CACHE);
      let removed = 0;
      for (const key of await wrap(cache.getAllKeys())) {
        if (!alive.has(key.split(':')[0])) {
          cache.delete(key);
          removed++;
        }
      }
      return removed;
    });
  },
};

// ---------------------------------------------------------------- backup

export function counts() {
  return withTx([SOURCES, ENTRIES], 'readonly', async (tx) => ({
    sources: (await getAllLive(tx, SOURCES)).length,
    entries: (await getAllLive(tx, ENTRIES)).length,
  }));
}

// User-facing backup: live records only, plus the uploaded images they use (as base64,
// so the backup is a single self-contained file).
export async function exportData() {
  const data = await withTx([SOURCES, ENTRIES, GALLERY, COVERS], 'readonly', async (tx) => {
    const entries = await getAllLive(tx, ENTRIES);
    const used = new Set(entries.filter((e) => isCoverRef(e.cover_image)).map((e) => coverIdOf(e.cover_image)));
    return {
      app: 'medialog',
      version: 4,
      exported_at: new Date().toISOString(),
      media_sources: await getAllLive(tx, SOURCES),
      media_entries: entries,
      // Links to gallery images on Cloudinary (the images themselves stay there).
      gallery_images: (await getAllLive(tx, GALLERY)).filter((g) => !g.pending),
      covers: (await wrap(tx.objectStore(COVERS).getAll())).filter((c) => used.has(c.id)),
    };
  });
  data.covers = await Promise.all(
    data.covers.map(async (c) => ({ id: c.id, data: bytesToBase64(new Uint8Array(await c.blob.arrayBuffer())) })),
  );
  return data;
}

// mode "merge":   adds new records; a record that already exists (same id) is replaced only
//                 if the imported copy is newer. Old backups with numeric ids get fresh ids.
// mode "replace": the backup becomes the whole library; everything else is deleted.
export async function importData(data, mode = 'merge') {
  if (!data || !Array.isArray(data.media_sources) || !Array.isArray(data.media_entries)) {
    throw new Error('This is not a valid Medialog backup file.');
  }
  const now = new Date().toISOString();
  const replace = mode === 'replace';
  const idMap = new Map();
  const idFor = (oldId) => {
    if (!idMap.has(oldId)) idMap.set(oldId, typeof oldId === 'string' && oldId ? oldId : newId());
    return idMap.get(oldId);
  };

  const prepare = (rows, normalize, label) =>
    rows.filter((row) => row && !row.deleted_at).map((row, i) => {
      try {
        return {
          ...normalize(row),
          id: idFor(row.id),
          created_at: row.created_at ?? now,
          updated_at: replace ? now : row.updated_at ?? now,
        };
      } catch (err) {
        throw new Error(`${label} #${i + 1} (${row?.title ?? 'untitled'}): ${err.message}`);
      }
    });

  const sources = prepare(data.media_sources, normalizeSource, 'Source');
  const entries = prepare(data.media_entries, normalizeEntry, 'Entry');
  const covers = (Array.isArray(data.covers) ? data.covers : [])
    .filter((c) => c && COVER_ID.test(c.id) && typeof c.data === 'string')
    .map((c) => ({ id: c.id, blob: new Blob([base64ToBytes(c.data)], { type: mimeOfCover(c.id) }), created_at: now }));
  for (const entry of entries) {
    const raw = entry.media_source_id;
    entry.media_source_id = raw == null ? null : idMap.get(raw) ?? idMap.get(Number(raw)) ?? (/^\d+$/.test(raw) ? null : raw);
  }
  const entryIds = new Set(entries.map((e) => e.id));
  const gallery = prepare(Array.isArray(data.gallery_images) ? data.gallery_images : [], normalizeGalleryImage, 'Gallery image')
    .filter((g) => entryIds.has(g.entry_id) && g.public_id && !g.pending);

  return withTx([SOURCES, ENTRIES, GALLERY, COVERS], 'readwrite', async (tx) => {
    for (const cover of covers) tx.objectStore(COVERS).put(cover);
    for (const [storeName, rows] of [[SOURCES, sources], [ENTRIES, entries], [GALLERY, gallery]]) {
      const store = tx.objectStore(storeName);
      const existing = new Map((await wrap(store.getAll())).map((r) => [r.id, r]));
      const incoming = new Set(rows.map((r) => r.id));
      for (const row of rows) {
        const current = existing.get(row.id);
        if (current?.deleted_at) {
          // Restoring something that was deleted: bring it back, stamped as a new change so
          // the restore also wins over the deletion on other devices.
          store.put({ ...row, updated_at: now });
          continue;
        }
        if (!replace && current && current.updated_at >= row.updated_at) continue;
        store.put(row);
      }
      if (replace) {
        for (const current of existing.values()) {
          if (live(current) && !incoming.has(current.id)) store.put(tombstone(current, now));
        }
      }
    }
    return { sources: sources.length, entries: entries.length };
  });
}

// Deletes everything (as tombstones, so the deletion also syncs).
export function clearAll() {
  return withTx([...SYNCED, COVERS, GALLERY_CACHE], 'readwrite', async (tx) => {
    tx.objectStore(COVERS).clear();
    tx.objectStore(GALLERY_CACHE).clear();
    const now = new Date().toISOString();
    for (const name of SYNCED) {
      const store = tx.objectStore(name);
      for (const record of await getAllLive(tx, name)) store.put(tombstone(record, now));
    }
  });
}

// ---------------------------------------------------------------- sync helpers

// Every synced record including tombstones, keyed by store name.
export function snapshot() {
  return withTx(SYNCED, 'readonly', async (tx) => {
    const result = {};
    for (const name of SYNCED) result[name] = await wrap(tx.objectStore(name).getAll());
    return result;
  });
}

// Writes records received from another device, unless this device changed the record
// again in the meantime (a local edit made while the sync was running wins).
export function putSynced(data) {
  return withTx(SYNCED, 'readwrite', async (tx) => {
    for (const name of SYNCED) {
      const rows = data[name] ?? [];
      const store = tx.objectStore(name);
      for (const row of rows) {
        const current = await wrap(store.get(row.id));
        if (!current || current.updated_at <= row.updated_at) store.put(row);
      }
    }
  }, 'sync');
}
