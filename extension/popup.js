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
  } else if (b && b.kind === 'search' && b.done) {
    const L = b.lists || {};
    const parts = [`${b.done - b.failed} trouvés`, `${b.failed} non trouvés (réessayés dans 30 jours)`];
    if (L.added || L.already) parts.push(`${L.added || 0} ajoutés à la liste, ${L.already || 0} y étaient déjà`);
    const bad = Object.entries(L).filter(([k]) => !['added', 'already'].includes(k)).map(([k, v]) => `${v} × ${k}`);
    if (bad.length) parts.push('problèmes d\'ajout : ' + bad.join(', '));
    box.append(card('Dernier relevé des manquants', parts.join(' · ')));
  } else if (b && b.failed) {
    box.append(card('Dernière capture en lot', `${b.failed} commande(s) non lue(s). Ouvrez-les à la main pour réessayer.`));
  }

  // Products bought regularly that have no recent price (not in My Items / lists / deals pages visited).
  const mbox = $('missing'); mbox.replaceChildren();
  if (!orders.length || (b && b.running)) return;
  const st = (await chrome.storage.local.get('settings')).settings || { months: 12, addToList: true, listName: 'ListMaker' };
  const save = () => chrome.storage.local.set({ settings: st });
  const opts = store => ({ minTimes: 2, months: st.months, store });

  const head = card('Produits manquants', 'Achetés 2 fois ou plus, sans prix vu depuis 14 jours.');
  const row = (label, el) => { const d = document.createElement('label'); d.className = 'm'; d.style.display = 'block'; d.style.marginTop = '4px'; d.append(label, el); return d; };
  const months = document.createElement('select');
  [[6, '6 derniers mois'], [12, '12 derniers mois'], [24, '24 derniers mois'], [999, 'tout l\'historique']].forEach(([v, t]) => months.append(new Option(t, v, false, +st.months === v)));
  months.onchange = () => { st.months = +months.value; save(); };
  const add = document.createElement('input'); add.type = 'checkbox'; add.checked = !!st.addToList;
  add.onchange = () => { st.addToList = add.checked; save(); };
  const ln = document.createElement('input'); ln.type = 'text'; ln.value = st.listName || 'ListMaker'; ln.style.width = '110px';
  ln.onchange = () => { st.listName = ln.value.trim() || 'ListMaker'; save(); };
  head.append(row('Achetés dans les : ', months), row(add, ' ajouter les produits trouvés à une liste'), row('Liste Maxi : ', ln),
    Object.assign(document.createElement('div'), { className: 'm', textContent: 'Walmart : liste Favourites (cœur). Ajout seulement, jamais de retrait ni de panier.' }));
  mbox.append(head);

  // "Compléter la liste": every product bought regularly that is not known to be in the list, whatever was searched before.
  const fill = card('Compléter les listes', 'Produits achetés 2 fois ou plus (période ci-dessus) qui ne sont pas encore dans la liste. Lisez d\'abord la liste (My Items / ListMaker) avec « Tout lire ».');
  mbox.append(fill);
  for (const store of ['Walmart', 'Maxi']) {
    const listName = store === 'Maxi' ? (st.listName || 'ListMaker') : 'Favourites';
    const o = { store, listName, minTimes: 2, months: st.months };
    const { items = [] } = await chrome.runtime.sendMessage({ type: 'fill-list-count', opts: o });
    const go = document.createElement('button');
    go.textContent = store === 'Walmart'
      ? (items.length ? `Walmart : ${items.length} produits absents de My Items → les ajouter aux Favourites` : 'Walmart : tout est dans My Items ou Favourites')
      : (items.length ? `Maxi : ajouter ${items.length} produits à « ${listName} »` : `Maxi : « ${listName} » est complète`);
    go.disabled = !items.length;
    go.onclick = async () => {
      if (!confirm(`Rechercher ${items.length} produits sur ${store} et ajouter à « ${listName} » ceux retrouvés (code produit identique) ?\n\nUn produit déjà dans la liste est laissé tel quel. Rien n'est retiré, rien n'est mis au panier.`)) return;
      go.disabled = true;
      const r = await chrome.runtime.sendMessage({ type: 'fill-list-start', opts: o });
      go.textContent = r.ok ? 'Lancé dans un nouvel onglet' : 'Impossible de lancer';
    };
    mbox.append(go);
  }

  for (const store of ['Walmart', 'Maxi']) {
    const { items = [] } = await chrome.runtime.sendMessage({ type: 'missing-list', opts: opts(store) });
    if (!items.length) continue;
    const c = card(`${store} : ${items.length} produits manquants`, `les plus achetés d'abord`);
    const ul = document.createElement('ul');
    items.slice(0, 5).forEach(it => { const li = document.createElement('li'); li.textContent = `${it.name} (${it.times}×, dernier ${it.last})`; ul.append(li); });
    if (items.length > 5) { const li = document.createElement('li'); li.textContent = `… et ${items.length - 5} autres`; ul.append(li); }
    c.append(ul);
    const go = document.createElement('button'); go.className = 'p';
    go.textContent = `Relever les ${items.length} produits ${store}` + (st.addToList ? ' et les ajouter à la liste' : '');
    go.onclick = async () => {
      if (st.addToList && !confirm(`Rechercher ${items.length} produits sur ${store} et ajouter ceux retrouvés (code produit identique) à la liste « ${store === 'Maxi' ? st.listName : 'Favourites'} » ?\n\nAjout seulement : rien n'est retiré, rien n'est mis au panier.`)) return;
      go.disabled = true;
      const r = await chrome.runtime.sendMessage({ type: 'missing-start', opts: opts(store), addToList: st.addToList, listName: st.listName, limit: 300 });
      go.textContent = r.ok ? 'Relevé lancé dans un nouvel onglet' : 'Impossible de lancer';
    };
    mbox.append(c, go);
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
