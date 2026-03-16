/** AGENT 9: API SERVER — REST + WebSocket push + Admin Panel + Platform */

const express = require('express');
const cors = require('cors');
const path = require('path');
const { WebSocketServer } = require('ws');
const http = require('http');
const { getStats } = require('./engine');
const settings = require('./settings');
const { reinitTelegram, getBotStatus } = require('./telegram');
const { getPool } = require('./db');

// ── Signal transformer: internal format → platform format ──────────────────
function toSymbol(s) {
  // BTCUSDT → BTC/USDT
  if (s.endsWith('USDT') && !s.includes('/')) return s.slice(0, -4) + '/USDT';
  return s;
}

function transformSignal(s) {
  if (!s) return null;
  const tp = s.tp_matrix || [];
  const layers = s.confluence_layers || [];

  // buyer dominance: derive from RSI (stored in extra)
  const rsi = s.extra?.rsi ?? s.rsi ?? 50;
  const buyer_dominance = Math.round(Math.min(95, Math.max(5, rsi)));
  const seller_pressure = 100 - buyer_dominance;

  // exchange: first from array, lowercase
  const exchanges = s.extra?.exchanges || s.exchanges || [];
  const exchange = (exchanges[0] || 'BINANCE').toLowerCase();

  // why_lines from confluence layers
  const why_lines = layers
    .filter(l => l.score > 10)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(l => `${l.name}: ${l.detail || l.dir || ''} (${l.score > 0 ? '+' : ''}${l.score})`);

  // structure bias
  const structLayer = layers.find(l => l.name === 'MARKET_STRUCTURE');
  const structure_bias = structLayer?.dir || (s.setup_type === 'TREND' ? (s.direction === 'LONG' ? 'BULLISH' : 'BEARISH') : 'NEUTRAL');

  // time display
  const updatedAt = s.updated_at ? new Date(s.updated_at) : new Date();
  const time = updatedAt.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });

  // timeframe → expected hold
  const tfHoldMap = { '5m': '15-30m', '15m': '30-90m', '1h': '2-6h', '4h': '8-24h', '1d': '1-3d' };
  const tfExpiry   = { '5m': 30, '15m': 90, '1h': 360, '4h': 1440, '1d': 4320 };
  const tf = s.primary_tf || '1h';

  // entry freshness
  const dist = s.entry_distance_pct || 0;
  const entry_freshness = dist < 0.5 ? 'AT ENTRY' : dist < 1.5 ? 'FRESH' : dist < 3 ? 'NEAR' : 'FAR';

  // ob_dominant from funding
  const fund = s.extra?.fund ?? s.fund ?? 0;
  const ob_dominant = fund < -0.0003 ? 'BUY' : fund > 0.0003 ? 'SELL' : 'NEUTRAL';

  // x_sentiment from confluence
  const level = s.confluence_level || 'NONE';
  const x_sentiment = level === 'HIGH' ? 'Bullish' : level === 'MEDIUM' ? 'Mixed' : 'Neutral';

  return {
    symbol: toSymbol(s.symbol),
    side: s.direction,
    opportunity_score: Math.round(s.opportunity_score || 0),
    entry_low: s.entry_low,
    entry_high: s.entry_high,
    stop_loss: s.stop_loss,
    tp1: tp[0]?.price, tp1_tf: tp[0]?.tf,
    tp2: tp[1]?.price, tp2_tf: tp[1]?.tf,
    tp3: tp[2]?.price, tp3_tf: tp[2]?.tf,
    buyer_dominance,
    seller_pressure,
    social_conviction: Math.round(s.confluence_score || 0),
    structure_bias,
    exchange,
    why_lines,
    time,
    timeframe: tf,
    signal_number: s.id,
    why_enter_score: Math.round(s.opportunity_score || 0),
    ob_score: Math.round(50 + (s.confluence_agreeing || 0) * 5),
    whale_strength: Math.round(s.whale_score || 0),
    x_sentiment,
    ob_dominant,
    entry_freshness,
    expected_hold: tfHoldMap[tf] || '2-6h',
    expiry_minutes: tfExpiry[tf] || 360,
    ts: s.updated_at ? new Date(s.updated_at).getTime() : Date.now(),
    // keep originals for compatibility
    _raw: { state: s.state, confluence_level: s.confluence_level, confluence_agreeing: s.confluence_agreeing }
  };
}

function createServer(supabase) {
  const app = express();
  app.use(cors()); app.use(express.json());
  const server = http.createServer(app);

  // ── WebSocket: /ws/stream (internal) ──
  const wss = new WebSocketServer({ server, path: '/ws/stream' });
  const streamClients = new Set();
  wss.on('connection', ws => {
    streamClients.add(ws);
    ws.on('close', () => streamClients.delete(ws));
    ws.on('error', () => streamClients.delete(ws));
  });

  // ── WebSocket: /ws/events (platform) ──
  const wssEvents = new WebSocketServer({ server, path: '/ws/events' });
  const eventClients = new Set();
  wssEvents.on('connection', async ws => {
    eventClients.add(ws);
    ws.on('close', () => eventClients.delete(ws));
    ws.on('error', () => eventClients.delete(ws));

    // Send hello with recent signals
    if (supabase) {
      try {
        const { data } = await supabase.from('signals').select('*').neq('state', 'INVALIDATED').order('panel_rank_score', { ascending: false }).limit(50);
        const recent_signals = (data || []).map(transformSignal).filter(Boolean);
        ws.send(JSON.stringify({ type: 'hello', recent_signals }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'hello', recent_signals: [] }));
      }
    } else {
      ws.send(JSON.stringify({ type: 'hello', recent_signals: [] }));
    }
  });

  function broadcast(type, data) {
    // /ws/stream — original format
    const msg = JSON.stringify({ type, data, ts: Date.now() });
    for (const ws of streamClients) { if (ws.readyState === 1) ws.send(msg); }

    // /ws/events — platform format (per-signal)
    if (type === 'signals' && Array.isArray(data)) {
      for (const sig of data) {
        const transformed = transformSignal(sig);
        if (!transformed) continue;
        const platformMsg = JSON.stringify({ type: 'signal', ...transformed });
        for (const ws of eventClients) { if (ws.readyState === 1) ws.send(platformMsg); }
      }
    }
  }

  function broadcastLifecycle(symbol, status, price) {
    const msg = JSON.stringify({ type: 'lifecycle_update', symbol: toSymbol(symbol), status, price });
    for (const ws of eventClients) { if (ws.readyState === 1) ws.send(msg); }
  }

  // ── Static files ──
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ── Platform UI ──
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'platform.html'));
  });

  // ── Admin UI ──
  app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
  });

  // ── Signal API ──
  app.get('/api/signals', async (req, res) => {
    if (!supabase) return res.json({ signals: [], ts: Date.now() });
    try {
      const { data, error } = await supabase.from('signals').select('*').neq('state', 'INVALIDATED').order('panel_rank_score', { ascending: false }).limit(100);
      if (error) throw error;
      // Return transformed signals for platform compatibility
      const signals = (data || []).map(transformSignal).filter(Boolean);
      res.json({ signals, ts: Date.now() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/signals/raw', async (req, res) => {
    if (!supabase) return res.json({ signals: [], ts: Date.now() });
    try {
      const { data, error } = await supabase.from('signals').select('*').neq('state', 'INVALIDATED').order('panel_rank_score', { ascending: false }).limit(100);
      if (error) throw error;
      res.json({ signals: data || [], ts: Date.now() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/signals/:symbol', async (req, res) => {
    if (!supabase) return res.status(404).json({ error: 'Not found' });
    try {
      const { data } = await supabase.from('signals').select('*').eq('symbol', req.params.symbol.toUpperCase()).single();
      res.json({ signal: data ? transformSignal(data) : null });
    } catch (e) { res.status(404).json({ error: 'Not found' }); }
  });

  app.get('/api/events', async (req, res) => {
    if (!supabase) return res.json({ events: [] });
    try {
      const { data } = await supabase.from('events').select('*').order('created_at', { ascending: false }).limit(30);
      res.json({ events: data || [] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/stats', async (req, res) => {
    if (!supabase) return res.json({});
    const days = parseInt(req.query.days) || 7;
    const stats = await getStats(supabase, days);
    res.json(stats);
  });

  app.get('/api/correlation', async (req, res) => {
    if (!supabase) return res.json({ matrix: {} });
    try {
      const { data } = await supabase.from('correlation_matrix').select('matrix,ts').order('ts', { ascending: false }).limit(1).single();
      res.json({ matrix: data?.matrix || {}, ts: data?.ts });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/filters/:type', async (req, res) => {
    if (!supabase) return res.json({ signals: [] });
    try {
      const { data } = await supabase.from('signals').select('*').neq('state', 'INVALIDATED').order('panel_rank_score', { ascending: false });
      let f = data || [];
      switch (req.params.type) {
        case 'long':     f = f.filter(s => s.direction === 'LONG'); break;
        case 'short':    f = f.filter(s => s.direction === 'SHORT'); break;
        case 'squeeze':  f = f.filter(s => s.confluence_layers?.some(l => l.name === 'FUND_OI' && l.score > 25)); break;
        case 'leadlag':  f = f.filter(s => s.confluence_layers?.some(l => l.name === 'LEAD_LAG' && l.score > 25)); break;
        case 'highconf': f = f.filter(s => (s.confluence_agreeing || 0) >= 4); break;
        case 'priority': f = f.filter(s => ['PRIORITY', 'EXECUTION', 'ACTIVE'].includes(s.state)); break;
      }
      res.json({ signals: f.map(transformSignal).filter(Boolean), filter: req.params.type, ts: Date.now() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), clients: streamClients.size + eventClients.size, ts: Date.now() });
  });

  // ── Admin API ──
  app.get('/admin/api/settings', (req, res) => {
    const cfg = settings.load();
    const masked = { ...cfg };
    if (masked.database_url) {
      try {
        const u = new URL(masked.database_url);
        masked.database_url_display = `${u.protocol}//${u.username}:****@${u.host}${u.pathname}`;
      } catch (e) { masked.database_url_display = masked.database_url; }
    }
    res.json(masked);
  });

  app.post('/admin/api/settings', (req, res) => {
    try {
      settings.save(req.body);
      res.json({ ok: true, saved: Object.keys(req.body) });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/admin/api/telegram/restart', (req, res) => {
    try {
      reinitTelegram();
      res.json({ ok: true, status: getBotStatus() });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get('/admin/api/telegram/status', (req, res) => {
    res.json(getBotStatus());
  });

  app.get('/admin/api/db/status', async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json({ connected: false, error: 'Pool not initialized' });
    try {
      await pool.query('SELECT 1');
      res.json({ connected: true });
    } catch (e) { res.json({ connected: false, error: e.message }); }
  });

  return { app, server, wss, broadcast, broadcastLifecycle };
}

module.exports = { createServer };
