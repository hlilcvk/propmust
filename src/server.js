/** AGENT 9: API SERVER — REST + WebSocket push + Admin Panel */

const express = require('express');
const cors = require('cors');
const path = require('path');
const { WebSocketServer } = require('ws');
const http = require('http');
const { getStats } = require('./engine');
const settings = require('./settings');
const { reinitTelegram, getBotStatus } = require('./telegram');
const { getPool } = require('./db');

function createServer(supabase) {
  const app = express();
  app.use(cors()); app.use(express.json());
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws/stream' });
  const clients = new Set();
  wss.on('connection', ws => { clients.add(ws); ws.on('close', () => clients.delete(ws)); ws.on('error', () => clients.delete(ws)); });

  function broadcast(type, data) {
    const msg = JSON.stringify({ type, data, ts: Date.now() });
    for (const ws of clients) { if (ws.readyState === 1) ws.send(msg); }
  }

  // ── Signal API ──
  app.get('/api/signals', async (req, res) => {
    try {
      const { data, error } = await supabase.from('signals').select('*').neq('state', 'INVALIDATED').order('panel_rank_score', { ascending: false }).limit(100);
      if (error) throw error;
      res.json({ signals: data || [], ts: Date.now() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/signals/:symbol', async (req, res) => {
    try {
      const { data } = await supabase.from('signals').select('*').eq('symbol', req.params.symbol.toUpperCase()).single();
      res.json({ signal: data });
    } catch (e) { res.status(404).json({ error: 'Not found' }); }
  });

  app.get('/api/events', async (req, res) => {
    try {
      const { data } = await supabase.from('events').select('*').order('created_at', { ascending: false }).limit(30);
      res.json({ events: data || [] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/stats', async (req, res) => {
    const days = parseInt(req.query.days) || 7;
    const stats = await getStats(supabase, days);
    res.json(stats);
  });

  app.get('/api/correlation', async (req, res) => {
    try {
      const { data } = await supabase.from('correlation_matrix').select('matrix,ts').order('ts', { ascending: false }).limit(1).single();
      res.json({ matrix: data?.matrix || {}, ts: data?.ts });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/filters/:type', async (req, res) => {
    try {
      const { data } = await supabase.from('signals').select('*').neq('state', 'INVALIDATED').order('panel_rank_score', { ascending: false });
      let f = data || [];
      switch (req.params.type) {
        case 'long': f = f.filter(s => s.direction === 'LONG'); break;
        case 'short': f = f.filter(s => s.direction === 'SHORT'); break;
        case 'squeeze': f = f.filter(s => s.confluence_layers?.some(l => l.name === 'FUND_OI' && l.score > 25)); break;
        case 'leadlag': f = f.filter(s => s.confluence_layers?.some(l => l.name === 'LEAD_LAG' && l.score > 25)); break;
        case 'highconf': f = f.filter(s => (s.confluence_agreeing || 0) >= 4); break;
        case 'priority': f = f.filter(s => ['PRIORITY', 'EXECUTION', 'ACTIVE'].includes(s.state)); break;
      }
      res.json({ signals: f, filter: req.params.type, ts: Date.now() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), clients: clients.size, ts: Date.now() });
  });

  // ── Admin API ──
  app.get('/admin/api/settings', (req, res) => {
    const cfg = settings.load();
    // mask password in db url for display
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
      const updated = settings.save(req.body);
      res.json({ ok: true, saved: Object.keys(req.body) });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/admin/api/telegram/restart', (req, res) => {
    try {
      reinitTelegram();
      const status = getBotStatus();
      res.json({ ok: true, status });
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

  // ── Admin Panel UI ──
  app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
  });

  return { app, server, wss, broadcast };
}

module.exports = { createServer };
