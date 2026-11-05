// Pantry capture – background worker.
// Keeps the batch queue in storage (Chrome may stop this worker at any time);
// the batch tab itself drives the navigation, so nothing is lost if the worker sleeps.
importScripts('parsers.js');
const P = globalThis.PantryParsers;
const get = k => chrome.storage.local.get(k).then(o => o[k]);
const set = (k, v) => chrome.storage.local.set({ [k]: v });
const day = (offset = 0) => { const d = new Date(Date.now() + offset * 864e5); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  handle(msg, sender).then(reply, e => reply({ error: String(e) }));
  return true; // async reply
});

// Products bought at least `minTimes` times (in different orders) that have no price seen in the last `maxAge` days
// and were not already searched recently.
async function missing(minTimes = 2, maxAge = 14) {
  const all = await chrome.storage.local.get(null);
  const fresh = day(-maxAge), seen = new Set(), counts = new Map();
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith('p:') && v.lastSeen >= fresh) [v.productId, ...(v.altIds || [])].forEach(id => seen.add(v.store + ':' + id));
    if (k.startsWith('m:') && v.d >= day(v.found ? -maxAge : -30)) seen.add(k.slice(2));
  }
  for (const [k, o] of Object.entries(all)) {
    if (!k.startsWith('o:')) continue;
    for (const l of o.lines) {
      if (!l.productId || l.section === 'fee' || l.section === 'unavailable') continue;
      const key = o.store + ':' + l.productId;
      const c = counts.get(key) || { store: o.store, productId: l.productId, name: l.name, brand: l.brand || '', orders: new Set(), last: '' };
      c.orders.add(o.orderId); if ((o.orderDate || '') > c.last) { c.last = o.orderDate || ''; c.name = l.name; }
      counts.set(key, c);
    }
  }
  return [...counts.entries()].filter(([k, c]) => c.orders.size >= minTimes && !seen.has(k))
    .map(([, c]) => ({ store: c.store, productId: c.productId, name: c.name, brand: c.brand, times: c.orders.size, last: c.last }))
    .sort((a, b) => b.times - a.times);
}

async function startBatch(queue, label, kind, index) {
  if (!queue.length) return { ok: false };
  const tab = await chrome.tabs.create({ url: queue[0].url, active: false, index });
  await set('batch', { running: true, kind, label, tabId: tab.id, queue, i: 0, done: 0, failed: 0, errors: [], startedAt: new Date().toISOString() });
  return { ok: true, count: queue.length };
}

async function handle(msg, sender) {
  const b = (await get('batch')) || null;
  const tabId = sender.tab && sender.tab.id;
  const inBatch = b && b.running && b.tabId === tabId;

  switch (msg.type) {
    case 'hello': {
      if (!inBatch) return { batch: false };
      const cur = b.queue[b.i] || {};
      return { batch: true, kind: cur.kind || 'order', item: cur, hint: { date: cur.date || null } };
    }
    case 'captured': {
      if (!inBatch) return {};
      const cur = b.queue[b.i] || {};
      if (cur.kind === 'search') await set('m:' + cur.store + ':' + cur.productId, { d: day(), found: !!msg.ok, name: cur.name, foundName: msg.foundName || '' });
      b.done++; if (!msg.ok) { b.failed++; b.errors.push({ url: msg.url, error: msg.error || 'non trouvé', name: cur.name || '' }); }
      b.i++;
      if (b.i >= b.queue.length) {
        b.running = false; await set('batch', b);
        setTimeout(() => chrome.tabs.remove(tabId).catch(() => {}), 8000);
        return { finished: true, done: b.done, failed: b.failed, label: b.label, kind: b.kind };
      }
      await set('batch', b);
      return { next: b.queue[b.i].url, done: b.done, total: b.queue.length, label: b.label };
    }
    case 'batch-start': {
      const queue = (msg.orders || []).map(o => ({ kind: 'order', id: o.id, url: o.url, date: o.date || null }));
      return startBatch(queue, 'Capture des commandes', 'order', sender.tab ? sender.tab.index + 1 : undefined);
    }
    case 'missing-list':
      return { items: await missing(msg.minTimes || 2) };
    case 'missing-start': {
      const items = (await missing(msg.minTimes || 2)).slice(0, msg.limit || 150);
      const queue = items.map(it => ({ kind: 'search', store: it.store, productId: it.productId, name: it.name, url: (it.store === 'Maxi' ? P.maxi : P.walmart).searchUrl(it) }));
      return startBatch(queue, 'Relevé des produits manquants', 'search');
    }
    case 'batch-stop': {
      if (b) { b.running = false; await set('batch', b); }
      return { ok: true };
    }
    case 'batch-status':
      return b ? { running: b.running, done: b.done, total: b.queue.length, failed: b.failed } : { running: false };
  }
  return {};
}

// If the batch tab is closed by hand, stop the batch.
chrome.tabs.onRemoved.addListener(async id => {
  const b = await get('batch');
  if (b && b.running && b.tabId === id) { b.running = false; await set('batch', b); }
});
