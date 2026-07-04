/**
 * NIFPresentationExporter — Frame-by-Frame Video Export Pipeline
 * © Fumoca Technologies · fumoca.co.za
 *
 * Renders every frame of the presentation at the requested resolution and
 * encodes them into an MP4 using the WebCodecs VideoEncoder API
 * (Chrome 94+, Edge 94+). Falls back to a server-side ffmpeg pipeline
 * for Firefox / Safari by posting raw JPEG frames to the API.
 *
 * Pipeline:
 *   1. Clone NIFRenderer into an OffscreenCanvas at export resolution
 *   2. For each frame t in [0, duration*fps]:
 *      a. Set camera to NIFCameraPathRecorder.getCameraAt(t)
 *      b. renderer.renderOnce() → draws Gaussians at this camera position
 *      c. NIFHotspotLayer.renderToCanvas(2dCtx, camera, t) → overlays labels
 *      d. Draw logo + watermark
 *      e. Encode via VideoEncoder (WebCodecs) or collect as JPEG
 *   3. Mux frames into .mp4 using mp4-muxer (bundled)
 *   4. Upload finished .mp4 to R2 via API
 *   5. Return { r2Key, downloadUrl }
 *
 * Server fallback:
 *   POST /api/presentations/:id/export/frames  { frames: base64[] }
 *   The API assembles with ffmpeg server-side and returns the R2 key.
 *
 * Memory management:
 *   Frames are encoded and flushed in batches of 30 to avoid OOM on mobile.
 *
 * Integration:
 *   const exporter = new NIFPresentationExporter({ nifId, token, api });
 *   await exporter.export({ presentation, renderer, hotspots, camera, onProgress });
 */

const RESOLUTIONS = {
  '1280x720':   { w: 1280, h: 720 },
  '1920x1080':  { w: 1920, h: 1080 },
  '3840x2160':  { w: 3840, h: 2160 },
  '1080x1920':  { w: 1080, h: 1920 },
  '1080x1080':  { w: 1080, h: 1080 },
};

const BATCH_SIZE   = 30;   // frames per flush
const JPEG_QUALITY = 0.92;

export class NIFPresentationExporter {
  /**
   * @param {object} opts
   *   nifId  string
   *   token  string  Supabase JWT
   *   api    string
   */
  constructor(opts = {}) {
    this._nifId = opts.nifId;
    this._token = opts.token;
    this._api   = opts.api ?? 'https://fumoca.co.za/api';
    this._abort = false;
  }

  destroy() {
    this._abort = true;
  }

  /**
   * @param {object} opts
   *   presentation  — full presentation config from NIFPresentationEditor
   *   renderer      — NIFRenderer instance (will be used read-only)
   *   onProgress    — (pct:number, stage:string) => void
   * @returns {Promise<{r2Key:string, downloadUrl:string}>}
   */
  async export({ presentation, renderer, audioLayer = null, onProgress = () => {} }) {
    this._abort = false;

    const resKey     = presentation.resolution ?? '1920x1080';
    const codecPref  = presentation.codec       ?? 'h264';
    const { w, h }   = RESOLUTIONS[resKey] ?? RESOLUTIONS['1920x1080'];
    const totalFrames= Math.round(presentation.duration * presentation.fps);
    const useWebCodecs = _supportsWebCodecs() && codecPref !== 'prores';

    onProgress(0, 'Preparing renderer…');

    // ── 1. Build an OffscreenCanvas at export resolution ─────────────────────
    let exportCanvas;
    try {
      exportCanvas = new OffscreenCanvas(w, h);
    } catch {
      // Safari fallback: regular canvas hidden off-screen
      exportCanvas = document.createElement('canvas');
      exportCanvas.width  = w;
      exportCanvas.height = h;
      exportCanvas.style.cssText = 'position:fixed;left:-99999px;top:0;visibility:hidden;';
      document.body.appendChild(exportCanvas);
    }

    // ── 2. Init WebCodecs encoder or fallback frame buffer ────────────────────
    let encoder    = null;
    let muxer      = null;
    let frameBuffer= [];   // for server fallback

    if (useWebCodecs) {
      const result = await _initWebCodecsEncoder(exportCanvas, w, h, presentation.fps, codecPref);
      encoder = result.encoder;
      muxer   = result.muxer;
    }

    onProgress(2, 'Starting render…');

    // ── 3. Render frames ──────────────────────────────────────────────────────
    // We call renderer.renderOnce() which renders to the renderer's own canvas,
    // then blit to exportCanvas. This avoids needing a second GL context.
    const exportCtx2d = exportCanvas.getContext?.('2d') ??
                        exportCanvas.getContext('2d');

    for (let frame = 0; frame < totalFrames; frame++) {
      if (this._abort) throw new Error('Export cancelled');

      const t       = (frame / (totalFrames - 1)) * presentation.duration;
      const camState = presentation.cameraPath
        ? _interpolatePath(presentation.cameraPath, t)
        : _autoOrbit(t, presentation.duration);

      // Apply camera state to renderer
      _applyCameraState(renderer, camState);

      // Render Gaussians (single frame, no loop)
      if (renderer.renderOnce) {
        renderer.renderOnce(1.0);
      } else {
        renderer.render?.();
      }

      // Blit renderer canvas → export canvas
      if (exportCtx2d) {
        exportCtx2d.clearRect(0, 0, w, h);

        // Background colour fill
        if (presentation.bgOpacity > 0) {
          exportCtx2d.fillStyle = _hexWithAlpha(presentation.bgColor, presentation.bgOpacity);
          exportCtx2d.fillRect(0, 0, w, h);
        }

        // Blit renderer GL canvas
        const glCanvas = renderer.canvas ?? renderer._canvas;
        if (glCanvas) {
          exportCtx2d.drawImage(glCanvas, 0, 0, w, h);
        }

        // Overlay hotspots
        if (presentation.hotspots?.length) {
          const camera = {
            projectionMatrix: renderer._projMatrix ?? _identityMat4(),
            viewMatrix:       renderer._viewMatrix ?? _identityMat4(),
            canvasWidth:  w,
            canvasHeight: h,
          };
          _renderHotspotsToCtx(exportCtx2d, presentation.hotspots, camera, t, w, h);
        }

        // Logo
        if (presentation.logoUrl) {
          await _drawLogo(exportCtx2d, presentation.logoUrl, presentation.logoPosition, w, h);
        }

        // Watermark
        if (presentation.showWatermark) {
          _drawWatermark(exportCtx2d, w, h);
        }
      }

      // Encode frame
      if (useWebCodecs && encoder) {
        const videoFrame = new VideoFrame(exportCanvas, {
          timestamp:  Math.round((frame / presentation.fps) * 1_000_000), // microseconds
          duration:   Math.round((1 / presentation.fps) * 1_000_000),
        });
        encoder.encode(videoFrame, { keyFrame: frame % 30 === 0 });
        videoFrame.close();
      } else {
        // Server fallback: collect JPEG blob
        const blob = await _canvasToJpeg(exportCanvas, JPEG_QUALITY);
        frameBuffer.push(blob);

        // Flush in batches to avoid OOM
        if (frameBuffer.length >= BATCH_SIZE || frame === totalFrames - 1) {
          await this._uploadFrameBatch(presentation.id, frameBuffer, frame, totalFrames);
          frameBuffer = [];
        }
      }

      if (frame % 5 === 0) {
        const pct = 5 + (frame / totalFrames) * 80;
        onProgress(pct, `Rendering frame ${frame + 1} / ${totalFrames}…`);
        await _yield(); // keep UI alive
      }
    }

    onProgress(85, 'Encoding video…');

    // ── 4. Finalise encoder / get blob ────────────────────────────────────────

    // ── Mix audio ──────────────────────────────────────────────────────────────
    let audioWav = null;
    if (audioLayer) {
      onProgress(86, 'Mixing audio…');
      try {
        audioWav = await audioLayer.mixToBuffer(presentation.duration, 48000);
      } catch (err) {
        console.warn('[NIFExporter] Audio mix failed, exporting video-only:', err.message);
      }
    }
    let mp4Blob;

    if (useWebCodecs && encoder && muxer) {
      await encoder.flush();
      encoder.close();
      mp4Blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
    } else if (!useWebCodecs) {
      // Server assembled — get download URL from API
      const res  = await fetch(`${this._api}/presentations/${presentation.id}/export/assemble`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${this._token}`,
        },
        body: JSON.stringify({
          fps:       presentation.fps,
          width:     w,
          height:    h,
          loopType:  presentation.loopType,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Server assembly failed');
      onProgress(100, 'Done');
      exportCanvas.remove?.();
      return { r2Key: data.r2Key, downloadUrl: data.downloadUrl };
    }

    onProgress(90, 'Uploading video…');

    // ── 5. Upload MP4 to R2 via API ────────────────────────────────────────────
    const formData = new FormData();
    formData.append('video', mp4Blob, `presentation-${this._nifId.slice(0,8)}.mp4`);
    formData.append('presentationId', presentation.id ?? '');
    formData.append('nifId',          this._nifId);
    formData.append('duration',       String(presentation.duration));
    formData.append('fps',            String(presentation.fps));
    formData.append('width',          String(w));
    formData.append('height',         String(h));
    formData.append('loopType',       presentation.loopType);
    if (audioWav) {
      formData.append('audio', new Blob([audioWav], { type: 'audio/wav' }), 'audio.wav');
    }

    const upRes  = await fetch(`${this._api}/presentations/${presentation.id}/export/upload`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${this._token}` },
      body:    formData,
    });
    const upData = await upRes.json();
    if (!upRes.ok) throw new Error(upData.error ?? 'Upload failed');

    onProgress(100, 'Export complete');

    exportCanvas.remove?.();

    return {
      r2Key:       upData.r2Key,
      downloadUrl: upData.downloadUrl,
    };
  }

  // ── Private: server-side frame batch upload ──────────────────────────────────

  async _uploadFrameBatch(presentationId, blobs, lastFrame, totalFrames) {
    if (!blobs.length) return;

    // Convert blobs to base64
    const frames = await Promise.all(blobs.map(b => _blobToBase64(b)));

    await fetch(`${this._api}/presentations/${presentationId}/export/frames`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${this._token}`,
      },
      body: JSON.stringify({ frames, lastFrame, totalFrames }),
    });
  }
}

// ── Module helpers ────────────────────────────────────────────────────────────

function _supportsWebCodecs() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

async function _initWebCodecsEncoder(canvas, w, h, fps, codecPref) {
  // mp4-muxer CDN (only loaded at export time)
  if (!window.Muxer) {
    await _loadScript('https://cdn.jsdelivr.net/npm/mp4-muxer@4/build/mp4-muxer.min.js');
  }

  const target = new window.Muxer.ArrayBufferTarget();
  const muxer  = new window.Muxer.Muxer({
    target,
    video: {
      codec: codecPref === 'h265' ? 'avc1' : 'avc1',   // mp4-muxer uses avc1
      width:  w,
      height: h,
    },
    fastStart: 'in-memory',
  });

  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error:  (e) => console.error('[NIFExporter WebCodecs]', e),
  });

  encoder.configure({
    codec:       codecPref === 'h265' ? 'hvc1.1.6.L93.B0' : 'avc1.42001f',
    width:        w,
    height:       h,
    framerate:    fps,
    bitrate:      8_000_000,
    latencyMode: 'quality',
  });

  return { encoder, muxer };
}

function _interpolatePath(path, t) {
  const kfs = path.keyframes ?? [];
  if (!kfs.length) return _autoOrbit(t, path.duration ?? 10);

  const tNorm = Math.max(0, Math.min(t, path.duration ?? 10));
  let i1 = 0;
  for (let i = 0; i < kfs.length - 1; i++) {
    if (kfs[i+1].t >= tNorm) { i1 = i; break; }
    i1 = i;
  }
  const i0 = Math.max(0, i1-1), i2 = Math.min(kfs.length-1, i1+1), i3 = Math.min(kfs.length-1, i1+2);
  const p0 = kfs[i0], p1 = kfs[i1], p2 = kfs[i2], p3 = kfs[i3];
  const segLen = p2.t - p1.t;
  const u = segLen > 0 ? (tNorm - p1.t) / segLen : 0;

  const cr = (v0,v1,v2,v3,t) => {
    const t2=t*t, t3=t2*t;
    return 0.5*((2*v1)+(-v0+v2)*t+(2*v0-5*v1+4*v2-v3)*t2+(-v0+3*v1-3*v2+v3)*t3);
  };

  const crVec = (k, ch) => cr(
    p0[k]?.[ch]??0, p1[k]?.[ch]??0, p2[k]?.[ch]??0, p3[k]?.[ch]??0, u
  );

  // Cartesian keyframe format: {t, position:[x,y,z], target:[x,y,z], up:[x,y,z]}
  return {
    position: [crVec('position',0), crVec('position',1), crVec('position',2)],
    target:   [crVec('target',0),   crVec('target',1),   crVec('target',2)],
    up:       [crVec('up',0),       crVec('up',1),       crVec('up',2)],
  };
}

function _autoOrbit(t, duration) {
  // Slow 360° orbit at radius 5, elevation 25°, around origin
  const az = (t * 0.3 * Math.PI * 2 / 60) % (Math.PI * 2);
  const el = 25 * Math.PI / 180;
  const r  = 5;
  return {
    position: [r * Math.cos(el) * Math.sin(az), r * Math.sin(el), r * Math.cos(el) * Math.cos(az)],
    target:   [0, 0, 0],
    up:       [0, 1, 0],
  };
}

function _applyCameraState(renderer, cam) {
  // NIFRenderer uses position/target/up (Cartesian) — not phi/theta/radius
  if (!renderer || !cam) return;
  if (cam.position) renderer.position = [...cam.position];
  if (cam.target)   renderer.target   = [...cam.target];
  if (cam.up)       renderer.up       = [...cam.up];
  renderer._movedThisFrame = true;
}

function _renderHotspotsToCtx(ctx, hotspots, camera, t, w, h) {
  for (const h of hotspots) {
    if (!h.visible) continue;
    const screen = _worldToScreen(h.worldX, h.worldY, h.worldZ, camera, w, h);
    if (!screen) continue;

    const style = h.style ?? 'pill';
    const color = h.color ?? '#7c6dfa';
    const label = h.label ?? '';
    const fs    = h.fontSize ?? 14;

    ctx.font     = `600 ${fs}px "DM Sans",sans-serif`;
    const tw     = ctx.measureText(label).width;

    if (style === 'pill') {
      const bw = tw + 24, bh = fs + 14;
      ctx.fillStyle   = 'rgba(0,0,0,0.7)';
      _rrect(ctx, screen.x - bw/2, screen.y - bh/2, bw, bh, bh/2);
      ctx.fill();
      ctx.strokeStyle = color; ctx.lineWidth = 1.5;
      _rrect(ctx, screen.x - bw/2, screen.y - bh/2, bw, bh, bh/2);
      ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, screen.x, screen.y);
    } else if (style === 'line') {
      ctx.beginPath(); ctx.moveTo(screen.x, screen.y);
      ctx.lineTo(screen.x + 60, screen.y - 20);
      ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.beginPath(); ctx.arc(screen.x, screen.y, 4, 0, Math.PI*2);
      ctx.fillStyle = color; ctx.fill();
      ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(label, screen.x + 68, screen.y - 20);
    } else {
      // default pill fallback
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, screen.x, screen.y);
    }
  }
}

function _worldToScreen(wx, wy, wz, camera, W, H) {
  const proj = camera.projectionMatrix, view = camera.viewMatrix;
  const vx = view[0]*wx+view[4]*wy+view[8]*wz+view[12];
  const vy = view[1]*wx+view[5]*wy+view[9]*wz+view[13];
  const vz = view[2]*wx+view[6]*wy+view[10]*wz+view[14];
  const vw = view[3]*wx+view[7]*wy+view[11]*wz+view[15];
  const cx = proj[0]*vx+proj[4]*vy+proj[8]*vz+proj[12]*vw;
  const cy = proj[1]*vx+proj[5]*vy+proj[9]*vz+proj[13]*vw;
  const cw = proj[3]*vx+proj[7]*vy+proj[11]*vz+proj[15]*vw;
  if (cw <= 0) return null;
  return { x: (cx/cw*0.5+0.5)*W, y: (1-cy/cw*0.5-0.5)*H };
}

async function _drawLogo(ctx, url, position, w, h) {
  try {
    const img = await _loadImage(url);
    const lw = Math.min(120, w * 0.08);
    const lh = (img.height / img.width) * lw;
    const pad = 20;
    let lx, ly;
    if (position === 'top-left')     { lx = pad;       ly = pad; }
    else if (position === 'top-right')    { lx = w-lw-pad; ly = pad; }
    else if (position === 'bottom-left')  { lx = pad;       ly = h-lh-pad; }
    else                                  { lx = w-lw-pad; ly = h-lh-pad; }
    ctx.drawImage(img, lx, ly, lw, lh);
  } catch {}
}

function _drawWatermark(ctx, w, h) {
  ctx.save();
  ctx.font         = `500 ${Math.round(w * 0.012)}px "DM Sans",sans-serif`;
  ctx.fillStyle    = 'rgba(255,255,255,0.35)';
  ctx.textAlign    = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText('Made with NIF · fumoca.co.za', w - 12, h - 8);
  ctx.restore();
}

async function _canvasToJpeg(canvas, quality) {
  if (canvas instanceof OffscreenCanvas) {
    return await canvas.convertToBlob({ type:'image/jpeg', quality });
  }
  return new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
}

async function _blobToBase64(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload  = () => res(fr.result.split(',')[1]);
    fr.onerror = rej;
    fr.readAsDataURL(blob);
  });
}

async function _loadImage(url) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload  = () => res(img);
    img.onerror = rej;
    img.src = url;
  });
}

async function _loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
}

function _yield() {
  return new Promise(r => setTimeout(r, 0));
}

function _hexWithAlpha(hex, alpha) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function _identityMat4() {
  return new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
}

function _rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y);
  ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h-r);
  ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  ctx.lineTo(x+r,y+h);
  ctx.quadraticCurveTo(x,y+h,x,y+h-r);
  ctx.lineTo(x,y+r);
  ctx.quadraticCurveTo(x,y,x+r,y);
  ctx.closePath();
}
