import { Entries, Sources } from '../db.js';
import { STATUSES, byText, debounce, esc } from '../util.js';
import { bindCards, renderCards } from '../components.js';

const PREFS_KEY = 'medialog.library';
const DEFAULTS = { status: 'all', type: '', source: '', sort: 'updated' };

const SORTS = {
  updated: ['Recently updated', (a, b) => b.updated_at.localeCompare(a.updated_at)],
  created: ['Recently added', (a, b) => b.created_at.localeCompare(a.created_at)],
  title: ['Title', (a, b) => byText(a.title, b.title)],
  release: ['Release date', (a, b) => (b.release_date ?? '').localeCompare(a.release_date ?? '')],
  score: ['Score', (a, b) => (b.score ?? -1) - (a.score ?? -1)],
};

function loadPrefs() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

function savePrefs(prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
}

export async function renderLibrary(view) {
  let [entries, sources] = await Promise.all([Entries.all(), Sources.all()]);

  if (!entries.length) {
    view.innerHTML = `<div class="empty-state">
      <h1>Your library is empty</h1>
      <p class="muted">Add an anime, show, movie, book, game… anything you want to keep track of.</p>
      <div class="row center">
        <a class="btn btn-primary" href="#/entries/new">+ Add your first entry</a>
      </div>
    </div>`;
    return;
  }

  const prefs = loadPrefs();
  const types = [...new Set(entries.map((e) => e.type))].sort(byText);
  const sortedSources = [...sources].sort((a, b) => byText(a.title, b.title));
  if (!types.includes(prefs.type)) prefs.type = '';
  if (!sources.some((s) => String(s.id) === prefs.source)) prefs.source = '';
  if (!SORTS[prefs.sort]) prefs.sort = 'updated';
  let query = '';

  view.innerHTML = `
    <div class="page-head">
      <h1>Library</h1>
      <span class="muted">${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}</span>
    </div>
    <div class="tabs" id="tabs" role="toolbar" aria-label="Filter by status"></div>
    <div class="filters">
      <input type="search" id="f-q" placeholder="Search titles…" aria-label="Search">
      <select id="f-type" aria-label="Type">
        <option value="">All types</option>
        ${types.map((t) => `<option ${t === prefs.type ? 'selected' : ''}>${esc(t)}</option>`).join('')}
      </select>
      <select id="f-source" aria-label="Source">
        <option value="">All sources</option>
        ${sortedSources.map((s) => `<option value="${s.id}" ${String(s.id) === prefs.source ? 'selected' : ''}>${esc(s.title)}</option>`).join('')}
      </select>
      <select id="f-sort" aria-label="Sort">
        ${Object.entries(SORTS).map(([k, [label]]) => `<option value="${k}" ${k === prefs.sort ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
    </div>
    <div class="cards" id="grid"></div>`;

  const tabs = view.querySelector('#tabs');
  const grid = view.querySelector('#grid');

  function draw() {
    const needle = query.trim().toLowerCase();
    const base = entries.filter(
      (e) =>
        (!prefs.type || e.type === prefs.type) &&
        (!prefs.source || String(e.media_source_id) === prefs.source) &&
        (!needle || e.title.toLowerCase().includes(needle) || (e.description ?? '').toLowerCase().includes(needle)),
    );

    const count = { all: base.length };
    for (const e of base) count[e.status] = (count[e.status] ?? 0) + 1;
    tabs.innerHTML = [{ value: 'all', label: 'All' }, ...STATUSES]
      .map(
        (s) => `<button type="button" class="tab ${prefs.status === s.value ? 'active' : ''}" data-status="${s.value}" aria-pressed="${prefs.status === s.value}">
          ${s.label}<span class="count">${count[s.value] ?? 0}</span></button>`,
      )
      .join('');

    const list = base.filter((e) => prefs.status === 'all' || e.status === prefs.status).sort(SORTS[prefs.sort][1]);
    renderCards(grid, list, '<p class="empty-inline muted">Nothing matches these filters.</p>');
  }

  tabs.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-status]');
    if (!tab) return;
    prefs.status = tab.dataset.status;
    savePrefs(prefs);
    draw();
  });

  view.querySelector('#f-q').addEventListener('input', debounce((event) => {
    query = event.target.value;
    draw();
  }, 120));

  for (const [selector, key] of [['#f-type', 'type'], ['#f-source', 'source'], ['#f-sort', 'sort']]) {
    view.querySelector(selector).addEventListener('change', (event) => {
      prefs[key] = event.target.value;
      savePrefs(prefs);
      draw();
    });
  }

  bindCards(grid, async () => {
    entries = await Entries.all();
    draw();
  });

  draw();
}
