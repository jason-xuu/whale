# 🐋 Whale Tracker

Free, self-hosted whale-tracking dashboard: options flow (CBOE), 13F institutions, Form 4 insiders, and congress trades — plus a confluence engine that converts aligned signals into falsifiable, self-scoring theses.

**Live:** https://jason-xuu.github.io/whale/

## Two ways to run it

### 1. GitHub Pages (zero install)

Open the live link above. The dashboard fetches public market data directly from the browser; where a source blocks cross-origin requests (CBOE, some SEC endpoints), it automatically falls back to public CORS relays. Slower and occasionally flaky — a banner appears when relay mode kicks in.

### 2. Local launcher (recommended — fastest, most reliable)

Download/clone this repo, then double-click **`Start Whale Tracker.command`** (macOS, Python 3 stdlib only). It serves the dashboard at `http://127.0.0.1:8742` with a tiny same-origin proxy for CBOE/SEC data — no CORS, no relays, no API credits.

## Files

- `whale-dashboard.html` — the entire app. One self-contained HTML file: 1 CSS block + 5 script blocks (shared helpers/fetch routing · options flow · EDGAR 13F + Form 4 · congress + auto-refresh · confluence engine + thesis ledger).
- `index.html` — redirect to the dashboard so GitHub Pages serves it at the repo root.
- `Start Whale Tracker.command` — macOS local server/proxy launcher.

## Data sources

| Tab | Source | Notes |
|---|---|---|
| Options Flow | CBOE delayed quotes | Free, no key, 15-min delay |
| Institutions | SEC EDGAR 13F-HR | Quarterly, up to 45-day lag |
| Insiders | SEC EDGAR Form 4 | Filed within 2 business days |
| Congress | Finnhub (free API key) | STOCK Act disclosures, up to 45-day lag |

API keys are stored in your browser's localStorage only and are never sent through any relay or proxy.

This is a research instrument, not trade advice — judge it by its own ledger.
