// Shared inventory API used by both the production Worker (src/worker.ts,
// Cloudflare Access enforced) and the localhost-only Worker (src/worker.local.ts).
// Keeping one copy means the two can never drift apart.

export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface D1Database { prepare(sql: string): D1Statement; }
export interface Env {
  DB: D1Database;
  ASSETS: { fetch(request: Request): Promise<Response> };
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
}
/** Who is making the request: the Cloudflare Access email in production, a chosen name locally. */
export type Actor = { name: string | null; source: 'access' | 'local' };

type StockRow = { location_id: number; quantity: number };
type Item = { id: number; name: string; barcode: string; quantity: number; category: string | null; min_qty: number | null; last_moved?: string | null; stock?: StockRow[] | string };
type Location = { id: number; name: string; units: number; items: number; used: number };
type Movement = {
  id: number; request_id: string; item_id: number; item_name: string; barcode: string; direction: 'in' | 'out' | 'transfer';
  quantity: number; resulting_balance: number; location_id: number; location_balance: number; to_location_id: number | null;
  to_location_balance: number | null; location_name?: string; to_location_name?: string | null;
  reason: 'scan' | 'adjustment'; note: string | null; actor: string | null; created_at: string;
};
type SummaryRow = { id: number; name: string; barcode: string; category: string | null; min_qty: number | null; on_hand: number; opening: number; received: number; issued: number; closing: number };

export const MAX_QTY = 10000;

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
});

// Scanners can prepend/append invisible characters (GS separators, CR, zero-width
// spaces, BOM). Strip them so the stored barcode matches what a later scan sends.
export function cleanBarcode(v: unknown): string {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001F\u007F​-‍⁠﻿]/g, '').trim() : '';
}
export const cleanText = (v: unknown) => typeof v === 'string' ? v.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim() : '';
const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9-]{36}$/i.test(v);
const isQty = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_QTY;
const isId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1;
const optNote = (v: unknown) => cleanText(v).slice(0, 200) || null;

export function dates(url: URL): { start: string; end: string } | null {
  const start = url.searchParams.get('start');
  const end = url.searchParams.get('end');
  const valid = (d: string | null) => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
  if (!valid(start) || !valid(end) || start! > end!) return null;
  return { start: start!, end: end! };
}
// Malta is CET/CEST; derive each local midnight by iterative Intl conversion,
// rather than assuming a fixed UTC offset (DST changes are handled).
export function maltaMidnight(date: string): string {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Malta', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const target = Date.parse(`${date}T00:00:00Z`);
  let instant = target - 3600_000;
  for (let i = 0; i < 4; i++) {
    const values = Object.fromEntries(format.formatToParts(new Date(instant)).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
    const localAsUtc = Date.parse(`${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:00Z`);
    instant += target - localAsUtc;
  }
  return new Date(instant).toISOString();
}
function nextDate(date: string): string { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); }
export function escapeCsv(v: string | number | null): string { const s = String(v ?? ''); const safe = /^[=+@\-\t\r]/.test(s) ? `'${s}` : s; return `"${safe.replaceAll('"', '""')}"`; }

const columns = `m.id, m.request_id, m.item_id, m.item_name, m.barcode, m.direction, m.quantity, m.resulting_balance,
  m.location_id, m.location_balance, m.to_location_id, m.to_location_balance, m.reason, m.note, m.actor, m.created_at,
  (SELECT name FROM locations WHERE id = m.location_id) AS location_name,
  (SELECT name FROM locations WHERE id = m.to_location_id) AS to_location_name`;
const itemColumns = `id, name, barcode, quantity, category, min_qty,
  (SELECT MAX(m.created_at) FROM movements m WHERE m.item_id = items.id) AS last_moved,
  (SELECT json_group_array(json_object('location_id', s.location_id, 'quantity', s.quantity)) FROM stock s WHERE s.item_id = items.id AND s.quantity > 0) AS stock`;
const parseItem = (i: Item | null): Item | null => {
  if (!i) return i;
  let stock: StockRow[] = [];
  try { stock = typeof i.stock === 'string' ? JSON.parse(i.stock) : (i.stock || []); } catch { /* none */ }
  return { ...i, stock };
};
const byRequest = (db: D1Database, id: string) => db.prepare(`SELECT ${columns} FROM movements m WHERE m.request_id = ?`).bind(id).first<Movement>();
const itemById = async (db: D1Database, id: number) => parseItem(await db.prepare(`SELECT ${itemColumns} FROM items WHERE id = ?`).bind(id).first<Item>());
const itemByBarcode = async (db: D1Database, b: string) => parseItem(await db.prepare(`SELECT ${itemColumns} FROM items WHERE barcode = ?`).bind(b).first<Item>());
const locationExists = async (db: D1Database, id: number) => !!(await db.prepare('SELECT id FROM locations WHERE id = ?').bind(id).first());
const stockAt = async (db: D1Database, itemId: number, loc: number) => (await db.prepare('SELECT quantity FROM stock WHERE item_id = ? AND location_id = ?').bind(itemId, loc).first<{ quantity: number }>())?.quantity ?? 0;
const locName = async (db: D1Database, id: number) => (await db.prepare('SELECT name FROM locations WHERE id = ?').bind(id).first<{ name: string }>())?.name ?? 'that location';

function itemFields(input: Record<string, unknown>, base?: Item) {
  const name = input.name === undefined && base ? base.name : cleanText(input.name);
  const barcode = input.barcode === undefined && base ? base.barcode : cleanBarcode(input.barcode);
  const category = input.category === undefined ? (base ? base.category : null) : (cleanText(input.category).slice(0, 60) || null);
  let min_qty: number | null = base ? base.min_qty : null;
  if (input.min_qty !== undefined) {
    if (input.min_qty === null || input.min_qty === '') min_qty = null;
    else if (typeof input.min_qty === 'number' && Number.isInteger(input.min_qty) && input.min_qty >= 0 && input.min_qty <= 1_000_000) min_qty = input.min_qty;
    else return { error: 'Minimum level must be a whole number (0 or more), or empty.' };
  }
  if (name.length < 1 || name.length > 200 || barcode.length < 1 || barcode.length > 128) return { error: 'Name and barcode are required (max 200 and 128 characters).' };
  return { name, barcode, category, min_qty };
}

async function report(db: D1Database, url: URL) {
  const range = dates(url);
  if (!range) return { error: json({ error: 'Use valid start and end dates (YYYY-MM-DD), start no later than end.' }, 400) };
  const from = maltaMidnight(range.start), to = maltaMidnight(nextDate(range.end));
  const movements = (await db.prepare(`SELECT ${columns} FROM movements m WHERE m.created_at >= ? AND m.created_at < ? ORDER BY m.created_at, m.id`).bind(from, to).all<Movement>()).results;
  const sum = (d: string) => movements.filter(m => m.direction === d).reduce((a, m) => a + m.quantity, 0);
  return { movements, totals: { received: sum('in'), issued: sum('out'), transferred: sum('transfer') } };
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try { const v = await req.json(); return v && typeof v === 'object' ? v as Record<string, unknown> : {}; } catch { return {}; }
}

export async function handleApi(req: Request, env: Env, url: URL, actor: Actor = { name: null, source: 'local' }): Promise<Response> {
  const db = env.DB;
  const who = actor.name ? actor.name.slice(0, 120) : null;
  const itemPath = url.pathname.match(/^\/api\/items\/(\d+)(\/count|\/movements)?$/);
  const locPath = url.pathname.match(/^\/api\/locations\/(\d+)$/);
  try {
    if (url.pathname === '/api/me' && req.method === 'GET') return json({ name: actor.name, source: actor.source });

    // ── Locations ──
    if (url.pathname === '/api/locations' && req.method === 'GET') {
      const results = (await db.prepare(`SELECT l.id, l.name,
          COALESCE((SELECT SUM(quantity) FROM stock s WHERE s.location_id = l.id), 0) AS units,
          (SELECT COUNT(*) FROM stock s WHERE s.location_id = l.id AND s.quantity > 0) AS items,
          (SELECT COUNT(*) FROM movements m WHERE m.location_id = l.id OR m.to_location_id = l.id) AS used
        FROM locations l ORDER BY l.id`).all<Location>()).results;
      return json({ locations: results });
    }
    if (url.pathname === '/api/locations' && req.method === 'POST') {
      const name = cleanText((await readJson(req)).name).slice(0, 80);
      if (!name) return json({ error: 'Give the location a name.' }, 400);
      try { await db.prepare('INSERT INTO locations (name) VALUES (?)').bind(name).run(); }
      catch { return json({ error: `There is already a location called ${name}.` }, 409); }
      return json({ location: await db.prepare('SELECT id, name FROM locations WHERE name = ?').bind(name).first() }, 201);
    }
    if (locPath) {
      const id = Number(locPath[1]);
      if (!(await locationExists(db, id))) return json({ error: 'Location not found.' }, 404);
      if (req.method === 'PATCH') {
        const name = cleanText((await readJson(req)).name).slice(0, 80);
        if (!name) return json({ error: 'Give the location a name.' }, 400);
        try { await db.prepare('UPDATE locations SET name = ? WHERE id = ?').bind(name, id).run(); }
        catch { return json({ error: `There is already a location called ${name}.` }, 409); }
        return json({ location: { id, name } });
      }
      if (req.method === 'DELETE') {
        const used = await db.prepare('SELECT (SELECT COUNT(*) FROM movements WHERE location_id = ? OR to_location_id = ?) + (SELECT COUNT(*) FROM stock WHERE location_id = ? AND quantity > 0) AS n').bind(id, id, id).first<{ n: number }>();
        const total = await db.prepare('SELECT COUNT(*) AS n FROM locations').first<{ n: number }>();
        if ((used?.n ?? 0) > 0) return json({ error: 'This location has stock or history, so it can’t be removed. You can rename it.' }, 409);
        if ((total?.n ?? 0) <= 1) return json({ error: 'You need at least one location.' }, 409);
        await db.prepare('DELETE FROM stock WHERE location_id = ?').bind(id).run();
        await db.prepare('DELETE FROM locations WHERE id = ?').bind(id).run();
        return json({ deleted: true });
      }
      return json({ error: 'Method not allowed' }, 405);
    }

    // ── Items: list / register ──
    if (url.pathname === '/api/items' && req.method === 'GET') {
      const search = (url.searchParams.get('q') || '').trim();
      const results = (await db.prepare(`SELECT ${itemColumns} FROM items WHERE name LIKE ? OR barcode LIKE ? ORDER BY name COLLATE NOCASE, id LIMIT 5000`).bind(`%${search}%`, `%${search}%`).all<Item>()).results;
      return json({ items: results.map(parseItem) });
    }
    if (url.pathname === '/api/items' && req.method === 'POST') {
      const f = itemFields(await readJson(req));
      if ('error' in f) return json({ error: f.error }, 400);
      try { await db.prepare('INSERT INTO items (name, barcode, category, min_qty) VALUES (?,?,?,?)').bind(f.name, f.barcode, f.category, f.min_qty).run(); }
      catch { return json({ error: `Barcode ${f.barcode} is already registered.` }, 409); }
      return json({ item: await itemByBarcode(db, f.barcode) }, 201);
    }
    if (url.pathname === '/api/categories' && req.method === 'GET') {
      const results = (await db.prepare(`SELECT category AS name, COUNT(*) AS items FROM items WHERE category IS NOT NULL GROUP BY category COLLATE NOCASE ORDER BY category COLLATE NOCASE`).all()).results;
      return json({ categories: results });
    }

    // ── Single item: read / edit / delete / count / history ──
    if (itemPath) {
      const id = Number(itemPath[1]);
      const sub = itemPath[2];
      const existing = await itemById(db, id);
      if (!existing) return json({ error: 'Item not found.' }, 404);

      if (!sub && req.method === 'GET') return json({ item: existing });

      if (!sub && req.method === 'PATCH') {
        const f = itemFields(await readJson(req), existing);
        if ('error' in f) return json({ error: f.error }, 400);
        try { await db.prepare('UPDATE items SET name = ?, barcode = ?, category = ?, min_qty = ? WHERE id = ?').bind(f.name, f.barcode, f.category, f.min_qty, id).run(); }
        catch { return json({ error: `Barcode ${f.barcode} is already used by another item.` }, 409); }
        // Past movements keep the name/barcode they were recorded with.
        return json({ item: await itemById(db, id) });
      }

      if (!sub && req.method === 'DELETE') {
        if (existing.last_moved) return json({ error: 'This item has stock history, so it can’t be deleted. Set its count to 0 instead.' }, 409);
        try { await db.prepare('DELETE FROM items WHERE id = ?').bind(id).run(); }
        catch { return json({ error: 'This item has stock history, so it can’t be deleted.' }, 409); }
        return json({ deleted: true });
      }

      if (sub === '/movements' && req.method === 'GET') {
        const results = (await db.prepare(`SELECT ${columns} FROM movements m WHERE m.item_id = ? ORDER BY m.created_at DESC, m.id DESC LIMIT 12`).bind(id).all<Movement>()).results;
        return json({ movements: results });
      }

      // Stock-take count at one location: the difference is recorded as one
      // 'adjustment' movement so reports stay complete.
      if (sub === '/count' && req.method === 'POST') {
        const input = await readJson(req);
        const count = input.count, requestId = input.requestId;
        const loc = input.location_id === undefined ? 1 : input.location_id;
        const note = optNote(input.note);
        if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > 1_000_000 || !isUuid(requestId) || !isId(loc)) return json({ error: 'A whole-number count (0 or more), a location and a UUID requestId are required.' }, 400);
        const prior = await byRequest(db, requestId);
        if (prior) return prior.item_id === id && prior.location_balance === count && prior.location_id === loc ? json({ item: await itemById(db, id), movement: prior, duplicate: true }) : json({ error: 'Request ID already used for a different change.' }, 409);
        if (!(await locationExists(db, loc))) return json({ error: 'Location not found.' }, 404);
        const here = await stockAt(db, id, loc);
        if (here === count) return json({ item: existing, movement: null });
        if (Math.abs(count - here) > 100000) return json({ error: 'That change is too large for a single adjustment.' }, 400);
        try {
          // Conditioned on the balance just read, so a scan landing in between
          // isn't silently overwritten.
          await db.prepare(`INSERT INTO movements (request_id,item_id,item_name,barcode,direction,quantity,resulting_balance,location_id,location_balance,reason,note,actor)
            SELECT ?, i.id, i.name, i.barcode, CASE WHEN ? > ? THEN 'in' ELSE 'out' END, abs(? - ?), i.quantity + (? - ?), ?, ?, 'adjustment', ?, ?
            FROM items i WHERE i.id = ? AND COALESCE((SELECT quantity FROM stock WHERE item_id = i.id AND location_id = ?), 0) = ?`)
            .bind(requestId, count, here, count, here, count, here, loc, count, note, who, id, loc, here).run();
        } catch {
          const again = await byRequest(db, requestId);
          if (again) return json({ item: await itemById(db, id), movement: again, duplicate: true });
          return json({ error: 'Stock changed while you were editing. Reopen the item and count again.' }, 409);
        }
        const movement = await byRequest(db, requestId);
        if (!movement) return json({ error: 'Stock changed while you were editing. Reopen the item and count again.' }, 409);
        return json({ item: await itemById(db, id), movement });
      }
      return json({ error: 'Method not allowed' }, 405);
    }

    // ── Scan: N units in or out at a location ──
    if (url.pathname === '/api/scan' && req.method === 'POST') {
      const input = await readJson(req);
      const barcode = cleanBarcode(input.barcode);
      const direction = input.direction;
      const requestId = input.requestId;
      const qty = input.quantity === undefined ? 1 : input.quantity;
      const loc = input.location_id === undefined ? 1 : input.location_id;
      // Optional free-text reason, e.g. "Installed at Naxxar DC" or "Faulty, RMA".
      const note = optNote(input.note);
      if (!barcode || barcode.length > 128 || (direction !== 'in' && direction !== 'out') || !isUuid(requestId)) return json({ error: 'Valid barcode, direction and UUID requestId required.' }, 400);
      if (!isQty(qty)) return json({ error: `Quantity must be a whole number from 1 to ${MAX_QTY}.` }, 400);
      if (!isId(loc)) return json({ error: 'Choose a location.' }, 400);
      const same = (m: Movement) => m.barcode === barcode && m.direction === direction && m.quantity === qty && m.location_id === loc;
      const prior = await byRequest(db, requestId);
      if (prior) return same(prior) ? json({ movement: prior, duplicate: true }) : json({ error: 'Request ID already used for a different scan.' }, 409);
      if (!(await locationExists(db, loc))) return json({ error: 'Location not found.' }, 404);
      // One INSERT + its AFTER INSERT trigger = one atomic change; concurrent
      // writes serialise. An out larger than the stock here inserts no row.
      try {
        await db.prepare(`INSERT INTO movements (request_id,item_id,item_name,barcode,direction,quantity,resulting_balance,location_id,location_balance,reason,note,actor)
          SELECT ?, i.id, i.name, i.barcode, ?, ?, i.quantity + CASE WHEN ? = 'in' THEN ? ELSE -? END,
                 ?, COALESCE(s.quantity, 0) + CASE WHEN ? = 'in' THEN ? ELSE -? END, 'scan', ?, ?
          FROM items i LEFT JOIN stock s ON s.item_id = i.id AND s.location_id = ?
          WHERE i.barcode = ? AND (? = 'in' OR COALESCE(s.quantity, 0) >= ?)`)
          .bind(requestId, direction, qty, direction, qty, qty, loc, direction, qty, qty, note, who, loc, barcode, direction, qty).run();
      } catch {
        const existing = await byRequest(db, requestId);
        if (existing) return same(existing) ? json({ movement: existing, duplicate: true }) : json({ error: 'Request ID already used for a different scan.' }, 409);
        return json({ error: 'Could not record scan. Please check inventory and try again with the same request ID.' }, 503);
      }
      const movement = await byRequest(db, requestId);
      if (movement) return json({ movement, duplicate: false });
      const item = await itemByBarcode(db, barcode);
      if (!item) return json({ error: 'Unknown barcode. Register item first.', barcode }, 404);
      const here = await stockAt(db, item.id, loc), name = await locName(db, loc);
      if (here === 0 && item.quantity > 0) return json({ error: `None at ${name}. ${item.quantity} held elsewhere.`, onHand: 0 }, 409);
      return json({ error: here === 0 ? 'Cannot withdraw: stock is already zero.' : `Cannot withdraw ${qty}: only ${here} at ${name}.`, onHand: here }, 409);
    }

    // ── Transfer between locations (one movement, totals unchanged) ──
    if (url.pathname === '/api/transfer' && req.method === 'POST') {
      const input = await readJson(req);
      const barcode = cleanBarcode(input.barcode);
      const { requestId, from, to } = input as { requestId?: unknown; from?: unknown; to?: unknown };
      const qty = input.quantity === undefined ? 1 : input.quantity;
      const note = optNote(input.note);
      if (!barcode || !isUuid(requestId) || !isId(from) || !isId(to)) return json({ error: 'Barcode, from, to and a UUID requestId are required.' }, 400);
      if (from === to) return json({ error: 'Choose two different locations.' }, 400);
      if (!isQty(qty)) return json({ error: `Quantity must be a whole number from 1 to ${MAX_QTY}.` }, 400);
      const same = (m: Movement) => m.barcode === barcode && m.direction === 'transfer' && m.quantity === qty && m.location_id === from && m.to_location_id === to;
      const prior = await byRequest(db, requestId);
      if (prior) return same(prior) ? json({ movement: prior, duplicate: true }) : json({ error: 'Request ID already used for a different change.' }, 409);
      if (!(await locationExists(db, from)) || !(await locationExists(db, to))) return json({ error: 'Location not found.' }, 404);
      try {
        await db.prepare(`INSERT INTO movements (request_id,item_id,item_name,barcode,direction,quantity,resulting_balance,location_id,location_balance,to_location_id,to_location_balance,reason,note,actor)
          SELECT ?, i.id, i.name, i.barcode, 'transfer', ?, i.quantity, ?, s.quantity - ?, ?, COALESCE(t.quantity, 0) + ?, 'scan', ?, ?
          FROM items i JOIN stock s ON s.item_id = i.id AND s.location_id = ?
          LEFT JOIN stock t ON t.item_id = i.id AND t.location_id = ?
          WHERE i.barcode = ? AND s.quantity >= ?`)
          .bind(requestId, qty, from, qty, to, qty, note, who, from, to, barcode, qty).run();
      } catch {
        const existing = await byRequest(db, requestId);
        if (existing) return same(existing) ? json({ movement: existing, duplicate: true }) : json({ error: 'Request ID already used for a different change.' }, 409);
        return json({ error: 'Could not record the move. Please try again.' }, 503);
      }
      const movement = await byRequest(db, requestId);
      if (movement) return json({ movement, duplicate: false });
      const item = await itemByBarcode(db, barcode);
      if (!item) return json({ error: 'Unknown barcode. Register item first.', barcode }, 404);
      const here = await stockAt(db, item.id, from), name = await locName(db, from);
      return json({ error: here === 0 ? `None at ${name} to move.` : `Cannot move ${qty}: only ${here} at ${name}.`, onHand: here }, 409);
    }

    // ── Reports ──
    if (url.pathname === '/api/summary' && req.method === 'GET') {
      // Per-item: total before the range, units in/out inside it, total at the end.
      const range = dates(url);
      if (!range) return json({ error: 'Use valid start and end dates (YYYY-MM-DD), start no later than end.' }, 400);
      const from = maltaMidnight(range.start), to = maltaMidnight(nextDate(range.end));
      const rows = (await db.prepare(`SELECT i.id, i.name, i.barcode, i.category, i.min_qty, i.quantity AS on_hand,
          COALESCE((SELECT m.resulting_balance FROM movements m WHERE m.item_id=i.id AND m.created_at < ? ORDER BY m.created_at DESC, m.id DESC LIMIT 1),0) AS opening,
          COALESCE((SELECT SUM(m.quantity) FROM movements m WHERE m.item_id=i.id AND m.direction='in' AND m.created_at >= ? AND m.created_at < ?),0) AS received,
          COALESCE((SELECT SUM(m.quantity) FROM movements m WHERE m.item_id=i.id AND m.direction='out' AND m.created_at >= ? AND m.created_at < ?),0) AS issued,
          COALESCE((SELECT m.resulting_balance FROM movements m WHERE m.item_id=i.id AND m.created_at < ? ORDER BY m.created_at DESC, m.id DESC LIMIT 1),0) AS closing
        FROM items i WHERE i.created_at < ? ORDER BY i.name COLLATE NOCASE, i.id`).bind(from, from, to, from, to, to, to).all<SummaryRow>()).results;
      const stock = (await db.prepare(`SELECT s.item_id, s.location_id, s.quantity FROM stock s WHERE s.quantity > 0`).all<{ item_id: number; location_id: number; quantity: number }>()).results;
      const locations = (await db.prepare('SELECT id, name FROM locations ORDER BY id').all<{ id: number; name: string }>()).results;
      return json({ start: range.start, end: range.end, items: rows, stock, locations });
    }
    if ((url.pathname === '/api/history' || url.pathname === '/api/history.csv') && req.method === 'GET') {
      const r = await report(db, url);
      if ('error' in r) return r.error!;
      if (url.pathname === '/api/history') return json(r);
      const lines = [['Timestamp (Europe/Malta)', 'Item', 'Barcode', 'Direction', 'Quantity', 'Location', 'To location', 'Balance at location', 'Total balance', 'Type', 'Note', 'By', 'Request ID'].map(escapeCsv).join(',')];
      const malta = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Malta', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
      for (const m of r.movements!) {
        // Excel otherwise converts zero-prefixed digit-only barcodes to numbers.
        // This formula is safe because it is used only for strictly numeric barcodes.
        const barcodeCell = /^\d+$/.test(m.barcode) ? `="${m.barcode}"` : escapeCsv(m.barcode);
        lines.push([escapeCsv(malta.format(new Date(m.created_at))), escapeCsv(m.item_name), barcodeCell, escapeCsv(m.direction), escapeCsv(m.quantity), escapeCsv(m.location_name ?? ''), escapeCsv(m.to_location_name ?? ''), escapeCsv(m.location_balance), escapeCsv(m.resulting_balance), escapeCsv(m.reason), escapeCsv(m.note), escapeCsv(m.actor), escapeCsv(m.request_id)].join(','));
      }
      const range = dates(url)!;
      return new Response('﻿' + lines.join('\r\n') + '\r\n', { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="stockroom-movements_${range.start}_to_${range.end}.csv"`, 'cache-control': 'no-store' } });
    }
    return json({ error: 'Not found' }, 404);
  } catch (err) { console.error('inventory API failed', err); return json({ error: 'Server error' }, 500); }
}

// Cross-site writes are refused for every state-changing method.
export function crossSiteWrite(req: Request, url: URL): boolean {
  if (req.method === 'GET' || req.method === 'HEAD') return false;
  return (!!req.headers.get('Origin') && req.headers.get('Origin') !== url.origin) || req.headers.get('Sec-Fetch-Site') === 'cross-site';
}
