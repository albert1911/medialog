// Auto-backup: after any change, rewrite a user-chosen JSON file on disk.
// Uses the File System Access API (Chrome/Edge desktop). Writes are debounced and
// serialized, and the file is replaced atomically, so it's always a complete backup.
import { Meta, changes, exportData } from './db.js';

const HANDLE_KEY = 'backup.handle';
const LAST_KEY = 'backup.last';
const DELAY_MS = 2000;

export const supported = typeof window.showSaveFilePicker === 'function';
export const status = new EventTarget(); // fires "change" whenever getStatus() would differ

let handle = null;
let state = 'off'; // off | active | paused (needs permission) | error
let last = null; // { at, bytes }
let error = null;
let timer = null;
let queue = Promise.resolve();

export const getStatus = () => ({ supported, state, fileName: handle?.name ?? null, last, error });

function setState(next) {
  state = next;
  document.body.classList.toggle('backup-attention', state === 'paused' || state === 'error');
  status.dispatchEvent(new Event('change'));
}

async function hasPermission(request = false) {
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return request && (await handle.requestPermission(opts)) === 'granted';
}

// `force` = explicit user request. Automatic writes never replace a backup with an empty
// database, so "Delete all data" (or a mistake) can still be recovered from the file.
async function write(force) {
  if (!handle) return false;
  if (!(await hasPermission())) {
    setState('paused');
    return false;
  }
  try {
    const data = await exportData();
    if (!force && !data.media_entries.length && !data.media_sources.length) {
      setState('active');
      return true;
    }
    const json = JSON.stringify(data);
    const writable = await handle.createWritable();
    await writable.write(json);
    await writable.close();
    last = { at: new Date().toISOString(), bytes: new Blob([json]).size };
    error = null;
    await Meta.set(LAST_KEY, last);
    setState('active');
    return true;
  } catch (err) {
    console.error('Auto-backup failed', err);
    error = err.message;
    setState('error');
    return false;
  }
}

export function backupNow(force = false) {
  clearTimeout(timer);
  timer = null;
  const run = () => write(force);
  queue = queue.then(run, run);
  return queue;
}

function schedule() {
  if (!handle) return;
  clearTimeout(timer);
  timer = setTimeout(() => backupNow(), DELAY_MS);
}

export async function initAutoBackup() {
  if (!supported) return;
  changes.addEventListener('change', schedule);
  // Don't lose the last couple of seconds of edits when the app is closed or backgrounded.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && timer) backupNow();
  });

  handle = (await Meta.get(HANDLE_KEY)) ?? null;
  last = (await Meta.get(LAST_KEY)) ?? null;
  if (!handle) return setState('off');
  // Browsers usually forget file permission between sessions; the user re-grants with one click.
  setState((await hasPermission()) ? 'active' : 'paused');
}

export async function chooseFile() {
  let picked;
  try {
    picked = await window.showSaveFilePicker({
      suggestedName: 'medialog-backup.json',
      types: [{ description: 'Medialog backup', accept: { 'application/json': ['.json'] } }],
    });
  } catch (err) {
    if (err.name === 'AbortError') return false; // user cancelled
    throw err;
  }
  handle = picked;
  await Meta.set(HANDLE_KEY, handle);
  return backupNow();
}

// Must be called from a click (permission prompts need a user gesture).
export async function resume() {
  if (!handle) return false;
  if (!(await hasPermission(true))) {
    setState('paused');
    return false;
  }
  return backupNow();
}

export async function turnOff() {
  clearTimeout(timer);
  handle = null;
  last = null;
  error = null;
  await Meta.remove(HANDLE_KEY);
  await Meta.remove(LAST_KEY);
  setState('off');
}
