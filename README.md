# 🐋 Whale Tracker

Free, self-hosted whale-tracking dashboard: options flow (CBOE), 13F institutions, Form 4 insiders, and congress trades — plus a confluence engine that converts aligned signals into falsifiable, self-scoring theses.

**Live:** https://jason-xuu.github.io/whale/

## Two ways to run it

### 1. GitHub Pages (zero install)

Open the live link above. A scheduled GitHub Actions workflow (`.github/workflows/pages.yml`) snapshots CBOE option chains, SEC 13F filings, and Form 4 data into `data/` and redeploys the site every 5 minutes during US market hours — so the dashboard reads everything same-origin with no CORS proxies at all. CBOE data is 15-minute delayed at the source, so the snapshot cadence matches the data's own resolution.

Covered by snapshots: the default watchlist (`scripts/watchlist.json`), the 12 tracked funds' 13Fs, recent Form 4 filings, and per-ticker insider scans. Tickers or CIKs outside the snapshot fall back to direct fetch + public CORS relays, which usually fail for large payloads — use the local launcher for arbitrary symbols.

### 2. Local launcher (recommended — fastest, most reliable)

Download/clone this repo, then double-click **`Start Whale Tracker.command`** (macOS, Python 3 stdlib only). It serves the dashboard at `http://127.0.0.1:8742` with a tiny same-origin proxy for CBOE/SEC data — no CORS, no relays, no API credits.

## Files

- `whale-dashboard.html` — the entire app. One self-contained HTML file: 1 CSS block + 5 script blocks (shared helpers/fetch routing · options flow · EDGAR 13F + Form 4 · congress + auto-refresh · confluence engine + thesis ledger).
- `index.html` — redirect to the dashboard so GitHub Pages serves it at the repo root.
- `Start Whale Tracker.command` — macOS local server/proxy launcher.
- `scripts/build-data.mjs` + `scripts/watchlist.json` — data snapshot builder run by the Pages workflow (SEC-fair-access rate-limited; reuses the previous SEC mirror between daily refreshes).
- `.github/workflows/pages.yml` — builds snapshots and deploys the site as a Pages artifact (no data commits, no repo bloat).

## Data sources

| Tab | Source | Notes |
|---|---|---|
| Options Flow | CBOE delayed quotes | Free, no key, 15-min delay |
| Institutions | SEC EDGAR 13F-HR | Quarterly, up to 45-day lag |
| Insiders | SEC EDGAR Form 4 | Filed within 2 business days |
| Congress | Finnhub (free API key) | STOCK Act disclosures, up to 45-day lag |

API keys are stored in your browser's localStorage only and are never sent through any relay or proxy.

This is a research instrument, not trade advice — judge it by its own ledger.
