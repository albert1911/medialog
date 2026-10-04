import { Entries } from './db.js';
import { esc, safeImg, statusLabel, toast } from './util.js';

// portrait  (< 0.85): fills 2:3 frames
// square    (0.85–1.3) and landscape (>= 1.3): shown whole over a blurred copy of itself;
// landscape covers also become a banner on the entry page.
export function coverShape(aspect) {
  if (!aspect) return '';
  return aspect >= 1.3 ? 'landscape' : aspect > 0.85 ? 'square' : 'portrait';
}

const clampAspect = (aspect) => Math.min(Math.max(aspect, 0.5), 1.3);
const backdropHTML = (src) => `<img class="cover-backdrop" src="${esc(src)}" alt="" aria-hidden="true" loading="lazy" decoding="async">`;

export function coverHTML(entry, extraClass = '') {
  const src = safeImg(entry.cover_image);
  const initial = (entry.title ?? '?').trim().charAt(0).toUpperCase() || '?';
  const shape = src ? coverShape(entry.cover_aspect) : '';
  const aspectVar = shape ? ` style="--aspect:${clampAspect(entry.cover_aspect)}"` : '';
  return `<div class="cover ${extraClass}" data-initial="${esc(initial)}" data-shape="${shape}"${aspectVar}>
    ${src && shape && shape !== 'portrait' ? backdropHTML(src) : ''}
    ${src ? `<img class="cover-img" src="${esc(src)}" alt="" loading="lazy" decoding="async">` : ''}
  </div>`;
}

// Corrects the shape from the real image once it loads (covers saved without an aspect,
// or a remote image that changed since).
export function applyCoverShape(img) {
  const cover = img.closest('.cover');
  if (!cover || !img.naturalWidth) return;
  const aspect = img.naturalWidth / img.naturalHeight;
  const shape = coverShape(aspect);
  cover.dataset.shape = shape;
  cover.style.setProperty('--aspect', clampAspect(aspect));
  if (shape !== 'portrait' && !cover.querySelector('.cover-backdrop')) {
    cover.insertAdjacentHTML('afterbegin', backdropHTML(img.src));
  }
}

export function shapeCovers(root) {
  root.querySelectorAll('.cover-img').forEach((img) => img.complete && applyCoverShape(img));
}

export const progressText = (e) => `${e.progress} / ${e.chapter_count > 0 ? e.chapter_count : '?'}`;
export const progressPct = (e) => (e.chapter_count > 0 ? Math.min(100, (e.progress / e.chapter_count) * 100) : 0);
export const canIncrement = (e) => e.chapter_count === 0 || e.progress < e.chapter_count;

export function entryCard(e) {
  return `<article class="card" data-id="${e.id}">
    <a class="card-link" href="#/entries/${e.id}" aria-label="${esc(e.title)}"></a>
    ${coverHTML(e)}
    <span class="badge status-${e.status}">${statusLabel(e.status)}</span>
    <div class="card-body">
      <h3 class="card-title" title="${esc(e.title)}">${esc(e.title)}</h3>
      <div class="card-meta">
        <span>${esc(e.type)}</span>
        ${e.score != null ? `<span class="score">★ ${e.score}</span>` : ''}
      </div>
      <div class="card-progress">
        <div class="bar"><span style="width:${progressPct(e)}%"></span></div>
        <span class="muted small">${progressText(e)}</span>
        ${canIncrement(e) ? '<button type="button" class="inc" data-action="inc" title="Add 1 to progress">+1</button>' : ''}
      </div>
    </div>
  </article>`;
}

// Handles the "+1" buttons on entry cards inside `container`.
export function bindCards(container, onChange) {
  container.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action="inc"]');
    if (!button) return;
    event.preventDefault();
    button.disabled = true;
    try {
      const id = Number(button.closest('.card').dataset.id);
      const entry = await Entries.get(id);
      const updated = await Entries.update(id, { progress: entry.progress + 1 });
      if (updated.status === 'completed' && entry.status !== 'completed') {
        toast(`Completed “${updated.title}”`, 'success');
      }
      await onChange?.(updated);
    } catch (err) {
      toast(err.message, 'error');
      button.disabled = false;
    }
  });
}

// Renders user-provided raw HTML in a sandboxed iframe: scripts never run,
// links open in a new tab, and the frame grows to fit its content.
export function mountContent(frame, html) {
  const css = getComputedStyle(document.documentElement);
  const color = css.getPropertyValue('--text').trim();
  const accent = css.getPropertyValue('--accent').trim();
  frame.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>
    :root{color-scheme:light dark}
    html,body{margin:0;background:transparent;color:${color};font:15px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow:hidden;overflow-wrap:anywhere}
    body>:first-child{margin-top:0} body>:last-child{margin-bottom:0}
    a{color:${accent}} img,video{max-width:100%;height:auto} pre{white-space:pre-wrap}
    table{border-collapse:collapse} td,th{border:1px solid #8885;padding:4px 8px}
  </style></head><body>${html}</body></html>`;
  const fit = () => {
    const doc = frame.contentDocument;
    if (doc?.documentElement) frame.style.height = `${doc.documentElement.scrollHeight}px`;
  };
  frame.onload = () => {
    fit();
    try { new ResizeObserver(fit).observe(frame.contentDocument.body); } catch { /* ignore */ }
  };
}

export function renderNotFound(view, message = 'Page not found') {
  view.innerHTML = `<div class="empty-state">
    <h1>${esc(message)}</h1>
    <p class="muted">It may have been deleted.</p>
    <a class="btn btn-primary" href="#/">Back to library</a>
  </div>`;
}

export function markInvalid(form, field) {
  form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
  const input = field && form.elements[field];
  if (input) {
    input.setAttribute('aria-invalid', 'true');
    input.focus();
  }
}

export function charCounter(input) {
  const counter = document.createElement('span');
  counter.className = 'counter muted small';
  const update = () => (counter.textContent = `${input.value.length} / ${input.maxLength}`);
  input.addEventListener('input', update);
  update();
  input.after(counter);
}
