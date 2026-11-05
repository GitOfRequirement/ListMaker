"""Build the Pantry v2 data file from the reviewed classification workbook and the extension export.

    python tools/build-data.py "Pantry - classification v4.xlsx" pantry-export-2026-11-05.json pantry-data-v2.json

Output (one JSON file, imported in the app: Setup > Import):
  areas     [{id, name}]
  items     {itemId: {name, aisle, follow, targets{areaId:n}, match, targetPrice, note, stats{b12, q}}}
  products  {key: {store, id, alt[], name, brand, item, status, url, n, n12, last, qty}}   key = "W:<id>" / "M:<id>"
  prices    {key: [[date, price, unitPrice, unitBase, wasPrice, source]]}   source: "shelf" (seen on a page) or "order" (paid)

follow: normal (wanted all year) | seasonal (reminder) | deal (only when significantly under its usual price) | retired
match:  any (compare every non-excluded product) | preferred (only products marked preferred: "exactly this one")
status: preferred | ok | excluded   (new products found later arrive as "new")

Decisions taken in conversation after the last workbook review are applied below (DECISIONS) so they are not lost.
"""
import sys, re, json, statistics as st, collections as C, warnings
import openpyxl
warnings.filterwarnings('ignore')
XLSX, EXPORT, OUT = sys.argv[1:4]
TODAY = '2026-11-05'; Y1 = '2025-11-05'

FOLLOW = {'Normal': 'normal', 'Saisonnier': 'seasonal', 'Rabais seulement': 'deal', 'Retirer': 'retired'}

# ---- decisions made after the workbook was last saved (2026-11-05) ----
DECISIONS = {
    'rename': {'Bread': 'Bread, white'},
    'item': {
        'Liquid aminos': {'follow': 'retired', 'targets': {}},
        'Broth, chicken bone': {'match': 'preferred', 'note': 'EXACTLY the usual Imagine Chicken Bone Broth. The Imagine low-sodium one contains gluten.'},
        'Granola bars, KIND': {'note': 'Often cheaper at Dollarama: bought there too.'},
        'Bread, white': {'note': 'White only (no sourdough).'},
        'Bread, gluten-free': {'note': 'White preferred; millet & quinoa acceptable.'},
    },
    # product status by (article, regex on product name)
    'status': [
        ('Bread, white', r'sourdough', 'excluded'),
        ('Bread, white', r'white miche', 'preferred'),
        ('Bread, gluten-free', r'white', 'preferred'),
        ('Broth, chicken bone', r'^imagine chicken bone broth$', 'preferred'),
    ],
}

def slug(s):
    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')

wb = openpyxl.load_workbook(XLSX)
wa, wp = wb['Articles'], wb['Produits']
hdr = [c.value for c in wa[1]]
AREAS = hdr[4:13]
areas = [{'id': slug(a), 'name': a} for a in AREAS]

# ---- items ----
items, name2id = {}, {}
for r in range(2, wa.max_row + 1):
    v = [wa.cell(r, c).value for c in range(1, 21)]
    if not v[0]: continue
    name = DECISIONS['rename'].get(v[0], v[0])
    iid = slug(name)
    assert iid not in items, ('duplicate item id', iid)
    targets = {slug(AREAS[i]): int(v[4 + i]) for i in range(9) if isinstance(v[4 + i], (int, float)) and v[4 + i] > 0}
    items[iid] = {'name': name, 'aisle': v[1], 'follow': FOLLOW.get(v[3], 'normal'), 'targets': targets, 'match': 'any',
                  'targetPrice': v[19] if isinstance(v[19], (int, float)) else None, 'note': v[18] or ''}
    items[iid].update(DECISIONS['item'].get(name, {}))
    name2id[v[0]] = iid; name2id[name] = iid

# ---- purchase history ----
d = json.load(open(EXPORT, encoding='utf-8'))
FEE = re.compile(r'\b(FEE|TIP|BAG CHARGE|DEPOSIT)\b', re.I)
hist = C.defaultdict(lambda: {'orders': {}, 'last': '', 'paid': []})
for o in d['orders']:
    for l in o['lines']:
        if l['section'] in ('fee', 'unavailable') or (FEE.search(l['name']) and not l.get('brand')): continue
        k = o['store'][0] + ':' + (l['productId'] or l['name'])
        h = hist[k]; dt = o['orderDate'] or ''
        q = 1 if l.get('weightKg') else (l['qty'] or 1)
        h['orders'][o['orderId']] = (dt, h['orders'].get(o['orderId'], ('', 0))[1] + q)
        h['last'] = max(h['last'], dt)
        if l.get('paid') is not None:
            if l.get('weightKg'):   # sold by weight: price per kg
                h['paid'].append([dt, l['paid'], l.get('pricePerKg') or round(l['paid'] / l['weightKg'], 3), 'kg', l.get('wasPrice'), 'order'])
            else:
                h['paid'].append([dt, round(l['paid'] / q, 2), None, '', l.get('wasPrice'), 'order'])

# ---- products (the reviewed links from the workbook) ----
products = {}
for r in range(2, wp.max_row + 1):
    store, brand, name, art = (wp.cell(r, c).value for c in (1, 2, 3, 4))
    pid = wp.cell(r, 12).value
    key = store[0] + ':' + (pid or name)
    iid = name2id.get(art)
    assert iid, ('product without a known article', art, name)
    h = hist[key]
    products[key] = {'store': store, 'id': pid or '', 'alt': [], 'name': name, 'brand': brand or '', 'item': iid, 'status': 'ok', 'url': '',
                     'n': len(h['orders']), 'n12': sum(1 for dt, _ in h['orders'].values() if dt >= Y1), 'last': h['last'],
                     'qty': round(sum(q for _, q in h['orders'].values()) / max(1, len(h['orders'])), 1)}
for art, rx, status in DECISIONS['status']:
    iid = name2id[art]
    for p in products.values():   # match on "brand name" (Maxi keeps the brand apart from the name)
        if p['item'] == iid and re.search(rx, (p['brand'] + ' ' + p['name']).strip(), re.I): p['status'] = status

# ---- prices: what the extension saw on the stores' pages + what was paid ----
prices = C.defaultdict(list)
by_id = {}
for p in d['products']:
    k = p['store'][0] + ':' + p['productId']
    for pid in [p['productId']] + (p.get('altIds') or []): by_id[p['store'][0] + ':' + pid] = p
    for ob in p.get('obs') or []:
        prices[k].append([ob['d'], ob.get('price'), ob.get('unitPrice'), ob.get('unitBase') or '', ob.get('wasPrice'), 'shelf'])
for key, p in products.items():
    sp = by_id.get(key)
    if sp:   # same product seen on a page: fill url, size, alt ids, and use the page's key for its prices
        p['url'] = sp.get('url') or ''
        p['size'] = sp.get('size') or ''
        p['alt'] = sorted({sp['productId'], *(sp.get('altIds') or [])} - {p['id']})
        k2 = sp['store'][0] + ':' + sp['productId']
        if k2 != key: prices[key] = prices.pop(k2, []) + prices.get(key, [])
    prices[key] = prices.get(key, []) + hist[key]['paid']
prices = {k: sorted(v, key=lambda x: x[0]) for k, v in prices.items() if k in products and v}

# ---- item stats: orders in the last 12 months, median quantity per order ----
for iid, it in items.items():
    per = C.defaultdict(float)
    for k, p in products.items():
        if p['item'] != iid: continue
        for oid, (dt, q) in hist[k]['orders'].items():
            if dt >= Y1: per[oid] += q
    it['stats'] = {'b12': len(per), 'q': round(st.median(per.values()), 1) if per else 0}

empty = [it['name'] for iid, it in items.items() if not any(p['item'] == iid for p in products.values())]
data = {'format': 'pantry-v2', 'built': TODAY, 'areas': areas, 'items': items, 'products': products, 'prices': prices}
json.dump(data, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
size = len(json.dumps({k: data[k] for k in ('areas', 'items', 'products')}, ensure_ascii=False))
print(f"areas {len(areas)} | items {len(items)} ({C.Counter(i['follow'] for i in items.values())}) | products {len(products)} "
      f"({C.Counter(p['status'] for p in products.values())}) | price series {len(prices)} / points {sum(map(len, prices.values()))}")
print('items without products:', empty, '| synced part ≈', round(size / 1024), 'KB')
