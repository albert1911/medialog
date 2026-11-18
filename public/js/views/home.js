import { Activity, Entries } from '../db.js';
import { bindCards, coverHTML, patchChildren, renderCards } from '../components.js';
import { esc } from '../util.js';
import { describe, newestFirst, visible } from './activity.js';

const LIMIT = 30;

function ago(iso) {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  const days = Math.round(mins / 1440);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// An activity item with the entry's cover; looks different from the plain text rows in Recap / entry pages.
function itemHTML(row, entry) {
  const { icon, html } = describe(row);
  return `<li data-key="${esc(row.id)}"><a class="home-act" href="#/entries/${esc(entry.id)}">
    ${coverHTML(entry, 'home-act-cover')}
    <span class="home-act-body">
      <strong class="home-act-title">${esc(entry.title)}</strong>
      <span class="home-act-what"><span class="act-icon" aria-hidden="true">${icon}</span> ${html}</span>
    </span>
    <time class="muted small" datetime="${esc(row.at)}">${ago(row.at)}</time>
  </a></li>`;
}

export async function renderHome(view) {
  let [entries, rows] = await Promise.all([Entries.all(), Activity.all()]);

  view.innerHTML = `
    <div class="home">
      <section class="home-col" aria-labelledby="home-activity">
        <div class="home-col-head">
          <h2 id="home-activity">Recent activity</h2>
          <button type="button" class="icon-btn" id="home-refresh" aria-label="Refresh recent activity" title="Refresh">&#8635;</button>
        </div>
        <div id="home-acts"></div>
      </section>
      <section class="home-col" aria-labelledby="home-current">
        <h2 id="home-current">In progress</h2>
        <div id="home-cards"></div>
      </section>
    </div>`;

  const acts = view.querySelector('#home-acts');
  const drawActs = () => {
    const byId = new Map(entries.map((e) => [e.id, e]));
    const recent = rows.filter((r) => byId.has(r.entry_id) && visible(r)).sort(newestFirst).slice(0, LIMIT);
    if (!recent.length) {
      acts.innerHTML = '<p class="empty-inline muted">No activity yet. Update progress on an entry and it shows up here.</p>';
      return;
    }
    let list = acts.querySelector('ul.home-acts');
    if (!list) {
      acts.innerHTML = '<ul class="home-acts"></ul>';
      list = acts.firstElementChild;
    }
    patchChildren(list, recent.map((r) => itemHTML(r, byId.get(r.entry_id))).join(''));
  };
  const reload = async () => {
    [entries, rows] = await Promise.all([Entries.all(), Activity.all()]);
    drawActs();
    draw();
  };

  const cards = view.querySelector('#home-cards');
  const draw = () => renderCards(
    cards,
    entries.filter((e) => e.status === 'current').sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    '<p class="empty-inline muted">Nothing in progress. <a href="#/library">Browse your library</a></p>',
  );
  bindCards(cards, reload);
  view.querySelector('#home-refresh').addEventListener('click', reload);
  drawActs();
  draw();
}
