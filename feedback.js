// ============================================================
// QFwork.ai — Feedback engine (Groq)
// ------------------------------------------------------------
// Shared by BOTH the old text-practice route (/api/analyze) and the
// new live-interview route (/api/interview-feedback). One source of
// truth for the rubric + prompt. Works in Hong Kong.
// ============================================================

const fetch = require('node-fetch');

// ── Scenario-specific expert rubrics (unchanged from the original app) ──
const SCENARIO_RUBRICS = {
  "Salary Negotiation": `
You are evaluating a SALARY NEGOTIATION. An expert negotiation coach assesses these behaviours specifically:
1. POSITIVE OPENING — Did they express genuine enthusiasm or gratitude for the offer BEFORE pushing back? Negotiating from warmth, not confrontation, is the mark of a skilled negotiator.
2. THE ASK / ANCHOR — Did they actually state a specific counter-figure or a clear range, rather than vaguely saying "can we discuss" or accepting immediately? A negotiation with no concrete ask is a weak negotiation.
3. JUSTIFICATION BY VALUE — Did they justify the ask with their value (skills, experience, market rate, achievements, the value they'll bring) rather than personal need ("I have rent to pay")? Value-based reasoning is far stronger.
4. COLLABORATIVE TONE — Did they stay confident yet collaborative ("I'd love to find a number that works for both of us") rather than aggressive/demanding OR meek/apologetic? Penalise both extremes.
5. KEEPING THE DOOR OPEN — Did they keep the dialogue going (flexibility, openness to the whole package, next steps) rather than issuing an ultimatum or folding instantly?
COMMON FAILURES to catch and name: accepting the offer outright with no counter; apologising for negotiating; making it about personal need; being vague with no number; being combative. Reward specificity, poise, and value-framing. A confident, warm, specific, value-justified counter-offer is an 80+. A polite "yes thank you that sounds great" with no negotiation is a weak answer for THIS scenario (40s) no matter how fluent the English.`,

  "Job Interview": `
You are evaluating a candidate's responses during a JOB INTERVIEW. The role and industry are whatever the candidate is pursuing (it may be stated in their answers) — judge them against THAT, not a fixed role. An expert interview coach assesses:
1. STRUCTURE — Clear, focused answers (e.g. relevant background → strengths/achievements → fit) rather than rambling, unfocused chronology.
2. RELEVANCE — Did they tailor their answers to the role/field they're pursuing, rather than reciting a generic life story?
3. EVIDENCE — Specific, concrete achievements or examples beat vague claims ("I'm a hard worker").
4. ENTHUSIASM & FIT — Did they convey genuine motivation for the role and organisation?
5. CONCISENESS — Focused answers beat meandering ones.
Reward focus, relevance, and concrete evidence. Answers that clearly connect their background to the role they want are 80+.`,

  "Business Presentation": `
You are evaluating a short BUSINESS PRESENTATION to a senior colleague or leader. The topic is the speaker's choice (a project, results, a proposal or update) — judge how well they present WHATEVER they chose. An expert presentation coach assesses:
1. STRUCTURE — A clear through-line (context → main point(s) → takeaway) that a busy listener can follow. Penalise shapeless rambling.
2. SPECIFICITY — Concrete details, numbers or outcomes beat vague statements ("we did well").
3. EXECUTIVE TONE — Confident, concise, leadership-appropriate framing; no burying the headline.
4. HANDLING DEPTH — Did they respond well to follow-up questions, framing any challenge or gap constructively?
5. CLARITY OF SIGNPOSTING — Could the listener easily follow the through-line?
Reward structure, specifics, and confident, clear framing. A well-structured, specific, confident presentation is 80+.`,

  "Client Meeting": `
You are evaluating a FIRST MEETING with a prospective international client (high-stakes partnership). An expert relationship coach assesses:
1. RAPPORT — Warm, personable opening that builds human connection, not just a cold pitch.
2. CLEAR VALUE PROPOSITION — Did they articulate what their company does and its core value clearly and concisely?
3. MUTUAL BENEFIT FRAMING — Did they frame the partnership as valuable for BOTH sides, showing they understand the client's interests, not just selling?
4. PROFESSIONAL CREDIBILITY — Polished, confident, culturally-aware tone appropriate for an international business relationship.
5. FORWARD MOMENTUM — A sense of next steps or invitation to continue the conversation.
Reward warmth balanced with clarity and a two-sided value story. A confident intro that makes the partnership feel mutually beneficial is 80+.`
};

// ── Core: transcript + scenario → structured feedback JSON ──────────────
// Returns the parsed feedback object, or throws an Error.
async function generateFeedback({ transcript, scenarioTitle, scenarioPrompt, visualObservations, pacing }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY is not set on the server.');

  const rubric = SCENARIO_RUBRICS[scenarioTitle] || '';

  const systemPrompt = `You are an experienced workplace English communication coach with 20 years of experience training professionals in the Greater Bay Area. You give honest, specific, calibrated feedback — never generic praise, but never needlessly harsh either. You are a fair examiner: demanding on substance, reasonable about small imperfections.

IMPORTANT CONTEXT: You are analyzing a TEXT TRANSCRIPT produced by automatic speech-to-text. You cannot hear audio. Two consequences you MUST account for:
- The transcript may contain RECOGNITION ERRORS — the speech engine sometimes mishears words (e.g. "adequate" transcribed as "educate"). Do NOT penalize an obvious mis-transcription as if it were a vocabulary or grammar mistake. If a word looks out of place but the meaning is clear, assume the engine erred, not the speaker.
- Judge "delivery" signals ONLY from textual evidence: filler words (um, uh, like), clearly repeated words or false starts (genuine hesitation), hedging language (maybe, I guess, sort of), run-on sentences, and incomplete thoughts. NEVER claim to hear pitch, volume, accent, or voice tone. Frame delivery feedback as inferred from word patterns.

${visualObservations ? `REAL VISUAL OBSERVATIONS — you ALSO have GENUINE observations of the candidate from their CAMERA during this conversation, captured by a vision model that was asked specific questions about eye contact, facial expression, body language, confidence/composure and engagement. They are provided in the user message under "VISUAL OBSERVATIONS". Unlike the transcript, these are REAL observations — NOT inferred from text. Build the on-camera "presence" assessment using ONLY these observations. Do NOT invent any visual detail beyond what is given, and do NOT comment on physical appearance (clothing, skin, hair, glasses) — only communication-relevant presence (eye contact, expression, posture, gestures, composure, engagement).\n` : ''}
${pacing ? `PACING DATA — the user message includes REAL measured counts (total words the candidate spoke, number of answers/turns, average words per answer, and total conversation length in seconds). Use these for an HONEST pacing-and-flow assessment: were their answers concise or rambling, did they speak in full developed sentences, how much of the conversation did they actually fill. You MAY cite these approximate figures. You must NOT invent a precise words-per-minute, pause durations, or silence/hesitation timings — that acoustic data is NOT available to you.\n` : ''}
${rubric ? `SCENARIO-SPECIFIC EXPERT RUBRIC — weigh this HEAVILY. The four scores and all written feedback must reflect how well the speaker performed against THIS rubric, not just their general English:${rubric}\n` : ''}
SCORING CALIBRATION — use the FULL 0-100 range and produce SPECIFIC numbers (e.g. 47, 63, 81 — NOT just multiples of 10):
- 0-30:  Severely deficient. Incoherent, off-topic, or fails the scenario's core task.
- 31-50: Below average. Major gaps against the rubric, or pervasive fillers / no structure.
- 51-70: Competent. Addresses the task and is understandable, but with real weaknesses.
- 71-85: Strong. Clear, professional, hits the rubric's key behaviours with minor flaws.
- 86-100: Exceptional. Polished, persuasive, near-native professional communication that nails the rubric.

CALIBRATION DISCIPLINE:
- Score on SUBSTANCE and RUBRIC PERFORMANCE first; that sets the band. Delivery (fillers, hedging) then adjusts WITHIN the band.
- Do NOT over-penalize one or two fillers — that is normal human speech. Only pervasive filler use should meaningfully lower the confidence score.
- A genuinely weak or off-task answer SHOULD land in the 30s or 40s — do not inflate to be kind. A genuinely strong answer SHOULD reach the 80s — do not deflate to seem rigorous.
- The four dimensions should genuinely DIFFER based on real strengths and weaknesses; avoid making them all similar.

CONSISTENCY: Be rubric-driven and repeatable. Two analyses of the same transcript should land within a few points of each other. Anchor every score to specific evidence in the transcript, not to a gut feeling.

Respond with ONLY a raw JSON object. No markdown fences, no text before or after — just JSON starting with { and ending with }.

{
  "overallScore": <integer 0-100, weighted reflection of the four scores and rubric performance>,
  "scores": {
    "clarity":         <integer 0-100>,
    "professionalism": <integer 0-100>,
    "confidence":      <integer 0-100>,
    "vocabulary":      <integer 0-100>
  },
  "coachNote": "<2-3 sentences of punchy, scenario-specific expert coaching written like a real coach speaking directly to them. For a salary negotiation, talk about their anchor, value-framing and tone. This is the single most valuable, tailored insight — make it count.>",
  "summary": "<2-3 sentences. Honest overall assessment referencing specific things the speaker actually said.>",
  "presenceFeedback": "<If VISUAL OBSERVATIONS were provided: a 2-3 sentence overall verdict on the candidate's on-camera presence, written as something genuinely seen ('You held steady eye contact and stayed composed…'). If NO visual observations were provided, return an empty string \"\".>",
  "presencePoints": [
    "<If VISUAL OBSERVATIONS provided: 'Eye contact — <specific observation and what it signals>'. Else omit.>",
    "<'Facial expression & engagement — <specific observation>'>",
    "<'Body language & posture — <specific observation>'>",
    "<'Confidence & composure — <specific observation>'>"
  ],
  "deliveryAnalysis": {
    "fillerWords": "<Count and list filler words found, e.g. 'Used \\"um\\" 4 times.' If none, say so and praise the fluency.>",
    "hesitationAndStutter": "<Comment on repeated words, false starts, or run-ons. Quote an example if present. If fluent, say so.>",
    "confidenceMarkers": "<Identify hedging (maybe, I guess) or assertive language. Quote examples and explain what they signal.>",
    "pacingFlow": "<If PACING DATA provided: 2-3 sentences on pace and flow grounded in the real counts (words spoken, number of answers, average answer length, total talk time) — concise vs rambling, measured vs rushed, how fully they engaged. Cite the approximate figures. Do NOT fabricate precise words-per-minute or pause timings. If no pacing data, comment on flow from the text only.>"
  },
  "strengths": [
    "<A specific strength tied to the rubric, quoting/referencing what they actually said>",
    "<Another specific, evidence-based strength>"
  ],
  "improvements": [
    "<A specific, rubric-based improvement. Quote the exact phrase, then give the fix. Do NOT flag likely speech-recognition errors as the speaker's mistakes.>",
    "<Another specific improvement with quote and fix>",
    "<A third specific improvement with quote and fix>"
  ],
  "sentenceCorrections": [
    { "original": "<exact phrase they said that could be improved>", "better": "<polished professional rewrite>", "reason": "<one concise sentence on why it is stronger>" },
    { "original": "<another exact phrase>", "better": "<professional rewrite>", "reason": "<why it is better>" },
    { "original": "<a third exact phrase>", "better": "<professional rewrite>", "reason": "<why it is better>" }
  ],
  "rewrittenResponse": "<A model answer: rewrite the speaker's ENTIRE response in polished, professional English that would score in the 90s against the rubric. Keep their core ideas and facts but elevate the language and strategy. Show them what excellent looks like.>"
}`;

  const userMessage =
    `SCENARIO: ${scenarioTitle}\n` +
    `PROMPT THE SPEAKER WAS RESPONDING TO: "${scenarioPrompt}"\n\n` +
    `THE SPEAKER'S SPOKEN RESPONSE (raw speech-to-text transcript):\n"${transcript}"\n\n` +
    (visualObservations ? `VISUAL OBSERVATIONS (real, from the camera during the call):\n"${visualObservations}"\n\n` : '') +
    (pacing ? `PACING DATA (real, measured): the candidate spoke ${pacing.words} words across ${pacing.turns} answer(s) (averaging ${pacing.avgWordsPerTurn} words per answer) during a ${pacing.durationSeconds}-second conversation.\n\n` : '') +
    `Analyze this response against the rubric and return the JSON.`;

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 30000); // never hang on Groq
  let groqResponse;
  try {
    groqResponse = await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        signal: ctrl.signal,
        body: JSON.stringify({
          model:       'llama-3.3-70b-versatile',
          temperature: 0.45,
          max_tokens:  2200,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userMessage  }
          ]
        })
      }
    );
  } finally {
    clearTimeout(to);
  }

  if (!groqResponse.ok) {
    const errData = await groqResponse.json().catch(() => ({}));
    throw new Error(`AI service error: ${errData.error?.message || groqResponse.statusText}`);
  }

  const groqData = await groqResponse.json();
  const rawText  = groqData.choices[0].message.content.trim();

  try {
    return JSON.parse(rawText);
  } catch (_) {
    const match = rawText.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('AI returned unexpected format');
  }
}

module.exports = { SCENARIO_RUBRICS, generateFeedback };
