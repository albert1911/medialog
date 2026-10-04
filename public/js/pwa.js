import { toast } from './util.js';

let deferredPrompt = null;

const sync = () => document.body.classList.toggle('can-install', !!deferredPrompt);

export function initPWA() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Service worker registration failed', err));
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
