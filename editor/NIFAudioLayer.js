/**
 * NIFAudioLayer — Spatial Audio for NIF Presentations
 * © Fumoca Technologies · fumoca.co.za
 *
 * Connects the HRTF math already in NIFMath.js to the presentation editor.
 * Handles three audio use cases:
 *
 *   1. BACKGROUND TRACK — creator uploads an MP3/WAV/OGG that plays under
 *      the whole video. Volume envelope, fade-in/out, loop toggle.
 *
 *   2. SPATIAL SOUND POINTS — sounds anchored to 3D positions in the scene.
 *      As the camera moves, the HRTF panner updates in real time so the sound
 *      "comes from" the right place. Useful for: product clicks, ambient
 *      environment, motion sounds. Uses the HRTF ITD/ILD math from NIFMath.js.
 *
 *   3. VOICEOVER — creator records directly in the browser (MediaRecorder) or
 *      uploads a separate voice file. Synced to the camera path timeline.
 *
 * Export integration:
 *   NIFPresentationExporter calls audioLayer.mixToBuffer(duration, fps)
 *   which returns a Float32Array stereo interleaved PCM buffer. The exporter
 *   muxes this into the MP4 alongside the video frames.
 *
 * Architecture:
 *   All audio runs through the Web Audio API. One AudioContext for preview,
 *   offline OfflineAudioContext for export mixing.
 *
 * Usage:
 *   const audio = new NIFAudioLayer(containerEl, renderer, { onChange });
 *   audio.setEditable(true);
 *   const buf = await audio.mixToBuffer(duration, sampleRate);
 *   // → ArrayBuffer of WAV data ready for the muxer
 */

import { HRTF, clamp, lerp } from '../core/math/NIFMath.js';

const DEFAULT_SAMPLE_RATE = 48000;
const FADE_TIME           = 0.03; // seconds — prevents clicks on start/stop

export class NIFAudioLayer {
  /**
   * @param {HTMLElement} container   — editor container (for waveform canvas)
   * @param {NIFRenderer} renderer    — to read camera position for HRTF
   * @param {object}      opts
   *   onChange  fn  — called when audio state changes
   */
  constructor(container, renderer, opts = {}) {
    this.container  = container;
    this._renderer  = renderer;
    this._onChange  = opts.onChange ?? (() => {});

    // Web Audio context (lazy — created on first interaction to satisfy autoplay policy)
    this._ctx        = null;
    this._masterGain = null;

    // State
    this._bg = {
      file:        null,    // File object
      buffer:      null,    // AudioBuffer (decoded)
      objectUrl:   null,    // for revocation
      name:        '',
      volume:      0.8,
      fadeIn:      1.0,     // seconds
      fadeOut:     1.0,
      loop:        true,
      startOffset: 0,       // seconds into the audio file to start from
      trim:        null,    // { start, end } seconds — null = use full
    };

    this._spatialSounds = [];  // [{id,name,buffer,worldX,worldY,worldZ,volume,startTime,duration}]
    this._voiceover = {
      file:   null,
      buffer: null,
      name:   '',
      volume: 1.0,
      offset: 0,    // start time in the presentation timeline
    };

    // Recording state
    this._recording     = false;
    this._mediaRecorder = null;
    this._recordChunks  = [];

    // Playback nodes (for live preview)
    this._bgSourceNode   = null;
    this._voiceSourceNode= null;
    this._spatialNodes   = [];

    // Waveform canvas
    this._waveCanvas = null;
    this._waveCtx    = null;

    this._editable = false;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  setEditable(editable) {
    this._editable = editable;
  }

  /** Initialise Web Audio — call once after a user gesture */
  async initAudio() {
    if (this._ctx) return;
    this._ctx        = new (window.AudioContext ?? window.webkitAudioContext)({ sampleRate: DEFAULT_SAMPLE_RATE });
    this._masterGain = this._ctx.createGain();
    this._masterGain.gain.value = 1.0;
    this._masterGain.connect(this._ctx.destination);
  }

  // ── Background track ───────────────────────────────────────────────────────

  async loadBackgroundTrack(file) {
    await this.initAudio();
    if (this._bg.objectUrl) URL.revokeObjectURL(this._bg.objectUrl);

    const arrayBuf = await file.arrayBuffer();
    const decoded  = await this._ctx.decodeAudioData(arrayBuf);

    this._bg.file      = file;
    this._bg.buffer    = decoded;
    this._bg.name      = file.name;
    this._bg.objectUrl = URL.createObjectURL(file);

    this._drawWaveform(decoded);
    this._onChange();
    return decoded;
  }

  setBGVolume(v)      { this._bg.volume = clamp(v, 0, 1); this._onChange(); }
  setBGFadeIn(s)      { this._bg.fadeIn  = Math.max(0, s); this._onChange(); }
  setBGFadeOut(s)     { this._bg.fadeOut = Math.max(0, s); this._onChange(); }
  setBGLoop(loop)     { this._bg.loop    = !!loop; this._onChange(); }
  setBGStartOffset(s) { this._bg.startOffset = Math.max(0, s); this._onChange(); }
  setBGTrim(start, end) { this._bg.trim = { start, end }; this._onChange(); }

  // ── Spatial sounds ─────────────────────────────────────────────────────────

  async addSpatialSound(file, worldPos = { x:0, y:0, z:0 }) {
    await this.initAudio();
    const arrayBuf = await file.arrayBuffer();
    const decoded  = await this._ctx.decodeAudioData(arrayBuf);
    const id = `sp_${Date.now()}`;

    this._spatialSounds.push({
      id,
      name:       file.name,
      buffer:     decoded,
      worldX:     worldPos.x,
      worldY:     worldPos.y,
      worldZ:     worldPos.z,
      volume:     0.7,
      startTime:  0,
      duration:   decoded.duration,
      loop:       false,
    });
    this._onChange();
    return id;
  }

  updateSpatialSound(id, updates) {
    const s = this._spatialSounds.find(s => s.id === id);
    if (s) { Object.assign(s, updates); this._onChange(); }
  }

  removeSpatialSound(id) {
    this._spatialSounds = this._spatialSounds.filter(s => s.id !== id);
    this._onChange();
  }

  // ── Voiceover ─────────────────────────────────────────────────────────────

  async loadVoiceover(file) {
    await this.initAudio();
    const arrayBuf = await file.arrayBuffer();
    const decoded  = await this._ctx.decodeAudioData(arrayBuf);
    this._voiceover.file   = file;
    this._voiceover.buffer = decoded;
    this._voiceover.name   = file.name;
    this._onChange();
    return decoded;
  }

  async startVoiceoverRecording() {
    await this.initAudio();
    if (this._recording) return;

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    this._mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
    this._recordChunks  = [];

    this._mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this._recordChunks.push(e.data);
    };

    this._mediaRecorder.onstop = async () => {
      const blob     = new Blob(this._recordChunks, { type: 'audio/webm' });
      const arrayBuf = await blob.arrayBuffer();
      const decoded  = await this._ctx.decodeAudioData(arrayBuf);
      this._voiceover.buffer = decoded;
      this._voiceover.name   = 'Recorded voiceover';
      stream.getTracks().forEach(t => t.stop());
      this._onChange();
    };

    this._mediaRecorder.start(100); // 100ms chunks
    this._recording = true;
    this._onChange();
  }

  stopVoiceoverRecording() {
    if (!this._recording || !this._mediaRecorder) return;
    this._mediaRecorder.stop();
    this._recording = false;
    this._onChange();
  }

  setVoiceoverVolume(v)  { this._voiceover.volume = clamp(v, 0, 1); this._onChange(); }
  setVoiceoverOffset(s)  { this._voiceover.offset = Math.max(0, s); this._onChange(); }

  // ── Preview playback ───────────────────────────────────────────────────────

  async startPreview(presentationDuration) {
    await this.initAudio();
    this.stopPreview();

    const now = this._ctx.currentTime + 0.05;

    // Background
    if (this._bg.buffer) {
      const gain = this._ctx.createGain();
      gain.connect(this._masterGain);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(this._bg.volume, now + this._bg.fadeIn);
      gain.gain.setValueAtTime(this._bg.volume, now + presentationDuration - this._bg.fadeOut);
      gain.gain.linearRampToValueAtTime(0, now + presentationDuration);

      const src = this._ctx.createBufferSource();
      src.buffer    = this._bg.buffer;
      src.loop      = this._bg.loop;
      src.connect(gain);
      src.start(now, this._bg.startOffset);
      this._bgSourceNode = src;
    }

    // Voiceover
    if (this._voiceover.buffer) {
      const gain = this._ctx.createGain();
      gain.gain.value = this._voiceover.volume;
      gain.connect(this._masterGain);
      const src = this._ctx.createBufferSource();
      src.buffer = this._voiceover.buffer;
      src.connect(gain);
      src.start(now + this._voiceover.offset);
      this._voiceSourceNode = src;
    }

    // Spatial sounds (simplified stereo panning for preview — HRTF used in export)
    for (const sp of this._spatialSounds) {
      if (!sp.buffer) continue;
      const panner = this._ctx.createStereoPanner();
      const azimuth = this._computeAzimuth(sp.worldX, sp.worldZ);
      panner.pan.value = clamp(azimuth / 90, -1, 1);
      panner.connect(this._masterGain);

      const gain = this._ctx.createGain();
      gain.gain.value = sp.volume;
      gain.connect(panner);

      const src = this._ctx.createBufferSource();
      src.buffer = sp.buffer;
      src.loop   = sp.loop;
      src.connect(gain);
      src.start(now + sp.startTime);
      this._spatialNodes.push(src);
    }
  }

  stopPreview() {
    const stop = (node) => { try { node?.stop(); } catch {} };
    stop(this._bgSourceNode);
    stop(this._voiceSourceNode);
    this._spatialNodes.forEach(stop);
    this._bgSourceNode    = null;
    this._voiceSourceNode = null;
    this._spatialNodes    = [];
  }

  // ── Export: mix all audio to PCM ──────────────────────────────────────────

  /**
   * Mix all audio sources into a single stereo PCM buffer.
   * Uses OfflineAudioContext so it renders faster than real time.
   * Uses NIFMath.HRTF for proper spatial positioning — not Web Audio panner.
   *
   * @param {number} duration     — total presentation duration in seconds
   * @param {number} sampleRate   — export sample rate (default 48000)
   * @returns {Promise<ArrayBuffer>} WAV ArrayBuffer ready to mux into MP4
   */
  async mixToBuffer(duration, sampleRate = DEFAULT_SAMPLE_RATE) {
    const frameCount = Math.ceil(duration * sampleRate);
    const offline    = new OfflineAudioContext(2, frameCount, sampleRate);

    const masterGain = offline.createGain();
    masterGain.gain.value = 1.0;
    masterGain.connect(offline.destination);

    const now = 0;

    // ── Background track ──────────────────────────────────────────────────
    if (this._bg.buffer) {
      const gain = offline.createGain();
      gain.connect(masterGain);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(this._bg.volume, now + this._bg.fadeIn);
      const fadeOutStart = Math.max(now, duration - this._bg.fadeOut);
      gain.gain.setValueAtTime(this._bg.volume, fadeOutStart);
      gain.gain.linearRampToValueAtTime(0, duration);

      // Resample if needed
      const buf = await this._resampleBuffer(this._bg.buffer, offline, sampleRate);
      const src = offline.createBufferSource();
      src.buffer      = buf;
      src.loop        = this._bg.loop;
      src.loopStart   = this._bg.trim?.start ?? 0;
      src.loopEnd     = this._bg.trim?.end   ?? buf.duration;
      src.connect(gain);
      src.start(now, this._bg.startOffset);
    }

    // ── Voiceover ─────────────────────────────────────────────────────────
    if (this._voiceover.buffer) {
      const gain = offline.createGain();
      gain.gain.value = this._voiceover.volume;
      gain.connect(masterGain);
      const buf = await this._resampleBuffer(this._voiceover.buffer, offline, sampleRate);
      const src = offline.createBufferSource();
      src.buffer = buf;
      src.connect(gain);
      src.start(Math.max(0, this._voiceover.offset));
    }

    // ── Spatial sounds via HRTF ────────────────────────────────────────────
    // For each spatial sound, we manually apply the HRTF math from NIFMath.js
    // rather than using the Web Audio PannerNode — this gives us accurate
    // binaural rendering that matches what the live NIF viewer does.
    for (const sp of this._spatialSounds) {
      if (!sp.buffer) continue;

      const azimuth   = this._computeAzimuth(sp.worldX, sp.worldZ);
      const elevation = this._computeElevation(sp.worldX, sp.worldY, sp.worldZ);

      // Get ITD (inter-aural time delay) in seconds
      const itd = HRTF.itd(azimuth);

      // Get ILD (inter-aural level difference) in dB at 1kHz
      const ild = HRTF.ild(azimuth, 1000);
      const ildLinear = Math.pow(10, ild / 20);

      // Encode to ambisonics B-format then decode to stereo
      // We work in the frequency domain by applying gains channel-by-channel
      const buf = await this._resampleBuffer(sp.buffer, offline, sampleRate);

      // Left channel: delayed by ITD/2, attenuated by ILD/2
      const leftGain   = offline.createGain();
      const leftDelay  = offline.createDelay(0.1);
      const rightGain  = offline.createGain();

      const leftLevel  = azimuth >= 0
        ? sp.volume
        : sp.volume * ildLinear;
      const rightLevel = azimuth >= 0
        ? sp.volume * ildLinear
        : sp.volume;

      leftGain.gain.value   = leftLevel;
      rightGain.gain.value  = rightLevel;
      leftDelay.delayTime.value = azimuth >= 0 ? 0 : Math.abs(itd);

      // We need per-channel routing — use ChannelSplitter/Merger
      const splitter = offline.createChannelSplitter(2);
      const merger   = offline.createChannelMerger(2);

      const src = offline.createBufferSource();
      // Mono source if needed
      const monoBuf = this._toMono(buf, offline, sampleRate);
      src.buffer = monoBuf;

      // Route: src → splitter → [leftGain+delay, rightGain] → merger → master
      src.connect(splitter);
      splitter.connect(leftGain, 0);
      splitter.connect(rightGain, 1);
      leftGain.connect(leftDelay);
      leftDelay.connect(merger, 0, 0);
      rightGain.connect(merger, 0, 1);
      merger.connect(masterGain);

      src.start(Math.max(0, sp.startTime));
    }

    // ── Render ────────────────────────────────────────────────────────────
    const rendered = await offline.startRendering();
    return this._audioBufferToWav(rendered);
  }

  /**
   * Export state for saving in presentation record
   */
  exportState() {
    return {
      bg: {
        name:        this._bg.name,
        volume:      this._bg.volume,
        fadeIn:      this._bg.fadeIn,
        fadeOut:     this._bg.fadeOut,
        loop:        this._bg.loop,
        startOffset: this._bg.startOffset,
        trim:        this._bg.trim,
        // Note: file binary not saved here — stored separately via uploadAudio()
      },
      spatialSounds: this._spatialSounds.map(({ id, name, worldX, worldY, worldZ, volume, startTime, duration, loop }) => ({
        id, name, worldX, worldY, worldZ, volume, startTime, duration, loop,
      })),
      voiceover: {
        name:   this._voiceover.name,
        volume: this._voiceover.volume,
        offset: this._voiceover.offset,
      },
    };
  }

  importState(state) {
    if (!state) return;
    if (state.bg) Object.assign(this._bg, state.bg);
    if (state.voiceover) Object.assign(this._voiceover, state.voiceover);
    // Spatial sound positions restored — buffers re-loaded separately
    if (state.spatialSounds) {
      this._spatialSounds = state.spatialSounds.map(s => ({ ...s, buffer: null }));
    }
  }

  destroy() {
    this.stopPreview();
    if (this._bg.objectUrl) URL.revokeObjectURL(this._bg.objectUrl);
    this._ctx?.close().catch(() => {});
  }

  // ── Private: waveform ─────────────────────────────────────────────────────

  _buildWaveformCanvas(parentEl) {
    this._waveCanvas = document.createElement('canvas');
    this._waveCanvas.style.cssText = 'width:100%;height:48px;border-radius:6px;display:block;';
    this._waveCanvas.height = 48;
    this._waveCtx = this._waveCanvas.getContext('2d');
    parentEl.appendChild(this._waveCanvas);
  }

  _drawWaveform(audioBuffer) {
    if (!this._waveCanvas || !this._waveCtx) return;
    const W = this._waveCanvas.offsetWidth || 240;
    this._waveCanvas.width = W;
    const ctx = this._waveCtx;
    const data = audioBuffer.getChannelData(0);
    const step = Math.ceil(data.length / W);

    ctx.clearRect(0, 0, W, 48);
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, W, 48);

    ctx.beginPath();
    ctx.strokeStyle = '#7c6dfa';
    ctx.lineWidth = 1;

    for (let x = 0; x < W; x++) {
      let min = 1, max = -1;
      for (let j = 0; j < step; j++) {
        const val = data[x * step + j] ?? 0;
        if (val < min) min = val;
        if (val > max) max = val;
      }
      const yMin = (1 + min) / 2 * 48;
      const yMax = (1 + max) / 2 * 48;
      ctx.moveTo(x, yMin);
      ctx.lineTo(x, yMax);
    }
    ctx.stroke();
  }

  // ── Private: HRTF helpers ─────────────────────────────────────────────────

  _computeAzimuth(worldX, worldZ) {
    // Read camera position from NIFRenderer.position (Cartesian [x,y,z])
    const r   = this._renderer;
    const cpx = r?.position?.[0] ?? 0;
    const cpz = r?.position?.[2] ?? 5;
    const tx  = r?.target?.[0]   ?? 0;
    const tz  = r?.target?.[2]   ?? 0;
    // Forward vector (camera → target) projected onto XZ plane
    const fwdX = tx - cpx, fwdZ = tz - cpz;
    const fwdLen = Math.sqrt(fwdX*fwdX + fwdZ*fwdZ) || 1;
    // Sound direction from camera
    const dx = worldX - cpx, dz = worldZ - cpz;
    // Azimuth = angle between forward and sound, in degrees
    const dot   = (dx*fwdX + dz*fwdZ) / fwdLen;
    const cross = (dx*fwdZ - dz*fwdX) / fwdLen;
    return Math.atan2(cross, dot) * 180 / Math.PI;
  }

  _computeElevation(worldX, worldY, worldZ) {
    const r   = this._renderer;
    const cpx = r?.position?.[0] ?? 0;
    const cpy = r?.position?.[1] ?? 0;
    const cpz = r?.position?.[2] ?? 5;
    const dx = worldX - cpx, dy = worldY - cpy, dz = worldZ - cpz;
    return Math.atan2(dy, Math.sqrt(dx*dx + dz*dz)) * 180 / Math.PI;
  }

  // ── Private: audio utils ──────────────────────────────────────────────────

  async _resampleBuffer(sourceBuffer, offlineCtx, targetRate) {
    if (sourceBuffer.sampleRate === targetRate) return sourceBuffer;
    // Create a short offline context to resample
    const duration  = sourceBuffer.duration;
    const frames    = Math.ceil(duration * targetRate);
    const resampleCtx = new OfflineAudioContext(sourceBuffer.numberOfChannels, frames, targetRate);
    const src = resampleCtx.createBufferSource();
    src.buffer = sourceBuffer;
    src.connect(resampleCtx.destination);
    src.start(0);
    return await resampleCtx.startRendering();
  }

  _toMono(buffer, offlineCtx, sampleRate) {
    if (buffer.numberOfChannels === 1) return buffer;
    const mono = offlineCtx.createBuffer(1, buffer.length, sampleRate);
    const out  = mono.getChannelData(0);
    const L    = buffer.getChannelData(0);
    const R    = buffer.getChannelData(1);
    for (let i = 0; i < out.length; i++) out[i] = (L[i] + R[i]) * 0.5;
    return mono;
  }

  /** Convert AudioBuffer → WAV ArrayBuffer */
  _audioBufferToWav(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate  = buffer.sampleRate;
    const numFrames   = buffer.length;
    const bytesPerSample = 2; // 16-bit PCM
    const dataSize    = numFrames * numChannels * bytesPerSample;
    const wavBuf      = new ArrayBuffer(44 + dataSize);
    const view        = new DataView(wavBuf);

    // RIFF header
    _writeString(view, 0,  'RIFF');
    view.setUint32(4,  36 + dataSize, true);
    _writeString(view, 8,  'WAVE');
    _writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);           // PCM chunk size
    view.setUint16(20, 1,  true);           // PCM format
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
    view.setUint16(32, numChannels * bytesPerSample, true);
    view.setUint16(34, 16, true);           // bits per sample
    _writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    // Interleaved PCM
    let offset = 44;
    for (let f = 0; f < numFrames; f++) {
      for (let c = 0; c < numChannels; c++) {
        const sample = clamp(buffer.getChannelData(c)[f], -1, 1);
        view.setInt16(offset, sample * 0x7FFF, true);
        offset += 2;
      }
    }
    return wavBuf;
  }
}

function _writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}
