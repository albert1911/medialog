import { clearAll, counts, exportData, importData } from '../db.js';
import { downloadFile, esc, fmtDate, fmtDateTime, formatBytes, todayISO, toast } from '../util.js';
import { canInstall, checkForUpdate, getVersion, isStandalone, isUpdateReady, promptInstall } from '../pwa.js';
import * as AutoBackup from '../autobackup.js';
import * as Sync from '../sync.js';
import * as G from '../gallery.js';

async function drawVersion(box) {
  const info = await getVersion();
  const versionText = info
    ? `Version <strong>${esc(info.version)}</strong> · released ${fmtDate(info.released)}`
    : 'Version: not available yet (offline support is still being set up; reload to see it)';
  box.innerHTML = isUpdateReady()
    ? `<p>${info ? `Version <strong>${esc(info.version)}</strong> (released ${fmtDate(info.released)}) is downloaded.` : 'A new version is downloaded.'}
         Reload to start using it.</p>
       <button type="button" class="btn btn-small btn-primary" data-v="reload">Reload to update</button>`
    : `<p class="muted small">${versionText}</p>
       <button type="button" class="btn btn-small" data-v="check">Check for updates</button>`;
  box.querySelector('[data-v=reload]')?.addEventListener('click', () => location.reload());
  box.querySelector('[data-v=check]')?.addEventListener('click', async (event) => {
    const button = event.target;
    button.disabled = true;
    button.textContent = 'Checking…';
    try {
      const result = await checkForUpdate();
      if (result === 'latest') toast("You're on the latest version");
      if (result === 'downloading') toast('Downloading a new version… you can reload when it’s ready');
    } catch {
      toast('Could not check for updates. Are you offline?', 'error');
    }
    if (box.isConnected) drawVersion(box);
  });
}

const SYNC_GUIDE = 'https://github.com/albert1911/medialog#sync-between-devices';
const GALLERY_GUIDE = 'https://github.com/albert1911/medialog#gallery-images-cloudinary';

function drawGallery(box) {
  const config = G.getConfig();
  const { pending, error } = G.getProgress();

  if (!config) {
    box.innerHTML = `<p>Gallery images are stored on <strong>Cloudinary</strong> (free plan). Viewing works on every device;
        to <em>add</em> images from this device, connect your Cloudinary account here.
        <a class="nowrap" href="${GALLERY_GUIDE}" target="_blank" rel="noopener noreferrer">Setup guide ↗</a></p>
      <form id="gallery-form" class="sync-form" novalidate>
        <label class="field"><span>Cloud name</span>
          <input name="cloud" autocomplete="off" autocapitalize="off" spellcheck="false">
        </label>
        <label class="field"><span>Upload preset (unsigned)</span>
          <input name="preset" autocomplete="off" autocapitalize="off" spellcheck="false">
        </label>
        <button type="submit" class="btn btn-primary">Save</button>
      </form>`;
    box.querySelector('#gallery-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await G.setConfig(event.target.elements.cloud.value, event.target.elements.preset.value);
        toast('Gallery hosting connected', 'success');
      } catch (err) {
        toast(err.message, 'error', 6000);
      }
    });
    return;
  }

  box.innerHTML = `<p class="ok">✓ Uploading to Cloudinary cloud <strong>${esc(config.cloud)}</strong> with preset <strong>${esc(config.preset)}</strong></p>
    ${error
      ? `<p class="error-text"><strong>Upload problem:</strong> ${esc(error)}${pending ? ` (${pending} waiting)` : ''}</p>`
      : pending ? `<p>Uploading ${pending} image${pending === 1 ? '' : 's'}…</p>` : ''}
    <div class="row">
      ${error ? '<button type="button" class="btn" data-g="retry">Retry uploads</button>' : ''}
      <button type="button" class="btn btn-danger-ghost" data-g="off">Disconnect</button>
    </div>`;
  box.querySelector('[data-g=retry]')?.addEventListener('click', () => G.uploadPending());
  box.querySelector('[data-g=off]').addEventListener('click', async () => {
    if (!confirm('Disconnect Cloudinary on this device? Existing gallery images keep working.')) return;
    await G.clearConfig();
  });
}

function drawSync(box) {
  const { state, repo, last, error, pendingUploads, resumeAt } = Sync.getStatus();

  if (state === 'off') {
    box.innerHTML = `<p>Keep your library in sync across devices through a <strong>private</strong> GitHub repository.
        Set it up the same way on each device. <a class="nowrap" href="${SYNC_GUIDE}" target="_blank" rel="noopener noreferrer">Setup guide ↗</a></p>
      <form id="sync-form" class="sync-form" novalidate>
        <label class="field"><span>Private repository</span>
          <input name="repo" placeholder="your-username/medialog-data" autocomplete="off" autocapitalize="off" spellcheck="false">
        </label>
        <label class="field"><span>Access token</span>
          <input name="token" type="password" placeholder="github_pat_…" autocomplete="off" autocapitalize="off" spellcheck="false">
        </label>
        <p class="muted small">The token is stored only in this browser on this device.</p>
        <button type="submit" class="btn btn-primary">Connect &amp; sync</button>
      </form>`;
    box.querySelector('#sync-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.target;
      const button = form.querySelector('button');
      button.disabled = true;
      button.textContent = 'Connecting…';
      try {
        if (await Sync.connect(form.elements.repo.value, form.elements.token.value)) toast('Sync is on', 'success');
      } catch (err) {
        toast(err.message, 'error', 6000);
        button.disabled = false;
        button.textContent = 'Connect & sync';
      }
    });
    return;
  }

  const images = (n) => `${n} image${n === 1 ? '' : 's'}`;
  const at = resumeAt ? new Date(resumeAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
  const lines = {
    idle: `<p class="ok">✓ Syncing with <strong>${esc(repo)}</strong></p>`,
    syncing: pendingUploads
      ? `<p>Uploading images to <strong>${esc(repo)}</strong>… ${images(pendingUploads)} left.</p>`
      : `<p>Syncing with <strong>${esc(repo)}</strong>…</p>`,
    waiting: pendingUploads
      ? `<p class="ok">✓ Entries are synced.</p>
         <p><strong>${images(pendingUploads)} left to upload.</strong> GitHub limits how fast images can be added,
           so this continues automatically around ${at}. Keep the app open or open it again later.</p>`
      : `<p>GitHub asked to pause syncing for a moment. Continuing automatically around ${at}.</p>`,
    error: `<p class="error-text"><strong>Sync problem:</strong> ${esc(error)}</p>`,
  };
  box.innerHTML = `${lines[state]}
    <p class="muted small">${last ? `Last synced ${fmtDateTime(last)}` : 'Not synced yet'}.
      Changes sync a few seconds after you make them, and when you open the app.</p>
    <div class="row">
      <button type="button" class="btn" data-sync="now" ${state === 'syncing' ? 'disabled' : ''}>Sync now</button>
      <button type="button" class="btn btn-danger-ghost" data-sync="off">Disconnect</button>
    </div>`;
  box.querySelector('[data-sync="now"]').addEventListener('click', async () => {
    if (await Sync.syncNow()) toast('Synced', 'success');
    else if (Sync.getStatus().state === 'waiting') toast('Waiting for GitHub. It continues automatically.');
  });
  box.querySelector('[data-sync="off"]').addEventListener('click', async () => {
    if (!confirm('Stop syncing this device? Your data stays on this device and in the repository.')) return;
    await Sync.disconnect();
    toast('Sync disconnected');
  });
}

function drawAutoBackup(box) {
  const { supported, state, fileName, last, error } = AutoBackup.getStatus();

  if (!supported) {
    box.innerHTML = `<p class="muted">This browser can't write files automatically. Auto-backup needs Chrome or Edge on desktop;
      here, use <strong>Export JSON</strong> below now and then.</p>`;
    return;
  }

  if (state === 'off') {
    box.innerHTML = `<p>Pick a file once (for example in a synced folder such as OneDrive, Google Drive or Dropbox) and Medialog will
      rewrite it a couple of seconds after every change.</p>
      <button type="button" class="btn btn-primary" data-ab="choose">Choose backup file…</button>`;
  } else {
    const lastText = last ? `Last saved ${fmtDateTime(last.at)} (${formatBytes(last.bytes)})` : 'Not saved yet';
    const notes = {
      active: `<p class="ok">✓ On. Writing to <strong>${esc(fileName)}</strong></p>`,
      paused: `<p><strong>Paused.</strong> The browser needs your permission again to write to <strong>${esc(fileName)}</strong>.</p>`,
      error: `<p class="error-text"><strong>Last backup failed:</strong> ${esc(error)}</p>`,
    };
    box.innerHTML = `${notes[state]}
      <p class="muted small">${lastText}. Changes are only written while this app is open.</p>
      <div class="row">
        ${state === 'paused' ? '<button type="button" class="btn" data-ab="resume">Resume backup</button>' : '<button type="button" class="btn" data-ab="now">Back up now</button>'}
        <button type="button" class="btn btn-ghost" data-ab="choose">Change file…</button>
        <button type="button" class="btn btn-danger-ghost" data-ab="off">Turn off</button>
      </div>`;
  }

  box.querySelectorAll('[data-ab]').forEach((button) =>
    button.addEventListener('click', async () => {
      try {
        const action = button.dataset.ab;
        if (action === 'choose' && (await AutoBackup.chooseFile())) toast('Auto-backup is on', 'success');
        if (action === 'resume' && (await AutoBackup.resume())) toast('Auto-backup resumed', 'success');
        if (action === 'now' && (await AutoBackup.backupNow(true))) toast('Backup saved', 'success');
        if (action === 'off') {
          await AutoBackup.turnOff();
          toast('Auto-backup turned off (the file was kept)');
        }
      } catch (err) {
        toast(err.message, 'error');
      }
    }),
  );
}

export async function renderSettings(view) {
  const { entries, sources } = await counts();
  const estimate = await navigator.storage?.estimate?.().catch(() => null);
  const persisted = await navigator.storage?.persisted?.().catch(() => false);

  view.innerHTML = `
    <div class="page-head"><h1>Settings</h1></div>
    <div class="settings">
      <section class="panel">
        <h2>App</h2>
        ${isStandalone()
          ? '<p>Running as an installed app.</p>'
          : canInstall()
            ? '<p>Install Medialog for quick, offline access from your desktop or home screen.</p><button type="button" class="btn btn-primary" id="install">Install app</button>'
            : '<p class="muted">To install, use your browser menu (“Install app” / “Add to Home Screen”). Everything works offline after the first visit.</p>'}
        <div class="app-version" id="app-version"></div>
      </section>

      <section class="panel">
        <h2>Storage</h2>
        <p><strong>${entries}</strong> entries · <strong>${sources}</strong> sources${estimate ? ` · about ${formatBytes(estimate.usage)} used` : ''}</p>
        <p class="muted">Data lives only in this browser's IndexedDB on this device. Clearing site data removes it, so export backups regularly.</p>
        ${navigator.storage?.persist
          ? persisted
            ? '<p class="ok">✓ Persistent storage is on — the browser won\'t evict your data automatically.</p>'
            : '<button type="button" class="btn" id="persist">Ask browser to keep data permanently</button>'
          : ''}
      </section>

      <section class="panel">
        <h2>Sync</h2>
        <div id="sync"></div>
      </section>

      <section class="panel">
        <h2>Gallery</h2>
        <div id="gallery-settings"></div>
      </section>

      <section class="panel">
        <h2>Auto-backup</h2>
        <div id="auto-backup"></div>
      </section>

      <section class="panel">
        <h2>Backup</h2>
        <p>Export everything to a JSON file, or restore from one.</p>
        <div class="row">
          <button type="button" class="btn btn-primary" id="export">Export JSON</button>
        </div>
        <form id="import-form" class="import">
          <label class="field"><span>Backup file</span><input type="file" name="file" accept="application/json,.json" required></label>
          <fieldset class="radio-group">
            <legend class="small muted">Import mode</legend>
            <label><input type="radio" name="mode" value="merge" checked> Merge — add new items, update older copies</label>
            <label><input type="radio" name="mode" value="replace"> Replace — the backup becomes your whole library</label>
          </fieldset>
          <button type="submit" class="btn">Import</button>
        </form>
      </section>

      <section class="panel danger">
        <h2>Danger zone</h2>
        <p>Delete every entry and source on this device.</p>
        <button type="button" class="btn btn-danger" id="wipe">Delete all data</button>
      </section>
    </div>`;

  const $ = (selector) => view.querySelector(selector);
  const rerender = () => renderSettings(view);

  const autoBox = $('#auto-backup');
  drawAutoBackup(autoBox);
  const onStatus = () => (autoBox.isConnected ? drawAutoBackup(autoBox) : AutoBackup.status.removeEventListener('change', onStatus));
  AutoBackup.status.addEventListener('change', onStatus);

  const syncBox = $('#sync');
  drawSync(syncBox);
  const onSync = () => (syncBox.isConnected ? drawSync(syncBox) : Sync.status.removeEventListener('change', onSync));
  Sync.status.addEventListener('change', onSync);

  const galleryBox = $('#gallery-settings');
  drawGallery(galleryBox);
  const onGallery = () => (galleryBox.isConnected ? drawGallery(galleryBox) : G.status.removeEventListener('change', onGallery));
  G.status.addEventListener('change', onGallery);

  const versionBox = $('#app-version');
  drawVersion(versionBox);
  const onUpdateReady = () => (versionBox.isConnected ? drawVersion(versionBox) : document.removeEventListener('medialog:update-ready', onUpdateReady));
  document.addEventListener('medialog:update-ready', onUpdateReady);

  $('#install')?.addEventListener('click', async () => {
    await promptInstall();
    rerender();
  });

  $('#persist')?.addEventListener('click', async () => {
    const granted = await navigator.storage.persist();
    toast(granted ? 'Persistent storage enabled' : 'The browser declined (it may grant it after you install the app)', granted ? 'success' : 'info', 4500);
    rerender();
  });

  $('#export').addEventListener('click', async () => {
    const data = await exportData();
    downloadFile(`medialog-backup-${todayISO()}.json`, JSON.stringify(data, null, 2));
    toast('Backup downloaded', 'success');
  });

  $('#import-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const file = form.elements.file.files[0];
    const mode = form.elements.mode.value;
    if (!file) return toast('Choose a backup file first.', 'error');
    if (mode === 'replace' && !confirm('Replace ALL current data with this backup?')) return;
    try {
      const result = await importData(JSON.parse(await file.text()), mode);
      toast(`Imported ${result.entries} entries and ${result.sources} sources`, 'success');
      rerender();
    } catch (err) {
      toast(err instanceof SyntaxError ? 'That file is not valid JSON.' : err.message, 'error', 6000);
    }
  });

  $('#wipe').addEventListener('click', async () => {
    if (!confirm(`Delete all ${entries} entries and ${sources} sources? This can't be undone.

(If sync is on, they're deleted on your other devices too. An auto-backup file, if set up, keeps your last non-empty data.)`)) return;
    await clearAll();
    toast('All data deleted');
    rerender();
  });
}
