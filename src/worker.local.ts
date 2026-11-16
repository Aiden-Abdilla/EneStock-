// LOCAL-ONLY entrypoint for `wrangler dev --local` on your own PC.
// Authentication is intentionally skipped, so it refuses anything that isn't
// localhost. Production uses src/worker.ts, which enforces Cloudflare Access.
// Never deploy this file or wrangler.local.toml.
import { handleApi, crossSiteWrite, json, type Env } from './api.ts';
export { maltaMidnight, dates, escapeCsv } from './api.ts';

async function handler(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return json({ error: 'Local test only.' }, 403);
  if (crossSiteWrite(req, url)) return json({ error: 'Cross-site writes are not permitted.' }, 403);
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json({ error: 'Method not allowed' }, 405);
    return env.ASSETS.fetch(req);
  }
  // Locally there is no login; the app sends the name chosen on this PC.
  const name = decodeURIComponent(req.headers.get('X-Stockroom-User') || '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 60) || null;
  return handleApi(req, env, url, { name, source: 'local' });
}
export default { fetch: handler };
