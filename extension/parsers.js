// Pantry capture – page parsers for Walmart.ca and Maxi.ca order pages.
// Pure functions: they take a Document and return plain data, so they can be tested on saved pages.
(function (root) {
  'use strict';

  const MONTHS = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,sept:8,oct:9,nov:10,dec:11};
  const MONTH_RE = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';

  const clean = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const text = el => clean(el && el.textContent);

  // "$1,234.56", "4,47 $", "-$5.00" -> number
  function money(s) {
    s = String(s || '');
    let m = s.match(/-?\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/);
    if (m) return parseFloat(m[1].replace(/,/g, ''));
    m = s.match(/(\d+(?:[.,]\d{1,2})?)\s*\$/);
    return m ? parseFloat(m[1].replace(',', '.')) : null;
  }

  const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

  function monthIndex(name) { return MONTHS[String(name).slice(0, 4).toLowerCase()] ?? MONTHS[String(name).slice(0, 3).toLowerCase()]; }

  // "Oct 22, 2026" / "October 24, 2026" -> "2026-10-22"
  function parseFullDate(s) {
    const m = String(s || '').match(new RegExp(MONTH_RE + '\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})', 'i'));
    if (!m) return null;
    return iso(new Date(+m[3], monthIndex(m[1]), +m[2]));
  }

  // "October 24" without a year: take the most recent such date not later than `ref` (+3 days slack).
  function parseMonthDay(s, ref) {
    const m = String(s || '').match(new RegExp(MONTH_RE + '\\.?\\s+(\\d{1,2})\\b', 'i'));
    if (!m) return null;
    const r = ref ? new Date(ref + 'T12:00:00') : new Date();
    let d = new Date(r.getFullYear(), monthIndex(m[1]), +m[2]);
    if (d - r > 3 * 864e5) d = new Date(r.getFullYear() - 1, monthIndex(m[1]), +m[2]);
    return iso(d);
  }

  function lastMatch(str, re) { let m, out = null; re = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'); while ((m = re.exec(str))) out = m; return out; }

  // ---------------- Walmart ----------------
  const walmart = {
    store: 'Walmart',
    isOrderPage: url => /walmart\.ca\/.*orders\/\d{6,}/.test(url),
    itemCount: doc => doc.querySelectorAll('[data-testid="itemtile-stack"]').length,

    // Find the section header ("41 items received", "4 unavailable items", ...) a tile belongs to.
    section(tile) {
      let el = tile;
      for (let i = 0; i < 30 && el; i++, el = el.parentElement) {
        // Look at every earlier sibling (closest first): categories like "Shopped" sit after "Weight-adjusted".
        for (let prev = el.previousElementSibling; prev; prev = prev.previousElementSibling) {
          const t = text(prev);
          // Headers look like "41 items received", "4 unavailable items", "2 substituted items".
          if (t.length < 80 && /^\d+\s/.test(t)) {
            if (/unavailable|out of stock/i.test(t)) return 'unavailable';
            if (/substitut/i.test(t)) return 'substituted';
            if (/refund|returned|cancel/i.test(t)) return 'returned';
            if (/received|delivered|picked up|shopped/i.test(t)) return 'received';
          }
        }
      }
      return 'unknown';
    },

    parse(doc, url, hint) {
      url = url || '';
      const body = text(doc.body);
      const top = doc.querySelector('#order-details-top');
      const h1 = top && top.querySelector('h1');
      const orderDate = parseFullDate(text(h1)) || (hint && hint.date) || parseFullDate(body);
      const idM = url.match(/orders\/(\d{6,})/) || body.match(/Order#\s*([\d-]{6,})/);
      const orderId = idM ? idM[1].replace(/-/g, '') : null;
      const delM = body.match(new RegExp('(Delivered|Picked up) on ' + MONTH_RE + '\\.?\\s+(\\d{1,2})', 'i'));
      const deliveredDate = delM ? parseMonthDay(delM[2] + ' ' + delM[3], orderDate ? iso(new Date(new Date(orderDate + 'T12:00:00').getTime() + 20 * 864e5)) : null) : null;

      const lines = [];
      doc.querySelectorAll('[data-testid="itemtile-stack"]').forEach(tile => {
        const nameEl = tile.querySelector('[data-testid="productName"]');
        const a = tile.querySelector('a[href*="/ip/"]');
        const href = a ? a.getAttribute('href') : '';
        const idm = href.match(/\/ip\/[^/?#]*\/([A-Za-z0-9]+)/);
        const t = text(tile);
        const desc = text(tile.querySelector('[data-testid="productDescription"]'));
        const w = desc.match(/([\d.]+)\s*kg\s*x\s*\$?\s*([\d.,]+)\s*\/\s*kg/i);
        const q = t.match(/Qty\s*(\d+(?:\.\d+)?)/i);
        // The status label sits just outside the tile, in its parent.
        const st = (text(tile.parentElement) || t).match(/(Shopped|Weight-adjusted|Substituted|Unavailable|Out of stock|Refunded|Returned|Cancell?ed)/i);
        const was = t.match(/Was\s*\$\s*([\d.,]+)/i);
        const priceEl = tile.querySelector('[data-testid="line-price"]');
        lines.push({
          section: walmart.section(tile),
          status: st ? st[1].toLowerCase() : '',
          productId: idm ? idm[1] : '',
          name: text(nameEl) || (a && clean(a.getAttribute('aria-label'))) || '',
          brand: '',
          description: desc,
          qty: q ? +q[1] : 1,
          weightKg: w ? +w[1] : null,
          pricePerKg: w ? parseFloat(w[2].replace(',', '.')) : null,
          paid: money(text(priceEl)),
          wasPrice: was ? parseFloat(was[1].replace(/,/g, '')) : null,
          listPrice: null,
          url: href ? new URL(href, 'https://www.walmart.ca').href.split('?')[0] : ''
        });
      });

      const sub = body.match(/Subtotal\s*\$\s*([\d,]+\.\d{2})/);
      const tot = lastMatch(body, /(?<![A-Za-z])Total\s*\$\s*([\d,]+\.\d{2})/);
      return {
        store: 'Walmart', orderId, orderDate, deliveredDate,
        subtotal: sub ? parseFloat(sub[1].replace(/,/g, '')) : null,
        total: tot ? parseFloat(tot[1].replace(/,/g, '')) : null,
        url: url.split('?')[0], lines
      };
    },

    // Orders on the purchase-history page: "View details" buttons carry the order number
    // (data-automation-id="view-order-details-link-600000130916701"); some cards also link to /orders/<id>/returns.
    // The order page itself shows the full date, so no date is needed here.
    listOrders(doc) {
      const seen = new Map();
      const add = id => { if (id && !seen.has(id)) seen.set(id, { id, url: 'https://www.walmart.ca/orders/' + id, date: null }); };
      doc.querySelectorAll('[data-automation-id^="view-order-details-link-"]').forEach(b => add((b.getAttribute('data-automation-id').match(/(\d{6,})/) || [])[1]));
      doc.querySelectorAll('a[href*="/orders/"]').forEach(a => add(((a.getAttribute('href') || '').match(/\/orders\/(\d{6,})/) || [])[1]));
      return [...seen.values()];
    },
    // Purchase history is paginated (about 5 orders per page).
    nextPageButton(doc) {
      const b = doc.querySelector('[data-automation-id="next-pages-button"], nav[aria-label="Pagination"] button[aria-label="Next page"]');
      return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' ? b : null;
    },

    // Product tiles on any listing page (My Items, Rollbacks, Flyer, search, category).
    products(doc) {
      const out = [];
      doc.querySelectorAll('[role="group"][data-item-id]').forEach(g => {
        const a = g.querySelector('a[href*="/ip/"]');
        const title = text(g.querySelector('[data-automation-id="product-title"]'));
        const priceBox = g.querySelector('[data-automation-id="product-price"]');
        if (!a || !title || !priceBox) return;
        const href = a.getAttribute('href');
        const urlId = (href.match(/\/ip\/[^/?#]*\/([A-Za-z0-9]+)/) || [])[1] || '';
        // "current price Now $2.46, Was $3.47" or "current price $9.97"
        const sr = [...priceBox.querySelectorAll('span')].map(text).find(s => /current price/i.test(s)) || text(priceBox);
        const now = sr.match(/current price[^$]*\$\s*([\d,]+\.\d{2})/i);
        const cents = !now && sr.match(/current price\D*(\d+(?:[.,]\d+)?)\s*¢/i);
        const was = sr.match(/Was\s*\$\s*([\d,]+\.\d{2})/i);
        const unitRaw = text(g.querySelector('[data-testid="product-price-per-unit"]'));
        const t = text(g);
        const bought = t.match(/Bought\s+([\d+]+)\s+times?/i);
        out.push({
          productId: urlId, altIds: [g.getAttribute('data-item-id')].filter(x => x && x !== urlId),
          name: title, brand: '', size: '',
          price: now ? parseFloat(now[1].replace(/,/g, '')) : cents ? parseFloat(cents[1].replace(',', '.')) / 100 : money(sr),
          wasPrice: was ? parseFloat(was[1].replace(/,/g, '')) : null,
          ...unitPrice(unitRaw),
          deal: was ? 'rollback' : (/clearance/i.test(t) ? 'clearance' : ''),
          dealText: (t.match(/You save\s*\$\s*[\d.,]+/i) || [''])[0],
          expiry: '',
          bought: bought ? bought[1] : '',
          url: new URL(href, 'https://www.walmart.ca').href.split('?')[0]
        });
      });
      return out;
    }
  };

  // ---------------- Maxi (PC Express) ----------------
  const maxi = {
    store: 'Maxi',
    isOrderPage: url => /maxi\.ca\/.*past-order\/\d{6,}/.test(url),
    itemCount: doc => doc.querySelectorAll('li.cart-entry-list__item').length,

    parse(doc, url, hint) {
      url = url || '';
      const body = text(doc.body);
      const idM = url.match(/past-order\/(\d{6,})/) || body.match(/Order\s*#\s*(\d{6,})/);
      const orderId = idM ? idM[1] : null;
      const when = body.match(new RegExp('(Delivery|Pickup)\\s*,\\s*' + MONTH_RE + '\\.?\\s+(\\d{1,2})', 'i'));
      const orderDate = (hint && hint.date) || (when ? parseMonthDay(when[2] + ' ' + when[3]) : null);

      const lines = [];
      doc.querySelectorAll('li.cart-entry-list__item').forEach(li => {
        let d = {};
        const tr = li.querySelector('[data-track-products-array]');
        try { d = JSON.parse(tr.getAttribute('data-track-products-array'))[0] || {}; } catch (e) { d = {}; }
        const ul = li.closest('ul');
        const mod = ul ? ((ul.className.match(/cart-entry-list--([\w-]+)/) || [])[1] || '') : '';
        const name = text(li.querySelector('.cart-entry__content--product-name')) || clean(d.productName);
        const qv = (li.querySelector('input.cart-entry__content__quantity') || {}).value || '';
        const kg = String(qv).match(/([\d.]+)\s*kg/i);
        const lb = String(qv).match(/([\d.]+)\s*lb/i);
        const paidEl = li.querySelector('.price--total .price__value') || li.querySelector('.price__value');
        const was = text(li).match(/was\s*\$\s*([\d.,]+)/i);
        const sku = clean(d.productSKU);
        const isFee = /\bFEE\b/i.test(name) && !d.productBrand;
        const weightKg = kg ? +kg[1] : lb ? +(lb[1] * 0.45359237).toFixed(3) : null;
        lines.push({
          section: isFee ? 'fee' : (mod === 'grocery-cart-products' ? 'received' : mod || 'unknown'),
          status: isFee ? 'fee' : '',
          productId: sku,
          name,
          brand: clean(d.productBrand),
          description: '',
          qty: weightKg ? 1 : (parseFloat(qv) || 1),
          weightKg,
          pricePerKg: weightKg && d.productPrice ? +d.productPrice : null,
          paid: money(text(paidEl)),
          wasPrice: was ? parseFloat(was[1].replace(',', '.')) : null,
          listPrice: d.productPrice ? +d.productPrice : null,
          url: '' // order pages have no product link; product pages captured elsewhere give the real one (same SKU)
        });
      });

      const sub = body.match(/Subtotal[^$]{0,20}\$\s*([\d,]+\.\d{2})/);
      const tot = lastMatch(body, /(?<![A-Za-z])Total\s*\$\s*([\d,]+\.\d{2})/);
      return {
        store: 'Maxi', orderId, orderDate, deliveredDate: orderDate,
        subtotal: sub ? parseFloat(sub[1].replace(/,/g, '')) : null,
        total: tot ? parseFloat(tot[1].replace(/,/g, '')) : null,
        url: url.split('?')[0], lines
      };
    },

    // My Orders: every past order is a link card holding its own date ("Oct 24, 2026").
    listOrders(doc) {
      const seen = new Map();
      doc.querySelectorAll('a[href*="past-order/"]').forEach(a => {
        const m = (a.getAttribute('href') || '').match(/past-order\/(\d{6,})/);
        if (!m || seen.has(m[1])) return;
        seen.set(m[1], { id: m[1], url: new URL(a.getAttribute('href'), 'https://www.maxi.ca').href, date: cardDate(a) });
      });
      return [...seen.values()];
    },
    nextPageButton: () => null,

    // Product tiles. Maxi has two designs: the classic one (deals, shopping lists, search)
    // and the newer one (My Shop, some collections).
    products(doc) {
      const out = [], seen = new Set();
      // Classic tiles
      doc.querySelectorAll('.product-tile').forEach(tile => {
        const a = tile.querySelector('a[href*="/p/"]');
        if (!a) return;
        const href = a.getAttribute('href');
        const sku = (href.match(/\/p\/([\w]+)/) || [])[1] || '';
        if (!sku || seen.has(sku)) return; seen.add(sku);
        const sale = tile.querySelector('[class*="selling-price-list__item__price--sale__value"]');
        const reg = tile.querySelector('.selling-price-list .price__value');
        const was = tile.querySelector('[class*="--was-price__value"]');
        const cmp = tile.querySelector('.comparison-price-list__item');
        const exp = text(tile.querySelector('[class*="product-badge__icon__expiry"]'));
        const dealT = text(tile.querySelector('[class*="product-badge__icon__text"]'));
        const badge = text(tile.querySelector('.product-badge__text'));
        out.push({
          productId: sku, altIds: [],
          name: text(tile.querySelector('.product-name__item--name')) || text(a),
          brand: text(tile.querySelector('.product-name__item--brand')),
          size: text(tile.querySelector('.product-name__item--package-size')),
          price: money(text(sale || reg)),
          wasPrice: was ? money(text(was)) : null,
          ...unitPrice(text(cmp)),
          deal: dealT.toLowerCase(), dealText: badge, expiry: exp.replace(/^Exp\.?\s*/i, ''),
          bought: '',
          url: new URL(href, 'https://www.maxi.ca').href.split('?')[0]
        });
      });
      // Newer tiles
      doc.querySelectorAll('[data-testid="product-title"]').forEach(h => {
        const sku = h.id || '';
        if (!/^\d+_[A-Z]{2}$/.test(sku) || seen.has(sku)) return; seen.add(sku);
        let box = h; for (let i = 0; i < 8 && box && !box.querySelector('[data-testid="price-product-tile"]'); i++) box = box.parentElement;
        if (!box) return;
        // "2 kg, $0.75/100g" — or, for produce sold by weight, "$6.61/1kg $3.00/1lb"
        const pkg = text(box.querySelector('[data-testid="product-package-size"]'));
        const cut = pkg.indexOf('$') < 0 ? pkg.length : pkg.indexOf('$');
        const sale = box.querySelector('[data-testid="sale-price"]');
        const reg = box.querySelector('[data-testid="regular-price"]');
        const was = box.querySelector('[data-testid="was-price"]');
        const a = box.querySelector('a[href*="/p/"]');
        const badge = text(box.querySelector('[data-testid="product-badge"]'));
        out.push({
          productId: sku, altIds: [],
          name: text(h), brand: text(box.querySelector('[data-testid="product-brand"]')),
          size: clean(pkg.slice(0, cut)).replace(/,$/, ''),
          price: money(text(sale || reg)),
          wasPrice: was ? money(text(was)) : null,
          ...unitPrice(pkg.slice(cut)),
          deal: sale ? 'sale' : '', dealText: text(box.querySelector('[data-testid="price-descriptor"]')) || (/sponsored/i.test(badge) ? '' : badge),
          expiry: '', bought: '',
          url: a ? new URL(a.getAttribute('href'), 'https://www.maxi.ca').href.split('?')[0] : ''
        });
      });
      return out;
    }
  };

  // "$0.63 / 100ml", "57.0 ¢/100ml", "$1.99/100g", "$1.72/kg", "$0.25/1ea" -> price per kg, L or unit.
  function unitPrice(raw) {
    raw = clean(raw);
    const m = raw.match(/(\$\s*[\d.,]+|[\d.,]+\s*¢)\s*\/\s*([\d.]*)\s*(kg|g|lb|l|ml|ea|each|un|unit)\b/i);
    if (!m) return { unitPrice: null, unitBase: '', unitRaw: raw };
    let v = /¢/.test(m[1]) ? parseFloat(m[1].replace(/[^\d.,]/g, '').replace(',', '.')) / 100 : parseFloat(m[1].replace(/[^\d.,]/g, '').replace(',', '.'));
    const n = parseFloat(m[2]) || 1, u = m[3].toLowerCase();
    let base = '';
    if (u === 'g') { v = v / n * 1000; base = 'kg'; }
    else if (u === 'kg') { v = v / n; base = 'kg'; }
    else if (u === 'lb') { v = v / n / 0.45359237; base = 'kg'; }
    else if (u === 'ml') { v = v / n * 1000; base = 'L'; }
    else if (u === 'l') { v = v / n; base = 'L'; }
    else { v = v / n; base = 'ea'; }
    return { unitPrice: Math.round(v * 1000) / 1000, unitBase: base, unitRaw: raw };
  }

  // Walk up from an order link to the smallest card that holds only this order, and read a full date in it.
  function cardDate(a) {
    const own = parseFullDate(text(a));
    if (own) return own;
    let el = a;
    for (let i = 0; i < 10 && el.parentElement; i++) {
      const p = el.parentElement;
      const ids = new Set([...p.querySelectorAll('a[href]')].map(x => (x.getAttribute('href').match(/(?:orders|past-order)\/(\d{6,})/) || [])[1]).filter(Boolean));
      if (ids.size > 1) break;
      el = p;
      const d = parseFullDate(text(el));
      if (d) return d;
    }
    return null;
  }

  // "Next page" control on product listing pages (Walmart: a[data-testid=NextPage]; generic fallbacks for Maxi).
  function nextProductPage(doc) {
    const c = doc.querySelector('a[data-testid="NextPage"], button[data-testid="NextPage"], a[aria-label="Next Page"], button[aria-label="Next Page"], ' +
      '[class*="pagination"] a[aria-label*="next" i], [class*="pagination"] button[aria-label*="next" i]');
    if (!c || c.disabled || c.getAttribute('aria-disabled') === 'true' || /disabled/i.test(c.className)) return null;
    return c;
  }
  walmart.nextProductPage = nextProductPage;
  maxi.nextProductPage = nextProductPage;

  // Search page address used to look up a product that has no recent price.
  walmart.searchUrl = it => 'https://www.walmart.ca/en/search?q=' + encodeURIComponent(clean(it.name).split(' ').slice(0, 8).join(' '));
  maxi.searchUrl = it => 'https://www.maxi.ca/en/search?search-bar=' + encodeURIComponent(clean((it.brand || '') + ' ' + it.name));

  function forUrl(url) { return /walmart\.ca/.test(url) ? walmart : /maxi\.ca/.test(url) ? maxi : null; }

  root.PantryParsers = { walmart, maxi, forUrl, money, unitPrice, parseFullDate, parseMonthDay };
})(typeof globalThis !== 'undefined' ? globalThis : this);
