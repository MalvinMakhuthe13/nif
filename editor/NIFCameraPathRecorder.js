/**
 * NIFCameraPathRecorder — Record & Replay Camera Paths for Presentations
 * © Fumoca Technologies · fumoca.co.za
 *
 * Records the user's orbit gestures as a series of time-stamped keyframes,
 * then plays them back as a smooth Catmull-Rom spline during export.
 *
 * Coordinate system: spherical (phi, theta, radius) matching NIFRenderer's
 * OrbitControls so imports/exports are lossless.
 *
 * Integration:
 *   const cam = new NIFCameraPathRecorder(renderer, { duration: 10 });
 *   cam.startRecording();
 *   // user orbits…
 *   cam.stopRecording();
 *   cam.playback(); // preview in viewport
 *   const path = cam.exportPath(); // → JSON to save in presentation
 *   cam.importPath(path);          // restore on next load
 *   cam.getCameraAt(t)             // → {phi,theta,radius,target} for export frame t
 */

import { v3, clamp, smootherstep } from '../core/math/NIFMath.js';

const AUTO_ORBIT_PRESETS = {
  none:    null,
  slow:    { type:'orbit',   rpm:0.3,  range:360 },
  figure8: { type:'figure8', rpm:0.25, amplitude:30 },
  spiral:  { type:'spiral',  duration:10, startRadius:8, endRadius:3 },
};

export class NIFCameraPathRecorder {
  /**
   * @param {NIFRenderer} renderer
   * @param {object} opts
   *   duration  number  seconds (default 10)
   *   fps       number  capture rate during recording (default 10 — enough for spline)
   *   onChange  fn      called when keyframes change
   */
  constructor(renderer, opts = {}) {
    this._renderer  = renderer;
    this._duration  = opts.duration ?? 10;
    this._captureFps= 10;   // internal: how often we sample during user recording
    this._onChange  = opts.onChange ?? (() => {});

    this._keyframes  = [];   // [{t, position:[x,y,z], target:[x,y,z], up:[x,y,z]}]
    this._recording  = false;
    this._captureTimer = null;
    this._playbackRaf  = null;
    this._active       = false;  // editor mode active
    this._autoOrbit    = 'slow';

    // Playback state
    this._playbackStart = null;
    this._playbackRunning = false;
  }

  // ── Public ──────────────────────────────────────────────────────────────────

  setDuration(d) {
    this._duration = d;
  }

  setActive(active) {
    this._active = active;
    if (!active && this._recording) this.stopRecording();
  }

  /** Begin capturing camera state at _captureFps intervals */
  startRecording() {
    if (this._recording) return;
    this._recording = true;
    this._keyframes = [];
    this._recordStart = performance.now();

    this._captureTimer = setInterval(() => {
      const t  = (performance.now() - this._recordStart) / 1000;
      const cam = this._getCameraState();
      this._keyframes.push({ t, ...cam });
    }, 1000 / this._captureFps);
  }

  /** Stop recording, normalise timestamps to [0, duration], return keyframe count */
  stopRecording() {
    if (!this._recording) return 0;
    this._recording = false;
    clearInterval(this._captureTimer);

    if (this._keyframes.length < 2) {
      this._keyframes = [];
      return 0;
    }

    // Normalise t to [0, this._duration]
    const totalT = this._keyframes[this._keyframes.length - 1].t;
    if (totalT > 0) {
      this._keyframes.forEach(kf => { kf.t = (kf.t / totalT) * this._duration; });
    }

    this._onChange();
    return this._keyframes.length;
  }

  /** Smoothly replay the recorded path in the live viewer */
  playback() {
    if (this._playbackRunning) return;
    if (!this._keyframes.length && this._autoOrbit === 'none') return;

    this._playbackRunning = true;
    this._playbackStart   = performance.now();

    const tick = () => {
      const elapsed = (performance.now() - this._playbackStart) / 1000;
      const t       = elapsed % this._duration;  // loop
      const cam     = this.getCameraAt(t);

      if (cam) {
        this._setCameraState(cam);
        this._renderer.render?.();
      }

      if (this._playbackRunning) {
        this._playbackRaf = requestAnimationFrame(tick);
      }
    };
    this._playbackRaf = requestAnimationFrame(tick);
  }

  stopPlayback() {
    this._playbackRunning = false;
    if (this._playbackRaf) {
      cancelAnimationFrame(this._playbackRaf);
      this._playbackRaf = null;
    }
  }

  clear() {
    this.stopPlayback();
    this.stopRecording();
    this._keyframes = [];
    this._onChange();
  }

  destroy() {
    this.clear();
  }

  getKeyframes() {
    return this._keyframes;
  }

  /**
   * Get interpolated camera state at time t (seconds).
   * Falls back to auto-orbit if no path recorded.
   * Returns {phi, theta, radius, targetX, targetY, targetZ}
   */
  getCameraAt(t) {
    if (this._keyframes.length >= 2) {
      return this._interpolatePath(t);
    }
    return this._autoOrbitAt(t);
  }

  exportPath() {
    return {
      duration:   this._duration,
      keyframes:  this._keyframes,
      autoOrbit:  this._autoOrbit,
    };
  }

  importPath(path) {
    if (!path) return;
    this._duration  = path.duration  ?? this._duration;
    this._keyframes = path.keyframes ?? [];
    this._autoOrbit = path.autoOrbit ?? 'slow';
  }

  // ── Private: interpolation ───────────────────────────────────────────────────

  /**
   * Catmull-Rom spline interpolation over recorded Cartesian keyframes.
   */
  _interpolatePath(t) {
    const kfs = this._keyframes;
    if (!kfs.length) return null;

    const tNorm = clamp(t, 0, this._duration);
    let i1 = 0;
    for (let i = 0; i < kfs.length - 1; i++) {
      if (kfs[i + 1].t >= tNorm) { i1 = i; break; }
      i1 = i;
    }
    const i0 = Math.max(0, i1 - 1);
    const i2 = Math.min(kfs.length - 1, i1 + 1);
    const i3 = Math.min(kfs.length - 1, i1 + 2);
    const p0 = kfs[i0], p1 = kfs[i1], p2 = kfs[i2], p3 = kfs[i3];
    const segLen = p2.t - p1.t;
    const u = segLen > 0 ? (tNorm - p1.t) / segLen : 0;
    const s = smootherstep(0, 1, clamp(u, 0, 1));

    const cr = (v0, v1, v2, v3, t) => {
      const t2 = t*t, t3 = t2*t;
      return 0.5*((2*v1)+(-v0+v2)*t+(2*v0-5*v1+4*v2-v3)*t2+(-v0+3*v1-3*v2+v3)*t3);
    };

    const crVec = (k, ch) => cr(
      p0[k]?.[ch]??0, p1[k]?.[ch]??0, p2[k]?.[ch]??0, p3[k]?.[ch]??0, s
    );

    return {
      position: [crVec('position',0), crVec('position',1), crVec('position',2)],
      target:   [crVec('target',0),   crVec('target',1),   crVec('target',2)],
      up:       [crVec('up',0),       crVec('up',1),       crVec('up',2)],
    };
  }

  /** Generate auto-orbit camera state at time t — returns Cartesian {position,target,up} */
  _autoOrbitAt(t) {
    const preset = AUTO_ORBIT_PRESETS[this._autoOrbit];
    const base   = this._getCameraState();
    const target = base.target ?? [0, 0, 0];

    if (!preset) {
      return base; // static
    }

    // Compute orbit radius from current camera distance to target
    const dx = (base.position?.[0]??0) - target[0];
    const dy = (base.position?.[1]??0) - target[1];
    const dz = (base.position?.[2]??0) - target[2];
    const r  = Math.sqrt(dx*dx + dy*dy + dz*dz) || 5;
    const el = Math.atan2(dy, Math.sqrt(dx*dx + dz*dz));

    let az;
    if (preset.type === 'orbit') {
      az = (t * preset.rpm * Math.PI * 2 / 60) % (Math.PI * 2);
    } else if (preset.type === 'figure8') {
      az = (t * preset.rpm * Math.PI * 2 / 60) % (Math.PI * 2);
    } else if (preset.type === 'spiral') {
      const frac = clamp(t / (preset.duration ?? 10), 0, 1);
      az = frac * Math.PI * 2;
      const spiralR  = preset.startRadius + (preset.endRadius - preset.startRadius) * frac;
      const spiralEl = el + frac * 0.4;
      return {
        position: [
          target[0] + spiralR * Math.cos(spiralEl) * Math.sin(az),
          target[1] + spiralR * Math.sin(spiralEl),
          target[2] + spiralR * Math.cos(spiralEl) * Math.cos(az),
        ],
        target, up: [0, 1, 0],
      };
    } else {
      return base;
    }

    return {
      position: [
        target[0] + r * Math.cos(el) * Math.sin(az),
        target[1] + r * Math.sin(el),
        target[2] + r * Math.cos(el) * Math.cos(az),
      ],
      target, up: [0, 1, 0],
    };
  }

  // ── Private: renderer camera bridge ─────────────────────────────────────────
  // NIFRenderer uses this.position, this.target, this.up — all [x,y,z] arrays.
  // No phi/theta/radius anywhere. We read/write these directly.

  _getCameraState() {
    const r = this._renderer;
    if (!r) return { position:[0,0,5], target:[0,0,0], up:[0,1,0] };
    return {
      position: r.position ? [...r.position] : [0, 0, 5],
      target:   r.target   ? [...r.target]   : [0, 0, 0],
      up:       r.up       ? [...r.up]       : [0, 1, 0],
    };
  }

  _getBaseCamera() {
    return this._getCameraState();
  }

  _setCameraState({ position, target, up }) {
    const r = this._renderer;
    if (!r) return;
    if (position) r.position = [...position];
    if (target)   r.target   = [...target];
    if (up)       r.up       = [...up];
    r._movedThisFrame = true;
    r.renderOnce?.(1.0);
  }
}
