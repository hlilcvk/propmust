/** AGENT 2: STRUCTURE ANALYST — swing/FVG/VOB/equal levels from real OHLCV */

function findSwings(klines, left = 5, right = 5) {
  const swings = [];
  if (!klines || klines.length < left + right + 1) return swings;
  for (let i = left; i < klines.length - right; i++) {
    let isHi = true, isLo = true;
    for (let j = 1; j <= left; j++) {
      if (klines[i].h <= klines[i - j].h) isHi = false;
      if (klines[i].l >= klines[i - j].l) isLo = false;
    }
    for (let j = 1; j <= right; j++) {
      if (klines[i].h <= klines[i + j].h) isHi = false;
      if (klines[i].l >= klines[i + j].l) isLo = false;
    }
    if (isHi) swings.push({ price: klines[i].h, type: 'RESISTANCE', bar: i, strength: 1 });
    if (isLo) swings.push({ price: klines[i].l, type: 'SUPPORT', bar: i, strength: 1 });
  }
  return swings;
}

function findEqualLevels(swings, threshold = 0.002) {
  const clusters = [];
  const used = new Set();
  for (let i = 0; i < swings.length; i++) {
    if (used.has(i)) continue;
    const group = [swings[i]];
    for (let j = i + 1; j < swings.length; j++) {
      if (used.has(j)) continue;
      if (swings[i].type !== swings[j].type) continue;
      if (Math.abs(swings[i].price - swings[j].price) / swings[i].price < threshold) {
        group.push(swings[j]); used.add(j);
      }
    }
    if (group.length >= 2) {
      const avg = group.reduce((s, g) => s + g.price, 0) / group.length;
      clusters.push({ price: avg, type: group[0].type, strength: group.length, source: 'EQUAL_LEVEL' });
      used.add(i);
    }
  }
  return clusters;
}

function findFVG(klines) {
  const gaps = [];
  if (!klines || klines.length < 3) return gaps;
  for (let i = 2; i < klines.length; i++) {
    const c1 = klines[i - 2], c3 = klines[i];
    if (c3.l > c1.h) gaps.push({ upper: c3.l, lower: c1.h, mid: (c3.l + c1.h) / 2, type: 'BULL_FVG', bar: i });
    if (c3.h < c1.l) gaps.push({ upper: c1.l, lower: c3.h, mid: (c1.l + c3.h) / 2, type: 'BEAR_FVG', bar: i });
  }
  if (klines.length === 0) return gaps;
  const last = klines[klines.length - 1].c;
  return gaps.filter(g => {
    if (g.type === 'BULL_FVG' && last < g.lower) return true;
    if (g.type === 'BEAR_FVG' && last > g.upper) return true;
    return false;
  });
}

function findVOB(klines) {
  if (!klines || klines.length < 30) return [];
  const avgVol = klines.reduce((s, k) => s + k.v, 0) / klines.length;
  const zones = [];
  for (let i = 2; i < klines.length - 1; i++) {
    const k = klines[i];
    if (k.v < avgVol * 1.5) continue;
    const body = Math.abs(k.c - k.o), range = k.h - k.l;
    if (range === 0 || body / range < 0.4) continue;
    const bull = k.c > k.o;
    const last = klines[klines.length - 1].c;
    let valid = true;
    if (bull && last < Math.min(k.o, k.c)) valid = false;
    if (!bull && last > Math.max(k.o, k.c)) valid = false;
    if (valid) {
      zones.push({
        type: bull ? 'BULL_OB' : 'BEAR_OB',
        upper: Math.max(k.o, k.c), lower: Math.min(k.o, k.c),
        mid: (k.o + k.c) / 2, volume: k.v, volRatio: k.v / avgVol, bar: i, source: 'VOB'
      });
    }
  }
  return zones.sort((a, b) => b.volume - a.volume).slice(0, 10);
}

function detectTrend(klines, period = 20) {
  if (!klines || klines.length < period) return 'NEUTRAL';
  const recent = klines.slice(-period);
  const first = recent[0].c, last = recent[recent.length - 1].c;
  if (last > first * 1.01) return 'BULLISH';
  if (last < first * 0.99) return 'BEARISH';
  return 'NEUTRAL';
}

function clusterLevels(levels, threshold = 0.005) {
  const sorted = [...levels].sort((a, b) => a.price - b.price);
  const merged = [];
  for (const lv of sorted) {
    const near = merged.find(m => Math.abs(m.price - lv.price) / lv.price < threshold);
    if (near) { near.strength = (near.strength || 1) + 1; near.price = (near.price + lv.price) / 2; }
    else merged.push({ ...lv });
  }
  return merged.sort((a, b) => (b.strength || 1) - (a.strength || 1)).slice(0, 8);
}

function analyzeStructure(klines, tf) {
  const swings = findSwings(klines);
  const equalLevels = findEqualLevels(swings);
  const fvgs = findFVG(klines);
  const vobs = findVOB(klines);
  const trend = detectTrend(klines);
  const supports = clusterLevels(swings.filter(s => s.type === 'SUPPORT'));
  const resistances = clusterLevels(swings.filter(s => s.type === 'RESISTANCE'));
  return { swings, equalLevels, fvgs, vobs, trend, supports, resistances, tf };
}

module.exports = { findSwings, findEqualLevels, findFVG, findVOB, detectTrend, clusterLevels, analyzeStructure };
