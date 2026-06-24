// ============================================================
// QFwork.ai — Backend Server
// ------------------------------------------------------------
//  • POST /api/analyze            → text practice → Groq feedback (original)
//  • POST /api/conversation       → start a Tavus live video interview
//  • POST /api/interview-feedback → pull Tavus transcript → Groq feedback
//  • WS   /realtime               → OpenAI Realtime relay (alternate path)
//
//  Keys (GROQ / OPENAI / TAVUS) live here only, never in the browser.
// ============================================================

const express = require('express');
const cors    = require('cors');
const http    = require('http');
require('dotenv').config();

const { attachRealtimeRelay } = require('./relay');
const { generateFeedback }    = require('./feedback');
const { createConversation, getConversationTranscript, endConversation } = require('./tavus');

const app  = express();
const PORT = process.env.PORT || 3000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

app.use(express.json());
app.use(cors());

// Make the live interview the front door.
app.get('/', (req, res) => res.redirect('/exam.html'));

app.use(express.static('public'));


// ============================================================
// LIVE INTERVIEW SCENARIOS
// ------------------------------------------------------------
// `prompt`  → the situation, also passed to the feedback rubric.
// `context` → conversational_context: how the Tavus replica role-plays.
// `greeting`→ custom_greeting: the first line the replica says.
// Titles MUST match the rubric titles in feedback.js.
// ============================================================
const INTERVIEW_SCENARIOS = {
  "Job Interview": {
    prompt:  "A professional job interview. The interviewer asks about your background, strengths and fit, with natural follow-ups — tailored to whatever role you're pursuing.",
    context: "You are a warm, professional interviewer running a practice job interview. Do NOT assume any particular industry or role. At the very start, briefly ask the candidate what role or field they're interviewing for, then adapt ALL of your questions to whatever they say. Open with 'tell me about yourself', then ask natural, open follow-up questions about their experience, strengths and motivation. Follow the candidate's lead, ask ONE question at a time, and keep each turn to 1-3 sentences. Never give feedback or scores during the interview.",
    greeting: "Hi, great to meet you — thanks for coming in. Before we dive in, what role or field are you interviewing for today?"
  },
  "Salary Negotiation": {
    prompt:  "A salary negotiation. You've received a job offer and are negotiating the package.",
    context: "You are a friendly hiring manager who has just offered the candidate a role. Do NOT assume their industry. If you don't already know their field, briefly ask what kind of role they're negotiating for, then continue. Present a fair offer and show some flexibility, but only improve it if they negotiate well — a warm opening, a specific ask or range, and value-based justification. Gently push back once or twice to test them. Ask ONE thing at a time, keep turns to 1-3 sentences. Do not give feedback during the conversation.",
    greeting: "Congratulations — we'd really love to have you on the team. Before I lay out the offer, tell me a little about the role you're stepping into so we're on the same page."
  },
  "Business Presentation": {
    prompt:  "A short professional presentation to a senior colleague or leader — about a project, result, proposal or update of your choice.",
    context: "You are a senior colleague listening to the candidate give a short professional presentation. Let THEM choose the topic: at the start, invite them to tell you what they'd like to present (a project, some results, an idea), then listen and probe with one or two thoughtful follow-up questions. Do NOT impose a fixed structure or industry. Ask ONE thing at a time, keep turns to 1-3 sentences, executive in tone. Do not give feedback during the conversation.",
    greeting: "Good to see you. Whenever you're ready — what would you like to walk me through today?"
  },
  "Client Meeting": {
    prompt:  "A first meeting with a prospective client or partner about working together.",
    context: "You are a prospective client or partner meeting the candidate for the first time. Do NOT assume their industry. Be warm but curious: let them introduce themselves and what they or their company do, and ask how working together could benefit your side. Adapt to whatever field they describe. Ask ONE thing at a time, keep turns to 1-3 sentences. Do not give feedback during the conversation.",
    greeting: "Hello, lovely to meet you. I'd love to hear a bit about you and what you do — go ahead."
  }
};


// ============================================================
// POST /api/analyze  — original text-practice feedback
// ============================================================
app.post('/api/analyze', async (req, res) => {
  const { transcript, scenarioTitle, scenarioPrompt } = req.body;
  if (!transcript || !scenarioTitle) {
    return res.status(400).json({ error: 'Missing transcript or scenario.' });
  }
  try {
    const feedback = await generateFeedback({ transcript, scenarioTitle, scenarioPrompt });
    return res.status(200).json(feedback);
  } catch (error) {
    console.error('Analyze error:', error.message);
    const code = /not set/.test(error.message) ? 500 : 502;
    return res.status(code).json({ error: error.message });
  }
});


// ============================================================
// POST /api/conversation  — start a live Tavus video interview
//   body: { scenarioTitle }
//   returns: { conversationId, conversationUrl, scenarioPrompt }
// ============================================================
app.post('/api/conversation', async (req, res) => {
  const { scenarioTitle, userContext } = req.body;
  const scenario = INTERVIEW_SCENARIOS[scenarioTitle];
  if (!scenario) {
    return res.status(400).json({ error: `Unknown scenario: ${scenarioTitle}` });
  }
  // Optionally tailor the role-play to whatever the user told us about themselves.
  let context = scenario.context;
  if (userContext && userContext.trim()) {
    context += `\n\nThe candidate shared this about their situation — use it to tailor the conversation and do NOT ask again: "${userContext.trim().slice(0, 500)}"`;
  }
  try {
    const convo = await createConversation({
      conversationName:      `QFwork — ${scenarioTitle}`,
      conversationalContext: context,
      customGreeting:        scenario.greeting,
      callbackUrl:           process.env.TAVUS_CALLBACK_URL || undefined
    });
    return res.status(200).json({
      conversationId:  convo.conversation_id,
      conversationUrl: convo.conversation_url,
      scenarioPrompt:  scenario.prompt,
      maxSeconds:      parseInt(process.env.TAVUS_MAX_CALL_SECONDS || '300', 10)
    });
  } catch (error) {
    console.error('Create conversation error:', error.message);
    return res.status(502).json({ error: error.message });
  }
});


// ============================================================
// POST /api/interview-feedback  — end of call → transcript → feedback
//   body: { conversationId, scenarioTitle }
// ============================================================
app.post('/api/interview-feedback', async (req, res) => {
  const { conversationId, scenarioTitle, durationSeconds } = req.body;
  const scenario = INTERVIEW_SCENARIOS[scenarioTitle];
  if (!conversationId || !scenario) {
    return res.status(400).json({ error: 'Missing conversationId or unknown scenario.' });
  }
  try {
    await endConversation(conversationId); // stop the stream so the transcript finalises

    // The transcript is NOT ready the instant a call ends — poll for it,
    // breaking as soon as we have the candidate's speech.
    let result = { userText: '', dialogue: '', rawTurns: [], raw: null };
    for (let attempt = 1; attempt <= 8; attempt++) {
      await sleep(attempt === 1 ? 2000 : 3000);
      try {
        result = await getConversationTranscript(conversationId);
      } catch (e) {
        console.log(`⚠️  Transcript fetch attempt ${attempt}/8 failed: ${e.message}`);
        continue;
      }
      console.log(`⏳  Attempt ${attempt}/8 — turns found: ${result.rawTurns?.length || 0}, candidate chars: ${result.userText?.length || 0}`);
      if (result.userText && result.userText.length >= 15) break;
    }

    if (!result.userText || result.userText.length < 15) {
      // Dump the raw payload so we can pin the exact transcript field if needed.
      console.log('\n────────── Tavus raw conversation payload (transcript debug) ──────────');
      console.log(JSON.stringify(result.raw, null, 2)?.slice(0, 6000));
      console.log('───────────────────────────────────────────────────────────────────────\n');
      return res.status(422).json({
        error: 'No candidate speech was captured in the transcript. If you did speak, this is a transcript-format mismatch — the raw Tavus payload was printed to the server terminal so we can fix the extractor.',
        dialogue: result.dialogue
      });
    }

    // Real pacing metrics from the transcript (legit — no fabricated WPM/pauses).
    const words = (result.userText.match(/[\w'-]+/g) || []).length;
    const turns = (result.rawTurns || []).filter(t => /^(user|participant|human)$/.test(t.role)).length || 1;
    let dur = Math.round(Number(durationSeconds) || 0);
    if (!dur && result.raw && result.raw.created_at && result.raw.updated_at) {
      dur = Math.round((new Date(result.raw.updated_at) - new Date(result.raw.created_at)) / 1000);
    }
    const pacing = { words, turns, avgWordsPerTurn: Math.round(words / turns), durationSeconds: dur };

    const feedback = await generateFeedback({
      transcript:         result.userText,
      scenarioTitle,
      scenarioPrompt:     scenario.prompt,
      visualObservations: result.perception,   // real camera observations (Raven perception)
      pacing
    });
    return res.status(200).json({ feedback, dialogue: result.dialogue });
  } catch (error) {
    console.error('Interview feedback error:', error.message);
    return res.status(502).json({ error: error.message });
  }
});


app.get('/health', (req, res) => res.json({ status: 'ok', message: 'QFwork.ai server is running' }));


// ── Boot: share one HTTP server between Express and the WS relay ─────────
const server = http.createServer(app);
attachRealtimeRelay(server);

server.listen(PORT, () => {
  console.log(`\n🚀  QFwork.ai server running at http://localhost:${PORT}`);
  console.log(`🔑  Groq:   ${process.env.GROQ_API_KEY  ? '✅' : '❌ missing'}   (feedback report)`);
  console.log(`🔑  Tavus:  ${process.env.TAVUS_API_KEY ? '✅' : '❌ missing'}   (live video interview)`);
  console.log(`🔑  OpenAI: ${process.env.OPENAI_API_KEY ? '✅' : '— (optional, Realtime relay path)'}`);
  console.log(`📁  Serving frontend from /public\n`);
});
