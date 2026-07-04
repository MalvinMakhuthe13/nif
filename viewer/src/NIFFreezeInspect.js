/**
 * NIFFreezeInspect — Freeze Frame Inspection System
 * © Fumoca Technologies · fumoca.co.za
 *
 * Works on three source types:
 *   'video'  — HTMLVideoElement (proxy video, uploaded file, recorded clip)
 *   'stream' — MediaStream / getUserMedia (live camera, screen capture)
 *   'canvas' — HTMLCanvasElement with WebGL (the 4D Gaussian scene)
 *
 * What it does:
 *   1. Captures a full-resolution snapshot from whichever source is live
 *   2. Displays the frozen frame in a resizable inspect panel
 *   3. Source continues playing in a picture-in-picture thumbnail
 *      (or pauses if the user explicitly pauses it)
 *   4. Inside the inspect panel: zoom, pan, measure, colour sample, annotate
 *   5. Frame can be saved as PNG, copied to clipboard, or sent to the 3D
 *      print pipeline as a reference image
 *
 * Integration:
 *   const inspector = new NIFFreezeInspect(containerEl);
 *   inspector.attachVideo(videoEl);      // or
 *   inspector.attachStream(mediaStream); // or
 *   inspector.attachCanvas(canvasEl);    // WebGL/Gaussian scene
 *   inspector.freeze();                  // trigger manually
 *   // or bind the F key / long-press to inspector.freeze()
 *
 * The inspector mounts as an overlay layer inside the same container.
 * It does not interrupt the source — video keeps playing, Gaussian renderer
 * keeps rendering.
 */

export class NIFFreezeInspect {
  /**
   * @param {HTMLElement} container   — the viewer's root element
   * @param {object}      opts
   *   onFreeze(imageData, timestamp)  — called when frame is captured
   *   onUnfreeze()                    — called when inspection is dismissed
   *   pipPosition  'top-left'|'top-right'|'bottom-left'|'bottom-right'
   *   accentColor  css colour string  (default '#7c6dfa')
   */
  constructor(container, opts = {}) {
    this.container   = container;
    this.onFreeze    = opts.onFreeze    ?? (() => {});
    this.onUnfreeze  = opts.onUnfreeze  ?? (() => {});
    this.pipPosition = opts.pipPosition ?? 'bottom-right';
    this.accent      = opts.accentColor ?? '#7c6dfa';

    this._source     = null;   // { type, el }
    this._frozen     = false;
    this._frameData  = null;   // ImageData of frozen frame
    this._timestamp  = null;
    this._panel      = null;   // inspect panel DOM el
    this._pip        = null;   // picture-in-picture thumbnail
    this._pipCanvas  = null;   // canvas inside pip
    this._pipLoop    = null;   // rAF loop for pip
    this._inspect    = null;   // InspectCanvas instance
    this._annotations= [];
    this._measuring  = false;
    this._measureStart = null;

    this._injectStyles();
    this._buildPanel();
    this._bindKeys();
  }

  // ── Source attachment ───────────────────────────────────────────────────────

  attachVideo(videoEl) {
    this._source = { type: 'video', el: videoEl };
  }

  attachStream(mediaStream) {
    // Create a hidden video element to drive the stream
    if (!this._streamVideo) {
      this._streamVideo = document.createElement('video');
      this._streamVideo.autoplay = true;
      this._streamVideo.muted    = true;
      this._streamVideo.playsInline = true;
      this._streamVideo.style.display = 'none';
      document.body.appendChild(this._streamVideo);
    }
    this._streamVideo.srcObject = mediaStream;
    this._source = { type: 'stream', el: this._streamVideo };
  }

  attachCanvas(canvasEl) {
    this._source = { type: 'canvas', el: canvasEl };
  }

  // ── Core: freeze / unfreeze ─────────────────────────────────────────────────

  freeze() {
    if (this._frozen) return;
    const frame = this._captureFrame();
    if (!frame) { console.warn('[NIFFreezeInspect] No source attached'); return; }

    this._frozen    = true;
    this._frameData = frame;
    this._timestamp = new Date();
    this._annotations = [];

    this._showPanel(frame);
    this._startPIP();

    this.onFreeze(frame, this._timestamp);

    // Dispatch DOM event so NIFViewer can react
    this.container.dispatchEvent(new CustomEvent('nif:freeze', {
      bubbles: true, detail: { timestamp: this._timestamp }
    }));
  }

  unfreeze() {
    if (!this._frozen) return;
    this._frozen = false;
    this._stopPIP();
    this._hidePanel();

    // Resume any paused video
    if (this._source?.type === 'video' && this._source.el.paused) {
      this._source.el.play().catch(() => {});
    }

    this.onUnfreeze();
    this.container.dispatchEvent(new CustomEvent('nif:unfreeze', { bubbles: true }));
  }

  toggleFreeze() {
    this._frozen ? this.unfreeze() : this.freeze();
  }

  get isFrozen() { return this._frozen; }

  // ── Frame capture ───────────────────────────────────────────────────────────

  _captureFrame() {
    if (!this._source) return null;
    const { type, el } = this._source;
    const cvs = document.createElement('canvas');

    if (type === 'video' || type === 'stream') {
      if (!el.videoWidth) return null;
      cvs.width  = el.videoWidth;
      cvs.height = el.videoHeight;
      const ctx  = cvs.getContext('2d');
      ctx.drawImage(el, 0, 0);
      return ctx.getImageData(0, 0, cvs.width, cvs.height);
    }

    if (type === 'canvas') {
      // Read WebGL pixels — requires preserveDrawingBuffer or a readback pass
      cvs.width  = el.width;
      cvs.height = el.height;
      const ctx  = cvs.getContext('2d');
      ctx.drawImage(el, 0, 0);
      return ctx.getImageData(0, 0, cvs.width, cvs.height);
    }

    return null;
  }

  // ── Picture-in-picture thumbnail ────────────────────────────────────────────

  _startPIP() {
    if (!this._pip || !this._source) return;
    const { type, el } = this._source;
    this._pip.style.display = 'block';

    const draw = () => {
      if (!this._frozen) return;
      const ctx = this._pipCanvas.getContext('2d');
      if ((type === 'video' || type === 'stream') && el.videoWidth) {
        this._pipCanvas.width  = el.videoWidth;
        this._pipCanvas.height = el.videoHeight;
        ctx.drawImage(el, 0, 0);
      } else if (type === 'canvas') {
        this._pipCanvas.width  = el.width;
        this._pipCanvas.height = el.height;
        ctx.drawImage(el, 0, 0);
      }
      this._pipLoop = requestAnimationFrame(draw);
    };
    this._pipLoop = requestAnimationFrame(draw);
  }

  _stopPIP() {
    cancelAnimationFrame(this._pipLoop);
    this._pipLoop = null;
    if (this._pip) this._pip.style.display = 'none';
  }

  // ── Panel: build ────────────────────────────────────────────────────────────

  _buildPanel() {
    // ── Main inspect panel ────────────────────────────────────────────────────
    const panel = document.createElement('div');
    panel.className = 'nif-inspect-panel';
    panel.setAttribute('data-nif-inspect', '');
    panel.style.display = 'none';

    panel.innerHTML = `
      <div class="nif-inspect-topbar">
        <div class="nif-inspect-title">
          <span class="nif-inspect-dot"></span>
          <span id="nif-inspect-ts">Freeze frame</span>
        </div>
        <div class="nif-inspect-tools">
          <button class="nif-itool" id="nif-tool-zoom"     title="Zoom (Z)"          data-tool="zoom">🔍</button>
          <button class="nif-itool" id="nif-tool-pan"      title="Pan (P)"           data-tool="pan">✥</button>
          <button class="nif-itool" id="nif-tool-measure"  title="Measure (M)"       data-tool="measure">⊨</button>
          <button class="nif-itool" id="nif-tool-sample"   title="Sample colour (C)" data-tool="sample">◈</button>
          <button class="nif-itool" id="nif-tool-annotate" title="Annotate (A)"      data-tool="annotate">✎</button>
          <div class="nif-itool-sep"></div>
          <button class="nif-itool" id="nif-zoom-in"  title="Zoom in (+)">+</button>
          <button class="nif-itool" id="nif-zoom-out" title="Zoom out (-)">−</button>
          <button class="nif-itool" id="nif-zoom-fit" title="Fit to screen">⊙</button>
          <div class="nif-itool-sep"></div>
          <button class="nif-itool" id="nif-inspect-copy"  title="Copy to clipboard">⎘</button>
          <button class="nif-itool" id="nif-inspect-save"  title="Save PNG">↓</button>
          <button class="nif-itool nif-itool-close" id="nif-inspect-close" title="Close (Esc)">✕</button>
        </div>
      </div>
      <div class="nif-inspect-canvas-wrap" id="nif-inspect-canvas-wrap">
        <canvas id="nif-inspect-canvas"></canvas>
        <div class="nif-inspect-crosshair" id="nif-inspect-crosshair"></div>
        <div class="nif-measure-line" id="nif-measure-line" style="display:none"></div>
        <div class="nif-measure-label" id="nif-measure-label" style="display:none"></div>
        <div class="nif-colour-pip" id="nif-colour-pip" style="display:none">
          <div class="nif-colour-swatch" id="nif-colour-swatch"></div>
          <div class="nif-colour-info" id="nif-colour-info"></div>
        </div>
        <svg class="nif-annotation-svg" id="nif-annotation-svg"></svg>
      </div>
      <div class="nif-inspect-statusbar">
        <span id="nif-inspect-coords">x:— y:—</span>
        <span id="nif-inspect-colour">rgb(—,—,—)</span>
        <span id="nif-inspect-zoom-level">100%</span>
        <span id="nif-inspect-dims">—×—</span>
      </div>
    `;

    this.container.appendChild(panel);
    this._panel = panel;

    // ── PIP thumbnail ─────────────────────────────────────────────────────────
    const pip = document.createElement('div');
    pip.className = `nif-pip nif-pip-${this.pipPosition}`;
    pip.style.display = 'none';
    pip.setAttribute('data-nif-pip', '');

    const pipCvs = document.createElement('canvas');
    pipCvs.className = 'nif-pip-canvas';
    this._pipCanvas = pipCvs;

    const pipLabel = document.createElement('div');
    pipLabel.className = 'nif-pip-label';
    pipLabel.textContent = '▶ Live';

    const pipClose = document.createElement('button');
    pipClose.className = 'nif-pip-btn';
    pipClose.textContent = '✕';
    pipClose.title = 'Stop & resume';
    pipClose.onclick = () => this.unfreeze();

    const pipPause = document.createElement('button');
    pipPause.className = 'nif-pip-btn';
    pipPause.id = 'nif-pip-pause';
    pipPause.textContent = '⏸';
    pipPause.title = 'Pause source';
    pipPause.onclick = () => this._toggleSourcePause();

    pip.appendChild(pipCvs);
    pip.appendChild(pipLabel);
    pip.appendChild(pipPause);
    pip.appendChild(pipClose);
    this.container.appendChild(pip);
    this._pip = pip;

    // Bind inspect canvas interactions
    this._inspect = new InspectCanvas(
      document.getElementById('nif-inspect-canvas'),
      document.getElementById('nif-inspect-canvas-wrap'),
    );
    this._bindPanelEvents();
  }

  // ── Panel: show/hide ─────────────────────────────────────────────────────────

  _showPanel(frame) {
    const panel  = this._panel;
    const canvas = document.getElementById('nif-inspect-canvas');
    const ts     = document.getElementById('nif-inspect-ts');

    ts.textContent = 'Frozen · ' + this._timestamp.toLocaleTimeString();
    document.getElementById('nif-inspect-dims').textContent = `${frame.width}×${frame.height}`;

    panel.style.display = 'flex';
    // Force reflow then animate in
    panel.getBoundingClientRect();
    panel.classList.add('nif-inspect-visible');

    this._inspect.loadFrame(frame);
    this._setTool('zoom');
  }

  _hidePanel() {
    const panel = this._panel;
    panel.classList.remove('nif-inspect-visible');
    setTimeout(() => { panel.style.display = 'none'; }, 280);
    this._clearAnnotations();
  }

  // ── Tool management ──────────────────────────────────────────────────────────

  _activeTool = 'zoom';

  _setTool(tool) {
    this._activeTool = tool;
    document.querySelectorAll('.nif-itool[data-tool]').forEach(b => {
      b.classList.toggle('nif-itool-active', b.dataset.tool === tool);
    });
    const wrap = document.getElementById('nif-inspect-canvas-wrap');
    if (wrap) wrap.setAttribute('data-cursor', tool);
    this._inspect.setTool(tool);
    this._measuring = tool === 'measure';
  }

  // ── Panel events ─────────────────────────────────────────────────────────────

  _bindPanelEvents() {
    // Tool buttons
    document.querySelectorAll('.nif-itool[data-tool]').forEach(btn => {
      btn.addEventListener('click', () => this._setTool(btn.dataset.tool));
    });
    document.getElementById('nif-zoom-in') .addEventListener('click', () => this._inspect.zoom( 1.3));
    document.getElementById('nif-zoom-out').addEventListener('click', () => this._inspect.zoom(1/1.3));
    document.getElementById('nif-zoom-fit').addEventListener('click', () => this._inspect.fit());
    document.getElementById('nif-inspect-close').addEventListener('click', () => this.unfreeze());
    document.getElementById('nif-inspect-save') .addEventListener('click', () => this._saveFrame());
    document.getElementById('nif-inspect-copy') .addEventListener('click', () => this._copyFrame());

    // Mouse feedback on canvas: show colour + coords
    const wrap = document.getElementById('nif-inspect-canvas-wrap');
    wrap.addEventListener('mousemove', (e) => {
      if (!this._frameData) return;
      const pt = this._inspect.screenToImage(e.offsetX, e.offsetY);
      if (!pt) return;
      const {x, y} = pt;
      const ix = Math.round(x), iy = Math.round(y);
      if (ix < 0 || iy < 0 || ix >= this._frameData.width || iy >= this._frameData.height) return;
      const idx = (iy * this._frameData.width + ix) * 4;
      const r = this._frameData.data[idx], g = this._frameData.data[idx+1], b = this._frameData.data[idx+2];
      document.getElementById('nif-inspect-coords').textContent = `x:${ix} y:${iy}`;
      document.getElementById('nif-inspect-colour').textContent = `rgb(${r},${g},${b})`;

      // Colour pip popover
      if (this._activeTool === 'sample') {
        const pip = document.getElementById('nif-colour-pip');
        const sw  = document.getElementById('nif-colour-swatch');
        const inf = document.getElementById('nif-colour-info');
        pip.style.display = 'block';
        pip.style.left = (e.offsetX + 12) + 'px';
        pip.style.top  = (e.offsetY - 20) + 'px';
        sw.style.background = `rgb(${r},${g},${b})`;
        const hex = '#' + [r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('');
        inf.innerHTML = `<div>${hex.toUpperCase()}</div><div style="opacity:0.6">rgb(${r},${g},${b})</div>`;
      } else {
        document.getElementById('nif-colour-pip').style.display = 'none';
      }
    });

    wrap.addEventListener('mouseleave', () => {
      document.getElementById('nif-colour-pip').style.display = 'none';
    });

    // Measure tool: click to start line, click again to finish
    wrap.addEventListener('click', (e) => {
      if (this._activeTool !== 'measure') return;
      const pt = this._inspect.screenToImage(e.offsetX, e.offsetY);
      if (!pt) return;
      if (!this._measureStart) {
        this._measureStart = { sx: e.offsetX, sy: e.offsetY, ix: pt.x, iy: pt.y };
        document.getElementById('nif-measure-line').style.display  = 'block';
        document.getElementById('nif-measure-label').style.display = 'block';
      } else {
        this._finishMeasure(e.offsetX, e.offsetY, pt.x, pt.y);
        this._measureStart = null;
      }
    });

    wrap.addEventListener('mousemove', (e) => {
      if (this._activeTool !== 'measure' || !this._measureStart) return;
      this._drawMeasureLine(
        this._measureStart.sx, this._measureStart.sy, e.offsetX, e.offsetY,
        this._measureStart.ix, this._measureStart.iy,
      );
    });

    // Annotate tool — freehand SVG path drawing
    let _annotating = false, _currentPath = null, _pathPoints = [];
    wrap.addEventListener('mousedown', (e) => {
      if (this._activeTool !== 'annotate') return;
      _annotating  = true;
      _pathPoints  = [[e.offsetX, e.offsetY]];
      const svg    = document.getElementById('nif-annotation-svg');
      _currentPath = document.createElementNS('http://www.w3.org/2000/svg','path');
      _currentPath.setAttribute('stroke', '#ffdd00');
      _currentPath.setAttribute('stroke-width', '2');
      _currentPath.setAttribute('fill', 'none');
      _currentPath.setAttribute('stroke-linecap', 'round');
      _currentPath.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(_currentPath);
    });
    wrap.addEventListener('mousemove', (e) => {
      if (!_annotating || this._activeTool !== 'annotate' || !_currentPath) return;
      _pathPoints.push([e.offsetX, e.offsetY]);
      // Smooth path using Catmull-Rom → cubic bezier conversion
      const d = _pathPoints.reduce((acc, p, i) => {
        if (i === 0) return `M ${p[0]},${p[1]}`;
        const prev = _pathPoints[i-1];
        const cpx  = (prev[0]+p[0])/2, cpy = (prev[1]+p[1])/2;
        return `${acc} Q ${prev[0]},${prev[1]} ${cpx},${cpy}`;
      }, '');
      _currentPath.setAttribute('d', d);
    });
    wrap.addEventListener('mouseup', () => {
      if (!_annotating) return;
      _annotating  = false;
      _currentPath = null;
      _pathPoints  = [];
    });
    wrap.addEventListener('mouseleave', () => { _annotating = false; });

    // Zoom update
    this._inspect.onZoomChange = (z) => {
      document.getElementById('nif-inspect-zoom-level').textContent = Math.round(z * 100) + '%';
    };
  }

  _drawMeasureLine(x1, y1, x2, y2, ix1, iy1) {
    const line  = document.getElementById('nif-measure-line');
    const label = document.getElementById('nif-measure-label');
    const dx = x2-x1, dy = y2-y1;
    const len = Math.sqrt(dx*dx+dy*dy);
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;
    line.style.cssText = `
      display:block;position:absolute;
      left:${x1}px;top:${y1}px;
      width:${len}px;height:2px;
      transform-origin:0 50%;
      transform:rotate(${angle}deg);
      background:rgba(255,200,0,0.9);
      pointer-events:none;
    `;
    const pxDist = Math.sqrt((iy1-(iy1+dy/this._inspect.scale))**2 + (ix1-(ix1+dx/this._inspect.scale))**2);
    label.style.cssText = `
      display:block;position:absolute;
      left:${(x1+x2)/2+6}px;top:${(y1+y2)/2-20}px;
      background:rgba(0,0,0,0.7);color:#ffd700;
      font-family:var(--mono,'monospace');font-size:11px;font-weight:600;
      padding:2px 8px;border-radius:4px;white-space:nowrap;pointer-events:none;
    `;
    label.textContent = `${Math.round(pxDist)}px`;
  }

  _finishMeasure(x2, y2, ix2, iy2) {
    this._drawMeasureLine(
      this._measureStart.sx, this._measureStart.sy, x2, y2,
      this._measureStart.ix, this._measureStart.iy
    );
    // Add to annotation SVG
    const svg = document.getElementById('nif-annotation-svg');
    const ns  = 'http://www.w3.org/2000/svg';
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', this._measureStart.sx);
    line.setAttribute('y1', this._measureStart.sy);
    line.setAttribute('x2', x2); line.setAttribute('y2', y2);
    line.setAttribute('stroke', '#ffd700'); line.setAttribute('stroke-width', '1.5');
    svg.appendChild(line);
  }

  _clearAnnotations() {
    const svg = document.getElementById('nif-annotation-svg');
    if (svg) svg.innerHTML = '';
    this._annotations = [];
    this._measureStart = null;
    ['nif-measure-line','nif-measure-label'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
  }

  _toggleSourcePause() {
    const src = this._source;
    if (!src) return;
    const btn = document.getElementById('nif-pip-pause');
    if (src.type === 'video' || src.type === 'stream') {
      if (src.el.paused) {
        src.el.play().catch(()=>{});
        btn.textContent = '⏸';
        btn.title = 'Pause source';
      } else {
        src.el.pause();
        btn.textContent = '▶';
        btn.title = 'Resume source';
      }
    }
  }

  _saveFrame() {
    if (!this._frameData) return;
    const cvs = document.createElement('canvas');
    cvs.width  = this._frameData.width;
    cvs.height = this._frameData.height;
    cvs.getContext('2d').putImageData(this._frameData, 0, 0);
    const a = document.createElement('a');
    a.href     = cvs.toDataURL('image/png');
    a.download = `nif-freeze-${Date.now()}.png`;
    a.click();
  }

  async _copyFrame() {
    if (!this._frameData) return;
    try {
      const cvs = document.createElement('canvas');
      cvs.width  = this._frameData.width;
      cvs.height = this._frameData.height;
      cvs.getContext('2d').putImageData(this._frameData, 0, 0);
      cvs.toBlob(async blob => {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        const btn = document.getElementById('nif-inspect-copy');
        btn.textContent = '✓';
        setTimeout(() => { btn.textContent = '⎘'; }, 1500);
      });
    } catch(e) {
      console.warn('[NIFFreezeInspect] Clipboard write failed:', e.message);
    }
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────────────────

  _bindKeys() {
    window.addEventListener('keydown', (e) => {
      // Don't intercept if typing in an input
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      if (e.code === 'Space' || e.code === 'KeyF') {
        e.preventDefault();
        this.toggleFreeze();
      }
      if (!this._frozen) return;
      if (e.code === 'Escape')   { this.unfreeze(); return; }
      if (e.code === 'KeyZ')     { this._setTool('zoom'); }
      if (e.code === 'KeyP')     { this._setTool('pan'); }
      if (e.code === 'KeyM')     { this._setTool('measure'); }
      if (e.code === 'KeyC')     { this._setTool('sample'); }
      if (e.code === 'KeyA')     { this._setTool('annotate'); }
      if (e.code === 'Equal')    { this._inspect.zoom(1.3); }
      if (e.code === 'Minus')    { this._inspect.zoom(1/1.3); }
      if (e.code === 'Digit0')   { this._inspect.fit(); }
      if (e.key === 's' && (e.ctrlKey||e.metaKey)) { e.preventDefault(); this._saveFrame(); }
    });
  }

  // ── CSS injection ─────────────────────────────────────────────────────────────

  _injectStyles() {
    if (document.getElementById('nif-inspect-styles')) return;
    const accent = this.accent;
    const s = document.createElement('style');
    s.id = 'nif-inspect-styles';
    s.textContent = `
      /* ── Panel ─────────────────────────────────────────────────────────── */
      .nif-inspect-panel {
        position:absolute;inset:0;z-index:50;
        display:none;flex-direction:column;
        background:#000;
        opacity:0;transform:scale(0.97);
        transition:opacity 0.25s ease, transform 0.25s ease;
        pointer-events:none;
      }
      .nif-inspect-visible {
        opacity:1;transform:scale(1);pointer-events:auto;
      }

      /* ── Topbar ─────────────────────────────────────────────────────────── */
      .nif-inspect-topbar {
        display:flex;align-items:center;justify-content:space-between;
        padding:8px 12px;
        background:rgba(10,10,18,0.95);
        border-bottom:0.5px solid rgba(255,255,255,0.08);
        flex-shrink:0;
        gap:10px;
      }
      .nif-inspect-title {
        display:flex;align-items:center;gap:8px;
        font-family:Syne,sans-serif;font-size:12px;font-weight:700;color:#fff;
        white-space:nowrap;
      }
      .nif-inspect-dot {
        width:8px;height:8px;border-radius:50%;
        background:${accent};flex-shrink:0;
      }
      .nif-inspect-tools {
        display:flex;align-items:center;gap:3px;flex-wrap:wrap;
      }
      .nif-itool {
        width:28px;height:28px;border-radius:6px;
        border:0.5px solid rgba(255,255,255,0.1);
        background:transparent;color:rgba(255,255,255,0.55);
        font-size:13px;cursor:pointer;
        display:flex;align-items:center;justify-content:center;
        transition:all 0.12s;font-family:Syne,sans-serif;
      }
      .nif-itool:hover { background:rgba(255,255,255,0.08);color:#fff; }
      .nif-itool-active {
        background:${accent}28;border-color:${accent}88;color:${accent};
      }
      .nif-itool-close { color:rgba(255,255,255,0.3); }
      .nif-itool-close:hover { background:rgba(255,85,85,0.2);border-color:rgba(255,85,85,0.3);color:#ff5566; }
      .nif-itool-sep {
        width:0.5px;height:16px;background:rgba(255,255,255,0.1);margin:0 4px;
      }

      /* ── Canvas wrap ────────────────────────────────────────────────────── */
      .nif-inspect-canvas-wrap {
        flex:1;overflow:hidden;position:relative;cursor:crosshair;
        background:#0a0a0f;
      }
      .nif-inspect-canvas-wrap[data-cursor="pan"]      { cursor:grab; }
      .nif-inspect-canvas-wrap[data-cursor="zoom"]     { cursor:zoom-in; }
      .nif-inspect-canvas-wrap[data-cursor="sample"]   { cursor:cell; }
      .nif-inspect-canvas-wrap[data-cursor="measure"]  { cursor:crosshair; }
      .nif-inspect-canvas-wrap[data-cursor="annotate"] { cursor:text; }
      #nif-inspect-canvas {
        position:absolute;transform-origin:0 0;
        image-rendering:pixelated;image-rendering:crisp-edges;
      }
      .nif-annotation-svg {
        position:absolute;inset:0;width:100%;height:100%;
        pointer-events:none;overflow:visible;
      }
      .nif-colour-pip {
        position:absolute;
        background:rgba(0,0,0,0.85);
        border:0.5px solid rgba(255,255,255,0.15);
        border-radius:8px;padding:8px 10px;
        display:flex;align-items:center;gap:8px;
        pointer-events:none;z-index:10;
        backdrop-filter:blur(8px);
      }
      .nif-colour-swatch {
        width:22px;height:22px;border-radius:4px;
        border:0.5px solid rgba(255,255,255,0.2);flex-shrink:0;
      }
      .nif-colour-info {
        font-family:monospace;font-size:11px;
        color:#fff;line-height:1.5;
      }

      /* ── Status bar ─────────────────────────────────────────────────────── */
      .nif-inspect-statusbar {
        display:flex;gap:16px;align-items:center;
        padding:5px 14px;
        background:rgba(10,10,18,0.95);
        border-top:0.5px solid rgba(255,255,255,0.06);
        font-family:monospace;font-size:10px;
        color:rgba(255,255,255,0.4);
        flex-shrink:0;
      }

      /* ── PIP ────────────────────────────────────────────────────────────── */
      .nif-pip {
        position:absolute;z-index:60;
        width:180px;border-radius:10px;overflow:hidden;
        border:1.5px solid ${accent}66;
        background:#000;
        box-shadow:0 8px 24px rgba(0,0,0,0.6);
        display:none;
      }
      .nif-pip-top-right    { top:12px;right:12px; }
      .nif-pip-top-left     { top:12px;left:12px; }
      .nif-pip-bottom-right { bottom:68px;right:12px; }
      .nif-pip-bottom-left  { bottom:68px;left:12px; }
      .nif-pip-canvas {
        width:100%;display:block;
        aspect-ratio:16/9;object-fit:cover;
      }
      .nif-pip-label {
        position:absolute;top:5px;left:7px;
        font-size:9px;font-weight:700;color:#fff;
        font-family:Syne,sans-serif;
        background:rgba(0,0,0,0.5);padding:1px 6px;border-radius:4px;
        letter-spacing:0.05em;
      }
      .nif-pip-btn {
        position:absolute;top:4px;
        width:22px;height:22px;border-radius:5px;
        border:0.5px solid rgba(255,255,255,0.2);
        background:rgba(0,0,0,0.6);color:#fff;
        font-size:11px;cursor:pointer;
        display:flex;align-items:center;justify-content:center;
        backdrop-filter:blur(4px);
      }
      .nif-pip-btn:nth-child(3) { right:28px; }
      .nif-pip-btn:nth-child(4) { right:4px; }
    `;
    document.head.appendChild(s);
  }

  destroy() {
    this._stopPIP();
    this._panel?.remove();
    this._pip?.remove();
    this._streamVideo?.remove();
  }
}

// ─── InspectCanvas — zoom / pan / render ──────────────────────────────────────
class InspectCanvas {
  constructor(canvas, wrap) {
    this.canvas    = canvas;
    this.wrap      = wrap;
    this.ctx       = canvas.getContext('2d');
    this.scale     = 1;
    this.offsetX   = 0;
    this.offsetY   = 0;
    this._frame    = null;
    this._drag     = false;
    this._last     = { x:0, y:0 };
    this._tool     = 'zoom';
    this.onZoomChange = null;
    this._bindEvents();
  }

  loadFrame(imageData) {
    this._frame = imageData;
    this.canvas.width  = imageData.width;
    this.canvas.height = imageData.height;
    this.ctx.putImageData(imageData, 0, 0);
    this.fit();
  }

  setTool(tool) { this._tool = tool; }

  fit() {
    if (!this._frame) return;
    const W = this.wrap.offsetWidth  || 800;
    const H = this.wrap.offsetHeight || 600;
    const s = Math.min(W / this._frame.width, H / this._frame.height) * 0.92;
    this.scale   = s;
    this.offsetX = (W - this._frame.width  * s) / 2;
    this.offsetY = (H - this._frame.height * s) / 2;
    this._applyTransform();
    this.onZoomChange?.(s);
  }

  zoom(factor, cx, cy) {
    if (!this._frame) return;
    const W = this.wrap.offsetWidth, H = this.wrap.offsetHeight;
    cx = cx ?? W/2; cy = cy ?? H/2;
    const newScale = Math.max(0.1, Math.min(50, this.scale * factor));
    this.offsetX = cx - (cx - this.offsetX) * (newScale / this.scale);
    this.offsetY = cy - (cy - this.offsetY) * (newScale / this.scale);
    this.scale   = newScale;
    this._applyTransform();
    this.onZoomChange?.(newScale);
  }

  // Convert screen coordinates to image pixel coordinates
  screenToImage(sx, sy) {
    if (!this._frame) return null;
    const ix = (sx - this.offsetX) / this.scale;
    const iy = (sy - this.offsetY) / this.scale;
    return { x: ix, y: iy };
  }

  _applyTransform() {
    this.canvas.style.transform = `translate(${this.offsetX}px, ${this.offsetY}px) scale(${this.scale})`;
  }

  _bindEvents() {
    const w = this.wrap;

    // Wheel to zoom
    w.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom(e.deltaY < 0 ? 1.12 : 1/1.12, e.offsetX, e.offsetY);
    }, { passive: false });

    // Drag to pan
    w.addEventListener('mousedown', (e) => {
      if (this._tool !== 'pan') return;
      this._drag = true; this._last = { x: e.clientX, y: e.clientY };
      w.style.cursor = 'grabbing';
    });
    window.addEventListener('mouseup', () => { this._drag=false; if(this._tool==='pan') w.style.cursor='grab'; });
    w.addEventListener('mousemove', (e) => {
      if (!this._drag) return;
      this.offsetX += e.clientX - this._last.x;
      this.offsetY += e.clientY - this._last.y;
      this._last = { x: e.clientX, y: e.clientY };
      this._applyTransform();
    });

    // Click to zoom in/out
    w.addEventListener('click', (e) => {
      if (this._tool === 'zoom') this.zoom(e.shiftKey ? 1/1.5 : 1.5, e.offsetX, e.offsetY);
    });

    // Touch pinch to zoom
    let t0 = null, t1 = null, initDist = 0, initScale = 1;
    w.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        t0 = e.touches[0]; t1 = e.touches[1];
        initDist  = Math.hypot(t1.clientX-t0.clientX, t1.clientY-t0.clientY);
        initScale = this.scale;
      }
    }, { passive: true });
    w.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const d = Math.hypot(e.touches[1].clientX-e.touches[0].clientX, e.touches[1].clientY-e.touches[0].clientY);
        const s = initScale * (d / initDist);
        this.scale   = Math.max(0.1, Math.min(50, s));
        this._applyTransform();
        this.onZoomChange?.(this.scale);
      }
    }, { passive: false });
  }
}
