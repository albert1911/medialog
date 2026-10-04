import { initPWA, promptInstall } from './pwa.js';
import { initAutoBackup, resume as resumeBackup } from './autobackup.js';
import { initSync, status as syncStatus } from './sync.js';
import { initGallery } from './gallery.js';
import { esc, toast } from './util.js';
import { applyCoverShape, renderNotFound, shapeCovers, watchCovers } from './components.js';
import { Covers } from './db.js';
import { renderLibrary } from './views/library.js';
import { renderEntryDetail, renderEntryForm } from './views/entry.js';
import { renderSourceDetail, renderSourceForm, renderSourcesList } from './views/sources.js';
import { renderSettings } from './views/settings.js';

// Hash routes: [pattern, render(view, id, query), nav section, page title]
const routes = [
  [/^\/$/, (v) => renderLibrary(v), 'library', 'Library'],
  [/^\/entries\/new$/, (v, _id, q) => renderEntryForm(v, null, q), 'library', 'New entry'],
  [/^\/entries\/([\w-]+)$/, (v, id) => renderEntryDetail(v, id), 'library', 'Entry'],
  [/^\/entries\/([\w-]+)\/edit$/, (v, id, q) => renderEntryForm(v, id, q), 'library', 'Edit entry'],
  [/^\/sources$/, (v) => renderSourcesList(v), 'sources', 'Sources'],
  [/^\/sources\/new$/, (v) => renderSourceForm(v, null), 'sources', 'New source'],
  [/^\/sources\/([\w-]+)$/, (v, id) => renderSourceDetail(v, id), 'sources', 'Source'],
  [/^\/sources\/([\w-]+)\/edit$/, (v, id) => renderSourceForm(v, id), 'sources', 'Edit source'],
  [/^\/settings$/, (v) => renderSettings(v), 'settings', 'Settings'],
];

const view = document.getElementById('view');
let renderSeq = 0;

// ---- page history for the Back button: pages you viewed, without forms (new / edit)
const HISTORY_KEY = 'medialog.history';
const isForm = (raw) => /\/(new|edit)$/.test(raw.split('?')[0]);
const backButton = document.getElementById('back-btn');
let pages = [];
let goingBackTo = null;
try { pages = JSON.parse(sessionStorage.getItem(HISTORY_KEY) || '[]'); } catch { /* ignore */ }

function trackPage(raw) {
  if (!isForm(raw)) {
    if (goingBackTo === raw) {
      while (pages.length && pages.at(-1) !== raw) pages.pop(); // our Back button
    } else if (pages.at(-2) === raw) {
      pages.pop(); // the browser's back button
    } else if (pages.at(-1) !== raw) {
      pages.push(raw);
    }
    pages = pages.slice(-50);
    try { sessionStorage.setItem(HISTORY_KEY, JSON.stringify(pages)); } catch { /* ignore */ }
  }
  goingBackTo = null;
  backButton.hidden = !backTarget(raw);
}

// From a form, back means the page the form was opened from; otherwise the page before this one.
const backTarget = (raw) => (isForm(raw) ? pages.at(-1) : pages.at(-2));

backButton.addEventListener('click', () => {
  const target = backTarget(location.hash.slice(1) || '/');
  if (!target) return;
  goingBackTo = target;
  location.hash = `#${target}`;
});

// A deleted entry/source: drop its pages so Back never leads to "not found".
document.addEventListener('medialog:forget', (event) => {
  const gone = event.detail;
  pages = pages.filter((raw) => {
    const path = raw.split('?')[0];
    return path !== gone && !path.startsWith(`${gone}/`);
  });
  try { sessionStorage.setItem(HISTORY_KEY, JSON.stringify(pages)); } catch { /* ignore */ }
});

async function router() {
  const raw = location.hash.slice(1) || '/';
  const [path, qs = ''] = raw.split('?');
  const query = new URLSearchParams(qs);
  const seq = ++renderSeq;
  trackPage(raw);

  const match = routes.find(([pattern]) => pattern.test(path));
  const [pattern, render, section, title] = match ?? [null, null, null, 'Not found'];

  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === section));

  // Render off-screen, then swap in, so a slow earlier route can't overwrite a newer one.
  const next = document.createElement('div');
  next.className = 'page';
  try {
    if (render) await render(next, path.match(pattern)[1], query);
    else renderNotFound(next);
  } catch (err) {
    console.error(err);
    next.innerHTML = `<div class="empty-state"><h1>Something went wrong</h1><p class="muted">${esc(err.message)}</p><a class="btn" href="#/">Back to library</a></div>`;
  }
  if (seq !== renderSeq) return;

  view.replaceChildren(next);
  shapeCovers(next); // images that finished loading while the page was off-screen
  document.title = `${title} · Medialog`;
  window.scrollTo(0, 0);
}

// Hide broken cover images so the placeholder initial shows instead.
document.addEventListener('error', (event) => {
  const cover = event.target instanceof HTMLImageElement && event.target.closest('.cover');
  if (!cover) return;
  cover.querySelectorAll('img').forEach((img) => img.remove());
  cover.dataset.shape = '';
}, true);

// Pick the portrait/square/landscape treatment from the real image size.
document.addEventListener('load', (event) => {
  if (event.target instanceof HTMLImageElement && event.target.classList.contains('cover-img')) applyCoverShape(event.target);
}, true);

document.getElementById('install-btn').addEventListener('click', promptInstall);

// One click re-grants file permission when auto-backup is paused; on error, go to Settings.
document.getElementById('backup-btn').addEventListener('click', async (event) => {
  if (!document.body.classList.contains('backup-attention')) return;
  event.preventDefault();
  if (await resumeBackup()) toast('Auto-backup resumed', 'success');
  else location.hash = '#/settings';
});

watchCovers(view);
window.addEventListener('hashchange', router);
// Tidy up images that no entry uses anymore, once the app is idle.
setTimeout(() => Covers.prune().catch((err) => console.warn('Cover cleanup failed', err)), 3000);
initPWA();
initAutoBackup().catch((err) => console.error('Auto-backup init failed', err));
initSync().catch((err) => console.error('Sync init failed', err));
initGallery().catch((err) => console.error('Gallery init failed', err));

// Changes pulled from another device: refresh the page, unless it's a form being filled in.
syncStatus.addEventListener('remote', () => {
  const path = location.hash.split('?')[0];
  if (/\/(new|edit)$/.test(path)) toast('Synced changes from another device');
  else router();
});
router();
