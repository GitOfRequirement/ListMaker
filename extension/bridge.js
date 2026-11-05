// Pantry capture – bridge with the Pantry app (https://gitofrequirement.github.io/ListMaker/).
// Runs only on the app's own address (see manifest.json). The app asks for the captured data with
// window.postMessage; this script answers with the same content as "Tout exporter (JSON)".
// It only answers messages coming from the app page itself, and never changes anything.
(function () {
  'use strict';
  const HELLO = { source: 'pantry-extension', type: 'hello', version: chrome.runtime.getManifest().version };
  const announce = () => window.postMessage(HELLO, location.origin);

  window.addEventListener('message', async e => {
    if (e.source !== window || e.origin !== location.origin) return;
    const m = e.data || {};
    if (m.source !== 'pantry-app') return;
    if (m.type === 'ping') { announce(); return; }
    if (m.type === 'export-request') {
      try {
        const all = await chrome.storage.local.get(null);
        const pick = p => Object.keys(all).filter(k => k.startsWith(p)).map(k => all[k]);
        window.postMessage({ source: 'pantry-extension', type: 'export', id: m.id,
          data: { exportedAt: new Date().toISOString(), orders: pick('o:'), products: pick('p:') } }, location.origin);
      } catch (err) {
        window.postMessage({ source: 'pantry-extension', type: 'export', id: m.id, error: String(err && err.message || err) }, location.origin);
      }
    }
  });
  announce();
})();
