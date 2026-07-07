# Whale Tracker

Free, self-hosted whale-tracking dashboard: options flow, 13F institutions, Form 4 insiders,
congress trades, plus a confluence engine that converts aligned signals into falsifiable,
self-scoring theses.

## Files

- `whale-dashboard.html` — the entire app. Single file: 1 CSS block + 5 `<script>` blocks
  (1: shared helpers/fetch/relay/proxy routing · 2: options flow · 3: EDGAR 13F + Form 4 ·
  4: congress via Finnhub + auto-refresh · 5: confluence engine + thesis ledger).
- `Start Whale Tracker.command` — macOS launcher. Serves the dashboard at `http://127.0.0.1:8742-8752`
  and proxies `/proxy?url=` to an allowlist (`cdn.cboe.com`, `efts.sec.gov`, `data.sec.gov`, `www.sec.gov`).
  **Required for options data** — see CORS note below. Python 3 stdlib only.

## Data sources & hard-won quirks (do not rediscover these)

- **CBOE delayed quotes** `cdn.cboe.com/api/global/delayed_quotes/options/{SYM}.json`:
  free, no key, 15-min delay. **Sends no `Access-Control-Allow-Origin` header** — browser fetch
  fails from any origin; must go through the launcher's local proxy. Public CORS relays mostly
  fail too (403 for `null` origin). Index symbols need an underscore prefix in the URL (`_SPX`),
  handled by `INDEX_MAP`. `iv` is a decimal fraction (0.79 = 79%). `volume`/`open_interest`
  arrive as floats. OI is prior-session (OCC updates overnight) — vol/OI > 1 means fresh positioning.
  The CDN occasionally serves stale snapshots; the UI warns when the feed timestamp is >5 days old.
- **OCC option symbols**: `ROOT + YYMMDD + C|P + strike*1000 (8 digits)`, parsed by
  `parseOptionSymbol` (regex allows leading `_` and weekly roots like SPXW).
- **SEC EDGAR full-text search** `efts.sec.gov/LATEST/search-index`: accepts **empty q** with
  `forms=4&dateRange=custom&startdt&enddt&from={0,10,...}` (10 hits/page). Hit `_id` =
  `adsh:filename` — when filename ends `.xml` you can fetch the Form 4 XML directly, skipping index.json.
- **13F infotables**: `value` is **whole dollars** (post-2023 rule; verified to-the-dollar against
  NVDA/PLTR positions in Scion's filing). Holdings XML may be namespaced (`ns1:infoTable`) —
  parse with the prefix-tolerant regex in `fetch13FHoldings`, not DOMParser (files reach several MB).
  Issuer names ≠ tickers: match via `normName()` against `www.sec.gov/files/company_tickers.json`.
- **SEC fair access**: keep fetch concurrency ≤4-5 (the `pool()` helper), identify with a UA in the proxy.
- **Finnhub congress endpoint**: needs free API key; key must never route through relays/proxy
  (`relay:false` in fetchJSON does this).

## Confluence engine (script block 5)

Weighted, documented scoring: options 35 / insiders 30 / institutions 20 / congress 15,
normalized to available sources. Cross-examination subtracts itemized counter-evidence
(insider sales vs bullish flow, fund puts, QoQ TRIMMED/EXITED positions — 13F indexer diffs the
two latest 13F-HRs per fund), capped at 20 pts. Directional rows emit theses: outperform/underperform
SPY over 14/21/30d with invalidation at the dominant whale strike. `logScan()` snapshots entry
prices to localStorage (`wt_ledger`); `resolveDue()` grades matured theses vs SPY. Implied odds =
Black-Scholes N(d2) from the whale contract's own IV (`cnd`/`impliedOdds`).

## Testing (keep this bar)

- Syntax: extract script blocks (`re.findall(r'<script>(.*?)</script>', html, re.S)`) → `node --check` each.
- Integration: jsdom with `runScripts:'dangerously'`, `url:'http://127.0.0.1:8742/...'` (activates
  proxy-mode fetch), mock `window.fetch` with fixtures, drive `runConfluence()`/`logScan()`/`resolveDue()`
  via `window.eval` (top-level `const` doesn't attach to window). End with `process.exit(0)` — the
  app's `setInterval` otherwise keeps node alive. Last run: 18/18 passing.
- Financial math: verify notional/vol-OI by hand; check delta/IV/price coherence via Black-Scholes.

## Known limitations (documented in-UI, keep honest)

Notional = volume × last price (approximation; true premium needs paid per-trade data).
Delayed aggregate data can't attribute trade direction (buy vs sell). 13F lags ≤45d (positioning,
not timing). Congress disclosures lag ≤45d. localStorage ledger is per-origin — port changes
(8742→8743 on conflict) move the origin; export CSV for durability.
