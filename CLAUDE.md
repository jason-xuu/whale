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

## Quant layer (script blocks 2 + 5, added 2026-07)

- **Aggressor inference**: last trade within 20% of the ask → buyer-initiated (+1), of the bid →
  seller-initiated (−1), else unclassified (0). Stored per row as `sideSign`. Flow direction blends
  aggressor-signed premium (w2) + net delta-adjusted flow / gross delta (w2) + naive premium split (w1);
  degrades gracefully to naive when <30% of premium classifies.
- **GEX**: gamma is NOT in the CBOE feed — computed via Black-Scholes from each contract's own IV
  (r=4%). Convention: calls +, puts − (dealer-long-calls/short-puts naive assumption), $ per 1% move.
- **Skew/term**: 25Δ put IV − 25Δ call IV (front expiry, 2–95 DTE); term = front ATM − next ATM in
  vol pts (positive = inverted). Both feed the cross-exam with itemized deductions.
- **Baselines**: `wt_baseline` in localStorage — per ticker, one record/day, 60 kept, of
  {nd, pc, sk, gx, iv}. `zScore()` needs ≥5 prior days; z shown in MARKET STRUCTURE + used in
  cross-exam and flow unusualness bonus. Identical seeded values ⇒ sd=0 ⇒ z null (tests must vary).
- **Conviction weights**: 13F entries carry `pct` (value / fund's total book) → per-fund weight
  clamp(0.5 + 25·pct, 0.5, 2). Insider buyerTitles/sellerTitles from Form 4 XML; C-suite regex
  /chief|ceo|cfo|coo|president/i gets 1.5× buyer weight; ≥3 buyers = CLUSTER BUY badge.
- **Confidence tier**: HIGH needs active≥3 ∧ agreement≥0.7 ∧ adj≥40 ∧ counter≤8; MEDIUM active≥2 ∧
  agreement≥0.55 ∧ adj≥22; else LOW (gates sizing language in recMove).
- **recMove edge test**: market past-breakeven prob (N(d2) at breakeven) vs ledger's Laplace-smoothed
  hit rate ((w+1)/(n+2)); needs ≥10 resolved theses; positive edge → half-Kelly capped at 5%.
  All-aligned-prints-sold-at-bid ⇒ premium-selling flow ⇒ route to shares, never mirror a seller.
  IV > 1.25× next-expiry ATM ⇒ debit-spread alt with a real short leg from `chain.legs`.
- Testing bar is now 59 jsdom assertions (scratchpad test-static.js pattern) — keep invariants:
  |signedPrem| ≤ classPrem ≤ callPrem+putPrem; sideSign ∈ {−1,0,1}; pct ∈ (0,1]; rec contract must
  exist in flowState.rows; Kelly text only with ≥10 graded.
- **Hedge screening (default ON, `wt_hedges` toggle mirrored on flow+conf tabs)**: `classifyHedge()`
  tags index/ETF puts bought (BROAD_HEDGE_TICKERS reference set), index calls sold, and ≤0.10Δ
  bought puts as insurance — excluded from whale prints/flowByT and never tier 0/1; stats always
  disclose count+premium. 13F puts with same-fund long stock get `married=true` (excluded from inst
  dir + cross-exam unless toggle). Form 4 `aff10b5One` → `planned` (excluded from buy/sell tallies,
  tracked in plannedBuyVal/SellVal, badged in insiders tab). Toggle ON = count everything, tagged.
- **Accuracy audit (2026-07)**: sided netDelta added (`netDeltaSided`/`classDelta` over aggressor-
  classified volume) — buyer-assumed netDelta stays as downweighted fallback; the two can DISAGREE
  in sign (NVDA 07-08: +1.34B unsided vs −1.51B sided — sided wins). Kelly fixed to
  f* = edge/(1−p_mkt), half applied, 5% cap. agreeW counts only |dir|≥0.1 sources (neutral =
  abstain). z-bonus requires dir≠0 and sign match; sided z stored as `nds` in baselines.
- **Freshness**: Pages snapshots every 5 min market hours (CBOE itself 15-min delayed). With a
  Finnhub key, spots (rows.spot/otm, spotOf, ledger pricing) upgrade to real-time REST quotes
  (relay:false, never proxied); chain analytics keep the snapshot spot for greek consistency.
  Conf tab is the primary (leftmost, default) view; "Data freshness" stat disclosès feed time +
  spot source.
- **Tests**: `tests/test-static.js` (78 assertions, integration) and `tests/test-verify-math.js`
  (32 assertions — independent erf-based BS recompute, raw-JSON chain-analytics re-accumulation,
  thesis consistency invariants, Kelly formula fixtures). Run:
  `npm i jsdom && node tests/test-static.js whale-dashboard.html <site-dir>` where site-dir holds
  a data/ snapshot built by scripts/build-data.mjs.
