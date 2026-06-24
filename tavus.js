// ============================================================
// QFwork.ai — Tavus CVI integration
// ------------------------------------------------------------
// Thin wrapper over the Tavus Conversational Video Interface API.
// The TAVUS_API_KEY lives here on the server only — the browser
// receives just the conversation_url to join the video call.
//
//   create → returns { conversation_id, conversation_url }
//   transcript → GET ?verbose=true, normalised to the user's speech
// ============================================================

const fetch = require('node-fetch');

const TAVUS_BASE = 'https://tavusapi.com/v2';

function headers() {
  return {
    'x-api-key': process.env.TAVUS_API_KEY || '',
    'Content-Type': 'application/json'
  };
}

// fetch that can't hang forever — aborts after `ms` so the server always responds.
async function fetchWithTimeout(url, opts = {}, ms = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

// Retry transient network blips (DNS ENOTFOUND, dropped sockets, timeouts).
// Does NOT retry HTTP error statuses — only thrown network errors.
async function fetchResilient(url, opts = {}, { timeout = 20000, retries = 2 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try { return await fetchWithTimeout(url, opts, timeout); }
    catch (e) {
      lastErr = e;
      const transient = /ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|abort|network|socket/i.test(e.message || '');
      if (i < retries && transient) {
        console.log(`↻  Network blip (${e.message}) — retry ${i + 1}/${retries}…`);
        await new Promise(r => setTimeout(r, 800 * (i + 1)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// Start a real-time video conversation with the interviewer replica.
async function createConversation({ conversationName, conversationalContext, customGreeting, callbackUrl }) {
  if (!process.env.TAVUS_API_KEY)    throw new Error('TAVUS_API_KEY is not set on the server.');
  if (!process.env.TAVUS_REPLICA_ID) throw new Error('TAVUS_REPLICA_ID is not set (pick a stock replica in the Tavus dashboard).');

  // Hard per-call cap (seconds) — the single best guard against runaway billing.
  const maxSeconds = parseInt(process.env.TAVUS_MAX_CALL_SECONDS || '300', 10);

  const body = {
    replica_id: process.env.TAVUS_REPLICA_ID,
    conversation_name: conversationName || 'QFwork interview',
    conversational_context: conversationalContext || '',
    custom_greeting: customGreeting || '',
    properties: {
      max_call_duration: maxSeconds
    }
  };
  // persona_id is OPTIONAL — Tavus falls back to a default persona if omitted.
  // Our richer "QFwork Interviewer" persona (from setup-tavus.js) is preferred when set.
  if (process.env.TAVUS_PERSONA_ID) body.persona_id = process.env.TAVUS_PERSONA_ID;
  if (callbackUrl) body.callback_url = callbackUrl;

  const r = await fetchResilient(`${TAVUS_BASE}/conversations`, {
    method: 'POST', headers: headers(), body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`Tavus create conversation failed (${r.status}): ${await r.text()}`);
  return r.json(); // { conversation_id, conversation_url, status, ... }
}

// Fetch the conversation (verbose) and pull out a usable transcript.
// Returns the extracted transcript PLUS the raw payload (for debugging).
async function getConversationTranscript(conversationId) {
  const r = await fetchWithTimeout(`${TAVUS_BASE}/conversations/${conversationId}?verbose=true`, { headers: headers() });
  if (!r.ok) throw new Error(`Tavus get conversation failed (${r.status}): ${await r.text()}`);
  const data = await r.json();
  return { ...extractTranscript(data), perception: extractPerception(data), raw: data };
}

// The end-of-call visual summary from Tavus's Raven perception model
// (facial expression, eye contact, body language, emotional state).
function extractPerception(data) {
  const events = Array.isArray(data.events) ? data.events : [];
  const pa = events.find(e => (e.event_type || '') === 'application.perception_analysis');
  return (pa && pa.properties && pa.properties.analysis) ? String(pa.properties.analysis).trim() : '';
}

// The exact location of the transcript in Tavus's payload can vary by
// version/endpoint, so instead of guessing a path we DEEP-SEARCH the whole
// object for the largest array of role+content message objects.
function extractTranscript(data) {
  // Exact path: events[] → application.transcription_ready → properties.transcript.
  // Fall back to a deep-search if Tavus changes the structure.
  let turns = null;
  const events = Array.isArray(data.events) ? data.events : [];
  const tr = events.find(e => (e.event_type || '') === 'application.transcription_ready');
  if (tr && Array.isArray(tr.properties && tr.properties.transcript)) turns = tr.properties.transcript;
  if (!turns) turns = findTranscriptArray(data);

  const norm = (turns || [])
    .map(t => ({
      role: String(t.role || t.speaker || t.from || '').toLowerCase(),
      text: String(t.content || t.text || t.message || t.transcript || '').trim()
    }))
    .filter(t => t.text && t.role !== 'system');   // drop the injected system prompt

  // Tavus labels the human "user" and the AI "assistant"/"replica".
  const isUser = (role) => role === 'user' || role === 'participant' || role === 'human';

  const userText = norm.filter(t => isUser(t.role)).map(t => t.text).join(' ');
  const dialogue = norm.map(t => `${isUser(t.role) ? 'CANDIDATE' : 'INTERVIEWER'}: ${t.text}`).join('\n');

  return { userText, dialogue, rawTurns: norm };
}

// Walk the whole response and return the longest array whose items look
// like {role/speaker, content/text/message} — that's the transcript,
// wherever Tavus happens to nest it.
function findTranscriptArray(root) {
  let best = [];
  const seen = new Set();
  const visit = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      const looksLikeTranscript = node.length > 0 && node.every(it =>
        it && typeof it === 'object' &&
        ('role' in it || 'speaker' in it || 'from' in it) &&
        ('content' in it || 'text' in it || 'message' in it || 'transcript' in it));
      if (looksLikeTranscript && node.length > best.length) best = node;
      node.forEach(visit);
    } else {
      Object.values(node).forEach(visit);
    }
  };
  visit(root);
  return best;
}

// Politely end a conversation (frees the stream / stops billing).
async function endConversation(conversationId) {
  try {
    await fetchWithTimeout(`${TAVUS_BASE}/conversations/${conversationId}/end`, { method: 'POST', headers: headers() }, 10000);
  } catch (_) { /* best-effort */ }
}

module.exports = { createConversation, getConversationTranscript, endConversation, extractTranscript };
