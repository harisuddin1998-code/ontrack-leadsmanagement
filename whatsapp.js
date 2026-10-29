import crypto from 'node:crypto';

const endpoint = () => `https://graph.facebook.com/v21.0/${process.env.WA_PHONE_NUMBER_ID}/messages`;

export async function sendText(to, body) {
  const r = await fetch(endpoint(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
  });
  if (!r.ok) throw new Error(`WhatsApp send failed ${r.status}: ${await r.text()}`);
}

export function validSignature(rawBody, header) {
  if (!process.env.WA_APP_SECRET) return true;
  if (!header) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', process.env.WA_APP_SECRET).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
