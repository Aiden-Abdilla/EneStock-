# Stockroom — Cloudflare Worker + D1

A single-screen inventory app with no Docker, VM, WSL, or local application server. A scanner in USB HID keyboard mode types a barcode followed by Enter; you can also type into the scan box. Frontend and API run on one Cloudflare Worker, and D1 stores items and movements. No existing InvenTree instance is needed.

## Features

- Search items by name/barcode; register unique text barcodes at stock = 0.
- Explicit Stock In or Stock Out mode; one unit per Enter; mode stays selected. The scan box clears and refocuses.
- Unknown/zero-balance scans create no movements. Unique UUID per intentional scan is idempotent on retry.
- One SQLite `INSERT ... SELECT` and its `AFTER INSERT` trigger atomically update stock and create history. A conditional `quantity > 0` prevents stock-out below zero, even with concurrent writers. The `request_id` uniqueness constraint prevents duplicate writes.
- Malta time-zone date boundaries and display, DST-aware, inclusive end date; CSV export uses same query as screen. Digit-only barcodes are wrapped in an Excel-friendly text formula; other values are CSV-escaped and guarded against spreadsheet formula injection.
- Access JWT validated **at the Worker** for every file and API route (in addition to Cloudflare Access edge policy). No authentication bypass for `.workers.dev` or preview URLs: both are disabled in Wrangler. Configure only one intended custom domain and audit any extra routes.

## Prerequisites

Cloudflare account with a zone/domain, Cloudflare Zero Trust (Access), Cloudflare Workers + D1 enabled, GitHub repository, Node.js 22+ and npm on your Windows machine for local CLI commands, and a barcode scanner configured as **USB HID keyboard** with **Enter suffix**. No Docker or local web server needed to use the deployed app.

> **Tool installation:** The app has zero runtime npm dependencies. To avoid an unverified dependency lockfile in this offline-generated starter, the checked-in npm lockfile is minimal and commands fetch explicitly pinned TypeScript `5.9.3` and Wrangler `4.45.0` using `npx`. GitHub Actions requires network access and runs `npm ci` first. For stricter reproducibility, install the two as dev dependencies and commit an npm-generated transitive package-lock.json before production use.

## Step 1 — Put source in GitHub

Copy the full repository contents to your chosen GitHub repo, commit, and push to `main`. The `.github/workflows/ci.yml` action tests PRs and tests/deploys pushes to `main` when secrets are configured.

## Step 2 — Create D1 and edit Wrangler binding

Sign into Cloudflare Dashboard > Storage & databases > D1 > Create database; name it **`stockroom-db`**. Copy its **database UUID** into `wrangler.toml` under `[[d1_databases]]` as `database_id`. The binding must remain `DB`.

From a Windows PowerShell terminal in this project folder (requires Node 22+), authenticate locally:

```powershell
npx --yes --package=wrangler@4.45.0 wrangler login
npm ci
npm run migrate:remote
```

The `migrations/0001_inventory.sql` migration creates items, movements, constraints, indexes and the atomic stock-update trigger.

## Step 3 — Secure custom hostname with Access

1. Use a Cloudflare-managed domain, e.g. `stock.example.com` (replace with your own). In Cloudflare Workers > your Worker > Settings > Domains & Routes, add **Custom Domain** `stock.example.com`. Don't enable other public routes.
2. In Cloudflare Zero Trust > Access controls > Applications > Add an application > **Self-hosted**, set its hostname to `stock.example.com`, and add an **Allow** policy for only your chosen users/emails/identity group. Enable your preferred identity method and MFA. Make sure the application protects **all paths**, including `/api/*` and assets.
3. Open that Access app > Additional settings and copy the **Application Audience (AUD) tag**. Find your Zero Trust **team domain**, e.g. `https://myteam.cloudflareaccess.com`.
4. Set `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` in the `[vars]` section of `wrangler.toml`; these are identifiers, not passwords. For production you may set them with deployment-specific configuration. Do **not** include personal API tokens, keys, or passwords in this file.
5. `workers_dev = false` and `preview_urls = false` in Wrangler turn off the two alternate hostnames. Review dashboard configuration for stale deployments and additional custom domains/routes. The Worker checks signed Access JWTs **on every request**, so even a newly exposed hostname cannot bypass the correct application AUD validation.
6. For added defense, set Cloudflare Access policy to require MFA and review user/group membership regularly.

**Important:** Configure the Access application **before** using the deployment; unconfigured auth variables cause all requests to return HTTP 401, including static files. Do not temporarily disable JWT enforcement to test in production.

## Step 4 — Set up GitHub deployment secrets

GitHub repository > Settings > Secrets and variables > Actions > New repository secret:

- `CLOUDFLARE_API_TOKEN`: scoped API token permitted to edit Workers scripts and D1 (least privilege).
- `CLOUDFLARE_ACCOUNT_ID`: account ID from the Cloudflare dashboard.

The workflow automatically runs `npm ci`, TypeScript check and SQL tests, applies D1 migrations remotely, and deploys on a successful push to `main`. Pull requests only test. GitHub Actions must be enabled for the repo. `wrangler.toml` must include the real database UUID and Access settings before the first deploy. Keep tokens in GitHub secrets and do not commit `.dev.vars`, API keys or session cookies.

To deploy manually after completing the configuration:

```powershell
npm ci
npm run typecheck
npm test
npm run migrate:remote
npm run deploy
```

Open `https://stock.example.com` (replace with your real hostname), sign in with Cloudflare Access, and verify the UI.

## Step 5 — Use barcode scanner

Register an item from the **Register Item** form. Scan a barcode into that form, or type it. Select **Stock In** and click the scan field: scanning `001234` + Enter records +1. Select **Stock Out** for -1. The scan field stays active after each result. Each Enter gets a new `crypto.randomUUID()` request ID; the API accepts an identical request ID again without double-counting. If implementing network retries later, reuse the **same** request ID for that specific intent.

## Reporting

Choose Start date and End date and press Apply dates. Bounds are midnight-to-midnight in `Europe/Malta`, including the entire end date even on DST transition days. **Export CSV** uses the exact same date criteria and movement query, with an Excel-compatible BOM and CRLF. Date ranges are currently loaded up to available D1 result size; add server-side pagination for a high-volume production inventory.

## Validation checklist

```powershell
npm test
npm run typecheck
```

The tests cover registering `001234`, 3 receipts + 1 issue => **2 on hand** and **4 movements** in the date-range CSV, unknown barcode, zero-stock issue, repeated request ID, two genuinely concurrent SQLite connections withdrawing the last unit, malformed Access tokens/unauthenticated routes and Malta daylight-saving boundaries. Run additional post-deploy integration checks against an Access-authenticated Worker/D1 before treating the system as production-ready. The integration test should compare CSV with history for the chosen dates, check Access-denied requests against `/`, `/app.js`, `/api/items` and `/api/history.csv`, and verify `.workers.dev` / preview URLs are unavailable.

## Architecture

`public/` contains HTML/CSS/browser JavaScript; `src/worker.ts` validates Access JWT then serves assets or handles API; `migrations/` initializes D1; `tests/` tests the schema and scan SQL. Barcodes and names are retained as text. D1 movements snapshot item name/barcode at the time of scanning, so later changes don't rewrite history.

## Limitations

Only **successful** movements are stored; failed scans leave history untouched. No user administration, audit of unsuccessful scan attempts, bulk imports, backups, or multi-store support. No guaranteed disaster-recovery process: configure and periodically test D1 backups/export separately. Browser UI and live D1 end-to-end tests require deployment and authenticated Cloudflare account access.

