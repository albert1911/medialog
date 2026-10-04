// Sync between devices through a file in a private GitHub repo (GitHub Contents API).
//
//   medialog.json        every source/entry, including deletion tombstones
//   covers/<sha256>.<ext> uploaded cover images, one file each (records reference them as
//                         "cover:<sha256>.<ext>", the same id used in the local covers store)
//
// A sync: download the file, keep the newer copy of each record (by updated_at) on both
// sides, then upload the merged file if this device had anything newer. If another device
// pushed in between, GitHub rejects the stale write and we simply merge again.
// Images go after the text, so text changes never wait behind a big batch of images.
//
// GitHub limits how fast files can be created (documented: 80 per minute, 500 per hour).
// Image uploads are paced under that, keeping some room free so text syncs always get
// through. If GitHub still says "slow down", we wait exactly as long as it asks.
import { Covers, Meta, changes, coverIdOf, isCoverRef, mimeOfCover, putSynced, snapshot } from './db.js';
import { base64ToBytes, bytesToBase64 } from './util.js';

const CONFIG_KEY = 'sync.config'; // { repo: "owner/name", token }
const LAST_KEY = 'sync.last'; // ISO time of last successful sync
const COVERS_KEY = 'sync.covers'; // cover file names known to exist in the repo
const UPLOAD_LOG_KEY = 'sync.uploads'; // times of recent image uploads (for pacing)
const DATA_FILE = 'medialog.json';
const PUSH_DELAY_MS = 4000;
const PULL_INTERVAL_MS = 5 * 60 * 1000;
const DOWNLOAD_PARALLEL = 4;
const STORES = ['media_sources', 'media_entries', 'gallery_images'];

const HOUR = 60 * 60 * 1000;
const UPLOAD_GAP_MS = 1000; // ≤ 60 images per minute (GitHub allows 80)
const UPLOADS_PER_HOUR = 420; // GitHub allows 500; the rest stays free for text syncs
const BACKOFF_START_MS = 60 * 1000; // when GitHub says "slow down" without saying how long
const BACKOFF_MAX_MS = 30 * 60 * 1000;

export const status = new EventTarget(); // "change" when getStatus() changes, "remote" after pulling changes

let config = null;
let state = 'off'; // off | idle | syncing | waiting (paused for GitHub's limits) | error
let last = null;
let error = null;
let timer = null;
let running = null;
let again = false;
let uploadedCovers = new Set();
let uploadLog = []; // timestamps of image uploads in the last hour
let pendingUploads = 0; // images on this device not yet in the repo
let resumeAt = null; // when the next sync may run, while waiting
let holdUntil = 0; // GitHub asked us to pause everything until then
let backoff = BACKOFF_START_MS;

export const getStatus = () => ({ state, repo: config?.repo ?? null, last, error, pendingUploads, resumeAt });

function setState(next, err = null) {
  state = next;
  error = err;
  document.body.classList.toggle('sync-attention', state === 'error');
  status.dispatchEvent(new Event('change'));
}

// ---------------------------------------------------------------- GitHub API

class SyncError extends Error {}

// GitHub said "slow down": retry no earlier than `retryAt`.
class RateLimitError extends SyncError {
  constructor(retryAt) {
    super('GitHub asked to slow down.');
    this.retryAt = retryAt;
  }
}

async function rateLimitFrom(res) {
  const retryAfter = Number(res.headers.get('retry-after'));
  if (retryAfter > 0) return new RateLimitError(Date.now() + retryAfter * 1000);
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  if (res.headers.get('x-ratelimit-remaining') === '0' && reset) return new RateLimitError(reset * 1000 + 1000);
  const { message = '' } = await res.clone().json().catch(() => ({}));
  if (res.status === 429 || /rate limit/i.test(message)) {
    // No wait time given: GitHub's docs say wait at least a minute, then back off further.
    const retryAt = Date.now() + backoff;
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    return new RateLimitError(retryAt);
  }
  return null;
}

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
    const limited = await rateLimitFrom(res);
    if (limited) throw limited;
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

// How long until another image upload fits in the hourly budget (0 = now).
function uploadBudgetWait() {
  const now = Date.now();
  uploadLog = uploadLog.filter((t) => now - t < HOUR);
  return uploadLog.length < UPLOADS_PER_HOUR ? 0 : uploadLog[0] + HOUR - now + 1000;
}

// Uploads this device's images that the repo doesn't have yet, as many as the budget allows.
// Other devices show a placeholder for an image that isn't there yet and fetch it later.
// Returns how long to wait before continuing (0 = all done).
async function uploadCovers() {
  const { media_entries } = await snapshot();
  const queue = [];
  for (const id of coverIdsIn(media_entries)) {
    if (!uploadedCovers.has(id) && (await Covers.has(id))) queue.push(id); // others' images: they upload them
  }
  pendingUploads = queue.length;
  status.dispatchEvent(new Event('change'));

  for (const id of queue) {
    const wait = uploadBudgetWait();
    if (wait) return wait;
    const record = await Covers.get(id);
    if (!record) continue; // deleted meanwhile
    const res = await api(contentsPath(config.repo, `covers/${id}`), {
      method: 'PUT',
      body: { message: 'Add cover image', content: bytesToBase64(new Uint8Array(await record.blob.arrayBuffer())) },
    });
    // 422 = file already exists (the same image was uploaded from another device).
    if (!res.ok && res.status !== 422) throw new SyncError(`GitHub error ${res.status} while uploading an image.`);
    uploadedCovers.add(id);
    uploadLog.push(Date.now());
    pendingUploads--;
    await Meta.set(COVERS_KEY, [...uploadedCovers]);
    await Meta.set(UPLOAD_LOG_KEY, uploadLog);
    status.dispatchEvent(new Event('change'));
    if (pendingUploads) await new Promise((r) => setTimeout(r, UPLOAD_GAP_MS));
  }
  return 0;
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
      if (!res.ok) continue; // not uploaded yet by the other device; retried next sync
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

// Text: pull, merge, push. Returns how many records came from other devices.
async function syncRecords() {
  for (let attempt = 0; attempt < 4; attempt++) {
    const remote = await readDataFile();
    const local = await snapshot();
    const pulled = Object.fromEntries(STORES.map((s) => [s, []]));
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

    const pulledCount = STORES.reduce((n, s) => n + pulled[s].length, 0);
    if (pulledCount) await putSynced(pulled);

    if (needPush) {
      const merged = await snapshot();
      const file = { app: 'medialog', kind: 'sync', version: 3, synced_at: new Date().toISOString(), ...merged };
      if (!(await writeDataFile(file, remote.sha))) continue; // someone else pushed first: merge again
    }
    return pulledCount;
  }
  throw new SyncError('Another device kept syncing at the same time. Try again in a moment.');
}

// ---------------------------------------------------------------- scheduling

const notifyRemote = (count) => count && status.dispatchEvent(new CustomEvent('remote', { detail: { count } }));

function wait(ms, err = null) {
  resumeAt = Date.now() + ms;
  setState('waiting', err);
  schedule(ms);
}

export function syncNow() {
  if (!config) return Promise.resolve(false);
  if (Date.now() < holdUntil) {
    schedule(holdUntil - Date.now()); // GitHub asked us to pause; the scheduled sync picks this up
    return Promise.resolve(false);
  }
  clearTimeout(timer);
  timer = null;
  if (running) {
    again = true; // changes arrived mid-sync: run once more afterwards
    return running;
  }
  running = (async () => {
    resumeAt = null;
    setState('syncing');
    try {
      notifyRemote(await syncRecords()); // text first: never waits for images
      last = new Date().toISOString();
      await Meta.set(LAST_KEY, last);

      const uploadWait = await uploadCovers();
      notifyRemote(await downloadCovers());
      backoff = BACKOFF_START_MS;
      if (uploadWait) wait(uploadWait); // more images to upload once the hourly budget frees up
      else setState('idle');
      return true;
    } catch (err) {
      if (err instanceof RateLimitError) {
        holdUntil = err.retryAt;
        wait(err.retryAt - Date.now());
        return false;
      }
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
  timer = setTimeout(syncNow, Math.max(delay, Date.now() < holdUntil ? holdUntil - Date.now() : 0));
}

export async function initSync() {
  config = (await Meta.get(CONFIG_KEY)) ?? null;
  last = (await Meta.get(LAST_KEY)) ?? null;
  uploadedCovers = new Set((await Meta.get(COVERS_KEY)) ?? []);
  uploadLog = (await Meta.get(UPLOAD_LOG_KEY)) ?? [];

  changes.addEventListener('change', (event) => {
    if (event.detail?.origin !== 'sync') schedule();
  });
  document.addEventListener('visibilitychange', () => {
    if (!config) return;
    if (document.visibilityState === 'hidden' && timer) syncNow(); // push pending edits before closing
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
  resumeAt = null;
  pendingUploads = 0;
  await Meta.remove(CONFIG_KEY);
  await Meta.remove(LAST_KEY);
  await Meta.remove(COVERS_KEY);
  setState('off');
}
