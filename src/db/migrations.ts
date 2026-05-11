import type { Db } from './database.js'

type Migration = {
  id: number
  name: string
  sql: string
}

const migrations: Migration[] = [
  {
    id: 1,
    name: 'initial_backend_data_slice',
    sql: `
      CREATE TABLE IF NOT EXISTS sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('invoice', 'count', 'toast', 'manual', 'seed')),
        config_json TEXT NOT NULL DEFAULT '{}',
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS source_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL REFERENCES sources(id),
        external_id TEXT,
        document_type TEXT NOT NULL,
        document_date TEXT,
        raw_text TEXT,
        raw_json TEXT NOT NULL DEFAULT '{}',
        content_hash TEXT,
        ingested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (source_id, external_id, document_type)
      );

      CREATE TABLE IF NOT EXISTS ingest_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL REFERENCES sources(id),
        started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
        records_seen INTEGER NOT NULL DEFAULT 0,
        records_imported INTEGER NOT NULL DEFAULT 0,
        errors INTEGER NOT NULL DEFAULT 0,
        error_message TEXT
      );

      CREATE TABLE IF NOT EXISTS vendors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        contact_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS skus (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        unit TEXT NOT NULL,
        category TEXT,
        par_level REAL,
        shelf_life_days INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS vendor_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vendor_id INTEGER NOT NULL REFERENCES vendors(id),
        sku_id INTEGER NOT NULL REFERENCES skus(id),
        vendor_sku TEXT,
        pack_size REAL NOT NULL DEFAULT 1,
        pack_unit TEXT NOT NULL,
        price REAL,
        lead_time_days INTEGER NOT NULL DEFAULT 2,
        min_order_qty REAL NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        UNIQUE (vendor_id, sku_id)
      );

      CREATE TABLE IF NOT EXISTS menu_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        external_id TEXT UNIQUE,
        name TEXT NOT NULL UNIQUE,
        category TEXT,
        active INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS recipes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        menu_item_id INTEGER NOT NULL REFERENCES menu_items(id),
        sku_id INTEGER NOT NULL REFERENCES skus(id),
        quantity REAL NOT NULL,
        unit TEXT NOT NULL,
        yield_quantity REAL NOT NULL DEFAULT 1,
        active INTEGER NOT NULL DEFAULT 1,
        UNIQUE (menu_item_id, sku_id)
      );

      CREATE TABLE IF NOT EXISTS openclaw_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        state TEXT NOT NULL CHECK (state IN ('proposed', 'auto_applied', 'needs_review', 'suppressed', 'reversed')),
        risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
        title TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        policy_json TEXT NOT NULL DEFAULT '{}',
        confidence REAL NOT NULL DEFAULT 0,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        applied_inventory_event_id INTEGER,
        reversed_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS evidence_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_document_id INTEGER REFERENCES source_documents(id),
        evidence_type TEXT NOT NULL,
        entity_type TEXT,
        entity_id INTEGER,
        inventory_event_id INTEGER,
        decision_id INTEGER REFERENCES openclaw_decisions(id),
        occurred_at TEXT,
        summary TEXT NOT NULL,
        amount REAL,
        unit TEXT,
        confidence REAL NOT NULL DEFAULT 1,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS inventory_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sku_id INTEGER NOT NULL REFERENCES skus(id),
        event_type TEXT NOT NULL CHECK (event_type IN ('purchase', 'sale', 'adjustment', 'shrink', 'correction')),
        quantity REAL NOT NULL,
        unit TEXT NOT NULL,
        unit_cost REAL,
        source_document_id INTEGER REFERENCES source_documents(id),
        evidence_item_id INTEGER REFERENCES evidence_items(id),
        decision_id INTEGER REFERENCES openclaw_decisions(id),
        occurred_at TEXT NOT NULL,
        note TEXT,
        reversed_event_id INTEGER REFERENCES inventory_events(id),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS forecasts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sku_id INTEGER NOT NULL REFERENCES skus(id),
        forecast_date TEXT NOT NULL,
        horizon_days INTEGER NOT NULL,
        avg_daily_usage REAL NOT NULL,
        confidence REAL NOT NULL,
        method TEXT NOT NULL,
        generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        evidence_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE (sku_id, forecast_date, horizon_days)
      );

      CREATE TABLE IF NOT EXISTS order_recommendations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        forecast_id INTEGER REFERENCES forecasts(id),
        vendor_id INTEGER NOT NULL REFERENCES vendors(id),
        sku_id INTEGER NOT NULL REFERENCES skus(id),
        recommended_qty REAL NOT NULL,
        unit TEXT NOT NULL,
        estimated_cost REAL,
        reason TEXT NOT NULL,
        confidence REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'dismissed', 'ordered')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id INTEGER,
        before_json TEXT NOT NULL DEFAULT '{}',
        after_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_source_documents_source ON source_documents(source_id);
      CREATE INDEX IF NOT EXISTS idx_evidence_document ON evidence_items(source_document_id);
      CREATE INDEX IF NOT EXISTS idx_inventory_events_sku_time ON inventory_events(sku_id, occurred_at);
      CREATE INDEX IF NOT EXISTS idx_inventory_events_decision ON inventory_events(decision_id);
      CREATE INDEX IF NOT EXISTS idx_forecasts_sku_date ON forecasts(sku_id, forecast_date);
      CREATE INDEX IF NOT EXISTS idx_order_recommendations_vendor ON order_recommendations(vendor_id, status);
      CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
    `,
  },
]

export const migrateDatabase = (db: Db): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)

  for (const migration of migrations) {
    const existing = db.prepare('SELECT id FROM schema_migrations WHERE id = ?').get(migration.id)
    if (existing) continue

    db.exec('BEGIN')
    try {
      db.exec(migration.sql)
      db.prepare('INSERT INTO schema_migrations (id, name) VALUES (?, ?)').run(migration.id, migration.name)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}
