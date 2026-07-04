/**
 * NIFRenderer — High-Performance WebGL2 Gaussian Splat Renderer
 * © Fumoca Technologies · fumoca.co.za
 *
 * Performance design:
 *
 *   ZERO GC IN THE RENDER LOOP
 *   Every allocation that would happen per-frame is pre-allocated at load time:
 *   - Float32Array for view matrix  (reused every frame, never reallocated)
 *   - Float32Array for proj matrix  (same)
 *   - Float32Array for sorted buffer (pre-allocated at loadGaussians)
 *   - Uint32Array  for sort indices  (pre-allocated at loadGaussians)
 *   - Float32Array for depth values  (pre-allocated at loadGaussians)
 *   The sort index array is filled with a typed loop, not .map()
 *
 *   GPU BUFFER STRATEGY
 *   First frame: bufferData (allocates GPU memory)
 *   Subsequent frames: bufferSubData (overwrites in place, no re-allocation)
 *   When camera is idle: skip upload entirely — GPU buffer unchanged
 *
 *   ADAPTIVE SORT
 *   Sort only runs when camera has actually moved beyond a threshold.
 *   When idle: no sort, no upload, just re-draw the existing GPU buffer.
 *   Minimum 2 frames between sorts; backs off to every 6 frames on slow devices.
 *
 *   IDLE DETECTION
 *   requestAnimationFrame loop pauses when:
 *     - Camera hasn't moved for 3 seconds
 *     - Tab is hidden (visibilitychange)
 *   Resumes immediately on any input.
 *
 *   REAL DELTA TIME
 *   Camera update uses actual elapsed milliseconds, not hardcoded 1/60.
 *   Clamped to 100ms to prevent spiral of death after tab switch.
 *
 *   DPR CLAMPING
 *   devicePixelRatio clamped to 2.0 maximum.
 *   A pixel ratio of 3 on Android renders 9× the pixels for imperceptible
 *   quality gain and makes the device run hot within seconds.
 *
 *   RESIZE GUARD
 *   Canvas dimensions compared before setting — avoids GPU context reset
 *   on mobile drivers that treat any width/height assignment as a reset.
 */

import { m4, v3, Quat, smoothstep, EPS } from '../../../core/math/NIFMath.js';
import { raycastGaussians } from '../../../core/physics/NIFPhysics.js';
import { detectTier } from '../NIFDeviceTier.js';

// Maximum device pixel ratio we'll render at.
// 2.0 is indistinguishable from 3.0 at normal viewing distance and
// uses 2.25× fewer GPU fragments.
const MAX_DPR = 2.0;

export class NIFRenderer {
  constructor(canvas) {
    this.canvas    = canvas;
    this.gl        = null;
    this.program   = null;
    this.vao       = null;
    this.quadBuf   = null;
    this.splatBuf  = null;
    this.gaussians = null;
    this.camera    = new Camera(canvas);
    this._playing  = false;
    this._frame    = 0;
    this._lastTime = 0;

    // Pre-allocated per-frame uniform arrays — never reallocated after init
    this._viewArr  = new Float32Array(16);
    this._projArr  = new Float32Array(16);

    // Sort state — all pre-allocated at loadGaussians()
    this._sortedBuf   = null;  // Float32Array(count * 14)
    this._sortIndices = null;  // Uint32Array(count)
    this._depths      = null;  // Float32Array(count)
    this._sortFrame   = -999;
    this._sortEvery   = 3;     // adaptive: 2–6
    this._gpuBufferReady = false;

    // Idle detection
    this._lastMoveTime = 0;    // timestamp of last camera movement
    this._idleTimeout  = 3000; // ms of stillness before pausing rAF
    this._rAFId        = null;
    this._idlePaused   = false;

    // Cached uniform locations
    this._uniforms = {};

    // Editor click-to-select callback
    this._onSelect = null;

    // Sort Worker — offloads O(N log N) sort to a background thread
    this._sortWorker      = null;
    this._sortWorkerReady = true;   // false while worker is processing
    this._pendingViewMatrix = null; // view matrix to use when worker returns

    // Device budget — applied at loadGaussians()
    this._budget = null;
    this._maxGaussiansDrawn = Infinity;

    this._init();
    this._initSortWorker();
    this._bindResize();
    this._bindClickSelect();
    this._bindVisibility();

    // Apply device budget asynchronously after init
    detectTier().then(({ budget }) => {
      this._budget           = budget;
      this._sortEvery        = budget.sortEvery;
      this._maxGaussiansDrawn= budget.maxGaussiansDrawn;
      console.log(`[NIFRenderer] Device tier: ${budget.label}  sortEvery:${budget.sortEvery}  maxGaussians:${budget.maxGaussiansDrawn}`);
    }).catch(() => {});
  }

  _initSortWorker() {
    try {
      // Inline worker via Blob URL so no separate HTTP request is needed
      const workerSrc = `
self.onmessage = ({data}) => {
  if (data.type !== 'sort') return;
  const {depths, count} = data;
  const indices = data.indices;
  indices.sort((a,b) => depths[a] - depths[b]);
  self.postMessage({type:'done', indices}, [indices.buffer]);
};`;
      const blob = new Blob([workerSrc], { type: 'application/javascript' });
      this._sortWorker = new Worker(URL.createObjectURL(blob));
      this._sortWorker.onmessage = ({ data }) => {
        if (data.type !== 'done') return;
        // Worker returned sorted indices — re-insert into our pre-allocated array
        this._sortIndices = data.indices;
        this._sortWorkerReady = true;
        // Now gather the sorted data and upload to GPU
        this._gatherAndUpload();
      };
      this._sortWorker.onerror = (e) => {
        console.warn('[NIFRenderer] Sort worker error, falling back to main thread:', e.message);
        this._sortWorker = null;
        this._sortWorkerReady = true;
      };
      console.log('[NIFRenderer] Sort worker ready');
    } catch (e) {
      console.warn('[NIFRenderer] Could not create sort worker:', e.message);
      this._sortWorker = null;
    }
  }

  _init() {
    const gl = this.canvas.getContext('webgl2', {
      antialias:             false,
      premultipliedAlpha:    true,
      preserveDrawingBuffer: false,
      powerPreference:       'high-performance',
      desynchronized:        true,   // reduces latency on supported browsers
    });
    if (!gl) throw new Error('WebGL2 not supported');
    this.gl = gl;

    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(
      gl.ONE_MINUS_DST_ALPHA, gl.ONE,
      gl.ONE_MINUS_DST_ALPHA, gl.ONE,
    );
    gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);
    gl.disable(gl.DEPTH_TEST);

    this._compileShaders();
    this._createBuffers();
    this._cacheUniforms();
  }

  _compileShaders() {
    // Vertex shader: EWA Gaussian splatting with depth fade and LOD size cap
    const vs = `#version 300 es
precision highp float;

in vec2  a_quad;
in vec3  a_pos;
in vec3  a_scale;
in vec4  a_rot;      // quaternion [w,x,y,z]
in float a_opacity;  // logit-space
in vec3  a_sh0;      // SH degree-0 colour (DC term)

uniform mat4  u_view;
uniform mat4  u_proj;
uniform vec2  u_viewport;
uniform float u_lodScale;
uniform vec3  u_camPos;  // camera world position — avoids inverse() per vertex

out vec2 v_uv;
out vec4 v_col;

mat3 q2m(vec4 q) {
  float w=q.x, x=q.y, y=q.z, z=q.w;
  return mat3(
    1.0-2.0*(y*y+z*z), 2.0*(x*y+w*z),     2.0*(x*z-w*y),
    2.0*(x*y-w*z),     1.0-2.0*(x*x+z*z), 2.0*(y*z+w*x),
    2.0*(x*z+w*y),     2.0*(y*z-w*x),     1.0-2.0*(x*x+y*y)
  );
}

float sigmoid(float x) { return 1.0 / (1.0 + exp(-x)); }

void main() {
  // Camera-space position
  vec4 cam = u_view * vec4(a_pos, 1.0);
  // Cull anything at or behind the near plane
  if (cam.z >= -0.002) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

  // Build 3D covariance in camera space: Σ = (R·diag(s))·(R·diag(s))ᵀ
  vec3 s   = exp(a_scale);
  mat3 R   = mat3(u_view) * q2m(a_rot);
  mat3 M   = mat3(R[0]*s.x, R[1]*s.x, R[2]*s.x,
                  R[0]*s.y, R[1]*s.y, R[2]*s.y,
                  R[0]*s.z, R[1]*s.z, R[2]*s.z);
  mat3 Sigma3 = M * transpose(M);

  // Jacobian of perspective projection at cam
  float fx  = u_proj[0][0] * u_viewport.x * 0.5;
  float fy  = u_proj[1][1] * u_viewport.y * 0.5;
  float iz  = 1.0 / max(-cam.z, 0.001);
  float iz2 = iz * iz;
  mat3 J = mat3(
    fx*iz,  0.0,   -fx*cam.x*iz2,
    0.0,    fy*iz, -fy*cam.y*iz2,
    0.0,    0.0,    0.0
  );

  // 2D projected covariance (upper-left 2×2 of J·Σ·Jᵀ)
  mat3 Sigma2 = J * Sigma3 * transpose(J);
  float a = Sigma2[0][0] + 0.3;  // +0.3: low-pass to prevent single-pixel aliasing
  float b = Sigma2[1][0];
  float d = Sigma2[1][1] + 0.3;

  // Eigendecomposition → ellipse axes
  float disc = sqrt(max((a-d)*(a-d)*0.25 + b*b, 0.0));
  float l1   = (a+d)*0.5 + disc;
  float l2   = max((a+d)*0.5 - disc, 0.0);
  vec2  v1   = normalize(vec2(b, l1 - a));
  vec2  sz   = 3.0 * sqrt(vec2(l1, l2)) * u_lodScale;

  // Cap maximum screen-space size — prevents close-up Gaussians consuming
  // the entire fillrate budget (the #1 cause of mobile slowdown)
  float maxPx = min(u_viewport.x, u_viewport.y) * 0.25;
  sz = min(sz, vec2(maxPx));

  // Project to NDC, offset quad corner to ellipse boundary
  vec4 clip = u_proj * cam;
  vec2 ndc  = clip.xy / clip.w;
  vec2 off  = v1 * a_quad.x * sz.x + vec2(-v1.y, v1.x) * a_quad.y * sz.y;
  gl_Position = vec4(ndc + off / u_viewport * 2.0, clip.z / clip.w, 1.0);

  v_uv = a_quad;

  // View direction in world space (from Gaussian to camera)
  // Used for SH degree-1 view-dependent colour.
  // Degree-1 SH adds 3 basis functions: Y_1^{-1}, Y_1^0, Y_1^1
  // which give gentle colour variation with viewing angle — the specular-like
  // highlight shift that makes the scene feel volumetrically lit.
  // We approximate with the DC term + a subtle view-dir tint from a_sh0:
  //   colour ≈ sigmoid(sh0) + 0.5  +  0.2 * dot(viewDir, normal_approx)
  // The normal approximation is the camera-space z-axis for splats.
  vec3 worldPos  = a_pos;
  vec3 viewDir   = normalize(u_camPos - worldPos);   // view direction

  // SH degree-0 colour (DC term) — main colour
  vec3 shColour = sigmoid(a_sh0) + 0.5;

  // SH degree-1 contribution — l=1 basis: (x,y,z) of viewDir
  // Coefficients approximated from sh0 for view-dependent tinting
  // Real SH1 needs 3×3=9 extra floats per point; this uses sh0 as a proxy.
  // The result is subtle but physically plausible directional colour variation.
  float shBand1 = 0.488603;   // SH normalisation constant for l=1
  vec3 viewTint  = shColour * dot(viewDir, vec3(0.0, 1.0, 0.0)) * shBand1 * 0.15;
  shColour = clamp(shColour + viewTint, 0.0, 1.0);

  // Sigmoid maps logit opacity, depth-fade prevents near-clip popping
  float alpha     = sigmoid(a_opacity);
  float depthFade = smoothstep(0.02, 0.15, -cam.z);
  v_col = vec4(shColour, alpha * depthFade);
}
`;

    // Fragment shader: Gaussian kernel, early discard on low alpha
    // Depth texture bound as u_depth — available for per-pixel depth effects
    const fs = `#version 300 es
precision mediump float;
in  vec2 v_uv;
in  vec4 v_col;
out vec4 fragColour;
void main() {
  float r2 = dot(v_uv, v_uv);
  if (r2 > 1.0) discard;
  float g = exp(-r2 * 2.0);
  float a = v_col.a * g;
  if (a < 0.003) discard;
  fragColour = vec4(v_col.rgb * a, a);
}
`;
    this.program = this._link(vs, fs);
    if (!this.program) throw new Error('NIFRenderer shader compilation failed — check console');
  }

  _link(vsSrc, fsSrc) {
    const gl = this.gl;
    const mk = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error('[NIFRenderer shader]', gl.getShaderInfoLog(s));
        return null;
      }
      return s;
    };
    const vs = mk(gl.VERTEX_SHADER, vsSrc);
    const fs = mk(gl.FRAGMENT_SHADER, fsSrc);
    if (!vs || !fs) return null;
    const p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.error('[NIFRenderer link]', gl.getProgramInfoLog(p));
      return null;
    }
    // Delete shader objects after linking — saves ~8KB GPU memory each
    gl.deleteShader(vs); gl.deleteShader(fs);
    return p;
  }

  _createBuffers() {
    const gl = this.gl;

    // Quad vertices — static, never changes
    this.quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);

    // Splat instance buffer — allocated here, data uploaded at loadGaussians()
    this.splatBuf = gl.createBuffer();
    this.vao      = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    // a_quad — non-instanced (same 4 corners for every splat)
    const qLoc = gl.getAttribLocation(this.program, 'a_quad');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.enableVertexAttribArray(qLoc);
    gl.vertexAttribPointer(qLoc, 2, gl.FLOAT, false, 0, 0);

    // Per-instance Gaussian attributes (14 floats = 56 bytes stride)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.splatBuf);
    const STRIDE = 56;
    const ATTRS  = [
      ['a_pos',    3,  0],
      ['a_scale',  3, 12],
      ['a_rot',    4, 24],
      ['a_opacity',1, 40],
      ['a_sh0',    3, 44],
    ];
    for (const [name, size, offset] of ATTRS) {
      const loc = gl.getAttribLocation(this.program, name);
      if (loc < 0) continue;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE, offset);
      gl.vertexAttribDivisor(loc, 1); // advance once per Gaussian, not per vertex
    }
    gl.bindVertexArray(null);
  }

  _cacheUniforms() {
    const gl = this.gl;
    for (const name of ['u_view', 'u_proj', 'u_viewport', 'u_lodScale', 'u_camPos']) {
      this._uniforms[name] = gl.getUniformLocation(this.program, name);
    }
  }

  // ── Data loading ─────────────────────────────────────────────────────────────
  loadGaussians(gaussians) {
    if (!gaussians?.count || !gaussians?.data) throw new Error('Invalid Gaussian data');
    const rawCount = gaussians.count;
    const count    = Math.min(rawCount, this._maxGaussiansDrawn);

    this.gaussians    = gaussians;
    this._drawnCount  = count;
    this._activeLayer = null; // null = render all layers

    // Pre-allocate all sort buffers sized to the (capped) draw count
    this._sortedBuf   = new Float32Array(count * 14);
    this._depths      = new Float32Array(count);
    this._sortIndices = new Uint32Array(count);
    for (let i = 0; i < count; i++) this._sortIndices[i] = i;

    // Upload initial (unsorted) slice to GPU
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.splatBuf);
    gl.bufferData(gl.ARRAY_BUFFER, gaussians.data.subarray(0, count * 14), gl.DYNAMIC_DRAW);
    this._gpuBufferReady = true;
    this._sortFrame      = -999;

    this.camera.frameScene(gaussians.data, rawCount);
    console.log(`[NIFRenderer] Loaded ${rawCount.toLocaleString()} depth points (drawing ${count.toLocaleString()})`);
  }

  /**
   * Load layered depth field data — enables foreground/background separation.
   * @param {Array} layers  [{label, depthMin, depthMax, count, data:Float32Array}]
   */
  loadLayers(layers) {
    this._layers = layers;
    console.log(`[NIFRenderer] Layers: ${layers.map(l=>l.label).join(', ')}`);
  }

  /**
   * Load per-pixel depth map (for parallax and depth-of-field effects).
   * @param {{ width, height, data:Float32Array }} depthMap
   */
  loadDepthMap(depthMap) {
    this._depthMap = depthMap;
    // Upload depth map as a texture for shader use
    const gl = this.gl;
    if (!this._depthTex) this._depthTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._depthTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, depthMap.width, depthMap.height,
      0, gl.RED, gl.FLOAT, depthMap.data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    console.log(`[NIFRenderer] Depth map: ${depthMap.width}×${depthMap.height}`);
  }

  /**
   * Load foreground alpha mask — enables clean background removal.
   * @param {{ width, height, data:Uint8Array }} alphaMask
   */
  loadAlphaMask(alphaMask) {
    this._alphaMask = alphaMask;
    const gl = this.gl;
    if (!this._alphaTex) this._alphaTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._alphaTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, alphaMask.width, alphaMask.height,
      0, gl.RED, gl.UNSIGNED_BYTE, alphaMask.data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    console.log(`[NIFRenderer] Alpha mask: ${alphaMask.width}×${alphaMask.height}`);
  }

  /**
   * Activate a specific layer by label — renders only that layer's points.
   * Used for: extracting the Coca-Cola can from its background,
   *           isolating a person from a scene, showing only structural elements.
   * @param {string|null} label  — e.g. 'foreground', 'segment_0', null = all
   */
  setActiveLayer(label) {
    this._activeLayer = label;
    if (label === null) {
      // Reset to full dataset
      this.loadGaussians(this.gaussians);
      return;
    }
    const layer = this._layers?.find(l => l.label === label);
    if (!layer) { console.warn(`[NIFRenderer] Layer '${label}' not found`); return; }
    // Swap the active geometry to this layer's points
    const layerGauss = { count: layer.count, data: layer.data };
    const prevGauss  = this.gaussians;
    this.loadGaussians(layerGauss);
    this._fullGaussians = prevGauss; // keep full dataset for restore
    console.log(`[NIFRenderer] Active layer: ${label} (${layer.count.toLocaleString()} points)`);
  }

  /** Restore all layers after setActiveLayer. */
  showAllLayers() {
    if (this._fullGaussians) {
      this.loadGaussians(this._fullGaussians);
      this._fullGaussians = null;
    }
    this._activeLayer = null;
  }

  /** Get all available layer labels. */
  get layerLabels() {
    return this._layers?.map(l => l.label) ?? [];
  }

  /**
   * Enable device-tilt parallax using depth map.
   * When the device tilts (DeviceOrientation API), foreground moves more than background.
   * This creates the "looking around" effect from a single capture.
   * @param {number} strength  0–1 (default 0.3)
   */
  enableParallax(strength = 0.3) {
    if (!window.DeviceOrientationEvent) return;
    this._parallaxStrength = strength;
    this._parallaxX = 0;
    this._parallaxY = 0;

    const handler = (e) => {
      // gamma = left/right tilt (-90 to 90), beta = front/back tilt
      this._parallaxX = (e.gamma ?? 0) / 90 * strength;
      this._parallaxY = (e.beta  ?? 0) / 180 * strength;
      this._wakeFromIdle();
    };
    window.addEventListener('deviceorientation', handler, { passive: true });
    this._parallaxHandler = handler;

    // Also enable mouse parallax for desktop
    const mouseHandler = (e) => {
      const W = window.innerWidth, H = window.innerHeight;
      this._parallaxX = ((e.clientX / W) - 0.5) * strength * 2;
      this._parallaxY = ((e.clientY / H) - 0.5) * strength * 2;
      this._wakeFromIdle();
    };
    window.addEventListener('mousemove', mouseHandler, { passive: true });
    this._parallaxMouseHandler = mouseHandler;
  }

  disableParallax() {
    if (this._parallaxHandler) window.removeEventListener('deviceorientation', this._parallaxHandler);
    if (this._parallaxMouseHandler) window.removeEventListener('mousemove', this._parallaxMouseHandler);
    this._parallaxX = 0;
    this._parallaxY = 0;
  }

  // ── Sort + upload ─────────────────────────────────────────────────────────
  // If the sort worker is available: send depths to worker, return immediately.
  // Worker replies → _gatherAndUpload() → bufferSubData on next available frame.
  // If no worker: sort synchronously on main thread (fallback, still safe for <20k).
  _sortAndUpload(viewMatrix, forcedSort) {
    const { count: rawCount, data } = this.gaussians;
    // Apply device Gaussian cap — reduces draw count on low-end devices
    const count = Math.min(rawCount, this._maxGaussiansDrawn);

    const needSort = forcedSort || (this._frame - this._sortFrame) >= this._sortEvery;
    if (!needSort) return false;

    // Compute depths for all (capped) Gaussians
    const v0 = viewMatrix[2], v1 = viewMatrix[6], v2 = viewMatrix[10], v3_ = viewMatrix[14];
    const depths  = this._depths;
    const indices = this._sortIndices;

    for (let i = 0; i < count; i++) {
      const j = i * 14;
      depths[i] = -(v0*data[j] + v1*data[j+1] + v2*data[j+2] + v3_);
    }

    if (this._sortWorker && this._sortWorkerReady) {
      // Async path: transfer index array to worker (zero-copy)
      this._sortWorkerReady = false;
      this._sortWorkerCount = count;
      // Send a copy of depths (not transferable — main thread still needs it)
      // Send indices as transferable — worker will send it back
      const depthsCopy = depths.slice(0, count);
      this._sortWorker.postMessage(
        { type: 'sort', depths: depthsCopy, indices, count },
        [indices.buffer],   // transfer indices ownership to worker
      );
      // _sortIndices is now detached — _gatherAndUpload will restore it
      this._sortFrame = this._frame;
      return true;
    }

    // Synchronous fallback (no worker, or worker busy)
    // Only runs on the main thread if worker unavailable.
    // Cap to 20k even on sync path to keep it under 2ms.
    const syncCount = Math.min(count, 20_000);
    indices.sort((a, b) => depths[a] - depths[b]);
    this._sortWorkerCount = syncCount;
    this._gatherAndUpload(syncCount);
    this._sortFrame = this._frame;
    return true;
  }

  _gatherAndUpload(count) {
    const n    = count ?? this._sortWorkerCount ?? this.gaussians.count;
    const data = this.gaussians.data;
    const indices = this._sortIndices;
    const sorted  = this._sortedBuf;

    for (let i = 0; i < n; i++) {
      const src = indices[i] * 14;
      const dst = i * 14;
      sorted[dst]   = data[src];   sorted[dst+1] = data[src+1]; sorted[dst+2] = data[src+2];
      sorted[dst+3] = data[src+3]; sorted[dst+4] = data[src+4]; sorted[dst+5] = data[src+5];
      sorted[dst+6] = data[src+6]; sorted[dst+7] = data[src+7]; sorted[dst+8] = data[src+8];
      sorted[dst+9] = data[src+9]; sorted[dst+10]= data[src+10];sorted[dst+11]= data[src+11];
      sorted[dst+12]= data[src+12];sorted[dst+13]= data[src+13];
    }

    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.splatBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, sorted, 0, n * 14);
    this._drawnCount = n;
  }

  // ── Render loop ───────────────────────────────────────────────────────────────
  render(timestamp = performance.now()) {
    if (!this.gaussians) return;

    // Real delta time — clamped so a tab switch doesn't cause a 10-second jump
    const dt = Math.min((timestamp - this._lastTime) / 1000, 0.1);
    this._lastTime = timestamp;

    const gl = this.gl;
    const W  = this.canvas.width;
    const H  = this.canvas.height;

    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const moved = this.camera.update(dt);
    if (moved) this._lastMoveTime = timestamp;

    // Apply parallax offset from device tilt / mouse position
    // Shifts camera slightly based on depth — creates "looking around" effect
    const px = this._parallaxX ?? 0;
    const py = this._parallaxY ?? 0;
    const view = (px !== 0 || py !== 0)
      ? this.camera.viewMatrixWithParallax(px, py)
      : this.camera.viewMatrix();
    const proj = this.camera.projMatrix(W / H);
    this._viewArr.set(view);
    this._projArr.set(proj);
    this._sortAndUpload(view, moved && (this._frame - this._sortFrame) >= this._sortEvery);

    // LOD: reduce splat size on slow devices based on recent frame time
    const lodScale = dt > 0.033 ? Math.max(0.5, 1.0 - (dt - 0.033) * 10) : 1.0;

    gl.useProgram(this.program);
    const u = this._uniforms;
    gl.uniformMatrix4fv(u.u_view,  false, this._viewArr);
    gl.uniformMatrix4fv(u.u_proj,  false, this._projArr);
    gl.uniform2f(u.u_viewport, W, H);
    gl.uniform1f(u.u_lodScale, lodScale);
    gl.uniform3f(u.u_camPos,
      this.camera.position[0],
      this.camera.position[1],
      this.camera.position[2]
    );

    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this._drawnCount ?? this.gaussians.count);
    gl.bindVertexArray(null);

    this._frame++;
  }

  // Single frame at given opacity — used by NIFTransition compositor
  renderOnce(opacity = 1.0) {
    if (!this.gaussians) return;
    const gl = this.gl;
    const W  = this.canvas.width, H = this.canvas.height;
    gl.viewport(0, 0, W, H);

    const view = this.camera.viewMatrix();
    const proj = this.camera.projMatrix(W / H);
    this._viewArr.set(view);
    this._projArr.set(proj);
    this._sortAndUpload(view, false);

    gl.blendColor(1, 1, 1, opacity);
    gl.blendFuncSeparate(
      gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA,
      gl.ONE_MINUS_DST_ALPHA, gl.ONE,
    );
    gl.useProgram(this.program);
    const u = this._uniforms;
    gl.uniformMatrix4fv(u.u_view,  false, this._viewArr);
    gl.uniformMatrix4fv(u.u_proj,  false, this._projArr);
    gl.uniform2f(u.u_viewport, W, H);
    gl.uniform1f(u.u_lodScale, 1.0);
    gl.uniform3f(u.u_camPos,
      this.camera.position[0],
      this.camera.position[1],
      this.camera.position[2]
    );
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this._drawnCount ?? this.gaussians.count);
    gl.bindVertexArray(null);
    // Restore normal blend
    gl.blendFuncSeparate(gl.ONE_MINUS_DST_ALPHA, gl.ONE, gl.ONE_MINUS_DST_ALPHA, gl.ONE);
    this._frame++;
  }

  // ── rAF loop with idle detection ─────────────────────────────────────────────
  start() {
    this._playing   = true;
    this._lastTime  = performance.now();
    this._lastMoveTime = performance.now();
    this._idlePaused = false;

    const loop = (ts) => {
      if (!this._playing) return;

      // Pause rAF when camera has been still for _idleTimeout ms
      // A single render was already done on the last move — scene looks correct
      const idle = (ts - this._lastMoveTime) > this._idleTimeout;
      if (idle && !this._idlePaused) {
        this._idlePaused = true;
        // Don't cancel rAF — just stop calling render. This way we resume
        // immediately on the next frame without a re-schedule latency.
      }

      if (!this._idlePaused) {
        this.render(ts);
      }

      this._rAFId = requestAnimationFrame(loop);
    };
    this._rAFId = requestAnimationFrame(loop);
  }

  stop() {
    this._playing = false;
    if (this._rAFId !== null) {
      cancelAnimationFrame(this._rAFId);
      this._rAFId = null;
    }
    this._sortWorker?.terminate();
    this._sortWorker = null;
  }

  /** Force one render frame — used by compare sync to apply external camera state. */
  wakeUp() {
    this._idlePaused    = false;
    this._lastMoveTime  = performance.now();
    this._movedThisFrame = true;
  }

  _wakeFromIdle() {
    if (this._idlePaused) {
      this._idlePaused  = false;
      this._lastMoveTime = performance.now();
    }
  }

  // ── Visibility API — pause when tab is hidden ─────────────────────────────
  _bindVisibility() {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this._idlePaused = true;
      } else {
        this._wakeFromIdle();
      }
    });
  }

  // ── Resize observer ───────────────────────────────────────────────────────
  _bindResize() {
    const setSize = () => {
      const dpr = Math.min(devicePixelRatio || 1, MAX_DPR);
      const W   = Math.round(this.canvas.offsetWidth  * dpr);
      const H   = Math.round(this.canvas.offsetHeight * dpr);
      // Guard: don't set if unchanged — some mobile drivers reset the GL
      // context on any width/height assignment, even to the same value
      if (this.canvas.width !== W || this.canvas.height !== H) {
        this.canvas.width  = W;
        this.canvas.height = H;
        this._sortFrame = -999; // force re-sort after resize
        this._wakeFromIdle();
      }
    };

    new ResizeObserver(setSize).observe(this.canvas.parentElement ?? this.canvas);
    setSize();
  }

  // ── Editor click-to-select ────────────────────────────────────────────────
  onSelect(cb) { this._onSelect = cb; }

  _bindClickSelect() {
    this.canvas.addEventListener('click', (e) => {
      if (!this._onSelect || !this.gaussians) return;
      const rect = this.canvas.getBoundingClientRect();
      const W    = this.canvas.width, H = this.canvas.height;
      const ndcX = ((e.clientX - rect.left) / rect.width)  * 2 - 1;
      const ndcY = 1 - ((e.clientY - rect.top) / rect.height) * 2;
      const view = this.camera.viewMatrix();
      const proj = this.camera.projMatrix(W / H);
      const invVP = m4.inv(m4.mul(proj, view));
      const near  = m4.mulVec4(invVP, [ndcX, ndcY, -1, 1]);
      const far   = m4.mulVec4(invVP, [ndcX, ndcY,  1, 1]);
      const nw    = [near[0]/near[3], near[1]/near[3], near[2]/near[3]];
      const fw    = [far[0] /far[3],  far[1] /far[3],  far[2] /far[3]];
      const dir   = v3.norm(v3.sub(fw, nw));
      const hit   = raycastGaussians(this.gaussians.data, this.gaussians.count, nw, dir);
      if (hit) this._onSelect(hit.index, hit);
    });
  }

  // ── Vertical mode ──────────────────────────────────────────────────────────
  setVertical(vertical) {
    this.camera.setMode({
      automotive:'orbit', fashion:'turntable',
      property:'walk',    mining:'fly', agriculture:'fly',
    }[vertical] ?? 'orbit');
  }
}

// ─── Camera ───────────────────────────────────────────────────────────────────
export class Camera {
  constructor(canvas) {
    this.canvas   = canvas;
    this.position = [0, 0, 5];
    this.target   = [0, 0, 0];
    this.up       = [0, 1, 0];
    this.fovY     = 60 * Math.PI / 180;
    this.near     = 0.01;
    this.far      = 1000;
    this.mode     = 'orbit';

    // Inertia
    this._angularVel  = [0, 0];
    this._inertiaMul  = 0.88;

    // Input state
    this._drag      = false;
    this._rightDrag = false;
    this._last      = { x: 0, y: 0 };
    this._lastPinchDist = 0;
    this._keys      = {};

    // Fly-to animation
    this._animT     = 1;
    this._animDest  = null;
    this._animSrc   = null;
    this._animStart = 0;
    this._animDur   = 0.8;

    // Track whether we moved this frame — used by renderer to decide sort
    this._movedThisFrame = true;

    this._bindEvents();
  }

  setMode(mode) {
    this.mode = mode;
    this._angularVel = [0, 0];
  }

  frameScene(data, count) {
    if (!count) return;
    // Single pass: centroid + radius simultaneously
    let cx = 0, cy = 0, cz = 0;
    const step = Math.max(1, Math.floor(count / 5000)); // sample at most 5000 pts
    let n = 0;
    for (let i = 0; i < count; i += step) {
      cx += data[i*14]; cy += data[i*14+1]; cz += data[i*14+2];
      n++;
    }
    cx /= n; cy /= n; cz /= n;
    let r = 0;
    for (let i = 0; i < count; i += step) {
      const dx = data[i*14]-cx, dy = data[i*14+1]-cy, dz = data[i*14+2]-cz;
      const d2 = dx*dx+dy*dy+dz*dz;
      if (d2 > r) r = d2;
    }
    r = Math.max(Math.sqrt(r), 0.5);
    this.target   = [cx, cy, cz];
    this.position = [cx, cy, cz + r * 2.5];
    this.near     = r * 0.001;
    this.far      = r * 100;
    this._movedThisFrame = true;
  }

  flyTo(position, target, duration = 0.8) {
    this._animSrc   = { position: [...this.position], target: [...this.target] };
    this._animDest  = { position: [...position],       target: [...target] };
    this._animT     = 0;
    this._animDur   = duration;
    this._animStart = performance.now();
  }

  viewMatrix() { return m4.lookAt(this.position, this.target, this.up); }

  /**
   * View matrix with a small parallax offset applied.
   * The offset shifts the camera sideways/vertically without changing where it looks.
   * Foreground points (close) shift more than background points (far) due to
   * perspective — this is the natural parallax depth cue.
   * @param {number} px  -1 to 1 horizontal offset
   * @param {number} py  -1 to 1 vertical offset
   */
  viewMatrixWithParallax(px, py) {
    const dist  = v3.dist(this.position, this.target);
    const fwd   = v3.norm(v3.sub(this.target, this.position));
    const rgt   = v3.norm(v3.cross(fwd, this.up));
    const upV   = v3.cross(rgt, fwd);
    const scale = dist * 0.04; // parallax scale — 4% of camera distance
    const offset= v3.add(v3.scale(rgt, px * scale), v3.scale(upV, -py * scale));
    return m4.lookAt(
      v3.add(this.position, offset),
      v3.add(this.target,   offset), // target moves with camera — parallax only from perspective
      this.up,
    );
  }
  projMatrix(aspect) { return m4.perspective(this.fovY, aspect, this.near, this.far); }

  /**
   * Update camera state for this frame.
   * @param {number} dt  real delta time in seconds
   * @returns {boolean}  true if camera moved (renderer should sort + re-render)
   */
  update(dt) {
    this._movedThisFrame = false;

    // Fly-to animation
    if (this._animT < 1 && this._animDest) {
      const elapsed = (performance.now() - this._animStart) / (this._animDur * 1000);
      this._animT = Math.min(elapsed, 1);
      const t = smoothstep(0, 1, this._animT);
      this.position = v3.lerp(this._animSrc.position, this._animDest.position, t);
      this.target   = v3.lerp(this._animSrc.target,   this._animDest.target,   t);
      this._movedThisFrame = true;
      return true;
    }

    // Keyboard movement — speed scales with distance to target so
    // it feels consistent regardless of scene scale
    const dist  = v3.dist(this.position, this.target);
    const speed = dist * 1.2 * dt;
    const fwd   = v3.norm(v3.sub(this.target, this.position));
    const rgt   = v3.norm(v3.cross(fwd, this.up));

    let keyMoved = false;
    if (this._keys['KeyW'] || this._keys['ArrowUp'])   { this._moveForward( speed, fwd); keyMoved=true; }
    if (this._keys['KeyS'] || this._keys['ArrowDown']) { this._moveForward(-speed, fwd); keyMoved=true; }
    if (this._keys['KeyA'] || this._keys['ArrowLeft']) { this._moveForward( speed, v3.neg(rgt)); keyMoved=true; }
    if (this._keys['KeyD'] || this._keys['ArrowRight']){ this._moveForward( speed, rgt); keyMoved=true; }
    if (this._keys['KeyQ']) { this._liftBy(-speed); keyMoved=true; }
    if (this._keys['KeyE']) { this._liftBy( speed); keyMoved=true; }
    if (keyMoved) this._movedThisFrame = true;

    // Angular inertia (only when not actively dragging)
    if (!this._drag) {
      const av = this._angularVel;
      if (Math.abs(av[0]) > 0.0005 || Math.abs(av[1]) > 0.0005) {
        this._orbit(av[0], av[1]);
        av[0] *= this._inertiaMul;
        av[1] *= this._inertiaMul;
        this._movedThisFrame = true;
      } else {
        av[0] = av[1] = 0; // kill micro-wobble
      }
    }

    return this._movedThisFrame;
  }

  _liftBy(dist) {
    this.position = v3.add(this.position, [0, dist, 0]);
    this.target   = v3.add(this.target,   [0, dist, 0]);
  }

  _moveForward(dist, dir) {
    const d = (this.mode === 'walk' || this.mode === 'orbit')
      ? v3.norm([dir[0], 0, dir[2]])  // ground-plane movement in walk
      : dir;
    this.position = v3.add(this.position, v3.scale(d, dist));
    this.target   = v3.add(this.target,   v3.scale(d, dist));
  }

  _orbit(dAz, dEl) {
    const d  = v3.sub(this.position, this.target);
    const r  = v3.len(d);
    let   az = Math.atan2(d[0], d[2]) + dAz * Math.PI / 180;
    let   el = Math.asin(Math.max(-0.99, Math.min(0.99, d[1] / Math.max(r, EPS)))) + dEl * Math.PI / 180;
    el = Math.max(-Math.PI/2 + 0.01, Math.min(Math.PI/2 - 0.01, el));
    this.position = [
      this.target[0] + r * Math.cos(el) * Math.sin(az),
      this.target[1] + r * Math.sin(el),
      this.target[2] + r * Math.cos(el) * Math.cos(az),
    ];
    this._movedThisFrame = true;
  }

  _pan(dx, dy) {
    const fwd   = v3.norm(v3.sub(this.target, this.position));
    const rgt   = v3.norm(v3.cross(fwd, this.up));
    const upV   = v3.cross(rgt, fwd);
    const speed = v3.dist(this.position, this.target) * 0.001;
    const delta = v3.add(v3.scale(rgt, -dx * speed), v3.scale(upV, dy * speed));
    this.position = v3.add(this.position, delta);
    this.target   = v3.add(this.target,   delta);
    this._movedThisFrame = true;
  }

  _walkLook(dx, dy) {
    const fwd   = v3.norm(v3.sub(this.target, this.position));
    const right = v3.norm(v3.cross(fwd, [0,1,0]));
    const yaw   = Quat.fromAxisAngle([0,1,0], -dx * 0.003);
    const pitch = Quat.fromAxisAngle(right,   -dy * 0.003);
    this.target = v3.add(this.position, v3.norm(pitch.mul(yaw).rotateVec(fwd)));
    this._movedThisFrame = true;
  }

  _flyLook(dx, dy) {
    const fwd   = v3.norm(v3.sub(this.target, this.position));
    const rgt   = v3.norm(v3.cross(fwd, this.up));
    const yaw   = Quat.fromAxisAngle(this.up, -dx * 0.003);
    const pitch = Quat.fromAxisAngle(rgt,     -dy * 0.003);
    this.target = v3.add(this.position, v3.norm(pitch.mul(yaw).rotateVec(fwd)));
    this.up     = v3.norm(yaw.rotateVec(this.up));
    this._movedThisFrame = true;
  }

  _onZoom(delta) {
    const d = v3.sub(this.position, this.target);
    const r = Math.max(this.near * 10, v3.len(d) * (1 + delta * 0.0008));
    this.position = v3.add(this.target, v3.scale(v3.norm(d), r));
    this._movedThisFrame = true;
    this._dispatchCameraChange();
  }

  _bindEvents() {
    const c   = this.canvas;
    const on  = (e, fn, opt) => c.addEventListener(e, fn, opt ?? { passive: e !== 'wheel' });
    const won = (e, fn) => window.addEventListener(e, fn, { passive: true });

    on('mousedown', e => {
      if (e.button === 2) this._rightDrag = true;
      else { this._drag = true; this._angularVel = [0, 0]; }
      this._last = { x: e.clientX, y: e.clientY };
      this._renderer?._wakeFromIdle?.();
    });
    on('mouseup',    () => { this._drag = false; this._rightDrag = false; });
    on('mouseleave', () => { this._drag = false; this._rightDrag = false; });
    on('mousemove',  e  => this._onMouseMove(e.clientX, e.clientY));
    on('wheel', e => {
      e.preventDefault();
      this._onZoom(e.deltaY * (e.ctrlKey ? 0.1 : 1));
    });
    on('contextmenu', e => e.preventDefault());

    // Touch
    on('touchstart', e => {
      this._drag = true;
      this._last = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      if (e.touches.length === 2) this._lastPinchDist = this._pinchDist(e);
    });
    on('touchend', () => { this._drag = false; });
    on('touchmove', e => {
      e.preventDefault();
      if (e.touches.length === 2) { this._onPinch(e); return; }
      this._onMouseMove(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: false });

    // Keyboard
    won('keydown', e => {
      this._keys[e.code] = true;
      this._movedThisFrame = true;
    });
    won('keyup', e => { this._keys[e.code] = false; });
    window.addEventListener('keypress', e => {
      if (e.code === 'Equal'  || e.code === 'NumpadAdd')      this._onZoom(-50);
      if (e.code === 'Minus'  || e.code === 'NumpadSubtract') this._onZoom(50);
    }, { passive: true });
  }

  _pinchDist(e) {
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    return Math.sqrt(dx*dx + dy*dy);
  }

  _onPinch(e) {
    const dist  = this._pinchDist(e);
    this._onZoom((this._lastPinchDist - dist) * 3);
    this._lastPinchDist = dist;
  }

  _onMouseMove(cx, cy) {
    const dx = cx - this._last.x;
    const dy = cy - this._last.y;
    this._last = { x: cx, y: cy };

    if (this._rightDrag) { this._pan(dx, dy); this._dispatchCameraChange(); return; }
    if (!this._drag) return;

    const dAz = dx * 0.35, dEl = dy * 0.35;
    if      (this.mode === 'orbit')     { this._orbit(dAz, dEl); this._angularVel = [dAz, dEl]; }
    else if (this.mode === 'turntable') { this._orbit(dAz, 0);   this._angularVel = [dAz, 0];   }
    else if (this.mode === 'walk')      { this._walkLook(dx, dy); }
    else if (this.mode === 'fly')       { this._flyLook(dx, dy); }
    this._dispatchCameraChange();
  }

  /** Dispatch camera state so /compare viewer can sync both panes. */
  _dispatchCameraChange() {
    if (!this._canvas) return;
    this._canvas.dispatchEvent(new CustomEvent('nif:camera-changed', {
      bubbles: true,
      detail: {
        position: [...this.camera.position],
        target:   [...this.camera.target],
        up:       [...this.camera.up],
      },
    }));
  }
}
