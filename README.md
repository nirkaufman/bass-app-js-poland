# The 60 FPS Slap: Real-Time Bass DSP & Shaders in JavaScript

A browser demo that takes a live electric bass signal and analyzes pitch, dynamics and slaps off
the main thread in an `AudioWorklet`. It drives a reactive Three.js/GLSL scene at display rate.
No build step, no framework, one library.

## Architecture

```
Bass guitar → USB audio interface (input 1)
        │
        ▼
getUserMedia            (raw stream: echo cancellation / noise suppression / AGC off)
        │
        ▼
AudioWorkletNode "bass-processor"         ── audio rendering thread, 128 samples per call
        ├── output[0] ← input                  direct monitor → speakers
        ├── running RMS (30 ms)                dynamics
        ├── ΔRMS > threshold                   slap / transient
        └── low-pass → 12 kHz → 1024 ring      McLeod pitch detection, 25–400 Hz
                │
                ▼ port.postMessage  (~94 Hz)
Main thread: store latest → requestAnimationFrame
        ├── uLevel  ← RMS          vertex shader: ripple along the normal
        ├── uPunch  ← transient    vertex shader: spikes · fragment shader: white flash
        └── uHue    ← pitch        fragment shader: one octave = one trip round the color wheel
```

## Files

- `index.html`: app shell, canvas, telemetry HUD
- `app.js`: Web Audio graph, worklet wiring, Three.js scene, shaders, render loop
- `bass-processor.js`: the `AudioWorkletProcessor` (ring buffer, pitch, RMS, transients)

## Running

`getUserMedia` and `AudioWorklet` need a secure context. `localhost` works, `file://` doesn't.

```bash
python3 -m http.server 8000
```

Open `http://localhost:8000` in Chrome, then click **ENGAGE AUDIO WORKLET** (or press Space).

- **No bass?** `http://localhost:8000/?track=your-recording.m4a` plays any audio file (served from
  this folder) through the same worklet.
- **J** blocks the main thread for 3 seconds. The visuals freeze. The audio doesn't.

## Using it

1. Plug the bass into input 1 of a USB audio interface. Turn the interface's direct monitoring
   **off**, so what you hear is coming from the browser.
2. Pick the interface as the input in Chrome's site settings (or as the macOS default input).
3. Play. The HUD shows note, frequency, RMS, FPS and output latency.

## Notes on the DSP

- **Pitch:** the McLeod pitch method, i.e. normalized autocorrelation that picks the *first*
  strong peak, not the biggest. Slap harmonics are often louder than the fundamental, and
  picking the biggest peak reports an octave too low. Parabolic interpolation gives sub-sample
  precision. In a synthetic test harness, every note from B0 to C4 was identified, within a
  cent on clean tones.
- **Why decimate:** bass fundamentals sit below 400 Hz. Low-passing and keeping every 4th sample
  makes the autocorrelation ~16× cheaper (~0.5 ms per run). The 85 ms window still holds 2.6
  periods of Low B.
- **Why not an FFT:** a 2048-point FFT at 48 kHz has 23.4 Hz bins. The E and A strings
  (41.2 Hz and 55 Hz) land in the same bin.
- **Physics sets the floor:** a 41 Hz note takes 24 ms to complete one cycle. Dynamics and slaps
  react within ~10 ms. Pitch needs a couple of cycles.
