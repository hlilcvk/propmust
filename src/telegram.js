/** AGENT 6: TELEGRAM BOT — signal notifications + commands */

const settings = require('./settings');

let bot = null;
let channelId = null;
let adminId = null;
let _supabase = null;

async function initTelegram(supabase) {
  _supabase = supabase;
  const cfg = settings.load();
  const token = cfg.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN;
  channelId = cfg.telegram_channel_id || process.env.TELEGRAM_CHANNEL_ID;
  adminId = cfg.telegram_admin_id || process.env.TELEGRAM_ADMIN_ID;

  if (!token) { console.log('[Telegram] No token — go to /admin to configure'); return null; }

  // Stop existing bot before re-init
  if (bot) {
    try { await bot.stopPolling(); } catch (e) {}
    bot = null;
    await new Promise(r => setTimeout(r, 1000));
  }

  try {
    const TelegramBot = require('node-telegram-bot-api');
    bot = new TelegramBot(token, { polling: { autoStart: false } });
    await bot.deleteWebhook();
    bot.startPolling();

    bot.onText(/\/signals/, async (msg) => {
      const { data } = await _supabase.from('signals').select('symbol,direction,state,confluence_level,opportunity_score').neq('state', 'INVALIDATED').order('panel_rank_score', { ascending: false }).limit(10);
      if (!data?.length) return bot.sendMessage(msg.chat.id, 'No active signals.');
      const lines = data.map((s, i) => `${i + 1}. ${s.direction === 'LONG' ? '🟢' : '🔴'} ${s.symbol.replace('USDT', '')} — ${s.state} (${s.confluence_level} ${s.opportunity_score?.toFixed(0)})`);
      bot.sendMessage(msg.chat.id, `📊 Active Signals:\n\n${lines.join('\n')}`);
    });

    bot.onText(/\/stats/, async (msg) => {
      const { getStats } = require('./engine');
      const st = await getStats(_supabase, 7);
      bot.sendMessage(msg.chat.id, `📊 7-Day Stats:\nTotal: ${st.total} | Win: ${st.wins} | Loss: ${st.losses}\nWin Rate: ${st.winRate}% | Avg R:R: ${st.avgRR}\nAvg PnL: ${st.avgPnl}%`);
    });

    bot.onText(/\/detail (.+)/, async (msg, match) => {
      const sym = match[1].toUpperCase() + (match[1].toUpperCase().endsWith('USDT') ? '' : 'USDT');
      const { data } = await _supabase.from('signals').select('*').eq('symbol', sym).single();
      if (!data) return bot.sendMessage(msg.chat.id, `No signal for ${sym}`);
      bot.sendMessage(msg.chat.id, formatSignalFull(data), { parse_mode: 'HTML' });
    });

    console.log('[Telegram] Bot started');
    return bot;
  } catch (e) { console.error('[Telegram] Init error:', e.message); return null; }
}

async function reinitTelegram() {
  if (_supabase) return initTelegram(_supabase);
  console.log('[Telegram] Cannot reinit — no supabase client');
  return null;
}

function getBotStatus() {
  return { active: bot !== null, channelId, adminId };
}

function formatSignalFull(s) {
  const dir = s.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
  const sym = s.symbol.replace('USDT', '');
  const layers = (s.confluence_layers || []).filter(l => l.score > 15).map(l => `✦ ${l.name}: ${l.detail || l.dir}`).join('\n');
  const tps = (s.tp_matrix || []).map(tp => `${tp.label}: $${(+tp.price).toFixed(tp.price > 10 ? 2 : 4)} → ${tp.source} ${tp.tf} (R:R ${tp.rr})`).join('\n');
  const exs = s.extra?.exchanges?.join(' | ') || 'BNB';
  return `${dir} — $${sym}\n\n━━━ Confluence: ${s.confluence_agreeing}/7 ${s.confluence_level} ━━━\n${layers}\n\n📍 ${exs}\n\nEntry: $${(+s.entry_low).toFixed(2)} — $${(+s.entry_high).toFixed(2)}\nStop: $${(+s.stop_loss).toFixed(2)}\n\n${tps}\n\n⚠️ NFA | PROPTREX`;
}

function formatTPHit(s, tp) {
  const sym = s.symbol.replace('USDT', '');
  const entry = ((+s.entry_low + +s.entry_high) / 2);
  const pnl = s.direction === 'LONG' ? ((tp.price - entry) / entry * 100) : ((entry - tp.price) / entry * 100);
  return `✅ $${sym} — ${tp.label} HIT @ $${(+tp.price).toFixed(2)}\nEntry: $${entry.toFixed(2)} → ${tp.label}: $${(+tp.price).toFixed(2)} (${pnl > 0 ? '+' : ''}${pnl.toFixed(1)}%)`;
}

function formatSLHit(s, price) {
  const sym = s.symbol.replace('USDT', '');
  const entry = ((+s.entry_low + +s.entry_high) / 2);
  const pnl = s.direction === 'LONG' ? ((price - entry) / entry * 100) : ((entry - price) / entry * 100);
  return `❌ $${sym} — STOP HIT @ $${(+price).toFixed(2)}\nEntry: $${entry.toFixed(2)} → SL: $${(+price).toFixed(2)} (${pnl.toFixed(1)}%)`;
}

async function notifySignal(signal) {
  if (!bot || !channelId) return;
  if (!['HIGH', 'MEDIUM', 'LOW'].includes(signal.confluence_level)) return;
  try { await bot.sendMessage(channelId, formatSignalFull(signal), { parse_mode: 'HTML' }); } catch (e) { console.error('[TG Send]', e.message); }
}

async function notifyTPHit(signal, tp) {
  if (!bot || !channelId) return;
  try { await bot.sendMessage(channelId, formatTPHit(signal, tp)); } catch (e) {}
}

async function notifySLHit(signal, price) {
  if (!bot || !channelId) return;
  try { await bot.sendMessage(channelId, formatSLHit(signal, price)); } catch (e) {}
}

async function notifyAdmin(msg) {
  if (!bot || !adminId) return;
  try { await bot.sendMessage(adminId, `⚠️ PROPTREX ADMIN:\n${msg}`); } catch (e) {}
}

module.exports = { initTelegram, reinitTelegram, getBotStatus, notifySignal, notifyTPHit, notifySLHit, notifyAdmin };
