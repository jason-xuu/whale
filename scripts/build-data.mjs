#!/usr/bin/env node
/* Build same-origin data snapshots for the GitHub Pages deployment.
   The dashboard's staticPath() maps live API URLs to these files, so the
   Pages site needs no CORS proxy for its default watchlist.

   MODE=full  — refresh everything (CBOE + all SEC mirrors). Used on push,
                manual dispatch, and the daily pre-market cron.
   MODE=cboe  — refresh CBOE chains/quotes + latest Form 4 list pages
                (small), reuse the rest of the SEC mirror from the live
                site if it is <26h old; incremental-fetch only new Form 4
                XMLs. Used by the every-15-min market-hours cron.

   Output layout under OUT (default _site/data):
     cboe/options/{SYM}.json        cboe/quotes/{SYM}.json
     sec/company_tickers.json       sec/submissions/CIK##########.json
     sec/edgar/{cik}/{adsh}/{file}  sec/form4-recent-{from}.json
     sec/form4-{TICKER}-{from}.json sec/manifest.json
     meta.json
*/
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const MODE = process.env.MODE === 'cboe' ? 'cboe' : 'full';
const OUT = process.env.OUT || '_site/data';
const SITE_BASE = (process.env.SITE_BASE || 'https://jason-xuu.github.io/whale').replace(/\/$/, '');
const SEC_UA = 'WhaleTracker/1.0 (personal research dashboard; contact jxu5041@gmail.com)';

const WATCHLIST = JSON.parse(await readFile(new URL('./watchlist.json', import.meta.url), 'utf8'));
const FUNDS = [ // must match the FUNDS list in whale-dashboard.html
  ['Berkshire Hathaway', 1067983], ['Citadel Advisors', 1423053], ['Renaissance Tech', 1037389],
  ['Bridgewater', 1350694], ['Pershing Square', 1336528], ['Scion (Burry)', 1649339],
  ['ARK Invest', 1697748], ['Duquesne (Druckenmiller)', 1536411], ['Tiger Global', 1167483],
  ['Third Point', 1040273], ['Baupost', 1061768], ['Soros Fund Mgmt', 1029160]
];

const written = new Set();          // sec/* paths written this run (manifest)
let failures = 0, cboeOk = 0;

/* SEC fair access: stay well under 10 req/s across ALL sec.gov hosts,
   and back off hard on 429 (their throttle blocks for minutes if pushed). */
const sleep = ms => new Promise(res => setTimeout(res, ms));
let secNext = 0;
async function secGate() {
  const now = Date.now();
  const at = Math.max(now, secNext);
  secNext = at + 250; // ≤4 req/s
  if (at > now) await sleep(at - now);
}
async function fetchBody(url, {timeout = 60000, retries = 3} = {}) {
  const isSec = /\.sec\.gov\//.test(url);
  for (let i = 0; ; i++) {
    if (isSec) await secGate();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(url, {signal: ctrl.signal, headers: {'User-Agent': SEC_UA, 'Accept': 'application/json, text/xml, */*'}});
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (i >= retries) throw e;
      if (/HTTP 429/.test(e.message)) { console.error(`  429 on ${url} — backing off ${30 * (i + 1)}s`); await sleep(30000 * (i + 1)); }
      else if (/HTTP 5\d\d/.test(e.message)) await sleep(3000 * (i + 1)); // efts throws transient 500s
      else await sleep(800 * (i + 1));
    } finally { clearTimeout(t); }
  }
}
/* Last resort for a failed fetch: copy the previous deploy's version of this
   file from the live site, so one flaky SEC response never ships a 404 hole. */
async function saveOrSalvage(url, rel, opts) {
  try { const b = await fetchBody(url, opts); await save(rel, b); return b; }
  catch (e) {
    try {
      const b = await fetchBody(`${SITE_BASE}/data/${rel}`, {retries: 1, timeout: 60000});
      await save(rel, b);
      console.error(`  SALVAGED ${rel} from previous deploy (${e.message})`);
      return b;
    } catch (e2) { failures++; console.error(`  FAIL ${rel}: ${e.message}`); return null; }
  }
}
async function save(rel, buf) {
  const p = join(OUT, rel);
  await mkdir(dirname(p), {recursive: true});
  await writeFile(p, buf);
  if (rel.startsWith('sec/')) written.add(rel);
}
async function mirror(url, rel, opts) {
  try { await save(rel, await fetchBody(url, opts)); return true; }
  catch (e) { failures++; console.error(`  FAIL ${rel}: ${e.message}`); return false; }
}
async function pool(items, worker, limit) {
  let i = 0;
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => {
    while (i < items.length) { const idx = i++; await worker(items[idx], idx); }
  }));
}
const d = x => x.toISOString().slice(0, 10);
const today = new Date(), day5 = new Date(Date.now() - 5 * 864e5), day90 = new Date(Date.now() - 90 * 864e5);

/* ---------- CBOE (every run) ---------- */
async function buildCboe() {
  console.log(`CBOE: ${WATCHLIST.length} chains + quotes`);
  await pool(WATCHLIST, async sym => {
    if (await mirror(`https://cdn.cboe.com/api/global/delayed_quotes/options/${sym}.json`, `cboe/options/${sym}.json`)) cboeOk++;
  }, 4);
  const quoteSyms = [...new Set([...WATCHLIST, 'SPY'])];
  await pool(quoteSyms, sym =>
    mirror(`https://cdn.cboe.com/api/global/delayed_quotes/quotes/${sym}.json`, `cboe/quotes/${sym}.json`), 4);
}

/* ---------- Form 4 recent list (every run) + incremental filing XMLs ---------- */
function filingsFromPages(pages) {
  const seen = new Set(), out = [];
  for (const buf of pages) {
    if (!buf) continue;
    let j; try { j = JSON.parse(buf); } catch (e) { continue; }
    for (const h of (j.hits && j.hits.hits) || []) {
      const s = h._source;
      if (seen.has(s.adsh)) continue;
      seen.add(s.adsh);
      out.push({adsh: s.adsh, cik: s.ciks[s.ciks.length - 1], fileDate: s.file_date || '', docId: (h._id.split(':')[1] || '')});
    }
  }
  // newest first — the dashboard sorts by fileDate and parses from the top,
  // so mirror coverage must follow date order, not page order
  return out.sort((a, b) => b.fileDate.localeCompare(a.fileDate));
}
async function mirrorFiling(f) {
  const cikN = parseInt(f.cik, 10), acc = f.adsh.replace(/-/g, '');
  const base = `sec/edgar/${cikN}/${acc}`;
  const dir = `https://www.sec.gov/Archives/edgar/data/${cikN}/${acc}`;
  if (/\.xml$/i.test(f.docId)) {
    if (written.has(`${base}/${f.docId}`)) return;
    await mirror(`${dir}/${f.docId}`, `${base}/${f.docId}`);
  } else {
    if (written.has(`${base}/index.json`)) return;
    const ok = await mirror(`${dir}/index.json`, `${base}/index.json`);
    if (!ok) return;
    try {
      const idx = JSON.parse(await readFile(join(OUT, `${base}/index.json`), 'utf8'));
      const x = (idx.directory.item || []).find(i => /\.xml$/i.test(i.name));
      if (x && !written.has(`${base}/${x.name}`)) await mirror(`${dir}/${x.name}`, `${base}/${x.name}`);
    } catch (e) { failures++; }
  }
}
async function buildForm4Recent() {
  console.log('SEC: Form 4 recent list (15 pages) + filing XMLs');
  const pages = [];
  await pool(Array.from({length: 15}, (_, i) => i * 10), async from => {
    const url = `https://efts.sec.gov/LATEST/search-index?q=&forms=4&dateRange=custom&startdt=${d(day5)}&enddt=${d(today)}&from=${from}`;
    pages[from / 10] = await saveOrSalvage(url, `sec/form4-recent-${from}.json`);
  }, 4);
  await pool(filingsFromPages(pages).slice(0, 150), mirrorFiling, 4);
}

/* ---------- Per-ticker insider pages (daily) ---------- */
async function buildInsiderScans() {
  console.log('SEC: per-ticker Form 4 scans');
  const jobs = WATCHLIST.flatMap(t => [0, 10].map(from => ({t, from})));
  const byTicker = {};
  await pool(jobs, async ({t, from}) => {
    const url = `https://efts.sec.gov/LATEST/search-index?q=%22${t}%22&forms=4&dateRange=custom&startdt=${d(day90)}&enddt=${d(today)}&from=${from}`;
    const b = await saveOrSalvage(url, `sec/form4-${t}-${from}.json`);
    if (b) (byTicker[t] = byTicker[t] || []).push(b);
  }, 4);
  // mirror every filing the pages reference — the dashboard parses the 8 most
  // recent per ticker, but "most recent" spans both pages, so partial mirrors miss
  const filings = [];
  for (const t of Object.keys(byTicker)) filings.push(...filingsFromPages(byTicker[t]));
  await pool(filings, mirrorFiling, 4);
}

/* ---------- 13F mirrors (daily) ---------- */
async function build13F() {
  console.log('SEC: 13F submissions + info tables for 12 funds');
  await pool(FUNDS, async ([name, cik]) => {
    const cik10 = String(cik).padStart(10, '0');
    const subUrl = `https://data.sec.gov/submissions/CIK${cik10}.json`;
    if (!await mirror(subUrl, `sec/submissions/CIK${cik10}.json`)) return;
    let sub;
    try { sub = JSON.parse(await readFile(join(OUT, `sec/submissions/CIK${cik10}.json`), 'utf8')); }
    catch (e) { failures++; return; }
    const r = sub.filings.recent, accs = [];
    for (let i = 0; i < r.form.length && accs.length < 2; i++)
      if (r.form[i] === '13F-HR') accs.push(r.accessionNumber[i]);
    for (const adsh of accs) {
      const cikN = parseInt(cik, 10), acc = adsh.replace(/-/g, '');
      const dir = `https://www.sec.gov/Archives/edgar/data/${cikN}/${acc}`;
      const base = `sec/edgar/${cikN}/${acc}`;
      if (!await mirror(`${dir}/index.json`, `${base}/index.json`)) continue;
      try {
        const idx = JSON.parse(await readFile(join(OUT, `${base}/index.json`), 'utf8'));
        const files = (idx.directory.item || []).filter(f => /\.xml$/i.test(f.name) && !/primary_doc/i.test(f.name));
        const info = files.find(f => /info/i.test(f.name)) || files.sort((a, b) => (b.size || 0) - (a.size || 0))[0];
        if (info) await mirror(`${dir}/${info.name}`, `${base}/${info.name}`, {timeout: 120000});
      } catch (e) { failures++; }
    }
  }, 3);
  await mirror('https://www.sec.gov/files/company_tickers.json', 'sec/company_tickers.json');
}

/* ---------- reuse SEC mirror from the live site (cboe mode) ---------- */
async function reuseSec() {
  try {
    const meta = JSON.parse(await fetchBody(`${SITE_BASE}/data/meta.json`, {retries: 1, timeout: 20000}));
    if (!meta.secBuiltAt || Date.now() - new Date(meta.secBuiltAt).getTime() > 26 * 3600e3) {
      console.log(`Live SEC mirror stale (secBuiltAt ${meta.secBuiltAt})`);
      return false;
    }
    const manifest = JSON.parse(await fetchBody(`${SITE_BASE}/data/sec/manifest.json`, {retries: 1, timeout: 20000}));
    // form4-* list pages are rebuilt fresh every run — don't bother copying them
    const files = manifest.files.filter(f => !/^sec\/form4-/.test(f));
    console.log(`Reusing ${files.length} SEC files from live site (secBuiltAt ${meta.secBuiltAt})`);
    const missed = [];
    await pool(files, async rel => {
      try { await save(rel, await fetchBody(`${SITE_BASE}/data/${rel}`, {retries: 1, timeout: 60000})); }
      catch (e) { missed.push(rel); }
    }, 8);
    if (missed.length > files.length / 4) { console.log(`Reuse too broken (${missed.length} misses)`); return false; }
    return {secBuiltAt: meta.secBuiltAt, missed};
  } catch (e) { console.log(`Reuse unavailable: ${e.message}`); return false; }
}

/* Holes appear when a build hits a transient SEC failure; reconstruct the
   origin URL from the mirror path and refetch instead of carrying the hole. */
async function healMisses(missed) {
  for (const rel of missed) {
    let m, url = null;
    if (rel === 'sec/company_tickers.json') url = 'https://www.sec.gov/files/company_tickers.json';
    else if ((m = /^sec\/submissions\/(CIK\d{10}\.json)$/.exec(rel))) url = `https://data.sec.gov/submissions/${m[1]}`;
    else if ((m = /^sec\/edgar\/(\d+)\/(\d+)\/([\w.-]+)$/.exec(rel))) url = `https://www.sec.gov/Archives/edgar/data/${m[1]}/${m[2]}/${m[3]}`;
    if (url) { console.log(`  healing ${rel}`); await mirror(url, rel, {timeout: 120000}); }
  }
}

/* ---------- main ---------- */
let secBuiltAt = new Date().toISOString();
if (MODE === 'cboe') {
  const reused = await reuseSec();
  if (reused) {
    secBuiltAt = reused.secBuiltAt;
    await buildCboe();
    // Form 4 data streams in all day — always rebuild it fresh. The reused
    // mirror makes this cheap: already-mirrored filing XMLs are skipped.
    await buildForm4Recent();
    await buildInsiderScans();
    await healMisses(reused.missed);
  } else {
    console.log('Running full build instead');
    await buildCboe(); await buildForm4Recent(); await buildInsiderScans(); await build13F();
  }
} else {
  await buildCboe(); await buildForm4Recent(); await buildInsiderScans(); await build13F();
}

await save('sec/manifest.json', JSON.stringify({files: [...written].filter(f => f !== 'sec/manifest.json').sort()}));
await writeFile(join(OUT, 'meta.json'), JSON.stringify({
  builtAt: new Date().toISOString(), secBuiltAt, mode: MODE, tickers: WATCHLIST, failures
}, null, 1));

console.log(`Done. mode=${MODE} cboeOk=${cboeOk}/${WATCHLIST.length} failures=${failures}`);
if (cboeOk === 0) { console.error('No CBOE chain succeeded — aborting so the previous deploy stays live'); process.exit(1); }
