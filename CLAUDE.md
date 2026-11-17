# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static, dependency-free (aside from a CDN-loaded Three.js) browser demo: it captures a live
bass guitar signal via `getUserMedia`, analyzes pitch/dynamics/transients off the main thread in
an `AudioWorklet`, and drives a reactive Three.js/GLSL scene at display rate. Built as a 20-minute
conference talk demo ("The 60 FPS Slap", JS Poland 2026).

**Talk prep:** start with `SESSION-CONTEXT.md` (decisions, state, what's verified). The script and
runbook is `talk-walkthrough.md`, and the slide copy is `slide-deck-notes.md`.

## Running it

No build step, no package.json. Serve the directory statically on a **fixed port** (Chrome
remembers the mic permission per origin, and the port is part of the origin):

```bash
python3 -m http.server 8000
```

Then visit `http://localhost:8000`. A secure context is required: `getUserMedia` and
`AudioWorklet` don't work over `file://` or plain HTTP on non-localhost origins.
`?track=<file>` plays an audio file through the same worklet instead of the live input. This is
the on-stage fallback, and it's also how to test without a bass.

There are no lint, test, or build commands.

## Stage state (live-coding)

The talk live-codes two GLSL lines in `app.js` (slap → spikes, slap → flash).

```bash
node stage.mjs start   # replace them with TODO comments (on-stage starting point)
node stage.mjs final   # restore them (finished demo)
```

These are exact-text swaps, and the script refuses to write if `app.js` drifted. **If you edit either
line, update `LIVE_EDITS` in `stage.mjs` too.** Check which state the repo is in (grep for `TODO: slap`)
before editing the shaders.

## Architecture

Three files, each with a distinct execution context. This separation is the core design and
should be preserved when editing:

- **`bass-processor.js`**: an `AudioWorkletProcessor` on the audio rendering thread
  (`AudioWorkletGlobalScope`). It has **no DOM/`window`**, and everything leaves via
  `this.port.postMessage()`. Per sample, it does three things:
  - a running RMS (exponential, 30 ms memory, longer than a Low E period, so no ripple)
  - a one-pole ~1 kHz low-pass
  - decimation to ~12 kHz into a 1024-sample ring buffer (≈85 ms, 2.6 periods of Low B)

  Every 512 input samples (~94 Hz @ 48 kHz), it posts `{ freq, rms, isTransient }`.
  `freq` comes from the McLeod pitch method: unroll the ring → NSDF over lags up to 25 Hz → the
  **first** peak ≥ 0.9 × the best one (avoids octave errors) → parabolic interpolation. It's
  gated by `NOISE_GATE` and `CLARITY`. `isTransient` means the RMS jumped by more than
  `TRANSIENT_THRESHOLD` since the last message. The input passes straight through to `output[0]`
  for monitoring.

- **`app.js`**: the main thread, loaded as a plain (non-module) script.
  - **Audio setup:** creates the `AudioContext` and gets the input. That's `getUserMedia` with
    echo cancellation, noise suppression and AGC all off, or `?track=` instead. It then
    registers the worklet and wires `source → dspNode (mono out) → destination`.
  - **Messages:** `port.onmessage` stores only the latest telemetry, sets `punch = 1` on a
    transient, and sets `targetHue = log2(freq / C0) % 1`, so one octave is one trip around the
    color wheel.
  - **Frame loop:** `requestAnimationFrame` does all drawing. It smooths with time-based
    exponentials (frame-rate independent, so it behaves the same on 120 Hz displays) and
    writes the uniforms `uTime`, `uLevel`, `uPunch` and `uHue`. It updates the HUD, including
    FPS and output latency (`baseLatency + outputLatency`).
  - **J key:** busy-blocks the main thread for 3 s, to prove the audio keeps running.
  - **Scene:** an `IcosahedronGeometry(1.4, 32)` (65,340 vertices), drawn as a wireframe
    `ShaderMaterial`.

- **`index.html`**: shell, canvas container, and the HUD (note, freq, RMS, FPS, latency). It has
  a status pill (idle, connecting, live, blocked) and an autofocused start button, so Space
  engages after a reload. Three.js r128 is a global script from cdnjs, then `app.js` loads.

## Key constraints to preserve when modifying

- `bass-processor.js` must stay DOM/`window`-free and allocation-free inside `process()`.
  Analysis currently costs ~0.5 ms per run, once every 4 render quanta (each quantum's budget is
  2.67 ms @ 48 kHz).
- Pitch range is 25–400 Hz. The bass is a **4-string in standard tuning** (E1 41.20, A1 55.00,
  D2 73.42, G2 98.00). The talk detunes the E string to B0 (30.87 Hz) for the "30 Hz" moment.
  The ring length × decimation sets the lowest resolvable pitch. Keep at least 2 periods of
  25 Hz in the window.
- Keep the direct `source → dspNode → destination` path. It's both the low-latency monitor and
  the thing the J-freeze demo proves.
- Visual tuning knobs: `LEVEL_GAIN` in `app.js` (match it to the input gain at soundcheck),
  `TRANSIENT_THRESHOLD` in `bass-processor.js`, and the `0.4` / `0.5` punch amounts in the shaders.
