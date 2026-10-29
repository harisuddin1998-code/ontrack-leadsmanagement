import Anthropic from '@anthropic-ai/sdk';
import { BUSINESS, SYSTEM_PROMPT, TOOLS } from './config.js';
import { q } from './db.js';

const client = new Anthropic();

// Runs the model against the stored chat history; returns { reply, hot, human }.
export async function respond(phone) {
  const messages = q.history(phone).map((m) => ({ role: m.role, content: m.body }));
  while (messages.length && messages[0].role !== 'user') messages.shift(); // API needs a user turn first
  const out = { reply: '', hot: false, human: false };

  for (let i = 0; i < 3; i++) {
    const res = await client.messages.create({
      model: BUSINESS.model,
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (text) out.reply = text;
    if (res.stop_reason !== 'tool_use') break;

    messages.push({ role: 'assistant', content: res.content });
    const results = [];
    for (const b of res.content.filter((c) => c.type === 'tool_use')) {
      if (b.name === 'save_lead') {
        q.upsertLead(phone, b.input);
        q.addEvent('lead_updated', phone, JSON.stringify(b.input));
        if (b.input.interest === 'hot') out.hot = true;
      } else if (b.name === 'request_human') {
        q.flagHuman(phone);
        q.addEvent('human_requested', phone, b.input.reason);
        out.human = true;
      }
      results.push({ type: 'tool_result', tool_use_id: b.id, content: 'ok' });
    }
    messages.push({ role: 'user', content: results });
  }
  return out;
}
