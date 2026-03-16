/** AGENT 3: TP BUILDER — structural targets, NOT ATR multiples */

const { findSwings, findEqualLevels, findFVG, findVOB } = require('./structure');

const TF_WEIGHT = { '4h': 4.0, '1h': 3.0, '15m': 2.0, '5m': 1.0 };
const SRC_BONUS = { 'EQUAL_LEVEL': 1.5, 'VOB': 1.3, 'SWING': 1.0, 'FVG': 0.8 };

function collectAllLevels(klinesByTF, direction, price) {
  const all = [];
  for (const [tf, kl] of Object.entries(klinesByTF)) {
    if (!kl || kl.length < 20) continue;
    const swings = findSwings(kl);
    for (const s of swings) all.push({ price: s.price, type: s.type, tf, source: 'SWING', strength: s.strength || 1 });
    const eqs = findEqualLevels(swings);
    for (const e of eqs) all.push({ ...e, tf });
    const fvgs = findFVG(kl);
    for (const f of fvgs) {
      const target = (direction === 'LONG' && f.type === 'BEAR_FVG') || (direction === 'SHORT' && f.type === 'BULL_FVG');
      if (target) all.push({ price: f.mid, tf, source: 'FVG', type: f.type });
    }
    if (['1h', '4h'].includes(tf)) {
      const vobs = findVOB(kl);
      for (const z of vobs) {
        const target = (direction === 'LONG' && z.type === 'BEAR_OB') || (direction === 'SHORT' && z.type === 'BULL_OB');
        if (target) all.push({ price: z.mid, tf, source: 'VOB', volRatio: z.volRatio });
      }
    }
  }
  return all;
}

function filterByDirection(levels, direction, price) {
  if (direction === 'LONG') return levels.filter(l => l.price > price * 1.002).sort((a, b) => a.price - b.price);
  return levels.filter(l => l.price < price * 0.998).sort((a, b) => b.price - a.price);
}

function prioritize(levels) {
  return levels.map(l => ({
    ...l,
    priority: (TF_WEIGHT[l.tf] || 1) * (SRC_BONUS[l.source] || 1) * (l.strength || 1)
  })).sort((a, b) => {
    // Same direction: closer first, then by priority
    return (a._dist || 0) - (b._dist || 0) || b.priority - a.priority;
  });
}

function clampByHigherTF(tps, allLevels, direction) {
  const barriers = allLevels.filter(l => (TF_WEIGHT[l.tf] || 0) >= 3);
  if (!barriers.length) return tps;
  const barrier = barriers[0];
  return tps.map(tp => {
    if (direction === 'LONG' && tp.price > barrier.price) return { ...tp, price: barrier.price * 0.997, clamped: true };
    if (direction === 'SHORT' && tp.price < barrier.price) return { ...tp, price: barrier.price * 1.003, clamped: true };
    return tp;
  });
}

function selectFinal(candidates, atr, price, direction) {
  const minGap = atr * 0.6;
  const minFromEntry = atr * 0.3;
  const final = [];
  let lastPx = price;
  for (const c of candidates) {
    if (Math.abs(c.price - price) < minFromEntry) continue;
    if (final.length > 0 && Math.abs(c.price - lastPx) < minGap) {
      if (c.priority > (final[final.length - 1].priority || 0)) { final[final.length - 1] = c; lastPx = c.price; }
      continue;
    }
    final.push(c); lastPx = c.price;
    if (final.length >= 4) break;
  }
  // ATR fallback ONLY if no structural levels found
  if (final.length === 0) {
    const sign = direction === 'LONG' ? 1 : -1;
    final.push({ price: price + sign * atr * 1.5, source: 'ATR_FALLBACK', tf: 'none', priority: 0.1 });
    final.push({ price: price + sign * atr * 3.0, source: 'ATR_FALLBACK', tf: 'none', priority: 0.1 });
  }
  return final;
}

function snapToStructure(tps, allLevels, atr) {
  const radius = atr * 1.2;
  return tps.map(tp => {
    const nearest = allLevels.find(l => Math.abs(l.price - tp.price) < radius && l.source !== 'ATR_FALLBACK');
    if (nearest && tp.source === 'ATR_FALLBACK') return { ...tp, price: nearest.price, source: nearest.source, tf: nearest.tf, snapped: true };
    return tp;
  });
}

function buildTpMatrix(symbol, direction, price, klinesByTF, atr) {
  const all = collectAllLevels(klinesByTF, direction, price);
  const filtered = filterByDirection(all, direction, price);
  // Add distance for sorting
  filtered.forEach(l => { l._dist = Math.abs(l.price - price); });
  const prioritized = prioritize(filtered);
  const clamped = clampByHigherTF(prioritized, all, direction);
  let tps = selectFinal(clamped, atr, price, direction);
  tps = snapToStructure(tps, all, atr);
  const risk = Math.abs(price - (direction === 'LONG' ? price - atr * 1.5 : price + atr * 1.5));
  return tps.map((tp, i) => ({
    price: +tp.price.toFixed(8),
    source: tp.source || 'UNKNOWN',
    tf: tp.tf || 'multi',
    label: `TP${i + 1}`,
    rr: risk > 0 ? +((Math.abs(tp.price - price) / risk).toFixed(2)) : 0,
    distance_pct: ((tp.price - price) / price * 100).toFixed(2) + '%',
    hit: false, hit_at: null, snapped: tp.snapped || false
  }));
}

function computeStopLoss(direction, price, klines, atr) {
  const swings = findSwings(klines, 3, 3);
  if (direction === 'LONG') {
    const lows = swings.filter(s => s.type === 'SUPPORT' && s.price < price).sort((a, b) => b.price - a.price);
    return lows.length > 0 ? lows[0].price - atr * 0.2 : price - atr * 1.5;
  }
  const highs = swings.filter(s => s.type === 'RESISTANCE' && s.price > price).sort((a, b) => a.price - b.price);
  return highs.length > 0 ? highs[0].price + atr * 0.2 : price + atr * 1.5;
}

module.exports = { buildTpMatrix, computeStopLoss, collectAllLevels, filterByDirection };
