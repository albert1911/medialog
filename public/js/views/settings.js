import { clearAll, counts, exportData, importData } from '../db.js';
import { downloadFile, esc, fmtDateTime, formatBytes, todayISO, toast } from '../util.js';
import { canInstall, isStandalone, promptInstall } from '../pwa.js';
import * as AutoBackup from '../autobackup.js';

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
        ${state === 'paused' ? '<button type="button" class="btn btn-primary" data-ab="resume">Resume backup</button>' : '<button type="button" class="btn" data-ab="now">Back up now</button>'}
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
            <label><input type="radio" name="mode" value="merge" checked> Merge — add to existing data</label>
            <label><input type="radio" name="mode" value="replace"> Replace — delete current data first</label>
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

(An auto-backup file, if set up, keeps your last non-empty data.)`)) return;
    await clearAll();
    toast('All data deleted');
    rerender();
  });
}
