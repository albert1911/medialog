import { Entries, Sources } from '../db.js';
import { STATUSES, byText, debounce, esc, sameTag, tagList, tagsOf } from '../util.js';
import { bindCards, renderCards, searchSelect } from '../components.js';

const PREFS_KEY = 'medialog.library';
const DEFAULTS = { status: 'all', type: '', source: '', tag: '', sort: 'updated' };

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

// Opens the library on every entry with this tag (used by the tag links on an entry's page).
export function showTagInLibrary(tag) {
  savePrefs({ ...loadPrefs(), status: 'all', type: '', source: '', tag });
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
  const tags = tagList(entries);
  if (!types.includes(prefs.type)) prefs.type = '';
  prefs.tag = tags.find((t) => sameTag(t, prefs.tag)) ?? '';
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
      <input type="search" id="f-q" placeholder="Search titles and tags…" aria-label="Search">
      <select id="f-type" aria-label="Type">
        <option value="">All types</option>
        ${types.map((t) => `<option ${t === prefs.type ? 'selected' : ''}>${esc(t)}</option>`).join('')}
      </select>
      ${tags.length ? '<span id="f-tag-slot"></span>' : ''}
      <span id="f-source-slot"></span>
      <select id="f-sort" aria-label="Sort">
        ${Object.entries(SORTS).map(([k, [label]]) => `<option value="${k}" ${k === prefs.sort ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
    </div>
    <div class="cards" id="grid"></div>`;

  const mountCombo = (slot, key, label, allLabel, items) =>
    view.querySelector(slot)?.replaceWith(searchSelect({
      id: `f-${key}`, label, value: prefs[key],
      options: [{ value: '', label: allLabel }, ...items],
      onChange: (v) => { prefs[key] = v; savePrefs(prefs); draw(); },
    }));
  mountCombo('#f-tag-slot', 'tag', 'Tag', 'All tags', tags.map((t) => ({ value: t, label: t })));
  mountCombo('#f-source-slot', 'source', 'Source', 'All sources', sortedSources.map((s) => ({ value: String(s.id), label: s.title })));

  const tabs = view.querySelector('#tabs');
  const grid = view.querySelector('#grid');

  function draw() {
    const needle = query.trim().toLowerCase();
    const base = entries.filter(
      (e) =>
        (!prefs.type || e.type === prefs.type) &&
        (!prefs.source || String(e.media_source_id) === prefs.source) &&
        (!prefs.tag || tagsOf(e).some((t) => sameTag(t, prefs.tag))) &&
        (!needle || e.title.toLowerCase().includes(needle) || (e.description ?? '').toLowerCase().includes(needle) ||
          tagsOf(e).some((t) => t.toLowerCase().includes(needle))),
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

  for (const [selector, key] of [['#f-type', 'type'], ['#f-sort', 'sort']]) {
    view.querySelector(selector)?.addEventListener('change', (event) => {
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
