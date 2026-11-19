#!/usr/bin/env python3
"""
Turn an InsiTE MySQL dump into an anonymised test dataset for Prachar.

  python anonymize_insite.py InsiteProd.sql --out ../dataset

What it does
  * Prices: each part gets its own random factor in [0.90, 1.10] for selling price and another for
    purchase price (selling rounded to Rs 5, cost to Rs 1). Past invoice lines are scaled by the same
    selling factor so sales history stays consistent.
  * Stock: each inventory row gets its own random factor in [0.90, 1.10] (random rounding, so small
    quantities also move).
  * People: customer, staff and store names, phones, emails and addresses are replaced with made-up
    values. Addresses are real central-Hyderabad localities around the store's pincode; streets and
    house numbers are invented. Phones start with 5 (not a valid Indian mobile prefix), so nobody real
    can ever be messaged. Password hashes are dropped. Part codes lose the store-initials prefix.
  * The random seed is NOT saved, so the original prices cannot be recovered from the output.

Outputs (in --out)
  insite-demo.xlsx   workbook: README, Store, Branches, Users, Parts, Inventory, Customers, Orders, Order_Items
  insite-demo.json   the dataset the Prachar app loads
"""
import argparse, collections, datetime as dt, hashlib, json, os, random, re, sys

# ---------------------------------------------------------------- dump parsing
def parse_values(s):
    rows, i, n = [], 0, len(s)
    esc = {'n': '\n', 'r': '\r', 't': '\t', '0': '\0', "'": "'", '"': '"', '\\': '\\', 'Z': '\x1a'}
    while i < n:
        if s[i] != '(':
            i += 1; continue
        i += 1; row = []
        while True:
            while s[i] == ' ': i += 1
            if s[i] == "'":
                i += 1; buf = []
                while True:
                    c = s[i]
                    if c == '\\': buf.append(esc.get(s[i + 1], s[i + 1])); i += 2
                    elif c == "'":
                        if i + 1 < n and s[i + 1] == "'": buf.append("'"); i += 2
                        else: i += 1; break
                    else: buf.append(c); i += 1
                row.append(''.join(buf))
            else:
                j = i
                while s[j] not in ',)': j += 1
                tok = s[i:j].strip(); i = j
                if tok == 'NULL': row.append(None)
                else:
                    try: row.append(int(tok))
                    except ValueError:
                        try: row.append(float(tok))
                        except ValueError: row.append(tok)
            if s[i] == ',': i += 1; continue
            if s[i] == ')': i += 1; break
        rows.append(row)
    return rows

def load_dump(path):
    src = open(path, encoding='utf8', errors='replace').read()
    db = {}
    for m in re.finditer(r"CREATE TABLE `(\w+)` \((.*?)\n\) ENGINE", src, re.S):
        name, body = m.group(1), m.group(2)
        cols = [l.strip().split()[0].strip('`') for l in body.split('\n') if l.strip().startswith('`')]
        rows = []
        for ins in re.finditer(r"INSERT INTO `%s` VALUES (.*?);\n" % name, src, re.S):
            rows += parse_values(ins.group(1))
        db[name] = [dict(zip(cols, r)) for r in rows]
    return db

# ---------------------------------------------------------------- fake identities
FIRST_M = ["Ravi", "Suresh", "Srinivas", "Mahesh", "Venkatesh", "Raju", "Naresh", "Prasad", "Ramesh", "Anil", "Kiran",
           "Satish", "Praveen", "Vijay", "Sai", "Arjun", "Imran", "Salim", "Irfan", "Abdul", "Farhan", "Sameer", "Rakesh",
           "Harish", "Shiva", "Nagaraju", "Lakshman", "Chandra", "Gopal", "Bhaskar", "Yusuf", "Aslam", "Rahul", "Vikram",
           "Karthik", "Madhu", "Pavan", "Sandeep", "Yadagiri", "Mallesh", "Srikanth", "Rajesh", "Mujeeb", "Khaja", "Anand"]
FIRST_F = ["Lakshmi", "Swathi", "Padma", "Anjali", "Sravani", "Kavitha", "Sunitha", "Ayesha", "Farzana", "Divya", "Radha"]
SURNAMES = ["Reddy", "Rao", "Goud", "Yadav", "Naidu", "Sharma", "Kumar", "Varma", "Chary", "Khan", "Shaikh", "Qureshi",
            "Patel", "Jain", "Agarwal", "Mudiraj", "Rathod", "Ansari", "Siddiqui", "Pillai", "Gupta", "Mohammed"]
DEITIES = ["Tirumala", "Sai", "Balaji", "Lakshmi", "Hanuman", "Durga", "Ganesh", "Rama", "Krishna", "Vinayaka"]
# Real central-Hyderabad localities within roughly 6 km of pincode 500095; weights favour the nearest ones.
LOCALITIES = [("Koti", "500095", 8), ("Sultan Bazar", "500095", 8), ("Putlibowli", "500095", 4), ("Abids", "500001", 6),
              ("Nampally", "500001", 5), ("Kachiguda", "500027", 5), ("Barkatpura", "500027", 3), ("Narayanguda", "500029", 5),
              ("Himayatnagar", "500029", 4), ("Basheerbagh", "500029", 3), ("Chikkadpally", "500020", 3), ("Musheerabad", "500020", 3),
              ("Chaderghat", "500024", 4), ("Malakpet", "500036", 4), ("Afzalgunj", "500012", 4), ("Begum Bazar", "500012", 4),
              ("Gowliguda", "500012", 3), ("Amberpet", "500013", 3), ("Nallakunta", "500044", 3)]
STREETS = ["Main Road", "Bazar Road", "Station Road", "Market Street", "Temple Street", "1st Lane", "2nd Lane", "3rd Lane",
           "Cross Road", "Mosque Lane", "Old Road", "New Colony Road"]

class Faker:
    def __init__(self, rng, forbidden=()):
        self.r = rng; self.used_phones = set(); self.used_names = set()
        self.forbidden = {f for f in forbidden if f}             # real names: a fake name must never equal or contain one
    def phone(self):
        while True:  # 5xxxx xxxxx: not a valid Indian mobile series, so it can never reach a real person
            p = "5" + "".join(self.r.choice("0123456789") for _ in range(9))
            if p not in self.used_phones: self.used_phones.add(p); return "+91 " + p[:5] + " " + p[5:]
    def person(self, female=None):
        female = self.r.random() < 0.12 if female is None else female
        return f"{self.r.choice(FIRST_F if female else FIRST_M)} {self.r.choice(SURNAMES)}"
    def ok(self, n):
        low = n.lower()
        return n not in self.used_names and low not in self.forbidden and not any(f in low for f in self.forbidden if " " in f)
    def unique(self, make):
        for _ in range(200):
            n = make()
            if self.ok(n): self.used_names.add(n); return n
        while True:
            n = make() + f" {self.r.randint(2, 999)}"
            if self.ok(n): self.used_names.add(n); return n
    def business(self, kind, locality):
        f = self.r.choice(FIRST_M); d = self.r.choice(DEITIES)
        if kind == "garage":
            opts = [f"{f} Auto Works", f"Sri {d} Bike Care", f"{f} Motors", f"{locality} Two Wheeler Service",
                    f"New {f} Bike Point", f"{f} Auto Electricals", f"Sri {d} Motor Works"]
        else:
            opts = [f"Sri {d} Auto Spares", f"{f} Auto Agencies", f"New {locality} Auto Parts", f"{f} Spares & Accessories",
                    f"Sri {d} Motor Parts"]
        return self.unique(lambda: self.r.choice(opts))
    def address(self):
        loc, pin, _ = self.r.choices(LOCALITIES, weights=[w for *_, w in LOCALITIES])[0]
        hno = f"{self.r.randint(1, 5)}-{self.r.randint(1, 9)}-{self.r.randint(10, 999)}"
        return loc, pin, f"H.No. {hno}, {self.r.choice(STREETS)}, {loc}, Hyderabad {pin}"

# ---------------------------------------------------------------- helpers
def jitter(rng, lo=0.9, hi=1.1): return rng.uniform(lo, hi)
def rnd_int(rng, x):  # random rounding keeps the ±10% visible on small counts
    fl = int(x); return fl + (1 if rng.random() < (x - fl) else 0)
def round_price(p): return max(1, int(round(p / 5.0)) * 5) if p >= 100 else max(1, int(round(p)))
def pretty(s):
    s = re.sub(r"\s+", " ", (s or "").strip())
    small = {"ASSY": "Assy", "ASSLY": "Assy", "CDI": "CDI", "ECM": "ECM", "ECU": "ECU", "RR": "RR", "TCI": "TCI", "CKP": "CKP",
             "O2": "O2", "BS6": "BS6", "BS4": "BS4", "BS3": "BS3", "AM": "A"}
    return " ".join(small.get(w, w.capitalize() if w.isalpha() else w) for w in s.split(" "))
def d(x): return dt.datetime.strptime(str(x)[:19], "%Y-%m-%d %H:%M:%S") if x else None

# ---------------------------------------------------------------- main
def build(dump, outdir, seed=None, store_id=None):
    rng = random.Random(seed if seed is not None else int.from_bytes(os.urandom(16), "big"))
    db = load_dump(dump)
    real = set()
    for o in db.get("orders", []) + db.get("carts", []) + db.get("return_orders", []):
        if o.get("customer_name"): real.add(re.sub(r"\s+", " ", str(o["customer_name"]).strip().lower()))
    for u in db.get("users", []):
        nm = " ".join(x for x in (u.get("first_name"), u.get("last_name")) if x)
        if nm: real.add(re.sub(r"\s+", " ", nm.strip().lower()))
    for t in ("stores", "branches", "purchasers"):
        for x in db.get(t, []):
            if x.get("name"): real.add(re.sub(r"\s+", " ", str(x["name"]).strip().lower()))
    real -= {"main warehouse"}
    fk = Faker(rng, {r for r in real if len(r) >= 4})
    parts, inv, orders, items = db["parts"], db["inventory"], db["orders"], db["order_items"]
    if store_id is None: store_id = collections.Counter(p["store_id"] for p in parts).most_common(1)[0][0]
    parts = [p for p in parts if p["store_id"] == store_id]
    inv = [r for r in inv if r["store_id"] == store_id]
    orders = [o for o in orders if o["store_id"] == store_id]
    oids = {o["id"] for o in orders}; items = [i for i in items if i["order_id"] in oids]
    store = next(s for s in db["stores"] if s["id"] == store_id)
    branches = [b for b in db["branches"] if b["store_id"] == store_id]

    # ---- store / branches / users
    s_loc, s_pin, s_addr = "Sultan Bazar", store["postal_code"] or "500095", f"Shop No. {rng.randint(3, 40)}, Bazar Road, Sultan Bazar, Hyderabad {store['postal_code'] or '500095'}"
    STORE = {"name": "Sri Venkateswara Auto Spares", "short": "SVAS", "address": s_addr, "area": f"{s_loc}, Hyderabad",
             "city": store["city"], "state": store["state"], "pincode": s_pin, "phone": fk.phone(),
             "business": "Two-wheeler electrical spare parts (CDI, coil plates, self motors, ECMs, fuel pumps)"}
    BR = [{"branch_id": b["id"], "name": b["name"] if re.fullmatch(r"(?i)main warehouse", b["name"] or "") else "Main Warehouse",
           "code": b["code"], "type": b["branch_type"], "address": fk.address()[2], "phone": fk.phone()} for b in branches]
    US = []
    for u in db["users"]:
        if u["store_id"] not in (store_id, None): continue
        n = fk.unique(fk.person)
        US.append({"user_id": u["id"], "name": n, "email": re.sub(r"[^a-z.]", "", n.lower().replace(" ", ".")) + "@svas.example",
                   "phone": fk.phone(), "role": u["role"], "active": u["is_active"]})  # password hash intentionally dropped

    # ---- parts: price factors
    pf = {}  # part_id -> selling factor
    P = {}
    code_map = {}
    for p in parts:
        f, g = jitter(rng), jitter(rng)
        sell = round_price(float(p["selling_price"] or 0) * f)
        cost = int(round(float(p["purchase_price"] or 0) * g))
        orig_ok = (p["selling_price"] or 0) >= (p["purchase_price"] or 0)
        if orig_ok and cost >= sell: cost = int(sell / 1.05)   # keep the original's profitable/loss-making nature
        pf[p["id"]] = sell / float(p["selling_price"]) if p["selling_price"] else f
        code = re.sub(r"^GM", "SV", p["part_code"] or f"SV{p['id']:05d}")
        code_map[p["id"]] = code
        P[p["id"]] = {"sku": code, "name": pretty(p["part_name"]), "fits": (p["brand"] or "").strip(),
                      "category": pretty(p["part_name"]), "description": pretty(p["description"] or p["part_name"]),
                      "selling_price": sell, "purchase_price": cost, "gst_applicable": bool(p["is_gst_applicable"]),
                      "gst_rate": float(p["gst_rate"] or 0), "hsn": "8714", "unit": p["unit_of_measure"] or "piece",
                      "reorder_level": p["reorder_level"] or 0}

    # ---- inventory
    bins = {b["id"]: b for b in db["bins"]}; racks = {r["id"]: r for r in db["racks"]}; subs = {s["id"]: s for s in db["sub_racks"]}
    INV = []
    stock = collections.Counter()
    for r in inv:
        h = jitter(rng)
        g_, ng, ex = [rnd_int(rng, (r[k] or 0) * h) for k in ("quantity_gst", "quantity_non_gst", "quantity_exempted")]
        q = rnd_int(rng, (r["quantity"] or 0) * h)
        if g_ + ng + ex and abs((g_ + ng + ex) - q) > max(1, q * 0.02) and (r["quantity_gst"] or 0) + (r["quantity_non_gst"] or 0) + (r["quantity_exempted"] or 0) == r["quantity"]:
            q = g_ + ng + ex
        loc = " / ".join(x for x in [f"Bin {bins[r['bin_id']]['bin_name']}" if r.get("bin_id") in bins else "",
                                     racks[r["rack_id"]]["rack_code"] if r.get("rack_id") in racks else "",
                                     subs[r["sub_rack_id"]]["sub_rack_code"] if r.get("sub_rack_id") in subs else ""] if x)
        INV.append({"sku": code_map.get(r["part_id"], ""), "branch_id": r["branch_id"], "location": loc, "quantity": q,
                    "qty_gst": g_, "qty_non_gst": ng, "qty_exempted": ex, "last_restock": str(r["last_restock_date"] or "")[:10]})
        stock[r["part_id"]] += q
    INV = [x for x in INV if x["sku"]]

    # ---- customers from orders
    def ckey(o):
        ph = re.sub(r"\D", "", str(o["customer_phone"] or ""))[-10:]
        if len(ph) >= 9: return "p:" + ph
        nm = re.sub(r"\s+", " ", (o["customer_name"] or "").strip().lower())
        return "n:" + nm if nm else "walkin"
    as_of = max(d(o["created_at"]) for o in orders)
    order_money = collections.defaultdict(float)
    for i in items: order_money[i["order_id"]] += float(i["item_total"] or 0)
    groups = collections.defaultdict(list)
    for o in orders: groups[ckey(o)].append(o)
    CUS, cust_of = [], {}
    n = 0
    for key, os_ in sorted(groups.items(), key=lambda kv: min(d(o["created_at"]) for o in kv[1])):
        n += 1; cid = f"C{n:04d}"
        spend = sum(float(o["total_amount"] or 0) for o in os_); cnt = len(os_)
        first, last = min(d(o["created_at"]) for o in os_), max(d(o["created_at"]) for o in os_)
        if key == "walkin": kind = "walkin"
        elif cnt >= 3 or (cnt >= 2 and spend >= 3000): kind = "garage"
        elif spend >= 10000: kind = "retailer"
        else: kind = "walkin"
        loc, pin, addr = fk.address()
        if key == "walkin": name, phone = "Walk-in customers (no name)", ""
        elif kind == "walkin": name, phone = fk.unique(fk.person), (fk.phone() if key.startswith("p:") else "")
        else: name, phone = fk.business(kind, loc), (fk.phone() if key.startswith("p:") else "")
        opt = bool(phone) and rng.random() < 0.85
        lapsed = cnt >= 2 and (as_of - last).days > 45
        CUS.append({"customer_id": cid, "name": name, "type": kind, "locality": loc, "pincode": pin,
                    "address": addr if key != "walkin" else "", "phone": phone, "whatsapp_opt_in": opt,
                    "orders": cnt, "spend": 0.0, "first_order": first.strftime("%Y-%m-%d"), "last_order": last.strftime("%Y-%m-%d"),
                    "lapsed": lapsed})
        for o in os_: cust_of[o["id"]] = CUS[-1]

    # ---- orders & items, scaled by part selling factor
    OI = []; new_tot = collections.defaultdict(float)
    for i in items:
        f = pf.get(i["part_id"], 1.0)
        up, da, ga, it = [round(float(i[k] or 0) * f, 2) for k in ("unit_price", "discount_amount", "gst_amount", "item_total")]
        new_tot[i["order_id"]] += it
        OI.append({"invoice_id": None, "order_id": i["order_id"], "sku": code_map.get(i["part_id"], ""), "quantity": i["quantity"],
                   "unit_price": up, "discount_percent": float(i["discount_percent"] or 0), "discount_amount": da,
                   "gst_rate": float(i["gst_rate"] or 0), "gst_amount": ga, "item_total": it})
    ORD = []; inv_no = {}
    for k, o in enumerate(sorted(orders, key=lambda o: d(o["created_at"])), 1):
        ratio = (new_tot[o["id"]] / order_money[o["id"]]) if order_money[o["id"]] else 1.0
        money = {k2: round(float(o[k2] or 0) * ratio, 2) for k2 in ("subtotal", "total_discount", "gst_amount", "total_amount", "cash_amount", "upi_amount", "card_amount")}
        c = cust_of[o["id"]]; c["spend"] += money["total_amount"]
        inv_no[o["id"]] = f"SV-{d(o['created_at']).strftime('%y%m')}-{k:05d}"
        ORD.append({"invoice_no": inv_no[o["id"]], "date": str(o["created_at"])[:19], "customer_id": c["customer_id"],
                    "customer_name": c["name"], **money, "payment_method": o["payment_method"], "status": o["order_status"]})
    for x in OI: x["invoice_id"] = inv_no.get(x.pop("order_id"))
    for c in CUS: c["spend"] = round(c["spend"], 2)

    # ---- sales signals per part
    sold30, sold90, last_sale = collections.Counter(), collections.Counter(), {}
    date_of = {o["id"]: d(o["created_at"]) for o in orders}
    for i in items:
        t = date_of[i["order_id"]]; age = (as_of - t).days
        if age <= 30: sold30[i["part_id"]] += i["quantity"]
        if age <= 90: sold90[i["part_id"]] += i["quantity"]
        last_sale[i["part_id"]] = max(last_sale.get(i["part_id"], t), t)
    window = (as_of - min(date_of.values())).days + 1
    fast_ids = {pid for pid, _ in sold30.most_common(25)}

    PRODUCTS = []
    for pid, p in P.items():
        ls = last_sale.get(pid)
        PRODUCTS.append({"sku": p["sku"], "name": p["name"], "brand": "", "fit": p["fits"], "cat": p["category"], "hsn": p["hsn"],
                         "mrp": None, "price": p["selling_price"], "cost": p["purchase_price"], "stock": stock.get(pid, 0),
                         "lastSale": (as_of - ls).days if ls else window, "neverSold": ls is None,
                         "sold30": sold30.get(pid, 0), "sold90": sold90.get(pid, 0), "seg": "2w", "fast": pid in fast_ids,
                         "gst": p["gst_rate"] if p["gst_applicable"] else 0, "reorder": p["reorder_level"]})
    for p in P.values(): p["stock"] = next((x["stock"] for x in PRODUCTS if x["sku"] == p["sku"]), 0)

    def aud(id_, name, sel, note):
        cs = [c for c in CUS if sel(c)]
        return {"id": id_, "name": name, "total": len(cs), "optIn": sum(c["whatsapp_opt_in"] for c in cs), "note": note}
    AUDS = [aud("garages", "Garages & mechanics (repeat buyers)", lambda c: c["type"] == "garage", "Bought 3+ times, or twice with ₹3,000+ spend"),
            aud("retailers", "Parts shops (bulk buyers)", lambda c: c["type"] == "retailer", "Single orders of ₹10,000+"),
            aud("walkin", "Walk-in buyers", lambda c: c["type"] == "walkin" and c["phone"], "One-off counter customers with a phone number"),
            aud("lapsed", "Lapsed regulars (45+ days)", lambda c: c["lapsed"], "Ordered 2+ times, nothing in the last 45 days"),
            aud("all", "All customers with a phone", lambda c: bool(c["phone"]), "Everyone we can message")]

    body = {"store": STORE, "asOf": as_of.strftime("%Y-%m-%d"), "windowDays": window, "products": PRODUCTS, "audiences": AUDS,
            "customers": CUS, "social": {"facebook": {"followers": 1850}, "instagram": {"followers": 920}}}
    body["version"] = hashlib.sha1(json.dumps(body, sort_keys=True, default=str).encode()).hexdigest()[:8]
    body["generated"] = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    body["notes"] = "Anonymised from an InsiTE dump: prices and stock randomised ±10% per item; all people, phones and addresses are synthetic; phones start with 5 so they are not real numbers. Social follower counts are placeholders."
    os.makedirs(outdir, exist_ok=True)
    json.dump(body, open(os.path.join(outdir, "insite-demo.json"), "w", encoding="utf8"), ensure_ascii=False, separators=(",", ":"))
    return body, STORE, BR, US, P, INV, CUS, ORD, OI, as_of

def write_xlsx(path, body, STORE, BR, US, P, INV, CUS, ORD, OI):
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment
    from openpyxl.utils import get_column_letter
    wb = Workbook(); F = Font(name="Arial", size=10); H = Font(name="Arial", size=10, bold=True, color="FFFFFF")
    fill = PatternFill("solid", fgColor="23395D")
    def sheet(title, headers, rows, widths=None, numfmt=None):
        ws = wb.create_sheet(title)
        ws.append(headers)
        for r in rows: ws.append(r)
        for c in ws[1]: c.font = H; c.fill = fill; c.alignment = Alignment(vertical="center")
        for row in ws.iter_rows(min_row=2):
            for c in row: c.font = F
        for i, h in enumerate(headers, 1):
            ws.column_dimensions[get_column_letter(i)].width = (widths or {}).get(h, max(10, min(40, len(h) + 4)))
            if numfmt and h in numfmt:
                for (c,) in ws.iter_rows(min_row=2, min_col=i, max_col=i): c.number_format = numfmt[h]
        ws.freeze_panes = "A2"; ws.auto_filter.ref = ws.dimensions
        return ws
    rd = wb.active; rd.title = "README"
    lines = [("Prachar test dataset (anonymised InsiTE data)", True), ("", False),
             (f"Store (synthetic): {STORE['name']}, {STORE['address']}", False),
             (f"Sales data window: {body['windowDays']} days, up to {body['asOf']} (as-of date used for 'days since last sale').", False),
             (f"Dataset version {body['version']}, generated {body['generated']}.", False), ("", False),
             ("How it was made", True),
             ("Prices: each part has its own random factor between -10% and +10% (selling price rounded to Rs 5; cost to Rs 1).", False),
             ("Past invoice lines use the same factor as their part, so sales history stays consistent.", False),
             ("Stock: each inventory row has its own random -10% to +10% change.", False),
             ("People: all customer, staff and store names, phones, emails and addresses are made up.", False),
             ("Addresses use real central-Hyderabad localities near pincode 500095; house numbers and streets are invented.", False),
             ("Phone numbers start with 5, which is not an Indian mobile series, so no real person can be messaged.", False),
             ("Password hashes were removed. Part codes lost the store's initials (now start with SV).", False),
             ("Random seed not stored, so original prices cannot be recovered from this file.", False), ("", False),
             ("Assumptions", True),
             ("HSN 8714 (motorcycle parts) is assumed for all parts; the source had no HSN codes.", False),
             ("Customer type is inferred from buying pattern: garage = 3+ orders or 2+ orders with Rs 3,000+ spend; retailer = single orders Rs 10,000+; others walk-in.", False),
             ("WhatsApp opt-in is simulated (about 85% of customers with a phone). Social follower counts are placeholders.", False),
             ("Margin % and Stock value in the Parts sheet are formulas.", False)]
    for t, b in lines:
        rd.append([t]); rd.cell(rd.max_row, 1).font = Font(name="Arial", size=12 if b and rd.max_row == 1 else 10, bold=b)
    rd.column_dimensions["A"].width = 120
    sheet("Store", ["Field", "Value"], [[k, v] for k, v in STORE.items()], {"Field": 14, "Value": 80})
    sheet("Branches", list(BR[0].keys()) if BR else ["branch_id"], [list(b.values()) for b in BR], {"address": 60})
    sheet("Users", ["user_id", "name", "email", "phone", "role", "active"], [list(u.values()) for u in US], {"email": 34, "name": 22})
    ph = ["sku", "name", "fits", "category", "description", "selling_price", "purchase_price", "gst_applicable", "gst_rate", "hsn", "unit", "reorder_level", "stock"]
    ws = sheet("Parts", ph + ["margin_pct", "stock_value_at_cost"], [[p[h] for h in ph] for p in P.values()],
               {"name": 24, "fits": 26, "category": 22, "description": 30},
               {"selling_price": "#,##0", "purchase_price": "#,##0", "margin_pct": "0.0%", "stock_value_at_cost": "#,##0"})
    for r in range(2, ws.max_row + 1):   # F=selling, G=purchase, M=stock
        ws[f"N{r}"] = f"=IF(F{r}=0,0,(F{r}-G{r})/F{r})"; ws[f"O{r}"] = f"=G{r}*M{r}"
        ws[f"N{r}"].font = F; ws[f"O{r}"].font = F; ws[f"N{r}"].number_format = "0.0%"; ws[f"O{r}"].number_format = "#,##0"
    sheet("Inventory", list(INV[0].keys()), [list(x.values()) for x in INV], {"location": 22})
    sheet("Customers", list(CUS[0].keys()), [list(c.values()) for c in CUS], {"name": 30, "address": 55}, {"spend": "#,##0.00"})
    sheet("Orders", list(ORD[0].keys()), [list(o.values()) for o in ORD], {"customer_name": 30, "date": 20},
          {k: "#,##0.00" for k in ("subtotal", "total_discount", "gst_amount", "total_amount", "cash_amount", "upi_amount", "card_amount")})
    sheet("Order_Items", list(OI[0].keys()), [list(x.values()) for x in OI], None,
          {k: "#,##0.00" for k in ("unit_price", "discount_amount", "gst_amount", "item_total")})
    wb.save(path)

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("dump"); ap.add_argument("--out", default="dataset")
    ap.add_argument("--seed", type=int, default=None, help="only for repeatable tests; leave out for real use")
    a = ap.parse_args()
    body, *rest = build(a.dump, a.out, a.seed)
    write_xlsx(os.path.join(a.out, "insite-demo.xlsx"), body, *rest[:-1])
    print(f"Wrote {a.out}/insite-demo.json and insite-demo.xlsx  (version {body['version']}, {len(body['products'])} parts, "
          f"{len(body['customers'])} customers, as of {body['asOf']})")
