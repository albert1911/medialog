// Sync between devices through a file in a private GitHub repo (GitHub Contents API).
//
//   medialog.json        every source/entry, including deletion tombstones
//   covers/<sha256>.<ext> uploaded cover images, one file each (records reference them as
//                         "cover:<sha256>.<ext>", the same id used in the local covers store)
//
// A sync: download the file, keep the newer copy of each record (by updated_at) on both
// sides, then upload the merged file if this device had anything newer. If another device
// pushed in between, GitHub rejects the stale write and we simply merge again.
import { Covers, Meta, changes, coverIdOf, isCoverRef, mimeOfCover, putSynced, snapshot } from './db.js';
import { base64ToBytes, bytesToBase64 } from './util.js';

const CONFIG_KEY = 'sync.config'; // { repo: "owner/name", token }
const LAST_KEY = 'sync.last'; // ISO time of last successful sync
const COVERS_KEY = 'sync.covers'; // cover file names known to exist in the repo
const DATA_FILE = 'medialog.json';
const PUSH_DELAY_MS = 4000;
const PULL_INTERVAL_MS = 5 * 60 * 1000;
const DOWNLOAD_PARALLEL = 4;
const STORES = ['media_sources', 'media_entries'];

export const status = new EventTarget(); // "change" when getStatus() changes, "remote" after pulling changes

let config = null;
let state = 'off'; // off | idle | syncing | error
let last = null;
let error = null;
let timer = null;
let running = null;
let again = false;
let uploadedCovers = new Set();

export const getStatus = () => ({ state, repo: config?.repo ?? null, last, error });

function setState(next, err = null) {
  state = next;
  error = err;
  document.body.classList.toggle('sync-attention', state === 'error');
  status.dispatchEvent(new Event('change'));
}

// ---------------------------------------------------------------- GitHub API

class SyncError extends Error {}

async function api(path, { method = 'GET', body, accept = 'application/vnd.github+json', token = config?.token } = {}) {
  let res;
  try {
    res = await fetch(`https://api.github.com${path}`, {
      method,
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: accept,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body && JSON.stringify(body),
    });
  } catch {
    throw new SyncError(navigator.onLine ? 'Could not reach GitHub.' : "You're offline. Will sync when you're back online.");
  }
  if (res.status === 401) throw new SyncError('GitHub rejected the token (expired or revoked?). Reconnect in Settings → Sync.');
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining === '0' || res.status === 429) throw new SyncError('GitHub rate limit reached. Sync will continue later.');
    throw new SyncError('The token is not allowed to do this. It needs "Contents: Read and write" access to the repository.');
  }
  return res;
}

const contentsPath = (repo, file) => `/repos/${repo}/contents/${file.split('/').map(encodeURIComponent).join('/')}`;

const utf8ToBase64 = (text) => bytesToBase64(new TextEncoder().encode(text));

async function readDataFile() {
  const path = contentsPath(config.repo, DATA_FILE);
  const res = await api(path);
  if (res.status === 404) return { sha: null, data: null };
  if (!res.ok) throw new SyncError(`GitHub error ${res.status} while downloading.`);
  const meta = await res.json();
  let text;
  if (meta.encoding === 'base64' && meta.content) {
    text = new TextDecoder().decode(base64ToBytes(meta.content));
  } else {
    // Files over 1 MB come without inline content; fetch them raw.
    const raw = await api(path, { accept: 'application/vnd.github.raw+json' });
    if (!raw.ok) throw new SyncError(`GitHub error ${raw.status} while downloading.`);
    text = await raw.text();
  }
  try {
    return { sha: meta.sha, data: JSON.parse(text) };
  } catch {
    throw new SyncError(`${DATA_FILE} in the repo is not valid JSON.`);
  }
}

// Returns false when the file changed on GitHub since we read it (another device synced).
async function writeDataFile(data, sha) {
  const device = navigator.userAgentData?.platform || (/Android|iPhone|iPad/.test(navigator.userAgent) ? 'phone' : 'computer');
  const res = await api(contentsPath(config.repo, DATA_FILE), {
    method: 'PUT',
    body: { message: `Sync from ${device}`, content: utf8ToBase64(JSON.stringify(data)), ...(sha ? { sha } : {}) },
  });
  if (res.status === 409 || res.status === 422) return false;
  if (!res.ok) throw new SyncError(`GitHub error ${res.status} while uploading.`);
  return true;
}

// ---------------------------------------------------------------- covers

const coverIdsIn = (entries) =>
  [...new Set(entries.filter((e) => !e.deleted_at && isCoverRef(e.cover_image)).map((e) => coverIdOf(e.cover_image)))];

// Uploads this device's images that the repo doesn't have yet. Runs before the data file is
// pushed, so other devices never see a reference to an image that isn't there.
async function uploadCovers(entries) {
  for (const id of coverIdsIn(entries)) {
    if (uploadedCovers.has(id)) continue;
    const record = await Covers.get(id);
    if (!record) continue; // added on another device, which uploads it
    const res = await api(contentsPath(config.repo, `covers/${id}`), {
      method: 'PUT',
      body: { message: 'Add cover image', content: bytesToBase64(new Uint8Array(await record.blob.arrayBuffer())) },
    });
    // 422 = file already exists (the same image was uploaded from another device).
    if (!res.ok && res.status !== 422) throw new SyncError(`GitHub error ${res.status} while uploading a cover.`);
    uploadedCovers.add(id);
    await Meta.set(COVERS_KEY, [...uploadedCovers]);
    // Uploads create commits; stay well under GitHub's limit on how fast content can be created.
    await new Promise((r) => setTimeout(r, 800));
  }
}

// Downloads images used by entries that this device doesn't have yet, a few at a time.
async function downloadCovers() {
  const { media_entries } = await snapshot();
  const missing = [];
  for (const id of coverIdsIn(media_entries)) if (!(await Covers.has(id))) missing.push(id);

  let downloaded = 0;
  const worker = async () => {
    while (missing.length) {
      const id = missing.shift();
      const res = await api(contentsPath(config.repo, `covers/${id}`), { accept: 'application/vnd.github.raw+json' });
      if (!res.ok) continue; // not uploaded yet; retried next sync
      await Covers.put(id, new Blob([await res.arrayBuffer()], { type: mimeOfCover(id) }));
      uploadedCovers.add(id);
      downloaded++;
    }
  };
  await Promise.all(Array.from({ length: DOWNLOAD_PARALLEL }, worker));
  if (downloaded) await Meta.set(COVERS_KEY, [...uploadedCovers]);
  return downloaded;
}

// ---------------------------------------------------------------- merge

const isRecord = (r) => r && typeof r.id === 'string' && typeof r.updated_at === 'string';
const newer = (a, b) => a.updated_at > b.updated_at;

async function syncOnce() {
  for (let attempt = 0; attempt < 4; attempt++) {
    const remote = await readDataFile();
    const local = await snapshot();
    const pulled = { media_sources: [], media_entries: [] };
    let needPush = !remote.data;

    for (const store of STORES) {
      const localById = new Map(local[store].map((r) => [r.id, r]));
      const remoteRows = (remote.data?.[store] ?? []).filter(isRecord);
      const remoteById = new Map(remoteRows.map((r) => [r.id, r]));
      for (const r of remoteRows) {
        const l = localById.get(r.id);
        if (!l || newer(r, l)) pulled[store].push(r);
      }
      for (const l of local[store]) {
        const r = remoteById.get(l.id);
        if (!r || newer(l, r)) needPush = true;
      }
    }

    const pulledCount = pulled.media_sources.length + pulled.media_entries.length;
    if (pulledCount) await putSynced(pulled);

    if (needPush) {
      const merged = await snapshot();
      await uploadCovers(merged.media_entries);
      const file = { app: 'medialog', kind: 'sync', version: 3, synced_at: new Date().toISOString(), ...merged };
      if (!(await writeDataFile(file, remote.sha))) continue; // someone else pushed first: merge again
    }

    const downloaded = await downloadCovers();
    return { pulled: pulledCount + downloaded };
  }
  throw new SyncError('Another device kept syncing at the same time. Try again in a moment.');
}

// ---------------------------------------------------------------- scheduling

export function syncNow() {
  if (!config) return Promise.resolve(false);
  clearTimeout(timer);
  timer = null;
  if (running) {
    again = true; // changes arrived mid-sync: run once more afterwards
    return running;
  }
  running = (async () => {
    setState('syncing', null);
    try {
      const { pulled } = await syncOnce();
      last = new Date().toISOString();
      await Meta.set(LAST_KEY, last);
      setState('idle');
      if (pulled) status.dispatchEvent(new CustomEvent('remote', { detail: { count: pulled } }));
      return true;
    } catch (err) {
      console.error('Sync failed', err);
      setState('error', err instanceof SyncError ? err.message : `Sync failed: ${err.message}`);
      return false;
    } finally {
      running = null;
      if (again && config) {
        again = false;
        schedule(500);
      }
    }
  })();
  return running;
}

function schedule(delay = PUSH_DELAY_MS) {
  if (!config) return;
  clearTimeout(timer);
  timer = setTimeout(syncNow, delay);
}

export async function initSync() {
  config = (await Meta.get(CONFIG_KEY)) ?? null;
  last = (await Meta.get(LAST_KEY)) ?? null;
  uploadedCovers = new Set((await Meta.get(COVERS_KEY)) ?? []);

  changes.addEventListener('change', (event) => {
    if (event.detail?.origin !== 'sync') schedule();
  });
  document.addEventListener('visibilitychange', () => {
    if (!config) return;
    if (document.visibilityState === 'hidden' && timer) syncNow(); // push pending edits before the app is closed
    if (document.visibilityState === 'visible' && Date.now() - Date.parse(last ?? 0) > 30_000) syncNow();
  });
  window.addEventListener('online', () => config && syncNow());
  setInterval(() => config && document.visibilityState === 'visible' && syncNow(), PULL_INTERVAL_MS);

  if (!config) return setState('off');
  setState('idle');
  syncNow();
}

// Checks the repo and token before saving them.
export async function connect(repoInput, token) {
  const repo = repoInput.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  token = token.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new SyncError('Repository must look like "your-username/medialog-data".');
  if (!token) throw new SyncError('Paste your GitHub token.');

  const res = await api(`/repos/${repo}`, { token });
  if (res.status === 404) throw new SyncError(`Repository "${repo}" not found, or the token doesn't have access to it.`);
  if (!res.ok) throw new SyncError(`GitHub error ${res.status} while checking the repository.`);
  const info = await res.json();
  if (!info.private) throw new SyncError('That repository is public: anyone could read your data. Use a private repository.');

  config = { repo: info.full_name, token };
  uploadedCovers = new Set();
  await Meta.set(CONFIG_KEY, config);
  await Meta.set(COVERS_KEY, []);
  setState('idle');
  return syncNow();
}

export async function disconnect() {
  clearTimeout(timer);
  config = null;
  last = null;
  await Meta.remove(CONFIG_KEY);
  await Meta.remove(LAST_KEY);
  await Meta.remove(COVERS_KEY);
  setState('off');
}
