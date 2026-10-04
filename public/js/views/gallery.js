// Gallery section on the entry page, plus the full-screen viewer.
import { Gallery, changes } from '../db.js';
import * as G from '../gallery.js';
import { toast } from '../util.js';

const thumbObserver = new IntersectionObserver((items) => {
  for (const item of items) {
    if (!item.isIntersecting) continue;
    thumbObserver.unobserve(item.target);
    item.target.loadThumb?.();
  }
}, { rootMargin: '300px' });

export async function mountGallery(section, entryId) {
  let images = [];

  async function draw() {
    images = await Gallery.byEntry(entryId);
    const canAdd = Boolean(G.getConfig());
    section.innerHTML = `
      <div class="section-head">
        <h2 class="section-title">Gallery ${images.length ? `<span class="muted">(${images.length})</span>` : ''}</h2>
        ${canAdd ? '<label class="btn btn-small">＋ Add images<input type="file" accept="image/*" multiple hidden></label>' : ''}
      </div>
      ${images.length
        ? `<div class="gallery-grid">${images.map((img, i) => `
            <button type="button" class="gallery-tile" data-index="${i}" aria-label="Open image ${i + 1} of ${images.length}">
              <img alt="" hidden>
              ${img.pending ? '<span class="gallery-badge">Uploading…</span>' : ''}
            </button>`).join('')}</div>`
        : `<p class="muted small">${canAdd
            ? 'No images yet.'
            : 'No images yet. To add some, set up image hosting in <a href="#/settings">Settings → Gallery</a>.'}</p>`}`;

    section.querySelectorAll('.gallery-tile').forEach((tile) => {
      const img = images[Number(tile.dataset.index)];
      tile.loadThumb = async () => {
        const url = await G.imageUrl(img, 'thumb');
        if (!url) return tile.classList.add('unavailable');
        const el = tile.querySelector('img');
        el.src = url;
        el.hidden = false;
      };
      thumbObserver.observe(tile);
      tile.addEventListener('click', () => openViewer(images, Number(tile.dataset.index), draw));
    });

    section.querySelector('input[type=file]')?.addEventListener('change', async (event) => {
      const files = [...event.target.files];
      event.target.value = '';
      if (!files.length) return;
      try {
        const n = await G.addImages(entryId, files);
        toast(`Added ${n} image${n === 1 ? '' : 's'}`, 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
      draw();
    });
  }

  // Refresh when uploads finish or the gallery changes (here or from another device);
  // stop listening once the page has been left.
  let shown = false;
  const refresh = () => {
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

function openViewer(images, start, onChange) {
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

  async function show(i) {
    index = (i + images.length) % images.length;
    const img = images[index];
    dialog.querySelector('.viewer-count').textContent = `${index + 1} / ${images.length}`;
    dialog.querySelectorAll('.viewer-nav').forEach((b) => (b.hidden = images.length < 2));
    note.hidden = true;
    // Thumbnail first (instant), then the full image.
    const thumb = await G.imageUrl(img, 'thumb');
    if (index !== images.indexOf(img)) return;
    imgEl.src = thumb ?? '';
    imgEl.hidden = !thumb;
    const full = await G.imageUrl(img, 'full');
    if (index !== images.indexOf(img)) return;
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
    if (startX == null || images.length < 2) return;
    const dx = e.clientX - startX;
    startX = null;
    if (Math.abs(dx) > 50) show(index + (dx < 0 ? 1 : -1));
  });

  dialog.querySelector('[data-v=delete]').addEventListener('click', async () => {
    if (!confirm('Delete this image from the gallery?')) return;
    const removedEverywhere = await G.deleteImage(images[index]);
    toast(removedEverywhere
      ? 'Image deleted'
      : 'Image deleted from the gallery. It stays in your Cloudinary Media Library until you remove it there.', 'success', 5000);
    images.splice(index, 1);
    onChange();
    if (!images.length) close();
    else show(index);
  });

  dialog.showModal();
  show(index);
}
