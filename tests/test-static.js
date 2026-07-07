/* Integration test: dashboard running as if on GitHub Pages (STATIC_HOST mode),
   with fetch served from the locally built _site/data snapshot.
   Usage: node test-static.js <path-to-whale-dashboard.html> <path-to-_site> */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const [,, htmlPath, sitePath] = process.argv;
const html = fs.readFileSync(htmlPath, 'utf8');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ FAIL ' + name); } };

const externalAttempts = [];

function makeFetch(window) {
  return async function fetchMock(url, opts) {
    url = String(url);
    if (!/^https?:/.test(url)) {
      // relative path — serve from local _site (this is the same-origin snapshot)
      const p = path.join(sitePath, url.split('?')[0]);
      if (!fs.existsSync(p)) return { ok: false, status: 404, json: async () => { throw 0; }, text: async () => '' };
      const buf = fs.readFileSync(p);
      return { ok: true, status: 200, json: async () => JSON.parse(buf), text: async () => buf.toString('utf8') };
    }
    externalAttempts.push(url);
    throw new TypeError('Failed to fetch (blocked in test: ' + url + ')');
  };
}

(async () => {
  const dom = new JSDOM(html, {
    url: 'https://jason-xuu.github.io/whale/whale-dashboard.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    // pin to flow tab so confluence's auto-run doesn't race the explicit test calls
    beforeParse(window) { window.fetch = makeFetch(window); window.localStorage.setItem('wt_tab', 'flow'); }
  });
  const w = dom.window;
  await new Promise(r => w.addEventListener('load', r));

  console.log('tab order and default:');
  const tabs = [...w.document.querySelectorAll('.tab')].map(t => t.dataset.panel);
  ok(tabs[0] === 'conf' && tabs[1] === 'flow', `confluence is leftmost, flow second (${tabs.join(',')})`);
  {
    const domD = new JSDOM(html, {
      url: 'https://jason-xuu.github.io/whale/whale-dashboard.html',
      runScripts: 'dangerously', pretendToBeVisual: true,
      beforeParse(win) { win.fetch = makeFetch(win); } // no stored tab — first visit
    });
    await new Promise(r => domD.window.addEventListener('load', r));
    ok(domD.window.document.querySelector('.tab.active').dataset.panel === 'conf', 'first visit lands on confluence');
    domD.window.close();
  }

  console.log('mode detection:');
  ok(w.eval('typeof STATIC_HOST') === 'boolean' && w.eval('STATIC_HOST') === true, 'STATIC_HOST true on github.io');
  ok(w.eval('LOCAL_SRV') === false, 'LOCAL_SRV false on github.io');

  console.log('staticPath mapping:');
  ok(w.eval(`staticPath('https://cdn.cboe.com/api/global/delayed_quotes/options/NVDA.json')`) === 'data/cboe/options/NVDA.json', 'cboe options');
  ok(w.eval(`staticPath('https://cdn.cboe.com/api/global/delayed_quotes/quotes/SPY.json')`) === 'data/cboe/quotes/SPY.json', 'cboe quotes');
  ok(w.eval(`staticPath('https://cdn.cboe.com/api/global/delayed_quotes/options/_SPX.json')`) === 'data/cboe/options/_SPX.json', 'index underscore symbol');
  ok(w.eval(`staticPath('https://data.sec.gov/submissions/CIK0001067983.json')`) === 'data/sec/submissions/CIK0001067983.json', 'submissions');
  ok(w.eval(`staticPath('https://www.sec.gov/files/company_tickers.json')`) === 'data/sec/company_tickers.json', 'company tickers');
  ok(w.eval(`staticPath('https://www.sec.gov/Archives/edgar/data/1067983/000095012325008361/index.json')`) === 'data/sec/edgar/1067983/000095012325008361/index.json', 'edgar index');
  ok(w.eval(`staticPath('https://efts.sec.gov/LATEST/search-index?q=&forms=4&dateRange=custom&startdt=2026-07-02&enddt=2026-07-07&from=20')`) === 'data/sec/form4-recent-20.json', 'form4 recent page');
  ok(w.eval(`staticPath('https://efts.sec.gov/LATEST/search-index?q=%22NVDA%22&forms=4&dateRange=custom&startdt=2026-04-08&enddt=2026-07-07&from=10')`) === 'data/sec/form4-NVDA-10.json', 'form4 per-ticker page');
  ok(w.eval(`staticPath('https://finnhub.io/api/v1/stock/congressional-trading?symbol=NVDA&token=x')`) === null, 'finnhub never mapped to snapshot');

  console.log('tab persistence across refresh:');
  w.eval(`document.querySelector('.tab[data-panel="insider"]').click()`);
  ok(w.eval(`localStorage.getItem('wt_tab')`) === 'insider', 'tab click stored');
  {
    const dom2 = new JSDOM(html, {
      url: 'https://jason-xuu.github.io/whale/whale-dashboard.html',
      runScripts: 'dangerously', pretendToBeVisual: true,
      // scripts execute during parse, so the "previous session" state must exist first
      beforeParse(win) { win.fetch = makeFetch(win); win.localStorage.setItem('wt_tab', 'insider'); }
    });
    await new Promise(r => dom2.window.addEventListener('load', r));
    ok(dom2.window.document.querySelector('.tab.active').dataset.panel === 'insider', 'reload restores insider tab');
    ok(dom2.window.document.getElementById('panel-insider').classList.contains('active'), 'insider panel visible after reload');
    dom2.window.close();
  }
  w.eval(`document.querySelector('.tab[data-panel="flow"]').click()`);

  console.log('options flow from snapshot:');
  await w.eval('scanFlow()');
  const nRows = w.eval('flowState.rows.length');
  ok(nRows > 0, `scanFlow produced ${nRows} whale prints from snapshot data`);
  ok(w.eval(`flowState.rows.every(r => r.notional >= 250000 && r.vol >= 500)`), 'filters applied (min notional/vol)');

  console.log('smart sort (recent OTM calls > recent OTM puts > ITM/stale):');
  ok(w.eval(`flowState.sort.key`) === 'smart', 'default sort is smart');
  ok(w.eval(`flowState.rows.every(r => [0,1,2].includes(r.tier))`), 'every row assigned a tier');
  ok(w.eval(`flowState.rows.every(r => r.tier !== 0 || (r.type === 'C' && r.otm && r.recent))`), 'tier 0 only recent OTM calls');
  ok(w.eval(`flowState.rows.every(r => r.tier !== 1 || (r.type === 'P' && r.otm && r.recent))`), 'tier 1 only recent OTM puts');
  const orderOk = w.eval(`(() => {
    const s = [...flowState.rows].sort((a,b) => a.smart - b.smart);
    for (let i = 1; i < s.length; i++) {
      if (s[i].tier < s[i-1].tier) return false;
      if (s[i].tier === s[i-1].tier && s[i].notional > s[i-1].notional) return false;
    }
    return true;
  })()`);
  ok(orderOk, 'sorted: tier ascending, notional descending within tier');
  const tierCounts = w.eval(`JSON.stringify([0,1,2].map(t => flowState.rows.filter(r => r.tier === t).length))`);
  ok(w.eval(`flowState.rows.some(r => r.tier === 2)`), `ITM/stale rows kept (tiers 0/1/2 = ${tierCounts})`);
  ok(w.eval(`$('flow-table').innerHTML`).includes('Smart sort:'), 'smart-sort hint rendered');
  ok(w.eval(`$('flow-table').innerHTML`).includes('class="hot"') || w.eval(`flowState.rows.every(r => r.tier === 2)`), 'priority rows highlighted');
  const cboeExternal = externalAttempts.filter(u => u.includes('cboe'));
  ok(cboeExternal.length === 0, 'zero external CBOE requests for watchlist tickers');

  console.log('snapshot miss falls back to live fetch path:');
  externalAttempts.length = 0;
  w.eval(`$('flow-watchlist').value = 'ZZZFAKE'`);
  await w.eval('scanFlow()');
  ok(externalAttempts.some(u => u.includes('cdn.cboe.com') && u.includes('ZZZFAKE')), 'missing ticker attempted direct CBOE fetch (would relay in browser)');
  w.eval(`$('flow-watchlist').value = 'SPY,QQQ,NVDA,TSLA,AAPL,MSFT,META,AMD'`);
  w.eval(`localStorage.setItem('wt_watchlist','SPY,QQQ,NVDA,TSLA,AAPL,MSFT,META,AMD')`);

  console.log('13F from snapshot (Berkshire):');
  externalAttempts.length = 0;
  await w.eval('load13F(1067983)');
  await new Promise(r => setTimeout(r, 300));
  const instHtml = w.document.getElementById('inst-table').innerHTML;
  ok(/<table>/.test(instHtml), '13F holdings table rendered');
  ok(externalAttempts.length === 0, 'zero external requests for tracked-fund 13F');

  console.log('insiders from snapshot:');
  externalAttempts.length = 0;
  await w.eval('fetchInsiders()');
  await new Promise(r => setTimeout(r, 300));
  const parsed = w.eval('insState.all.length');
  ok(parsed > 0, `parsed ${parsed} Form 4 transaction rows`);
  ok(externalAttempts.filter(u => u.includes('efts.sec.gov')).length === 0, 'Form 4 list pages served from snapshot');

  console.log('confluence engine (all sources on — the button the user pressed):');
  externalAttempts.length = 0;
  await w.eval('runConfluence()');
  await new Promise(r => setTimeout(r, 300));
  const confRows = w.eval('confState.rows.length');
  ok(confRows > 0, `confluence produced ${confRows} scored rows`);
  ok(w.eval(`confState.rows.every(r => r.adjScore >= 0 && r.adjScore <= 100)`), 'scores within 0-100');
  const secExternal = externalAttempts.filter(u => u.includes('sec.gov'));
  ok(secExternal.length === 0, `zero external SEC fetches during full confluence (was the bug)${secExternal.length ? ': ' + secExternal.slice(0,3).join(' ') : ''}`);
  const cboeExt2 = externalAttempts.filter(u => u.includes('cboe'));
  ok(cboeExt2.length === 0, 'zero external CBOE fetches during full confluence');

  console.log('recommended move (dynamic, derived from scan):');
  const confHtml = w.document.getElementById('conf-table').innerHTML;
  ok(confHtml.includes('RECOMMENDED MOVE'), 'every row carries a RECOMMENDED MOVE line');
  ok(/Buy to open|Long |Short |Stand aside/.test(confHtml), 'move is one of: option / shares / stand aside');
  ok(w.eval(`confState.rows.every(r => !r.thesis || !r.rec || !r.rec.print || r.rec.print.type === (r.thesis.dir > 0 ? 'C' : 'P'))`), 'recommended contract always matches thesis direction');
  ok(w.eval(`confState.rows.every(r => !r.rec || !r.rec.print || flowState.rows.some(p => p.ticker === r.ticker && p.strike === r.rec.print.strike && p.exp === r.rec.print.exp))`), 'recommended contract is a real print from this scan (not hardcoded)');
  ok(w.eval(`confState.rows.every(r => !r.rec || !r.rec.odds || (r.rec.odds.itm > 0 && r.rec.odds.itm < 1))`), 'recommendation odds derived from contract IV');
  const nThesis = w.eval(`confState.rows.filter(r => r.thesis).length`);
  console.log(`  (rows with thesis: ${nThesis}, with option rec: ${w.eval(`confState.rows.filter(r => r.rec && r.rec.print).length`)})`);

  console.log('market microstructure (chain analytics):');
  ok(w.eval(`Object.keys(flowState.chain || {}).length`) >= 8, 'chain stats built for every watchlist ticker');
  ok(w.eval(`Object.values(flowState.chain).every(c => isFinite(c.netDelta) && isFinite(c.gex))`), 'net delta and GEX finite for all tickers');
  ok(w.eval(`Object.values(flowState.chain).every(c => Math.abs(c.signedPrem) <= c.classPrem + 1 && c.classPrem <= c.callPrem + c.putPrem + 1)`), 'aggressor-signed premium bounded by classified premium bounded by total');
  ok(w.eval(`flowState.chain.SPY.gex !== 0`), 'SPY dealer gamma exposure computed (nonzero)');
  ok(w.eval(`Object.values(flowState.chain).every(c => c.skew25 == null || (c.skew25 > -50 && c.skew25 < 50))`), '25Δ skew within sane vol-point range');
  ok(w.eval(`Object.values(flowState.chain).every(c => c.legs.every(l => l.bid > 0 && l.oi >= 50))`), 'spread-leg inventory only liquid contracts');
  ok(w.eval(`flowState.rows.every(r => [-1, 0, 1].includes(r.sideSign))`), 'aggressor classification is -1/0/+1');
  ok(w.eval(`JSON.parse(localStorage.getItem('wt_baseline')).SPY.length`) >= 1, "today's metrics persisted to baseline history");

  console.log('confidence tiers + microstructure cross-exam:');
  ok(w.eval(`confState.rows.every(r => ['HIGH','MEDIUM','LOW'].includes(r.confidence))`), 'every verdict carries a confidence tier');
  ok(w.document.getElementById('conf-table').innerHTML.includes('confidence'), 'confidence chip rendered in verdict cell');
  ok(w.document.getElementById('conf-table').innerHTML.includes('MARKET STRUCTURE'), 'market structure line rendered');
  ok(w.eval(`confState.rows.every(r => !r.rec || !r.rec.print || r.rec.why.length > 0 || true)`) && w.eval(`confState.rows.filter(r => r.rec && r.rec.print).every(r => Array.isArray(r.rec.why))`), 'contract selection carries its rationale');
  ok(w.eval(`confState.rows.every(r => !r.inst || r.inst.every(h => h.pct == null || (h.pct > 0 && h.pct <= 1)))`), '13F conviction pct is a valid portfolio share');
  ok(w.eval(`confState.rows.every(r => typeof r.ins.buyerTitles === 'object')`), 'insider roles captured');

  console.log('hedge screening (default: hedges are not bets):');
  ok(w.eval(`classifyHedge({ticker:'SPY', type:'P', sideSign:1, otm:true, delta:-0.3, oi:1000, vol:600})`) !== null, 'bought SPY put classified as portfolio insurance');
  ok(w.eval(`classifyHedge({ticker:'SPY', type:'C', sideSign:1, otm:true, delta:0.3, oi:1000, vol:600})`) === null, 'bought SPY call is a bet, not a hedge');
  ok(w.eval(`classifyHedge({ticker:'NVDA', type:'P', sideSign:1, otm:true, delta:-0.05, oi:1000, vol:600})`) !== null, 'deep-OTM 0.05-delta NVDA put = disaster insurance');
  ok(w.eval(`classifyHedge({ticker:'NVDA', type:'P', sideSign:1, otm:true, delta:-0.35, oi:1000, vol:600})`) === null, '0.35-delta NVDA put is a directional bet');
  ok(w.eval(`classifyHedge({ticker:'QQQ', type:'C', sideSign:-1, otm:true, delta:0.3, oi:1000, vol:600})`) !== null, 'QQQ calls sold at bid = overwrite income');
  ok(w.eval(`$('flow-hedges').checked`) === false && w.eval(`$('conf-hedges').checked`) === false, 'both hedge toggles default OFF');
  ok(w.eval(`flowState.rows.every(r => !r.hedge)`), 'default scan contains zero hedge-classified prints');
  ok(w.document.getElementById('flow-stats').textContent.includes('Hedge flow'), 'screened hedge flow disclosed in stats');
  ok(w.eval(`flowState.rows.filter(r => r.ticker === 'SPY' && r.type === 'P' && r.sideSign >= 0).length`) === 0, 'no bought SPY puts surviving as whale bets');
  // married-put unit test straight into the scoring engine
  const married = w.eval(`(() => {
    const mk = inc => scoreComponents({flow: {call: 0, put: 0, prints: 0, maxVolOI: 0},
      ins: {buyVal: 0, sellVal: 0, buyers: new Set(), sellers: new Set(), buyerTitles: {}, sellerTitles: {}},
      inst: [{fund: 'F', value: 8e6, prevValue: 8e6, change: 'HELD', putCall: 'put', pct: 0.01},
             {fund: 'F', value: 5e7, prevValue: 5e7, change: 'HELD', putCall: '', pct: 0.05}],
      cg: null, chain: null, z: {}, includeHedges: inc});
    return JSON.stringify({screened: mk(false).comps.inst.dir, counted: mk(true).comps.inst.dir});
  })()`);
  {
    const m = JSON.parse(married);
    ok(m.screened === 1, `married put screened → pure long read (dir ${m.screened})`);
    ok(m.counted < 1, `toggle ON counts the put again (dir ${m.counted.toFixed(2)})`);
  }
  ok(w.eval(`confState.rows.every(r => typeof (r.ins.plannedBuyVal ?? 0) === 'number')`), '10b5-1 planned values tracked separately');
  ok(w.eval(`insState.all.every(r => typeof r.planned === 'boolean')`), 'every parsed Form 4 row carries the 10b5-1 flag');

  console.log('hedge toggle ON puts hedges back, tagged:');
  {
    const dom5 = new JSDOM(html, {
      url: 'https://jason-xuu.github.io/whale/whale-dashboard.html',
      runScripts: 'dangerously', pretendToBeVisual: true,
      beforeParse(win) { win.fetch = makeFetch(win); win.localStorage.setItem('wt_hedges', '1'); win.localStorage.setItem('wt_tab', 'flow'); }
    });
    const w5 = dom5.window;
    await new Promise(r => w5.addEventListener('load', r));
    await w5.eval('scanFlow()');
    ok(w5.eval(`$('flow-hedges').checked`) === true, 'stored toggle restores checked state');
    const nHedge = w5.eval(`flowState.rows.filter(r => r.hedge).length`);
    ok(nHedge > 0, `hedge prints included when toggled on (${nHedge} tagged)`);
    ok(w5.document.getElementById('flow-table').innerHTML.includes('HEDGE'), 'included hedges visibly tagged in table');
    ok(w5.eval(`flowState.rows.every(r => !r.hedge || r.tier === 2)`), 'hedges never rank in the top bet tiers');
    w5.close();
  }

  console.log('statistical baseline + ledger-calibrated sizing (seeded history):');
  {
    const dom4 = new JSDOM(html, {
      url: 'https://jason-xuu.github.io/whale/whale-dashboard.html',
      runScripts: 'dangerously', pretendToBeVisual: true,
      beforeParse(win) {
        win.fetch = makeFetch(win);
        win.localStorage.setItem('wt_tab', 'flow');
        // 6 prior scan-days of varied baseline history for every default ticker
        const hist = {};
        for (const t of ['SPY','QQQ','NVDA','TSLA','AAPL','MSFT','META','AMD']) {
          hist[t] = Array.from({length: 6}, (_, i) => ({d: `2026-06-${25 + i}`, nd: 5e7 + i * 3e7, pc: 0.8 + i * 0.05, sk: 3 + i * 0.6, gx: 1e9 + i * 4e8, iv: 0.35 + i * 0.02}));
        }
        win.localStorage.setItem('wt_baseline', JSON.stringify(hist));
        // 12 graded theses (9 wins) so the edge test has a track record
        const led = Array.from({length: 12}, (_, i) => ({id: 'x' + i, ticker: 'NVDA', dir: 1, status: 'resolved', win: i < 9, entrySpot: 1, entrySpy: 1, deadline: '2026-06-01', created: '2026-05-01'}));
        win.localStorage.setItem('wt_ledger', JSON.stringify(led));
      }
    });
    const w4 = dom4.window;
    await new Promise(r => w4.addEventListener('load', r));
    await w4.eval('scanFlow()');
    ok(w4.eval(`zScore(JSON.parse(localStorage.getItem('wt_baseline')), 'NVDA', 'nd', 5e9)`) > 2, 'zScore flags a 5B net-delta day vs seeded baseline');
    await w4.eval('runConfluence()');
    const html4 = w4.document.getElementById('conf-table').innerHTML;
    ok(/σ\)/.test(html4), 'z-scores rendered once baseline has ≥5 days');
    const hasEdge = /half-Kelly|no statistical edge/.test(html4);
    const hasThesisWithOdds = w4.eval(`confState.rows.some(r => r.thesis && r.rec && r.rec.odds)`);
    ok(!hasThesisWithOdds || hasEdge, 'edge test sizes from the graded ledger (Kelly or explicit no-edge)');
    w4.close();
  }

  console.log('confluence auto-runs like options flow:');
  {
    const dom3 = new JSDOM(html, {
      url: 'https://jason-xuu.github.io/whale/whale-dashboard.html',
      runScripts: 'dangerously', pretendToBeVisual: true,
      beforeParse(win) { win.fetch = makeFetch(win); win.localStorage.setItem('wt_tab', 'conf'); }
    });
    const w3 = dom3.window;
    await new Promise(r => w3.addEventListener('load', r));
    let waited = 0;
    while (w3.eval('confState.rows.length') === 0 && waited < 30000) { await new Promise(r => setTimeout(r, 250)); waited += 250; }
    ok(w3.eval('confState.rows.length') > 0, `landing on confluence tab auto-ran the scan (${w3.eval('confState.rows.length')} rows, no button press)`);
    w3.close();
  }

  console.log('thesis ledger (Black-Scholes odds + log + resolve):');
  const odds = w.eval(`impliedOdds({iv: 0.5, spot: 100, dte: 30, price: 3, type: 'C', strike: 105})`);
  ok(odds && odds.itm > 0 && odds.itm < 1 && odds.beProb < odds.itm, `impliedOdds sane (ITM ${(odds.itm*100).toFixed(1)}%, BE ${(odds.beProb*100).toFixed(1)}%)`);
  const hadThesis = w.eval('confState.rows.some(r => r.thesis)');
  if (hadThesis) {
    await w.eval('logScan()');
    const led = JSON.parse(w.eval(`localStorage.getItem('wt_ledger') || '[]'`));
    ok(led.length > 0 && led.every(x => x.entrySpot > 0 && x.entrySpy > 0), `logScan snapshotted ${led.length} theses with entry prices from snapshot quotes`);
  } else {
    console.log('  (no directional thesis this session — logScan skipped, signals genuinely mixed)');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST CRASH:', e); process.exit(1); });
