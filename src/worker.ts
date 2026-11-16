import { handleApi, crossSiteWrite, json, type Env } from './api.ts';
export { maltaMidnight, dates, escapeCsv, cleanBarcode } from './api.ts';

const decoder = new TextDecoder();
function bytes64(s: string): Uint8Array<ArrayBuffer> {
  const normalized = s.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(bytes, (v) => v.charCodeAt(0));
}
type Jwk = JsonWebKey & { kid?: string };
let keyCache: { issuer: string; until: number; keys: Jwk[] } | undefined;
// Returns the signed-in user's email (or a non-empty marker) when the Access JWT is valid, else null.
async function authenticate(req: Request, env: Env): Promise<string | null> {
  const issuer = env.CF_ACCESS_TEAM_DOMAIN?.replace(/\/$/, '');
  const aud = env.CF_ACCESS_AUD;
  if (!issuer?.startsWith('https://') || issuer.includes('REPLACE_') || !aud || aud.includes('REPLACE_')) return null;
  const jwt = req.headers.get('Cf-Access-Jwt-Assertion');
  if (!jwt) return null;
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(decoder.decode(bytes64(parts[0]))) as { alg?: string; kid?: string; typ?: string };
    const payload = JSON.parse(decoder.decode(bytes64(parts[1]))) as { iss?: string; aud?: string | string[]; exp?: number; nbf?: number; email?: string; sub?: string };
    const now = Math.floor(Date.now() / 1000);
    if (header.alg !== 'RS256' || !header.kid || payload.iss !== issuer || !payload.exp || payload.exp <= now || (payload.nbf && payload.nbf > now) || !(Array.isArray(payload.aud) ? payload.aud.includes(aud) : payload.aud === aud)) return null;
    if (!keyCache || keyCache.issuer !== issuer || keyCache.until < Date.now()) {
      const certs = await fetch(`${issuer}/cdn-cgi/access/certs`, { cf: { cacheTtl: 300 } } as RequestInit);
      if (!certs.ok) return null;
      const body = await certs.json() as { keys?: Jwk[] };
      if (!Array.isArray(body.keys)) return null;
      keyCache = { issuer, until: Date.now() + 300_000, keys: body.keys };
    }
    const jwk = keyCache.keys.find((k) => k.kid === header.kid && k.kty === 'RSA');
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const signature = Uint8Array.from(bytes64(parts[2])).buffer;
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    return ok ? (payload.email || payload.sub || 'signed-in user') : null;
  } catch { return null; }
}
async function handler(req: Request, env: Env): Promise<Response> {
  // Authenticate *before* assets and APIs, including HEAD, OPTIONS and errors.
  const user = await authenticate(req, env);
  if (!user) return json({ error: 'Cloudflare Access authentication required.' }, 401);
  const url = new URL(req.url);
  if (crossSiteWrite(req, url)) return json({ error: 'Cross-site writes are not permitted.' }, 403);
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json({ error: 'Method not allowed' }, 405);
    return env.ASSETS.fetch(req);
  }
  // The actor comes only from the verified JWT, never from anything the browser sends.
  return handleApi(req, env, url, { name: user, source: 'access' });
}
export default { fetch: handler };
