// Pantry capture – runs on walmart.ca and maxi.ca pages.
// Order page    -> waits for the items to load, reads them, saves the order.
// History page  -> offers to capture every order listed, one after the other.
// Product pages -> (My Items, deals, flyer, lists, search…) quietly records the prices shown.
(function () {
  'use strict';
  const P = globalThis.PantryParsers;
  const site = P.forUrl(location.href);
  if (!site) return;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const send = msg => new Promise(r => { try { chrome.runtime.sendMessage(msg, x => { void chrome.runtime.lastError; r(x || {}); }); } catch (e) { r({}); } });

  // ---------- small floating panel (shadow DOM so the site's CSS can't touch it) ----------
  let host, msgEl, btnRow, closed = false;
  function say(m, buttons) {
    if (closed) return;
    if (!host || !host.isConnected) {
      host = document.createElement('div');
      host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647';
      const sh = host.attachShadow({ mode: 'open' });
      sh.innerHTML = `<style>
        .b{font:14px/1.4 system-ui,sans-serif;background:#fff;color:#1c1d1a;border:2px solid #2d6a4f;border-radius:12px;padding:10px 12px;max-width:330px;box-shadow:0 4px 18px rgba(0,0,0,.18)}
        .t{font-weight:700;color:#2d6a4f;margin-bottom:4px}.r{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}.r:empty{display:none}
        button{font:inherit;border:1px solid #2d6a4f;border-radius:8px;padding:6px 10px;background:#fff;color:#2d6a4f;cursor:pointer}
        button.p{background:#2d6a4f;color:#fff}.x{float:right;border:0;padding:0 4px;color:#666}</style>
        <div class="b"><button class="x" title="Fermer">×</button><div class="t">Pantry</div><div class="m"></div><div class="r"></div></div>`;
      sh.querySelector('.x').onclick = () => { closed = true; host.remove(); };
      msgEl = sh.querySelector('.m'); btnRow = sh.querySelector('.r');
      document.documentElement.appendChild(host);
    }
    msgEl.textContent = m; btnRow.replaceChildren();
    (buttons || []).forEach(([label, fn, primary]) => {
      const b = document.createElement('button'); b.textContent = label; if (primary) b.className = 'p'; b.onclick = fn; btnRow.append(b);
    });
  }

  // ---------- order page ----------
  async function waitForItems(maxMs) {
    const t0 = Date.now(); let last = -1, stable = 0;
    while (Date.now() - t0 < maxMs) {
      // Expand collapsed sections ("Show items") so every line is in the page.
      document.querySelectorAll('[data-automation-id="items-toggle-link"][aria-expanded="false"]').forEach(b => { try { b.click(); } catch (e) {} });
      const n = site.itemCount(document);
      if (n > 0 && n === last) { if (++stable >= 3) return n; } else stable = 0;
      last = n; await sleep(600);
    }
    return site.itemCount(document);
  }

  // After a batch page is done: tell the background, then go to the next page of the batch.
  async function batchNext(ok, info) {
    const r = await send({ type: 'captured', ok, ...info, url: location.href });
    if (r.next) {
      say((ok ? '✓ ' : '⚠ ') + `${r.label || 'Capture en lot'} : ${r.done}/${r.total}. Suivant dans quelques secondes…`,
        [['Arrêter', async () => { await send({ type: 'batch-stop' }); say('Capture en lot arrêtée.'); }]]);
      await sleep(3000 + Math.random() * 3000);
      const st = await send({ type: 'batch-status' });
      if (st.running) location.href = r.next;
    } else if (r.finished) {
      say(`✓ ${r.label || 'Capture en lot'} : terminé. ${r.done} pages lues${r.failed ? ', ' + r.failed + (r.kind === 'search' ? ' produits non trouvés' : ' en erreur') : ''}. Exportez depuis l'icône Pantry.`);
    }
  }

  async function captureOrder(hello) {
    say('Lecture de la commande…');
    const n = await waitForItems(hello.batch ? 25000 : 40000);
    let order = null, error = null;
    if (n) {
      try {
        order = site.parse(document, location.href, hello.hint);
        order.capturedAt = new Date().toISOString();
        if (!order.orderId) throw new Error('numéro de commande introuvable');
        await chrome.storage.local.set({ ['o:' + order.store + ':' + order.orderId]: order });
      } catch (e) { error = e.message || String(e); order = null; }
    } else error = 'aucun article trouvé sur la page';

    if (order) say(`✓ Commande ${order.store} du ${order.orderDate || '?'} enregistrée : ${order.lines.filter(l => l.section !== 'fee').length} lignes.`);
    else say('⚠ Commande non lue : ' + error + '.');

    if (hello.batch) await batchNext(!!order, { id: order && order.orderId, error });
  }

  // ---------- search batch: look for one product that has no recent price ----------
  async function captureSearch(hello) {
    const target = hello.item || {};
    say(`Recherche du produit : ${target.name || target.productId}…`);
    const t0 = Date.now(); let last = -1, stable = 0;
    while (Date.now() - t0 < 15000) {
      const n = site.products(document).length;
      if (n > 0 && n === last) { if (++stable >= 3) break; } else stable = 0;
      last = n; await sleep(600);
    }
    for (let i = 0; i < 3; i++) { window.scrollBy(0, innerHeight); await sleep(700); }
    await scanProducts();
    const hit = site.products(document).find(p => p.productId === target.productId || p.altIds.includes(target.productId));
    say(hit ? `✓ Trouvé : ${hit.name} à ${hit.price} $.` : '⚠ Produit pas dans les résultats (peut-être plus vendu, ou nom différent).');
    await batchNext(!!hit, { productId: target.productId, store: target.store, foundName: hit ? hit.name : '' });
  }

  // ---------- history page ----------
  async function offerBatch() {
    const orders = site.listOrders(document);
    if (!orders.length) return false;
    const have = await chrome.storage.local.get(null);
    const todo = orders.filter(o => !have['o:' + site.store + ':' + o.id]);
    const paged = !!site.nextPageButton(document);
    const buttons = [];
    if (paged) buttons.push(['Parcourir toutes les pages et capturer', () => walkPages(have), true]);
    buttons.push([`Capturer les ${todo.length} nouvelles de cette page`, () => start(todo), !paged]);
    buttons.push(['Actualiser', () => offerBatch()]);
    say(`${orders.length} commandes visibles sur cette page, dont ${todo.length} pas encore capturées.` +
      (paged ? ' L\'historique a plusieurs pages : je peux les parcourir pour vous.' : ' Faites défiler ou cliquez « voir plus » si des commandes manquent.'), buttons);
    return true;
  }

  // Walmart: click "Next page" until the end, collecting order numbers, then capture the new ones.
  let walking = false;
  async function walkPages(have) {
    if (walking) return; walking = true;
    try { await walkPagesInner(have); } finally { walking = false; lastUrl = location.href; }
  }
  async function walkPagesInner(have) {
    const all = new Map();
    for (let page = 1; page <= 60; page++) {
      site.listOrders(document).forEach(o => all.set(o.id, o));
      say(`Lecture de l'historique : page ${page}, ${all.size} commandes trouvées…`);
      const next = site.nextPageButton(document);
      if (!next) break;
      const before = site.listOrders(document).map(o => o.id).join();
      next.click();
      let changed = false;
      for (let i = 0; i < 25 && !changed; i++) { await sleep(400); changed = site.listOrders(document).map(o => o.id).join() !== before; }
      if (!changed) break;
      await sleep(800 + Math.random() * 700);
    }
    const todo = [...all.values()].filter(o => !have['o:' + site.store + ':' + o.id]);
    say(`${all.size} commandes dans l'historique, dont ${todo.length} pas encore capturées.`,
      [[`Capturer les ${todo.length} nouvelles`, () => start(todo), true]]);
  }

  async function start(list) {
    if (!list.length) { say('Rien de nouveau à capturer.'); return; }
    const r = await send({ type: 'batch-start', orders: list });
    say(r.ok ? `Capture en lot lancée dans un nouvel onglet (${list.length} commandes). Laissez-le travailler.` : 'Impossible de lancer la capture.');
  }

  // ---------- product pages: record prices as they appear (lazy loading, "load more", next pages) ----------
  const sig = new Map(); let pageCount = 0;
  async function scanProducts() {
    const found = site.products(document).filter(p => p.productId && p.price != null);
    const fresh = found.filter(p => { const s = [p.price, p.wasPrice, p.unitPrice, p.deal].join('|'); if (sig.get(p.productId) === s) return false; sig.set(p.productId, s); return true; });
    if (!fresh.length) return;
    const keys = fresh.map(p => 'p:' + site.store + ':' + p.productId);
    const old = await chrome.storage.local.get(keys);
    const d = today(), src = clean(document.title).slice(0, 80) || location.pathname, upd = {};
    fresh.forEach((p, i) => {
      const k = keys[i];
      const rec = old[k] || { store: site.store, productId: p.productId, altIds: [], firstSeen: d, obs: [] };
      rec.name = p.name || rec.name; rec.brand = p.brand || rec.brand || ''; rec.size = p.size || rec.size || '';
      rec.url = p.url || rec.url; rec.lastSeen = d; if (p.bought) rec.bought = p.bought;
      rec.altIds = [...new Set([...(rec.altIds || []), ...p.altIds])];
      const ob = { d, price: p.price, wasPrice: p.wasPrice, unitPrice: p.unitPrice, unitBase: p.unitBase, unitRaw: p.unitRaw, deal: p.deal, dealText: p.dealText, expiry: p.expiry, src };
      const same = rec.obs.findIndex(o => o.d === d);
      if (same >= 0) rec.obs[same] = ob; else rec.obs.push(ob);
      upd[k] = rec;
    });
    await chrome.storage.local.set(upd);
    pageCount = sig.size;
    if (!reading && !inSearchBatch) say(`${pageCount} prix lus sur cette page. Défilez vous-même, ou laissez-moi tout lire.`,
      [['Tout lire (défilement et pages)', () => readAll(), true]]);
  }
  function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

  // ---------- "Tout lire": scroll to the bottom, click "load more" / "next page" until the end ----------
  const AR = 'pantryAutoRead';
  let reading = false, stopRead = false, inSearchBatch = false;
  const ids = () => site.products(document).map(p => p.productId).join();
  function loadMoreButton() {
    return [...document.querySelectorAll('button')].find(b => b.offsetParent !== null && !b.disabled &&
      /^(load|show|see|view)\s+more(\s+(items|products|results))?$|^(voir|afficher|charger)\s+plus/i.test(clean(b.textContent)));
  }
  async function readAll() {
    if (reading) return; reading = true; stopRead = false;
    try { sessionStorage.setItem(AR, String(Date.now() + 15 * 60e3)); } catch (e) {}
    const stopBtn = [['Arrêter', () => { stopRead = true; }]];
    let pages = 1;
    try {
      for (let round = 0; round < 300 && !stopRead; round++) {
        const before = site.products(document).length;
        say(`Lecture automatique : défilement de la page ${pages}…`, stopBtn);
        for (let i = 0; i < 120 && !stopRead; i++) {
          window.scrollBy(0, innerHeight); await sleep(300);
          if (innerHeight + scrollY >= document.documentElement.scrollHeight - 5) break;
        }
        await sleep(1500); await scanProducts();
        say(`Lecture automatique : ${sig.size} prix lus, page ${pages}…`, stopBtn);
        if (site.products(document).length > before) continue;        // infinite scroll loaded more
        const more = loadMoreButton();
        if (more) { more.click(); await sleep(2500); continue; }
        const next = site.nextProductPage(document);
        if (!next) break;
        const prev = ids(); next.click(); pages++;
        let changed = false;                                            // same-page navigation (single-page app)
        for (let i = 0; i < 30 && !changed && !stopRead; i++) { await sleep(500); changed = ids() !== prev && site.products(document).length > 0; }
        if (!changed) break;                                            // a full page load continues via sessionStorage
        window.scrollTo(0, 0); await sleep(800);
      }
    } finally {
      reading = false; lastUrl = location.href;
      try { sessionStorage.removeItem(AR); } catch (e) {}
    }
    say(`✓ Lecture terminée : ${sig.size} prix lus${pages > 1 ? ' sur ' + pages + ' pages' : ''}.`, [['Relire', () => readAll()]]);
  }
  const autoReadPending = () => { try { return +sessionStorage.getItem(AR) > Date.now(); } catch (e) { return false; } };

  // ---------- routing (sites are single-page apps: watch for URL changes) ----------
  let lastUrl = '', productTimer = null;
  async function route() {
    if (walking || reading || location.href === lastUrl) return;
    lastUrl = location.href;
    clearInterval(productTimer); sig.clear();
    const hello = await send({ type: 'hello', url: location.href });
    if (hello.batch && hello.kind === 'search') { inSearchBatch = true; captureSearch(hello); return; }
    if (site.isOrderPage(location.href)) { captureOrder(hello); return; }
    // History pages render their list late: try a few times.
    for (let i = 0; i < 6 && location.href === lastUrl; i++) { if (await offerBatch()) return; await sleep(1500); }
    if (location.href !== lastUrl) return;
    scanProducts(); productTimer = setInterval(scanProducts, 2500);
    if (autoReadPending()) readAll();
  }
  route();
  setInterval(route, 1500);
})();
