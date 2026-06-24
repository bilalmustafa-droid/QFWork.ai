// ============================================================
// One-time Tavus setup — run:  node setup-tavus.js
// ------------------------------------------------------------
// Creates the QFwork interviewer PERSONA and lists stock REPLICA
// faces, then prints the two ids to paste into your .env:
//   TAVUS_PERSONA_ID=...
//   TAVUS_REPLICA_ID=...
// Requires TAVUS_API_KEY in .env first.
// ============================================================

require('dotenv').config();
const fetch = require('node-fetch');

const BASE = 'https://tavusapi.com/v2';
const key  = process.env.TAVUS_API_KEY;
const H    = { 'x-api-key': key, 'Content-Type': 'application/json' };

async function main() {
  if (!key) {
    console.error('❌  Set TAVUS_API_KEY in your .env first.');
    process.exit(1);
  }

  // 1) Create the interviewer persona (uses Tavus's built-in LLM + voice).
  const persona = {
    persona_name: 'QFwork Interviewer',
    system_prompt:
      'You are a professional but friendly workplace-English interview partner for QFwork.ai. ' +
      'You run realistic spoken practice — interviews, salary negotiations, presentations and client meetings — ' +
      'to help the candidate improve their professional spoken English. Speak naturally and conversationally, ' +
      'ask ONE thing at a time, keep your turns short (1-3 sentences), and ask natural follow-up questions based ' +
      'on what the candidate actually says. The specific situation and your opening line are provided per conversation. ' +
      'Never break character, and never give feedback, corrections or scores during the conversation — that happens afterwards.',
    context: 'QFwork.ai helps Hong Kong professionals practise workplace English through realistic spoken role-play.',
    pipeline_mode: 'full',
    // Raven-1 vision: targeted end-of-call questions → a HIGH-QUALITY, focused
    // delivery analysis (instead of Tavus's generic default summary). These are
    // answered once, at the end, from the whole conversation, and shape the
    // application.perception_analysis event we read for feedback.
    layers: {
      perception: {
        perception_model: 'raven-1',
        perception_analysis_queries: [
          "Eye contact: Did the candidate maintain steady, direct eye contact with the camera, or did they frequently look away, down, or around? Describe how their eye contact changed across the conversation.",
          "Facial expression: What expressions did the candidate show while speaking and listening — engaged and animated, neutral and flat, tense or anxious, or warm and smiling? Note changes at key moments.",
          "Body language: Describe the candidate's posture and body language — upright and composed, relaxed, stiff, slouching, leaning, or fidgeting. Note any repeated or distracting gestures, and whether their hands/movements supported or undercut their message.",
          "Confidence and composure: Overall, did the candidate appear confident and at ease on camera, or visibly nervous and uncomfortable? Cite the specific visual signals you based this on.",
          "Engagement: How engaged and present did the candidate seem throughout — actively listening and reacting to the interviewer, or distracted, disengaged, or looking elsewhere?"
        ]
      }
    }
  };

  const pr = await fetch(`${BASE}/personas`, { method: 'POST', headers: H, body: JSON.stringify(persona) });
  const pdata = await pr.json().catch(() => ({}));
  if (!pr.ok) {
    console.error('❌  Persona creation failed:', pr.status, JSON.stringify(pdata));
    process.exit(1);
  }
  const personaId = pdata.persona_id || pdata.id;
  console.log('\n✅  Persona created.');
  console.log('    TAVUS_PERSONA_ID=' + personaId);

  // 2) List stock replicas so you can pick a face.
  try {
    const rr = await fetch(`${BASE}/replicas?replica_type=system`, { headers: H });
    const rdata = await rr.json().catch(() => ({}));
    const list = (rdata.data || rdata.replicas || []).slice(0, 10);
    if (list.length) {
      console.log('\n🎭  Stock replica faces (pick one for TAVUS_REPLICA_ID):');
      for (const r of list) {
        console.log('    ' + (r.replica_id || r.id) + '   —   ' + (r.replica_name || r.name || ''));
      }
    } else {
      console.log('\n(Could not auto-list replicas — browse them in the Tavus dashboard and copy a replica_id.)');
    }
  } catch (_) {
    console.log('\n(Could not auto-list replicas — browse them in the Tavus dashboard.)');
  }

  console.log('\n👉  Paste TAVUS_PERSONA_ID and TAVUS_REPLICA_ID into .env, then restart the server.\n');
}

main().catch(e => { console.error(e); process.exit(1); });
