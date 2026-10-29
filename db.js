import fs from 'node:fs';
import Database from 'better-sqlite3';

// The host mounts a persistent volume at /data; fall back to the project folder locally.
export const DATA_DIR = process.env.DATA_DIR ?? (fs.existsSync('/data') ? '/data' : '.');
export const db = new Database(process.env.DB_PATH ?? `${DATA_DIR}/ontrack.db`);
db.exec(`
CREATE TABLE IF NOT EXISTS leads (
  phone TEXT PRIMARY KEY, name TEXT, city TEXT, vehicle_type TEXT, vehicle_count INTEGER,
  interest TEXT DEFAULT 'cold', status TEXT DEFAULT 'new', notes TEXT,
  needs_human INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, wa_id TEXT UNIQUE, phone TEXT, role TEXT, body TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, phone TEXT, detail TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

export const q = {
  ensureLead: (phone) => db.prepare('INSERT OR IGNORE INTO leads (phone) VALUES (?)').run(phone),
  upsertLead(phone, f) {
    q.ensureLead(phone);
    const cols = ['name', 'city', 'vehicle_type', 'vehicle_count', 'interest', 'notes'].filter((c) => f[c] != null);
    if (!cols.length) return;
    const params = { phone };
    for (const c of cols) params[c] = f[c];
    db.prepare(`UPDATE leads SET ${cols.map((c) => `${c}=@${c}`).join(',')}, updated_at=CURRENT_TIMESTAMP WHERE phone=@phone`).run(params);
  },
  flagHuman: (phone) => db.prepare('UPDATE leads SET needs_human=1, updated_at=CURRENT_TIMESTAMP WHERE phone=?').run(phone),
  setStatus: (phone, status) =>
    db.prepare('UPDATE leads SET status=?, needs_human=0, updated_at=CURRENT_TIMESTAMP WHERE phone=?').run(status, phone),
  addMessage: (phone, role, body, waId = null) =>
    db.prepare('INSERT OR IGNORE INTO messages (wa_id, phone, role, body) VALUES (?,?,?,?)').run(waId, phone, role, body).changes,
  history: (phone, n = 20) =>
    db.prepare('SELECT role, body FROM messages WHERE phone=? ORDER BY id DESC LIMIT ?').all(phone, n).reverse(),
  addEvent: (type, phone, detail) => db.prepare('INSERT INTO events (type, phone, detail) VALUES (?,?,?)').run(type, phone, detail),
  leads: () => db.prepare('SELECT * FROM leads ORDER BY updated_at DESC').all(),
  events: (n = 50) => db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(n),
  messages: (phone) => db.prepare('SELECT role, body, created_at FROM messages WHERE phone=? ORDER BY id').all(phone),
  stats: () => ({
    total: db.prepare('SELECT COUNT(*) c FROM leads').get().c,
    today: db.prepare("SELECT COUNT(*) c FROM leads WHERE date(created_at)=date('now')").get().c,
    hot: db.prepare("SELECT COUNT(*) c FROM leads WHERE interest='hot'").get().c,
    human: db.prepare('SELECT COUNT(*) c FROM leads WHERE needs_human=1').get().c,
    won: db.prepare("SELECT COUNT(*) c FROM leads WHERE status='won'").get().c,
    msgsToday: db.prepare("SELECT COUNT(*) c FROM messages WHERE date(created_at)=date('now')").get().c,
  }),
};
