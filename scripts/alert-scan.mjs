#!/usr/bin/env node
/* Headless confluence alert scanner.
   Runs the deployed dashboard's OWN engine (via jsdom against the live site
   and its data snapshots — zero logic duplication) and opens a GitHub Issue
   whenever a thesis at/above MIN_CONF confidence appears. Issues double as
   the notification channel (repo watchers get emailed) and the dedup store
   (an open alert for the same ticker+direction is not re-raised). Alerts
   whose thesis deadline has passed are closed automatically.

   Env: SITE_BASE (default the live site), FINNHUB_KEY (live spots),
        GITHUB_TOKEN + GITHUB_REPOSITORY (issue API), MIN_CONF (HIGH default),
        DRY_RUN=1 (print instead of filing). */
import { JSDOM } from 'jsdom';

const SITE = (process.env.SITE_BASE || 'https://jason-xuu.github.io/whale').replace(/\/$/, '');
const FH = process.env.FINNHUB_KEY || '';
const TOKEN = process.env.GITHUB_TOKEN || '';
const REPO = process.env.GITHUB_REPOSITORY || 'jason-xuu/whale';
const MIN_CONF = (process.env.MIN_CONF || 'HIGH').toUpperCase();
const DRY = process.env.DRY_RUN === '1';
const CONF_RANK = {LOW: 0, MEDIUM: 1, HIGH: 2};
const LABEL = 'whale-alert';

if (!(MIN_CONF in CONF_RANK)) { console.error(`bad MIN_CONF ${MIN_CONF}`); process.exit(1); }

/* ---------- run the dashboard's engine headlessly ---------- */
const html = await (await fetch(`${SITE}/whale-dashboard.html?alert=${Math.random()}`)).text();
const dom = new JSDOM(html, {
  url: `${SITE}/whale-dashboard.html`,
  runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) {
    if (FH) w.localStorage.setItem('wt_finnhub', FH);
    w.localStorage.setItem('wt_tab', 'flow'); // we invoke runConfluence ourselves
    w.fetch = (u, o) => fetch(/^https?:/.test(String(u)) ? u : `${SITE}/` + u, o);
  }
});
const w = dom.window;
await new Promise(r => w.addEventListener('load', r));
await w.eval('runConfluence()');

const rows = JSON.parse(w.eval(`JSON.stringify(confState.rows
  .filter(r => r.thesis && ${JSON.stringify(CONF_RANK)}[r.confidence] >= ${CONF_RANK[MIN_CONF]})
  .map(r => ({
    ticker: r.ticker, label: r.dirLabel, conf: r.confidence, adj: r.adjScore, score: r.score,
    active: r.active, claim: r.thesis.claim, invalidation: r.thesis.invalidation,
    deadline: r.thesis.deadline, horizon: r.thesis.horizon,
    crossExam: r.counter.notes,
    move: recMove(r).replace(/<[^>]+>/g, '').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
      .replace(/\\s+/g, ' ').replace(/^RECOMMENDED MOVE\\s*/, '').trim(),
    structure: r.chain ? {
      netDeltaSided: r.chain.classDelta > 0 ? r.chain.netDeltaSided : null,
      gex: r.chain.gex, skew25: r.chain.skew25, term: r.chain.term
    } : null
  })))`));
const feed = w.eval('flowState.feedTime') || '';
const spotsLive = w.eval('flowState.spotsLive') || 0;
console.log(`scan complete: ${rows.length} thesis rows at ≥${MIN_CONF} confidence (feed ${feed}, ${spotsLive} live spots)`);

/* ---------- GitHub Issues: notify + dedup + expire ---------- */
const $$ = n => n == null ? '—' : (Math.abs(n) >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.round(n).toLocaleString());
async function gh(path, opts = {}) {
  const r = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json',
              'User-Agent': 'whale-alert-scan', 'X-GitHub-Api-Version': '2022-11-28', ...(opts.headers || {})}
  });
  if (!r.ok && r.status !== 422) throw new Error(`${path} → HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json().catch(() => null);
}
const title = a => `🐋 ${a.conf} confluence: ${a.label} ${a.ticker}`;
const body = a => `**${a.claim}**

| | |
|---|---|
| Confidence | **${a.conf}** |
| Score | ${a.adj}/100 adjusted (${a.score} raw) |
| Sources aligned | ${a.active} |
| Invalidation | ${a.invalidation} |
| Deadline | ${a.deadline} (${a.horizon}d horizon) |
${a.structure ? `| Net Δ flow (sided) | ${a.structure.netDeltaSided != null ? '$' + $$(a.structure.netDeltaSided) : 'n/a'} |
| Dealer gamma /1% | ${a.structure.gex != null ? '$' + $$(a.structure.gex) : 'n/a'} |
| 25Δ skew / term | ${a.structure.skew25 != null ? a.structure.skew25.toFixed(1) + ' pts' : '—'} / ${a.structure.term != null ? a.structure.term.toFixed(1) + ' pts' : '—'} |` : ''}

**Recommended move:** ${a.move}

${a.crossExam.length ? '**Cross-exam:** ' + a.crossExam.join(' · ') : 'Cross-exam found no opposing evidence.'}

Scan feed: ${feed} UTC (CBOE 15-min delayed) · ${spotsLive} live spots · [open dashboard](${SITE}/)

<!-- deadline:${a.deadline} -->
_Auto-filed by the confluence alert scan. Research signal, not financial advice._`;

if (DRY) {
  for (const a of rows) console.log(`\n=== DRY RUN would file: ${title(a)}\n${body(a)}`);
  process.exit(0);
}
if (!TOKEN) { console.error('no GITHUB_TOKEN and not DRY_RUN'); process.exit(1); }

await gh(`/repos/${REPO}/labels`, {method: 'POST', body: JSON.stringify({name: LABEL, color: '1d76db', description: 'Automated confluence thesis alerts'})}); // 422 if exists — fine
const open = await gh(`/repos/${REPO}/issues?labels=${LABEL}&state=open&per_page=100`) || [];
const today = new Date().toISOString().slice(0, 10);

let closed = 0;
for (const iss of open) {
  const m = /<!-- deadline:(\d{4}-\d{2}-\d{2}) -->/.exec(iss.body || '');
  if (m && m[1] < today) {
    await gh(`/repos/${REPO}/issues/${iss.number}`, {method: 'PATCH', body: JSON.stringify({state: 'closed'})});
    await gh(`/repos/${REPO}/issues/${iss.number}/comments`, {method: 'POST', body: JSON.stringify({body: `Thesis deadline ${m[1]} passed — closing. Check the dashboard ledger for the graded outcome.`})});
    closed++;
  }
}

let filed = 0, skipped = 0;
const stillOpen = open.filter(i => !/<!-- deadline:(\d{4}-\d{2}-\d{2}) -->/.test(i.body || '') || /<!-- deadline:(\d{4}-\d{2}-\d{2}) -->/.exec(i.body)[1] >= today);
for (const a of rows) {
  if (stillOpen.some(i => i.title === title(a))) { skipped++; continue; }
  await gh(`/repos/${REPO}/issues`, {method: 'POST', body: JSON.stringify({title: title(a), body: body(a), labels: [LABEL]})});
  console.log(`FILED: ${title(a)}`);
  filed++;
}
console.log(`done: ${filed} filed, ${skipped} already open, ${closed} expired closed`);
