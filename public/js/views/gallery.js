// Gallery section on the entry page, plus the full-screen viewer.
// The entry's cover is shown as the first tile (display only: it isn't a gallery record,
// isn't synced as one, and can't be deleted from here — change it via Edit).
import { Covers, Gallery, changes, coverIdOf, isCoverRef } from '../db.js';
import * as G from '../gallery.js';
import { safeImg, toast } from '../util.js';

const thumbObserver = new IntersectionObserver((items) => {
  for (const item of items) {
    if (!item.isIntersecting) continue;
    thumbObserver.unobserve(item.target);
    item.target.loadThumb?.();
  }
}, { rootMargin: '300px' });

const coverUrls = new Map(); // cover id -> object URL

// URL of the cover image (uploaded covers come from the device, web covers load directly).
async function coverUrl(image) {
  if (isCoverRef(image)) {
    const id = coverIdOf(image);
    if (!coverUrls.has(id)) {
      const record = await Covers.get(id);
      if (!record) return null;
      coverUrls.set(id, URL.createObjectURL(record.blob));
    }
    return coverUrls.get(id);
  }
  return safeImg(image);
}

// Everything the grid and viewer show: { label, url(size), image? (gallery record) }.
function itemsFor(entry, images) {
  const items = images.map((image) => ({ image, url: (size) => G.imageUrl(image, size) }));
  if (entry?.cover_image) items.unshift({ cover: true, url: () => coverUrl(entry.cover_image) });
  return items;
}

export async function mountGallery(section, entry) {
  let items = [];
  let images = [];
  let reordering = false;
  // While a tile is being dragged, redraws (another change, a sync) wait until it's dropped.
  let dragActive = false;
  let redrawPending = false;

  async function draw() {
    images = await Gallery.byEntry(entry.id);
    items = itemsFor(entry, images);
    if (images.length < 2) reordering = false;
    const canAdd = Boolean(G.getConfig());
    section.classList.toggle('reordering', reordering);
    section.innerHTML = `
      <div class="section-head">
        <h2 class="section-title">Gallery ${images.length ? `<span class="muted">(${images.length})</span>` : ''}</h2>
        <div class="row">
          ${images.length >= 2 ? `<button type="button" class="btn btn-small" data-g="reorder">${reordering ? 'Done' : 'Reorder'}</button>` : ''}
          ${canAdd && !reordering ? '<label class="btn btn-small">＋ Add images<input type="file" accept="image/*" multiple hidden></label>' : ''}
        </div>
      </div>
      ${reordering ? '<p class="muted small reorder-hint">Drag images to reorder them, or use the arrows. The cover always stays first.</p>' : ''}
      ${items.length
        ? `<div class="gallery-grid">${items.map((item, i) => `
            <button type="button" class="gallery-tile" data-index="${i}" ${item.image ? `data-image="${item.image.id}"` : ''}
              aria-label="${item.cover ? 'Open cover image' : `Open image ${i + 1}`}">
              <img alt="" hidden draggable="false">
              ${item.cover ? '<span class="gallery-badge">Cover</span>' : ''}
              ${item.image?.pending ? '<span class="gallery-badge">Uploading…</span>' : ''}
              ${reordering && item.image ? `
                <span class="move-buttons">
                  <span class="move-btn" role="button" tabindex="0" data-move="-1" aria-label="Move earlier">◀</span>
                  <span class="move-btn" role="button" tabindex="0" data-move="1" aria-label="Move later">▶</span>
                </span>` : ''}
            </button>`).join('')}</div>`
        : ''}
      ${images.length ? '' : `<p class="muted small">${canAdd
        ? 'No gallery images yet.'
        : 'No gallery images yet. To add some, set up image hosting in <a href="#/settings">Settings → Gallery</a>.'}</p>`}`;

    section.querySelectorAll('.gallery-tile').forEach((tile) => {
      const item = items[Number(tile.dataset.index)];
      tile.loadThumb = async () => {
        const url = await item.url('thumb');
        if (!url) return tile.classList.add('unavailable');
        const el = tile.querySelector('img');
        // A damaged file: show the "not available" placeholder instead of a broken-image icon.
        el.onerror = () => {
          el.hidden = true;
          tile.classList.add('unavailable');
        };
        el.src = url;
        el.hidden = false;
      };
      thumbObserver.observe(tile);
      tile.addEventListener('click', (event) => {
        if (reordering) {
          const move = event.target.closest('[data-move]');
          if (move && item.image) moveBy(item.image.id, Number(move.dataset.move));
          return; // tapping doesn't open the viewer while reordering
        }
        openViewer(items, Number(tile.dataset.index), draw);
      });
      tile.addEventListener('keydown', (event) => {
        const move = reordering && (event.key === 'Enter' || event.key === ' ') && event.target.closest('[data-move]');
        if (!move || !item.image) return;
        event.preventDefault();
        moveBy(item.image.id, Number(move.dataset.move));
      });
    });

    section.querySelector('[data-g=reorder]')?.addEventListener('click', () => {
      reordering = !reordering;
      draw();
    });
    if (reordering) enableDragging(section.querySelector('.gallery-grid'));

    section.querySelector('input[type=file]')?.addEventListener('change', async (event) => {
      const files = [...event.target.files];
      event.target.value = '';
      if (!files.length) return;
      try {
        const n = await G.addImages(entry.id, files);
        toast(`Added ${n} image${n === 1 ? '' : 's'}`, 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
      draw();
    });
  }

  // ---- reordering
  const galleryOrder = () => images.map((g) => g.id);

  async function saveOrder(orderedIds, movedId) {
    if (orderedIds.join() === galleryOrder().join()) return draw(); // dropped where it was
    try {
      await Gallery.move(orderedIds, movedId); // the change event redraws the gallery
    } catch (err) {
      toast(`Could not save the new order: ${err.message}`, 'error');
      draw();
    }
  }

  // ◀ / ▶ buttons: swap with the neighbour.
  function moveBy(id, step) {
    const ids = galleryOrder();
    const from = ids.indexOf(id);
    const to = from + step;
    if (to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    saveOrder(ids, id);
  }

  // Drag with mouse or touch: the dragged tile moves into place live; saved on release.
  function enableDragging(grid) {
    let dragging = null;
    grid.addEventListener('pointerdown', (event) => {
      const tile = event.target.closest('.gallery-tile[data-image]');
      if (!tile || event.target.closest('[data-move]') || event.button > 0) return;
      event.preventDefault();
      dragging = tile;
      dragActive = true;
      tile.setPointerCapture(event.pointerId);
      tile.classList.add('dragging');
    });
    grid.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      const over = document.elementFromPoint(event.clientX, event.clientY)?.closest('.gallery-tile[data-image]');
      if (!over || over === dragging || !grid.contains(over)) return;
      const box = over.getBoundingClientRect();
      const after = event.clientX > box.left + box.width / 2;
      grid.insertBefore(dragging, after ? over.nextSibling : over);
    });
    const finish = () => {
      if (!dragging) return;
      const moved = dragging;
      dragging = null;
      dragActive = false;
      redrawPending = false; // saveOrder redraws in any case
      moved.classList.remove('dragging');
      const ids = [...grid.querySelectorAll('.gallery-tile[data-image]')].map((t) => t.dataset.image);
      saveOrder(ids, moved.dataset.image);
    };
    grid.addEventListener('pointerup', finish);
    grid.addEventListener('pointercancel', finish);
  }

  // Refresh when uploads finish or the gallery changes (here or from another device);
  // stop listening once the page has been left.
  let shown = false;
  const refresh = () => {
    if (dragActive) {
      redrawPending = true;
      return;
    }
    if (section.isConnected) {
      shown = true;
      draw();
    } else if (shown) {
      cleanup();
    }
  };
  const cleanup = () => {
    G.status.removeEventListener('change', refresh);
    changes.removeEventListener('change', refresh);
  };
  G.status.addEventListener('change', refresh);
  changes.addEventListener('change', refresh);
  await draw();
}

// ---------------------------------------------------------------- viewer

function openViewer(items, start, onChange) {
  let index = start;
  const dialog = document.createElement('dialog');
  dialog.className = 'viewer';
  dialog.innerHTML = `
    <img class="viewer-img" alt="">
    <p class="viewer-note" hidden>This image isn't available on this device yet.</p>
    <button type="button" class="viewer-nav prev" aria-label="Previous image">‹</button>
    <button type="button" class="viewer-nav next" aria-label="Next image">›</button>
    <div class="viewer-bar">
      <span class="viewer-count"></span>
      <div class="row">
        <button type="button" class="btn btn-small btn-danger-ghost" data-v="delete">Delete</button>
        <button type="button" class="btn btn-small" data-v="close">Close</button>
      </div>
    </div>`;
  document.body.append(dialog);
  const imgEl = dialog.querySelector('.viewer-img');
  const note = dialog.querySelector('.viewer-note');
  const deleteButton = dialog.querySelector('[data-v=delete]');

  async function show(i) {
    index = (i + items.length) % items.length;
    const item = items[index];
    dialog.querySelector('.viewer-count').textContent = `${item.cover ? 'Cover · ' : ''}${index + 1} / ${items.length}`;
    dialog.querySelectorAll('.viewer-nav').forEach((b) => (b.hidden = items.length < 2));
    deleteButton.hidden = Boolean(item.cover); // the cover is changed via Edit, not here
    note.hidden = true;
    // Thumbnail first (instant), then the full image.
    const thumb = await item.url('thumb');
    if (index !== items.indexOf(item)) return;
    imgEl.src = thumb ?? '';
    imgEl.hidden = !thumb;
    const full = await item.url('full');
    if (index !== items.indexOf(item)) return;
    if (full) {
      imgEl.src = full;
      imgEl.hidden = false;
    } else if (!thumb) {
      note.hidden = false;
    }
  }

  const close = () => dialog.close();
  dialog.addEventListener('close', () => dialog.remove());
  dialog.querySelector('.prev').addEventListener('click', () => show(index - 1));
  dialog.querySelector('.next').addEventListener('click', () => show(index + 1));
  dialog.querySelector('[data-v=close]').addEventListener('click', close);
  dialog.addEventListener('click', (e) => e.target === dialog && close()); // click on the backdrop
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') show(index - 1);
    if (e.key === 'ArrowRight') show(index + 1);
  });

  // Swipe left/right on touch screens.
  let startX = null;
  dialog.addEventListener('pointerdown', (e) => (startX = e.clientX));
  dialog.addEventListener('pointerup', (e) => {
    if (startX == null || items.length < 2) return;
    const dx = e.clientX - startX;
    startX = null;
    if (Math.abs(dx) > 50) show(index + (dx < 0 ? 1 : -1));
  });

  deleteButton.addEventListener('click', async () => {
    const item = items[index];
    if (!item.image || !confirm('Delete this image from the gallery?')) return;
    const removedEverywhere = await G.deleteImage(item.image);
    toast(removedEverywhere
      ? 'Image deleted'
      : 'Image deleted from the gallery. It stays in your Cloudinary Media Library until you remove it there.', 'success', 5000);
    items.splice(index, 1);
    onChange();
    if (!items.length) close();
    else show(index);
  });

  dialog.showModal();
  show(index);
}
