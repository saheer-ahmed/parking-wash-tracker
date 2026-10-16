// Minimal service worker so the app can be installed on a phone's home screen.
// It doesn't cache anything, so staff always see the latest version and live data.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
