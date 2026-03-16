/** PostgreSQL wrapper — Supabase-compatible fluent API */

const { Pool } = require('pg');

let pool = null;

function initPool(connectionString) {
  pool = new Pool({ connectionString });
  pool.on('error', (err) => console.error('[DB] Pool error:', err.message));
  return pool;
}

function getPool() { return pool; }

class QueryBuilder {
  constructor(table) {
    this._table = table;
    this._operation = 'SELECT';
    this._cols = '*';
    this._wheres = [];
    this._orderCol = null;
    this._orderAsc = true;
    this._limitN = null;
    this._isSingle = false;
    this._insertData = null;
    this._updateData = null;
    this._conflictCol = null;
  }

  select(cols = '*') {
    this._operation = 'SELECT';
    this._cols = cols;
    return this;
  }

  insert(data) {
    this._operation = 'INSERT';
    this._insertData = Array.isArray(data) ? data : [data];
    return this;
  }

  update(data) {
    this._operation = 'UPDATE';
    this._updateData = data;
    return this;
  }

  upsert(data, opts = {}) {
    this._operation = 'UPSERT';
    this._insertData = Array.isArray(data) ? data : [data];
    this._conflictCol = opts.onConflict || null;
    return this;
  }

  eq(col, val)  { this._wheres.push({ op: '=',  col, val }); return this; }
  neq(col, val) { this._wheres.push({ op: '!=', col, val }); return this; }
  gte(col, val) { this._wheres.push({ op: '>=', col, val }); return this; }
  in(col, vals) { this._wheres.push({ op: 'IN', col, vals }); return this; }

  order(col, opts = {}) {
    this._orderCol = col;
    this._orderAsc = opts.ascending !== false;
    return this;
  }

  limit(n) { this._limitN = n; return this; }
  single() { this._isSingle = true; return this; }

  _serialize(val) {
    if (val === null || val === undefined) return null;
    if (typeof val === 'object') return JSON.stringify(val);
    return val;
  }

  _buildWhere(params) {
    if (!this._wheres.length) return '';
    const parts = this._wheres.map(w => {
      if (w.op === 'IN') {
        const ph = w.vals.map(v => { params.push(v); return `$${params.length}`; });
        return `"${w.col}" = ANY(ARRAY[${ph.join(',')}]::text[])`;
      }
      params.push(w.val);
      return `"${w.col}" ${w.op} $${params.length}`;
    });
    return 'WHERE ' + parts.join(' AND ');
  }

  async _execute() {
    if (!pool) return { data: null, error: new Error('DB not initialized') };
    const params = [];
    let sql = '';
    try {
      if (this._operation === 'SELECT') {
        sql = `SELECT ${this._cols} FROM "${this._table}"`;
        const where = this._buildWhere(params);
        if (where) sql += ' ' + where;
        if (this._orderCol) sql += ` ORDER BY "${this._orderCol}" ${this._orderAsc ? 'ASC' : 'DESC'}`;
        if (this._limitN) sql += ` LIMIT ${this._limitN}`;
        const result = await pool.query(sql, params);
        if (this._isSingle) return { data: result.rows[0] || null, error: null };
        return { data: result.rows, error: null };

      } else if (this._operation === 'INSERT') {
        const rows = this._insertData;
        if (!rows || !rows.length) return { data: null, error: null };
        const keys = Object.keys(rows[0]);
        const cols = keys.map(k => `"${k}"`).join(', ');
        const valueSets = rows.map(row => {
          const ph = keys.map(k => { params.push(this._serialize(row[k])); return `$${params.length}`; });
          return `(${ph.join(', ')})`;
        });
        sql = `INSERT INTO "${this._table}" (${cols}) VALUES ${valueSets.join(', ')}`;
        await pool.query(sql, params);
        return { data: null, error: null };

      } else if (this._operation === 'UPDATE') {
        const keys = Object.keys(this._updateData);
        const sets = keys.map(k => {
          params.push(this._serialize(this._updateData[k]));
          return `"${k}" = $${params.length}`;
        }).join(', ');
        sql = `UPDATE "${this._table}" SET ${sets}`;
        const where = this._buildWhere(params);
        if (where) sql += ' ' + where;
        await pool.query(sql, params);
        return { data: null, error: null };

      } else if (this._operation === 'UPSERT') {
        const rows = this._insertData;
        if (!rows || !rows.length) return { data: null, error: null };
        const keys = Object.keys(rows[0]);
        const cols = keys.map(k => `"${k}"`).join(', ');
        const valueSets = rows.map(row => {
          const ph = keys.map(k => { params.push(this._serialize(row[k])); return `$${params.length}`; });
          return `(${ph.join(', ')})`;
        });
        const updateCols = this._conflictCol ? keys.filter(k => k !== this._conflictCol) : keys;
        const updates = updateCols.map(k => `"${k}" = EXCLUDED."${k}"`).join(', ');
        sql = `INSERT INTO "${this._table}" (${cols}) VALUES ${valueSets.join(', ')}`;
        if (this._conflictCol) sql += ` ON CONFLICT ("${this._conflictCol}") DO UPDATE SET ${updates}`;
        else sql += ' ON CONFLICT DO NOTHING';
        await pool.query(sql, params);
        return { data: null, error: null };
      }
    } catch (e) {
      console.error(`[DB Error] ${this._operation} ${this._table}:`, e.message);
      return { data: null, error: e };
    }
    return { data: null, error: null };
  }

  then(resolve, reject) { return this._execute().then(resolve, reject); }
  catch(fn) { return this._execute().catch(fn); }
}

function createClient(connectionString) {
  initPool(connectionString);
  return {
    from: (table) => new QueryBuilder(table),
    rpc: (fn) => pool.query(`SELECT ${fn}()`).then(() => ({ error: null })).catch(e => ({ error: e }))
  };
}

module.exports = { createClient, initPool, getPool };
