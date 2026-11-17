/**
 * bass-processor.js
 * AudioWorkletProcessor running on the dedicated audio rendering thread.
 * No DOM/window access here — only raw sample math and postMessage.
 */
const MIN_FREQ = 25;              // below Low B (30.87 Hz)
const MAX_FREQ = 400;             // fretted notes high up the neck
const ANALYSIS_RATE = 12000;      // bass needs no 48 kHz — decimate before analysis
const EMIT_INTERVAL = 512;        // samples between messages: ~94 Hz @ 48 kHz, faster than any display
const RMS_MEMORY = 0.03;          // seconds: longer than one period of Low E (24 ms), so no ripple
const NOISE_GATE = 0.01;          // RMS below this = silence, skip pitch detection
const TRANSIENT_THRESHOLD = 0.04; // RMS jump between messages that counts as a slap
const CLARITY = 0.6;              // how periodic the signal must be to report a pitch

class BassProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // Low-pass (one-pole, ~1 kHz) then keep every Nth sample: 48 kHz → 12 kHz.
    this.decimation = Math.round(sampleRate / ANALYSIS_RATE);
    this.rate = sampleRate / this.decimation;
    this.lowpass = 0;
    this.lowpassAlpha = 1 - Math.exp((-2 * Math.PI * 1000) / sampleRate);
    this.phase = 0;

    // 1024 samples @ 12 kHz ≈ 85 ms: 2.6 periods of Low B.
    this.ring = new Float32Array(1024);
    this.frame = new Float32Array(1024);
    this.writeIndex = 0;
    this.nsdf = new Float32Array(Math.ceil(this.rate / MIN_FREQ) + 2);

    // Running RMS: an exponential moving average of the signal's power.
    this.meanSquare = 0;
    this.rmsAlpha = 1 - Math.exp(-1 / (sampleRate * RMS_MEMORY));
    this.samplesSinceEmit = 0;
    this.previousRms = 0;
  }

  process(inputs, outputs) {
    const samples = inputs[0][0];
    if (!samples) return true;

    // Direct low-latency pass-through so the player hears themselves.
    outputs[0][0].set(samples);

    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      this.meanSquare += this.rmsAlpha * (s * s - this.meanSquare);
      this.lowpass += this.lowpassAlpha * (s - this.lowpass);
      if (++this.phase === this.decimation) {
        this.phase = 0;
        this.ring[this.writeIndex] = this.lowpass;
        this.writeIndex = (this.writeIndex + 1) % this.ring.length;
      }
    }

    this.samplesSinceEmit += samples.length;
    if (this.samplesSinceEmit >= EMIT_INTERVAL) {
      const rms = Math.sqrt(this.meanSquare);
      const isTransient = rms - this.previousRms > TRANSIENT_THRESHOLD;
      const freq = rms > NOISE_GATE ? this.detectPitch() : -1;

      this.port.postMessage({ freq, rms, isTransient });

      this.previousRms = rms;
      this.samplesSinceEmit = 0;
    }

    return true;
  }

  // McLeod pitch method: normalized autocorrelation, then the FIRST strong peak.
  // The biggest peak is often 2× the period (an octave too low) — slap
  // harmonics can be louder than the fundamental.
  detectPitch() {
    const { ring, frame, nsdf, writeIndex } = this;

    // Unroll the ring buffer: oldest sample first.
    for (let i = 0; i < frame.length; i++) {
      frame[i] = ring[(writeIndex + i) % ring.length];
    }

    // nsdf[lag] ∈ [-1, 1]: how well the wave matches itself shifted by `lag`.
    for (let lag = 0; lag < nsdf.length; lag++) {
      let acf = 0;
      let energy = 0;
      for (let i = 0; i < frame.length - lag; i++) {
        acf += frame[i] * frame[i + lag];
        energy += frame[i] * frame[i] + frame[i + lag] * frame[i + lag];
      }
      nsdf[lag] = energy > 0 ? (2 * acf) / energy : 0;
    }

    // Skip the lobe around lag 0 (every signal matches itself unshifted).
    let start = 1;
    while (start < nsdf.length && nsdf[start] > 0) start++;

    let globalMax = 0;
    for (let lag = start; lag < nsdf.length; lag++) {
      globalMax = Math.max(globalMax, nsdf[lag]);
    }
    if (globalMax < CLARITY) return -1;

    // First local maximum close to the best one = the fundamental period.
    const minLag = Math.max(start, Math.floor(this.rate / MAX_FREQ));
    for (let lag = minLag; lag < nsdf.length - 1; lag++) {
      const a = nsdf[lag - 1], b = nsdf[lag], c = nsdf[lag + 1];
      if (b >= 0.9 * globalMax && b >= a && b >= c) {
        const curve = a - 2 * b + c; // parabola through 3 points → sub-sample peak
        return this.rate / (lag + (curve ? (a - c) / (2 * curve) : 0));
      }
    }
    return -1;
  }
}

registerProcessor('bass-processor', BassProcessor);
