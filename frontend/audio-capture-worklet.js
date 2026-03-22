/**
 * Audio Capture Worklet — runs in the audio thread
 *
 * Captures mic audio at 48kHz, downsamples to 8kHz,
 * encodes to mu-law (G.711), and posts 20ms frames
 * to the main thread for transmission over libp2p.
 */

class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.FRAME_SIZE = 160; // 20ms at 8kHz = 160 samples
    this.DOWNSAMPLE_FACTOR = 6; // 48000 / 8000
    this.sampleIndex = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channel = input[0]; // Float32Array, 128 samples at 48kHz

    // Downsample by taking every Nth sample
    for (let i = 0; i < channel.length; i++) {
      this.sampleIndex++;
      if (this.sampleIndex >= this.DOWNSAMPLE_FACTOR) {
        this.sampleIndex = 0;
        const sample = Math.max(-1, Math.min(1, channel[i]));
        this.buffer.push(this.linearToMulaw(sample));
      }
    }

    // When we have a full frame, post it to main thread
    while (this.buffer.length >= this.FRAME_SIZE) {
      const frame = new Uint8Array(this.buffer.splice(0, this.FRAME_SIZE));
      this.port.postMessage(frame, [frame.buffer]);
    }

    return true;
  }

  linearToMulaw(sample) {
    // ITU-T G.711 mu-law encoding
    const MULAW_BIAS = 33;
    const sign = sample < 0 ? 0x80 : 0;
    let magnitude = Math.min(Math.abs(Math.round(sample * 32768)), 32635);
    magnitude += MULAW_BIAS;
    let exponent = 7;
    for (let expMask = 0x4000; (magnitude & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
    const mantissa = (magnitude >> (exponent + 3)) & 0x0F;
    return (~(sign | (exponent << 4) | mantissa)) & 0xFF;
  }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);
