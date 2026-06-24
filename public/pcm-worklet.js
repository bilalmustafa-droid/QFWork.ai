// ============================================================
// PCM capture worklet
// ------------------------------------------------------------
// Runs inside the AudioWorkletGlobalScope at the AudioContext's
// sample rate (we create the context at 24 kHz, the rate OpenAI
// Realtime expects). It accumulates mono float samples and posts
// ~100 ms chunks back to the main thread, which converts them to
// PCM16 + base64 and ships them over the WebSocket.
// ============================================================
class PCMCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = [];
    this._target = 2400; // 100 ms @ 24 kHz
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
