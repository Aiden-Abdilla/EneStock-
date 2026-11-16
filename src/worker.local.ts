interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
interface D1Database { prepare(sql: string): D1Statement; }
interface Env {
  DB: D1Database;
  ASSETS: { fetch(request: Request): Promise<Response> };
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
}
type Item = { id: number; name: string; barcode: string; quantity: number };
type Movement = { id: number; request_id: string; item_name: string; barcode: string; direction: 'in'|'out'; quantity: number; resulting_balance: number; created_at: string };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
});
function bytes64(s: string): Uint8Array {
  const normalized = s.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(bytes, (v) => v.charCodeAt(0));
}
const decoder = new TextDecoder();
type Jwk = JsonWebKey & { kid?: string };
let keyCache: { issuer: string; until: number; keys: Jwk[] } | undefined;
async function authenticate(req: Request, env: Env): Promise<boolean> {
  const issuer = env.CF_ACCESS_TEAM_DOMAIN?.replace(/\/$/, '');
  const aud = env.CF_ACCESS_AUD;
  if (!issuer?.startsWith('https://') || issuer.includes('REPLACE_') || !aud || aud.includes('REPLACE_')) return false;
  const jwt = req.headers.get('Cf-Access-Jwt-Assertion');
  if (!jwt) return false;
  const parts = jwt.split('.');
  if (parts.length !== 3) return false;
  try {
    const header = JSON.parse(decoder.decode(bytes64(parts[0]))) as { alg?: string; kid?: string; typ?: string };
    const payload = JSON.parse(decoder.decode(bytes64(parts[1]))) as { iss?: string; aud?: string | string[]; exp?: number; nbf?: number };
    const now = Math.floor(Date.now() / 1000);
    if (header.alg !== 'RS256' || !header.kid || payload.iss !== issuer || !payload.exp || payload.exp <= now || (payload.nbf && payload.nbf > now) || !(Array.isArray(payload.aud) ? payload.aud.includes(aud) : payload.aud === aud)) return false;
    if (!keyCache || keyCache.issuer !== issuer || keyCache.until < Date.now()) {
      const certs = await fetch(`${issuer}/cdn-cgi/access/certs`, { cf: { cacheTtl: 300 } } as RequestInit);
      if (!certs.ok) return false;
      const body = await certs.json() as { keys?: Jwk[] };
      if (!Array.isArray(body.keys)) return false;
      keyCache = { issuer, until: Date.now() + 300_000, keys: body.keys };
    }
    const jwk = keyCache.keys.find((k) => k.kid === header.kid && k.kty === 'RSA');
    if (!jwk) return false;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, bytes64(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch { return false; }
}
function dates(url: URL): { start: string; end: string } | null {
  const start = url.searchParams.get('start');
  const end = url.searchParams.get('end');
  const valid = (d: string | null) => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0,10) === d;
  if (!valid(start) || !valid(end) || start! > end!) return null;
  return { start: start!, end: end! };
}
// Malta is CET/CEST; derive each local midnight by iterative Intl conversion,
// rather than assuming a fixed UTC offset (DST changes are handled).
function maltaMidnight(date: string): string {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Malta', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const target = Date.parse(`${date}T00:00:00Z`);
  let instant = target - 3600_000;
  for (let i=0;i<4;i++) {
    const values = Object.fromEntries(format.formatToParts(new Date(instant)).filter(x=>x.type !== 'literal').map(x=>[x.type,x.value]));
    const localAsUtc = Date.parse(`${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:00Z`);
    instant += target - localAsUtc;
  }
  return new Date(instant).toISOString();
}
function nextDate(date: string): string { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0,10); }
function escapeCsv(v: string|number): string { const s=String(v); const safe = /^[=+@\-\t\r]/.test(s) ? `'${s}` : s; return `"${safe.replaceAll('"','""')}"`; }
const columns = 'id, request_id, item_name, barcode, direction, quantity, resulting_balance, created_at';
async function report(db: D1Database, url: URL) {
  const range = dates(url);
  if (!range) return { error: json({ error: 'Use valid start and end dates (YYYY-MM-DD), start no later than end.' }, 400) };
  const from = maltaMidnight(range.start), to = maltaMidnight(nextDate(range.end));
  const movements = (await db.prepare(`SELECT ${columns} FROM movements WHERE created_at >= ? AND created_at < ? ORDER BY created_at, id`).bind(from, to).all<Movement>()).results;
  const totals = { received: movements.filter(m=>m.direction==='in').reduce((a,m)=>a+m.quantity,0), issued: movements.filter(m=>m.direction==='out').reduce((a,m)=>a+m.quantity,0) };
  return { movements, totals };
}
async function handler(req: Request, env: Env): Promise<Response> {
  // Authenticate *before* assets and APIs, including HEAD, OPTIONS and errors.
  // LOCAL-ONLY entrypoint: authentication is intentionally skipped in Wrangler's localhost test.
  // Production continues to use src/worker.ts, which enforces Cloudflare Access.
  if (new URL(req.url).hostname !== 'localhost' && new URL(req.url).hostname !== '127.0.0.1')
    return json({ error: 'Local test only.' }, 403);
  const url = new URL(req.url);
  if (req.method === 'POST' && ((req.headers.get('Origin') && req.headers.get('Origin') !== url.origin) || req.headers.get('Sec-Fetch-Site') === 'cross-site')) return json({ error: 'Cross-site writes are not permitted.' }, 403);
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json({error:'Method not allowed'},405);
    return env.ASSETS.fetch(req);
  }
  try {
    if (url.pathname === '/api/items' && req.method === 'GET') {
      const search = (url.searchParams.get('q')||'').trim();
      const results = (await env.DB.prepare('SELECT id, name, barcode, quantity FROM items WHERE name LIKE ? OR barcode LIKE ? ORDER BY name, id LIMIT 1000').bind(`%${search}%`, `%${search}%`).all<Item>()).results;
      return json({ items: results });
    }
    if (url.pathname === '/api/items' && req.method === 'POST') {
      const input = await req.json() as {name?:unknown;barcode?:unknown};
      const name = typeof input.name==='string' ? input.name.trim() : '';
      const barcode = typeof input.barcode==='string' ? input.barcode.trim() : '';
      if (name.length<1 || name.length>200 || barcode.length<1 || barcode.length>128) return json({error:'Name and barcode are required (max 200 and 128 characters).'},400);
      try { await env.DB.prepare('INSERT INTO items (name, barcode) VALUES (?,?)').bind(name,barcode).run(); }
      catch { return json({error:'Barcode is already registered, or item is invalid.'},409); }
      return json({item: await env.DB.prepare('SELECT id,name,barcode,quantity FROM items WHERE barcode=?').bind(barcode).first<Item>()},201);
    }
    if (url.pathname === '/api/scan' && req.method === 'POST') {
      const input = await req.json() as {barcode?:unknown;direction?:unknown;requestId?:unknown};
      const barcode = typeof input.barcode==='string'?input.barcode.trim():'';
      const direction = input.direction;
      const requestId = input.requestId;
      if (!barcode || barcode.length>128 || (direction!=='in' && direction!=='out') || typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/i.test(requestId)) return json({error:'Valid barcode, direction and UUID requestId required.'},400);
      const prior = await env.DB.prepare(`SELECT ${columns} FROM movements WHERE request_id = ?`).bind(requestId).first<Movement>();
      if (prior) return prior.barcode===barcode && prior.direction===direction ? json({movement: prior, duplicate:true}) : json({error:'Request ID already used for a different scan.'},409);
      // SQLite executes this INSERT and its AFTER INSERT inventory UPDATE trigger
      // atomically; concurrent writes serialize. Zero-stock out inserts no row.
      try {
        await env.DB.prepare(`INSERT INTO movements (request_id,item_id,item_name,barcode,direction,quantity,resulting_balance)
          SELECT ?, id, name, barcode, ?, 1, quantity + CASE WHEN ? = 'in' THEN 1 ELSE -1 END
          FROM items WHERE barcode = ? AND (? = 'in' OR quantity > 0)`).bind(requestId,direction,direction,barcode,direction).run();
      } catch (err) {
        const existing = await env.DB.prepare(`SELECT ${columns} FROM movements WHERE request_id=?`).bind(requestId).first<Movement>();
        if (existing) return existing.barcode===barcode && existing.direction===direction ? json({movement:existing,duplicate:true}) : json({error:'Request ID already used for a different scan.'},409);
        return json({error:'Could not record scan. Please check inventory and try again with the same request ID.'},503);
      }
      const movement = await env.DB.prepare(`SELECT ${columns} FROM movements WHERE request_id=?`).bind(requestId).first<Movement>();
      if (movement) return json({movement, duplicate:false});
      const item = await env.DB.prepare('SELECT quantity FROM items WHERE barcode=?').bind(barcode).first<{quantity:number}>();
      return item ? json({error:'Cannot withdraw: stock is already zero.'},409) : json({error:'Unknown barcode. Register item first.'},404);
    }
    if ((url.pathname==='/api/history' || url.pathname==='/api/history.csv') && req.method==='GET') {
      const r = await report(env.DB,url);
      if ('error' in r) return r.error!;
      if (url.pathname==='/api/history') return json(r);
      const lines = [['Timestamp (Europe/Malta)','Item','Barcode','Direction','Quantity','Resulting balance','Request ID'].map(escapeCsv).join(',')];
      const malta = new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Malta',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
      for (const m of r.movements!) {
        // Excel otherwise converts zero-prefixed digit-only barcodes to numbers.
        // This formula is safe because it is used only for strictly numeric barcodes.
        const barcodeCell = /^\d+$/.test(m.barcode) ? `=\"${m.barcode}\"` : escapeCsv(m.barcode);
        lines.push([escapeCsv(malta.format(new Date(m.created_at))),escapeCsv(m.item_name),barcodeCell,escapeCsv(m.direction),escapeCsv(m.quantity),escapeCsv(m.resulting_balance),escapeCsv(m.request_id)].join(','));
      }
      return new Response('\uFEFF'+lines.join('\r\n')+'\r\n',{headers:{'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="stockroom-movements.csv"','cache-control':'no-store'}});
    }
    return json({error:'Not found'},404);
  } catch (err) { console.error('inventory API failed',err); return json({error:'Server error'},500); }
}
export default { fetch: handler };
export { maltaMidnight, dates, escapeCsv };
