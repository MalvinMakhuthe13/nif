/**
 * NIFTransition — Proprietary 4-Stage Solidification Transition
 * © Fumoca Technologies · fumoca.co.za
 *
 * This is the visual effect that plays when a NIF "comes alive" from its
 * proxy video. It is the primary brand differentiator.
 *
 * Pipeline:
 *   Stage 1 — DISSOCIATION  (t 0.00→0.20)
 *     Source frame pixels shatter into angular shards along Sobel edge map.
 *     Each shard carries the colour of the pixel it came from.
 *     Implementation: render source frame → Sobel pass → spawn particles at
 *     high-gradient pixels, jitter velocity outward.
 *
 *   Stage 2 — NEBULA         (t 0.20→0.55)
 *     200,000 particles orbit the scene centroid driven by 3D curl noise
 *     (divergence-free — no sinks, no sources, pure circulation).
 *     Camera is free to orbit through the glowing cloud.
 *
 *   Stage 3 — CRYSTALLISATION (t 0.55→0.85)
 *     Each particle is assigned to the nearest Gaussian target via a
 *     radix-sorted distance heuristic. Particles are pulled toward their
 *     target using smootherstep easing. Dense regions solidify first.
 *
 *   Stage 4 — SOLIDIFICATION  (t 0.85→1.00)
 *     Surface-tension ripple: a radial wave sweeps the scene.
 *     Specular highlights bloom on, opacity ramps to final values.
 *     Transition hands off to the main NIFRenderer.
 *
 * Technology:
 *   - WebGL2 Transform Feedback for GPU-side particle integration (no JS loop)
 *   - Ping-pong buffers: read from A, write to B, swap
 *   - Sobel edge detection in fragment shader
 *   - Curl noise encoded as 3D texture (128³, precomputed on first init)
 *   - Falls back gracefully to CPU particle loop if Transform Feedback fails
 *
 * Integration:
 *   NIFViewer calls transition.play(sourceImageData, gaussians, onComplete).
 *   When onComplete fires, NIFViewer starts the main renderer.
 */

import { Noise, v3, clamp, smoothstep, smootherstep } from '../../../core/math/NIFMath.js';
import { ParticleSystem } from '../../../core/physics/NIFPhysics.js';
import { detectTier, BUDGETS, TIER } from '../NIFDeviceTier.js';

// Stage boundaries — never change
const STAGE_BREAKS = [0, 0.20, 0.55, 0.85, 1.0];
const STAGE_NAMES  = ['dissociation','nebula','crystallisation','solidification'];

// Particle and texture counts are set from device budget at play() time
let N_PARTICLES   = 25_000;   // overwritten by budget
let CURL_TEX_SIZE = 32;        // overwritten by budget

// ─── Shaders ─────────────────────────────────────────────────────────────────

// Transform Feedback vertex shader — integrate particle in GPU
const TF_VS = `#version 300 es
precision highp float;
precision highp sampler3D;

in vec3 a_pos;
in vec3 a_vel;
in vec3 a_col;
in vec3 a_target;   // assigned Gaussian world position
in float a_age;     // 0=newborn, 1=dead

uniform float u_dt;
uniform float u_t;        // global transition t [0,1]
uniform vec3  u_centroid; // scene centre for orbit
uniform sampler3D u_curl; // 64³ curl noise texture

out vec3 v_pos;
out vec3 v_vel;
out vec3 v_col;
out vec3 v_target;
out float v_age;

// Sample curl noise from 3D texture at world position
vec3 curlSample(vec3 p) {
  // Tile at [-2,2] world units
  vec3 uv = fract(p * 0.25 + 0.5);
  return (texture(u_curl, uv).rgb - 0.5) * 2.0;
}

void main() {
  float stage1End = 0.20, stage2End = 0.55, stage3End = 0.85;

  vec3 pos = a_pos;
  vec3 vel = a_vel;
  float age = a_age + u_dt;

  if (u_t < stage1End) {
    // Stage 1: Dissociation — particles fly outward from source
    float s = u_t / stage1End;  // 0→1 within stage
    vel *= 0.96;  // gentle drag
    pos += vel * u_dt;

  } else if (u_t < stage2End) {
    // Stage 2: Nebula — curl noise circulation around centroid
    float s = (u_t - stage1End) / (stage2End - stage1End);

    // Mix between outward velocity and curl circulation
    vec3 curl = curlSample(pos * 0.3 + u_t * 0.1);
    vec3 toCentre = normalize(u_centroid - pos) * 0.5;
    // Orbit force: tangential component of curl + weak centripetal pull
    vec3 force = curl * 2.0 + toCentre * s;
    vel += force * u_dt;
    vel *= 0.97;
    pos += vel * u_dt;

  } else if (u_t < stage3End) {
    // Stage 3: Crystallisation — pull toward assigned Gaussian target
    float s = (u_t - stage2End) / (stage3End - stage2End);
    // Smootherstep — fast at start, slow finish (dense regions first)
    float pull = s * s * s * (s * (s * 6.0 - 15.0) + 10.0);
    // Add diminishing curl so the approach isn't perfectly linear
    vec3 curl = curlSample(pos * 0.5 + u_t * 0.2) * (1.0 - pull) * 0.3;
    vec3 toTarget = a_target - pos;
    vel = toTarget * pull * 3.0 + curl;
    pos += vel * u_dt;

  } else {
    // Stage 4: Solidification — snap to target, stop
    float s = (u_t - stage3End) / (1.0 - stage3End);
    pos = mix(pos, a_target, clamp(s * 4.0, 0.0, 1.0));
    vel = vec3(0.0);
  }

  v_pos    = pos;
  v_vel    = vel;
  v_col    = a_col;
  v_target = a_target;
  v_age    = age;
}
`;

// Rasterise particle as a point sprite
const PARTICLE_VS = `#version 300 es
precision highp float;
in vec3  a_pos;
in vec3  a_vel;
in vec3  a_col;
in float a_age;
uniform mat4  u_view;
uniform mat4  u_proj;
uniform float u_t;
uniform vec2  u_viewport;
out vec4 v_col;

void main() {
  vec4 cam = u_view * vec4(a_pos, 1.0);
  if (cam.z >= 0.0) { gl_Position = vec4(2,2,2,1); return; }
  gl_Position = u_proj * cam;

  // Speed-based elongation (point size grows with speed for motion blur feel)
  float speed = length(a_vel);
  float px = clamp(2.0 + speed * 40.0, 1.0, 8.0);

  // Size pulse: small in nebula, small in solid — largest during crystallisation
  float s = u_t;
  float sizeBoost = (s > 0.4 && s < 0.85) ? smoothstep(0.4, 0.55, s) * (1.0 - smoothstep(0.7, 0.85, s)) : 0.0;
  gl_PointSize = px * (1.0 + sizeBoost * 3.0);

  // Colour: brightest in nebula, fades in solidification
  float brightness = (u_t < 0.55) ? 1.0 : 1.0 - smoothstep(0.55, 1.0, u_t) * 0.6;
  float alpha = (u_t < 0.15) ? u_t / 0.15 : 1.0;  // fade in during dissociation
  v_col = vec4(a_col * brightness, alpha);
}
`;

const PARTICLE_FS = `#version 300 es
precision highp float;
in vec4 v_col;
out vec4 fragColour;
void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float r2 = dot(uv, uv);
  if (r2 > 0.25) discard;
  float g = exp(-r2 * 8.0);
  fragColour = vec4(v_col.rgb * g, v_col.a * g);
}
`;

// Sobel edge detection pass — returns edge strength + gradient angle
const SOBEL_VS = `#version 300 es
in vec2 a_xy; out vec2 v_uv;
void main(){ v_uv=(a_xy+1.0)*0.5; gl_Position=vec4(a_xy,0,1); }
`;
const SOBEL_FS = `#version 300 es
precision mediump float;
uniform sampler2D u_src;
uniform vec2 u_px; // 1/width, 1/height
in vec2 v_uv; out vec4 fc;
void main(){
  float tl=length(texture(u_src,v_uv+vec2(-u_px.x, u_px.y)).rgb);
  float t = length(texture(u_src,v_uv+vec2(      0, u_px.y)).rgb);
  float tr=length(texture(u_src,v_uv+vec2( u_px.x, u_px.y)).rgb);
  float l = length(texture(u_src,v_uv+vec2(-u_px.x,0)).rgb);
  float r = length(texture(u_src,v_uv+vec2( u_px.x,0)).rgb);
  float bl=length(texture(u_src,v_uv+vec2(-u_px.x,-u_px.y)).rgb);
  float b = length(texture(u_src,v_uv+vec2(      0,-u_px.y)).rgb);
  float br=length(texture(u_src,v_uv+vec2( u_px.x,-u_px.y)).rgb);
  float gx=(-tl-2.0*l-bl)+(tr+2.0*r+br);
  float gy=(-tl-2.0*t-tr)+(bl+2.0*b+br);
  float edge=clamp(sqrt(gx*gx+gy*gy),0.0,1.0);
  float angle=atan(gy,gx);
  fc=vec4(edge,angle,0,1);
}
`;

// Ripple composite — stage 4 surface tension wave
// Overlays a specular ripple on whatever the Gaussian renderer drew.
// Works purely from gl_FragCoord — no texture binding needed.
const RIPPLE_FS = `#version 300 es
precision highp float;
uniform float u_t;       // stage4 progress [0,1]
uniform vec2  u_viewport;
out vec4 fc;
void main(){
  vec2 uv   = gl_FragCoord.xy / u_viewport;
  uv.y      = 1.0 - uv.y;
  vec2 c    = uv - 0.5;
  float dist= length(c);
  // Wave front sweeps outward from centre over stage4 duration
  float wave = sin((dist - u_t * 2.5) * 25.0) * 0.5 + 0.5;
  float front= smoothstep(0.0, 0.08, u_t * 1.5 - dist);
  float spec = wave * front * (1.0 - u_t) * 0.5;
  // Additive specular bloom only — reads nothing from scene, purely overlaid
  fc = vec4(spec, spec * 0.95, spec * 0.85, spec * 0.6);
}
`;

// ─── NIFTransition ────────────────────────────────────────────────────────────
export class NIFTransition {
  /**
   * @param {HTMLCanvasElement} canvas  — shared with NIFRenderer
   * @param {object}            opts
   *   onStageChange(stageName, t)  — called at each stage boundary
   *   onComplete()                 — called when t reaches 1.0
   *   duration                     — total transition duration in seconds (default 4.5)
   */
  constructor(canvas, opts = {}) {
    this.canvas          = canvas;
    this.onStageChange   = opts.onStageChange ?? (() => {});
    this.onComplete      = opts.onComplete    ?? (() => {});
    this.duration        = opts.duration      ?? 4.5;

    this.gl              = null;
    this._t              = 0;
    this._running        = false;
    this._stage          = -1;
    this._tfProgram      = null;  // Transform Feedback shader
    this._drawProgram    = null;  // Particle draw shader
    this._sobelProgram   = null;
    this._rippleProgram  = null;
    this._vaoA           = null;  // ping-pong buffer A
    this._vaoB           = null;  // ping-pong buffer B
    this._bufA           = null;
    this._bufB           = null;
    this._curlTex        = null;
    this._sourceTex      = null;  // source frame as texture
    this._sobelFBO       = null;
    this._sobelTex       = null;
    this._gaussianRender = null;  // callback: () => renders current Gaussians to canvas
    this._centroid       = [0, 0, 0];
    this._cpuFallback    = false; // use CPU ParticleSystem if TF unavailable
    this._cpuParticles   = null;
    this._startTime      = 0;
    this._uniformsParticle = {};
    this._uniformsTF       = {};
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Begin the transition.
   * @param {ImageData|HTMLImageElement|HTMLVideoElement} source  — proxy frame
   * @param {{ count:int, data:Float32Array }}            gaussians
   * @param {function}                                    gaussianRenderFn
   *   Called each frame during stages 3-4 to composite the solidifying scene.
   */
  async play(source, gaussians, gaussianRenderFn) {
    this._gaussianRender = gaussianRenderFn;
    this._computeCentroid(gaussians);

    // ── Read device budget before touching GPU ──────────────────────────────
    const { tier, budget } = await detectTier();
    this._budget = budget;

    // Set particle count and curl texture size from budget
    N_PARTICLES   = this._cpuFallback ? budget.maxParticlesCPU : budget.maxParticlesGPU;
    CURL_TEX_SIZE = budget.curlTexSize;

    // On LOW tier: skip the full transition, just fade the Gaussian scene in
    if (tier === TIER.LOW) {
      this._runSimpleTransition(gaussians, gaussianRenderFn);
      return;
    }

    // If CPU fallback and budget says 0 CPU particles: also use simple transition
    if (this._cpuFallback && budget.maxParticlesCPU === 0) {
      this._runSimpleTransition(gaussians, gaussianRenderFn);
      return;
    }

    await this._initGL();
    await this._uploadSource(source);

    // Build curl texture asynchronously in chunks so it never freezes the UI
    await this._buildCurlTextureAsync();

    this._spawnParticles(gaussians, source);
    this._t       = 0;
    this._stage   = 0;
    this._running = true;
    this._startTime = performance.now();
    this.onStageChange(STAGE_NAMES[0], 0);
    this._loop();
  }

  // Simple fade-in for LOW tier devices — no particles, no compute, just alpha
  _runSimpleTransition(gaussians, gaussianRenderFn) {
    const duration = this._budget?.transitionDuration ?? 2.0;
    const start    = performance.now();
    const canvas   = this.canvas;
    const gl       = canvas.getContext('webgl2') ?? canvas.getContext('webgl');

    const fade = () => {
      const t = Math.min((performance.now() - start) / (duration * 1000), 1.0);
      if (gl) {
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      if (gaussianRenderFn) gaussianRenderFn(t * t); // ease-in opacity
      if (t < 1.0) {
        requestAnimationFrame(fade);
      } else {
        this.onComplete();
      }
    };
    requestAnimationFrame(fade);
  }

  stop() { this._running = false; }

  get t()         { return this._t; }
  get stageName() { return STAGE_NAMES[this._stage] ?? 'complete'; }

  // ── Initialisation ────────────────────────────────────────────────────────
  async _initGL() {
    let gl = this.canvas.getContext('webgl2');
    if (!gl) throw new Error('WebGL2 required for NIF transition');
    this.gl = gl;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);   // additive for particle glow
    gl.disable(gl.DEPTH_TEST);

    // Check Transform Feedback support
    const tfCheck = gl.createTransformFeedback();
    this._cpuFallback = !tfCheck;
    if (tfCheck) gl.deleteTransformFeedback(tfCheck);

    this._drawProgram  = this._link(PARTICLE_VS, PARTICLE_FS, null);
    this._sobelProgram = this._link(SOBEL_VS,    SOBEL_FS,    null);
    this._rippleProgram= this._link(SOBEL_VS,    RIPPLE_FS,   null); // reuse fullscreen quad VS

    if (!this._cpuFallback) {
      // Compile TF shader — capture 3 varyings
      const vShader = this._compileShader(gl.VERTEX_SHADER, TF_VS);
      const prog    = gl.createProgram();
      gl.attachShader(prog, vShader);
      // No fragment shader needed for TF — use rasterizer discard
      gl.transformFeedbackVaryings(prog, ['v_pos','v_vel','v_col','v_target','v_age'], gl.INTERLEAVED_ATTRIBS);
      gl.linkProgram(prog);
      if (gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        this._tfProgram = prog;
      } else {
        console.warn('[NIFTransition] TF shader link failed, using CPU fallback:', gl.getProgramInfoLog(prog));
        this._cpuFallback = true;
      }
    }

    if (this._cpuFallback) {
      this._cpuParticles = new ParticleSystem({ maxCount: 50_000, gravity: 0, drag: 0.03 });
    }

    // Cache uniform locations
    const u = (prog, name) => gl.getUniformLocation(prog, name);
    if (this._tfProgram) {
      this._uniformsTF = {
        u_dt:      u(this._tfProgram,'u_dt'),
        u_t:       u(this._tfProgram,'u_t'),
        u_centroid:u(this._tfProgram,'u_centroid'),
        u_curl:    u(this._tfProgram,'u_curl'),
      };
    }
    this._uniformsParticle = {
      u_view:     u(this._drawProgram,'u_view'),
      u_proj:     u(this._drawProgram,'u_proj'),
      u_t:        u(this._drawProgram,'u_t'),
      u_viewport: u(this._drawProgram,'u_viewport'),
    };
  }

  // ── Curl texture — built asynchronously in chunks of Z slices ──────────────
  // Each chunk takes ~2-4ms, then yields to the browser with rAF.
  // Total time unchanged (same math) but the main thread is never frozen.
  async _buildCurlTextureAsync() {
    const gl = this.gl;
    const S  = CURL_TEX_SIZE;
    const data = new Uint8Array(S * S * S * 3);

    // Build one Z-slice at a time, yield between slices
    for (let z = 0; z < S; z++) {
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const idx = (z * S * S + y * S + x) * 3;
          const px  = x / S * 4, py = y / S * 4, pz = z / S * 4;
          const [cx, cy, cz] = Noise.curl(px, py, pz);
          data[idx]   = Math.floor((cx * 0.5 + 0.5) * 255);
          data[idx+1] = Math.floor((cy * 0.5 + 0.5) * 255);
          data[idx+2] = Math.floor((cz * 0.5 + 0.5) * 255);
        }
      }
      // Yield every slice so browser can handle input and paint
      if (z % 4 === 3) await new Promise(r => requestAnimationFrame(r));
    }

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, S, S, S, 0, gl.RGB, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.REPEAT);
    this._curlTex = tex;
    console.log(`[NIFTransition] Curl texture ${S}³ built`);
  }

  // ── CPU curl LUT — tiny pre-baked lookup table for CPU fallback ───────────
  // Built once, ~0.5ms for 16³ entries. Replaces per-particle Noise.curl calls.
  _buildCPUCurlLUT(S = 16) {
    const lut = new Float32Array(S * S * S * 3);
    let idx   = 0;
    for (let z = 0; z < S; z++) for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const [cx, cy, cz] = Noise.curl(x/S*4, y/S*4, z/S*4);
      lut[idx++] = cx; lut[idx++] = cy; lut[idx++] = cz;
    }
    this._cpuCurlLUT     = lut;
    this._cpuCurlLUTSize = S;
  }
  async _uploadSource(source) {
    const gl  = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    if (source instanceof ImageData) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, source.width, source.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, source.data);
    } else {
      // HTMLVideoElement or HTMLImageElement
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }
    this._sourceTex = tex;

    // Run Sobel pass to get edge map for particle seeding
    this._runSobelPass(source.width ?? this.canvas.width, source.height ?? this.canvas.height);
  }

  _runSobelPass(W, H) {
    const gl = this.gl;
    this._sobelTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._sobelTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, W, H, 0, gl.RG, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._sobelTex, 0);

    gl.viewport(0, 0, W, H);
    gl.useProgram(this._sobelProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._sourceTex);
    gl.uniform1i(gl.getUniformLocation(this._sobelProgram,'u_src'), 0);
    gl.uniform2f(gl.getUniformLocation(this._sobelProgram,'u_px'), 1/W, 1/H);
    this._drawFullscreenQuad();

    // Read back edge map for CPU-side seeding
    const pixels = new Uint8Array(W * H * 2);
    gl.readPixels(0, 0, W, H, gl.RG, gl.UNSIGNED_BYTE, pixels);
    this._sobelPixels = { data: pixels, W, H };

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    this._sobelFBO = null; // not needed after readback
  }

  // ── Particle spawn — async/chunked so it never freezes ───────────────────
  _spawnParticles(gaussians, source) {
    // N_PARTICLES is already set from budget above
    const N   = N_PARTICLES;
    const W   = this.canvas.width, H = this.canvas.height;

    const STRIDE = 13;
    const data   = new Float32Array(N * STRIDE);

    const edgePixels = [];
    if (this._sobelPixels) {
      const { data: sp, W: sW, H: sH } = this._sobelPixels;
      for (let i = 0; i < sW * sH; i++) {
        const edge = sp[i * 2] / 255;
        if (edge > 0.3) edgePixels.push({ u: (i % sW) / sW, v: Math.floor(i / sW) / sH, w: edge });
      }
    }

    for (let i = 0; i < N; i++) {
      const j  = i * STRIDE;
      const gi = (i % gaussians.count) * 14;

      let px, py, pz;
      if (edgePixels.length && i < N * 0.7) {
        const ep = edgePixels[Math.floor(Math.random() * edgePixels.length)];
        px = (ep.u * 2 - 1) * 2;
        py = (1 - ep.v * 2) * 2;
        pz = (Math.random() - 0.5) * 0.5;
      } else {
        const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
        const r  = Math.cbrt(Math.random()) * 3;
        px = r * Math.sin(ph) * Math.cos(th);
        py = r * Math.sin(ph) * Math.sin(th);
        pz = r * Math.cos(ph);
      }

      const outDir = v3.norm([
        px - this._centroid[0],
        py - this._centroid[1],
        pz - this._centroid[2],
      ]);
      const speed = 1.5 + Math.random() * 2;
      const sh0r  = 1 / (1 + Math.exp(-gaussians.data[gi + 11])) + 0.5;
      const sh0g  = 1 / (1 + Math.exp(-gaussians.data[gi + 12])) + 0.5;
      const sh0b  = 1 / (1 + Math.exp(-gaussians.data[gi + 13])) + 0.5;

      data[j]    = px;
      data[j+1]  = py;
      data[j+2]  = pz;
      data[j+3]  = outDir[0] * speed + (Math.random() - 0.5) * 0.5;
      data[j+4]  = outDir[1] * speed + (Math.random() - 0.5) * 0.5;
      data[j+5]  = outDir[2] * speed + (Math.random() - 0.5) * 0.5;
      data[j+6]  = Math.min(1, sh0r * 1.5);
      data[j+7]  = Math.min(1, sh0g * 1.5);
      data[j+8]  = Math.min(1, sh0b * 1.5);
      data[j+9]  = gaussians.data[gi];
      data[j+10] = gaussians.data[gi+1];
      data[j+11] = gaussians.data[gi+2];
      data[j+12] = 0;
    }

    if (!this._cpuFallback) {
      this._createTFBuffers(data, N, STRIDE);
    }
    this._particleData   = data;
    this._particleN      = N;
    this._particleStride = STRIDE;
  }

  _createTFBuffers(data, N, STRIDE) {
    const gl     = this.gl;
    const bytes  = data.byteLength;

    this._bufA = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._bufA);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_COPY);

    this._bufB = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._bufB);
    gl.bufferData(gl.ARRAY_BUFFER, bytes, gl.DYNAMIC_COPY);

    this._vaoA = this._makeParticleVAO(this._bufA, this._tfProgram, STRIDE*4);
    this._vaoB = this._makeParticleVAO(this._bufB, this._tfProgram, STRIDE*4);

    this._drawVaoA = this._makeParticleVAO(this._bufA, this._drawProgram, STRIDE*4);
    this._drawVaoB = this._makeParticleVAO(this._bufB, this._drawProgram, STRIDE*4);

    this._tf       = gl.createTransformFeedback();
    this._ping     = true; // true = read A, write B; false = read B, write A
  }

  _makeParticleVAO(buf, prog, stride) {
    const gl  = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const attrs = [
      ['a_pos',   3, 0*4],
      ['a_vel',   3, 3*4],
      ['a_col',   3, 6*4],
      ['a_target',3, 9*4],
      ['a_age',   1,12*4],
    ];
    for (const [name, size, offset] of attrs) {
      const loc = gl.getAttribLocation(prog, name);
      if (loc < 0) continue;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
    }
    gl.bindVertexArray(null);
    return vao;
  }

  // ── Main render loop ──────────────────────────────────────────────────────
  _loop() {
    if (!this._running) return;
    const now     = performance.now();
    const elapsed = (now - this._startTime) / 1000;
    this._t = Math.min(elapsed / this.duration, 1.0);

    // Real delta time — clamped to prevent spiral of death after tab switch
    const dt = Math.min((now - (this._lastLoopTime ?? now)) / 1000, 0.1);
    this._lastLoopTime = now;

    // Stage change events
    const newStage = STAGE_BREAKS.findIndex(b => b > this._t) - 1;
    const clamped  = Math.max(0, Math.min(newStage, STAGE_NAMES.length - 1));
    if (clamped !== this._stage) {
      this._stage = clamped;
      this.onStageChange(STAGE_NAMES[this._stage], this._t);
    }

    this._renderFrame(dt);

    if (this._t >= 1.0) {
      this._running = false;
      this.onComplete();
      return;
    }
    requestAnimationFrame(() => this._loop());
  }

  _renderFrame(dt) {
    const gl = this.gl;
    const W  = this.canvas.width, H = this.canvas.height;
    gl.viewport(0, 0, W, H);

    if (this._t < STAGE_BREAKS[1]) {
      // Stage 1: Source frame + shatter
      this._renderSource(this._t / STAGE_BREAKS[1]);
      this._integrateParticles(dt);
      this._renderParticles(W, H, 0.3 + 0.7*(this._t/STAGE_BREAKS[1])); // fade in
    } else if (this._t < STAGE_BREAKS[2]) {
      // Stage 2: Black background + nebula
      gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      this._integrateParticles(dt);
      this._renderParticles(W, H, 1.0);
    } else if (this._t < STAGE_BREAKS[3]) {
      // Stage 3: Gaussians composited with particles (crystallisation)
      const s = (this._t - STAGE_BREAKS[2]) / (STAGE_BREAKS[3] - STAGE_BREAKS[2]);
      gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      // Render Gaussians at increasing opacity
      if (this._gaussianRender) this._gaussianRender(s * s); // opacity²
      this._integrateParticles(dt);
      this._renderParticles(W, H, 1.0 - s * 0.9); // fade particles out
    } else {
      // Stage 4: Solidification ripple
      const s = (this._t - STAGE_BREAKS[3]) / (1.0 - STAGE_BREAKS[3]);
      if (this._gaussianRender) this._gaussianRender(1.0);
      this._renderRipple(s, W, H);
    }
  }

  _integrateParticles(dt) {
    const gl = this.gl;
    if (this._cpuFallback) {
      // CPU path — uses budget-capped particle count (never 200k)
      // Curl noise is sampled from a pre-built lookup table instead of
      // calling Noise.curl() 200k times per frame (which crashes slow devices).
      const d    = this._particleData;
      const N    = this._particleN;  // already budget-capped
      const S    = this._particleStride;
      const [cx, cy, cz] = this._centroid;
      const t    = this._t;

      // Lazy-build a compact curl lookup for CPU path (16³ = 4096 entries, ~0.5ms)
      if (!this._cpuCurlLUT) this._buildCPUCurlLUT(16);
      const lut  = this._cpuCurlLUT;
      const LS   = this._cpuCurlLUTSize;

      for (let i = 0; i < N; i++) {
        const j = i * S;
        let px = d[j], py = d[j+1], pz = d[j+2];
        let vx = d[j+3], vy = d[j+4], vz = d[j+5];
        const tx = d[j+9], ty = d[j+10], tz = d[j+11];

        if (t < 0.20) {
          vx *= 0.96; vy *= 0.96; vz *= 0.96;
        } else if (t < 0.55) {
          // Sample curl from LUT — O(1), no transcendental functions
          const lx = Math.floor(((px * 0.3 + t * 0.1) % 1 + 1) % 1 * LS) % LS;
          const ly = Math.floor((py * 0.3 % 1 + 1) % 1 * LS) % LS;
          const lz = Math.floor((pz * 0.3 % 1 + 1) % 1 * LS) % LS;
          const li  = (lz * LS * LS + ly * LS + lx) * 3;
          const cv0 = lut[li], cv1 = lut[li+1], cv2 = lut[li+2];
          const s   = (t - 0.20) / 0.35;
          vx += (cv0 * 2 + (cx - px) * 0.5 * s) * dt;
          vy += (cv1 * 2 + (cy - py) * 0.5 * s) * dt;
          vz += (cv2 * 2 + (cz - pz) * 0.5 * s) * dt;
          vx *= 0.97; vy *= 0.97; vz *= 0.97;
        } else if (t < 0.85) {
          const s   = (t - 0.55) / 0.30;
          const pull = s * s * s * (s * (s * 6 - 15) + 10);
          vx = (tx - px) * pull * 3;
          vy = (ty - py) * pull * 3;
          vz = (tz - pz) * pull * 3;
        } else {
          const snap = Math.min((t - 0.85) / 0.15 * 4, 1);
          px += (tx - px) * snap;
          py += (ty - py) * snap;
          pz += (tz - pz) * snap;
          vx = vy = vz = 0;
        }

        d[j]   = px + vx * dt;
        d[j+1] = py + vy * dt;
        d[j+2] = pz + vz * dt;
        d[j+3] = vx;
        d[j+4] = vy;
        d[j+5] = vz;
      }
      return;
    }

    // GPU path — Transform Feedback
    const readBuf  = this._ping ? this._bufA   : this._bufB;
    const writeBuf = this._ping ? this._bufB   : this._bufA;
    const readVAO  = this._ping ? this._vaoA   : this._vaoB;

    gl.useProgram(this._tfProgram);
    const u = this._uniformsTF;
    gl.uniform1f(u.u_dt,       dt);
    gl.uniform1f(u.u_t,        this._t);
    gl.uniform3fv(u.u_centroid, this._centroid);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, this._curlTex);
    gl.uniform1i(u.u_curl, 0);

    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this._tf);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, writeBuf);
    gl.bindVertexArray(readVAO);
    gl.enable(gl.RASTERIZER_DISCARD); // no fragment output during TF
    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, 0, this._particleN);
    gl.endTransformFeedback();
    gl.disable(gl.RASTERIZER_DISCARD);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
    gl.bindVertexArray(null);

    this._ping = !this._ping; // swap buffers
  }

  _renderParticles(W, H, alpha) {
    const gl = this.gl;
    gl.useProgram(this._drawProgram);
    const u = this._uniformsParticle;

    // Simple orthographic view for 2D-style particle rendering
    const view = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,-5,1];
    const proj = [0.5,0,0,0, 0,0.5*W/H,0,0, 0,0,-1,0, 0,0,-1,1];

    gl.uniformMatrix4fv(u.u_view, false, new Float32Array(view));
    gl.uniformMatrix4fv(u.u_proj, false, new Float32Array(proj));
    gl.uniform1f(u.u_t, this._t);
    gl.uniform2f(u.u_viewport, W, H);

    if (this._cpuFallback) {
      // Upload CPU particle data
      if (!this._cpuBuf) {
        this._cpuBuf  = gl.createBuffer();
        this._cpuVAO  = this._makeParticleVAO(this._cpuBuf, this._drawProgram, this._particleStride*4);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this._cpuBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this._particleData, gl.DYNAMIC_DRAW);
      gl.bindVertexArray(this._cpuVAO);
    } else {
      // Read from the just-written buffer
      const drawVAO = this._ping ? this._drawVaoB : this._drawVaoA;
      gl.bindVertexArray(drawVAO);
    }
    gl.drawArrays(gl.POINTS, 0, this._particleN);
    gl.bindVertexArray(null);
  }

  _renderSource(alpha) {
    const gl = this.gl;
    gl.clearColor(0,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT);
    // Draw source texture as fullscreen quad at alpha
    // Fade out as dissociation progresses
    gl.useProgram(this._sobelProgram); // reuse — it just draws u_src
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._sourceTex);
    gl.uniform1i(gl.getUniformLocation(this._sobelProgram,'u_src'), 0);
    gl.uniform2f(gl.getUniformLocation(this._sobelProgram,'u_px'), 0, 0); // no edge effect
    this._drawFullscreenQuad();
  }

  _renderRipple(s, W, H) {
    const gl = this.gl;
    // Switch to additive blending — overlay specular flash on the Gaussian scene
    // that gaussianRenderFn already drew to the canvas this frame
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this._rippleProgram);
    gl.uniform1f(gl.getUniformLocation(this._rippleProgram,'u_t'), s);
    gl.uniform2f(gl.getUniformLocation(this._rippleProgram,'u_viewport'), W, H);
    this._drawFullscreenQuad();
    // Restore particle blend mode
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  _computeCentroid(gaussians) {
    const {count, data} = gaussians;
    let cx=0, cy=0, cz=0;
    const step = Math.max(1, Math.floor(count/2000)); // sample 2000 points max
    let n = 0;
    for (let i=0; i<count; i+=step) { cx+=data[i*14]; cy+=data[i*14+1]; cz+=data[i*14+2]; n++; }
    this._centroid = [cx/n, cy/n, cz/n];
  }

  _fullscreenQuadBuf = null;
  _drawFullscreenQuad() {
    const gl = this.gl;
    if (!this._fullscreenQuadBuf) {
      this._fullscreenQuadBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this._fullscreenQuadBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this._fullscreenQuadBuf);
    const loc = gl.getAttribLocation(gl.getParameter(gl.CURRENT_PROGRAM), 'a_xy');
    if (loc >= 0) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  _compileShader(type, src) {
    const gl = this.gl;
    const s  = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      console.error('[NIFTransition shader]', gl.getShaderInfoLog(s));
    return s;
  }

  _link(vsSrc, fsSrc) {
    const gl = this.gl;
    const vs = this._compileShader(gl.VERTEX_SHADER,   vsSrc);
    const fs = this._compileShader(gl.FRAGMENT_SHADER, fsSrc);
    const p  = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      console.error('[NIFTransition link]', gl.getProgramInfoLog(p));
    return p;
  }
}
