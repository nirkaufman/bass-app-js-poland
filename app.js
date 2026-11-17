/**
 * app.js — main-thread orchestration: Web Audio routing, AudioWorklet
 * lifecycle, telemetry HUD, and the Three.js/GLSL reactive scene.
 */
(() => {
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  function freqToNote(freq) {
    const midi = Math.round(69 + 12 * Math.log2(freq / 440));
    return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
  }

  // ---------------------------------------------------------------------
  // DOM references
  // ---------------------------------------------------------------------
  const container = document.getElementById('canvas-container');
  const controls = document.getElementById('controls');
  const startBtn = document.getElementById('start-btn');
  const errorMsg = document.getElementById('error-msg');
  const statusEl = document.getElementById('status');
  const statusText = document.getElementById('status-text');
  const noteDisplay = document.getElementById('note-display');
  const freqDisplay = document.getElementById('freq-display');
  const rmsDisplay = document.getElementById('rms-display');
  const fpsDisplay = document.getElementById('fps-display');
  const latencyDisplay = document.getElementById('latency-display');

  // ---------------------------------------------------------------------
  // Three.js scene
  // ---------------------------------------------------------------------
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );
  camera.position.z = 3.5;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  // The only data that crosses from JavaScript to the GPU: four floats per frame.
  const uniforms = {
    uTime: { value: 0 },
    uLevel: { value: 0 }, // loudness: smoothed RMS
    uPunch: { value: 0 }, // slap: jumps to 1 on a transient, decays to 0
    uHue: { value: 0.5 }, // pitch: one octave = one trip around the color wheel
  };

  // Runs once per vertex, every frame, in parallel on the GPU.
  const vertexShader = `
    uniform float uTime;
    uniform float uLevel;
    uniform float uPunch;
    varying vec3 vNormal;

    void main() {
      vNormal = normal;
      float displacement = sin(position.y * 6.0 + uTime * 3.0) * uLevel;
      displacement += uPunch * 0.4 * abs(sin(position.x * 8.0) * sin(position.z * 8.0));
      vec3 newPosition = position + normal * displacement;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(newPosition, 1.0);
    }
  `;

  // Runs once per pixel the mesh covers, every frame.
  const fragmentShader = `
    uniform float uHue;
    uniform float uLevel;
    uniform float uPunch;
    varying vec3 vNormal;

    vec3 hsv2rgb(vec3 c) {
      vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
      vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
      return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
    }

    void main() {
      vec3 color = hsv2rgb(vec3(uHue, 0.85, 0.9));
      float rim = 1.0 - max(dot(vNormal, vec3(0.0, 0.0, 1.0)), 0.0);
      color += vec3(rim * (0.3 + uLevel * 0.8));
      color = mix(color, vec3(1.0), uPunch * 0.5);
      gl_FragColor = vec4(color, 1.0);
    }
  `;

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms,
    wireframe: true,
  });

  const geometry = new THREE.IcosahedronGeometry(1.4, 32);
  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ---------------------------------------------------------------------
  // Audio pipeline
  // ---------------------------------------------------------------------
  const LEVEL_GAIN = 1.5; // RMS → displacement; tune at soundcheck to your input gain

  let audioCtx = null;
  let telemetry = { freq: -1, rms: 0 }; // latest message from the audio thread
  let punch = 0;
  let targetHue = 0.5;

  // Live input by default; `?track=groove.wav` plays a recording through the
  // exact same worklet (the on-stage fallback if the interface misbehaves).
  async function createSource() {
    const track = new URLSearchParams(location.search).get('track');
    if (track) {
      const audio = new Audio(track);
      audio.loop = true;
      await audio.play();
      return audioCtx.createMediaElementSource(audio);
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        latency: 0,
      },
    });
    return audioCtx.createMediaStreamSource(stream);
  }

  async function initAudio() {
    audioCtx = new AudioContext({ latencyHint: 'interactive' });
    await audioCtx.audioWorklet.addModule('bass-processor.js');

    const source = await createSource();
    // Mono out: the bass (interface input 1) plays on both speakers.
    const dspNode = new AudioWorkletNode(audioCtx, 'bass-processor', {
      outputChannelCount: [1],
    });

    // ~94 messages/s arrive here. Store them; the render loop draws.
    dspNode.port.onmessage = ({ data }) => {
      telemetry = data;
      if (data.isTransient) punch = 1;
      if (data.freq > 0) targetHue = Math.log2(data.freq / 16.35) % 1; // C = red
    };

    // Direct low-latency monitor path — no extra processing on the way out.
    source.connect(dspNode);
    dspNode.connect(audioCtx.destination);
  }

  function setStatus(state, label) {
    statusText.textContent = label;
    statusEl.className = state;
  }

  startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    errorMsg.style.display = 'none';
    setStatus('connecting', 'CONNECTING…');

    try {
      await initAudio();
      controls.style.display = 'none';
      setStatus('live', 'LIVE');
    } catch (err) {
      console.error('Failed to initialize audio pipeline:', err);
      errorMsg.textContent = `Audio init failed: ${err.message}`;
      errorMsg.style.display = 'block';
      startBtn.disabled = false;
      setStatus('idle', 'IDLE');
    }
  });

  // Press J: block the main thread for 3 s. The visuals freeze; the bass
  // keeps sounding, because the audio thread never waits for this one.
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'j' || !audioCtx) return;
    setStatus('blocked', 'MAIN THREAD BLOCKED');
    setTimeout(() => {
      const end = performance.now() + 3000;
      while (performance.now() < end); // busy-wait: no frames, no events
      setStatus('live', 'LIVE');
    }, 50);
  });

  // ---------------------------------------------------------------------
  // Render loop (60 FPS — or whatever the display runs at)
  // ---------------------------------------------------------------------
  const clock = new THREE.Clock();
  let level = 0;
  let hue = 0.5;
  let frames = 0;
  let fpsTimer = 0;

  function updateHud(dt) {
    if (telemetry.freq > 0) {
      noteDisplay.textContent = freqToNote(telemetry.freq);
      freqDisplay.textContent = `${telemetry.freq.toFixed(1)} Hz`;
    }
    rmsDisplay.textContent = telemetry.rms.toFixed(3);

    frames++;
    fpsTimer += dt;
    if (fpsTimer >= 0.5) {
      fpsDisplay.textContent = Math.round(frames / fpsTimer);
      if (audioCtx) {
        const latency = audioCtx.baseLatency + (audioCtx.outputLatency || 0);
        latencyDisplay.textContent = `${(latency * 1000).toFixed(1)} ms`;
      }
      frames = 0;
      fpsTimer = 0;
    }
  }

  function animate() {
    requestAnimationFrame(animate);
    const dt = clock.getDelta();

    // Exponential smoothing in seconds, not frames: identical at 60 or 120 Hz.
    level += (telemetry.rms * LEVEL_GAIN - level) * (1 - Math.exp(-dt * 10));
    const hueStep = targetHue - hue;
    hue += (hueStep - Math.round(hueStep)) * (1 - Math.exp(-dt * 6)); // short way round the wheel
    punch *= Math.exp(-dt * 8);

    uniforms.uTime.value = clock.elapsedTime;
    uniforms.uLevel.value = level;
    uniforms.uPunch.value = punch;
    uniforms.uHue.value = hue;

    mesh.rotation.y = clock.elapsedTime * 0.25;
    mesh.rotation.x = clock.elapsedTime * 0.15;

    updateHud(dt);
    renderer.render(scene, camera);
  }

  animate();
})();
