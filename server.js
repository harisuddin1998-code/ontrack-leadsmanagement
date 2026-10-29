import 'dotenv/config';
import express from 'express';
import { q } from './db.js';
import { respond } from './bot.js';
import { sendText, validSignature } from './whatsapp.js';
import { publicRouter, adminRouter } from './rotator.js';
import { restoreAll } from './wa.js';

const app = express();
const sseClients = new Set();

const push = (type, data = {}) => {
  const line = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  for (const res of sseClients) res.write(line);
};
const log = (type, phone, detail) => {
  q.addEvent(type, phone, detail);
  push('event', { event: { type, phone, detail, created_at: new Date().toISOString() } });
};

// ---------- WhatsApp webhook ----------
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.WA_VERIFY_TOKEN) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

app.post('/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  if (!validSignature(req.body, req.get('x-hub-signature-256'))) return res.sendStatus(401);
  res.sendStatus(200); // ack fast, Meta retries on slow responses
  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch {
    return;
  }
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const msg of change.value?.messages ?? []) {
        handleInbound(msg, change.value?.contacts?.[0]?.profile?.name).catch((e) => log('error', msg.from, e.message));
      }
    }
  }
});

const busy = new Map(); // phone -> promise chain, keeps one customer's replies in order
function handleInbound(msg, profileName) {
  const phone = msg.from;
  const prev = busy.get(phone) ?? Promise.resolve();
  const next = prev.then(() => processInbound(msg, phone, profileName)).finally(() => {
    if (busy.get(phone) === next) busy.delete(phone);
  });
  busy.set(phone, next);
  return next;
}

async function processInbound(msg, phone, profileName) {
  const isNew = !q.leads().some((l) => l.phone === phone);
  q.ensureLead(phone);
  if (isNew) {
    if (profileName) q.upsertLead(phone, { name: profileName });
    log('new_lead', phone, profileName ?? '');
  }
  const text = msg.type === 'text' ? msg.text.body : `[${msg.type}]`;
  if (!q.addMessage(phone, 'user', text, msg.id)) return; // duplicate delivery
  log('message_in', phone, text);

  if (msg.type !== 'text') {
    const reply = 'Shukriya! Abhi main sirf text samajh sakti hoon, meherbani karke apni baat likh kar bhej dein.';
    await sendText(phone, reply);
    q.addMessage(phone, 'assistant', reply);
    return;
  }
  const lead = q.leads().find((l) => l.phone === phone);
  if (lead.needs_human) { // a human owns this chat now; stay quiet
    push('refresh');
    return;
  }

  const { reply, hot, human } = await respond(phone);
  if (reply) {
    await sendText(phone, reply);
    q.addMessage(phone, 'assistant', reply);
    log('message_out', phone, reply);
  }
  if (human) log('handover', phone, 'Human needed');
  if (process.env.SALES_ALERT_NUMBER && (hot || human)) {
    const l = q.leads().find((x) => x.phone === phone);
    await sendText(
      process.env.SALES_ALERT_NUMBER,
      `${human ? 'Handover' : 'HOT lead'}: ${l.name ?? 'Unknown'} | ${l.city ?? '-'} | ${l.vehicle_type ?? '-'} x${l.vehicle_count ?? '-'} | +${phone}`,
    ).catch((e) => log('error', phone, 'alert failed: ' + e.message));
  }
  push('refresh');
}

// ---------- Ad link rotator + sales member pages (public, token-protected) ----------
const json = express.json();
app.use((req, res, next) => (req.path === '/webhook' ? next() : json(req, res, next))); // webhook needs the raw body for its signature
app.use(publicRouter);

// ---------- Dashboard (basic auth) ----------
app.use((req, res, next) => {
  if (req.path === '/webhook' || req.path === '/health') return next();
  const [user, pass] = Buffer.from((req.get('authorization') ?? '').slice(6), 'base64').toString().split(':');
  if (user === process.env.DASH_USER && pass === process.env.DASH_PASS) return next();
  res.set('WWW-Authenticate', 'Basic realm="On Track"').sendStatus(401);
});
app.use(adminRouter);
app.use(express.static('public', { index: 'index.html' }));

app.get('/health', (_req, res) => res.send('ok'));
app.get('/api/summary', (_req, res) => res.json({ stats: q.stats(), leads: q.leads(), events: q.events() }));
app.get('/api/leads/:phone/messages', (req, res) => res.json(q.messages(req.params.phone)));

app.post('/api/leads/:phone/status', (req, res) => {
  const ok = ['new', 'contacted', 'won', 'lost'];
  if (!ok.includes(req.body.status)) return res.sendStatus(400);
  q.setStatus(req.params.phone, req.body.status);
  log('status', req.params.phone, req.body.status);
  push('refresh');
  res.sendStatus(204);
});

app.post('/api/leads/:phone/reply', async (req, res) => {
  const text = String(req.body.text ?? '').trim();
  if (!text) return res.sendStatus(400);
  try {
    await sendText(req.params.phone, text);
    q.addMessage(req.params.phone, 'assistant', text);
    log('human_reply', req.params.phone, text);
    push('refresh');
    res.sendStatus(204);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

const port = process.env.PORT ?? 8000;
app.listen(port, () => {
  console.log(`On Track bot listening on :${port}`);
  restoreAll();
});
