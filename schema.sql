-- PROPTREX Schema — Run in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS signals (
  id BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  signal_key TEXT NOT NULL UNIQUE,
  direction TEXT NOT NULL CHECK (direction IN ('LONG','SHORT')),
  setup_type TEXT,
  state TEXT DEFAULT 'DETECTED',
  opportunity_score REAL DEFAULT 0,
  confluence_score REAL DEFAULT 0,
  confluence_level TEXT DEFAULT 'NONE',
  confluence_agreeing INT DEFAULT 0,
  confluence_layers JSONB DEFAULT '[]',
  entry_low REAL, entry_high REAL, stop_loss REAL,
  tp_matrix JSONB DEFAULT '[]',
  whale_score REAL DEFAULT 0, whale_side TEXT,
  freshness REAL DEFAULT 100,
  discovery_score REAL DEFAULT 0,
  panel_rank_score REAL DEFAULT 0,
  reasons JSONB DEFAULT '[]',
  primary_tf TEXT DEFAULT '1h',
  entry_distance_pct REAL,
  price REAL,
  published_telegram BOOLEAN DEFAULT FALSE,
  published_x BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  extra JSONB DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_sig_sym ON signals(symbol);
CREATE INDEX IF NOT EXISTS idx_sig_state ON signals(state);
CREATE INDEX IF NOT EXISTS idx_sig_updated ON signals(updated_at DESC);

CREATE TABLE IF NOT EXISTS price_snapshots (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ DEFAULT NOW(),
  data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snap_ts ON price_snapshots(ts DESC);

CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  symbol TEXT,
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  direction TEXT,
  severity TEXT DEFAULT 'info',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  extra JSONB DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_evt_ts ON events(created_at DESC);

CREATE TABLE IF NOT EXISTS correlation_matrix (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ DEFAULT NOW(),
  matrix JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS trade_journal (
  id BIGSERIAL PRIMARY KEY,
  signal_id BIGINT,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL,
  entry_price REAL, exit_price REAL, stop_loss REAL,
  tp1_price REAL, tp1_hit BOOLEAN DEFAULT FALSE, tp1_hit_at TIMESTAMPTZ,
  tp2_price REAL, tp2_hit BOOLEAN DEFAULT FALSE, tp2_hit_at TIMESTAMPTZ,
  tp3_price REAL, tp3_hit BOOLEAN DEFAULT FALSE, tp3_hit_at TIMESTAMPTZ,
  tp4_price REAL, tp4_hit BOOLEAN DEFAULT FALSE, tp4_hit_at TIMESTAMPTZ,
  result TEXT,
  pnl_pct REAL, rr_achieved REAL,
  confluence_level TEXT, confluence_agreeing INT,
  opened_at TIMESTAMPTZ DEFAULT NOW(), closed_at TIMESTAMPTZ,
  published_telegram BOOLEAN DEFAULT FALSE,
  published_x BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS token_exchanges (
  symbol TEXT NOT NULL,
  exchange TEXT NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  PRIMARY KEY (symbol, exchange)
);

CREATE TABLE IF NOT EXISTS cross_exchange_funding (
  id BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  ts TIMESTAMPTZ DEFAULT NOW(),
  rates JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS validator_log (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ DEFAULT NOW(),
  symbol TEXT,
  check_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  errors JSONB DEFAULT '[]',
  warnings JSONB DEFAULT '[]',
  action_taken TEXT
);

CREATE OR REPLACE FUNCTION cleanup_old() RETURNS void AS $$
BEGIN
  DELETE FROM price_snapshots WHERE ts < NOW() - INTERVAL '3 hours';
  DELETE FROM events WHERE expires_at IS NOT NULL AND expires_at < NOW();
  DELETE FROM correlation_matrix WHERE ts < NOW() - INTERVAL '2 hours';
  DELETE FROM validator_log WHERE ts < NOW() - INTERVAL '7 days';
  DELETE FROM cross_exchange_funding WHERE ts < NOW() - INTERVAL '6 hours';
END;
$$ LANGUAGE plpgsql;
