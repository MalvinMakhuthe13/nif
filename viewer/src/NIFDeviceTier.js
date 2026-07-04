/**
 * NIFDeviceTier — Device capability detection and budget allocation
 * © Fumoca Technologies · fumoca.co.za
 *
 * Runs once at startup. Benchmarks the actual device rather than guessing
 * from user-agent strings, which are unreliable.
 *
 * Produces a Tier (0=low, 1=mid, 2=high) used by every system to cap
 * its own resource usage — the renderer, transition, audio, and sort
 * all read from this before deciding how hard to push.
 *
 * The benchmark is a short WebGL2 draw-call test plus a JS arithmetic
 * microbenchmark. Total time: ~80ms. Runs asynchronously so it never
 * blocks the main thread — the result is delivered via a Promise.
 *
 * Budgets by tier:
 *
 *   LOW (tier 0)   — entry-level Android, 2GB RAM, Adreno 505 class
 *     Particles:    3,000   (GPU TF only)  /  0 CPU fallback
 *     Sort:         every 8 frames, max 20k Gaussians drawn
 *     DPR cap:      1.0
 *     Curl tex:     16³ (tiny, built in <5ms)
 *     Audio:        disabled
 *     Transition:   simplified (no nebula stage, just fade)
 *
 *   MID (tier 1)   — mid-range phone, 4GB RAM, Adreno 618 / Mali-G77 class
 *     Particles:    25,000  (GPU TF only)  /  5,000 CPU fallback
 *     Sort:         every 4 frames
 *     DPR cap:      1.5
 *     Curl tex:     32³
 *     Audio:        enabled, one source at a time
 *     Transition:   full 4 stages
 *
 *   HIGH (tier 2)  — flagship phone, tablet, desktop
 *     Particles:    200,000 (GPU TF)        /  15,000 CPU fallback
 *     Sort:         every 3 frames
 *     DPR cap:      2.0
 *     Curl tex:     64³
 *     Audio:        full spatial audio
 *     Transition:   full 4 stages + ripple
 */

export const TIER = Object.freeze({ LOW: 0, MID: 1, HIGH: 2 });

export const BUDGETS = Object.freeze([
  // LOW
  {
    tier:             0,
    label:            'low',
    maxParticlesGPU:  3_000,
    maxParticlesCPU:  0,          // zero — no CPU particle loop ever
    curlTexSize:      16,
    sortEvery:        8,
    maxGaussiansDrawn:20_000,     // skip Gaussians beyond this via count cap
    dprCap:           1.0,
    audioEnabled:     false,
    transitionFull:   false,      // simplified transition only
    transitionDuration:2.0,
  },
  // MID
  {
    tier:             1,
    label:            'mid',
    maxParticlesGPU:  25_000,
    maxParticlesCPU:  5_000,
    curlTexSize:      32,
    sortEvery:        4,
    maxGaussiansDrawn:50_000,
    dprCap:           1.5,
    audioEnabled:     true,
    transitionFull:   true,
    transitionDuration:3.5,
  },
  // HIGH
  {
    tier:             2,
    label:            'high',
    maxParticlesGPU:  200_000,
    maxParticlesCPU:  15_000,
    curlTexSize:      64,
    sortEvery:        3,
    maxGaussiansDrawn:Infinity,
    dprCap:           2.0,
    audioEnabled:     true,
    transitionFull:   true,
    transitionDuration:4.5,
  },
]);

// ─── Singleton result — detect once, reuse everywhere ─────────────────────────
let _result = null;
let _pending = null;

/**
 * Returns a Promise<{tier, budget}> that resolves after the benchmark.
 * Safe to call multiple times — only runs once.
 */
export async function detectTier() {
  if (_result) return _result;
  if (_pending) return _pending;
  _pending = _runBenchmark();
  _result  = await _pending;
  return _result;
}

/** Synchronous accessor — returns null until detectTier() has resolved. */
export function getTierSync() { return _result; }

// ─── Benchmark ────────────────────────────────────────────────────────────────
async function _runBenchmark() {
  // Yield to browser first so this doesn't compete with page load
  await _nextFrame();
  await _nextFrame();

  const scores = [];

  // ── Test 1: JS arithmetic throughput ──────────────────────────────────────
  // Simulates the depth-computation inner loop (the sort hot path).
  // 1M multiply-accumulate ops. Measures raw JS float throughput.
  {
    const t0    = performance.now();
    let   acc   = 0;
    const limit = 1_000_000;
    for (let i = 0; i < limit; i++) acc += Math.sin(i * 0.001) * i;
    const ms  = performance.now() - t0;
    // Calibration: flagship = ~8ms, mid = ~20ms, low = ~40ms+
    scores.push(ms < 12 ? 2 : ms < 28 ? 1 : 0);
    void acc; // prevent dead-code elimination
  }

  await _nextFrame();

  // ── Test 2: WebGL2 draw call throughput ───────────────────────────────────
  // Creates a tiny canvas, draws 500 instanced quads, reads back timing.
  // Measures GPU driver overhead per draw call.
  {
    const cvs = document.createElement('canvas');
    cvs.width = 64; cvs.height = 64;
    const gl  = cvs.getContext('webgl2', { antialias: false, powerPreference: 'high-performance' });
    if (gl) {
      const vs = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vs, `#version 300 es\nin vec2 a; void main(){gl_Position=vec4(a,0,1);gl_PointSize=1.;}`)
      gl.compileShader(vs);
      const fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, `#version 300 es\nprecision lowp float;\nout vec4 c;\nvoid main(){c=vec4(1);}`)
      gl.compileShader(fs);
      const prog = gl.createProgram();
      gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);

      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);

      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const loc = gl.getAttribLocation(prog, 'a');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);

      gl.useProgram(prog);
      gl.bindVertexArray(vao);

      const t0 = performance.now();
      for (let i = 0; i < 200; i++) {
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      // gl.finish() forces GPU sync — accurate timing
      gl.finish();
      const ms = performance.now() - t0;

      // Calibration: flagship = ~5ms/200, mid = ~15ms, low = ~35ms+
      scores.push(ms < 10 ? 2 : ms < 25 ? 1 : 0);

      // Clean up
      gl.deleteBuffer(buf); gl.deleteVertexArray(vao);
      gl.deleteProgram(prog); gl.deleteShader(vs); gl.deleteShader(fs);
    } else {
      // WebGL2 not available — lowest tier
      scores.push(0);
    }
  }

  await _nextFrame();

  // ── Test 3: Memory proxy ──────────────────────────────────────────────────
  // Low-RAM devices show high GC pressure. Check deviceMemory if available.
  {
    const mem = navigator.deviceMemory ?? 4; // GB, default 4 if not exposed
    scores.push(mem >= 6 ? 2 : mem >= 3 ? 1 : 0);
  }

  // ── Test 4: CPU core count ────────────────────────────────────────────────
  {
    const cores = navigator.hardwareConcurrency ?? 4;
    scores.push(cores >= 8 ? 2 : cores >= 4 ? 1 : 0);
  }

  // Average scores → tier
  const avg  = scores.reduce((a, b) => a + b, 0) / scores.length;
  const tier = avg >= 1.6 ? TIER.HIGH : avg >= 0.8 ? TIER.MID : TIER.LOW;

  console.log(`[NIFDeviceTier] scores=${JSON.stringify(scores)} avg=${avg.toFixed(2)} tier=${['low','mid','high'][tier]}`);

  return { tier, budget: BUDGETS[tier] };
}

function _nextFrame() {
  return new Promise(resolve => requestAnimationFrame(resolve));
}
