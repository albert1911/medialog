import { Covers, Entries, coverIdOf, isCoverRef } from './db.js';
import { esc, safeImg, sameTag, statusLabel, toast } from './util.js';

// portrait (< 0.85), square (0.85–1.3), landscape (>= 1.3).
// Library cards have a landscape 16:9 frame: landscape covers fill it, portrait and square ones
// are shown whole over a blurred copy of themselves. On the entry page, landscape covers become
// a banner and portrait/square ones keep their own proportions in the side column.
// Every cover with a known shape carries the blurred backdrop; CSS decides where it shows.
export function coverShape(aspect) {
  if (!aspect) return '';
  return aspect >= 1.3 ? 'landscape' : aspect > 0.85 ? 'square' : 'portrait';
}

const clampAspect = (aspect) => Math.min(Math.max(aspect, 0.5), 1.3);
// Web URLs go straight into src. Uploaded images ("cover:<id>") get data-cover instead and
// are loaded from the covers store only when they scroll into view (see watchCovers).
const imgAttr = (image) => (isCoverRef(image) ? `data-cover="${esc(coverIdOf(image))}"` : `src="${esc(image)}"`);
const backdropHTML = (image) => `<img class="cover-backdrop" ${imgAttr(image)} alt="" aria-hidden="true" loading="lazy" decoding="async">`;

export function coverHTML(entry, extraClass = '') {
  const image = isCoverRef(entry.cover_image) ? entry.cover_image : safeImg(entry.cover_image);
  const initial = (entry.title ?? '?').trim().charAt(0).toUpperCase() || '?';
  const shape = image ? coverShape(entry.cover_aspect) : '';
  const aspectVar = shape ? ` style="--aspect:${clampAspect(entry.cover_aspect)}"` : '';
  return `<div class="cover ${extraClass}" data-initial="${esc(initial)}" data-shape="${shape}"${aspectVar}>
    ${image && shape ? backdropHTML(image) : ''}
    ${image ? `<img class="cover-img" ${imgAttr(image)} alt="" loading="lazy" decoding="async">` : ''}
  </div>`;
}

// ---- lazy loading of uploaded covers
const coverUrls = new Map(); // cover id -> object URL (kept for the session)

async function loadCover(img) {
  const id = img.dataset.cover;
  let url = coverUrls.get(id);
  if (!url) {
    const record = await Covers.get(id);
    if (!record) return; // not on this device yet (sync will bring it)
    url = URL.createObjectURL(record.blob);
    coverUrls.set(id, url);
  }
  img.src = url;
}

const coverObserver = new IntersectionObserver((items) => {
  for (const item of items) {
    if (!item.isIntersecting) continue;
    coverObserver.unobserve(item.target);
    loadCover(item.target);
  }
}, { rootMargin: '400px' });

const observeCovers = (node) => {
  if (node.matches?.('img[data-cover]')) coverObserver.observe(node);
  node.querySelectorAll?.('img[data-cover]').forEach((img) => coverObserver.observe(img));
};

// Watches `root` so every uploaded cover rendered inside it loads when it's about to be seen.
export function watchCovers(root) {
  observeCovers(root);
  new MutationObserver((mutations) => {
    for (const m of mutations) m.addedNodes.forEach((node) => node.nodeType === 1 && observeCovers(node));
  }).observe(root, { childList: true, subtree: true });
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
  if (!cover.querySelector('.cover-backdrop')) {
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
  return `<article class="card" data-id="${esc(e.id)}">
    <a class="card-link" href="#/entries/${esc(e.id)}" aria-label="${esc(e.title)}"></a>
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

// Renders entry cards into `container` as a grid of same-shape (16:9) cards, or `emptyHTML`
// if there are none.
export function renderCards(container, entries, emptyHTML) {
  container.classList.add('cards');
  container.innerHTML = entries.length ? entries.map(entryCard).join('') : emptyHTML;
}

// Handles the "+1" buttons on entry cards inside `container`.
export function bindCards(container, onChange) {
  container.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action="inc"]');
    if (!button) return;
    event.preventDefault();
    button.disabled = true;
    try {
      const id = button.closest(".card").dataset.id;
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
    li>p{margin:0}
    hr{border:0;border-top:1px solid #8886;margin:1.2em 0}
    blockquote{margin:1em 0;padding:0 1em;border-left:4px solid #8886}
    code{background:#8883;border-radius:4px;padding:.1em .35em}
    .card{border:1px solid #8886;border-radius:10px;padding:.8em 1em;margin:1em 0;background:#8881}
    .card>:first-child{margin-top:0} .card>:last-child{margin-bottom:0}
    table{border-collapse:collapse} td,th{border:1px solid #8885;padding:4px 8px}
  </style></head><body>${html}</body></html>`;
  // The frame's height includes its own padding and border (border-box sizing), so add those
  // to the content's height; otherwise the last line(s) get cut off.
  const fit = () => {
    const body = frame.contentDocument?.body;
    if (!body) return;
    const cs = getComputedStyle(frame);
    const chrome = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth']
      .reduce((sum, prop) => sum + (parseFloat(cs[prop]) || 0), 0);
    frame.style.height = `${Math.ceil(body.scrollHeight + chrome)}px`;
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

// A dropdown of known values plus "＋ New …", which switches to a text box. Used for the
// free-text fields (type, category) so they look and work like every other dropdown.
// Whichever control is active carries the field's name, so FormData and validation just work.
const NEW_CHOICE = '__new__';

export function choiceFieldHTML({ name, label, value, options, placeholder, newLabel, maxlength }) {
  // Nothing to choose from yet (first entry): go straight to the text box.
  const inList = options.length > 0 && (!value || options.includes(value));
  return `<div class="field choice" data-choice="${esc(name)}">
    <span>${esc(label)}</span>
    <select ${inList ? `name="${esc(name)}"` : ''} ${inList ? '' : 'hidden'}>
      <option value="" ${value ? '' : 'selected'}>${esc(placeholder)}</option>
      ${options.map((o) => `<option ${o === value ? 'selected' : ''}>${esc(o)}</option>`).join('')}
      <option value="${NEW_CHOICE}">${esc(newLabel)}</option>
    </select>
    <div class="choice-new" ${inList ? 'hidden' : ''}>
      <input type="text" ${inList ? '' : `name="${esc(name)}"`} maxlength="${maxlength}" value="${inList ? '' : esc(value)}"
        placeholder="${esc(newLabel.replace(/^＋\s*/, '').replace(/…$/, ''))}" autocomplete="off">
      <button type="button" class="btn btn-ghost" data-choice-back ${options.length ? '' : 'hidden'}>Back to list</button>
    </div>
  </div>`;
}

export function bindChoiceFields(root) {
  root.querySelectorAll('[data-choice]').forEach((box) => {
    const name = box.dataset.choice;
    const select = box.querySelector('select');
    const textBox = box.querySelector('.choice-new');
    const input = textBox.querySelector('input');
    const useText = (on) => {
      select.hidden = on;
      textBox.hidden = !on;
      if (on) {
        select.removeAttribute('name');
        input.name = name;
        input.focus();
      } else {
        input.removeAttribute('name');
        select.name = name;
        select.focus();
      }
    };
    select.addEventListener('change', () => {
      if (select.value !== NEW_CHOICE) return;
      select.value = '';
      useText(true);
    });
    box.querySelector('[data-choice-back]').addEventListener('click', () => {
      input.value = '';
      useText(false);
    });
  });
}

// Tags: chips plus a text box. Enter or a comma adds what's typed (also picking a suggestion),
// Backspace in the empty box removes the last tag. The text box carries name="tags" only so
// validation errors can point at it; read the value with the getter bindTagField returns.
export function tagFieldHTML({ value, options }) {
  return `<div class="field" data-tags>
    <label class="field-label" for="tag-input">Tags</label>
    <div class="tag-box">
      <span class="tag-chips" data-initial="${esc(JSON.stringify(value ?? []))}" data-options="${esc(JSON.stringify(options))}"></span>
      <input id="tag-input" name="tags" list="tag-options" maxlength="50" placeholder="Add a tag…" autocomplete="off" enterkeyhint="enter">
    </div>
    <datalist id="tag-options"></datalist>
    <small class="muted">Press Enter or comma after each tag.</small>
  </div>`;
}

export function bindTagField(root) {
  const box = root.querySelector('[data-tags]');
  const chips = box.querySelector('.tag-chips');
  const input = box.querySelector('input');
  const datalist = box.querySelector('datalist');
  const options = JSON.parse(chips.dataset.options);
  let tags = JSON.parse(chips.dataset.initial);

  const draw = () => {
    chips.innerHTML = tags.map((t, i) => `<span class="chip tag">${esc(t)}<button type="button" class="chip-remove" data-remove="${i}" aria-label="Remove tag ${esc(t)}">×</button></span>`).join('');
    datalist.innerHTML = options.filter((o) => !tags.some((t) => sameTag(t, o))).map((o) => `<option value="${esc(o)}">`).join('');
  };
  // Typed text becomes tags (several at once if it has commas); an existing tag keeps its spelling.
  const commit = () => {
    for (const part of input.value.split(',')) {
      const typed = part.trim().replace(/\s+/g, ' ');
      if (!typed || tags.some((t) => sameTag(t, typed))) continue;
      tags.push(options.find((o) => sameTag(o, typed)) ?? typed);
    }
    input.value = '';
    input.removeAttribute('aria-invalid');
    draw();
  };

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && input.value.trim()) {
      event.preventDefault(); // add the tag instead of submitting the form
      commit();
    } else if (event.key === 'Backspace' && !input.value && tags.length) {
      tags.pop();
      draw();
    }
  });
  input.addEventListener('input', (event) => {
    // A comma (typed or pasted), or a suggestion picked from the list (not typed key by key).
    const picked = (event.inputType ?? 'insertReplacementText') === 'insertReplacementText'
      && options.some((o) => sameTag(o, input.value.trim()));
    if (input.value.includes(',') || picked) commit();
  });
  chips.addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove]');
    if (!button) return;
    tags.splice(Number(button.dataset.remove), 1);
    draw();
    input.focus();
  });
  box.querySelector('.tag-box').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) input.focus();
  });
  draw();

  // Current tags, including anything typed but not yet added.
  return () => {
    commit();
    return [...tags];
  };
}

export function charCounter(input) {
  const counter = document.createElement('span');
  counter.className = 'counter muted small';
  const update = () => (counter.textContent = `${input.value.length} / ${input.maxLength}`);
  input.addEventListener('input', update);
  update();
  input.after(counter);
}

// A dropdown with a search box (for long lists like tags and sources). `options` is
// [{ value, label }]; the first one is the "all" choice. Calls onChange(value) on pick.
export function searchSelect({ id, label, options, value, onChange }) {
  const root = document.createElement('div');
  root.className = 'combo';
  root.id = id;
  root.innerHTML = `
    <button type="button" class="combo-btn" aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(label)}">
      <span class="combo-label"></span>
    </button>
    <div class="combo-pop" hidden>
      <input type="search" class="combo-search" placeholder="Search…" aria-label="Search ${esc(label)}" autocomplete="off">
      <ul class="combo-list" role="listbox"></ul>
    </div>`;
  const btn = root.querySelector('.combo-btn');
  const pop = root.querySelector('.combo-pop');
  const search = root.querySelector('.combo-search');
  const list = root.querySelector('.combo-list');

  const setLabel = () => {
    const current = options.find((o) => o.value === value) ?? options[0];
    const span = root.querySelector('.combo-label');
    span.textContent = current.label;
    span.title = current.label;
    btn.classList.toggle('is-placeholder', current === options[0]);
  };
  const drawList = () => {
    const needle = search.value.trim().toLowerCase();
    const shown = options.filter((o) => !needle || o.label.toLowerCase().includes(needle));
    list.innerHTML = shown.length
      ? shown.map((o) => `<li role="option" tabindex="-1" data-value="${esc(o.value)}" aria-selected="${o.value === value}" title="${esc(o.label)}">${esc(o.label)}</li>`).join('')
      : '<li class="combo-empty">No matches</li>';
  };
  const close = () => {
    pop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
  };
  const outside = (event) => { if (!root.contains(event.target)) close(); };
  const open = () => {
    search.value = '';
    drawList();
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
    search.focus();
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  };
  const pick = (li) => {
    if (!li?.dataset || li.dataset.value === undefined) return;
    value = li.dataset.value;
    setLabel();
    close();
    btn.focus();
    onChange(value);
  };

  btn.addEventListener('click', () => (pop.hidden ? open() : close()));
  search.addEventListener('input', drawList);
  list.addEventListener('click', (event) => pick(event.target.closest('li')));
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !pop.hidden) { close(); btn.focus(); }
    else if (event.key === 'Enter' && event.target === search) { event.preventDefault(); pick(list.querySelector('li[data-value]')); }
    else if (event.key === 'ArrowDown' && event.target === search) { event.preventDefault(); list.querySelector('li[data-value]')?.focus(); }
    else if (event.key === 'Enter' && event.target.matches('li')) pick(event.target);
    else if (event.key === 'ArrowDown' && event.target.matches('li')) { event.preventDefault(); event.target.nextElementSibling?.focus(); }
    else if (event.key === 'ArrowUp' && event.target.matches('li')) { event.preventDefault(); (event.target.previousElementSibling ?? search).focus(); }
  });

  setLabel();
  return root;
}
