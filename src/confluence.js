/** AGENT 4: CONFLUENCE SCORER — 7 independent layers */

const { candles, tickers, fetchCrossExchangeFunding } = require('./collector');
const { SYM_TO_SECTOR } = require('./exchanges');

function cfLeadLag(symbol, snapshots) {
  if (!snapshots || snapshots.length < 6 || symbol === 'BTCUSDT') return { score: 0, dir: 'NEUTRAL', detail: '' };
  const now = snapshots[snapshots.length - 1].data;
  const back = snapshots[Math.max(0, snapshots.length - 10)].data;
  const bn = now['BTCUSDT'] || 0, bb = back['BTCUSDT'] || bn;
  if (bb <= 0) return { score: 0, dir: 'NEUTRAL', detail: '' };
  const bm = ((bn - bb) / bb) * 100;
  if (Math.abs(bm) < 0.3) return { score: 0, dir: 'NEUTRAL', detail: '' };
  const an = now[symbol] || 0, ab = back[symbol] || an;
  if (ab <= 0) return { score: 0, dir: 'NEUTRAL', detail: '' };
  const am = ((an - ab) / ab) * 100;
  const fr = Math.abs(bm) > 0.1 ? am / bm : 1;
  if (Math.abs(fr) >= 0.4) return { score: 5, dir: bm > 0 ? 'LONG' : 'SHORT', detail: `BTC ${bm>0?'+':''}${bm.toFixed(1)}%, alt followed` };
  const sc = Math.min(100, Math.abs(bm) * 18 + (1 - Math.abs(fr)) * 40);
  return { score: sc, dir: bm > 0 ? 'LONG' : 'SHORT', detail: `BTC ${bm>0?'+':''}${bm.toFixed(1)}% → alt ${am>0?'+':''}${am.toFixed(1)}% (lagging)` };
}

function cfFundOI(ticker) {
  const { fund = 0, oi_delta = 0, ch = 0 } = ticker || {};
  if (Math.abs(ch) > 5) return { score: 0, dir: 'NEUTRAL', type: 'NONE', detail: '' };
  if (fund < -0.0003 && oi_delta > 1) return { score: Math.min(100, Math.abs(fund) * 15000 + oi_delta * 8), dir: 'LONG', type: 'SHORT_SQUEEZE', detail: `Fund ${(fund*100).toFixed(4)}%, OI +${oi_delta.toFixed(1)}%` };
  if (fund > 0.0003 && oi_delta > 1) return { score: Math.min(100, fund * 15000 + oi_delta * 8), dir: 'SHORT', type: 'LONG_SQUEEZE', detail: `Fund +${(fund*100).toFixed(4)}%, OI +${oi_delta.toFixed(1)}%` };
  if (oi_delta > 3 && Math.abs(ch) < 2) return { score: Math.min(50, oi_delta * 6), dir: fund < 0 ? 'LONG' : 'SHORT', type: fund < 0 ? 'SHORT_SQUEEZE' : 'LONG_SQUEEZE', detail: `OI +${oi_delta.toFixed(1)}%, price flat` };
  return { score: 0, dir: 'NEUTRAL', type: 'NONE', detail: '' };
}

function cfCorrBreak(symbol, corrMatrix) {
  if (!corrMatrix || !corrMatrix[symbol]) return { score: 0, dir: 'NEUTRAL', detail: '' };
  const { btc_corr = 0.75, normal_corr = 0.75 } = corrMatrix[symbol];
  const drop = normal_corr - btc_corr;
  if (drop < 0.25) return { score: 5, dir: 'NEUTRAL', detail: `Corr ${btc_corr.toFixed(2)} (normal)` };
  const t = tickers.get(symbol), btcT = tickers.get('BTCUSDT');
  const altCh = t?.ch || 0, btcCh = btcT?.ch || 0;
  return { score: Math.min(100, drop * 120), dir: altCh > btcCh ? 'LONG' : altCh < btcCh ? 'SHORT' : 'NEUTRAL', detail: `Corr dropped to ${btc_corr.toFixed(2)} (was ${normal_corr.toFixed(2)})` };
}

function cfVolAnomaly(symbol) {
  const kl = candles.get(symbol)?.get('1h');
  if (!kl || kl.length < 24) return { score: 0, dir: 'NEUTRAL', detail: '' };
  const t = tickers.get(symbol);
  const ch = Math.abs(t?.ch || 0);
  const recentVol = kl[kl.length - 1].v;
  const avgVol = kl.slice(-24).reduce((s, k) => s + k.v, 0) / 24;
  const ratio = avgVol > 0 ? recentVol / avgVol : 0;
  if (ratio < 1.8 || ch > 4) return { score: Math.min(15, ratio * 5), dir: 'NEUTRAL', detail: `Vol ${ratio.toFixed(1)}x` };
  const sc = Math.min(100, (ratio - 1.5) * 25 + (4 - ch) * 8);
  const rsi = t?.computed_rsi || 50, fund = t?.fund || 0;
  let dir = 'NEUTRAL';
  if (fund < -0.0001 && rsi < 50) dir = 'LONG'; else if (fund > 0.0001 && rsi > 50) dir = 'SHORT';
  return { score: sc, dir, detail: `Vol ${ratio.toFixed(1)}x avg, ch ${ch.toFixed(1)}%` };
}

function cfSectorFlow(symbol) {
  const sector = SYM_TO_SECTOR[symbol];
  if (!sector) return { score: 0, dir: 'NEUTRAL', detail: '' };
  const avg = {}, cnt = {};
  for (const [s, t] of tickers) {
    const sec = SYM_TO_SECTOR[s]; if (!sec) continue;
    avg[sec] = (avg[sec] || 0) + (t.ch || 0); cnt[sec] = (cnt[sec] || 0) + 1;
  }
  for (const k in avg) avg[k] /= cnt[k] || 1;
  const myCh = avg[sector] || 0;
  const t = tickers.get(symbol);
  const tokenCh = t?.ch || 0;
  const lag = myCh - tokenCh;
  let best = '', bestV = -999;
  for (const k in avg) { if (avg[k] > bestV) { bestV = avg[k]; best = k; } }
  if (sector === best && bestV > 1 && lag > 0.5) return { score: Math.min(100, lag * 12 + bestV * 5), dir: 'LONG', detail: `${sector} avg +${myCh.toFixed(1)}%, token +${tokenCh.toFixed(1)}% (lagging)` };
  return { score: 0, dir: 'NEUTRAL', detail: '' };
}

function cfSession(symbol) {
  const h = new Date().getUTCHours(), m = new Date().getUTCMinutes();
  const ses = h < 8 ? 'ASIA' : h < 14 ? 'LONDON' : 'NY';
  const t = tickers.get(symbol);
  if (!t) return { score: 0, dir: 'NEUTRAL', session: ses, detail: '' };
  const ch = t.ch || 0, rsi = t.computed_rsi || 50, fund = t.fund || 0;
  const kl = candles.get(symbol)?.get('1h');
  const rv = kl?.length > 0 ? kl[kl.length - 1].v : 0;
  const av = kl?.length >= 24 ? kl.slice(-24).reduce((s, k) => s + k.v, 0) / 24 : rv;
  const vr = av > 0 ? rv / av : 1;
  let sc = 0, dir = 'NEUTRAL', pat = '';
  if (ses === 'ASIA' && vr < 0.8 && Math.abs(ch) < 2) {
    if (rsi < 45 && fund < 0) { sc = 35; dir = 'LONG'; pat = 'ASIA_ACCUM'; }
    else if (rsi > 55 && fund > 0) { sc = 35; dir = 'SHORT'; pat = 'ASIA_DIST'; }
  }
  if (ses === 'LONDON' && h <= 10 && Math.abs(ch) >= 1.5 && Math.abs(ch) <= 6 && vr >= 1.3) {
    sc = Math.min(70, Math.abs(ch) * 10 + vr * 8); dir = ch > 0 ? 'LONG' : 'SHORT'; pat = 'LONDON_BREAK';
  }
  if (ses === 'NY' && h >= 14 && h <= 16 && Math.abs(ch) >= 2 && vr >= 1.5) {
    sc = Math.min(60, Math.abs(ch) * 8 + vr * 6); dir = ch > 0 ? 'LONG' : 'SHORT'; pat = 'NY_SURGE';
  }
  return { score: sc, dir, session: ses, pattern: pat, detail: pat || ses };
}

function cfCrossExFunding(fundingRates) {
  const rates = Object.values(fundingRates || {}).filter(r => r !== undefined && r !== null);
  if (rates.length < 2) return { score: 0, dir: 'NEUTRAL', detail: '' };
  const avg = rates.reduce((s, r) => s + r, 0) / rates.length;
  const allNeg = rates.every(r => r < -0.0002);
  const allPos = rates.every(r => r > 0.0002);
  if (allNeg && Math.abs(avg) > 0.0005) return { score: Math.min(100, Math.abs(avg) * 20000), dir: 'LONG', detail: `All ${rates.length} exchanges funding negative (avg ${(avg*100).toFixed(4)}%)` };
  if (allPos && avg > 0.0005) return { score: Math.min(100, avg * 20000), dir: 'SHORT', detail: `All ${rates.length} exchanges funding positive (avg ${(avg*100).toFixed(4)}%)` };
  return { score: 0, dir: 'NEUTRAL', detail: '' };
}

function computeConfluence(symbol, snapshots, corrMatrix, crossFunding) {
  const layers = [
    { name: 'LEAD_LAG', ...cfLeadLag(symbol, snapshots) },
    { name: 'FUND_OI', ...cfFundOI(tickers.get(symbol)) },
    { name: 'CORR_BREAK', ...cfCorrBreak(symbol, corrMatrix) },
    { name: 'VOL_ANOMALY', ...cfVolAnomaly(symbol) },
    { name: 'SECTOR_FLOW', ...cfSectorFlow(symbol) },
    { name: 'SESSION', ...cfSession(symbol) },
    { name: 'CROSS_FUNDING', ...cfCrossExFunding(crossFunding) }
  ];
  let lc = 0, sc2 = 0, ls = 0, ss = 0;
  for (const l of layers) {
    if (l.score > 15) {
      if (l.dir === 'LONG') { lc++; ls += l.score; }
      else if (l.dir === 'SHORT') { sc2++; ss += l.score; }
    }
  }
  const dir = lc > sc2 ? 'LONG' : sc2 > lc ? 'SHORT' : 'NEUTRAL';
  const ag = Math.max(lc, sc2);
  const ts2 = dir === 'LONG' ? ls : dir === 'SHORT' ? ss : 0;
  const score = Math.min(100, ts2 * (0.5 + ag * 0.15));
  const level = ag >= 5 ? 'HIGH' : ag >= 4 ? 'MEDIUM' : ag >= 2 ? 'LOW' : 'NONE';
  return { direction: dir, score, level, agreeing: ag, layers, longCount: lc, shortCount: sc2 };
}

module.exports = { computeConfluence, cfLeadLag, cfFundOI, cfCorrBreak, cfVolAnomaly, cfSectorFlow, cfSession, cfCrossExFunding };
