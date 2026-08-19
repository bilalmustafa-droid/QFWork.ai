// ============================================================
// QFwork.ai — Voice metrics engine
// ------------------------------------------------------------
// Turns the RAW AUDIO of the candidate's microphone (recorded in
// the browser during the call and uploaded as mono 16-bit WAV)
// into REAL measured delivery data:
//
//   • Prosody  — pure-JS DSP, no dependencies:
//       pitch contour (YIN)  → intonation / monotone detection
//       loudness dynamics    → vocal energy variation
//   • Timing   — Groq Whisper word-level timestamps:
//       articulation rate (WPM), hesitation pauses, speaking turns
//   • Clarity  — Whisper per-segment confidence:
//       articulation/pronunciation clarity score
//
// No new services or keys: the DSP is local and the timing/clarity
// layer reuses GROQ_API_KEY (speech-to-text is on Groq's free tier).
// If the Whisper call fails we still return the acoustic metrics.
// ============================================================

const fetch = require('node-fetch');

// ────────────────────────────────────────────────────────────
// WAV parsing → mono Float32 samples
// ────────────────────────────────────────────────────────────
function parseWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file.');
  }
  let pos = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      fmt = {
        audioFormat:   buf.readUInt16LE(pos + 8),
        channels:      buf.readUInt16LE(pos + 10),
        sampleRate:    buf.readUInt32LE(pos + 12),
        bitsPerSample: buf.readUInt16LE(pos + 22)
      };
    } else if (id === 'data') {
      dataOff = pos + 8;
      dataLen = Math.min(size, buf.length - dataOff);
    }
    pos += 8 + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt || dataOff < 0) throw new Error('WAV is missing fmt/data chunks.');
  if (fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) {
    throw new Error(`Unsupported WAV format (need 16-bit PCM, got format ${fmt.audioFormat}/${fmt.bitsPerSample}-bit).`);
  }
  const bytesPerFrame = 2 * fmt.channels;
  const frames = Math.floor(dataLen / bytesPerFrame);
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < fmt.channels; c++) acc += buf.readInt16LE(dataOff + i * bytesPerFrame + c * 2);
    mono[i] = acc / fmt.channels / 32768;
  }
  return { samples: mono, sampleRate: fmt.sampleRate };
}

// Decimate with a box filter (default target ~8 kHz — plenty for pitch
// < 450 Hz), so the pitch tracker stays fast even on long recordings.
function decimate(samples, rate, target = 8000) {
  const factor = Math.max(1, Math.round(rate / target));
  if (factor === 1) return { samples, rate };
  const out = new Float32Array(Math.floor(samples.length / factor));
  for (let i = 0; i < out.length; i++) {
    let acc = 0;
    const base = i * factor;
    for (let j = 0; j < factor; j++) acc += samples[base + j];
    out[i] = acc / factor;
  }
  return { samples: out, rate: rate / factor };
}

// Re-encode float samples as a 16-bit mono WAV Buffer. Used to normalise
// whatever the browser recorded (44.1/48 kHz if it ignored our 16 kHz hint)
// down to a compact 16 kHz file before uploading to Groq Whisper — this
// keeps even long calls far under the API's file-size limit.
function encodeWavBuffer(samples, sampleRate) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0, 'ascii'); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii'); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii'); buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7FFF), 44 + i * 2);
  }
  return buf;
}

// ────────────────────────────────────────────────────────────
// Acoustics: speech gating, loudness dynamics, YIN pitch
// ────────────────────────────────────────────────────────────
function percentile(sortedArr, p) {
  if (!sortedArr.length) return NaN;
  const idx = Math.min(sortedArr.length - 1, Math.max(0, (sortedArr.length - 1) * p));
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}

// One YIN pitch estimate for the window starting at `start`.
// Returns F0 in Hz, or 0 if the frame is unvoiced.
function yinPitch(x, start, win, tauMin, tauMax, rate) {
  if (start + win + tauMax >= x.length) return 0;
  const d = new Float32Array(tauMax + 1);
  for (let tau = tauMin; tau <= tauMax; tau++) {
    let sum = 0;
    for (let i = 0; i < win; i++) {
      const diff = x[start + i] - x[start + i + tau];
      sum += diff * diff;
    }
    d[tau] = sum;
  }
  // Cumulative-mean-normalised difference
  const cmnd = new Float32Array(tauMax + 1);
  let running = 0;
  cmnd[0] = 1;
  for (let tau = 1; tau <= tauMax; tau++) {
    running += d[tau] || 0;
    cmnd[tau] = running ? (d[tau] * tau) / running : 1;
  }
  // First dip under threshold, refined to its local minimum
  const THRESH = 0.14;
  let tauEst = -1;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (cmnd[tau] < THRESH) {
      while (tau + 1 <= tauMax && cmnd[tau + 1] < cmnd[tau]) tau++;
      tauEst = tau;
      break;
    }
  }
  if (tauEst < 0) {
    // fall back to the global minimum if it's still a confident dip
    let best = tauMin;
    for (let tau = tauMin + 1; tau <= tauMax; tau++) if (cmnd[tau] < cmnd[best]) best = tau;
    if (cmnd[best] > 0.30) return 0; // unvoiced
    tauEst = best;
  }
  // Parabolic interpolation around the dip for sub-sample precision
  let tau = tauEst;
  if (tau > tauMin && tau < tauMax) {
    const a = cmnd[tau - 1], b = cmnd[tau], c = cmnd[tau + 1];
    const denom = a + c - 2 * b;
    if (Math.abs(denom) > 1e-12) tau += 0.5 * (a - c) / denom * -1;
  }
  const f0 = rate / tau;
  return (f0 >= 50 && f0 <= 450) ? f0 : 0;
}

function computeAcoustics(monoSamples, sampleRate) {
  const { samples: x, rate } = decimate(monoSamples, sampleRate);
  const durationSeconds = x.length / rate;

  // 20 ms frames for the loudness contour
  const hop = Math.round(0.02 * rate);
  const win = Math.round(0.05 * rate);
  const nFrames = Math.max(0, Math.floor((x.length - win) / hop));
  if (nFrames < 25) return null; // under ~half a second of audio

  const rmsDb = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    let acc = 0;
    const s = f * hop;
    for (let i = 0; i < win; i++) acc += x[s + i] * x[s + i];
    rmsDb[f] = 20 * Math.log10(Math.sqrt(acc / win) + 1e-9);
  }

  // Adaptive speech gate: well above the recording's own noise floor
  const sortedDb = Array.from(rmsDb).sort((a, b) => a - b);
  const noiseFloor = percentile(sortedDb, 0.15);
  const gate = Math.max(noiseFloor + 12, -55);
  const speechIdx = [];
  for (let f = 0; f < nFrames; f++) if (rmsDb[f] > gate && rmsDb[f] > -70) speechIdx.push(f);
  const speechRatio = speechIdx.length / nFrames;
  if (speechIdx.length < 25) return { durationSeconds, speechRatio, insufficientSpeech: true };

  // Loudness dynamics across speech frames only
  const speechDb = speechIdx.map(f => rmsDb[f]).sort((a, b) => a - b);
  const loudnessRangeDb = percentile(speechDb, 0.9) - percentile(speechDb, 0.1);

  // Pitch every 40 ms on speech frames only
  const tauMin = Math.max(2, Math.floor(rate / 450));
  const tauMax = Math.ceil(rate / 50);
  const f0s = [];
  for (let k = 0; k < speechIdx.length; k += 2) {
    const f0 = yinPitch(x, speechIdx[k] * hop, win, tauMin, tauMax, rate);
    if (f0 > 0) f0s.push(f0);
  }
  if (f0s.length < 12) return { durationSeconds, speechRatio, loudnessRangeDb: round1(loudnessRangeDb), insufficientPitch: true };

  // Robust pitch stats in semitones (gender-neutral variability measure)
  const st = f0s.map(f => 12 * Math.log2(f / 100));
  const stSorted = [...st].sort((a, b) => a - b);
  const median = percentile(stSorted, 0.5);
  // discard octave-error outliers beyond ±6 st of the median before the spread stats
  const kept = st.filter(v => Math.abs(v - median) <= 6);
  const mean = kept.reduce((a, b) => a + b, 0) / kept.length;
  const sd = Math.sqrt(kept.reduce((a, v) => a + (v - mean) * (v - mean), 0) / kept.length);
  const keptSorted = [...kept].sort((a, b) => a - b);
  const rangeSt = percentile(keptSorted, 0.9) - percentile(keptSorted, 0.1);
  const medianHz = 100 * Math.pow(2, median / 12);

  return {
    durationSeconds:      round1(durationSeconds),
    speechRatio:          round2(speechRatio),
    pitchMedianHz:        Math.round(medianHz),
    pitchVariabilitySt:   round1(sd),
    pitchRangeSt:         round1(rangeSt),
    intonationLabel:      sd < 1.2 ? 'flat / monotone'
                        : sd < 2.0 ? 'somewhat flat'
                        : sd < 3.5 ? 'naturally varied'
                        :            'highly expressive',
    loudnessRangeDb:      round1(loudnessRangeDb),
    energyLabel:          loudnessRangeDb < 4 ? 'flat / low variation'
                        : loudnessRangeDb < 8 ? 'moderate variation'
                        :                       'dynamic'
  };
}

const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;

// ────────────────────────────────────────────────────────────
// Groq Whisper: word timestamps + segment confidence
// (manual multipart body — no extra npm dependency)
// ────────────────────────────────────────────────────────────
async function transcribeWithTimestamps(wavBuffer) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY is not set on the server.');

  const boundary = '----QFworkVoice' + Date.now().toString(16) + Math.random().toString(16).slice(2);
  const field = (name, value) =>
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  const parts = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
    wavBuffer,
    Buffer.from('\r\n'),
    field('model', 'whisper-large-v3-turbo'),
    field('response_format', 'verbose_json'),
    field('timestamp_granularities[]', 'word'),
    field('timestamp_granularities[]', 'segment'),
    field('language', 'en'),
    field('temperature', '0'),
    Buffer.from(`--${boundary}--\r\n`)
  ];
  const body = Buffer.concat(parts);

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 45000);
  let r;
  try {
    r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body,
      signal: ctrl.signal
    });
  } finally {
    clearTimeout(to);
  }
  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    throw new Error(`Groq STT failed (${r.status}): ${errText.slice(0, 300)}`);
  }
  return r.json(); // { text, segments:[{start,end,text,avg_logprob,no_speech_prob,…}], words:[{word,start,end}] }
}

// ────────────────────────────────────────────────────────────
// Delivery timing from word timestamps
// ────────────────────────────────────────────────────────────
const FILLER_RE = /^(um+|uh+|uhm+|er+|erm+|hm+|hmm+|mm+|ah+|eh+)$/i;
const TURN_GAP_SEC = 1.8;   // silence longer than this = a turn boundary (AI talking / thinking)
const HESITATION_MIN = 0.35; // mid-utterance pause range counted as hesitation

function computeDelivery(whisper) {
  const words = Array.isArray(whisper.words) ? whisper.words.filter(w => Number.isFinite(w.start) && Number.isFinite(w.end)) : [];
  if (words.length < 5) return null;

  // Group words into utterances (speaking turns) split on long gaps
  const utterances = [[words[0]]];
  const hesitations = [];
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end;
    if (gap > TURN_GAP_SEC) utterances.push([words[i]]);
    else {
      utterances[utterances.length - 1].push(words[i]);
      if (gap >= HESITATION_MIN) hesitations.push(gap);
    }
  }

  const totalWords = words.length;
  let speakingTime = 0;
  for (const u of utterances) speakingTime += Math.max(0.3, u[u.length - 1].end - u[0].start);
  const articulationWpm = Math.round(totalWords / (speakingTime / 60));
  const speakingMinutes = speakingTime / 60;

  const fillerCount = words.filter(w => FILLER_RE.test(String(w.word || '').replace(/[^a-z]/gi, ''))).length;

  // Clarity from segment confidence (duration-weighted mean avg_logprob)
  const segs = (Array.isArray(whisper.segments) ? whisper.segments : [])
    .filter(s => Number.isFinite(s.avg_logprob) && (s.no_speech_prob == null || s.no_speech_prob < 0.6));
  let clarity = null;
  if (segs.length) {
    let wSum = 0, lpSum = 0, lowDur = 0, totDur = 0;
    for (const s of segs) {
      const dur = Math.max(0.2, (s.end || 0) - (s.start || 0));
      wSum += dur; lpSum += s.avg_logprob * dur;
      totDur += dur;
      if (s.avg_logprob < -0.6) lowDur += dur;
    }
    const avgLp = lpSum / wSum;
    const score = Math.max(5, Math.min(99, Math.round((1 + avgLp) * 100)));
    clarity = {
      score,
      label: score >= 85 ? 'crisp' : score >= 70 ? 'clear' : score >= 55 ? 'mostly clear' : score >= 40 ? 'uneven' : 'unclear',
      lowConfidenceShare: round2(lowDur / totDur)
    };
  }

  return {
    totalWords,
    speakingTurns:       utterances.length,
    speakingTimeSeconds: round1(speakingTime),
    articulationWpm,
    hesitationCount:     hesitations.length,
    hesitationsPerMin:   round1(hesitations.length / Math.max(0.25, speakingMinutes)),
    avgHesitationSec:    hesitations.length ? round2(hesitations.reduce((a, b) => a + b, 0) / hesitations.length) : 0,
    longestHesitationSec: hesitations.length ? round2(Math.max(...hesitations)) : 0,
    fillerCount,
    clarity
  };
}

// ────────────────────────────────────────────────────────────
// Human-readable measurement lines for the coaching LLM prompt
// ────────────────────────────────────────────────────────────
function summarizeForPrompt(m) {
  const lines = [];
  if (m.prosody && !m.prosody.insufficientSpeech) {
    lines.push(`Recording length: ${m.prosody.durationSeconds}s; the candidate was audibly speaking for ~${Math.round((m.prosody.speechRatio || 0) * 100)}% of it (the rest is listening/silence — this is a conversation, so that is normal).`);
    if (!m.prosody.insufficientPitch && m.prosody.pitchMedianHz) {
      lines.push(`Pitch: median ${m.prosody.pitchMedianHz} Hz; variability ${m.prosody.pitchVariabilitySt} semitones (std dev); working range (10th–90th pct) ${m.prosody.pitchRangeSt} semitones → intonation sounds ${m.prosody.intonationLabel}.`);
    }
    if (m.prosody.loudnessRangeDb != null) {
      lines.push(`Loudness dynamics across speech: ${m.prosody.loudnessRangeDb} dB (10th–90th pct) → ${m.prosody.energyLabel || 'n/a'} vocal energy.`);
    }
  }
  if (m.timing) {
    const t = m.timing;
    lines.push(`Speech timing: ${t.totalWords} words across ${t.speakingTurns} speaking turn(s), ${t.speakingTimeSeconds}s of active speech → articulation rate ≈ ${t.articulationWpm} words/min.`);
    lines.push(`Hesitation pauses (${HESITATION_MIN}–${TURN_GAP_SEC}s mid-utterance): ${t.hesitationCount} total (≈${t.hesitationsPerMin}/min of speech), average ${t.avgHesitationSec}s, longest ${t.longestHesitationSec}s.`);
    if (t.fillerCount) lines.push(`Audible fillers (um/uh/er…) detected in the audio timing: ${t.fillerCount}.`);
    if (t.clarity) lines.push(`Articulation clarity score (from the speech recogniser's confidence in what it heard): ${t.clarity.score}/100 — ${t.clarity.label}${t.clarity.lowConfidenceShare > 0.15 ? ` (${Math.round(t.clarity.lowConfidenceShare * 100)}% of speech was hard for the recogniser to make out)` : ''}.`);
  }
  return lines;
}

// Compact stats for the feedback UI chips
function statsForUi(m) {
  const s = {};
  if (m.timing) {
    s.wpm = m.timing.articulationWpm;
    s.hesitationsPerMin = m.timing.hesitationsPerMin;
    if (m.timing.clarity) { s.clarityScore = m.timing.clarity.score; s.clarityLabel = m.timing.clarity.label; }
  }
  if (m.prosody && m.prosody.pitchVariabilitySt != null) {
    s.pitchVariabilitySt = m.prosody.pitchVariabilitySt;
    s.intonationLabel = m.prosody.intonationLabel;
    s.energyLabel = m.prosody.energyLabel;
  }
  return Object.keys(s).length ? s : null;
}

// ────────────────────────────────────────────────────────────
// Main entry: WAV buffer → full metrics (never throws for a
// recoverable sub-failure; throws only if the WAV is unusable)
// ────────────────────────────────────────────────────────────
async function analyzeVoice(wavBuffer) {
  const { samples, sampleRate } = parseWav(wavBuffer);
  const durationSeconds = samples.length / sampleRate;
  if (durationSeconds < 3) throw new Error(`Recording too short to analyse (${durationSeconds.toFixed(1)}s).`);

  const metrics = { prosody: null, timing: null, whisperText: '', errors: [] };

  try {
    metrics.prosody = computeAcoustics(samples, sampleRate);
  } catch (e) {
    metrics.errors.push(`acoustics: ${e.message}`);
  }

  try {
    // Normalise to 16 kHz for the upload if the browser recorded at a higher rate.
    let whisperWav = wavBuffer;
    if (sampleRate > 16000) {
      const ds = decimate(samples, sampleRate, 16000);
      whisperWav = encodeWavBuffer(ds.samples, Math.round(ds.rate));
    }
    const whisper = await transcribeWithTimestamps(whisperWav);
    metrics.whisperText = String(whisper.text || '').trim();
    metrics.timing = computeDelivery(whisper);
  } catch (e) {
    metrics.errors.push(`whisper: ${e.message}`);
  }

  metrics.promptLines = summarizeForPrompt(metrics);
  metrics.uiStats = statsForUi(metrics);
  return metrics;
}

module.exports = { analyzeVoice, parseWav, computeAcoustics, computeDelivery, transcribeWithTimestamps };
