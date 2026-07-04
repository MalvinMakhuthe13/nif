/**
 * NIFViewer — Complete Load & Playback Pipeline
 * © Fumoca Technologies · fumoca.co.za
 *
 * Full pipeline:
 *   1. Fetch NIF metadata from API
 *   2. Get signed R2 stream URL
 *   3. Fetch .nif binary
 *   4. Parse binary → PROXY_VIDEO chunk + depth field data
 *   5. Mount NIFPreviewSystem → plays proxy video (looks like a regular video)
 *   6. User taps → NIFTransition fires (4 stages)
 *   7. NIFRenderer takes over → 60fps interactive scene
 *
 * The proxy video path means:
 *   - On social media: shares as a normal video (platform renders it natively)
 *   - On fumoca viewer / embed: plays as video, then goes 4D on tap
 */

import { NIFRenderer }      from './renderer/NIFRenderer.js';
import { NIFPreviewSystem } from './preview/NIFPreviewSystem.js';
import { CHUNK, ENCODER_TIER } from '../../core/format/NIFSpec.js';

export class NIFViewer {
  /**
   * @param {HTMLElement}  container  — any div; viewer mounts canvas inside it
   * @param {object}       opts
   *   nifId      string    NIF UUID
   *   token      string    Supabase JWT or license key
   *   license    string    License key (for embed access)
   *   api        string    API base URL
   *   autoplay   boolean   Auto-trigger transition after autoplayDelay ms
   *   autoplayDelay number ms before auto-trigger (default 3000)
   *   onReady    function  Called when 4D scene is live
   *   onError    function  Called on any failure
   *   onStage    function(stageName) Called at each transition stage
   */
  constructor(container, opts = {}) {
    // Accept either a container element or a canvas (legacy support)
    if (container instanceof HTMLCanvasElement) {
      this._legacyCanvas = container;
      container = container.parentElement ?? document.body;
    }
    this.container    = container;
    this.nifId        = opts.nifId;
    this.authToken    = opts.token    ?? null;
    this.licenseKey   = opts.license  ?? null;
    this.api          = opts.api      ?? 'https://fumoca.co.za/api';
    this.autoplay     = opts.autoplay ?? false;
    this.autoplayDelay= opts.autoplayDelay ?? 3000;
    this.onReady      = opts.onReady  ?? (() => {});
    this.onError      = opts.onError  ?? (e => console.error('[NIFViewer]', e));
    this.onStage      = opts.onStage  ?? (() => {});

    this._renderer   = null;
    this._preview    = null;
    this._canvas     = null;
    this._reader     = null;
    this._gaussians  = null;
    this._vertical   = 'generic';
    this._meta       = null;
    this._state      = 'idle'; // idle | loading | preview | transition | live | error
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  get state()    { return this._state; }
  get meta()     { return this._meta; }
  get renderer() { return this._renderer; }

  async load() {
    try {
      this._setState('loading');

      // 1. Stream URL
      const streamUrl = await this._getStreamUrl();

      // 2. Fetch .nif
      const nifBytes  = await this._fetchNIF(streamUrl);

      // 3. Parse
      const { reader, gaussians, depthMap, alphaMask, layers, vertical, meta } = await this._parseNIF(nifBytes);
      this._reader   = reader;
      this._gaussians= gaussians;
      this._vertical = vertical;
      this._meta     = meta;

      // 3b. Encoder certificate check
      // Files without a valid CERT chunk are UNCERTIFIED — viewer shows fumoca watermark.
      // Files with a valid cert from tier DEVELOPER and above show the clean viewer.
      // This check is client-side for UX speed; the API embed-log does server-side validation.
      const tier = reader.getEncoderTier?.() ?? ENCODER_TIER.UNCERTIFIED;
      this._encoderTier = tier;
      if (tier === ENCODER_TIER.UNCERTIFIED) {
        this._showEncoderWatermark();
      }

      // 4. Build GL canvas (hidden initially — preview shows on top)
      this._canvas = this._buildCanvas();

      // 5. Try to init renderer now (so it's ready for transition stage 3-4)
      //    This can run while the proxy video is playing — no wasted time.
      let rendererReady = false;
      try {
        this._renderer = new NIFRenderer(this._canvas);
        this._renderer.loadGaussians(gaussians);
        // Expose on window so compare viewer camera sync can reach it
        if (typeof window !== 'undefined') window._nifRenderer = this._renderer;
        // Load depth/layer data if present — enables foreground/background separation
        if (layers?.length)  this._renderer.loadLayers(layers);
        if (depthMap)        this._renderer.loadDepthMap(depthMap);
        if (alphaMask)       this._renderer.loadAlphaMask(alphaMask);
        this._renderer.setVertical(vertical);
        rendererReady = true;
      } catch (e) {
        // WebGL2 not available — will stay in proxy video mode
        console.warn('[NIFViewer] WebGL2 unavailable:', e.message);
      }

      // 6. Mount preview system
      this._preview = new NIFPreviewSystem(this.container, {
        vertical:         vertical,
        autoplay:         this.autoplay,
        autoplayDelay:    this.autoplayDelay,
        onTransitionStart:(stage) => {
          this._setState('transition');
          this.onStage(stage);
          // Ensure renderer is not drawing yet — transition controls the canvas
          this._renderer?.stop();
        },
        onTransitionEnd:  () => {
          if (rendererReady) {
            this._startRenderer();
          } else {
            // WebGL2 failed — show error or keep video
            this._setState('error');
            this.onError(new Error('WebGL2 not available — 4D view not possible'));
          }
        },
        onError: (err) => { this._setState('error'); this.onError(err); },
      });

      // Provide the renderer's render function to the transition for stage 3-4
      if (rendererReady) {
        this._preview.setGaussianRenderFn((opacity) => {
          // Called during crystallisation + solidification stages
          // Render one frame at given opacity without starting the loop
          this._renderer.renderOnce?.(opacity) ?? this._renderer.render();
        });
      }

      this._setState('preview');
      await this._preview.mount({ reader, gaussians }, this._canvas);

    } catch (err) {
      this._setState('error');
      this.onError(err);
      throw err;
    }
  }

  // Programmatically trigger the transition (useful for autoplay)
  trigger() {
    this._preview?._triggerTransition();
  }

  stop() {
    this._renderer?.stop();
    this._preview?.destroy();
  }

  setVertical(vertical) {
    this._vertical = vertical;
    this._renderer?.setVertical(vertical);
  }

  // ── Internal ───────────────────────────────────────────────────────────────
  _setState(state) {
    this._state = state;
  }

  _buildCanvas() {
    const canvas = this._legacyCanvas ?? document.createElement('canvas');
    if (!this._legacyCanvas) {
      canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:none;touch-action:none';
      // Container must be positioned
      if (getComputedStyle(this.container).position === 'static') {
        this.container.style.position = 'relative';
      }
      this.container.appendChild(canvas);
    }
    return canvas;
  }

  _startRenderer() {
    this._canvas.style.display = 'block';
    this._renderer.start();
    this._setState('live');
    this._canvas.dispatchEvent(new CustomEvent('nif:ready', {
      bubbles: true,
      detail: { nifId: this.nifId, vertical: this._vertical, gaussianCount: this._gaussians.count },
    }));
    this.onReady({
      nifId:         this.nifId,
      vertical:      this._vertical,
      gaussianCount: this._gaussians.count,
      meta:          this._meta,
    });
  }

  async _getStreamUrl() {
    const headers = {};
    if (this.authToken) headers['Authorization'] = `Bearer ${this.authToken}`;
    const params = new URLSearchParams();
    if (this.licenseKey) params.set('license', this.licenseKey);
    const res  = await fetch(`${this.api}/nif/${this.nifId}/stream?${params}`, { headers });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `Stream URL error: ${res.status}`);
    return data.url;
  }

  async _fetchNIF(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`R2 fetch failed: ${res.status} ${res.statusText}`);
    return await res.arrayBuffer();
  }

  async _parseNIF(arrayBuffer) {
    // Uses DataView — works identically in browser and Node.js
    const dv   = new DataView(arrayBuffer);
    const magic= dv.getUint32(0, false);
    if (magic !== 0x4E494600) throw new Error('Invalid .nif file — wrong magic bytes');

    const vMaj      = dv.getUint8(4);
    const vMin      = dv.getUint8(5);
    const vertical  = _readAscii(dv, 72, 24);
    const frameCount= dv.getUint16(18, false);
    const duration  = dv.getFloat32(20, false);

    const meta = { version:`${vMaj}.${vMin}`, vertical, frameCount, duration };

    // Parse all chunks
    const chunks = [];
    let offset   = 256;
    while (offset < arrayBuffer.byteLength) {
      if (offset + 16 > arrayBuffer.byteLength) break;
      const type  = dv.getUint16(offset,     false);
      const codec = dv.getUint8 (offset + 2);
      const size  = dv.getUint32(offset + 4, false);
      const crc   = dv.getUint32(offset + 8, false);
      if (size === 0 || offset + 16 + size > arrayBuffer.byteLength) break;
      // Raw slice — may be compressed
      const rawData = arrayBuffer.slice(offset + 16, offset + 16 + size);
      chunks.push({ type, codec, size, crc, rawData });
      offset += 16 + size;
    }

    // Async chunk accessor — decompresses on first access
    // codec 0x00 = raw, 0x02 = gzip (browser-native DecompressionStream)
    const decompressed = new Map();
    const getChunk = async (type) => {
      const c = chunks.find(c => c.type === type);
      if (!c) return null;
      if (decompressed.has(type)) return { ...c, data: decompressed.get(type) };
      let data;
      if (c.codec === 0x00) {
        // Raw — use directly
        data = c.rawData;
      } else if (c.codec === 0x02 && typeof DecompressionStream !== 'undefined') {
        // Gzip — decompress using browser-native stream API
        try {
          const ds     = new DecompressionStream('gzip');
          const writer = ds.writable.getWriter();
          const reader = ds.readable.getReader();
          writer.write(new Uint8Array(c.rawData));
          writer.close();
          const parts = []; let total = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            parts.push(value); total += value.length;
          }
          const out = new Uint8Array(total); let off2 = 0;
          for (const p of parts) { out.set(p, off2); off2 += p.length; }
          data = out.buffer;
        } catch (e) {
          console.warn('[NIFViewer] Decompression failed for chunk', type, '—', e.message);
          data = c.rawData;
        }
      } else {
        data = c.rawData;  // unknown codec — try raw
      }
      decompressed.set(type, data);
      return { ...c, data };
    };

    // Synchronous accessor for chunks that are known to be uncompressed (proxy video)
    const getChunkSync = (type) => {
      const c = chunks.find(c => c.type === type);
      return c ? { ...c, data: c.rawData } : null;
    };

    // ── Full geometry — decoded via NIFSpec (handles quantised + raw formats) ──
    const geoChunk = await getChunk(CHUNK.KEYFRAME_GEO);
    if (!geoChunk) throw new Error('NIF has no KEYFRAME_GEO chunk — reconstruction incomplete');

    // Build a minimal NIFReader stub so we can reuse getGeometry()
    // which handles both quantised (0x01) and raw float32 (0x00) formats
    const _stubReader = { chunks: [{ type: CHUNK.KEYFRAME_GEO, data: new Uint8Array(geoChunk.data) }] };
    _stubReader.getChunk = (t) => _stubReader.chunks.find(c => c.type === t) ?? null;

    // Inline decode — same logic as NIFSpec.getGeometry() but without the import cycle
    const geoFlag  = new Uint8Array(geoChunk.data)[0];
    const geoDV    = new DataView(geoChunk.data);
    const count    = geoDV.getUint32(1, false);   // byte 1, big-endian (flag is byte 0)
    let   geoData;

    if (geoFlag === 0x00) {
      // Raw float32 (legacy / fallback)
      geoData = new Float32Array(geoChunk.data, 5, count * 14);
    } else if (geoFlag === 0x01) {
      // Quantised — decode back to float32 for the renderer
      const u8      = new Uint8Array(geoChunk.data);
      const bbMinX  = geoDV.getFloat32(5,  false);
      const bbMinY  = geoDV.getFloat32(9,  false);
      const bbMinZ  = geoDV.getFloat32(13, false);
      const bbMaxX  = geoDV.getFloat32(17, false);
      const bbMaxY  = geoDV.getFloat32(21, false);
      const bbMaxZ  = geoDV.getFloat32(25, false);
      const rangeX  = bbMaxX - bbMinX;
      const rangeY  = bbMaxY - bbMinY;
      const rangeZ  = bbMaxZ - bbMinZ;
      const SM = -8.0, SR = 10.0;
      geoData = new Float32Array(count * 14);
      let base = 29;
      for (let i = 0; i < count; i++) {
        const o  = i * 14;
        const px = geoDV.getInt16(base,     false);
        const py = geoDV.getInt16(base + 2, false);
        const pz = geoDV.getInt16(base + 4, false);
        geoData[o+0] = ((px+32767)/65534)*rangeX+bbMinX;
        geoData[o+1] = ((py+32767)/65534)*rangeY+bbMinY;
        geoData[o+2] = ((pz+32767)/65534)*rangeZ+bbMinZ;
        geoData[o+3] = (u8[base+6] /255)*SR+SM;
        geoData[o+4] = (u8[base+7] /255)*SR+SM;
        geoData[o+5] = (u8[base+8] /255)*SR+SM;
        const qw=geoDV.getInt8(base+9),qx=geoDV.getInt8(base+10);
        const qy=geoDV.getInt8(base+11),qz=geoDV.getInt8(base+12);
        geoData[o+6]=qw/127; geoData[o+7]=qx/127; geoData[o+8]=qy/127; geoData[o+9]=qz/127;
        const opS=u8[base+13]/255;
        geoData[o+10]=Math.log(Math.max(opS,1e-6)/Math.max(1-opS,1e-6));
        const r=u8[base+14]/255,g=u8[base+15]/255,b=u8[base+16]/255;
        geoData[o+11]=Math.log(Math.max(r,1e-6)/Math.max(1-r,1e-6));
        geoData[o+12]=Math.log(Math.max(g,1e-6)/Math.max(1-g,1e-6));
        geoData[o+13]=Math.log(Math.max(b,1e-6)/Math.max(1-b,1e-6));
        base += 17;
      }
    } else {
      throw new Error(`Unknown geometry format flag: 0x${geoFlag.toString(16)}`);
    }

    const gaussians = { count, data: geoData };

    // ── Depth map — float16 (H×W) ─────────────────────────────────────────────
    let depthMap = null;
    const depthChunk = await getChunk(CHUNK.DEPTH_MAP);
    if (depthChunk) {
      const ddv = new DataView(depthChunk.data);
      const dH  = ddv.getUint16(0, false);
      const dW  = ddv.getUint16(2, false);
      const f16 = new Uint16Array(depthChunk.data, 4, dH * dW);
      const f32 = new Float32Array(dH * dW);
      for (let i = 0; i < f16.length; i++) f32[i] = _f16toF32(f16[i]);
      depthMap = { width: dW, height: dH, data: f32 };
    }

    // ── Alpha mask — uint8 (H×W) ──────────────────────────────────────────────
    let alphaMask = null;
    const alphaChunk = await getChunk(CHUNK.ALPHA_MASK);
    if (alphaChunk) {
      const adv = new DataView(alphaChunk.data);
      const aH  = adv.getUint16(0, false);
      const aW  = adv.getUint16(2, false);
      alphaMask = { width: aW, height: aH, data: new Uint8Array(alphaChunk.data, 4, aH * aW) };
    }

    // ── Layered geometry ──────────────────────────────────────────────────────
    let layers = [];
    const layerChunk = await getChunk(CHUNK.LAYER_GEO);
    if (layerChunk) {
      layers = _parseLayers(layerChunk.data);
    }

    // Reader — NIFPreviewSystem uses getChunkSync for proxy video (uncompressed)
    const reader = { getChunk: getChunkSync };

    return { reader, gaussians, depthMap, alphaMask, layers, vertical, meta };
  }

  // ── Static helpers ─────────────────────────────────────────────────────────
  /**
   * Mount a viewer into any element using data attributes.
   * Used by the embed SDK: just drop in the script tag.
   */
  static autoMount(api = 'https://fumoca.co.za/api') {
    document.querySelectorAll('[data-nif-id]').forEach(el => {
      if (el._nifViewer) return;
      el.style.position = el.style.position || 'relative';
      const viewer = new NIFViewer(el, {
        nifId:         el.dataset.nifId,
        token:         el.dataset.nifToken    ?? null,
        license:       el.dataset.nifLicense  ?? el.dataset.nifToken ?? null,
        api:           el.dataset.nifApi      ?? api,
        autoplay:      el.dataset.nifAutoplay === 'true',
        autoplayDelay: parseInt(el.dataset.nifAutoplayDelay ?? '3000', 10),
      });
      el._nifViewer = viewer;
      viewer.load().catch(err => {
        el.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;min-height:200px;color:#888;font-size:12px;font-family:sans-serif;padding:20px;text-align:center">NIF: ${err.message}</div>`;
      });
    });
  }

  static mount(elementOrId, opts) {
    const el = typeof elementOrId === 'string'
      ? document.getElementById(elementOrId)
      : elementOrId;
    if (!el) throw new Error(`NIFViewer.mount: element not found — ${elementOrId}`);
    const viewer = new NIFViewer(el, opts);
    viewer.load();
    return viewer;
  }

  /** Returns the encoder tier of the currently loaded NIF */
  getEncoderTier() { return this._encoderTier ?? ENCODER_TIER.UNCERTIFIED; }

  /**
   * Show a persistent encoder watermark on uncertified files.
   * This overlays the viewer — visible but unobtrusive.
   * Removed only by loading a certified NIF file.
   */
  _showEncoderWatermark() {
    if (this.container.querySelector('._nif-wm')) return;
    const wm = document.createElement('a');
    wm.className   = '_nif-wm';
    wm.href        = 'https://fumoca.co.za';
    wm.target      = '_blank';
    wm.rel         = 'noopener';
    wm.textContent = '✦ NIF · fumoca.co.za';
    wm.style.cssText = `
      position:absolute;bottom:10px;left:10px;z-index:50;
      background:rgba(0,0,0,0.55);backdrop-filter:blur(6px);
      color:#fff;font-size:10px;font-family:sans-serif;font-weight:600;
      padding:4px 10px;border-radius:100px;
      letter-spacing:0.05em;text-decoration:none;opacity:0.8;
      border:1px solid rgba(255,255,255,0.15);
      transition:opacity .2s;pointer-events:auto;
    `;
    wm.onmouseenter = () => { wm.style.opacity = '1'; };
    wm.onmouseleave = () => { wm.style.opacity = '0.8'; };
    if (getComputedStyle(this.container).position === 'static') {
      this.container.style.position = 'relative';
    }
    this.container.appendChild(wm);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _readAscii(dv, offset, len) {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = dv.getUint8(offset + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

// Float16 → Float32 conversion (no native float16 in JS)
function _f16toF32(h) {
  const s  = (h & 0x8000) >> 15;
  const e  = (h & 0x7C00) >> 10;
  const f  = (h & 0x03FF);
  if (e === 0)   return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  if (e === 31)  return f ? NaN : (s ? -Infinity : Infinity);
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

// Parse LAYER_GEO chunk into array of {label, depthMin, depthMax, count, data}
// Uses a copy-based approach to avoid Float32Array alignment issues
// (variable-length ASCII labels can leave the data at non-multiple-of-4 offsets)
function _parseLayers(arrayBuffer) {
  const dv      = new DataView(arrayBuffer);
  const nLayers = dv.getUint32(0, false);
  const layers  = [];
  let   offset  = 4;

  for (let i = 0; i < nLayers; i++) {
    if (offset + 1 > dv.byteLength) break;
    const labelLen = dv.getUint8(offset); offset += 1;
    let   label    = '';
    for (let j = 0; j < labelLen; j++) {
      label += String.fromCharCode(dv.getUint8(offset++));
    }
    if (offset + 12 > dv.byteLength) break;
    const depthMin = dv.getFloat32(offset, false); offset += 4;
    const depthMax = dv.getFloat32(offset, false); offset += 4;
    const nPoints  = dv.getUint32 (offset, false); offset += 4;
    const byteLen  = nPoints * 14 * 4;
    if (offset + byteLen > dv.byteLength) break;

    // Copy into a new aligned Float32Array — avoids alignment errors
    // when offset is not a multiple of 4 due to variable-length label
    const raw  = new Uint8Array(arrayBuffer, offset, byteLen);
    const copy = new ArrayBuffer(byteLen);
    new Uint8Array(copy).set(raw);
    const data = new Float32Array(copy);

    offset += byteLen;
    layers.push({ label, depthMin, depthMax, count: nPoints, data });
  }
  return layers;
}

// Auto-mount when loaded as a script tag
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => NIFViewer.autoMount());
}
