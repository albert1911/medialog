import { Activity, Entries } from '../db.js';
import { coverHTML } from '../components.js';
import { iconSVG } from '../icons.js';
import { STATUSES, esc, fmtDate, statusLabel, toast } from '../util.js';

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
  if (row.type === 'progress') return { icon: iconSVG('play'), html: `Progress ${row.from} → ${row.to} <span class="act-delta">+${row.to - row.from}</span>` };
  if (row.type === 'score') {
    return { icon: iconSVG('star'), html: row.to == null ? 'Score removed' : `Scored ${row.to}` };
  }
  if (isCompletion(row)) return { icon: iconSVG('done'), html: `Completed${auto}` };
  if (isStart(row)) return { icon: iconSVG('flag'), html: `Started${auto}` };
  return { icon: iconSVG('swap'), html: `Status ${esc(statusLabel(row.from))} → ${esc(statusLabel(row.to))}${auto}` };
}

function rowHTML(row, entry, editable = false) {
  const { icon, html } = describe(row);
  const title = entry ? `<a class="act-entry" href="#/entries/${esc(entry.id)}">${esc(entry.title)}</a>` : '';
  const tools = editable ? `<span class="act-tools">
      <button type="button" class="act-btn" data-act="edit" aria-label="Edit">${iconSVG('pen')}</button>
      <button type="button" class="act-btn" data-act="delete" aria-label="Delete">${iconSVG('trash')}</button></span>` : '';
  return `<li class="act-row" data-id="${esc(row.id)}"><time class="act-time muted small" datetime="${esc(row.at)}">${fmtTime(row.at)}</time>
    <span class="act-icon" aria-hidden="true">${icon}</span><span class="act-text">${title}${html}</span>${tools}</li>`;
}

// <input type="datetime-local"> wants local time without a zone.
const toLocalInput = (iso) => {
  const d = new Date(iso);
  return `${dayKey(iso)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function editHTML(row) {
  const num = (name, v) => `<input type="number" name="${name}" value="${v ?? ''}" step="any" ${row.type === 'score' ? '' : 'required'} aria-label="${name}">`;
  const opts = (v) => STATUSES.map((s) => `<option value="${s.value}" ${s.value === v ? 'selected' : ''}>${esc(s.label)}</option>`).join('');
  const fields = row.type === 'status'
    ? `<select name="from" aria-label="from">${opts(row.from)}</select> → <select name="to" aria-label="to">${opts(row.to)}</select>`
    : `${num('from', row.from)} → ${num('to', row.to)}`;
  return `<li class="act-row act-editing" data-id="${esc(row.id)}"><form class="act-form">
    <span class="act-form-type muted small">${row.type}</span>
    <span class="act-form-fields">${fields}</span>
    <input type="datetime-local" name="at" value="${toLocalInput(row.at)}" required aria-label="Time">
    <span class="act-form-actions">
      <button type="submit" class="btn btn-small btn-primary">Save</button>
      <button type="button" class="btn btn-small" data-act="cancel">Cancel</button>
    </span></form></li>`;
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

function feedHTML(rows, entryOf, editable = false) {
  return byDay(rows).map((d) => `
    <h3 class="act-day">${fmtDay(d.at)}</h3>
    <ul class="act-list">${d.rows.map((r) => rowHTML(r, entryOf?.(r), editable)).join('')}</ul>`).join('');
}

// ---------------------------------------------------------------- entry page

export async function mountActivity(container, entry) {
  const rows = (await Activity.byEntry(entry.id)).filter(visible);
  if (!rows.length) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  container.innerHTML = `<h2>Activity</h2><div class="act-feed">${feedHTML(rows, null, true)}</div>`;

  // Edit / delete log rows. This corrects the log only; the entry's own progress, status and score stay as they are.
  const byId = new Map(rows.map((r) => [r.id, r]));
  container.onclick = async (event) => {
    const button = event.target.closest('[data-act]');
    const li = button?.closest('.act-row');
    const row = li && byId.get(li.dataset.id);
    if (!row) return;
    try {
      if (button.dataset.act === 'edit') {
        li.replaceWith(Object.assign(document.createElement('div'), { innerHTML: editHTML(row) }).firstElementChild);
      } else if (button.dataset.act === 'cancel') {
        await mountActivity(container, entry);
      } else if (button.dataset.act === 'delete') {
        if (!confirm('Delete this activity entry? Your progress, status and score are not changed.')) return;
        await Activity.remove(row.id);
        await mountActivity(container, entry);
        toast('Activity deleted');
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  container.onsubmit = async (event) => {
    event.preventDefault();
    const li = event.target.closest('.act-row');
    const data = Object.fromEntries(new FormData(event.target));
    try {
      await Activity.update(li.dataset.id, {
        from: data.from === '' ? null : data.from,
        to: data.to === '' ? null : data.to,
        at: new Date(data.at).toISOString(),
      });
      await mountActivity(container, entry);
      toast('Activity updated', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  };
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

const localDayKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const fmtDayLong = (d) =>
  d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

function activityLevel(value, max) {
  if (!value || value <= 0) return 0;
  if (max <= 4) return Math.min(4, Math.max(1, value));
  return Math.min(4, Math.max(1, Math.ceil((value / max) * 4)));
}

function weekBarChartHTML(start, end, totals) {
  const days = [];
  for (let d = new Date(start); d < end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    const k = localDayKey(d);
    days.push({ d: new Date(d), key: k, value: totals.get(k) ?? 0 });
  }
  const max = Math.max(1, ...days.map((x) => x.value));

  return `
    <div class="recap-days-week" role="img" aria-label="Progress per day">
      ${days.map(({ d, value }) => {
        const title = `${fmtDayLong(d)}: ${value} ${value === 1 ? 'chapter / episode' : 'chapters / episodes'}`;
        const pct = value ? Math.max(6, (value / max) * 100) : 0;
        return `
          <div class="recap-bar-col" title="${esc(title)}">
            <div class="recap-bar-track">
              <span class="recap-bar-fill" style="height:${pct}%"></span>
            </div>
            <span class="recap-bar-day">${esc(d.toLocaleDateString(undefined, { weekday: 'short' }))}</span>
            <span class="recap-bar-date">${d.getDate()}</span>
          </div>`;
      }).join('')}
    </div>`;
}

function monthCalendarHTML(start, end, totals, max) {
  const days = [];
  for (let d = new Date(start); d < end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    const k = localDayKey(d);
    days.push({ d: new Date(d), key: k, value: totals.get(k) ?? 0 });
  }

  const firstWeekday = (days[0].d.getDay() + 6) % 7;
  const blankCells = Array.from({ length: firstWeekday }, () => '<span class="cal-day-empty"></span>').join('');

  const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const weekdaysHTML = weekdays.map((w) => `<span>${esc(w)}</span>`).join('');

  const daysHTML = days.map((day) => {
    const lvl = activityLevel(day.value, max);
    const title = `${fmtDayLong(day.d)}: ${day.value} ${day.value === 1 ? 'chapter / episode' : 'chapters / episodes'}`;
    return `<div class="cal-day cal-day-month" data-level="${lvl}" title="${esc(title)}">
      <span class="cal-day-num">${day.d.getDate()}</span>
    </div>`;
  }).join('');

  return `
    <div class="cal-month">
      <div class="cal-weekdays">${weekdaysHTML}</div>
      <div class="cal-month-grid">
        ${blankCells}
        ${daysHTML}
      </div>
      <div class="cal-legend">
        <span class="muted small">Less</span>
        <span class="cal-swatch" data-level="0" title="0 chapters"></span>
        <span class="cal-swatch" data-level="1" title="Low"></span>
        <span class="cal-swatch" data-level="2" title="Medium"></span>
        <span class="cal-swatch" data-level="3" title="High"></span>
        <span class="cal-swatch" data-level="4" title="Very high"></span>
        <span class="muted small">More</span>
      </div>
    </div>`;
}

function yearCalendarHTML(start, end, totals, max) {
  const days = [];
  for (let d = new Date(start); d < end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    const k = localDayKey(d);
    days.push({ d: new Date(d), key: k, value: totals.get(k) ?? 0 });
  }

  const firstWeekday = (days[0].d.getDay() + 6) % 7;
  const weeks = [];
  let currentWeek = [];
  for (let i = 0; i < firstWeekday; i++) {
    currentWeek.push(null);
  }
  for (const day of days) {
    currentWeek.push(day);
    if (currentWeek.length === 7) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
  }
  if (currentWeek.length > 0) {
    while (currentWeek.length < 7) currentWeek.push(null);
    weeks.push(currentWeek);
  }

  const monthLabels = [];
  let lastMonth = -1;
  weeks.forEach((week, weekIdx) => {
    const firstDay = week.find((day) => day !== null);
    if (firstDay && firstDay.d.getMonth() !== lastMonth) {
      lastMonth = firstDay.d.getMonth();
      monthLabels.push({
        col: weekIdx + 1,
        label: firstDay.d.toLocaleDateString(undefined, { month: 'short' }),
      });
    }
  });

  const monthsHTML = monthLabels.map(({ col, label }) =>
    `<span style="grid-column: ${col};">${esc(label)}</span>`
  ).join('');

  const weekdayNames = ['Mon', '', 'Wed', '', 'Fri', '', ''];
  const weekdaysHTML = weekdayNames.map((name) => `<span>${esc(name)}</span>`).join('');

  const cellsHTML = weeks.flatMap((week) =>
    week.map((day) => {
      if (!day) return '<span class="cal-day-empty"></span>';
      const lvl = activityLevel(day.value, max);
      const title = `${fmtDayLong(day.d)}: ${day.value} ${day.value === 1 ? 'chapter / episode' : 'chapters / episodes'}`;
      return `<span class="cal-day cal-day-year" data-level="${lvl}" title="${esc(title)}"></span>`;
    })
  ).join('');

  return `
    <div class="cal-year-wrap">
      <div class="cal-year">
        <div class="cal-year-header" style="grid-template-columns: repeat(${weeks.length}, 13px);">
          ${monthsHTML}
        </div>
        <div class="cal-year-body">
          <div class="cal-year-weekdays">${weekdaysHTML}</div>
          <div class="cal-year-grid" style="grid-template-columns: repeat(${weeks.length}, 13px);">
            ${cellsHTML}
          </div>
        </div>
        <div class="cal-legend">
          <span class="muted small">Less</span>
          <span class="cal-swatch" data-level="0" title="0 chapters"></span>
          <span class="cal-swatch" data-level="1" title="Low"></span>
          <span class="cal-swatch" data-level="2" title="Medium"></span>
          <span class="cal-swatch" data-level="3" title="High"></span>
          <span class="cal-swatch" data-level="4" title="Very high"></span>
          <span class="muted small">More</span>
        </div>
      </div>
    </div>`;
}

function daysChartHTML({ start, end }, rows, period) {
  const totals = new Map();
  for (const r of rows) if (r.type === 'progress') totals.set(dayKey(r.at), (totals.get(dayKey(r.at)) ?? 0) + (r.to - r.from));
  const days = [];
  for (let d = new Date(start); d < end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    const k = localDayKey(d);
    days.push({ d, value: totals.get(k) ?? 0 });
  }
  const max = Math.max(1, ...days.map((x) => x.value));

  if (period === 'week') return weekBarChartHTML(start, end, totals);
  if (period === 'month') return monthCalendarHTML(start, end, totals, max);
  return yearCalendarHTML(start, end, totals, max);
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
          <button type="button" class="btn btn-icon" data-shift="-1" aria-label="Previous">${iconSVG('chevronLeft')}</button>
          <strong class="recap-label">${esc(rangeLabel(state.period, r))}</strong>
          <button type="button" class="btn btn-icon" data-shift="1" aria-label="Next" ${state.offset >= 0 ? 'disabled' : ''}>${iconSVG('chevronRight')}</button>
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

        ${state.period === 'year' ? `
          <h2 class="recap-h">By day</h2>
          ${daysChartHTML(r, rows, 'year')}
          <h2 class="recap-h">Activity</h2>
          ${feedHTML(rows, (row) => entryById.get(row.entry_id))}
        ` : `
          <div class="recap-cols">
            <section class="recap-col">
              <h2 class="recap-h">By day</h2>
              ${daysChartHTML(r, rows, state.period)}
            </section>
            <section class="recap-col">
              <h2 class="recap-h">Activity</h2>
              ${feedHTML(rows, (row) => entryById.get(row.entry_id))}
            </section>
          </div>
        `}
      ` : '<div class="empty-state"><p class="muted">No activity in this period.</p></div>'}`;
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
