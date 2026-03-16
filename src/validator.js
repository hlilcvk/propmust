/** AGENT 0: VALIDATOR — verifies every data point before publish */

function validateCollector(symbol, ticker, klines) {
  const e = [], w = [];
  if (!ticker || ticker.price <= 0) e.push('Price missing or zero');
  if (ticker && ticker.price > (ticker.hi || Infinity) * 1.01) w.push(`Price ${ticker.price} > 24h high ${ticker.hi}`);
  if (!klines || klines.length < 30) e.push(`Klines too short: ${klines?.length || 0}`);
  if (klines && klines.length > 1) {
    for (let i = 1; i < Math.min(klines.length, 10); i++) {
      if (klines[i].t <= klines[i - 1].t) { e.push('Klines not chronological'); break; }
    }
    for (let i = 0; i < Math.min(klines.length, 10); i++) {
      const k = klines[i];
      if (k.h < k.o || k.h < k.c || k.l > k.o || k.l > k.c) { e.push(`OHLC logic error at bar ${i}`); break; }
    }
    const last = klines[klines.length - 1];
    if (ticker && Math.abs(last.c - ticker.price) / ticker.price > 0.02) w.push(`Kline close ${last.c} vs ticker ${ticker.price} >2% diff`);
  }
  if (ticker?.fund !== undefined && Math.abs(ticker.fund) > 0.01) w.push(`Extreme funding: ${(ticker.fund * 100).toFixed(4)}%`);
  if (ticker?.oi_delta !== undefined && Math.abs(ticker.oi_delta) > 50) w.push(`Extreme OI delta: ${ticker.oi_delta.toFixed(1)}%`);
  return { valid: e.length === 0, errors: e, warnings: w, severity: e.length > 0 ? 'BLOCK' : w.length > 0 ? 'WARN' : 'OK' };
}

function validateCrossPrice(symbol, prices) {
  const vals = Object.entries(prices).filter(([_, v]) => v > 0);
  if (vals.length < 2) return { valid: true, note: 'Single exchange' };
  const avg = vals.reduce((s, [_, v]) => s + v, 0) / vals.length;
  const anomalies = vals.filter(([_, v]) => Math.abs(v - avg) / avg > 0.01);
  if (anomalies.length > 0) return { valid: false, severity: 'WARN', anomalies: anomalies.map(([ex, p]) => ({ ex, price: p, dev: ((p - avg) / avg * 100).toFixed(2) + '%' })) };
  return { valid: true };
}

function validateTA(symbol, rsi, macd, atr, klines) {
  const e = [], w = [];
  if (rsi < 0 || rsi > 100) e.push(`RSI out of bounds: ${rsi}`);
  if (atr <= 0) e.push(`ATR <= 0`);
  if (klines && klines.length >= 20) {
    const chg = (klines[klines.length - 1].c - klines[klines.length - 20].c) / klines[klines.length - 20].c * 100;
    if (chg > 10 && rsi < 40) e.push(`Price +${chg.toFixed(1)}% but RSI ${rsi.toFixed(0)} — calculation error?`);
    if (chg < -10 && rsi > 60) e.push(`Price ${chg.toFixed(1)}% but RSI ${rsi.toFixed(0)} — calculation error?`);
    if (atr / klines[klines.length - 1].c > 0.2) w.push(`ATR ${(atr / klines[klines.length - 1].c * 100).toFixed(1)}% of price — abnormally high`);
  }
  return { valid: e.length === 0, errors: e, warnings: w, severity: e.length > 0 ? 'BLOCK' : w.length > 0 ? 'WARN' : 'OK' };
}

function validateTP(symbol, direction, tpMatrix, price) {
  const e = [], w = [];
  if (!tpMatrix || tpMatrix.length === 0) { e.push('Empty TP matrix'); return { valid: false, errors: e, warnings: w, severity: 'BLOCK' }; }
  for (let i = 0; i < tpMatrix.length; i++) {
    const tp = tpMatrix[i];
    if (direction === 'LONG' && tp.price <= price) e.push(`${tp.label} (${tp.price}) below price — LONG TPs must be above`);
    if (direction === 'SHORT' && tp.price >= price) e.push(`${tp.label} (${tp.price}) above price — SHORT TPs must be below`);
    if (!tp.source) w.push(`${tp.label} missing source`);
    if (tp.source === 'ATR_FALLBACK') w.push(`${tp.label} is ATR fallback — no structural level found`);
    if (i > 0) {
      if (direction === 'LONG' && tp.price <= tpMatrix[i - 1].price) e.push(`${tp.label} not ascending`);
      if (direction === 'SHORT' && tp.price >= tpMatrix[i - 1].price) e.push(`${tp.label} not descending`);
    }
  }
  const tp1Dist = Math.abs(tpMatrix[0].price - price) / price * 100;
  if (tp1Dist > 10) w.push(`TP1 ${tp1Dist.toFixed(1)}% away — unrealistic?`);
  return { valid: e.length === 0, errors: e, warnings: w, severity: e.length > 0 ? 'BLOCK' : w.length > 2 ? 'WARN' : 'OK' };
}

function validateConfluence(symbol, conf, ticker) {
  const e = [], w = [];
  if (conf.agreeing > conf.layers.length) e.push(`Agreeing ${conf.agreeing} > layers ${conf.layers.length}`);
  const lc = conf.layers.filter(l => l.score > 15 && l.dir === 'LONG').length;
  const sc = conf.layers.filter(l => l.score > 15 && l.dir === 'SHORT').length;
  if (conf.direction === 'LONG' && sc > lc) e.push(`Dir LONG but more SHORT layers (${sc} > ${lc})`);
  if (conf.direction === 'SHORT' && lc > sc) e.push(`Dir SHORT but more LONG layers (${lc} > ${sc})`);
  for (const l of conf.layers) {
    if (l.score > 100 || l.score < 0) e.push(`${l.name} score ${l.score} out of [0,100]`);
  }
  if (Math.abs(ticker?.ch || 0) > 15 && conf.level === 'HIGH') w.push(`${(ticker.ch).toFixed(1)}% already moved but HIGH confluence — late signal?`);
  return { valid: e.length === 0, errors: e, warnings: w, severity: e.length > 0 ? 'BLOCK' : w.length > 0 ? 'WARN' : 'OK' };
}

function validateBeforePublish(signal) {
  const e = [], w = [];
  const req = ['symbol', 'direction', 'entry_low', 'entry_high', 'stop_loss', 'tp_matrix', 'confluence_level'];
  for (const f of req) { if (signal[f] === undefined || signal[f] === null) e.push(`Missing field: ${f}`); }
  if (signal.direction === 'LONG' && signal.stop_loss >= signal.entry_low) e.push(`LONG but SL >= entry_low`);
  if (signal.direction === 'SHORT' && signal.stop_loss <= signal.entry_high) e.push(`SHORT but SL <= entry_high`);
  if (signal.confluence_level === 'NONE') e.push(`Confluence NONE — minimum LOW required`);
  if (signal.tp_matrix?.[0]) {
    const risk = Math.abs((signal.entry_low + signal.entry_high) / 2 - signal.stop_loss);
    const reward = Math.abs(signal.tp_matrix[0].price - (signal.entry_low + signal.entry_high) / 2);
    if (risk > 0 && reward / risk < 1.0) w.push(`TP1 R:R ${(reward / risk).toFixed(2)} < 1.0`);
  }
  return { approved: e.length === 0, errors: e, warnings: w, severity: e.length > 0 ? 'BLOCK' : w.length > 0 ? 'WARN' : 'OK' };
}

function postPublishAudit(signal, price) {
  const alerts = [];
  const age = (Date.now() - new Date(signal.created_at).getTime()) / 60000;
  if (age > 240 && signal.state === 'MONITORING') alerts.push({ type: 'STALE', msg: `4h+ in MONITORING` });
  const dist = Math.abs(price - (signal.entry_low + signal.entry_high) / 2) / price * 100;
  if (dist > 5 && signal.state === 'ACTIVE') alerts.push({ type: 'DRIFT', msg: `Price ${dist.toFixed(1)}% from entry` });
  if ((signal.confluence_agreeing || 0) < 2 && ['MONITORING', 'APPROACHING'].includes(signal.state)) alerts.push({ type: 'CONF_DROP', msg: `Confluence dropped to ${signal.confluence_agreeing}/7` });
  return alerts;
}

module.exports = { validateCollector, validateCrossPrice, validateTA, validateTP, validateConfluence, validateBeforePublish, postPublishAudit };
