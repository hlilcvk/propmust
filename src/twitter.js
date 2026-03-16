/** AGENT 7: X (TWITTER) BOT — only HIGH confluence signals */

let client = null;
let dailyCount = 0;
let lastResetDay = -1;

function initTwitter() {
  const key = process.env.X_API_KEY;
  if (!key) { console.log('[X] No API key — disabled'); return null; }
  try {
    const { TwitterApi } = require('twitter-api-v2');
    client = new TwitterApi({
      appKey: process.env.X_API_KEY, appSecret: process.env.X_API_SECRET,
      accessToken: process.env.X_ACCESS_TOKEN, accessSecret: process.env.X_ACCESS_SECRET
    });
    console.log('[X] Bot initialized');
    return client;
  } catch (e) { console.error('[X] Init error:', e.message); return null; }
}

function resetDailyCounter() {
  const today = new Date().getUTCDate();
  if (today !== lastResetDay) { dailyCount = 0; lastResetDay = today; }
}

function formatSignalTweet(s) {
  const dir = s.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
  const sym = s.symbol.replace('USDT', '');
  const layers = (s.confluence_layers || []).filter(l => l.score > 15).slice(0, 3)
    .map(l => `▸ ${l.name.replace('_', ' ')}: ${(l.detail || '').substring(0, 50)}`).join('\n');
  const exs = s.extra?.exchanges?.slice(0, 4).join(' | ') || 'BNB';
  const tp1 = s.tp_matrix?.[0];
  const tp2 = s.tp_matrix?.[1];
  const tpLine = tp1 ? `TP1: ${(+tp1.price).toFixed(2)} (${tp1.source})${tp2 ? ` | TP2: ${(+tp2.price).toFixed(2)} (${tp2.source})` : ''}` : '';
  return `$${sym} ${dir} | Confluence ${s.confluence_agreeing}/7 ${s.confluence_level}\n\n${layers}\n\n📍 ${exs}\n${tpLine}\nSL: ${(+s.stop_loss).toFixed(2)}\n\nNFA | PROPTREX`;
}

function formatTPHitTweet(s, tp) {
  const sym = s.symbol.replace('USDT', '');
  const entry = (+s.entry_low + +s.entry_high) / 2;
  const pnl = s.direction === 'LONG' ? ((tp.price - entry) / entry * 100) : ((entry - tp.price) / entry * 100);
  return `✅ $${sym} — ${tp.label} HIT @ $${(+tp.price).toFixed(2)} (+${pnl.toFixed(1)}%)\n\nNFA | PROPTREX`;
}

function formatInsightTweet(type, data) {
  switch (type) {
    case 'LEAD_LAG':
      const lagging = data.slice(0, 5).map(d => `$${d.symbol.replace('USDT', '')} (${d.lag.toFixed(1)}%)`).join(', ');
      return `⏱ BTC moved +${data[0]?.btcMove?.toFixed(1) || '?'}% — these alts haven't followed yet:\n\n${lagging}\n\nLead-lag signal active.\n\nNFA | PROPTREX`;
    case 'FUNDING_HEATMAP':
      const extreme = data.slice(0, 5).map(d => `$${d.symbol.replace('USDT', '')} ${(d.fund * 100).toFixed(4)}%`).join('\n');
      return `💰 Extreme Funding Rates (squeeze candidates):\n\n${extreme}\n\nCross-exchange analysis.\n\nNFA | PROPTREX`;
    case 'SECTOR_ROTATION':
      return `📊 Sector Rotation Alert:\n\n${data.from} → ${data.to}\n\nMoney flowing from ${data.from} to ${data.to}.\n\nNFA | PROPTREX`;
    default:
      return null;
  }
}

async function postSignalTweet(signal) {
  if (!client) return;
  if (signal.confluence_level !== 'HIGH') return; // ONLY HIGH
  resetDailyCounter();
  if (dailyCount >= 3) { console.log('[X] Daily limit (3) reached'); return; }
  try {
    const text = formatSignalTweet(signal);
    if (text.length > 280) {
      // Trim if needed
      await client.v2.tweet({ text: text.substring(0, 277) + '...' });
    } else {
      await client.v2.tweet({ text });
    }
    dailyCount++;
    console.log(`[X] Signal posted: ${signal.symbol} (${dailyCount}/3 today)`);
  } catch (e) { console.error('[X] Tweet error:', e.message); }
}

async function postTPHitTweet(signal, tp) {
  if (!client) return;
  if (!signal.published_x) return; // only update published signals
  try {
    await client.v2.tweet({ text: formatTPHitTweet(signal, tp) });
  } catch (e) { console.error('[X] TP tweet error:', e.message); }
}

async function postInsight(type, data) {
  if (!client) return;
  const text = formatInsightTweet(type, data);
  if (!text) return;
  try { await client.v2.tweet({ text }); } catch (e) { console.error('[X] Insight error:', e.message); }
}

module.exports = { initTwitter, postSignalTweet, postTPHitTweet, postInsight, formatSignalTweet, formatTPHitTweet };
