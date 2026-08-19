// ============================================================
// PCM capture worklet
// ------------------------------------------------------------
// Runs inside the AudioWorkletGlobalScope at the AudioContext's
// sample rate. Accumulates mono float samples and posts them to
// the main thread in fixed-size blocks, which the page assembles
// into a WAV file for the voice analysis.
// ============================================================
class PCMCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = [];
    // Block size in samples. At 16 kHz this is ~150 ms per message,
    // which keeps main-thread messaging light during a long call.
    this._target = 2400;
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const channel = input[0];
      for (let i = 0; i < channel.length; i++) this._buf.push(channel[i]);
      if (this._buf.length >= this._target) {
        this.port.postMessage(Float32Array.from(this._buf));
        this._buf = [];
      }
    }
    return true; // keep the processor alive
  }
}

registerProcessor('pcm-capture', PCMCapture);
