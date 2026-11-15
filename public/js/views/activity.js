import { Activity, Entries } from '../db.js';
import { coverHTML } from '../components.js';
import { esc, fmtDate, statusLabel } from '../util.js';

// ---------------------------------------------------------------- shared helpers

export const dayKey = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const fmtDay = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
export const fmtTime = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

// Rows from one save share a time; this keeps score above status above progress, as they read best.
const RANK = { score: 3, status: 2, progress: 1 };
export const newestFirst = (a, b) => b.at.localeCompare(a.at) || RANK[b.type] - RANK[a.type];

// Corrections (progress going down) are kept in the log but not shown.
export const visible = (row) => row.type !== 'progress' || row.to > row.from;

export const isStart = (row) => row.type === 'status' && row.to === 'current' && row.from === 'planning';
export const isCompletion = (row) => row.type === 'status' && row.to === 'completed';

export function describe(row) {
  const auto = row.auto ? ' <span class="muted small">(auto)</span>' : '';
  if (row.type === 'progress') return { icon: '▶', html: `Progress ${row.from} → ${row.to} <span class="act-delta">+${row.to - row.from}</span>` };
  if (row.type === 'score') {
    return { icon: '★', html: row.to == null ? 'Score removed' : `Scored ${row.to}` };
  }
  if (isCompletion(row)) return { icon: '✓', html: `Completed${auto}` };
  if (isStart(row)) return { icon: '●', html: `Started${auto}` };
  return { icon: '●', html: `Status ${esc(statusLabel(row.from))} → ${esc(statusLabel(row.to))}${auto}` };
}

function rowHTML(row, entry) {
  const { icon, html } = describe(row);
  const title = entry ? `<a class="act-entry" href="#/entries/${esc(entry.id)}">${esc(entry.title)}</a>` : '';
  return `<li class="act-row"><time class="act-time muted small" datetime="${esc(row.at)}">${fmtTime(row.at)}</time>
    <span class="act-icon" aria-hidden="true">${icon}</span><span class="act-text">${title}${html}</span></li>`;
}

// Rows grouped by day: [{ day, rows }], newest first.
function byDay(rows) {
  const days = [];
  for (const row of [...rows].sort(newestFirst)) {
    const key = dayKey(row.at);
    if (days.at(-1)?.key !== key) days.push({ key, at: row.at, rows: [] });
    days.at(-1).rows.push(row);
  }
  return days;
}

function feedHTML(rows, entryOf) {
  return byDay(rows).map((d) => `
    <h3 class="act-day">${fmtDay(d.at)}</h3>
    <ul class="act-list">${d.rows.map((r) => rowHTML(r, entryOf?.(r))).join('')}</ul>`).join('');
}

// ---------------------------------------------------------------- entry page

export async function mountActivity(container, entry) {
  const rows = (await Activity.byEntry(entry.id)).filter(visible);
  if (!rows.length) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  container.innerHTML = `<h2>Activity</h2>${feedHTML(rows)}`;
}

// ---------------------------------------------------------------- recap

const PERIODS = { week: 'Week', month: 'Month', year: 'Year' };
const state = { period: 'month', offset: 0 }; // offset: 0 = this period, -1 = the one before…

function range(period, offset) {
  const now = new Date();
  let start;
  let end;
  if (period === 'week') {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7) + offset * 7);
    end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
  } else if (period === 'month') {
    start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
  } else {
    start = new Date(now.getFullYear() + offset, 0, 1);
    end = new Date(start.getFullYear() + 1, 0, 1);
  }
  return { start, end };
}

function rangeLabel(period, { start, end }) {
  if (period === 'year') return String(start.getFullYear());
  if (period === 'month') return start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 1);
  const fmt = (d, year) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}) });
  return `${fmt(start)} – ${fmt(last, true)}`;
}

function barsHTML(items, max) {
  return items.map(({ label, value, href }) => `
    <div class="recap-bar-row">
      <a class="recap-bar-label" href="${esc(href)}" title="${esc(label)}">${esc(label)}</a>
      <div class="bar"><span style="width:${max ? (value / max) * 100 : 0}%"></span></div>
      <span class="muted small recap-bar-value">${value}</span>
    </div>`).join('');
}

function daysChartHTML({ start, end }, rows) {
  const totals = new Map();
  for (const r of rows) if (r.type === 'progress') totals.set(dayKey(r.at), (totals.get(dayKey(r.at)) ?? 0) + (r.to - r.from));
  const days = [];
  for (let d = new Date(start); d < end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    days.push({ d, value: totals.get(dayKey(d.toISOString())) ?? 0 });
  }
  const max = Math.max(1, ...days.map((x) => x.value));
  return `<div class="recap-days" role="img" aria-label="Progress per day">${days.map(({ d, value }) =>
    `<span class="recap-day" style="height:${value ? Math.max(6, (value / max) * 100) : 2}%" title="${esc(d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}: ${value}"></span>`).join('')}</div>`;
}

export async function renderRecap(view) {
  const [all, entries] = await Promise.all([Activity.all(), Entries.all()]);
  const entryById = new Map(entries.map((e) => [e.id, e]));
  const known = all.filter((r) => entryById.has(r.entry_id) && visible(r));

  function draw() {
    const r = range(state.period, state.offset);
    const rows = known.filter((row) => {
      const t = Date.parse(row.at);
      return t >= r.start && t < r.end;
    });

    const progressRows = rows.filter((row) => row.type === 'progress');
    const chapters = progressRows.reduce((n, row) => n + (row.to - row.from), 0);
    const completed = rows.filter(isCompletion).sort(newestFirst);
    const started = rows.filter(isStart).length;

    const perEntry = new Map();
    for (const row of progressRows) perEntry.set(row.entry_id, (perEntry.get(row.entry_id) ?? 0) + (row.to - row.from));
    const top = [...perEntry].sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([id, value]) => ({ label: entryById.get(id).title, value, href: `#/entries/${id}` }));

    view.innerHTML = `
      <div class="page-head"><h1>Recap</h1></div>
      <div class="recap-controls">
        <div class="seg" role="group" aria-label="Period">
          ${Object.entries(PERIODS).map(([value, label]) =>
            `<button type="button" class="btn btn-small ${value === state.period ? 'btn-primary' : ''}" data-period="${value}">${label}</button>`).join('')}
        </div>
        <div class="recap-nav">
          <button type="button" class="btn btn-icon" data-shift="-1" aria-label="Previous">‹</button>
          <strong class="recap-label">${esc(rangeLabel(state.period, r))}</strong>
          <button type="button" class="btn btn-icon" data-shift="1" aria-label="Next" ${state.offset >= 0 ? 'disabled' : ''}>›</button>
        </div>
      </div>

      ${rows.length ? `
        <div class="recap-stats">
          <div class="panel"><strong>${chapters}</strong><span class="muted small">chapters / episodes</span></div>
          <div class="panel"><strong>${completed.length}</strong><span class="muted small">completed</span></div>
          <div class="panel"><strong>${started}</strong><span class="muted small">started</span></div>
        </div>

        ${completed.length ? `<h2 class="recap-h">Completed</h2>
          <ul class="recap-completed">${completed.map((row) => {
            const e = entryById.get(row.entry_id);
            return `<li><a href="#/entries/${esc(e.id)}">${coverHTML(e, 'cover-sm')}<span>${esc(e.title)}</span></a>
              <span class="muted small">${e.score != null ? `★ ${e.score} · ` : ''}${fmtDate(dayKey(row.at))}</span></li>`;
          }).join('')}</ul>` : ''}

        ${top.length ? `<h2 class="recap-h">Most active</h2>${barsHTML(top, top[0].value)}` : ''}

        ${progressRows.length ? `<h2 class="recap-h">By day</h2>${daysChartHTML(r, rows)}` : ''}

        <h2 class="recap-h">Activity</h2>
        ${feedHTML(rows, (row) => entryById.get(row.entry_id))}`
      : '<div class="empty-state"><p class="muted">No activity in this period.</p></div>'}`;
  }

  view.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.period) {
      state.period = button.dataset.period;
      state.offset = 0;
    } else if (button.dataset.shift) {
      state.offset = Math.min(0, state.offset + Number(button.dataset.shift));
    } else return;
    draw();
  });

  draw();
}
