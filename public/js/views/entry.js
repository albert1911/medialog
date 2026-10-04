import { Entries, Sources, ValidationError } from '../db.js';
import {
  DEFAULT_TYPES, STATUSES, byText, debounce, esc, fmtDate, fmtDateTime,
  imageToDataUrl, probeAspect, safeHref, safeImg, statusLabel, toast,
} from '../util.js';
import {
  charCounter, coverHTML, coverShape, markInvalid, mountContent, progressPct, renderNotFound,
} from '../components.js';

const statusOptions = (selected) =>
  STATUSES.map((s) => `<option value="${s.value}" ${s.value === selected ? 'selected' : ''}>${s.label}</option>`).join('');

// ---------------------------------------------------------------- show

export async function renderEntryDetail(view, id) {
  let entry = await Entries.get(id);
  if (!entry) return renderNotFound(view, 'Entry not found');

  const source = entry.media_source_id != null ? await Sources.get(entry.media_source_id) : null;
  const sourceUrl = source && safeHref(source.link);

  // Older entries have no stored aspect: measure once (briefly) so the layout is right on first paint.
  const coverSrc = safeImg(entry.cover_image);
  const aspect = entry.cover_aspect ?? (coverSrc ? await probeAspect(coverSrc, 1500) : null);
  const banner = coverSrc && coverShape(aspect) === 'landscape';
  const coverEntry = { ...entry, cover_aspect: aspect };

  view.innerHTML = `
    <div class="crumbs"><a href="#/">Library</a> <span>/</span> <span>${esc(entry.type)}</span></div>
    ${banner ? coverHTML(coverEntry, 'cover-banner') : ''}
    <div class="detail ${banner ? 'has-banner' : ''}">
      <aside class="detail-side">
        ${banner ? '' : coverHTML(coverEntry, 'cover-lg cover-natural')}
        <form class="panel track" id="track" onsubmit="return false">
          <label class="field"><span>Status</span>
            <select id="t-status">${statusOptions(entry.status)}</select>
          </label>
          <label class="field"><span>Progress</span>
            <div class="stepper">
              <button type="button" class="btn btn-icon" data-step="-1" aria-label="Decrease progress">−</button>
              <input type="number" id="t-progress" min="0" ${entry.chapter_count > 0 ? `max="${entry.chapter_count}"` : ''} inputmode="numeric">
              <button type="button" class="btn btn-icon" data-step="1" aria-label="Increase progress">+</button>
            </div>
            <small class="muted">of ${entry.chapter_count > 0 ? entry.chapter_count : 'unknown'}</small>
          </label>
          <div class="bar"><span id="t-bar"></span></div>
          <label class="field"><span>Score (0–10)</span>
            <input type="number" id="t-score" min="0" max="10" step="any" inputmode="decimal" placeholder="—">
          </label>
          <label class="field"><span>Started</span><input type="date" id="t-started"></label>
          <label class="field"><span>Completed</span><input type="date" id="t-completed"></label>
        </form>
      </aside>

      <section class="detail-main">
        <h1 class="detail-title">${esc(entry.title)}</h1>
        <div class="chips">
          <span class="chip">${esc(entry.type)}</span>
          <span class="badge status-${entry.status}" id="status-badge">${statusLabel(entry.status)}</span>
        </div>

        <dl class="facts">
          <div><dt>Release date</dt><dd>${entry.release_date ? fmtDate(entry.release_date) : '—'}</dd></div>
          <div><dt>Chapters / Episodes</dt><dd>${entry.chapter_count > 0 ? entry.chapter_count : 'Unknown / ongoing'}</dd></div>
          <div><dt>Source</dt><dd>${
            source
              ? `<a href="#/sources/${source.id}">${esc(source.title)}</a>${sourceUrl ? ` · <a href="${esc(sourceUrl)}" target="_blank" rel="noopener noreferrer">Open ↗</a>` : ''}`
              : '—'
          }</dd></div>
        </dl>

        ${entry.description ? `<p class="description">${esc(entry.description)}</p>` : ''}

        <div class="row">
          <a class="btn btn-primary" href="#/entries/${entry.id}/edit">Edit</a>
          <button type="button" class="btn btn-danger-ghost" id="delete">Delete</button>
        </div>

        ${entry.content ? '<h2 class="section-title">Content</h2><iframe class="content-frame panel" id="content-frame" title="Entry content"></iframe>' : ''}

        <p class="muted small timestamps">Added ${fmtDateTime(entry.created_at)} · Updated <span id="updated-at">${fmtDateTime(entry.updated_at)}</span></p>
      </section>
    </div>`;

  const $ = (selector) => view.querySelector(selector);

  function fill() {
    $('#t-status').value = entry.status;
    $('#t-progress').value = entry.progress;
    $('#t-score').value = entry.score ?? '';
    $('#t-started').value = entry.started_at ?? '';
    $('#t-completed').value = entry.completed_at ?? '';
    $('#t-bar').style.width = `${progressPct(entry)}%`;
    const badge = $('#status-badge');
    badge.className = `badge status-${entry.status}`;
    badge.textContent = statusLabel(entry.status);
    $('#updated-at').textContent = fmtDateTime(entry.updated_at);
  }

  async function update(changes) {
    const before = entry.status;
    try {
      entry = await Entries.update(entry.id, changes);
      if (entry.status !== before && !('status' in changes)) toast(`Moved to ${statusLabel(entry.status)}`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
    fill();
  }

  $('#t-status').addEventListener('change', (e) => update({ status: e.target.value }));
  $('#t-progress').addEventListener('change', (e) => update({ progress: e.target.value }));
  $('#t-score').addEventListener('change', (e) => update({ score: e.target.value }));
  $('#t-started').addEventListener('change', (e) => update({ started_at: e.target.value }));
  $('#t-completed').addEventListener('change', (e) => update({ completed_at: e.target.value }));
  view.querySelectorAll('[data-step]').forEach((button) =>
    button.addEventListener('click', () => update({ progress: Math.max(0, entry.progress + Number(button.dataset.step)) })),
  );

  $('#delete').addEventListener('click', async () => {
    if (!confirm(`Delete “${entry.title}”? This can't be undone.`)) return;
    await Entries.remove(entry.id);
    toast('Entry deleted');
    location.hash = '#/';
  });

  if (entry.content) mountContent($('#content-frame'), entry.content);
  fill();
}

// ---------------------------------------------------------------- create / edit

export async function renderEntryForm(view, id, query) {
  const editing = id != null;
  const existing = editing ? await Entries.get(id) : null;
  if (editing && !existing) return renderNotFound(view, 'Entry not found');

  const [sources, entries] = await Promise.all([Sources.all(), Entries.all()]);
  const types = [...new Set([...DEFAULT_TYPES, ...entries.map((e) => e.type)])].sort(byText);
  const v = existing ?? {
    status: 'planning',
    progress: 0,
    chapter_count: 1,
    type: query.get('type') ?? '',
    media_source_id: Number(query.get('source')) || null,
  };
  let uploaded = v.cover_image?.startsWith('data:') ? v.cover_image : null;
  let coverAspect = v.cover_aspect ?? null;
  const cancelHref = editing ? `#/entries/${id}` : '#/';

  view.innerHTML = `
    <div class="page-head"><h1>${editing ? 'Edit entry' : 'New entry'}</h1></div>
    <form id="entry-form" class="form" novalidate>
      <div class="form-layout">
        <div class="form-cover">
          <div id="cover-preview"></div>
          <p class="muted small" id="cover-hint"></p>
          <label class="field"><span>Cover image URL</span>
            <input name="cover_url" type="text" inputmode="url" placeholder="https://…" value="${esc(uploaded ? '' : v.cover_image)}">
          </label>
          <div class="row">
            <label class="btn btn-small">Upload image<input type="file" id="cover-file" accept="image/*" hidden></label>
            <button type="button" class="btn btn-small btn-ghost" id="cover-clear">Remove</button>
          </div>
          <p class="muted small">Uploaded images are stored on this device, so they work offline.</p>
        </div>

        <div class="form-fields">
          <label class="field"><span>Title *</span>
            <input name="title" required maxlength="100" value="${esc(v.title)}" autocomplete="off">
          </label>
          <div class="field-row">
            <label class="field"><span>Type *</span>
              <input name="type" required maxlength="50" list="type-list" value="${esc(v.type)}" placeholder="Anime, Movie, Book…" autocomplete="off">
              <datalist id="type-list">${types.map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
            </label>
            <label class="field"><span>Source</span>
              <select name="media_source_id">
                <option value="">— None —</option>
                ${[...sources].sort((a, b) => byText(a.title, b.title)).map((s) => `<option value="${s.id}" ${s.id === v.media_source_id ? 'selected' : ''}>${esc(s.title)} (${esc(s.category)})</option>`).join('')}
              </select>
              <a class="small" href="#/sources/new">+ New source</a>
            </label>
          </div>
          <div class="field-row">
            <label class="field"><span>Release date</span>
              <input name="release_date" type="date" value="${esc(v.release_date)}">
            </label>
            <label class="field"><span>Chapters / Episodes</span>
              <input name="chapter_count" type="number" min="0" step="1" inputmode="numeric" value="${esc(v.chapter_count)}">
              <small class="muted">Use 0 if unknown or ongoing.</small>
            </label>
          </div>
          <label class="field"><span>Description</span>
            <textarea name="description" rows="3" maxlength="255">${esc(v.description)}</textarea>
          </label>

          <fieldset class="panel">
            <legend>Tracking</legend>
            <div class="field-row">
              <label class="field"><span>Status</span><select name="status">${statusOptions(v.status)}</select></label>
              <label class="field"><span>Progress</span>
                <input name="progress" type="number" min="0" step="1" inputmode="numeric" value="${esc(v.progress)}">
              </label>
              <label class="field"><span>Score (0–10)</span>
                <input name="score" type="number" min="0" max="10" step="any" inputmode="decimal" value="${esc(v.score)}">
              </label>
            </div>
            <div class="field-row">
              <label class="field"><span>Started</span><input name="started_at" type="date" value="${esc(v.started_at)}"></label>
              <label class="field"><span>Completed</span><input name="completed_at" type="date" value="${esc(v.completed_at)}"></label>
            </div>
          </fieldset>

          <div class="field">
            <div class="field-head">
              <label for="content">Content (raw HTML)</label>
              <button type="button" class="btn btn-small btn-ghost" id="preview-toggle">Preview</button>
            </div>
            <textarea name="content" id="content" rows="10" class="mono" placeholder="<p>Notes, reviews, links, embeds…</p>">${esc(v.content)}</textarea>
            <iframe class="content-frame panel" id="content-preview" title="Content preview" hidden></iframe>
          </div>
        </div>
      </div>

      <div class="form-actions">
        <a class="btn btn-ghost" href="${cancelHref}">Cancel</a>
        <button type="submit" class="btn btn-primary">${editing ? 'Save changes' : 'Create entry'}</button>
      </div>
    </form>`;

  const form = view.querySelector('#entry-form');
  const urlInput = form.elements.cover_url;
  const preview = view.querySelector('#cover-preview');

  const hint = view.querySelector('#cover-hint');
  const HINTS = {
    portrait: 'Portrait: fills the card.',
    square: 'Square: shown whole on cards over a blurred background.',
    landscape: 'Landscape: shown whole on cards, and as a banner on the entry page.',
  };
  const drawCover = () => {
    const cover_image = uploaded || urlInput.value.trim();
    preview.innerHTML = coverHTML({ title: form.elements.title.value || '?', cover_image, cover_aspect: coverAspect }, 'cover-lg cover-natural');
    hint.textContent = cover_image && coverAspect ? HINTS[coverShape(coverAspect)] : '';
  };
  drawCover();

  let probeSeq = 0;
  urlInput.addEventListener('input', debounce(async () => {
    uploaded = null;
    const seq = ++probeSeq;
    coverAspect = null;
    drawCover();
    const aspect = await probeAspect(safeImg(urlInput.value.trim()));
    if (seq !== probeSeq) return; // a newer URL was typed meanwhile
    coverAspect = aspect;
    drawCover();
  }, 300));
  form.elements.title.addEventListener('input', debounce(drawCover, 300));

  view.querySelector('#cover-file').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      ({ url: uploaded, aspect: coverAspect } = await imageToDataUrl(file));
      probeSeq++;
      urlInput.value = '';
      drawCover();
    } catch {
      toast('Could not read that image.', 'error');
    }
    event.target.value = '';
  });
  view.querySelector('#cover-clear').addEventListener('click', () => {
    uploaded = null;
    coverAspect = null;
    probeSeq++;
    urlInput.value = '';
    drawCover();
  });

  const previewFrame = view.querySelector('#content-preview');
  const previewToggle = view.querySelector('#preview-toggle');
  previewToggle.addEventListener('click', () => {
    previewFrame.hidden = !previewFrame.hidden;
    previewToggle.textContent = previewFrame.hidden ? 'Preview' : 'Hide preview';
    if (!previewFrame.hidden) mountContent(previewFrame, form.elements.content.value);
  });
  form.elements.content.addEventListener('input', debounce(() => {
    if (!previewFrame.hidden) mountContent(previewFrame, form.elements.content.value);
  }, 400));

  charCounter(form.elements.description);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    data.cover_image = uploaded || data.cover_url;
    data.cover_aspect = coverAspect;
    delete data.cover_url;
    try {
      const saved = await Entries.save(data, editing ? id : null);
      toast(editing ? 'Changes saved' : 'Entry created', 'success');
      location.hash = `#/entries/${saved.id}`;
    } catch (err) {
      if (err instanceof ValidationError) markInvalid(form, err.field);
      toast(err.message, 'error');
    }
  });
}
