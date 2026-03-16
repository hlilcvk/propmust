/** AGENT 5+8: ENGINE (TA + signal generation) + STATE MACHINE + JOURNAL */

const { candles, tickers, trackedSymbols, takePriceSnapshot, fetchCrossExchangeFunding, tokenExchangeMap } = require('./collector');
const { analyzeStructure } = require('./structure');
const { buildTpMatrix, computeStopLoss } = require('./tp-builder');
const { computeConfluence } = require('./confluence');
const V = require('./validator');
const { SYM_TO_SECTOR } = require('./exchanges');

// ── TA: RSI (Wilder 14) ──
function computeRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gS = 0, lS = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) gS += d; else lS += Math.abs(d); }
  let aG = gS / period, aL = lS / period;
  for (let i = period + 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; aG = (aG * (period - 1) + (d > 0 ? d : 0)) / period; aL = (aL * (period - 1) + (d < 0 ? Math.abs(d) : 0)) / period; }
  return aL === 0 ? 100 : 100 - 100 / (1 + aG / aL);
}
function ema(data, p) {
  if (data.length < p) return data.slice();
  const k = 2 / (p + 1); const r = [data.slice(0, p).reduce((a, b) => a + b, 0) / p];
  for (let i = p; i < data.length; i++) r.push(data[i] * k + r[r.length - 1] * (1 - k));
  return r;
}
function computeMACD(closes) {
  if (closes.length < 35) return { macd: 0, signal: 0, hist: 0 };
  const e12 = ema(closes, 12), e26 = ema(closes, 26), ml = Math.min(e12.length, e26.length);
  const line = []; for (let i = 0; i < ml; i++) line.push(e12[e12.length - ml + i] - e26[e26.length - ml + i]);
  const sig = ema(line, 9); const m = line[line.length - 1], s = sig[sig.length - 1];
  return { macd: m, signal: s, hist: m - s };
}
function computeATR(klines, period = 14) {
  if (klines.length < period + 1) return 0;
  let atr = 0;
  for (let i = 1; i <= period; i++) { atr += Math.max(klines[i].h - klines[i].l, Math.abs(klines[i].h - klines[i - 1].c), Math.abs(klines[i].l - klines[i - 1].c)); }
  atr /= period;
  for (let i = period + 1; i < klines.length; i++) { const tr = Math.max(klines[i].h - klines[i].l, Math.abs(klines[i].h - klines[i - 1].c), Math.abs(klines[i].l - klines[i - 1].c)); atr = (atr * (period - 1) + tr) / period; }
  return atr;
}

// ── DIRECTION ──
function computeDirection(ticker, structure, confluence, rsi, macd) {
  let bull = 0, bear = 0;
  if (structure.trend === 'BULLISH') bull += 2.5; if (structure.trend === 'BEARISH') bear += 2.5;
  if (rsi >= 55) bull += 1.2; if (rsi <= 45) bear += 1.2;
  if (rsi >= 78) bear += 0.5; if (rsi <= 22) bull += 0.5;
  if (macd.hist > 0) bull += 1.4; else if (macd.hist < 0) bear += 1.4;
  const fund = ticker.fund || 0;
  if (fund < -0.0003) bull += 0.6; else if (fund > 0.0003) bear += 0.6;
  const ch = ticker.ch || 0;
  if (ch > 0.8) bull += Math.min(1.2, ch * 0.1); else if (ch < -0.8) bear += Math.min(1.2, Math.abs(ch) * 0.1);
  if (Math.abs(ch) >= 30) { if (ch > 0) bull *= 0.7; else bear *= 0.7; }
  if (confluence.agreeing >= 3 && confluence.score >= 30) {
    if (confluence.direction === 'LONG') bull += confluence.agreeing * 2;
    else if (confluence.direction === 'SHORT') bear += confluence.agreeing * 2;
  }
  return bull > bear ? 'LONG' : bear > bull ? 'SHORT' : (ch >= 0 ? 'LONG' : 'SHORT');
}

// ── STATE MACHINE ──
function evaluateTransition(signal, price) {
  const mid = (signal.entry_low + signal.entry_high) / 2;
  const dist = Math.abs(price - mid) / price * 100;
  switch (signal.state) {
    case 'DETECTED': if (['HIGH', 'MEDIUM'].includes(signal.confluence_level)) return 'MONITORING'; break;
    case 'MONITORING': if (dist < 1.5) return 'APPROACHING'; if ((signal.confluence_agreeing || 0) < 2) return 'INVALIDATED'; break;
    case 'APPROACHING': if (dist < 0.3) return 'EXECUTION'; if (dist > 3) return 'MONITORING'; break;
    case 'EXECUTION': return 'ACTIVE';
    case 'ACTIVE':
      if (signal.direction === 'LONG' && price <= signal.stop_loss) return 'CLOSED_SL';
      if (signal.direction === 'SHORT' && price >= signal.stop_loss) return 'CLOSED_SL';
      const allHit = (signal.tp_matrix || []).every(tp => tp.hit);
      if (allHit && signal.tp_matrix?.length > 0) return 'CLOSED_TP';
      break;
  }
  return signal.state;
}

function checkTPHits(signal, price) {
  const hits = [];
  for (const tp of (signal.tp_matrix || [])) {
    if (tp.hit) continue;
    if (signal.direction === 'LONG' && price >= tp.price) { tp.hit = true; tp.hit_at = new Date().toISOString(); hits.push(tp); }
    if (signal.direction === 'SHORT' && price <= tp.price) { tp.hit = true; tp.hit_at = new Date().toISOString(); hits.push(tp); }
  }
  return hits;
}

// ── JOURNAL ──
async function closeToJournal(supabase, signal, result, exitPrice) {
  try {
    const entry = (signal.entry_low + signal.entry_high) / 2;
    const pnl = signal.direction === 'LONG' ? (exitPrice - entry) / entry * 100 : (entry - exitPrice) / entry * 100;
    const risk = Math.abs(entry - signal.stop_loss);
    const rr = risk > 0 ? Math.abs(exitPrice - entry) / risk : 0;
    await supabase.from('trade_journal').insert({
      signal_id: signal.id, symbol: signal.symbol, direction: signal.direction,
      entry_price: entry, exit_price: exitPrice, stop_loss: signal.stop_loss,
      tp1_price: signal.tp_matrix?.[0]?.price, tp1_hit: signal.tp_matrix?.[0]?.hit || false,
      tp2_price: signal.tp_matrix?.[1]?.price, tp2_hit: signal.tp_matrix?.[1]?.hit || false,
      tp3_price: signal.tp_matrix?.[2]?.price, tp3_hit: signal.tp_matrix?.[2]?.hit || false,
      result, pnl_pct: +pnl.toFixed(2), rr_achieved: +rr.toFixed(2),
      confluence_level: signal.confluence_level, confluence_agreeing: signal.confluence_agreeing,
      closed_at: new Date().toISOString(),
      published_telegram: signal.published_telegram, published_x: signal.published_x
    });
  } catch (e) { console.error('[Journal]', e.message); }
}

async function getStats(supabase, days = 7) {
  try {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const { data } = await supabase.from('trade_journal').select('*').gte('closed_at', since);
    if (!data || !data.length) return { total: 0, wins: 0, losses: 0, winRate: '0', avgRR: '0' };
    const wins = data.filter(t => t.result?.startsWith('WIN'));
    const losses = data.filter(t => t.result === 'LOSS_SL');
    return {
      total: data.length, wins: wins.length, losses: losses.length,
      winRate: (wins.length / data.length * 100).toFixed(1),
      avgRR: wins.length > 0 ? (wins.reduce((s, t) => s + (t.rr_achieved || 0), 0) / wins.length).toFixed(2) : '0',
      avgPnl: (data.reduce((s, t) => s + (t.pnl_pct || 0), 0) / data.length).toFixed(2),
      byLevel: {
        HIGH: calcLevelStats(data.filter(t => t.confluence_level === 'HIGH')),
        MEDIUM: calcLevelStats(data.filter(t => t.confluence_level === 'MEDIUM'))
      }
    };
  } catch (e) { return { total: 0, error: e.message }; }
}

function calcLevelStats(arr) {
  if (!arr.length) return { total: 0, wins: 0, winRate: '0' };
  const w = arr.filter(t => t.result?.startsWith('WIN'));
  return { total: arr.length, wins: w.length, winRate: (w.length / arr.length * 100).toFixed(1) };
}

// ── MAIN ENGINE ──
async function generateSignal(symbol, snapshots, corrMatrix) {
  const t = tickers.get(symbol);
  if (!t || !t.price) return null;
  const kl1h = candles.get(symbol)?.get('1h');
  if (!kl1h || kl1h.length < 50) return null;

  // Validator checkpoint 1: Collector output
  const vc = V.validateCollector(symbol, t, kl1h);
  if (vc.severity === 'BLOCK') { console.log(`[V BLOCK] ${symbol}: ${vc.errors.join(', ')}`); return null; }

  const structure = analyzeStructure(kl1h, '1h');
  const closes = kl1h.map(k => k.c);
  const rsi = computeRSI(closes);
  const macd = computeMACD(closes);
  const atr = computeATR(kl1h);
  t.computed_rsi = rsi; t.computed_macd = macd;

  // Validator checkpoint 2: TA
  const vta = V.validateTA(symbol, rsi, macd, atr, kl1h);
  if (vta.severity === 'BLOCK') { console.log(`[V BLOCK TA] ${symbol}: ${vta.errors.join(', ')}`); return null; }

  // Cross-exchange funding (top 20 only)
  let crossFund = {};
  if (trackedSymbols().indexOf(symbol) < 20) {
    try { crossFund = await fetchCrossExchangeFunding(symbol); } catch (e) {}
  }

  const confluence = computeConfluence(symbol, snapshots, corrMatrix, crossFund);

  // Validator checkpoint 3: Confluence
  const vconf = V.validateConfluence(symbol, confluence, t);
  if (vconf.severity === 'BLOCK') { console.log(`[V BLOCK CONF] ${symbol}: ${vconf.errors.join(', ')}`); return null; }

  const direction = computeDirection(t, structure, confluence, rsi, macd);
  const klinesByTF = {};
  for (const tf of ['5m', '15m', '1h', '4h']) {
    const kl = candles.get(symbol)?.get(tf);
    if (kl) klinesByTF[tf] = kl;
  }
  const tpMatrix = buildTpMatrix(symbol, direction, t.price, klinesByTF, atr);
  const stopLoss = computeStopLoss(direction, t.price, kl1h, atr);

  // Validator checkpoint 4: TP
  const vtp = V.validateTP(symbol, direction, tpMatrix, t.price);
  if (vtp.severity === 'BLOCK') { console.log(`[V BLOCK TP] ${symbol}: ${vtp.errors.join(', ')}`); return null; }

  const entryHalf = atr * 0.4;
  const entry_low = direction === 'LONG' ? t.price - entryHalf : t.price - entryHalf * 0.5;
  const entry_high = direction === 'LONG' ? t.price + entryHalf * 0.5 : t.price + entryHalf;
  const entry_distance_pct = Math.abs(t.price - (entry_low + entry_high) / 2) / t.price * 100;

  let opp = 50;
  opp += confluence.agreeing * 8;
  if (structure.trend === (direction === 'LONG' ? 'BULLISH' : 'BEARISH')) opp += 10;
  if (entry_distance_pct < 1) opp += 15;
  opp = Math.min(100, Math.max(0, opp));

  const exList = tokenExchangeMap.get(symbol) || ['BINANCE'];

  const signal = {
    symbol, s: symbol.replace('USDT', ''),
    signal_key: `${symbol}|${direction}`,
    direction, setup_type: confluence.level === 'HIGH' ? 'CONFLUENCE' : structure.trend !== 'NEUTRAL' ? 'TREND' : 'MEAN_REVERSION',
    state: 'DETECTED',
    opportunity_score: opp, confluence_score: confluence.score,
    confluence_level: confluence.level, confluence_agreeing: confluence.agreeing,
    confluence_layers: confluence.layers,
    entry_low, entry_high, stop_loss: stopLoss, entry_distance_pct,
    tp_matrix: tpMatrix,
    whale_score: 0, whale_side: 'NEUTRAL',
    freshness: 100, discovery_score: Math.max(0, 80 - Math.abs(t.ch || 0) * 3),
    panel_rank_score: opp + confluence.agreeing * 5,
    primary_tf: '1h', reasons: [],
    price: t.price, ch: t.ch || 0, fund: t.fund || 0, vol24: t.vol24 || 0,
    rsi, macd_hist: macd.hist, atr,
    sector: SYM_TO_SECTOR[symbol] || 'other',
    exchanges: exList
  };

  // Validator checkpoint 5: Pre-publish
  const vpub = V.validateBeforePublish(signal);
  if (!vpub.approved) { signal._blocked = true; signal._blockReasons = vpub.errors; }
  if (vpub.warnings.length > 0) signal._warnings = vpub.warnings;

  return signal;
}

async function runEngine(supabase) {
  console.log('[Engine] Running...');
  const t0 = Date.now();

  const { data: snapRows } = await supabase.from('price_snapshots').select('data,ts').order('ts', { ascending: false }).limit(60);
  const snapshots = (snapRows || []).reverse();
  const snap = takePriceSnapshot();
  if (Object.keys(snap).length > 0) await supabase.from('price_snapshots').insert({ data: snap });

  // Correlation matrix
  let corrMatrix = {};
  const { data: corrRow } = await supabase.from('correlation_matrix').select('matrix').order('ts', { ascending: false }).limit(1).single().catch(() => ({ data: null }));
  if (corrRow) corrMatrix = corrRow.matrix;

  const signals = [];
  for (const sym of trackedSymbols()) {
    const sig = await generateSignal(sym, snapshots, corrMatrix);
    if (sig && !sig._blocked) signals.push(sig);
  }
  signals.sort((a, b) => b.panel_rank_score - a.panel_rank_score);

  // Upsert
  for (const sig of signals) {
    const newState = evaluateTransition(sig, sig.price);
    sig.state = newState;
    await supabase.from('signals').upsert({
      symbol: sig.symbol, signal_key: sig.signal_key, direction: sig.direction,
      setup_type: sig.setup_type, state: sig.state,
      opportunity_score: sig.opportunity_score,
      confluence_score: sig.confluence_score, confluence_level: sig.confluence_level,
      confluence_agreeing: sig.confluence_agreeing, confluence_layers: sig.confluence_layers,
      entry_low: sig.entry_low, entry_high: sig.entry_high, stop_loss: sig.stop_loss,
      tp_matrix: sig.tp_matrix, whale_score: sig.whale_score, whale_side: sig.whale_side,
      freshness: sig.freshness, discovery_score: sig.discovery_score,
      panel_rank_score: sig.panel_rank_score, primary_tf: sig.primary_tf,
      entry_distance_pct: sig.entry_distance_pct, price: sig.price,
      reasons: sig.reasons, updated_at: new Date().toISOString(),
      extra: { rsi: sig.rsi, macd_hist: sig.macd_hist, ch: sig.ch, fund: sig.fund, sector: sig.sector, exchanges: sig.exchanges }
    }, { onConflict: 'signal_key' });
  }

  // Check active signals for TP/SL hits
  const { data: actives } = await supabase.from('signals').select('*').in('state', ['ACTIVE', 'APPROACHING', 'EXECUTION']);
  for (const sig of (actives || [])) {
    const t = tickers.get(sig.symbol);
    if (!t) continue;
    const hits = checkTPHits(sig, t.price);
    const newState = evaluateTransition(sig, t.price);
    if (newState !== sig.state) {
      await supabase.from('signals').update({ state: newState, tp_matrix: sig.tp_matrix, updated_at: new Date().toISOString() }).eq('id', sig.id);
      if (newState === 'CLOSED_SL') await closeToJournal(supabase, sig, 'LOSS_SL', t.price);
      if (newState === 'CLOSED_TP') await closeToJournal(supabase, sig, `WIN_TP${sig.tp_matrix.filter(tp => tp.hit).length}`, t.price);
    } else if (hits.length > 0) {
      await supabase.from('signals').update({ tp_matrix: sig.tp_matrix, updated_at: new Date().toISOString() }).eq('id', sig.id);
    }
  }

  await supabase.rpc('cleanup_old').catch(() => {});
  console.log(`[Engine] ${signals.length} signals in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return signals;
}

module.exports = {
  runEngine, generateSignal, computeRSI, computeMACD, computeATR,
  computeDirection, evaluateTransition, checkTPHits, closeToJournal, getStats
};
