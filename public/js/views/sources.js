import { Entries, Sources, ValidationError } from '../db.js';
import { byText, debounce, esc, fmtDateTime, safeHref, toast } from '../util.js';
import {
  bindCards, bindChoiceFields, charCounter, choiceFieldHTML, markInvalid, renderCards, renderNotFound,
} from '../components.js';

// ---------------------------------------------------------------- index

export async function renderSourcesList(view) {
  const [sources, entries] = await Promise.all([Sources.all(), Entries.all()]);

  if (!sources.length) {
    view.innerHTML = `<div class="empty-state">
      <h1>No sources yet</h1>
      <p class="muted">A source is the original work an entry's story comes from — like the game a story belongs to.
        It's optional: entries that stand on their own, such as a regular TV show, simply don't have one.</p>
      <a class="btn btn-primary" href="#/sources/new">+ Add a source</a>
    </div>`;
    return;
  }

  const entryCount = new Map();
  for (const e of entries) {
    if (e.media_source_id != null) entryCount.set(e.media_source_id, (entryCount.get(e.media_source_id) ?? 0) + 1);
  }
  const categories = [...new Set(sources.map((s) => s.category))].sort(byText);
  let category = '';
  let query = '';

  view.innerHTML = `
    <div class="page-head">
      <h1>Sources</h1>
      <a class="btn btn-primary" href="#/sources/new">+ New source</a>
    </div>
    <div class="filters">
      <input type="search" id="s-q" placeholder="Search sources…" aria-label="Search">
      <select id="s-category" aria-label="Category">
        <option value="">All categories</option>
        ${categories.map((c) => `<option>${esc(c)}</option>`).join('')}
      </select>
    </div>
    <div class="source-list" id="list"></div>`;

  const list = view.querySelector('#list');

  function draw() {
    const needle = query.trim().toLowerCase();
    const rows = sources
      .filter((s) => (!category || s.category === category) &&
        (!needle || s.title.toLowerCase().includes(needle) || (s.description ?? '').toLowerCase().includes(needle)))
      .sort((a, b) => byText(a.title, b.title));

    list.innerHTML = rows.length
      ? rows.map((s) => {
          const href = safeHref(s.link);
          const n = entryCount.get(s.id) ?? 0;
          return `<article class="source-row panel">
            <div class="source-main">
              <h3><a href="#/sources/${s.id}">${esc(s.title)}</a></h3>
              <div class="chips"><span class="chip">${esc(s.category)}</span><span class="muted small">${n} ${n === 1 ? 'entry' : 'entries'}</span></div>
              ${s.description ? `<p class="muted">${esc(s.description)}</p>` : ''}
            </div>
            <div class="source-actions">
              ${href ? `<a class="btn btn-small btn-ghost" href="${esc(href)}" target="_blank" rel="noopener noreferrer">Visit ↗</a>` : ''}
              <a class="btn btn-small" href="#/sources/${s.id}/edit">Edit</a>
            </div>
          </article>`;
        }).join('')
      : '<p class="empty-inline muted">No sources match.</p>';
  }

  view.querySelector('#s-q').addEventListener('input', debounce((e) => { query = e.target.value; draw(); }, 120));
  view.querySelector('#s-category').addEventListener('change', (e) => { category = e.target.value; draw(); });
  draw();
}

// ---------------------------------------------------------------- show

export async function renderSourceDetail(view, id) {
  const source = await Sources.get(id);
  if (!source) return renderNotFound(view, 'Source not found');

  let entries = await Entries.bySource(source.id);
  const href = safeHref(source.link);

  view.innerHTML = `
    <div class="crumbs"><a href="#/sources">Sources</a> <span>/</span> <span>${esc(source.category)}</span></div>
    <div class="page-head">
      <div>
        <h1>${esc(source.title)}</h1>
        <div class="chips"><span class="chip">${esc(source.category)}</span></div>
      </div>
      <div class="row">
        ${href ? `<a class="btn btn-ghost" href="${esc(href)}" target="_blank" rel="noopener noreferrer">Visit ↗</a>` : ''}
        <a class="btn" href="#/sources/${source.id}/edit">Edit</a>
        <button type="button" class="btn btn-danger-ghost" id="delete">Delete</button>
      </div>
    </div>
    ${source.description ? `<p class="description">${esc(source.description)}</p>` : ''}
    ${source.link && !href ? `<p class="muted small">Link: ${esc(source.link)}</p>` : ''}

    <div class="page-head sub">
      <h2>Entries <span class="muted" id="count"></span></h2>
      <a class="btn btn-small btn-primary" href="#/entries/new?source=${source.id}">+ Add entry from this source</a>
    </div>
    <div class="cards" id="grid"></div>
    <p class="muted small timestamps">Added ${fmtDateTime(source.created_at)} · Updated ${fmtDateTime(source.updated_at)}</p>`;

  const grid = view.querySelector('#grid');
  const draw = () => {
    entries.sort((a, b) => byText(a.title, b.title));
    view.querySelector('#count').textContent = `(${entries.length})`;
    renderCards(grid, entries, '<p class="empty-inline muted">No entries come from this source yet.</p>');
  };
  bindCards(grid, async () => {
    entries = await Entries.bySource(source.id);
    draw();
  });
  draw();

  view.querySelector('#delete').addEventListener('click', async () => {
    const note = entries.length ? `\n\n${entries.length} linked ${entries.length === 1 ? 'entry' : 'entries'} will be kept but unlinked.` : '';
    if (!confirm(`Delete source “${source.title}”?${note}`)) return;
    await Sources.remove(source.id);
    document.dispatchEvent(new CustomEvent('medialog:forget', { detail: `/sources/${source.id}` }));
    toast('Source deleted');
    location.hash = '#/sources';
  });
}

// ---------------------------------------------------------------- create / edit

export async function renderSourceForm(view, id) {
  const editing = id != null;
  const existing = editing ? await Sources.get(id) : null;
  if (editing && !existing) return renderNotFound(view, 'Source not found');

  const sources = await Sources.all();
  const categories = [...new Set(sources.map((s) => s.category))].sort(byText);
  const v = existing ?? {};

  view.innerHTML = `
    <div class="page-head"><h1>${editing ? 'Edit source' : 'New source'}</h1></div>
    <form id="source-form" class="form narrow" novalidate>
      <label class="field"><span>Title *</span>
        <input name="title" required maxlength="100" value="${esc(v.title)}" placeholder="Name of the original work" autocomplete="off">
      </label>
      ${choiceFieldHTML({
        name: 'category', label: 'Category *', value: v.category, options: categories,
        placeholder: 'Choose a category…', newLabel: '＋ New category…', maxlength: 50,
      })}
      <label class="field"><span>Link</span>
        <input name="link" type="text" inputmode="url" maxlength="255" value="${esc(v.link)}" placeholder="Official site, wiki page… (optional)">
      </label>
      <label class="field"><span>Description</span>
        <textarea name="description" rows="3" maxlength="255">${esc(v.description)}</textarea>
      </label>
      <div class="form-actions">
        <a class="btn btn-secondary" href="${editing ? `#/sources/${id}` : '#/sources'}">Cancel</a>
        <button type="submit" class="btn btn-primary">${editing ? 'Save changes' : 'Create source'}</button>
      </div>
    </form>`;

  const form = view.querySelector('#source-form');
  charCounter(form.elements.description);
  bindChoiceFields(form);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const saved = await Sources.save(Object.fromEntries(new FormData(form)), editing ? id : null);
      toast(editing ? 'Changes saved' : 'Source created', 'success');
      location.hash = `#/sources/${saved.id}`;
    } catch (err) {
      if (err instanceof ValidationError) markInvalid(form, err.field);
      toast(err.message, 'error');
    }
  });
}
