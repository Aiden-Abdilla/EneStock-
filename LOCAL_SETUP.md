# Run Stockroom on Windows localhost

1. Install Node.js 22+ and reopen PowerShell.
2. Extract the ZIP, then open PowerShell inside the `stockroom-local-ready` folder.
3. Run `npm ci`.
4. Run `npx --yes --package=wrangler@4.45.0 wrangler d1 migrations apply stockroom-db --local --config wrangler.local.toml`.
5. Run `npx --yes --package=wrangler@4.45.0 wrangler dev --config wrangler.local.toml --local --ip 127.0.0.1`.
6. Open http://localhost:8787

This uses an isolated, local-only Worker entrypoint and a local D1 database. No Cloudflare login required. Stop with Ctrl+C. Data is stored under `.wrangler/` (do not delete it to preserve stock). The original `src/worker.ts` and `wrangler.toml` are unchanged for production. Never deploy `wrangler.local.toml` or `src/worker.local.ts` to the internet: these are unauthenticated localhost testing files.

## Updating an existing local install

When a new version adds a file under `migrations/`, stop the app (Ctrl+C), copy the new files over the old folder (keep `.wrangler\`, that's your data), then run step 4 again. It only applies the migrations you don't have yet and keeps your existing stock and history. (Version with locations: `0003_locations_categories.sql` puts all existing stock in a location called "Main store"; rename it in Inventory → Locations.) Then start the app again (step 5).
