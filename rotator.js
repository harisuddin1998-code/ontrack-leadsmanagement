import crypto from 'node:crypto';
import express from 'express';
import { db } from './db.js';
import { waStatus, getQr, connect, disconnect } from './wa.js';

db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL, active INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS clicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER, ref TEXT, status TEXT DEFAULT 'new',
  customer TEXT, note TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`);
for (const col of ['customer_phone', 'customer_name']) {
  if (!db.prepare('PRAGMA table_info(clicks)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE clicks ADD COLUMN ${col} TEXT`);
}

const STATUSES = ['new', 'contacted', 'won', 'lost'];
const logEvent = (type, detail) => db.prepare('INSERT INTO events (type, phone, detail) VALUES (?,NULL,?)').run(type, detail);
const BOT_UA = /facebookexternalhit|facebot|bot|crawler|spider|preview/i;

// Digits only, Pakistan default: 0300... -> 92300...
export function normalizePhone(p) {
  const d = String(p).replace(/\D/g, '');
  return d.startsWith('0') ? '92' + d.slice(1) : d;
}

// Next active agent after the one who got the previous click, wrapping around.
const pickAgent = db.transaction(() => {
  const active = db.prepare('SELECT * FROM agents WHERE active=1 ORDER BY id').all();
  if (!active.length) return null;
  const last = Number(db.prepare("SELECT value FROM meta WHERE key='rr_last'").get()?.value ?? 0);
  const next = active.find((a) => a.id > last) ?? active[0];
  db.prepare("INSERT INTO meta (key,value) VALUES ('rr_last',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(next.id));
  return next;
});

export const publicRouter = express.Router();

// The ad points here. Every click goes to the next sales person's WhatsApp.
publicRouter.get('/go', (req, res) => {
  const ua = req.get('user-agent') ?? '';
  const agent = pickAgentIfHuman(ua);
  if (agent === 'bot') return res.status(200).send('On Track');
  if (!agent) return res.status(503).send('No sales agent is available right now. Please try again shortly.');
  const ref = String(req.query.ref ?? req.query.utm_campaign ?? '').slice(0, 60);
  const id = db.prepare('INSERT INTO clicks (agent_id, ref) VALUES (?,?)').run(agent.id, ref).lastInsertRowid;
  logEvent('click', `Ref #${id} routed to ${agent.name}`);
  const text = `Hello, I'd like details on the On Track GPS tracker. (Ref #${id})`;
  res.redirect(302, `https://wa.me/${agent.phone}?text=${encodeURIComponent(text)}`);
});

function pickAgentIfHuman(ua) {
  if (BOT_UA.test(ua)) return 'bot'; // link-preview crawlers must not use up a turn
  return pickAgent();
}

publicRouter.get('/ui.css', (_req, res) => res.sendFile('ui.css', { root: 'public' }));

// Each sales person's private page, identified by an unguessable token.
publicRouter.get('/agent/:token', (_req, res) => res.sendFile('agent.html', { root: 'public' }));

const byToken = (req, res, next) => {
  const agent = db.prepare('SELECT * FROM agents WHERE token=?').get(req.params.token);
  if (!agent) return res.sendStatus(404);
  req.agent = agent;
  next();
};

publicRouter.get('/api/agent/:token', byToken, (req, res) => {
  const clicks = db
    .prepare('SELECT id, ref, status, customer, customer_name, customer_phone, note, created_at FROM clicks WHERE agent_id=? ORDER BY id DESC LIMIT 200')
    .all(req.agent.id);
  res.json({ name: req.agent.name, clicks });
});

publicRouter.post('/api/agent/:token/clicks/:id', byToken, (req, res) => {
  const { status, customer, note } = req.body;
  if (status != null && !STATUSES.includes(status)) return res.sendStatus(400);
  const r = db
    .prepare(
      `UPDATE clicks SET status=COALESCE(?,status), customer=COALESCE(?,customer), note=COALESCE(?,note),
       updated_at=CURRENT_TIMESTAMP WHERE id=? AND agent_id=?`,
    )
    .run(status ?? null, customer ?? null, note ?? null, req.params.id, req.agent.id);
  if (r.changes && status) logEvent('status', `Ref #${req.params.id} marked ${status} by ${req.agent.name}`);
  res.sendStatus(r.changes ? 204 : 404);
});

// Admin routes (mounted behind the dashboard login).
export const adminRouter = express.Router();

adminRouter.get('/api/team', (req, res) => {
  const origin = `${req.protocol}://${req.get('host')}`;
  const agents = db
    .prepare(
      `SELECT a.id, a.name, a.phone, a.token, a.active,
        COUNT(c.id) total,
        SUM(c.status='new') new_, SUM(c.status='contacted') contacted, SUM(c.status='won') won, SUM(c.status='lost') lost
       FROM agents a LEFT JOIN clicks c ON c.agent_id=a.id GROUP BY a.id ORDER BY a.id`,
    )
    .all()
    .map((a) => ({ ...a, link: `${origin}/agent/${a.token}`, wa: waStatus(a.id) }));
  const recent = db
    .prepare(
      `SELECT c.id, c.ref, c.status, COALESCE(c.customer, c.customer_name) customer, c.customer_phone, c.created_at, a.name agent
       FROM clicks c LEFT JOIN agents a ON a.id=c.agent_id ORDER BY c.id DESC LIMIT 50`,
    )
    .all();
  const today = db.prepare("SELECT COUNT(*) c FROM clicks WHERE date(created_at)=date('now')").get().c;
  res.json({ agents, recent, today, adLink: `${origin}/go` });
});

adminRouter.post('/api/team', (req, res) => {
  const name = String(req.body.name ?? '').trim();
  const phone = normalizePhone(req.body.phone ?? '');
  if (!name || phone.length < 10) return res.status(400).json({ error: 'name aur sahi phone number chahiye' });
  const token = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO agents (name, phone, token) VALUES (?,?,?)').run(name, phone, token);
  res.sendStatus(201);
});

// Pakistan is UTC+5; dashboard days are cut on local midnight.
const PKT = "'+5 hours'";
const one = (sql, ...p) => db.prepare(sql).get(...p);

adminRouter.get('/api/overview', (_req, res) => {
  const cnt = (where) => one(`SELECT COUNT(*) c FROM clicks ${where}`).c;
  const k = {
    today: cnt(`WHERE date(created_at,${PKT})=date('now',${PKT})`),
    yesterday: cnt(`WHERE date(created_at,${PKT})=date('now',${PKT},'-1 day')`),
    week: cnt(`WHERE date(created_at,${PKT})>=date('now',${PKT},'-6 days')`),
    total: cnt(''),
    new: cnt("WHERE status='new'"),
    contacted: cnt("WHERE status='contacted'"),
    won: cnt("WHERE status='won'"),
    lost: cnt("WHERE status='lost'"),
    withNumber: cnt('WHERE customer_phone IS NOT NULL'),
  };
  const rows = db
    .prepare(`SELECT date(created_at,${PKT}) d, COUNT(*) c FROM clicks WHERE created_at >= datetime('now','-15 days') GROUP BY d`)
    .all();
  const byDay = Object.fromEntries(rows.map((r) => [r.d, r.c]));
  const daily = [];
  for (let i = 13; i >= 0; i--) {
    const day = new Date(Date.now() + 5 * 3600e3 - i * 864e5).toISOString().slice(0, 10);
    daily.push({ day, count: byDay[day] ?? 0 });
  }
  const agents = db
    .prepare(
      `SELECT a.id, a.name, a.active, COUNT(c.id) total,
         SUM(date(c.created_at,${PKT})=date('now',${PKT})) today,
         SUM(c.status='new') new_, SUM(c.status='contacted') contacted, SUM(c.status='won') won, SUM(c.status='lost') lost
       FROM agents a LEFT JOIN clicks c ON c.agent_id=a.id GROUP BY a.id ORDER BY a.id`,
    )
    .all()
    .map((a) => ({ ...a, wa: waStatus(a.id) }));
  const feed = db
    .prepare("SELECT id, type, phone, detail, created_at FROM events WHERE type IN ('click','lead_message','status','wa_connected','wa_logged_out') ORDER BY id DESC LIMIT 25")
    .all();
  res.json({ kpis: k, daily, agents, feed });
});

adminRouter.get('/api/leads', (req, res) => {
  const where = [];
  const params = {};
  if (STATUSES.includes(req.query.status)) { where.push('c.status=@status'); params.status = req.query.status; }
  if (req.query.agent) { where.push('c.agent_id=@agent'); params.agent = Number(req.query.agent); }
  if (req.query.q) {
    where.push('(c.customer LIKE @q OR c.customer_name LIKE @q OR c.customer_phone LIKE @q OR c.note LIKE @q OR CAST(c.id AS TEXT)=@id)');
    params.q = `%${req.query.q}%`;
    params.id = String(req.query.q).replace('#', '').trim();
  }
  const rows = db
    .prepare(
      `SELECT c.id, c.ref, c.status, c.note, c.created_at, c.customer_phone,
         COALESCE(c.customer, c.customer_name) customer, a.id agent_id, a.name agent
       FROM clicks c LEFT JOIN agents a ON a.id=c.agent_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.id DESC LIMIT 500`,
    )
    .all(params);
  res.json(rows);
});

// Link a member's WhatsApp: start a session, then poll the QR until it is scanned.
adminRouter.post('/api/team/:id/connect', async (req, res) => {
  if (!db.prepare('SELECT 1 FROM agents WHERE id=?').get(req.params.id)) return res.sendStatus(404);
  try {
    await connect(Number(req.params.id));
    res.sendStatus(204);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

adminRouter.get('/api/team/:id/qr', async (req, res) => {
  const id = Number(req.params.id);
  res.json({ ...waStatus(id), qr: await getQr(id) });
});

adminRouter.post('/api/team/:id/disconnect', async (req, res) => {
  await disconnect(Number(req.params.id));
  res.sendStatus(204);
});

adminRouter.post('/api/team/:id/active', (req, res) => {
  db.prepare('UPDATE agents SET active=? WHERE id=?').run(req.body.active ? 1 : 0, req.params.id);
  res.sendStatus(204);
});
