// Gallery images, hosted on Cloudinary (free plan, unsigned uploads straight from the browser).
//
// - Each image is a small synced record (db.js → Gallery); the file itself lives on Cloudinary.
// - Adding works offline: the image is resized, kept on this device, and uploaded when possible.
// - Other devices download a thumbnail when the gallery is shown and the full image when opened,
//   then keep both on the device (no further traffic, works offline).
// - Self-healing: if a device finds an image gone from Cloudinary (e.g. you deleted a leaked one),
//   it flags it; a device that still has the file re-uploads it under a new, unknown link.
import { Gallery, GalleryCache, Meta, changes } from './db.js';
import { imageToBlob, squareThumb } from './util.js';

const CONFIG_KEY = 'gallery.config'; // { cloud, preset }: this device
const TOKENS_KEY = 'gallery.deleteTokens'; // { [image id]: { token, expires } }: this device
const FULL_MAX_SIDE = 2048;
// The only transformation the app requests (allow it if you turn on "strict transformations").
export const THUMB_TRANSFORMATION = 'c_fill,g_center,w_320,h_320,q_80,f_jpg';
const DELETE_TOKEN_TTL_MS = 9 * 60 * 1000; // Cloudinary's tokens are valid for 10 minutes

export const status = new EventTarget(); // "change": config or upload progress changed

let config = null;
let uploading = null;
let progress = { pending: 0, error: null };

const emit = () => status.dispatchEvent(new Event('change'));
export const getConfig = () => config;
export const getProgress = () => progress;

export async function initGallery() {
  config = (await Meta.get(CONFIG_KEY)) ?? null;
  window.addEventListener('online', () => uploadPending());
  // Another device may have reported an image missing that this device can re-upload.
  changes.addEventListener('change', (event) => event.detail?.origin === 'sync' && uploadPending());
  uploadPending();
  setTimeout(() => GalleryCache.prune().catch((err) => console.warn('Gallery cleanup failed', err)), 4000);
}

export async function setConfig(cloudInput, presetInput) {
  const cloud = cloudInput.trim();
  const preset = presetInput.trim();
  if (!/^[\w-]+$/.test(cloud)) throw new Error('Cloud name looks wrong. Copy it from your Cloudinary dashboard.');
  if (!/^[\w-]+$/.test(preset)) throw new Error('Upload preset name looks wrong. Copy it from Settings → Upload in Cloudinary.');
  config = { cloud, preset };
  await Meta.set(CONFIG_KEY, config);
  emit();
  uploadPending();
}

export async function clearConfig() {
  config = null;
  await Meta.remove(CONFIG_KEY);
  emit();
}

const deliveryUrl = (img, transformation = '') =>
  `https://res.cloudinary.com/${img.cloud}/image/upload/${transformation ? `${transformation}/` : ''}v${img.version}/${img.public_id}.${img.format}`;

// ---------------------------------------------------------------- adding & uploading

export async function addImages(entryId, files) {
  if (!config) throw new Error('Set up gallery hosting in Settings → Gallery first.');
  let added = 0;
  for (const file of files) {
    const { blob, width, height } = await imageToBlob(file, FULL_MAX_SIDE);
    const record = await Gallery.add({ entry_id: entryId, cloud: config.cloud, width, height, pending: true });
    await GalleryCache.put(record.id, 'full', blob);
    await GalleryCache.put(record.id, 'thumb', await squareThumb(blob));
    added++;
  }
  uploadPending();
  return added;
}

async function uploadOne(img) {
  const blob = await GalleryCache.get(img.id, 'full');
  const form = new FormData();
  form.append('file', blob, 'image.jpg');
  form.append('upload_preset', config.preset);
  let res;
  try {
    res = await fetch(`https://api.cloudinary.com/v1_1/${config.cloud}/image/upload`, { method: 'POST', body: form });
  } catch {
    throw new Error(navigator.onLine ? 'Could not reach Cloudinary.' : "You're offline. Images upload when you're back online.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Cloudinary: ${data.error?.message ?? `error ${res.status}`}`);

  await Gallery.update(img.id, {
    cloud: config.cloud, public_id: data.public_id, version: data.version, format: data.format,
    width: data.width, height: data.height, pending: false, missing: false,
  });
  if (data.delete_token) {
    const tokens = (await Meta.get(TOKENS_KEY)) ?? {};
    tokens[img.id] = { token: data.delete_token, expires: Date.now() + DELETE_TOKEN_TTL_MS };
    await Meta.set(TOKENS_KEY, tokens);
  }
}

// Uploads images waiting on this device: new ones, and ones another device reported missing.
export function uploadPending() {
  if (!config || uploading) return uploading;
  uploading = (async () => {
    try {
      for (;;) {
        const queue = [];
        for (const img of await Gallery.all()) {
          if ((img.pending || img.missing) && (await GalleryCache.get(img.id, 'full'))) queue.push(img);
        }
        progress = { pending: queue.length, error: null };
        emit();
        if (!queue.length) return;
        await uploadOne(queue[0]);
      }
    } catch (err) {
      progress = { ...progress, error: err.message };
      emit();
    } finally {
      uploading = null;
    }
  })();
  return uploading;
}

// ---------------------------------------------------------------- viewing

const objectUrls = new Map(); // "<id>:<size>" -> object URL (session cache)

async function download(img, size) {
  let res;
  try {
    res = await fetch(deliveryUrl(img, size === 'thumb' ? THUMB_TRANSFORMATION : ''));
  } catch {
    return { blob: null, offline: true };
  }
  if (res.ok) {
    const blob = await res.blob();
    await GalleryCache.put(img.id, size, blob);
    return { blob };
  }
  if (size === 'thumb') {
    // Thumbnail refused (e.g. strict transformations without this one allowed): make it locally.
    const { blob: full } = await download(img, 'full');
    if (!full) return { blob: null };
    const thumb = await squareThumb(full);
    await GalleryCache.put(img.id, 'thumb', thumb);
    return { blob: thumb };
  }
  if (res.status === 404 && !img.missing) await Gallery.update(img.id, { missing: true }); // ask a device with the file to re-upload
  return { blob: null };
}

// Object URL for an image ("thumb" or "full"), or null if it isn't available (yet).
export async function imageUrl(img, size) {
  const key = `${img.id}:${size}`;
  if (objectUrls.has(key)) return objectUrls.get(key);
  let blob = await GalleryCache.get(img.id, size);
  if (!blob && img.public_id && img.cloud) ({ blob } = await download(img, size));
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  objectUrls.set(key, url);
  return url;
}

// ---------------------------------------------------------------- deleting

// Removes the image from the gallery (and from every device through sync). Within 10 minutes of
// uploading it's also deleted from Cloudinary; after that it stays there until you remove it in
// Cloudinary's Media Library. Returns true if Cloudinary deleted it too.
export async function deleteImage(img) {
  await Gallery.remove(img.id);
  for (const size of ['thumb', 'full']) {
    const key = `${img.id}:${size}`;
    if (objectUrls.has(key)) URL.revokeObjectURL(objectUrls.get(key));
    objectUrls.delete(key);
  }
  if (img.pending) return true; // never reached Cloudinary

  const tokens = (await Meta.get(TOKENS_KEY)) ?? {};
  const saved = tokens[img.id];
  delete tokens[img.id];
  for (const [id, t] of Object.entries(tokens)) if (t.expires < Date.now()) delete tokens[id];
  await Meta.set(TOKENS_KEY, tokens);
  if (!saved || saved.expires < Date.now() || !img.cloud) return false;
  try {
    const form = new FormData();
    form.append('token', saved.token);
    const res = await fetch(`https://api.cloudinary.com/v1_1/${img.cloud}/delete_by_token`, { method: 'POST', body: form });
    return res.ok;
  } catch {
    return false;
  }
}
