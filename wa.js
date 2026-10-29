// Links each sales member's own WhatsApp (QR, like WhatsApp Web) so we can see who messaged.
// Unofficial API: read-only here. We never send anything from these sessions.
import fs from 'node:fs';
import QRCode from 'qrcode';
import pino from 'pino';
import baileys, { useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { db, DATA_DIR, q } from './db.js';

const makeSocket = baileys.default ?? baileys;
const logger = pino({ level: 'silent' });
const sessions = new Map(); // agentId -> { sock, state, qr, phone, stopping }

const authDir = (id) => `${DATA_DIR}/wa-auth/${id}`;
const digits = (jid = '') => jid.split('@')[0].split(':')[0];

export function waStatus(agentId) {
  const s = sessions.get(agentId);
  if (s) return { state: s.state, phone: s.phone ?? null };
  return { state: fs.existsSync(authDir(agentId)) ? 'connecting' : 'disconnected', phone: null };
}

export async function getQr(agentId) {
  const s = sessions.get(agentId);
  return s?.qr ? QRCode.toDataURL(s.qr, { margin: 1, width: 280 }) : null;
}

export async function connect(agentId) {
  const existing = sessions.get(agentId);
  if (existing && existing.state !== 'disconnected') return;

  const { state, saveCreds } = await useMultiFileAuthState(authDir(agentId));
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
  const s = { sock: null, state: 'connecting', qr: null, phone: null, stopping: false, retry: 0 };
  sessions.set(agentId, s);

  const sock = makeSocket({ auth: state, version, logger, browser: Browsers.macOS('Desktop'), markOnlineOnConnect: false, syncFullHistory: false });
  s.sock = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) { s.qr = qr; s.state = 'qr'; }
    if (connection === 'open') {
      s.state = 'connected'; s.qr = null; s.retry = 0; s.phone = digits(sock.user?.id);
      q.addEvent('wa_connected', s.phone, 'WhatsApp linked');
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      sessions.delete(agentId);
      if (s.stopping) return;
      if (code === DisconnectReason.loggedOut) { // removed from the phone's Linked devices
        fs.rmSync(authDir(agentId), { recursive: true, force: true });
        q.addEvent('wa_logged_out', null, 'Removed from the phone\'s Linked devices');
        return;
      }
      const wait = Math.min(60000, 2000 * 2 ** s.retry++); // brief drops and restarts reconnect on their own
      setTimeout(() => connect(agentId).catch(() => {}), wait);
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      if (m.key.fromMe || m.key.remoteJid?.endsWith('@g.us') || m.key.remoteJid === 'status@broadcast') continue;
      const text = m.message?.conversation ?? m.message?.extendedTextMessage?.text ?? '';
      const ref = /Ref\s*#(\d+)/i.exec(text);
      if (!ref) continue;
      // Newer WhatsApp may expose an @lid id; prefer the real phone jid when present.
      const jid = m.key.remoteJidAlt?.endsWith('@s.whatsapp.net') ? m.key.remoteJidAlt : m.key.remoteJid;
      const phone = digits(jid);
      const r = db
        .prepare(`UPDATE clicks SET customer_phone=?, customer_name=COALESCE(customer_name,?), status=CASE WHEN status='new' THEN 'contacted' ELSE status END,
                  updated_at=CURRENT_TIMESTAMP WHERE id=? AND agent_id=? AND customer_phone IS NULL`)
        .run(phone, m.pushName ?? null, ref[1], agentId);
      if (r.changes) q.addEvent('lead_message', phone, `Ref #${ref[1]}`);
    }
  });
}

// Pause is routing only; disconnect unlinks this device and forgets the session.
export async function disconnect(agentId) {
  const s = sessions.get(agentId);
  if (s) {
    s.stopping = true;
    await s.sock?.logout().catch(() => {});
    s.sock?.end?.(undefined);
    sessions.delete(agentId);
  }
  fs.rmSync(authDir(agentId), { recursive: true, force: true });
}

// Reconnect saved sessions after a restart.
export function restoreAll() {
  const dir = `${DATA_DIR}/wa-auth`;
  if (!fs.existsSync(dir)) return;
  for (const id of fs.readdirSync(dir)) connect(Number(id)).catch(() => {});
}
