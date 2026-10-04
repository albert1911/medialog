import { initPWA, promptInstall } from './pwa.js';
import { initAutoBackup, resume as resumeBackup } from './autobackup.js';
import { esc, toast } from './util.js';
import { applyCoverShape, renderNotFound, shapeCovers } from './components.js';
import { renderLibrary } from './views/library.js';
import { renderEntryDetail, renderEntryForm } from './views/entry.js';
import { renderSourceDetail, renderSourceForm, renderSourcesList } from './views/sources.js';
import { renderSettings } from './views/settings.js';

// Hash routes: [pattern, render(view, id, query), nav section, page title]
const routes = [
  [/^\/$/, (v) => renderLibrary(v), 'library', 'Library'],
  [/^\/entries\/new$/, (v, _id, q) => renderEntryForm(v, null, q), 'library', 'New entry'],
  [/^\/entries\/(\d+)$/, (v, id) => renderEntryDetail(v, Number(id)), 'library', 'Entry'],
  [/^\/entries\/(\d+)\/edit$/, (v, id, q) => renderEntryForm(v, Number(id), q), 'library', 'Edit entry'],
  [/^\/sources$/, (v) => renderSourcesList(v), 'sources', 'Sources'],
  [/^\/sources\/new$/, (v) => renderSourceForm(v, null), 'sources', 'New source'],
  [/^\/sources\/(\d+)$/, (v, id) => renderSourceDetail(v, Number(id)), 'sources', 'Source'],
  [/^\/sources\/(\d+)\/edit$/, (v, id) => renderSourceForm(v, Number(id)), 'sources', 'Edit source'],
  [/^\/settings$/, (v) => renderSettings(v), 'settings', 'Settings'],
];

const view = document.getElementById('view');
let renderSeq = 0;

async function router() {
  const raw = location.hash.slice(1) || '/';
  const [path, qs = ''] = raw.split('?');
  const query = new URLSearchParams(qs);
  const seq = ++renderSeq;

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

window.addEventListener('hashchange', router);
initPWA();
initAutoBackup().catch((err) => console.error('Auto-backup init failed', err));
router();
