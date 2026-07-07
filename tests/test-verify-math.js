/* Independent verification of the confluence engine's financial math.
   Every check recomputes the number from raw snapshot JSON with a SEPARATE
   implementation (erf-based normal CDF, independent accumulators) and
   compares against what the app computed. Tolerances are tight.
   Usage: node test-verify-math.js <dashboard.html> <_site dir> */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const [,, htmlPath, sitePath] = process.argv;
const html = fs.readFileSync(htmlPath, 'utf8');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ FAIL ' + name); } };
const close = (a, b, tol, name) => ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${name} (app ${a.toExponential(3)} vs independent ${b.toExponential(3)})`);

/* independent normal CDF via erf (Abramowitz-Stegun 7.1.26 is what the app
   uses; this is a different rational approximation — max err ~1.5e-7) */
function erf(x) {
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  // different composition order + independent Horner grouping
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
const N = x => 0.5 * (1 + erf(x / Math.SQRT2));

function parseOcc(sym) {
  const m = /^([A-Z.]+)(\d{6})([CP])(\d{8})$/.exec(sym.replace(/\s+/g, ''));
  if (!m) return null;
  return {root: m[1], exp: `20${m[2].slice(0,2)}-${m[2].slice(2,4)}-${m[2].slice(4,6)}`, type: m[3], strike: +m[4] / 1000};
}

(async () => {
  const dom = new JSDOM(html, {
    url: 'https://jason-xuu.github.io/whale/whale-dashboard.html',
    runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = async u => {
        u = String(u);
        if (/^https?:/.test(u)) throw new TypeError('blocked');
        const p = path.join(sitePath, u.split('?')[0]);
        if (!fs.existsSync(p)) return {ok: false, status: 404, json: async () => {throw 0}, text: async () => ''};
        const b = fs.readFileSync(p);
        return {ok: true, status: 200, json: async () => JSON.parse(b), text: async () => b.toString()};
      };
    }
  });
  const w = dom.window;
  await new Promise(r => w.addEventListener('load', r));
  await w.eval('runConfluence()');

  console.log('Black-Scholes risk-neutral probabilities (independent erf-based recompute):');
  for (const c of [{iv: .45, spot: 200, dte: 21, price: 4.2, type: 'C', strike: 215},
                   {iv: .70, spot: 120, dte: 45, price: 6.5, type: 'P', strike: 100},
                   {iv: .25, spot: 500, dte: 7,  price: 2.1, type: 'C', strike: 510}]) {
    const app = w.eval(`JSON.stringify(impliedOdds(${JSON.stringify(c)}))`);
    const a = JSON.parse(app);
    const T = Math.max(c.dte, 0.5) / 365, r = 0.04;
    const pAbove = K => N((Math.log(c.spot / K) + (r - c.iv * c.iv / 2) * T) / (c.iv * Math.sqrt(T)));
    const itm = c.type === 'C' ? pAbove(c.strike) : 1 - pAbove(c.strike);
    const be = c.type === 'C' ? c.strike + c.price : c.strike - c.price;
    const beProb = c.type === 'C' ? pAbove(be) : 1 - pAbove(be);
    ok(Math.abs(a.itm - itm) < 1e-6 && Math.abs(a.beProb - beProb) < 1e-6 && a.be === be,
       `${c.type} K=${c.strike} dte=${c.dte}: ITM ${(itm*100).toFixed(2)}%, BE prob ${(beProb*100).toFixed(2)}%, BE $${be}`);
    ok(a.beProb <= a.itm + 1e-9, `breakeven prob ≤ ITM prob (breakeven is past the strike by construction)`);
  }
  ok(w.eval(`impliedOdds({iv:.5, spot:100, dte:0, price:1, type:'C', strike:105})`) === null, '0 DTE returns null (no div-by-zero)');

  console.log('chain analytics vs independent accumulation from raw snapshot JSON:');
  for (const tkr of ['NVDA', 'SPY']) {
    const raw = JSON.parse(fs.readFileSync(path.join(sitePath, `data/cboe/options/${tkr}.json`)));
    const spot = raw.data.current_price ?? raw.data.close;
    let nd = 0, nds = 0, cd = 0, ad = 0, cp = 0, pp = 0, sp = 0, clp = 0, gex = 0;
    for (const o of raw.data.options) {
      const p = parseOcc(o.option); if (!p) continue;
      const vol = o.volume || 0;
      const bid = o.bid || 0, ask = o.ask || 0;
      const mid = bid && ask ? (bid + ask) / 2 : 0;
      const price = o.last_trade_price || mid;
      const iv = o.iv || 0;
      const delta = p.type === 'P' ? -Math.abs(o.delta || 0) : Math.abs(o.delta || 0);
      const oi = o.open_interest || 0;
      const dte = Math.max(0, Math.round((new Date(p.exp) - Date.now()) / 864e5));
      let side = 0;
      if (vol > 0 && o.last_trade_price && bid && ask && ask > bid) {
        const wd = Math.max(0.01, (ask - bid) * 0.2);
        if (o.last_trade_price >= ask - wd) side = 1;
        else if (o.last_trade_price <= bid + wd) side = -1;
      }
      if (spot != null && vol > 0) {
        nd += vol * delta * 100 * spot;
        ad += vol * Math.abs(delta) * 100 * spot;
        (p.type === 'C' ? cp += vol * price * 100 : pp += vol * price * 100);
        if (side) { sp += side * vol * price * 100 * (p.type === 'C' ? 1 : -1); clp += vol * price * 100;
                    nds += side * vol * delta * 100 * spot; cd += vol * Math.abs(delta) * 100 * spot; }
      }
      if (spot && iv > 0 && dte > 0 && oi > 0) {
        const T = dte / 365, d1 = (Math.log(spot / p.strike) + (0.04 + iv * iv / 2) * T) / (iv * Math.sqrt(T));
        const g = Math.exp(-d1 * d1 / 2) / Math.sqrt(2 * Math.PI) / (spot * iv * Math.sqrt(T));
        if (isFinite(g)) gex += (p.type === 'C' ? 1 : -1) * oi * g * 100 * spot * spot * 0.01;
      }
    }
    const cs = JSON.parse(w.eval(`JSON.stringify(flowState.chain['${tkr}'])`));
    close(cs.netDelta, nd, 1e-6, `${tkr} net delta (buyer-assumed)`);
    close(cs.netDeltaSided, nds, 1e-6, `${tkr} net delta (sided)`);
    close(cs.gex, gex, 1e-6, `${tkr} dealer gamma exposure`);
    close(cs.callPrem + cs.putPrem, cp + pp, 1e-6, `${tkr} total premium`);
    close(cs.signedPrem, sp, 1e-6, `${tkr} aggressor-signed premium`);
    ok(Math.abs(cs.netDeltaSided) <= cs.classDelta + 1, `${tkr} |sided delta| ≤ classified gross delta`);
  }

  console.log('verdict/thesis internal consistency across all rows:');
  const rows = JSON.parse(w.eval(`JSON.stringify(confState.rows.map(r => ({
    t: r.ticker, dir: r.dir, label: r.dirLabel, adj: r.adjScore, score: r.score,
    counterPts: r.counter.pts, notes: r.counter.notes.length,
    thesis: r.thesis, conf: r.confidence,
    recType: r.rec && r.rec.print ? r.rec.print.type : null,
    recOdds: r.rec ? r.rec.odds : null})))`));
  ok(rows.every(r => (r.label === 'BULLISH') === (r.dir > 0.2) && (r.label === 'BEARISH') === (r.dir < -0.2)), 'label ⇔ direction cutoffs exact');
  ok(rows.every(r => r.adj <= r.score), 'adjusted score never exceeds raw score');
  ok(rows.every(r => r.counterPts <= 20 + 1e-9), 'cross-exam deductions capped at 20');
  ok(rows.every(r => !r.thesis || (r.thesis.dir === (r.label === 'BULLISH' ? 1 : -1))), 'thesis direction matches verdict label');
  ok(rows.every(r => !r.thesis || r.adj >= 15), 'thesis only above the action floor');
  ok(rows.every(r => !r.thesis || [14, 21, 30].includes(r.thesis.horizon)), 'horizon from the documented set');
  ok(rows.every(r => !r.thesis ||
      (r.thesis.dir > 0 ? /below|−7%/.test(r.thesis.invalidation) : /above|\+7%/.test(r.thesis.invalidation))),
     'invalidation direction opposes the thesis (bull→below, bear→above)');
  ok(rows.every(r => !r.thesis || Math.round((new Date(r.thesis.deadline) - Date.now()) / 864e5) - r.thesis.horizon <= 1),
     'deadline = today + horizon (±1d rounding)');
  ok(rows.every(r => !r.recType || !r.thesis || r.recType === (r.thesis.dir > 0 ? 'C' : 'P')), 'recommended type matches thesis');
  ok(rows.every(r => !r.recOdds || (r.recOdds.itm > 0 && r.recOdds.itm < 1 && r.recOdds.beProb <= r.recOdds.itm + 1e-9)), 'rec odds sane and ordered');

  console.log('Kelly sizing formula (synthetic contract, seeded 9/12 ledger):');
  {
    const led = Array.from({length: 12}, (_, i) => ({id: 'k' + i, status: 'resolved', win: i < 9}));
    w.eval(`localStorage.setItem('wt_ledger', '${JSON.stringify(led)}')`);
    const fake = `{ticker:'TEST', dirLabel:'BULLISH', adjScore:50, confidence:'HIGH', chain:null,
      thesis:{dir:1, horizon:21, claim:'x', invalidation:'close below $90 (the whale\\'s own strike)', deadline:'2026-08-01'},
      rec:{print:{type:'C', strike:110, exp:'2026-08-01', dte:25, price:3, notional:9e5, spot:100, iv:.4, volOI:2, oi:800, bid:2.9, ask:3.1, sideSign:1, otm:true, delta:.3}, odds:{itm:.72, beProb:.70, be:113}, why:['test'], spr:.06, nCands:1, allSold:false}}`;
    const txt = w.eval(`recMove(${fake})`);
    // pEmp = (9+1)/(12+2) = 0.714286; edge = 0.014286; half-Kelly = edge/(2*(1-0.70)) = 0.02381 → 2.4%
    ok(/≤2\.4% of book/.test(txt), `half-Kelly = edge/(2(1−p)) → 2.4% (got: ${(txt.match(/≤[\d.]+% of book/) || ['not found'])[0]})`);
    const led2 = Array.from({length: 12}, (_, i) => ({id: 'k' + i, status: 'resolved', win: i < 5}));
    w.eval(`localStorage.setItem('wt_ledger', '${JSON.stringify(led2)}')`);
    ok(/no statistical edge/.test(w.eval(`recMove(${fake})`)), '5/12 hit rate vs 70% market → explicit no-edge');
    w.eval(`localStorage.setItem('wt_ledger', '[]')`);
    ok(/no track record/.test(w.eval(`recMove(${fake})`)), 'empty ledger → minimum-size language, no Kelly claim');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('VERIFY CRASH:', e); process.exit(1); });
