export const STATUSES = [
  { value: 'current', label: 'In Progress' },
  { value: 'planning', label: 'Planning' },
  { value: 'completed', label: 'Completed' },
  { value: 'repeating', label: 'Revisiting' },
  { value: 'paused', label: 'Paused' },
  { value: 'dropped', label: 'Dropped' },
];
export const STATUS_VALUES = STATUSES.map((s) => s.value);
export const statusLabel = (value) => STATUSES.find((s) => s.value === value)?.label ?? value;

// Suggestions only; "type" and "category" are free text like the original string columns.
export const DEFAULT_TYPES = [
  'Anime', 'Manga', 'TV Show', 'Movie', 'Book', 'Light Novel', 'Web Novel',
  'Webtoon', 'Comic', 'Game', 'Podcast', 'YouTube Series',
];
export const DEFAULT_CATEGORIES = ['Streaming', 'Website', 'App', 'Publisher', 'Store', 'Library', 'Physical'];

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

export const byText = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });

export function todayISO() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

export function isISODate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

export function fmtDate(value) {
  if (!value) return '';
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function fmtDateTime(value) {
  if (!value) return '';
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// Only http(s) links are rendered as clickable hrefs.
export function safeHref(value) {
  if (!value) return null;
  try {
    const url = new URL(value, location.href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

// Covers may be a URL, a relative path, or an uploaded image stored as a data URL.
export function safeImg(value) {
  if (!value) return null;
  if (/^data:image\//i.test(value)) return value;
  try {
    const url = new URL(value, location.href);
    return ['http:', 'https:', 'blob:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function toast(message, kind = 'info', ms = 3000) {
  const host = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = message;
  host.append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

export function downloadFile(filename, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Downscale uploads so covers stay small inside IndexedDB. Landscape images get more
// pixels because they're shown as a wide banner. Returns { url, aspect } (aspect = w / h).
export async function imageToDataUrl(file) {
  const bitmap = await createImageBitmap(file);
  const aspect = bitmap.width / bitmap.height;
  const maxSide = aspect >= 1.3 ? 1280 : 600;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return { url: canvas.toDataURL('image/jpeg', 0.85), aspect };
}

// Loads an image just to read its proportions; resolves null on error or timeout.
export function probeAspect(src, timeoutMs = 4000) {
  return new Promise((resolve) => {
    if (!src) return resolve(null);
    const img = new Image();
    const timer = setTimeout(() => resolve(null), timeoutMs);
    img.onload = () => {
      clearTimeout(timer);
      resolve(img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : null);
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
    img.src = src;
  });
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(i ? 1 : 0)} ${units[i]}`;
}
