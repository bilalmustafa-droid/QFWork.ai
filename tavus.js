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
        console.log(`[tavus] network error (${e.message}), retry ${i + 1}/${retries}`);
        await new Promise(r => setTimeout(r, 800 * (i + 1)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// Start a real-time video conversation with the interviewer replica.
// `personaId` (optional) lets a scenario use its own persona — e.g. the
// patient "presentation executive" — instead of the default interviewer.
async function createConversation({ conversationName, conversationalContext, customGreeting, callbackUrl, personaId }) {
  if (!process.env.TAVUS_API_KEY)    throw new Error('TAVUS_API_KEY is not set on the server.');
  if (!process.env.TAVUS_REPLICA_ID) throw new Error('TAVUS_REPLICA_ID is not set (pick a stock replica in the Tavus dashboard).');

  // Hard per-call cap (seconds) — the single best guard against runaway billing.
  const maxSeconds = parseInt(process.env.TAVUS_MAX_CALL_SECONDS || '300', 10);

  // Tavus bills from the moment a conversation is created, because the replica
  // immediately starts waiting in the room — not from when the user joins.
  // The client therefore creates the conversation only once the user has
  // finished choosing their camera and microphone; these two timeouts cap the
  // remaining exposure if they still never arrive or leave the tab open.
  const absentTimeout = parseInt(process.env.TAVUS_ABSENT_TIMEOUT || '90', 10);
  const leftTimeout   = parseInt(process.env.TAVUS_LEFT_TIMEOUT   || '15', 10);

  const body = {
    replica_id: process.env.TAVUS_REPLICA_ID,
    conversation_name: conversationName || 'QFwork interview',
    conversational_context: conversationalContext || '',
    custom_greeting: customGreeting || '',
    properties: {
      max_call_duration:         maxSeconds,
      participant_absent_timeout: absentTimeout,
      participant_left_timeout:   leftTimeout
    }
  };
  // persona_id is OPTIONAL — Tavus falls back to a default persona if omitted.
  // Priority: explicit per-scenario persona → default QFwork Interviewer.
  const usePersona = personaId || process.env.TAVUS_PERSONA_ID;
  if (usePersona) body.persona_id = usePersona;
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
  // Tolerate event-name changes between raven-0 / raven-1: match any event
  // whose type mentions "perception" and carries an analysis/summary string.
  let pa = events.find(e => /perception/i.test(e.event_type || '') &&
                            e.properties && (e.properties.analysis || e.properties.summary));
  // Last-resort fallback: any event with a non-trivial analysis string.
  if (!pa) pa = events.find(e => e.properties && typeof e.properties.analysis === 'string'
                                 && e.properties.analysis.trim().length > 20);
  if (!pa) return '';
  return String(pa.properties.analysis || pa.properties.summary).trim();
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

// ============================================================
// Perception self-heal
// ------------------------------------------------------------
// The on-camera "presence" feedback depends on the persona having a
// PERCEPTION layer (Raven vision): without it Tavus never emits the
// application.perception_analysis event and the presence section of
// the report stays empty. Dashboard-created personas often lack it,
// so at boot we check the configured persona and PATCH the layer in
// (raven-1 + our end-of-call analysis queries) if it's missing.
// ============================================================
const PERCEPTION_ANALYSIS_QUERIES = [
  "Eye contact: Did the candidate maintain steady, direct eye contact with the camera, or did they frequently look away, down, or around? Describe how their eye contact changed across the conversation.",
  "Facial expression: What expressions did the candidate show while speaking and listening — engaged and animated, neutral and flat, tense or anxious, or warm and smiling? Note changes at key moments.",
  "Body language: Describe the candidate's posture and body language — upright and composed, relaxed, stiff, slouching, leaning, or fidgeting. Note any repeated or distracting gestures, and whether their hands/movements supported or undercut their message.",
  "Confidence and composure: Overall, did the candidate appear confident and at ease on camera, or visibly nervous and uncomfortable? Cite the specific visual signals you based this on.",
  "Engagement: How engaged and present did the candidate seem throughout — actively listening and reacting to the interviewer, or distracted, disengaged, or looking elsewhere?"
];

async function ensurePerceptionLayer(personaId = process.env.TAVUS_PERSONA_ID) {
  if (!process.env.TAVUS_API_KEY) return { ok: false, reason: 'TAVUS_API_KEY not set' };
  if (!personaId) return { ok: false, reason: 'persona id not set — default persona has no custom perception queries' };

  const r = await fetchResilient(`${TAVUS_BASE}/personas/${personaId}`, { headers: headers() });
  if (!r.ok) return { ok: false, reason: `could not fetch persona (${r.status}): ${(await r.text()).slice(0, 200)}` };
  const persona = await r.json();

  const layer = persona.layers && persona.layers.perception;
  const model = layer && layer.perception_model;
  const hasQueries = layer && Array.isArray(layer.perception_analysis_queries) && layer.perception_analysis_queries.length > 0;
  if (model && model !== 'off' && hasQueries) {
    return { ok: true, patched: false, model };
  }

  // JSON Patch: "add" both creates the member and replaces an incomplete one.
  const patch = [{
    op: 'add',
    path: '/layers/perception',
    value: {
      perception_model: 'raven-1',
      perception_analysis_queries: PERCEPTION_ANALYSIS_QUERIES
    }
  }];
  const pr = await fetchResilient(`${TAVUS_BASE}/personas/${personaId}`, {
    method: 'PATCH', headers: headers(), body: JSON.stringify(patch)
  });
  if (!pr.ok) return { ok: false, reason: `PATCH failed (${pr.status}): ${(await pr.text()).slice(0, 300)}` };
  return { ok: true, patched: true, model: 'raven-1' };
}

module.exports = { createConversation, getConversationTranscript, endConversation, extractTranscript, ensurePerceptionLayer };
