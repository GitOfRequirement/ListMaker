const $ = id => document.getElementById(id);

async function load() {
  const all = await chrome.storage.local.get(null);
  const pick = p => Object.keys(all).filter(k => k.startsWith(p)).map(k => all[k]);
  return {
    orders: pick('o:').sort((a, b) => (a.store + (a.orderDate || '')).localeCompare(b.store + (b.orderDate || ''))),
    products: pick('p:').sort((a, b) => (a.store + a.name).localeCompare(b.store + b.name)),
    batch: all.batch
  };
}

function card(title, sub) {
  const d = document.createElement('div'); d.className = 'card';
  const b = document.createElement('b'); b.textContent = title;
  const m = document.createElement('div'); m.className = 'm'; m.textContent = sub;
  d.append(b, m); return d;
}

async function render() {
  const { orders, products, batch: b } = await load();
  const by = {};
  orders.forEach(o => { const s = by[o.store] = by[o.store] || { n: 0, lines: 0, min: null, max: null }; s.n++; s.lines += o.lines.length;
    if (o.orderDate) { if (!s.min || o.orderDate < s.min) s.min = o.orderDate; if (!s.max || o.orderDate > s.max) s.max = o.orderDate; } });
  const pb = {};
  products.forEach(p => { const s = pb[p.store] = pb[p.store] || { n: 0, last: '' }; s.n++; if (p.lastSeen > s.last) s.last = p.lastSeen; });
  const cards = [
    ...Object.entries(by).map(([k, s]) => card(`${k} : ${s.n} commandes`, `${s.lines} lignes · du ${s.min || '?'} au ${s.max || '?'}`)),
    ...Object.entries(pb).map(([k, s]) => card(`${k} : ${s.n} produits avec prix`, `dernier relevé le ${s.last}`))
  ];
  $('stats').replaceChildren(...(cards.length ? cards : [Object.assign(document.createElement('p'), { className: 'm', textContent: 'Rien de capturé pour l\'instant.' })]));

  const box = $('batch'); box.replaceChildren();
  if (b && b.running) {
    const s = document.createElement('button'); s.textContent = 'Arrêter la capture en lot';
    s.onclick = async () => { await chrome.runtime.sendMessage({ type: 'batch-stop' }); render(); };
    box.append(card(`Capture en lot : ${b.done}/${b.queue.length}`, b.failed ? `${b.failed} en erreur` : 'en cours…'), s);
  } else if (b && b.failed) {
    box.append(b.kind === 'search'
      ? card('Dernier relevé des manquants', `${b.failed} produit(s) non trouvé(s) par la recherche. Ils seront réessayés dans 30 jours.`)
      : card('Dernière capture en lot', `${b.failed} commande(s) non lue(s). Ouvrez-les à la main pour réessayer.`));
  }

  // Products bought regularly that have no recent price (not in My Items / lists / deals pages visited).
  const mbox = $('missing'); mbox.replaceChildren();
  if (orders.length && !(b && b.running)) {
    const { items = [] } = await chrome.runtime.sendMessage({ type: 'missing-list', minTimes: 2 });
    if (items.length) {
      const c = card(`${items.length} produits achetés 2 fois ou plus sans prix récent`, 'Pas vus sur vos pages de produits depuis 14 jours.');
      const ul = document.createElement('ul');
      items.slice(0, 6).forEach(it => { const li = document.createElement('li'); li.textContent = `${it.store} · ${it.name} (${it.times}×)`; ul.append(li); });
      if (items.length > 6) { const li = document.createElement('li'); li.textContent = `… et ${items.length - 6} autres`; ul.append(li); }
      c.append(ul);
      const go = document.createElement('button'); go.className = 'p';
      go.textContent = `Relever les ${Math.min(items.length, 150)} produits manquants`;
      go.onclick = async () => { go.disabled = true; const r = await chrome.runtime.sendMessage({ type: 'missing-start', minTimes: 2, limit: 150 }); go.textContent = r.ok ? 'Relevé lancé dans un nouvel onglet' : 'Impossible de lancer'; };
      mbox.append(c, go);
    }
  }
}

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const stamp = () => new Date().toISOString().slice(0, 10);
const esc = v => { v = v == null ? '' : String(v); return /[",\n;]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
const csv = rows => '﻿' + rows.map(r => r.map(esc).join(',')).join('\r\n');

$('json').onclick = async () => {
  const { orders, products } = await load();
  download(`pantry-export-${stamp()}.json`, JSON.stringify({ exportedAt: new Date().toISOString(), orders, products }, null, 1), 'application/json');
};

$('csv').onclick = async () => {
  const cols = ['store', 'orderId', 'orderDate', 'deliveredDate', 'section', 'status', 'productId', 'name', 'brand', 'description', 'qty', 'weightKg', 'pricePerKg', 'paid', 'wasPrice', 'listPrice', 'url'];
  const rows = [cols];
  (await load()).orders.forEach(o => o.lines.forEach(l => rows.push(cols.map(c => c in l ? l[c] : o[c]))));
  download(`pantry-commandes-${stamp()}.csv`, csv(rows), 'text/csv');
};

$('pcsv').onclick = async () => {
  const cols = ['store', 'productId', 'name', 'brand', 'size', 'date', 'price', 'wasPrice', 'unitPrice', 'unitBase', 'unitRaw', 'deal', 'dealText', 'expiry', 'bought', 'source', 'url'];
  const rows = [cols];
  (await load()).products.forEach(p => p.obs.forEach(o => rows.push([p.store, p.productId, p.name, p.brand, p.size, o.d, o.price, o.wasPrice, o.unitPrice, o.unitBase, o.unitRaw, o.deal, o.dealText, o.expiry, p.bought || '', o.src, p.url])));
  download(`pantry-prix-${stamp()}.csv`, csv(rows), 'text/csv');
};

$('clear').onclick = async () => {
  if (!confirm('Effacer toutes les commandes et tous les prix capturés dans l\'extension ?')) return;
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(all));
  render();
};

render();
chrome.storage.onChanged.addListener(render);
