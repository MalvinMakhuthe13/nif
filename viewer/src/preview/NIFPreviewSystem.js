/**
 * NIFPreviewSystem — Proxy Video Playback + Transition Trigger
 * © Fumoca Technologies · fumoca.co.za
 *
 * What this does:
 *   1. Extract the PROXY_VIDEO chunk (0x0002) from the .nif binary
 *   2. Create a Blob URL from the H.264/H.265 bytes
 *   3. Play the video as a native <video> element (no WebGL needed yet)
 *      — This is what appears when someone sees a shared NIF on social media
 *        or embedded on a website. It looks like a regular video.
 *   4. Show a "tap to explore" UI affordance after 1.5s
 *   5. On click/tap: capture the current video frame as ImageData
 *   6. Fire the NIFTransition with that frame as the source image
 *   7. When transition completes, hand off to NIFRenderer
 *
 * If no PROXY_VIDEO chunk exists (reconstruction still running, or stripped
 * for size) — fall back directly to the Gaussian renderer with a simpler
 * fade-in transition.
 *
 * Social sharing note:
 *   The proxy video is a standard mp4. When shared to Twitter/WhatsApp/etc,
 *   the platform sees a normal video and plays it inline. The NIF magic
 *   only activates when clicked in the fumoca viewer or embed.
 */

import { CHUNK } from '../../../core/format/NIFSpec.js';
import { NIFTransition } from '../transition/NIFTransition.js';

export class NIFPreviewSystem {
  /**
   * @param {HTMLElement}  container  — element to mount into (viewer wraps this)
   * @param {object}       opts
   *   onTransitionStart(stage)    — stage name string
   *   onTransitionEnd()           — fire renderer handoff
   *   onError(err)
   *   autoplay                    — start transition automatically (default: false, wait for tap)
   *   autoplayDelay               — ms before auto-trigger (default: 3000)
   *   vertical                    — string, for UI colour theming
   */
  constructor(container, opts = {}) {
    this.container         = container;
    this.onTransitionStart = opts.onTransitionStart ?? (() => {});
    this.onTransitionEnd   = opts.onTransitionEnd   ?? (() => {});
    this.onError           = opts.onError            ?? console.error;
    this.autoplay          = opts.autoplay           ?? false;
    this.autoplayDelay     = opts.autoplayDelay      ?? 3000;
    this.vertical          = opts.vertical           ?? 'generic';

    this._video      = null;
    this._canvas     = null;
    this._transition = null;
    this._triggered  = false;
    this._proxyUrl   = null;
    this._affordance = null;
    this._autoTimer  = null;
  }

  /**
   * Mount preview into container.
   * @param {object} nifData   — { reader: NIFReader, gaussians: {count,data} }
   * @param {HTMLCanvasElement} sharedCanvas — the GL canvas (hidden during proxy)
   */
  async mount(nifData, sharedCanvas) {
    this._canvas   = sharedCanvas;
    this._gaussians= nifData.gaussians;

    // Try to extract proxy video
    const proxyChunk = nifData.reader?.getChunk(CHUNK.PROXY_VIDEO);

    if (proxyChunk && proxyChunk.data.length > 1000) {
      await this._mountVideo(proxyChunk);
    } else {
      // No proxy — skip to simple fade-in
      this._skipToTransition();
    }
  }

  // ── Video playback ─────────────────────────────────────────────────────────
  async _mountVideo(chunk) {
    // Detect codec from chunk codec byte
    const isHEVC = chunk.codec === 0x04;
    const mime   = isHEVC ? 'video/mp4; codecs="hvc1"' : 'video/mp4; codecs="avc1.42E01E"';
    const blob   = new Blob([chunk.data], { type: mime });
    this._proxyUrl = URL.createObjectURL(blob);

    // Check browser can play this codec
    const test = document.createElement('video');
    const canPlay = test.canPlayType(mime);
    if (canPlay === '') {
      // Codec unsupported — fall back to direct transition
      URL.revokeObjectURL(this._proxyUrl);
      this._proxyUrl = null;
      this._skipToTransition();
      return;
    }

    this._buildVideoUI();
  }

  _buildVideoUI() {
    // Hide the GL canvas during proxy playback
    this._canvas.style.display = 'none';

    // Wrapper
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;background:#000;cursor:pointer';
    wrap.setAttribute('data-nif-preview', '');

    // Video element
    const vid = document.createElement('video');
    vid.src          = this._proxyUrl;
    vid.autoplay     = true;
    vid.muted        = true;      // required for autoplay on mobile
    vid.loop         = true;
    vid.playsInline  = true;
    vid.style.cssText= 'width:100%;height:100%;object-fit:cover;display:block';
    vid.setAttribute('playsinline', '');
    vid.setAttribute('webkit-playsinline', '');
    this._video = vid;
    wrap.appendChild(vid);

    // Affordance overlay — "tap to explore"
    const aff = this._buildAffordance();
    wrap.appendChild(aff);
    this._affordance = aff;

    // Click/tap handler
    const trigger = () => this._triggerTransition();
    wrap.addEventListener('click',      trigger);
    wrap.addEventListener('touchstart', trigger, { passive: true });

    // Auto-trigger
    if (this.autoplay) {
      this._autoTimer = setTimeout(trigger, this.autoplayDelay);
    }

    // Show affordance after video plays for a moment
    vid.addEventListener('timeupdate', () => {
      if (vid.currentTime > 1.5 && aff.style.opacity === '0') {
        aff.style.opacity = '1';
      }
    }, { once: false });

    this.container.appendChild(wrap);
    this._wrap = wrap;

    vid.play().catch(() => {
      // Autoplay blocked — show play button
      aff.style.opacity = '1';
    });
  }

  _buildAffordance() {
    const VERT_COLORS = {
      automotive:'#ffaa44', fashion:'#f06aff', property:'#3ddc97',
      mining:'#ffcc44', agriculture:'#6ddc7c', generic:'#a594ff',
    };
    const color = VERT_COLORS[this.vertical] ?? '#a594ff';

    const el = document.createElement('div');
    el.style.cssText = `
      position:absolute;inset:0;
      display:flex;flex-direction:column;align-items:center;justify-content:flex-end;
      padding-bottom:28px;
      background:linear-gradient(to top,rgba(0,0,0,0.5) 0%,transparent 50%);
      opacity:0;transition:opacity 0.6s;pointer-events:none;
    `;

    const pill = document.createElement('div');
    pill.style.cssText = `
      display:inline-flex;align-items:center;gap:8px;
      padding:8px 18px;border-radius:999px;
      background:rgba(0,0,0,0.5);
      border:1px solid ${color}66;
      backdrop-filter:blur(8px);
      color:#fff;font-family:Syne,sans-serif;font-size:13px;font-weight:700;
      letter-spacing:0.04em;
      animation:nif-pulse 2.5s ease-in-out infinite;
    `;

    // Inject keyframes once
    if (!document.getElementById('nif-preview-styles')) {
      const style = document.createElement('style');
      style.id = 'nif-preview-styles';
      style.textContent = `
        @keyframes nif-pulse {
          0%,100% { box-shadow:0 0 0 0 ${color}44; }
          50%      { box-shadow:0 0 0 8px ${color}00; }
        }
        @keyframes nif-spin {
          to { transform:rotate(360deg); }
        }
        [data-nif-preview] { user-select:none; -webkit-user-select:none; }
      `;
      document.head.appendChild(style);
    }

    const dot = document.createElement('span');
    dot.style.cssText = `
      width:8px;height:8px;border-radius:50%;
      background:${color};flex-shrink:0;
      animation:nif-pulse 2.5s ease-in-out infinite;
    `;
    pill.appendChild(dot);

    const txt = document.createElement('span');
    txt.textContent = 'Tap to explore in 4D';
    pill.appendChild(txt);

    const spark = document.createElement('span');
    spark.textContent = '✦';
    spark.style.color = color;
    pill.appendChild(spark);

    el.appendChild(pill);
    return el;
  }

  // ── Transition trigger ─────────────────────────────────────────────────────
  async _triggerTransition() {
    if (this._triggered) return;
    this._triggered = true;
    clearTimeout(this._autoTimer);

    // Swap affordance to loading state
    if (this._affordance) {
      this._affordance.style.opacity = '1';
      this._affordance.innerHTML = '<div style="width:20px;height:20px;border:2px solid rgba(255,255,255,0.2);border-top-color:#fff;border-radius:50%;animation:nif-spin 0.7s linear infinite"></div>';
    }

    try {
      // Capture current video frame as ImageData
      const sourceFrame = await this._captureVideoFrame();

      // Show the GL canvas (transition renders here)
      this._canvas.style.display = 'block';
      this._canvas.width  = this.container.offsetWidth  * (devicePixelRatio ?? 1);
      this._canvas.height = this.container.offsetHeight * (devicePixelRatio ?? 1);

      // Remove video wrapper
      if (this._wrap) {
        this._wrap.style.transition = 'opacity 0.3s';
        this._wrap.style.opacity    = '0';
        setTimeout(() => { this._wrap?.remove(); this._wrap=null; }, 300);
      }

      // Start transition
      this._transition = new NIFTransition(this._canvas, {
        duration:        4.5,
        onStageChange:   (name, t) => this.onTransitionStart(name),
        onComplete:      () => {
          if (this._proxyUrl) URL.revokeObjectURL(this._proxyUrl);
          this.onTransitionEnd();
        },
      });

      await this._transition.play(
        sourceFrame,
        this._gaussians,
        // Gaussian render callback for stages 3-4 compositing
        // This is set from outside by NIFViewer after renderer is ready
        this._gaussianRenderFn ?? null,
      );

    } catch (err) {
      this.onError(err);
      // Fallback: just show the renderer
      this._canvas.style.display = 'block';
      if (this._proxyUrl) URL.revokeObjectURL(this._proxyUrl);
      this.onTransitionEnd();
    }
  }

  _skipToTransition() {
    // No proxy video — trigger immediately with a blank source
    this._triggered = true;
    this._canvas.style.display = 'block';

    const W = this.container.offsetWidth * (devicePixelRatio ?? 1);
    const H = this.container.offsetHeight * (devicePixelRatio ?? 1);
    const blank = new ImageData(Math.max(W, 1), Math.max(H, 1));

    this._transition = new NIFTransition(this._canvas, {
      duration:      3.5, // slightly shorter without source frame
      onStageChange: (name) => this.onTransitionStart(name),
      onComplete:    () => this.onTransitionEnd(),
    });

    this._transition.play(blank, this._gaussians, this._gaussianRenderFn ?? null)
      .catch(err => { this.onError(err); this.onTransitionEnd(); });
  }

  // ── Frame capture ──────────────────────────────────────────────────────────
  async _captureVideoFrame() {
    if (!this._video) {
      // No video — return blank frame at container size
      const W = Math.max(this.container.offsetWidth,  1);
      const H = Math.max(this.container.offsetHeight, 1);
      return new ImageData(W, H);
    }

    // Try ImageCapture API first (higher quality, no canvas needed)
    if (typeof ImageCapture !== 'undefined') {
      try {
        if (this._video.srcObject) {
          const track   = this._video.srcObject.getVideoTracks()[0];
          const capture = new ImageCapture(track);
          return await capture.grabFrame();
        }
      } catch {} // fall through
    }

    // Canvas 2D capture
    const W   = this._video.videoWidth  || this.container.offsetWidth;
    const H   = this._video.videoHeight || this.container.offsetHeight;
    const cvs = document.createElement('canvas');
    cvs.width = W; cvs.height = H;
    const ctx = cvs.getContext('2d');
    ctx.drawImage(this._video, 0, 0, W, H);
    return ctx.getImageData(0, 0, W, H);
  }

  // ── Called by NIFViewer once renderer is ready ────────────────────────────
  setGaussianRenderFn(fn) {
    this._gaussianRenderFn = fn;
    if (this._transition) this._transition._gaussianRender = fn;
  }

  destroy() {
    clearTimeout(this._autoTimer);
    this._transition?.stop();
    if (this._proxyUrl) URL.revokeObjectURL(this._proxyUrl);
    this._wrap?.remove();
    this._video  = null;
    this._wrap   = null;
  }
}
