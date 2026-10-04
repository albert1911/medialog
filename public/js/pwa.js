import { toast } from './util.js';

let deferredPrompt = null;
let updateReady = false;
let lastUpdateCheck = Date.now();
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

const sync = () => document.body.classList.toggle('can-install', !!deferredPrompt);

export function initPWA() {
  if ('serviceWorker' in navigator) {
    // A page that was already controlled before means any later takeover is an update
    // (on the very first visit, the first takeover is just the initial install).
    const hadController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !updateReady) {
        updateReady = true;
        showUpdateBar();
      }
    });

    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Service worker registration failed', err));
    });

    // Installed apps can stay open for days: look for a new version when coming back to it.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && Date.now() - lastUpdateCheck > UPDATE_CHECK_INTERVAL_MS) {
        checkForUpdate().catch(() => {});
      }
    });
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    sync();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    sync();
    toast('Medialog installed', 'success');
  });
}

export const canInstall = () => !!deferredPrompt;

export const isStandalone = () =>
  matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

export async function promptInstall() {
  if (!deferredPrompt) return false;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  deferredPrompt = null;
  sync();
  return outcome === 'accepted';
}

// ---------------------------------------------------------------- version & updates

export const isUpdateReady = () => updateReady;

// { version, released } of the installed offline copy, or null if it isn't active (yet).
export function getVersion() {
  const worker = navigator.serviceWorker?.controller;
  if (!worker) return Promise.resolve(null);
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 1500);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      resolve(event.data);
    };
    worker.postMessage({ type: 'version' }, [channel.port2]);
  });
}

// Asks the server for a newer version. Returns "ready" (already downloaded, reload to use),
// "downloading" (a new version was found; the update bar appears when it's ready),
// or "latest".
export async function checkForUpdate() {
  lastUpdateCheck = Date.now();
  if (updateReady) return 'ready';
  const registration = await navigator.serviceWorker?.getRegistration();
  if (!registration) return 'latest';
  await registration.update();
  return registration.installing || registration.waiting ? 'downloading' : 'latest';
}

function showUpdateBar() {
  if (document.querySelector('.update-bar')) return;
  const bar = document.createElement('div');
  bar.className = 'update-bar';
  bar.setAttribute('role', 'status');
  bar.innerHTML = `<span>A new version of Medialog is ready.</span>
    <div class="update-actions">
      <button type="button" class="btn btn-small btn-primary" data-u="reload">Reload</button>
      <button type="button" class="btn btn-small btn-secondary" data-u="later" aria-label="Dismiss">Later</button>
    </div>`;
  bar.querySelector('[data-u=reload]').addEventListener('click', () => location.reload());
  bar.querySelector('[data-u=later]').addEventListener('click', () => bar.remove());
  document.body.append(bar);
  document.dispatchEvent(new Event('medialog:update-ready'));
}
