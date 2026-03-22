/**
 * Audio Playback Worklet — runs in the audio thread
 *
 * Receives mu-law encoded audio chunks from the main thread,
 * decodes to linear PCM, upsamples from 8kHz to 48kHz,
 * and writes to the output buffer for speaker playback.
 */

class AudioPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = []; // Queue of float32 samples at 8kHz
    this.phase = 0;
    this.lastSample = 0;
    this.nextSample = 0;
    this.UPSAMPLE_FACTOR = 6; // 8kHz -> 48kHz

    this.port.onmessage = (event) => {
      const mulawBytes = new Uint8Array(event.data);
      for (let i = 0; i < mulawBytes.length; i++) {
        this.queue.push(this.mulawToLinear(mulawBytes[i]));
      }
    };
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const channel = output[0]; // 128 samples at 48kHz

    for (let i = 0; i < channel.length; i++) {
      if (this.phase >= this.UPSAMPLE_FACTOR) {
        this.phase = 0;
        this.lastSample = this.nextSample;
        this.nextSample = this.queue.length > 0 ? this.queue.shift() : this.lastSample * 0.95;
      }
      // Linear interpolation between samples for smoother audio
      const t = this.phase / this.UPSAMPLE_FACTOR;
      channel[i] = this.lastSample * (1 - t) + this.nextSample * t;
      this.phase++;
    }

    return true;
  }

  mulawToLinear(mulawByte) {
    // ITU-T G.711 mu-law decoding
    mulawByte = ~mulawByte & 0xFF;
    const sign = (mulawByte & 0x80) ? -1 : 1;
    const exponent = (mulawByte >> 4) & 0x07;
    const mantissa = mulawByte & 0x0F;
    let magnitude = ((mantissa << 3) + 0x84) << exponent;
    magnitude -= 0x84;
    return sign * magnitude / 32768.0;
  }
}

registerProcessor('audio-playback-processor', AudioPlaybackProcessor);
