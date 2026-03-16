/** Settings manager — settings.json > process.env > defaults */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'settings.json');

const DEFAULTS = {
  database_url: '',
  telegram_bot_token: '',
  telegram_channel_id: '',
  telegram_admin_id: '',
};

function load() {
  let fromFile = {};
  try {
    if (fs.existsSync(FILE)) {
      fromFile = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    }
  } catch (e) { console.error('[Settings] Load error:', e.message); }

  // Merge: file > env vars > defaults
  return {
    database_url:        fromFile.database_url        || process.env.DATABASE_URL          || DEFAULTS.database_url,
    telegram_bot_token:  fromFile.telegram_bot_token  || process.env.TELEGRAM_BOT_TOKEN    || DEFAULTS.telegram_bot_token,
    telegram_channel_id: fromFile.telegram_channel_id || process.env.TELEGRAM_CHANNEL_ID   || DEFAULTS.telegram_channel_id,
    telegram_admin_id:   fromFile.telegram_admin_id   || process.env.TELEGRAM_ADMIN_ID     || DEFAULTS.telegram_admin_id,
  };
}

function save(data) {
  let current = {};
  try {
    if (fs.existsSync(FILE)) current = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {}
  const updated = { ...current, ...data };
  fs.writeFileSync(FILE, JSON.stringify(updated, null, 2));
  return updated;
}

module.exports = { load, save };
