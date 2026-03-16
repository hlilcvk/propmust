/** PROPTREX BACKEND — Entry Point
 * 11 agents wired together. Cron-scheduled. Deploy-ready. */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const cron = require('node-cron');
const { createClient, getPool } = require('./src/db');
const settings = require('./src/settings');

async function runMigrations() {
  const pool = getPool();
  if (!pool) return;
  try {
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(sql);
    console.log('[DB] Schema applied');
  } catch (e) {
    console.error('[DB] Migration error:', e.message);
  }
}
const { runCollector, collectKlines, fetchOI, refreshSymbolList, discoverExchangeListings } = require('./src/collector');
const { runEngine } = require('./src/engine');
const { createServer } = require('./src/server');
const { initTelegram, notifySignal, notifyTPHit, notifySLHit, notifyAdmin } = require('./src/telegram');
const { initTwitter, postSignalTweet } = require('./src/twitter');

const PORT = process.env.PORT || 3001;

async function main() {
  console.log('═══════════════════════════════════════');
  console.log('  PROPTREX Signal Backend v1.0');
  console.log('  11 agents. 7 exchanges. Validator.');
  console.log('═══════════════════════════════════════');

  const cfg = settings.load();

  if (!cfg.database_url) {
    console.warn('[Startup] DATABASE_URL not configured — starting in config-only mode');
    console.warn(`[Startup] Open http://localhost:${PORT}/admin to configure`);

    // Start server only (admin panel accessible)
    const { server } = require('./src/server').createServer(null);
    server.listen(PORT, () => {
      console.log(`[Admin]  http://localhost:${PORT}/admin`);
    });
    return;
  }

  const supabase = createClient(cfg.database_url);
  await runMigrations();

  const { server, broadcast } = createServer(supabase);
  initTelegram(supabase);
  initTwitter();

  console.log('[Startup] Collecting data...');
  await runCollector();
  await discoverExchangeListings();

  console.log('[Startup] Generating signals...');
  const sigs = await runEngine(supabase);
  console.log(`[Startup] ${sigs.length} signals ready`);

  // Every 60s: collect + engine + broadcast
  cron.schedule('* * * * *', async () => {
    try {
      await runCollector();
      const signals = await runEngine(supabase);
      broadcast('signals', signals.slice(0, 50));

      for (const s of signals) {
        if (s.state === 'EXECUTION' && !s.published_telegram && ['HIGH', 'MEDIUM'].includes(s.confluence_level)) {
          await notifySignal(s);
          await postSignalTweet(s);
          await supabase.from('signals').update({ published_telegram: true, published_x: s.confluence_level === 'HIGH' }).eq('signal_key', s.signal_key);
        }
      }
    } catch (e) { console.error('[Cron 1m]', e.message); }
  });

  // Every 5m: klines refresh + OI
  cron.schedule('*/5 * * * *', async () => {
    try { await collectKlines(); await fetchOI(); } catch (e) { console.error('[Cron 5m]', e.message); }
  });

  // Every 15m: symbol list
  cron.schedule('*/15 * * * *', async () => {
    try { await refreshSymbolList(); } catch (e) { console.error('[Cron 15m]', e.message); }
  });

  // Every 1h: exchange mapping
  cron.schedule('0 * * * *', async () => {
    try { await discoverExchangeListings(); } catch (e) { console.error('[Cron 1h]', e.message); }
  });

  server.listen(PORT, () => {
    console.log(`\n[Server] http://localhost:${PORT}/api/signals`);
    console.log(`[Server] ws://localhost:${PORT}/ws/stream`);
    console.log(`[Admin]  http://localhost:${PORT}/admin`);
  });
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
