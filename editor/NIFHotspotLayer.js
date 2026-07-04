/**
 * NIFHotspotLayer — Visual-Only Labels & Callouts for Presentation Video
 * © Fumoca Technologies · fumoca.co.za
 *
 * Unlike the interactive INTERACTION chunk (0x0011) in a live NIF file,
 * these hotspots are PURELY VISUAL. They have no click handlers. They are
 * rendered as 2D overlays on top of the 3D scene and baked into the exported
 * video frame by frame.
 *
 * Why no click: this is a VIDEO EXPORT. The video plays in YouTube/TikTok/
 * Instagram where there is no NIF runtime. Labels are decorative — the
 * actual interactivity lives in the share URL.
 *
 * Hotspot types:
 *   pill      — rounded rectangle label (white text on semi-transparent dark)
 *   callout   — speech bubble with a stem pointing to the scene point
 *   line      — thin line from scene point to a floating label
 *   neon      — glowing ring + label (good for tech content)
 *
 * 3D positioning:
 *   Each hotspot stores a 3D world position. On every render frame, the
 *   layer projects that position through the current camera matrices to get
 *   2D screen coordinates. Labels follow the scene as the camera moves.
 *
 * Integration:
 *   const hs = new NIFHotspotLayer(containerEl, renderer, { onChange });
 *   hs.setEditable(true);
 *   hs.beginAddMode(callback);
 *   const all = hs.exportAll();
 *   hs.importAll(saved);
 *
 * During export:
 *   NIFPresentationExporter calls hs.renderToCanvas(canvas2dCtx, camera, t)
 *   for every frame.
 */

import { v3, m4 } from '../core/math/NIFMath.js';

let _uid = 0;

const STYLES = {
  pill: {
    draw(ctx, label, sx, sy, color, fontSize) {
      const pad   = { x: 12, y: 7 };
      ctx.font    = `600 ${fontSize}px "DM Sans",sans-serif`;
      const tw    = ctx.measureText(label).width;
      const bw    = tw + pad.x * 2;
      const bh    = fontSize + pad.y * 2;

      ctx.fillStyle   = 'rgba(0,0,0,0.7)';
      _roundRect(ctx, sx - bw/2, sy - bh/2, bw, bh, bh/2);
      ctx.fill();

      ctx.strokeStyle = color;
      ctx.lineWidth   = 1.5;
      _roundRect(ctx, sx - bw/2, sy - bh/2, bw, bh, bh/2);
      ctx.stroke();

      ctx.fillStyle   = '#fff';
      ctx.textAlign   = 'center';
      ctx.textBaseline= 'middle';
      ctx.fillText(label, sx, sy);
    }
  },
  callout: {
    draw(ctx, label, sx, sy, color, fontSize) {
      const pad = { x: 14, y: 9 };
      ctx.font  = `500 ${fontSize}px "DM Sans",sans-serif`;
      const tw  = ctx.measureText(label).width;
      const bw  = tw + pad.x * 2;
      const bh  = fontSize + pad.y * 2;
      const ox  = sx + 20, oy = sy - bh - 14;

      // Box
      ctx.fillStyle   = 'rgba(0,0,0,0.8)';
      ctx.strokeStyle = color;
      ctx.lineWidth   = 1.5;
      _roundRect(ctx, ox - bw/2, oy, bw, bh, 8);
      ctx.fill();
      ctx.stroke();

      // Stem
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ox - 8, oy + bh);
      ctx.lineTo(ox + 8, oy + bh);
      ctx.closePath();
      ctx.fillStyle   = 'rgba(0,0,0,0.8)';
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.stroke();

      // Text
      ctx.fillStyle    = '#fff';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, ox, oy + bh/2);
    }
  },
  line: {
    draw(ctx, label, sx, sy, color, fontSize) {
      const lx = sx + 60, ly = sy - 20;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(lx, ly);
      ctx.strokeStyle = color;
      ctx.lineWidth   = 1.5;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(sx, sy, 4, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      ctx.font         = `500 ${fontSize}px "DM Sans",sans-serif`;
      ctx.fillStyle    = '#fff';
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, lx + 6, ly);
    }
  },
  neon: {
    draw(ctx, label, sx, sy, color, fontSize) {
      // Glowing ring
      const r   = 18;
      const grd = ctx.createRadialGradient(sx, sy, r - 2, sx, sy, r + 8);
      grd.addColorStop(0,   color + 'cc');
      grd.addColorStop(0.5, color + '44');
      grd.addColorStop(1,   color + '00');
      ctx.beginPath();
      ctx.arc(sx, sy, r + 6, 0, Math.PI * 2);
      ctx.fillStyle = grd;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth   = 2;
      ctx.shadowColor = color;
      ctx.shadowBlur  = 8;
      ctx.stroke();
      ctx.shadowBlur  = 0;

      ctx.font         = `700 ${fontSize}px "DM Sans",sans-serif`;
      ctx.fillStyle    = '#fff';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'top';
      ctx.shadowColor  = color;
      ctx.shadowBlur   = 6;
      ctx.fillText(label, sx, sy + r + 6);
      ctx.shadowBlur   = 0;
    }
  },
};

export class NIFHotspotLayer {
  /**
   * @param {HTMLElement} container
   * @param {NIFRenderer} renderer
   * @param {object} opts
   *   onChange  fn
   */
  constructor(container, renderer, opts = {}) {
    this.container  = container;
    this._renderer  = renderer;
    this._onChange  = opts.onChange ?? (() => {});

    this._hotspots     = [];   // array of hotspot objects
    this._editable     = false;
    this._addMode      = false;
    this._addCallback  = null;
    this._defaultStyle = 'pill';
    this._accentColor  = '#7c6dfa';
    this._defaultFontSize = 14;

    // 2D overlay canvas for editor preview
    this._overlayCanvas = null;
    this._overlayCtx    = null;
    this._rafLoop       = null;

    this._buildOverlay();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  setEditable(editable) {
    this._editable = editable;
    if (editable) {
      this._overlayCanvas.style.pointerEvents = 'auto';
      this._startLoop();
    } else {
      this._overlayCanvas.style.pointerEvents = 'none';
      this._stopLoop();
    }
  }

  setDefaultStyle(style) {
    this._defaultStyle = style;
  }

  setAccentColor(color) {
    this._accentColor = color;
  }

  /** Enter click-to-place mode. Callback fires with the new hotspot. */
  beginAddMode(callback) {
    this._addMode     = true;
    this._addCallback = callback;
    this._overlayCanvas.style.cursor = 'crosshair';
  }

  clearAll() {
    this._hotspots = [];
    this._draw();
    this._onChange();
  }

  removeHotspot(id) {
    this._hotspots = this._hotspots.filter(h => h.id !== id);
    this._draw();
    this._onChange();
  }

  updateHotspot(id, updates) {
    const h = this._hotspots.find(h => h.id === id);
    if (h) Object.assign(h, updates);
    this._draw();
    this._onChange();
  }

  exportAll() {
    return this._hotspots.map(h => ({ ...h }));
  }

  importAll(hotspots) {
    this._hotspots = (hotspots ?? []).map(h => ({ ...h }));
    this._draw();
  }

  destroy() {
    this._stopLoop();
    this._overlayCanvas?.remove();
  }

  /**
   * Render all hotspots onto a 2D canvas context at a given camera state.
   * Called by NIFPresentationExporter for each export frame.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} camera   — { projectionMatrix, viewMatrix, canvasWidth, canvasHeight }
   * @param {number} t        — current time in seconds (for animated hotspots future use)
   */
  renderToCanvas(ctx, camera, t) {
    for (const h of this._hotspots) {
      if (!h.visible) continue;
      const screen = this._worldToScreen(
        h.worldX, h.worldY, h.worldZ,
        camera.projectionMatrix,
        camera.viewMatrix,
        camera.canvasWidth,
        camera.canvasHeight
      );
      if (!screen) continue;
      const style = STYLES[h.style ?? this._defaultStyle] ?? STYLES.pill;
      style.draw(ctx, h.label ?? '', screen.x, screen.y,
                 h.color ?? this._accentColor,
                 h.fontSize ?? this._defaultFontSize);
    }
  }

  // ── Private: overlay canvas ─────────────────────────────────────────────────

  _buildOverlay() {
    const c = document.createElement('canvas');
    c.style.cssText = `
      position:absolute;inset:0;width:100%;height:100%;
      pointer-events:none;z-index:5;
    `;
    this.container.style.position = 'relative';
    this.container.appendChild(c);
    this._overlayCanvas = c;
    this._overlayCtx    = c.getContext('2d');

    // Resize
    const ro = new ResizeObserver(() => this._resize());
    ro.observe(this.container);
    this._resize();

    // Click handler for placing hotspots
    c.addEventListener('click', (e) => {
      if (!this._addMode) return;
      const rect = c.getBoundingClientRect();
      const x    = e.clientX - rect.left;
      const y    = e.clientY - rect.top;
      this._placeHotspot(x, y);
    });
  }

  _resize() {
    const rect = this.container.getBoundingClientRect();
    this._overlayCanvas.width  = rect.width  * devicePixelRatio;
    this._overlayCanvas.height = rect.height * devicePixelRatio;
    this._overlayCanvas.style.width  = rect.width  + 'px';
    this._overlayCanvas.style.height = rect.height + 'px';
    this._overlayCtx.scale(devicePixelRatio, devicePixelRatio);
    this._draw();
  }

  _startLoop() {
    if (this._rafLoop) return;
    const loop = () => {
      this._draw();
      this._rafLoop = requestAnimationFrame(loop);
    };
    this._rafLoop = requestAnimationFrame(loop);
  }

  _stopLoop() {
    if (this._rafLoop) {
      cancelAnimationFrame(this._rafLoop);
      this._rafLoop = null;
    }
    this._draw(); // Final draw so labels stay visible
  }

  _draw() {
    const ctx = this._overlayCtx;
    if (!ctx) return;
    const W = this._overlayCanvas.width  / devicePixelRatio;
    const H = this._overlayCanvas.height / devicePixelRatio;
    ctx.clearRect(0, 0, W, H);

    // Build camera matrices from renderer for projection
    const cam = this._getCamera(W, H);

    for (const h of this._hotspots) {
      if (!h.visible) continue;
      const screen = this._worldToScreen(h.worldX, h.worldY, h.worldZ,
                                          cam.proj, cam.view, W, H);
      if (!screen) continue;
      const styleDef = STYLES[h.style ?? this._defaultStyle] ?? STYLES.pill;
      styleDef.draw(ctx, h.label ?? '',
                    screen.x, screen.y,
                    h.color ?? this._accentColor,
                    h.fontSize ?? this._defaultFontSize);

      // Edit handle
      if (this._editable) {
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, 6, 0, Math.PI * 2);
        ctx.strokeStyle = '#7c6dfa';
        ctx.lineWidth   = 1.5;
        ctx.stroke();
      }
    }

    // Crosshair hint in add mode
    if (this._addMode && this._editable) {
      ctx.font      = '12px sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.textAlign = 'center';
      ctx.fillText('Click to place label', W / 2, 24);
    }
  }

  _placeHotspot(screenX, screenY) {
    const W = this._overlayCanvas.width  / devicePixelRatio;
    const H = this._overlayCanvas.height / devicePixelRatio;

    // Unproject screen point to world (simplified — place on scene mid-plane)
    const world = this._screenToWorld(screenX, screenY, W, H);

    const h = {
      id:       `hs_${++_uid}`,
      label:    'Label',
      style:    this._defaultStyle,
      color:    this._accentColor,
      fontSize: this._defaultFontSize,
      worldX:   world.x,
      worldY:   world.y,
      worldZ:   world.z,
      visible:  true,
    };
    this._hotspots.push(h);

    // Prompt for label via an inline edit overlay
    this._promptLabel(h, screenX, screenY);

    this._addMode     = false;
    this._addCallback?.(h);
    this._addCallback = null;
    this._overlayCanvas.style.cursor = '';
    this._draw();
    this._onChange();
  }

  _promptLabel(h, sx, sy) {
    // Inline text input floating over the click point
    const inp       = document.createElement('input');
    inp.type        = 'text';
    inp.value       = h.label;
    inp.placeholder = 'Enter label…';
    inp.style.cssText = `
      position:absolute;
      left:${sx + 14}px;top:${sy - 14}px;
      z-index:20;
      background:#111;border:1px solid #7c6dfa;color:#fff;
      font-size:13px;padding:5px 9px;border-radius:7px;outline:none;
      font-family:"DM Sans",sans-serif;min-width:120px;
    `;
    this.container.appendChild(inp);
    inp.focus();
    inp.select();

    const commit = () => {
      h.label = inp.value.trim() || 'Label';
      inp.remove();
      this._draw();
      this._onChange();
    };
    inp.addEventListener('blur', commit);
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') { inp.remove(); this.removeHotspot(h.id); }
    });
  }

  // ── Private: 3D math ────────────────────────────────────────────────────────

  _getCamera(W, H) {
    // Try to read projection + view from renderer
    const r = this._renderer;
    const proj = r?._projMatrix  ?? r?.projMatrix  ?? _identityMat4();
    const view = r?._viewMatrix  ?? r?.viewMatrix  ?? _identityMat4();
    return { proj, view };
  }

  _worldToScreen(wx, wy, wz, proj, view, W, H) {
    // MVP transform
    const clip = _transformPoint(wx, wy, wz, proj, view);
    if (!clip) return null;

    // NDC → screen
    const sx = (clip.x / clip.w * 0.5 + 0.5) * W;
    const sy = (1 - clip.y / clip.w * 0.5 - 0.5) * H;

    // Behind camera check
    if (clip.w <= 0) return null;
    if (sx < -50 || sx > W + 50 || sy < -50 || sy > H + 50) return null;

    return { x: sx, y: sy };
  }

  _screenToWorld(sx, sy, W, H) {
    // Read camera position directly from NIFRenderer (Cartesian)
    const r      = this._renderer;
    const camPos = {
      x: r?.position?.[0] ?? 0,
      y: r?.position?.[1] ?? 0,
      z: r?.position?.[2] ?? 5,
    };
    const ndcX = (sx / W) * 2 - 1;
    const ndcY = 1 - (sy / H) * 2;
    return {
      x: camPos.x + ndcX * 2,
      y: camPos.y + ndcY * 2,
      z: camPos.z * 0.3,
    };
  }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

function _roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function _identityMat4() {
  return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
}

function _transformPoint(wx, wy, wz, proj, view) {
  // view * world
  const vx = view[0]*wx + view[4]*wy + view[8]*wz  + view[12];
  const vy = view[1]*wx + view[5]*wy + view[9]*wz  + view[13];
  const vz = view[2]*wx + view[6]*wy + view[10]*wz + view[14];
  const vw = view[3]*wx + view[7]*wy + view[11]*wz + view[15];

  // proj * view
  const cx = proj[0]*vx + proj[4]*vy + proj[8]*vz  + proj[12]*vw;
  const cy = proj[1]*vx + proj[5]*vy + proj[9]*vz  + proj[13]*vw;
  const cz = proj[2]*vx + proj[6]*vy + proj[10]*vz + proj[14]*vw;
  const cw = proj[3]*vx + proj[7]*vy + proj[11]*vz + proj[15]*vw;

  return { x: cx, y: cy, z: cz, w: cw };
}

