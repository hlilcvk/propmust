/** AGENT 1: DATA COLLECTOR — 7 exchanges, real OHLCV, funding, OI */

const { EXCHANGES, ALL_EXCHANGES, PRIMARY } = require('./exchanges');
const TOP_N = 60;
const candles = new Map();
const tickers = new Map();
const tokenExchangeMap = new Map();
let trackedSymbols = [];

async function fetchJSON(url, timeout = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  } finally { clearTimeout(timer); }
}

async function refreshSymbolList() {
  try {
    const d = await fetchJSON(PRIMARY.rest + PRIMARY.ticker24h());
    const usdt = d.filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
      .sort((a, b) => +b.quoteVolume - +a.quoteVolume).slice(0, TOP_N);
    trackedSymbols = usdt.map(t => t.symbol);
    for (const t of usdt) {
      const old = tickers.get(t.symbol) || {};
      tickers.set(t.symbol, { ...old, ...PRIMARY.parseTicker(t), updatedAt: Date.now() });
    }
    console.log(`[Collector] Tracking ${trackedSymbols.length} symbols`);
  } catch (e) { console.error('[Collector] refreshSymbolList:', e.message); }
}

async function fetchKlines(symbol, tf, limit = 500) {
  const interval = PRIMARY.intervals[tf];
  if (!interval) return null;
  try {
    const raw = await fetchJSON(PRIMARY.rest + PRIMARY.klines(symbol, interval, limit));
    return raw.map(PRIMARY.parseKline);
  } catch (e) { return null; }
}

async function fetchFunding() {
  try {
    const d = await fetchJSON(PRIMARY.rest + PRIMARY.funding());
    for (const r of d) {
      const p = PRIMARY.parseFunding(r);
      const t = tickers.get(p.symbol);
      if (t) { t.fund = p.rate; t.markPrice = p.mark; }
    }
  } catch (e) { console.error('[Funding]', e.message); }
}

async function fetchOI() {
  for (const sym of trackedSymbols.slice(0, 30)) {
    try {
      const d = await fetchJSON(PRIMARY.rest + PRIMARY.oi(sym));
      const t = tickers.get(sym);
      if (t) {
        const newOI = PRIMARY.parseOI(d);
        const oldOI = t.oi_val || newOI;
        t.oi_delta = oldOI > 0 ? ((newOI - oldOI) / oldOI) * 100 : 0;
        t.oi_val = newOI;
      }
    } catch (e) { if (String(e).includes('429')) break; }
    await sleep(100);
  }
}

async function fetchCrossExchangeFunding(symbol) {
  const rates = {};
  const exList = [EXCHANGES.BINANCE, EXCHANGES.BYBIT, EXCHANGES.OKX, EXCHANGES.BITGET];
  for (const ex of exList) {
    try {
      if (ex.name === 'BINANCE') {
        const t = tickers.get(symbol);
        if (t && t.fund !== undefined) { rates[ex.name] = t.fund; continue; }
      }
      if (ex.name === 'BYBIT') {
        const d = await fetchJSON(ex.rest + ex.ticker24h());
        const list = ex.parseTickers(d);
        const found = list.find(t => t.symbol === symbol);
        if (found) rates[ex.name] = found.fund;
      }
      if (ex.name === 'OKX') {
        const d = await fetchJSON(ex.rest + ex.funding());
        const list = ex.parseFundings(d);
        const found = list.find(t => t.symbol === symbol);
        if (found) rates[ex.name] = found.rate;
      }
    } catch (e) { /* skip */ }
  }
  return rates;
}

async function discoverExchangeListings() {
  for (const ex of ALL_EXCHANGES) {
    if (!ex.info || !ex.parseSymbols) continue;
    try {
      const d = await fetchJSON(ex.rest + ex.info());
      const syms = ex.parseSymbols(d);
      for (const s of syms) {
        if (!tokenExchangeMap.has(s)) tokenExchangeMap.set(s, []);
        const arr = tokenExchangeMap.get(s);
        if (!arr.includes(ex.name)) arr.push(ex.name);
      }
    } catch (e) { /* skip */ }
    await sleep(300);
  }
  console.log(`[Collector] Exchange map: ${tokenExchangeMap.size} tokens across ${ALL_EXCHANGES.length} exchanges`);
}

const TF_SCHEDULE = [
  { tf: '1m', interval: 60 },
  { tf: '5m', interval: 300 },
  { tf: '15m', interval: 900 },
  { tf: '1h', interval: 900 },
  { tf: '4h', interval: 3600 }
];
const lastFetch = {};

async function collectKlines() {
  const now = Date.now();
  for (const cfg of TF_SCHEDULE) {
    const key = `kl_${cfg.tf}`;
    if (now - (lastFetch[key] || 0) < cfg.interval * 1000) continue;
    lastFetch[key] = now;
    for (let i = 0; i < trackedSymbols.length; i += 10) {
      const batch = trackedSymbols.slice(i, i + 10);
      const results = await Promise.allSettled(batch.map(s => fetchKlines(s, cfg.tf)));
      for (let j = 0; j < batch.length; j++) {
        if (results[j].status === 'fulfilled' && results[j].value) {
          if (!candles.has(batch[j])) candles.set(batch[j], new Map());
          candles.get(batch[j]).set(cfg.tf, results[j].value);
        }
      }
      if (i + 10 < trackedSymbols.length) await sleep(200);
    }
  }
}

function takePriceSnapshot() {
  const snap = {};
  for (const [s, t] of tickers) { if (t.price > 0) snap[s] = t.price; }
  return snap;
}

async function runCollector() {
  const t0 = Date.now();
  await refreshSymbolList();
  await fetchFunding();
  await collectKlines();
  await fetchOI();
  console.log(`[Collector] Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = {
  candles, tickers, tokenExchangeMap,
  trackedSymbols: () => trackedSymbols,
  runCollector, collectKlines, fetchFunding, fetchOI,
  refreshSymbolList, takePriceSnapshot, fetchCrossExchangeFunding,
  discoverExchangeListings, fetchJSON
};
