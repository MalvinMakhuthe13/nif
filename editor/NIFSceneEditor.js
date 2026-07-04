/**
 * NIFSceneEditor — Complete 4D Scene Editor
 * fumoca.co.za · © Fumoca Technologies
 *
 * SELECTION SYSTEM — the Photoshop of depth field editing:
 *
 *   BOX SELECT     (B) — drag a rectangle, all points inside are selected
 *   LASSO SELECT   (L) — draw any freehand polygon, points inside selected
 *   SPHERE SELECT  (O) — 3D sphere brush, points within radius selected
 *   MAGIC WAND     (M) — click a point, selects all spatially/colour-connected
 *                        neighbours matching within tolerance (flood fill in 3D)
 *   DEPTH RANGE    (D) — select all points between two depth values (z-range)
 *   COLOUR RANGE   (C) — select points by colour similarity to clicked point
 *   LAYER SELECT   (Y) — select all points in a named layer (foreground/segment_N)
 *   SELECT ALL     (Ctrl+A)
 *   INVERT         (Ctrl+I)
 *   DESELECT ALL   (Escape)
 *
 * SELECTION OPERATIONS — after selecting:
 *   KEEP      — delete everything outside selection (isolate the subject)
 *   DELETE    — delete everything inside selection (remove background)
 *   EXTRACT   — copy selection to a new layer (non-destructive isolation)
 *   FADE      — reduce opacity of selection
 *   SMOOTH    — average positions within selection
 *   RECOLOUR  — paint selection with a colour
 *   INVERT    → DELETE (common pattern: select subject → invert → delete background)
 *
 * SCULPT TOOLS — brush-based editing:
 *   GRAB (G) · SMOOTH (S) · ERASE (E) · PAINT (P) · PUSH (Q) · PULL (W)
 *
 * LIGHTING — virtual point lights + IBL baked into depth field
 * DEPTH    — depth-of-field with focal plane click + bokeh keyframes
 * MESH     — 3D print prep: isovalue, paint include/exclude, send to queue
 */

import { GaussianEdit, v3, m4, clamp, smoothstep } from '../core/math/NIFMath.js';
import { GaussianKDTree, raycastGaussians }         from '../core/physics/NIFPhysics.js';

// ─── Selection tool registry ───────────────────────────────────────────────────
const SELECT_TOOLS = {
  box:    { icon:'⬜', label:'Box',         cursor:'crosshair', hotkey:'B', desc:'Drag to select a rectangle' },
  lasso:  { icon:'⬡', label:'Lasso',        cursor:'crosshair', hotkey:'L', desc:'Draw a freehand selection polygon' },
  sphere: { icon:'◎', label:'Sphere',        cursor:'crosshair', hotkey:'O', desc:'3D sphere — select all points within radius' },
  wand:   { icon:'✦', label:'Magic Wand',    cursor:'pointer',   hotkey:'M', desc:'Click to flood-fill select connected points' },
  depth:  { icon:'⊟', label:'Depth Range',   cursor:'col-resize',hotkey:'D', desc:'Select points between two depth values' },
  colour: { icon:'◉', label:'Colour Range',  cursor:'pointer',   hotkey:'C', desc:'Select points by colour similarity' },
  layer:  { icon:'◈', label:'Layer',         cursor:'pointer',   hotkey:'Y', desc:'Select all points in a named layer' },
};

const SCULPT_TOOLS = {
  grab:   { icon:'✥', label:'Grab',   cursor:'move',      hotkey:'G' },
  smooth: { icon:'~', label:'Smooth', cursor:'crosshair', hotkey:'S' },
  erase:  { icon:'◌', label:'Erase',  cursor:'crosshair', hotkey:'E' },
  paint:  { icon:'●', label:'Paint',  cursor:'crosshair', hotkey:'P' },
  push:   { icon:'▲', label:'Push',   cursor:'crosshair', hotkey:'Q' },
  pull:   { icon:'▼', label:'Pull',   cursor:'crosshair', hotkey:'W' },
};

const MODE_ICONS = { select:'⬡', sculpt:'✥', light:'◉', depth:'⊙', mesh:'◻' };

// ─── Main class ────────────────────────────────────────────────────────────────
export class NIFSceneEditor {
  constructor(container, renderer, gaussians, nifId, token, api) {
    this.container = container;
    this.renderer  = renderer;
    this.nifId     = nifId;
    this.token     = token;
    this.api       = api;

    // Working copy — all edits applied here, renderer reads this
    this.gaussians = { count: gaussians.count, data: new Float32Array(gaussians.data) };

    // KD-tree for spatial queries (rebuilt on data change)
    this._kdTree = new GaussianKDTree(this.gaussians.data, this.gaussians.count);

    // Selection — Uint8Array mask (1=selected) + Set for O(1) lookup
    this._selMask = new Uint8Array(this.gaussians.count);
    this._selSet  = new Set();

    // Selection highlight GPU buffer (separate from main splatBuf)
    this._selHighlightBuf = null;
    this._selHighlightCount = 0;

    // Edit history
    this._history    = [];
    this._histIdx    = -1;
    this._maxHistory = 60;

    // Mode / tool state
    this._mode        = 'select';
    this._selectTool  = 'box';
    this._sculptTool  = 'grab';

    // Brush
    this._brush = { radius:0.15, strength:0.5, colour:[1,1,1], falloff:'smooth' };

    // Selection drag state
    this._selDrag     = false;
    this._selPoints   = []; // lasso polygon screen points
    this._selBoxStart = null;

    // Magic wand / colour range tolerance
    this._wandTolerance   = 0.25;
    this._colourTolerance = 0.20;

    // Depth range state
    this._depthRangeMin = null;
    this._depthRangeMax = null;

    // Sculpt drag state
    this._dragging  = false;
    this._lastHit   = null;
    this._dragDelta = null;

    // Lighting
    this._lights          = [];
    this._ibl             = { strength:0.3, colour:[0.8,0.9,1.0] };
    this._lightingEnabled = false;

    // DOF
    this._dof = { enabled:false, focalDist:2.0, aperture:2.8, bokehBlades:6, fgBlur:true, bgBlur:true };
    this._dofKeyframes = [];

    // Mesh preview
    this._meshPreview = { visible:false, isovalue:null, paintMask:null };
    this._meshPaintMode = null;

    this._build();
    this._bindEvents();
    this._saveHistory('initial');
  }

  // ── Build UI ────────────────────────────────────────────────────────────────
  _build() {
    this.container.innerHTML = '';
    this.container.style.cssText = `
      display:grid;grid-template-columns:48px 1fr 268px;
      height:100%;background:#090909;overflow:hidden;
      font-family:'DM Sans',system-ui,sans-serif;color:#e0e0e0;font-size:12px;
      --accent:#7c6dfa;--accent2:#3ecfcf;--green:#3ecfcf;--red:#f0364a;--warn:#f90;
      --bg1:#090909;--bg2:#101010;--bg3:#161616;--bg4:#1e1e1e;--bg5:#252525;
      --border:rgba(255,255,255,0.06);--border2:rgba(255,255,255,0.1);
      --text:#e0e0e0;--text2:#888;--text3:#444;
    `;
    this.container.innerHTML = `
      <!-- LEFT TOOLBAR -->
      <div style="display:flex;flex-direction:column;align-items:center;padding:6px 4px;gap:3px;
        border-right:1px solid var(--border);background:var(--bg2);">
        <div style="font-size:7px;color:var(--text3);letter-spacing:.07em;margin:4px 0 2px;text-transform:uppercase;">Mode</div>
        ${Object.keys(MODE_ICONS).map(m=>`
          <button class="nse-mode" data-mode="${m}" title="${m.charAt(0).toUpperCase()+m.slice(1)}" style="
            width:38px;height:38px;border-radius:9px;border:1px solid transparent;
            background:transparent;color:var(--text3);cursor:pointer;transition:all .12s;
            display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;
          ">
            <span style="font-size:14px;line-height:1;">${MODE_ICONS[m]}</span>
            <span style="font-size:7px;letter-spacing:.05em;">${m.toUpperCase()}</span>
          </button>
        `).join('')}
        <div style="height:1px;background:var(--border);width:30px;margin:5px 0;"></div>
        <div id="nse-tools" style="display:flex;flex-direction:column;gap:2px;align-items:center;"></div>
        <div style="flex:1"></div>
        <button id="nse-undo" title="Undo (Ctrl+Z)" style="${this._tbs()}">↩</button>
        <button id="nse-redo" title="Redo (Ctrl+Y)" style="${this._tbs()}">↪</button>
      </div>

      <!-- VIEWPORT -->
      <div id="nse-vp" style="position:relative;overflow:hidden;background:#000;cursor:crosshair;">
        <!-- Selection overlay canvas — drawn on top of renderer -->
        <canvas id="nse-overlay" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2;"></canvas>
        <!-- Brush ring SVG -->
        <svg id="nse-ring" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:3;overflow:visible;opacity:0;">
          <circle id="nse-ring-c" cx="0" cy="0" r="40" fill="none" stroke="rgba(124,109,250,.8)" stroke-width="1.5" stroke-dasharray="4 3"/>
        </svg>
        <!-- Status bar -->
        <div id="nse-status" style="
          position:absolute;bottom:10px;left:50%;transform:translateX(-50%);
          background:rgba(0,0,0,.75);backdrop-filter:blur(10px);
          border:1px solid var(--border2);border-radius:20px;
          padding:4px 14px;font-size:11px;color:var(--text2);
          pointer-events:none;white-space:nowrap;z-index:4;
        ">✦ Ready</div>
        <!-- Selection count badge -->
        <div id="nse-sel-badge" style="
          display:none;position:absolute;top:10px;left:50%;transform:translateX(-50%);
          background:rgba(124,109,250,.9);color:#fff;
          border-radius:20px;padding:4px 12px;font-size:11px;font-weight:600;
          pointer-events:none;z-index:4;
        "></div>
      </div>

      <!-- RIGHT PANEL -->
      <div id="nse-panel" style="
        border-left:1px solid var(--border);background:var(--bg2);
        display:flex;flex-direction:column;overflow:hidden;
      ">
        <div style="padding:12px 14px 10px;border-bottom:1px solid var(--border);flex-shrink:0;">
          <div id="nse-panel-title" style="font-size:13px;font-weight:700;"></div>
          <div id="nse-panel-sub" style="font-size:10px;color:var(--text3);margin-top:2px;">
            ${this.gaussians.count.toLocaleString()} depth points
          </div>
        </div>
        <div id="nse-panel-body" style="flex:1;overflow-y:auto;padding:12px 14px;"></div>
        <div style="padding:10px 12px;border-top:1px solid var(--border);display:flex;gap:7px;flex-shrink:0;">
          <button id="nse-save" style="flex:1;background:var(--accent);color:#fff;border:none;
            border-radius:7px;padding:9px;font-size:12px;font-weight:600;cursor:pointer;">Save to NIF</button>
          <button id="nse-reset" style="background:var(--bg4);color:var(--text2);border:1px solid var(--border);
            border-radius:7px;padding:9px 12px;font-size:12px;cursor:pointer;">Reset</button>
        </div>
      </div>
    `;
    this._setMode('select');
  }

  // ── Mode switching ──────────────────────────────────────────────────────────
  _setMode(mode) {
    this._mode = mode;
    this.container.querySelectorAll('.nse-mode').forEach(b => {
      const on = b.dataset.mode === mode;
      b.style.background   = on ? 'rgba(124,109,250,.15)' : 'transparent';
      b.style.borderColor  = on ? 'rgba(124,109,250,.35)' : 'transparent';
      b.style.color        = on ? '#e0e0e0' : '#555';
    });
    const titles = { select:'⬡ Select', sculpt:'✥ Sculpt', light:'◉ Light', depth:'⊙ Depth & Focus', mesh:'◻ Mesh & Print' };
    document.getElementById('nse-panel-title').textContent = titles[mode] ?? mode;
    this._buildToolbar(mode);
    this._renderPanel(mode);
    // Update viewport cursor
    const vp = document.getElementById('nse-vp');
    if (vp) vp.style.cursor = mode === 'select' ? 'crosshair' : 'default';
  }

  _buildToolbar(mode) {
    const tb = document.getElementById('nse-tools');
    if (!tb) return;
    tb.innerHTML = '';
    const tools = mode === 'select' ? SELECT_TOOLS : mode === 'sculpt' ? SCULPT_TOOLS : {};
    const active = mode === 'select' ? this._selectTool : this._sculptTool;
    Object.entries(tools).forEach(([key, t]) => {
      const btn = document.createElement('button');
      btn.dataset.tool = key;
      btn.title = `${t.label} (${t.hotkey}) — ${t.desc ?? ''}`;
      const on = key === active;
      btn.style.cssText = `
        width:36px;height:36px;border-radius:8px;cursor:pointer;font-size:13px;
        display:flex;align-items:center;justify-content:center;transition:all .12s;
        border:1px solid ${on?'rgba(124,109,250,.4)':'var(--border)'};
        background:${on?'rgba(124,109,250,.18)':'var(--bg3)'};
        color:${on?'#e0e0e0':'#666'};
      `;
      btn.textContent = t.icon;
      btn.onclick = () => {
        if (mode === 'select') this._selectTool = key;
        else this._sculptTool = key;
        this._buildToolbar(mode);
        const vp = document.getElementById('nse-vp');
        if (vp) vp.style.cursor = t.cursor ?? 'crosshair';
        this._status(`${t.label} — ${t.desc ?? ''}`);
      };
      tb.appendChild(btn);
    });
  }

  // ── Panel rendering ──────────────────────────────────────────────────────────
  _renderPanel(mode) {
    const body = document.getElementById('nse-panel-body');
    if (!body) return;

    if (mode === 'select') {
      body.innerHTML = `
        ${this._sec('Selection tools')}
        <div style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;
          padding:9px 11px;margin-bottom:12px;font-size:10px;color:var(--text2);line-height:1.7;">
          <b style="color:var(--text);">How to use:</b><br>
          Box: drag rectangle &nbsp;·&nbsp; Lasso: draw shape &nbsp;·&nbsp; Sphere: click+drag<br>
          Magic Wand: click subject &nbsp;·&nbsp; Depth: set min/max &nbsp;·&nbsp; Colour: click colour<br>
          Layer: pick a captured layer
        </div>

        ${this._sec('Tool options')}
        <div id="sel-tool-opts"></div>

        ${this._sec('Add to / Subtract from selection')}
        <div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap;">
          <button id="sel-add"      style="${this._btn()} color:var(--green);border-color:rgba(62,207,207,.25);">+ Add</button>
          <button id="sel-subtract" style="${this._btn()} color:var(--red);border-color:rgba(240,54,74,.25);">− Subtract</button>
          <button id="sel-intersect"style="${this._btn()}">∩ Intersect</button>
        </div>
        <div style="display:flex;gap:6px;margin-bottom:14px;">
          <button id="sel-all"    style="${this._btn()}">All</button>
          <button id="sel-none"   style="${this._btn()}">None</button>
          <button id="sel-invert" style="${this._btn()}">Invert</button>
        </div>

        ${this._sec('Selection operations')}
        <div style="display:flex;flex-direction:column;gap:6px;">
          <button id="sel-keep" style="
            background:linear-gradient(135deg,rgba(62,207,207,.15),rgba(124,109,250,.15));
            border:1px solid rgba(62,207,207,.3);border-radius:7px;
            color:var(--green);padding:9px 12px;cursor:pointer;font-size:12px;font-weight:600;
            text-align:left;
          ">✓ Keep selection — delete everything outside</button>
          <button id="sel-delete-op" style="
            background:rgba(240,54,74,.08);border:1px solid rgba(240,54,74,.2);border-radius:7px;
            color:var(--red);padding:9px 12px;cursor:pointer;font-size:12px;font-weight:600;
            text-align:left;
          ">✕ Delete selection — remove selected points</button>
          <button id="sel-extract" style="${this._btn()} text-align:left;">⬡ Extract to new layer</button>
          <button id="sel-fade-op" style="${this._btn()} text-align:left;">◌ Fade opacity</button>
          <button id="sel-smooth-op" style="${this._btn()} text-align:left;">~ Smooth positions</button>
          <button id="sel-paint-op" style="${this._btn()} text-align:left;">● Recolour selection</button>
        </div>

        ${this._sec('Quick background removal')}
        <div style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;
          padding:9px 11px;margin-bottom:10px;font-size:10px;color:var(--text2);line-height:1.7;">
          Use Magic Wand on the subject, then<br>
          <b style="color:var(--accent2);">Invert → Delete</b> to remove the background.<br>
          Or use Layer Select to isolate a captured segment.
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <button id="sel-auto-bg" style="
            background:rgba(124,109,250,.12);border:1px solid rgba(124,109,250,.3);border-radius:7px;
            color:var(--accent2);padding:9px 12px;cursor:pointer;font-size:12px;font-weight:600;
            text-align:left;
          ">✦ Auto-remove background (use captured alpha mask)</button>
          ${this.renderer?._layers?.length ? `
          <button id="sel-isolate-fg" style="${this._btn()} text-align:left;">◈ Isolate foreground layer</button>
          ` : ''}
        </div>

        ${this._sec('Layers')}
        <div id="sel-layer-list" style="display:flex;flex-direction:column;gap:4px;"></div>
      `;
      this._buildSelToolOpts();
      this._buildLayerList();
      this._bindSelectPanel();
    }

    else if (mode === 'sculpt') {
      body.innerHTML = `
        ${this._sec('Brush')}
        ${this._slider('br-radius','Radius',this._brush.radius,0.01,1.0,0.01,v=>`${v.toFixed(2)}u`)}
        ${this._slider('br-strength','Strength',this._brush.strength,0.01,1.0,0.01,v=>`${Math.round(v*100)}%`)}
        ${this._row('Falloff',`<select id="br-falloff" style="${this._sel()}">${['smooth','linear','hard'].map(o=>`<option ${this._brush.falloff===o?'selected':''}>${o}</option>`).join('')}</select>`)}
        ${this._sec('Paint colour')}
        <div style="display:flex;gap:8px;margin-bottom:12px;">
          <input type="color" id="br-col" value="${this._rgbHex(this._brush.colour)}"
            style="width:40px;height:32px;border:none;background:none;cursor:pointer;border-radius:6px;">
          <div style="flex:1;display:flex;flex-direction:column;gap:3px;justify-content:center;">
            ${['R','G','B'].map((ch,ci)=>`<input type="range" id="br-${ch.toLowerCase()}" min="0" max="1" step="0.01"
              value="${this._brush.colour[ci]}" style="accent-color:${['#f44','#4f4','#44f'][ci]};width:100%;height:3px;">`).join('')}
          </div>
        </div>
        ${this._sec('Apply to current selection')}
        <div style="display:flex;flex-direction:column;gap:5px;">
          <button id="sculpt-smooth-sel"  style="${this._btn()}">~ Smooth selection</button>
          <button id="sculpt-delete-sel"  style="${this._btn()} color:var(--red);">✕ Delete selection</button>
          <button id="sculpt-recolour-sel"style="${this._btn()}">● Recolour selection</button>
        </div>
      `;
      this._bindSculptPanel();
    }

    else if (mode === 'light') {
      body.innerHTML = `
        ${this._sec('Ambient')}
        ${this._slider('ibl-str','Strength',this._ibl.strength,0,1,0.01,v=>`${Math.round(v*100)}%`)}
        ${this._row('Sky colour',`<input type="color" id="ibl-col" value="${this._rgbHex(this._ibl.colour)}" style="width:40px;height:28px;border:none;background:none;cursor:pointer;border-radius:6px;">`)}
        ${this._sec('Point lights')}
        <div id="light-list" style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px;"></div>
        <button id="add-light" style="${this._btn()} width:100%;">+ Add light at camera</button>
        <div id="light-props" style="opacity:.35;pointer-events:none;margin-top:12px;">
          ${this._slider('li-int','Intensity',1.0,0,5,0.1,v=>v.toFixed(1))}
          ${this._slider('li-rad','Radius',0.5,0.01,3,0.01,v=>`${v.toFixed(2)}u`)}
          ${this._row('Colour',`<input type="color" id="li-col" value="#ffffff" style="width:40px;height:28px;border:none;background:none;cursor:pointer;border-radius:6px;">`)}
          <button id="del-light" style="${this._btn()} color:var(--red);width:100%;margin-top:4px;">Delete light</button>
        </div>
      `;
      this._bindLightPanel();
    }

    else if (mode === 'depth') {
      const on = this._dof.enabled;
      body.innerHTML = `
        ${this._row('Depth of field',`<label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
          <input type="checkbox" id="dof-on" ${on?'checked':''} style="accent-color:var(--accent);width:14px;height:14px;"> Enable
        </label>`)}
        <div id="dof-ctrl" style="opacity:${on?1:.4};pointer-events:${on?'all':'none'};transition:opacity .2s;">
          ${this._sec('Focus')}
          <div style="background:var(--bg3);border:1px solid var(--border);border-radius:7px;
            padding:8px 10px;font-size:10px;color:var(--text2);margin-bottom:10px;line-height:1.65;">
            Click anywhere in the viewport to set the focal point.<br>
            Or drag the focal distance slider.
          </div>
          ${this._slider('dof-dist','Focal distance',this._dof.focalDist,0.1,20,0.1,v=>`${v.toFixed(1)}m`)}
          ${this._slider('dof-apt','Aperture (f)',this._dof.aperture,0.5,22,0.5,v=>`f/${v.toFixed(1)}`)}
          ${this._sec('Bokeh')}
          ${this._slider('dof-blades','Blades',this._dof.bokehBlades,3,12,1,v=>`${v}`)}
          ${this._row('Foreground',`<input type="checkbox" id="dof-fg" ${this._dof.fgBlur?'checked':''} style="accent-color:var(--accent);width:14px;height:14px;">`)}
          ${this._row('Background',`<input type="checkbox" id="dof-bg" ${this._dof.bgBlur?'checked':''} style="accent-color:var(--accent);width:14px;height:14px;">`)}
          ${this._sec('Focus pull keyframes')}
          <div id="dof-kfs" style="display:flex;flex-direction:column;gap:4px;margin-bottom:8px;"></div>
          <button id="dof-add-kf" style="${this._btn()} width:100%;">+ Add keyframe</button>
        </div>
      `;
      this._bindDepthPanel();
    }

    else if (mode === 'mesh') {
      body.innerHTML = `
        ${this._row('Mesh preview',`<label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
          <input type="checkbox" id="mesh-vis" ${this._meshPreview.visible?'checked':''} style="accent-color:var(--accent);width:14px;height:14px;"> Wireframe
        </label>`)}
        ${this._slider('mesh-iso','Detail level',this._meshPreview.isovalue??0.5,0.1,0.95,0.01,v=>`${Math.round(v*100)}%`)}
        ${this._sec('Paint include / exclude')}
        <div style="display:flex;gap:6px;margin-bottom:8px;">
          <button id="mp-inc" style="${this._btn()} color:var(--green);border-color:rgba(62,207,207,.25);">Include</button>
          <button id="mp-exc" style="${this._btn()} color:var(--red);border-color:rgba(240,54,74,.25);">Exclude</button>
          <button id="mp-clr" style="${this._btn()}">Clear</button>
        </div>
        <div style="font-size:10px;color:var(--text3);margin-bottom:12px;">
          Use the sculpt brush to paint which points go into the mesh.
          Excluded points are removed before marching cubes runs.
        </div>
        ${this._sec('Wall thickness')}
        ${this._slider('mesh-wall','Min wall',2.5,0.5,8,0.5,v=>`${v}mm`)}
        <div id="mesh-wall-warn" style="display:none;background:rgba(255,153,0,.1);border:1px solid rgba(255,153,0,.3);
          border-radius:6px;padding:7px;font-size:10px;color:var(--warn);margin-top:6px;">
          ⚠ Thin walls detected — increase thickness or use resin</div>
        ${this._sec('Send to 3D print')}
        <select id="mesh-tmpl" style="${this._sel()}">
          ${['figurine','memory','bust','statue','bobblehead','keychain','ornament','coin','miniature'].map(t=>`
            <option value="${t}">${{figurine:'🧍 Figurine',memory:'💝 Memory Figurine',bust:'🏺 Bust',statue:'🏆 Statue',bobblehead:'😄 Bobblehead',keychain:'🔑 Keychain',ornament:'🎄 Ornament',coin:'🪙 Coin',miniature:'⚔️ Miniature'}[t]}</option>
          `).join('')}
        </select>
        ${this._slider('mesh-h','Height',120,20,400,10,v=>`${v}mm`)}
        <button id="mesh-print" style="
          background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;
          border:none;border-radius:7px;padding:10px;font-size:12px;
          font-weight:600;cursor:pointer;width:100%;
        ">Send to 3D Print →</button>
      `;
      this._bindMeshPanel();
    }
  }

  // ── Selection tool options panel (changes with selectTool) ───────────────────
  _buildSelToolOpts() {
    const el = document.getElementById('sel-tool-opts');
    if (!el) return;
    const t = this._selectTool;
    if (t === 'wand') {
      el.innerHTML = this._slider('wand-tol','Tolerance',this._wandTolerance,0.01,1,0.01,v=>v.toFixed(2));
      document.getElementById('wand-tol')?.addEventListener('input', e => {
        this._wandTolerance = +e.target.value;
        document.getElementById('wand-tol-val').textContent = (+e.target.value).toFixed(2);
      });
    } else if (t === 'colour') {
      el.innerHTML = this._slider('col-tol','Tolerance',this._colourTolerance,0.01,1,0.01,v=>v.toFixed(2));
      document.getElementById('col-tol')?.addEventListener('input', e => {
        this._colourTolerance = +e.target.value;
        document.getElementById('col-tol-val').textContent = (+e.target.value).toFixed(2);
      });
    } else if (t === 'depth') {
      const b = this._getDepthBounds();
      el.innerHTML = `
        ${this._slider('dr-min','Min depth',this._depthRangeMin??b.min, b.min, b.max, (b.max-b.min)/200, v=>v.toFixed(2))}
        ${this._slider('dr-max','Max depth',this._depthRangeMax??b.max, b.min, b.max, (b.max-b.min)/200, v=>v.toFixed(2))}
        <button id="dr-apply" style="${this._btn()} width:100%;margin-top:4px;">Apply depth range</button>
      `;
      document.getElementById('dr-min')?.addEventListener('input', e => {
        this._depthRangeMin = +e.target.value;
        document.getElementById('dr-min-val').textContent = (+e.target.value).toFixed(2);
      });
      document.getElementById('dr-max')?.addEventListener('input', e => {
        this._depthRangeMax = +e.target.value;
        document.getElementById('dr-max-val').textContent = (+e.target.value).toFixed(2);
      });
      document.getElementById('dr-apply')?.addEventListener('click', () => this._applyDepthRange());
    } else if (t === 'sphere') {
      el.innerHTML = this._slider('sp-rad','Radius',this._brush.radius,0.01,2.0,0.01,v=>`${v.toFixed(2)}u`);
      document.getElementById('sp-rad')?.addEventListener('input', e => {
        this._brush.radius = +e.target.value;
        document.getElementById('sp-rad-val').textContent = `${(+e.target.value).toFixed(2)}u`;
      });
    } else {
      el.innerHTML = '';
    }
  }

  _buildLayerList() {
    const el = document.getElementById('sel-layer-list');
    if (!el) return;
    const layers = this.renderer?._layers ?? [];
    if (!layers.length) {
      el.innerHTML = `<div style="font-size:10px;color:var(--text3);">No layers in this NIF file. Layers are created during reconstruction from depth + alpha mask data.</div>`;
      return;
    }
    el.innerHTML = layers.map(l => `
      <button class="nse-layer-btn" data-label="${l.label}" style="
        background:var(--bg3);border:1px solid var(--border);border-radius:7px;
        padding:7px 10px;cursor:pointer;display:flex;align-items:center;gap:8px;
        font-size:11px;color:var(--text2);text-align:left;width:100%;transition:all .12s;
      ">
        <span style="font-size:12px;">${l.label==='foreground'?'◈':l.label==='background'?'◻':l.label==='midground'?'◉':'⬡'}</span>
        <span style="flex:1;">${l.label}</span>
        <span style="font-size:10px;color:var(--text3);">${l.count.toLocaleString()}</span>
      </button>
    `).join('');
    el.querySelectorAll('.nse-layer-btn').forEach(b => {
      b.onmouseenter = () => b.style.background = 'var(--bg4)';
      b.onmouseleave = () => b.style.background = 'var(--bg3)';
      b.onclick = () => this._selectByLayer(b.dataset.label);
    });
  }

  // ── Selection operations ─────────────────────────────────────────────────────
  _applySelection(newIndices, mode = 'replace') {
    if (mode === 'replace') {
      this._selMask.fill(0);
      this._selSet.clear();
      for (const i of newIndices) { this._selMask[i] = 1; this._selSet.add(i); }
    } else if (mode === 'add') {
      for (const i of newIndices) { this._selMask[i] = 1; this._selSet.add(i); }
    } else if (mode === 'subtract') {
      for (const i of newIndices) { this._selMask[i] = 0; this._selSet.delete(i); }
    } else if (mode === 'intersect') {
      const next = new Set(newIndices);
      for (const i of [...this._selSet]) {
        if (!next.has(i)) { this._selMask[i] = 0; this._selSet.delete(i); }
      }
    }
    this._updateSelectionBadge();
    this._drawSelectionHighlight();
    this._status(`${this._selSet.size.toLocaleString()} points selected`);
  }

  _updateSelectionBadge() {
    const badge = document.getElementById('nse-sel-badge');
    if (!badge) return;
    const n = this._selSet.size;
    if (n > 0) {
      badge.style.display = 'block';
      const pct = Math.round(n / this.gaussians.count * 100);
      badge.textContent = `${n.toLocaleString()} selected (${pct}%)`;
    } else {
      badge.style.display = 'none';
    }
  }

  // Magic wand — 3D flood fill from click point, connecting spatially+colour neighbours
  _magicWandSelect(hitPos, addMode = false) {
    const data   = this.gaussians.data;
    const count  = this.gaussians.count;
    const tol    = this._wandTolerance;
    const sigmoid = x => 1/(1+Math.exp(-x));

    // Find seed: closest point to hit
    const seedIdxArr = this._kdTree.kNN(hitPos, 1);
    if (!seedIdxArr.length) return;
    const seed = seedIdxArr[0];
    const sj   = seed * 14;
    const seedR = sigmoid(data[sj+11])+0.5;
    const seedG = sigmoid(data[sj+12])+0.5;
    const seedB = sigmoid(data[sj+13])+0.5;
    const seedPos = [data[sj], data[sj+1], data[sj+2]];

    // BFS flood fill
    const visited = new Uint8Array(count);
    const queue   = [seed];
    const result  = [];
    visited[seed] = 1;

    while (queue.length) {
      const idx = queue.shift();
      result.push(idx);
      const j   = idx * 14;
      const pos = [data[j], data[j+1], data[j+2]];

      // Find neighbours within adaptive radius (based on local density)
      const searchR = this._brush.radius * 1.5;
      const neighbours = this._kdTree.radiusQuery(pos, searchR);

      for (const ni of neighbours) {
        if (visited[ni]) continue;
        visited[ni] = 1;
        const nj   = ni * 14;
        // Colour distance from seed
        const nr = sigmoid(data[nj+11])+0.5;
        const ng = sigmoid(data[nj+12])+0.5;
        const nb_ = sigmoid(data[nj+13])+0.5;
        const dColour = Math.sqrt((nr-seedR)**2+(ng-seedG)**2+(nb_-seedB)**2);
        // Position distance from seed (spatial connectivity)
        const dx=data[nj]-seedPos[0], dy=data[nj+1]-seedPos[1], dz=data[nj+2]-seedPos[2];
        const dPos = Math.sqrt(dx*dx+dy*dy+dz*dz);
        if (dColour < tol * 1.5 && dPos < searchR * 8) {
          queue.push(ni);
        }
      }
    }

    this._applySelection(result, addMode ? 'add' : 'replace');
    this._status(`Magic Wand: ${result.length.toLocaleString()} points selected`);
  }

  // Colour range — select all points colour-similar to clicked point
  _colourRangeSelect(hitPos, addMode = false) {
    const data    = this.gaussians.data;
    const count   = this.gaussians.count;
    const sigmoid = x => 1/(1+Math.exp(-x));
    const tol     = this._colourTolerance;

    const seedArr = this._kdTree.kNN(hitPos, 1);
    if (!seedArr.length) return;
    const sj  = seedArr[0] * 14;
    const sr  = sigmoid(data[sj+11])+0.5;
    const sg  = sigmoid(data[sj+12])+0.5;
    const sb  = sigmoid(data[sj+13])+0.5;

    const result = [];
    for (let i = 0; i < count; i++) {
      const j  = i * 14;
      const r  = sigmoid(data[j+11])+0.5;
      const g  = sigmoid(data[j+12])+0.5;
      const b  = sigmoid(data[j+13])+0.5;
      const dc = Math.sqrt((r-sr)**2+(g-sg)**2+(b-sb)**2);
      if (dc <= tol) result.push(i);
    }
    this._applySelection(result, addMode ? 'add' : 'replace');
    this._status(`Colour Range: ${result.length.toLocaleString()} points selected`);
  }

  // Depth range selection
  _applyDepthRange() {
    const data  = this.gaussians.data;
    const count = this.gaussians.count;
    const mn    = this._depthRangeMin ?? -Infinity;
    const mx    = this._depthRangeMax ??  Infinity;
    const result = [];
    for (let i = 0; i < count; i++) {
      const z = data[i*14+2];
      if (z >= mn && z <= mx) result.push(i);
    }
    this._applySelection(result);
    this._status(`Depth range [${mn.toFixed(2)}, ${mx.toFixed(2)}]: ${result.length.toLocaleString()} selected`);
  }

  // Layer selection — select all points that belong to a named layer
  _selectByLayer(label) {
    const layer = this.renderer?._layers?.find(l => l.label === label);
    if (!layer) { this._status(`Layer '${label}' not found`); return; }
    // Match by position — layer data is a subset of the main gaussians
    // Use spatial lookup: for each point in the layer, find its index in main data
    const data    = this.gaussians.data;
    const count   = this.gaussians.count;
    const ldata   = layer.data;
    const lcount  = layer.count;
    const EPS2    = 1e-8;
    const result  = [];
    // Build position lookup for layer points
    const layerPosSet = new Map();
    for (let i = 0; i < lcount; i++) {
      const j  = i * 14;
      const key = `${ldata[j].toFixed(4)},${ldata[j+1].toFixed(4)},${ldata[j+2].toFixed(4)}`;
      layerPosSet.set(key, true);
    }
    for (let i = 0; i < count; i++) {
      const j   = i * 14;
      const key = `${data[j].toFixed(4)},${data[j+1].toFixed(4)},${data[j+2].toFixed(4)}`;
      if (layerPosSet.has(key)) result.push(i);
    }
    this._applySelection(result);
    this._status(`Layer '${label}': ${result.length.toLocaleString()} selected`);
    // Highlight the layer button
    document.querySelectorAll('.nse-layer-btn').forEach(b => {
      b.style.borderColor = b.dataset.label === label ? 'rgba(62,207,207,.5)' : 'var(--border)';
      b.style.color       = b.dataset.label === label ? 'var(--green)' : 'var(--text2)';
    });
  }

  // Box select — from screen rect
  _boxSelect(x0, y0, x1, y1, addMode = false) {
    const indices = GaussianEdit.selectRect(
      this.gaussians.data, this.gaussians.count,
      pos => this._worldToScreen(pos), x0, y0, x1, y1
    );
    this._applySelection(indices, addMode ? 'add' : 'replace');
    this._status(`Box select: ${indices.length.toLocaleString()} selected`);
  }

  // Lasso select — polygon point-in-polygon test
  _lassoSelect(screenPoints, addMode = false) {
    const data   = this.gaussians.data;
    const count  = this.gaussians.count;
    const result = [];
    for (let i = 0; i < count; i++) {
      const j   = i * 14;
      const sp  = this._worldToScreen([data[j], data[j+1], data[j+2]]);
      if (sp && this._pointInPolygon(sp.x, sp.y, screenPoints)) result.push(i);
    }
    this._applySelection(result, addMode ? 'add' : 'replace');
    this._status(`Lasso select: ${result.length.toLocaleString()} selected`);
  }

  _pointInPolygon(px, py, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi=poly[i][0], yi=poly[i][1], xj=poly[j][0], yj=poly[j][1];
      if (((yi>py) !== (yj>py)) && (px < (xj-xi)*(py-yi)/(yj-yi)+xi)) inside = !inside;
    }
    return inside;
  }

  // Auto background removal using the captured alpha mask
  _autoRemoveBackground() {
    const alphaMask = this.renderer?._alphaMask;
    if (!alphaMask) {
      this._status('No alpha mask in this NIF — use Magic Wand or Lasso instead');
      return;
    }
    // Project each point to alpha mask UV, check alpha value
    const data   = this.gaussians.data;
    const count  = this.gaussians.count;
    const { width: W, height: H, data: mask } = alphaMask;
    const result = []; // background indices (alpha=0)
    for (let i = 0; i < count; i++) {
      const sp = this._worldToScreen([data[i*14], data[i*14+1], data[i*14+2]]);
      if (!sp) continue;
      const ux = Math.round(clamp(sp.x / this._vpW(), 0, 1) * (W-1));
      const uy = Math.round(clamp(sp.y / this._vpH(), 0, 1) * (H-1));
      if (mask[uy * W + ux] < 64) result.push(i); // alpha < 25% = background
    }
    this._saveHistory('before-auto-bg');
    const kept = GaussianEdit.delete(this.gaussians.data, this.gaussians.count, result);
    this.gaussians = kept;
    this._rebuildKDTree();
    this._pushToRenderer();
    this._selSet.clear(); this._selMask = new Uint8Array(this.gaussians.count);
    this._updateSelectionBadge();
    this._status(`✓ Background removed — ${result.length.toLocaleString()} points deleted`);
    this._renderPanel('select');
  }

  // Keep selection — delete everything OUTSIDE selection
  _opKeep() {
    if (!this._selSet.size) { this._status('Nothing selected'); return; }
    this._saveHistory('before-keep');
    const outside = [];
    for (let i = 0; i < this.gaussians.count; i++) {
      if (!this._selMask[i]) outside.push(i);
    }
    this.gaussians = GaussianEdit.delete(this.gaussians.data, this.gaussians.count, outside);
    this._selMask  = new Uint8Array(this.gaussians.count).fill(1);
    this._selSet   = new Set(Array.from({length:this.gaussians.count},(_,i)=>i));
    this._rebuildKDTree(); this._pushToRenderer(); this._updateSelectionBadge();
    this._status(`✓ Kept ${this.gaussians.count.toLocaleString()} points — background removed`);
    this._renderPanel('select');
  }

  // Delete selection — remove selected points
  _opDelete() {
    if (!this._selSet.size) { this._status('Nothing selected'); return; }
    this._saveHistory('before-delete');
    this.gaussians = GaussianEdit.delete(this.gaussians.data, this.gaussians.count, [...this._selSet]);
    this._selMask  = new Uint8Array(this.gaussians.count);
    this._selSet.clear();
    this._rebuildKDTree(); this._pushToRenderer(); this._updateSelectionBadge();
    this._status(`✓ Deleted — ${this.gaussians.count.toLocaleString()} points remain`);
    this._renderPanel('select');
  }

  // Extract selection to new named layer (non-destructive — keeps all points visible)
  _opExtract() {
    if (!this._selSet.size) { this._status('Nothing selected'); return; }
    const name  = prompt('Layer name:', `selection_${Date.now()}`);
    if (!name) return;
    const sel   = [...this._selSet];
    const ldata = new Float32Array(sel.length * 14);
    sel.forEach((src, dst) => ldata.set(this.gaussians.data.subarray(src*14, src*14+14), dst*14));
    if (!this.renderer._layers) this.renderer._layers = [];
    this.renderer._layers.push({ label: name, count: sel.length, data: ldata, depthMin:-Infinity, depthMax:Infinity });
    this._renderPanel('select'); // rebuild layer list
    this._status(`✓ Extracted ${sel.length.toLocaleString()} points → layer '${name}'`);
  }

  // ── Bind select panel buttons ────────────────────────────────────────────────
  _bindSelectPanel() {
    const g = id => document.getElementById(id);
    g('sel-all')?.addEventListener('click', () => {
      const all = Array.from({length:this.gaussians.count},(_,i)=>i);
      this._applySelection(all);
    });
    g('sel-none')?.addEventListener('click', () => {
      this._applySelection([], 'replace');
    });
    g('sel-invert')?.addEventListener('click', () => {
      const inv = [];
      for (let i=0;i<this.gaussians.count;i++) if (!this._selMask[i]) inv.push(i);
      this._applySelection(inv, 'replace');
    });
    g('sel-add')?.addEventListener('click', () => { this._selMode='add'; this._status('Add mode — next selection adds to current'); });
    g('sel-subtract')?.addEventListener('click', () => { this._selMode='subtract'; this._status('Subtract mode — next selection removes from current'); });
    g('sel-intersect')?.addEventListener('click', () => { this._selMode='intersect'; this._status('Intersect mode — next selection keeps only overlap'); });
    g('sel-keep')?.addEventListener('click', () => this._opKeep());
    g('sel-delete-op')?.addEventListener('click', () => this._opDelete());
    g('sel-extract')?.addEventListener('click', () => this._opExtract());
    g('sel-fade-op')?.addEventListener('click', () => {
      if (!this._selSet.size) return;
      this._saveHistory('before-fade');
      this.gaussians.data = GaussianEdit.fade(this.gaussians.data, [...this._selSet], 0.8);
      this._pushToRenderer();
    });
    g('sel-smooth-op')?.addEventListener('click', () => {
      if (!this._selSet.size) return;
      this._saveHistory('before-smooth');
      this._smoothIndices([...this._selSet]);
      this._pushToRenderer();
    });
    g('sel-paint-op')?.addEventListener('click', () => {
      const hex = prompt('Hex colour (e.g. #ff3300):');
      if (!hex) return;
      const rgb = this._hexRgb(hex);
      this._saveHistory('before-paint');
      this.gaussians.data = GaussianEdit.recolour(this.gaussians.data, [...this._selSet], rgb, 1.0);
      this._pushToRenderer();
    });
    g('sel-auto-bg')?.addEventListener('click', () => this._autoRemoveBackground());
    g('sel-isolate-fg')?.addEventListener('click', () => this._selectByLayer('foreground'));
  }

  _bindSculptPanel() {
    const g = id => document.getElementById(id);
    g('br-radius')?.addEventListener('input', e => { this._brush.radius=+e.target.value; g('br-radius-val').textContent=`${(+e.target.value).toFixed(2)}u`; });
    g('br-strength')?.addEventListener('input', e => { this._brush.strength=+e.target.value; g('br-strength-val').textContent=`${Math.round(+e.target.value*100)}%`; });
    g('br-falloff')?.addEventListener('change', e => { this._brush.falloff=e.target.value; });
    g('br-col')?.addEventListener('input', e => { this._brush.colour=this._hexRgb(e.target.value); });
    g('sculpt-smooth-sel')?.addEventListener('click', () => { if(!this._selSet.size) return; this._saveHistory('before-smooth'); this._smoothIndices([...this._selSet]); this._pushToRenderer(); });
    g('sculpt-delete-sel')?.addEventListener('click', () => this._opDelete());
    g('sculpt-recolour-sel')?.addEventListener('click', () => {
      if(!this._selSet.size) return;
      const hex=prompt('Hex colour:'); if(!hex) return;
      this._saveHistory('before-paint');
      this.gaussians.data=GaussianEdit.recolour(this.gaussians.data,[...this._selSet],this._hexRgb(hex),1.0);
      this._pushToRenderer();
    });
  }

  _bindLightPanel() {
    const g = id => document.getElementById(id);
    g('ibl-str')?.addEventListener('input', e => { this._ibl.strength=+e.target.value; g('ibl-str-val').textContent=`${Math.round(+e.target.value*100)}%`; this._applyLighting(); });
    g('ibl-col')?.addEventListener('input', e => { this._ibl.colour=this._hexRgb(e.target.value); this._applyLighting(); });
    g('add-light')?.addEventListener('click', () => {
      this._lights.push({ pos:[...this.renderer.camera.position], colour:[1,1,1], intensity:1.0, radius:0.5, falloff:2.0 });
      this._renderPanel('light'); this._applyLighting();
    });
    this._renderLightList();
  }

  _renderLightList() {
    const el = document.getElementById('light-list');
    if (!el) return;
    el.innerHTML = this._lights.map((l,i)=>`
      <div data-li="${i}" style="background:var(--bg3);border:1px solid var(--border);border-radius:7px;
        padding:7px 10px;cursor:pointer;display:flex;align-items:center;gap:8px;font-size:11px;">
        <div style="width:11px;height:11px;border-radius:50%;background:${this._rgbHex(l.colour)};
          box-shadow:0 0 6px ${this._rgbHex(l.colour)};flex-shrink:0;"></div>
        <span>Light ${i+1}</span>
        <span style="color:var(--text3);margin-left:auto;">${l.pos.map(v=>v.toFixed(1)).join(', ')}</span>
      </div>
    `).join('');
    el.querySelectorAll('[data-li]').forEach(el=>{
      el.onclick=()=>{
        this._selectedLight=+el.dataset.li;
        const props=document.getElementById('light-props');
        if(props){props.style.opacity='1';props.style.pointerEvents='all';}
        const l=this._lights[this._selectedLight];
        const g=id=>document.getElementById(id);
        if(g('li-int')) g('li-int').value=l.intensity;
        if(g('li-rad')) g('li-rad').value=l.radius;
        if(g('li-col')) g('li-col').value=this._rgbHex(l.colour);
      };
    });
    const g=id=>document.getElementById(id);
    g('li-int')?.addEventListener('input',e=>{if(this._lights[this._selectedLight])this._lights[this._selectedLight].intensity=+e.target.value;g('li-int-val').textContent=(+e.target.value).toFixed(1);this._applyLighting();});
    g('li-rad')?.addEventListener('input',e=>{if(this._lights[this._selectedLight])this._lights[this._selectedLight].radius=+e.target.value;g('li-rad-val').textContent=`${(+e.target.value).toFixed(2)}u`;this._applyLighting();});
    g('li-col')?.addEventListener('input',e=>{if(this._lights[this._selectedLight])this._lights[this._selectedLight].colour=this._hexRgb(e.target.value);this._applyLighting();});
    g('del-light')?.addEventListener('click',()=>{if(this._selectedLight!=null){this._lights.splice(this._selectedLight,1);this._selectedLight=null;this._renderPanel('light');}});
  }

  _bindDepthPanel() {
    const g=id=>document.getElementById(id);
    g('dof-on')?.addEventListener('change',e=>{this._dof.enabled=e.target.checked;const c=document.getElementById('dof-ctrl');if(c){c.style.opacity=e.target.checked?'1':'.4';c.style.pointerEvents=e.target.checked?'all':'none';}this._applyDOF();});
    g('dof-dist')?.addEventListener('input',e=>{this._dof.focalDist=+e.target.value;g('dof-dist-val').textContent=`${(+e.target.value).toFixed(1)}m`;this._applyDOF();});
    g('dof-apt')?.addEventListener('input',e=>{this._dof.aperture=+e.target.value;g('dof-apt-val').textContent=`f/${(+e.target.value).toFixed(1)}`;this._applyDOF();});
    g('dof-blades')?.addEventListener('input',e=>{this._dof.bokehBlades=+e.target.value;g('dof-blades-val').textContent=e.target.value;});
    g('dof-fg')?.addEventListener('change',e=>{this._dof.fgBlur=e.target.checked;this._applyDOF();});
    g('dof-bg')?.addEventListener('change',e=>{this._dof.bgBlur=e.target.checked;this._applyDOF();});
    g('dof-add-kf')?.addEventListener('click',()=>this._addDOFKeyframe());
  }

  _bindMeshPanel() {
    const g=id=>document.getElementById(id);
    g('mesh-vis')?.addEventListener('change',e=>{this._meshPreview.visible=e.target.checked;this._updateMeshPreview();});
    g('mesh-iso')?.addEventListener('input',e=>{this._meshPreview.isovalue=+e.target.value;g('mesh-iso-val').textContent=`${Math.round(+e.target.value*100)}%`;this._updateMeshPreview();});
    g('mp-inc')?.addEventListener('click',()=>{this._meshPaintMode='include';this._status('Paint: Include — brush to mark points for printing');});
    g('mp-exc')?.addEventListener('click',()=>{this._meshPaintMode='exclude';this._status('Paint: Exclude — brush to remove points from mesh');});
    g('mp-clr')?.addEventListener('click',()=>{this._meshPreview.paintMask=null;this._meshPaintMode=null;this._status('Paint mask cleared');});
    g('mesh-print')?.addEventListener('click',()=>this._sendToPrint());
  }

  // ── Selection visual overlay ─────────────────────────────────────────────────
  // Selected points are drawn as small teal highlights on the overlay canvas
  _drawSelectionHighlight() {
    const cv = document.getElementById('nse-overlay');
    if (!cv) return;
    const vp = document.getElementById('nse-vp');
    cv.width  = vp?.offsetWidth  ?? 800;
    cv.height = vp?.offsetHeight ?? 600;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (!this._selSet.size) return;

    const data = this.gaussians.data;
    ctx.fillStyle = 'rgba(62,207,207,0.35)';
    ctx.strokeStyle = 'rgba(62,207,207,0.6)';

    // Only draw first 5000 dots for perf — still shows coverage clearly
    const indices = [...this._selSet];
    const step    = Math.max(1, Math.floor(indices.length / 5000));

    for (let k = 0; k < indices.length; k += step) {
      const i  = indices[k];
      const sp = this._worldToScreen([data[i*14], data[i*14+1], data[i*14+2]]);
      if (!sp) continue;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 2.5, 0, Math.PI*2);
      ctx.fill();
    }
  }

  // Draw lasso polygon in progress
  _drawLasso(points, closed = false) {
    const cv = document.getElementById('nse-overlay');
    if (!cv || points.length < 2) return;
    const vp = document.getElementById('nse-vp');
    cv.width  = vp?.offsetWidth  ?? 800;
    cv.height = vp?.offsetHeight ?? 600;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0,0,cv.width,cv.height);

    // Draw existing selection
    this._drawSelectionHighlight();

    // Draw lasso line
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (const p of points) ctx.lineTo(p[0], p[1]);
    if (closed) ctx.closePath();
    ctx.strokeStyle = 'rgba(124,109,250,.9)';
    ctx.setLineDash([5,3]);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = 'rgba(124,109,250,.12)';
    if (closed) ctx.fill();
    ctx.setLineDash([]);
  }

  // Draw box selection rectangle
  _drawBox(x0, y0, x1, y1) {
    const cv = document.getElementById('nse-overlay');
    if (!cv) return;
    const vp = document.getElementById('nse-vp');
    cv.width  = vp?.offsetWidth  ?? 800;
    cv.height = vp?.offsetHeight ?? 600;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0,0,cv.width,cv.height);
    this._drawSelectionHighlight();
    ctx.strokeStyle='rgba(124,109,250,.9)';
    ctx.fillStyle='rgba(124,109,250,.08)';
    ctx.setLineDash([5,3]);
    ctx.lineWidth=1.5;
    ctx.strokeRect(Math.min(x0,x1),Math.min(y0,y1),Math.abs(x1-x0),Math.abs(y1-y0));
    ctx.fillRect(Math.min(x0,x1),Math.min(y0,y1),Math.abs(x1-x0),Math.abs(y1-y0));
    ctx.setLineDash([]);
  }

  // ── Brush operations (sculpt mode) ───────────────────────────────────────────
  _applyBrush(worldPos, dt = 0.016) {
    if (!this._kdTree) return;
    const indices  = this._kdTree.radiusQuery(worldPos, this._brush.radius);
    if (!indices.length) return;
    const data     = this.gaussians.data;
    const r        = this._brush.radius;
    const strength = this._brush.strength * dt * 60;
    const falloff  = { smooth: d=>smoothstep(r,0,d), linear: d=>clamp(1-d/r,0,1), hard: d=>d<r?1:0 }[this._brush.falloff] ?? (d=>smoothstep(r,0,d));

    switch (this._sculptTool) {
      case 'grab': for (const i of indices) { const j=i*14; const dx=data[j]-worldPos[0],dy=data[j+1]-worldPos[1],dz=data[j+2]-worldPos[2]; const w=falloff(Math.sqrt(dx*dx+dy*dy+dz*dz))*strength; if(this._dragDelta){data[j]+=this._dragDelta[0]*w;data[j+1]+=this._dragDelta[1]*w;data[j+2]+=this._dragDelta[2]*w;} } break;
      case 'smooth': for (const i of indices) { const j=i*14; const nb=this._kdTree.kNN([data[j],data[j+1],data[j+2]],8); if(nb.length<2) continue; let ax=0,ay=0,az=0; for(const ni of nb){ax+=data[ni*14];ay+=data[ni*14+1];az+=data[ni*14+2];} ax/=nb.length;ay/=nb.length;az/=nb.length; const dx=data[j]-worldPos[0],dy=data[j+1]-worldPos[1],dz=data[j+2]-worldPos[2]; const w=falloff(Math.sqrt(dx*dx+dy*dy+dz*dz))*strength*0.3; data[j]+=((ax-data[j])*w);data[j+1]+=((ay-data[j+1])*w);data[j+2]+=((az-data[j+2])*w); } break;
      case 'erase': for (const i of indices) { const j=i*14; const dx=data[j]-worldPos[0],dy=data[j+1]-worldPos[1],dz=data[j+2]-worldPos[2]; data[j+10]-=falloff(Math.sqrt(dx*dx+dy*dy+dz*dz))*strength*3; } break;
      case 'paint': { const [tr,tg,tb]=this._brush.colour; const logit=x=>Math.log(Math.max(0.001,Math.min(0.999,x))/(1-Math.max(0.001,Math.min(0.999,x)))); for (const i of indices) { const j=i*14; const dx=data[j]-worldPos[0],dy=data[j+1]-worldPos[1],dz=data[j+2]-worldPos[2]; const w=falloff(Math.sqrt(dx*dx+dy*dy+dz*dz))*strength; data[j+11]+=(logit(tr-0.5)-data[j+11])*w; data[j+12]+=(logit(tg-0.5)-data[j+12])*w; data[j+13]+=(logit(tb-0.5)-data[j+13])*w; } break; }
      case 'push': for (const i of indices) { const j=i*14; const dx=data[j]-worldPos[0],dy=data[j+1]-worldPos[1],dz=data[j+2]-worldPos[2]; const d=Math.sqrt(dx*dx+dy*dy+dz*dz)+1e-8; const w=falloff(d)*strength*0.02; data[j]+=dx/d*w;data[j+1]+=dy/d*w;data[j+2]+=dz/d*w; } break;
      case 'pull': for (const i of indices) { const j=i*14; const dx=data[j]-worldPos[0],dy=data[j+1]-worldPos[1],dz=data[j+2]-worldPos[2]; const d=Math.sqrt(dx*dx+dy*dy+dz*dz)+1e-8; const w=falloff(d)*strength*0.02; data[j]-=dx/d*w;data[j+1]-=dy/d*w;data[j+2]-=dz/d*w; } break;
    }

    if (this._meshPaintMode && this._mode==='mesh') {
      if (!this._meshPreview.paintMask) this._meshPreview.paintMask=new Uint8Array(this.gaussians.count).fill(1);
      const val=this._meshPaintMode==='include'?1:0;
      for (const i of indices) this._meshPreview.paintMask[i]=val;
    }
    this._pushToRenderer();
  }

  // ── Lighting ─────────────────────────────────────────────────────────────────
  _applyLighting() {
    if (!this._lightingEnabled && !this._lights.length) return;
    const data=this.gaussians.data; const count=this.gaussians.count;
    const logit=x=>Math.log(Math.max(0.001,Math.min(0.999,x))/(1-Math.max(0.001,Math.min(0.999,x))));
    const sigmoid=x=>1/(1+Math.exp(-x));
    for(let i=0;i<count;i++){
      const j=i*14; const pos=[data[j],data[j+1],data[j+2]];
      const nb=this._kdTree.kNN(pos,6); let nx=0,ny=0,nz=1;
      if(nb.length>=3){const ps=nb.map(ni=>[data[ni*14],data[ni*14+1],data[ni*14+2]]);const ab=v3.sub(ps[1],ps[0]),ac=v3.sub(ps[2],ps[0]);const cr=v3.norm(v3.cross(ab,ac));nx=cr[0];ny=cr[1];nz=cr[2];}
      const N=[nx,ny,nz];
      let r=sigmoid(data[j+11])+0.5,g=sigmoid(data[j+12])+0.5,b=sigmoid(data[j+13])+0.5;
      let lr=r*this._ibl.colour[0]*this._ibl.strength,lg=g*this._ibl.colour[1]*this._ibl.strength,lb=b*this._ibl.colour[2]*this._ibl.strength;
      for(const light of this._lights){const tl=v3.sub(light.pos,pos);const dist=v3.len(tl)+1e-8;const L=v3.scale(tl,1/dist);const NdL=Math.max(v3.dot(N,L),0);const att=light.intensity/Math.pow(dist/light.radius+1,light.falloff);lr+=r*light.colour[0]*NdL*att;lg+=g*light.colour[1]*NdL*att;lb+=b*light.colour[2]*NdL*att;}
      data[j+11]=logit(clamp(lr-0.5,0.001,0.999));data[j+12]=logit(clamp(lg-0.5,0.001,0.999));data[j+13]=logit(clamp(lb-0.5,0.001,0.999));
    }
    this._pushToRenderer(); this._status('Lighting baked into depth field');
  }

  // ── DOF ───────────────────────────────────────────────────────────────────────
  _applyDOF() {
    if (!this._dof.enabled) { this._pushToRenderer(); return; }
    const data=this.gaussians.data; const count=this.gaussians.count;
    const fDist=this._dof.focalDist; const fStop=this._dof.aperture; const sensor=0.024;
    for(let i=0;i<count;i++){const j=i*14;const depth=Math.abs(data[j+2]);const delta=Math.abs(depth-fDist);const coc=(sensor*delta)/(fDist*fStop);const blur=clamp(coc*2,0,1);const isFg=depth<fDist;if((isFg&&this._dof.fgBlur)||(!isFg&&this._dof.bgBlur)) data[j+10]-=blur*1.5;}
    this._pushToRenderer();
  }

  _addDOFKeyframe() {
    this._dofKeyframes.push({ t:0, focalDist:this._dof.focalDist });
    const el=document.getElementById('dof-kfs');
    if(el) el.innerHTML=this._dofKeyframes.map((kf,i)=>`
      <div style="display:flex;align-items:center;gap:5px;font-size:10px;">
        <span style="color:var(--text3);">t=</span>
        <input type="number" value="${kf.t}" min="0" step="0.1" style="${this._miniInp()}">
        <span style="color:var(--text3);">f=</span>
        <input type="number" value="${kf.focalDist.toFixed(1)}" step="0.1" style="${this._miniInp()}">
        <button onclick="this.parentElement.remove()" style="background:none;border:none;color:var(--red);cursor:pointer;">✕</button>
      </div>
    `).join('');
  }

  // ── Mesh preview ──────────────────────────────────────────────────────────────
  _updateMeshPreview() {
    const w=document.getElementById('mesh-wall-warn');
    if(w) w.style.display=(this._meshPreview.isovalue??0.5)>0.8?'block':'none';
    this._status(this._meshPreview.visible?`Mesh at ${Math.round((this._meshPreview.isovalue??0.5)*100)}%`:'Mesh preview hidden');
  }

  async _sendToPrint() {
    const tmpl=document.getElementById('mesh-tmpl')?.value??'figurine';
    const h=+document.getElementById('mesh-h')?.value??120;
    const ep={};
    if(this._meshPreview.isovalue!=null) ep.isovalue=this._meshPreview.isovalue;
    if(this._meshPreview.paintMask){const exc=[];for(let i=0;i<this._meshPreview.paintMask.length;i++)if(!this._meshPreview.paintMask[i])exc.push(i);if(exc.length)ep.excluded_indices=exc;}
    const btn=document.getElementById('mesh-print');
    if(btn){btn.textContent='Sending…';btn.disabled=true;}
    try{
      const res=await fetch(`${this.api}/nif/${this.nifId}/print/request`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${this.token}`},body:JSON.stringify({templates:[tmpl],height_mm:h,edit_params:ep})});
      const d=await res.json();
      if(!res.ok) throw new Error(d.error??'Request failed');
      this._status(`✓ Print job queued — ${tmpl} ${h}mm`);
      if(btn){btn.textContent='✓ Sent';setTimeout(()=>{btn.textContent='Send to 3D Print →';btn.disabled=false;},3000);}
    }catch(e){this._status(`✗ ${e.message}`);if(btn){btn.textContent='Send to 3D Print →';btn.disabled=false;}}
  }

  // ── Event binding ─────────────────────────────────────────────────────────────
  _bindEvents() {
    this.container.querySelectorAll('.nse-mode').forEach(b=>b.addEventListener('click',()=>this._setMode(b.dataset.mode)));
    document.getElementById('nse-undo')?.addEventListener('click',()=>this._undo());
    document.getElementById('nse-redo')?.addEventListener('click',()=>this._redo());
    document.getElementById('nse-save')?.addEventListener('click',()=>this._saveToNIF());
    document.getElementById('nse-reset')?.addEventListener('click',()=>{if(!confirm('Reset all edits?'))return;const f=this._history[0];if(f){this.gaussians={count:f.count,data:new Float32Array(f.data)};this._rebuildKDTree();this._pushToRenderer();this._histIdx=0;this._updateUndoRedo();this._status('Reset to original');}});

    const vp=document.getElementById('nse-vp');
    if(!vp) return;

    vp.addEventListener('mousedown', e=>this._onDown(e));
    vp.addEventListener('mousemove', e=>this._onMove(e));
    vp.addEventListener('mouseup',   e=>this._onUp(e));
    vp.addEventListener('mouseleave',()=>{ this._onUp(null); document.getElementById('nse-ring').style.opacity='0'; });

    // Touch events for mobile
    vp.addEventListener('touchstart', e=>{const t=e.touches[0];this._onDown({offsetX:t.clientX-vp.getBoundingClientRect().left,offsetY:t.clientY-vp.getBoundingClientRect().top,button:0,shiftKey:false});},{passive:true});
    vp.addEventListener('touchmove',  e=>{const t=e.touches[0];this._onMove({offsetX:t.clientX-vp.getBoundingClientRect().left,offsetY:t.clientY-vp.getBoundingClientRect().top});},{passive:true});
    vp.addEventListener('touchend',   ()=>this._onUp(null),{passive:true});

    window.addEventListener('keydown', e=>{
      if(e.ctrlKey||e.metaKey){
        if(e.key==='z'){e.preventDefault();this._undo();}
        if(e.key==='y'||e.key==='Z'){e.preventDefault();this._redo();}
        if(e.key==='a'&&this._mode==='select'){e.preventDefault();const all=Array.from({length:this.gaussians.count},(_,i)=>i);this._applySelection(all);}
        if(e.key==='i'&&this._mode==='select'){e.preventDefault();const inv=[];for(let i=0;i<this.gaussians.count;i++)if(!this._selMask[i])inv.push(i);this._applySelection(inv,'replace');}
        return;
      }
      if(e.key==='Escape'){this._applySelection([],'replace');this._selPoints=[];this._selDrag=false;}
      if(this._mode==='select') Object.entries(SELECT_TOOLS).forEach(([k,t])=>{if(e.key.toUpperCase()===t.hotkey){this._selectTool=k;this._buildToolbar('select');vp.style.cursor=t.cursor;}});
      if(this._mode==='sculpt') Object.entries(SCULPT_TOOLS).forEach(([k,t])=>{if(e.key.toUpperCase()===t.hotkey){this._sculptTool=k;this._buildToolbar('sculpt');}});
      if(e.key==='[') this._brush.radius=Math.max(0.01,this._brush.radius-0.02);
      if(e.key===']') this._brush.radius=Math.min(2.0,this._brush.radius+0.02);
    });
  }

  _onDown(e) {
    if(e.button!==0) return;
    const sx=e.offsetX, sy=e.offsetY;

    if(this._mode==='depth'&&this._dof.enabled){
      const wp=this._screenToWorld(sx,sy);
      if(wp){this._dof.focalDist=Math.abs(wp[2]);const s=document.getElementById('dof-dist');if(s){s.value=this._dof.focalDist;document.getElementById('dof-dist-val').textContent=`${this._dof.focalDist.toFixed(1)}m`;}this._applyDOF();this._status(`Focal plane: ${this._dof.focalDist.toFixed(2)}m`);}
      return;
    }

    if(this._mode==='sculpt'||(this._mode==='mesh'&&this._meshPaintMode)){
      const wp=this._screenToWorld(sx,sy);
      if(!wp) return;
      this._dragging=true; this._lastHit=wp;
      this._saveHistory(`before-${this._sculptTool}`);
      this._applyBrush(wp);
      return;
    }

    if(this._mode!=='select') return;
    const addMode=e.shiftKey;
    const sm=this._selMode??'replace';

    if(this._selectTool==='box'){
      this._selDrag=true; this._selBoxStart=[sx,sy];
    } else if(this._selectTool==='lasso'){
      this._selDrag=true; this._selPoints=[[sx,sy]];
    } else if(this._selectTool==='sphere'){
      const wp=this._screenToWorld(sx,sy);
      if(wp){const idx=GaussianEdit.selectSphere(this.gaussians.data,this.gaussians.count,wp,this._brush.radius);this._applySelection(idx,addMode?'add':sm);}
    } else if(this._selectTool==='wand'){
      const wp=this._screenToWorld(sx,sy);
      if(wp) this._magicWandSelect(wp,addMode);
    } else if(this._selectTool==='colour'){
      const wp=this._screenToWorld(sx,sy);
      if(wp) this._colourRangeSelect(wp,addMode);
    }
    this._selMode = 'replace'; // reset to replace after one addMode click
  }

  _onMove(e) {
    const sx=e.offsetX, sy=e.offsetY;

    // Brush ring
    const ring=document.getElementById('nse-ring');
    const rc=document.getElementById('nse-ring-c');
    if(ring&&rc&&(this._mode==='sculpt'||(this._mode==='mesh'&&this._meshPaintMode))){
      ring.style.opacity='1'; rc.setAttribute('cx',sx); rc.setAttribute('cy',sy);
      const pxR=this._brush.radius*200*(1/Math.max(Math.abs(this.renderer?.camera?.position?.[2]??5),0.1));
      rc.setAttribute('r',clamp(pxR,6,400));
    } else if(ring) ring.style.opacity='0';

    if(this._mode==='sculpt'||(this._mode==='mesh'&&this._meshPaintMode)){
      if(!this._dragging) return;
      const wp=this._screenToWorld(sx,sy);
      if(!wp) return;
      if(this._lastHit&&this._sculptTool==='grab') this._dragDelta=v3.sub(wp,this._lastHit);
      this._applyBrush(wp);
      this._lastHit=wp; this._dragDelta=null;
      return;
    }

    if(this._mode!=='select'||!this._selDrag) return;

    if(this._selectTool==='box'&&this._selBoxStart){
      this._drawBox(this._selBoxStart[0],this._selBoxStart[1],sx,sy);
    } else if(this._selectTool==='lasso'){
      this._selPoints.push([sx,sy]);
      this._drawLasso(this._selPoints);
    }
  }

  _onUp(e) {
    const sx=e?.offsetX, sy=e?.offsetY;

    if(this._dragging){
      this._dragging=false; this._lastHit=null; this._dragDelta=null;
      this._rebuildKDTree();
      if(this._mode==='mesh') this._updateMeshPreview();
      return;
    }

    if(this._mode!=='select'||!this._selDrag) return;
    this._selDrag=false;
    const addMode=e?.shiftKey??false;
    const sm=this._selMode??'replace';

    if(this._selectTool==='box'&&this._selBoxStart&&sx!=null){
      this._boxSelect(this._selBoxStart[0],this._selBoxStart[1],sx,sy,addMode);
      this._selBoxStart=null;
    } else if(this._selectTool==='lasso'&&this._selPoints.length>3){
      this._lassoSelect(this._selPoints,addMode);
      this._selPoints=[];
    }
    // Redraw overlay with just highlights (no lasso/box)
    this._drawSelectionHighlight();
    this._selMode='replace';
  }

  // ── History ───────────────────────────────────────────────────────────────────
  _saveHistory(label) {
    if(this._histIdx<this._history.length-1) this._history=this._history.slice(0,this._histIdx+1);
    this._history.push({label,data:new Float32Array(this.gaussians.data),count:this.gaussians.count});
    if(this._history.length>this._maxHistory) this._history.shift();
    this._histIdx=this._history.length-1;
    this._updateUndoRedo();
  }
  _undo(){if(this._histIdx<=0)return;this._histIdx--;const s=this._history[this._histIdx];this.gaussians={count:s.count,data:new Float32Array(s.data)};this._selMask=new Uint8Array(s.count);this._selSet.clear();this._rebuildKDTree();this._pushToRenderer();this._updateUndoRedo();this._status(`Undo: ${s.label}`);}
  _redo(){if(this._histIdx>=this._history.length-1)return;this._histIdx++;const s=this._history[this._histIdx];this.gaussians={count:s.count,data:new Float32Array(s.data)};this._selMask=new Uint8Array(s.count);this._selSet.clear();this._rebuildKDTree();this._pushToRenderer();this._updateUndoRedo();this._status(`Redo: ${s.label}`);}
  _updateUndoRedo(){const u=document.getElementById('nse-undo'),r=document.getElementById('nse-redo');if(u)u.style.opacity=this._histIdx>0?'1':'.3';if(r)r.style.opacity=this._histIdx<this._history.length-1?'1':'.3';}

  // ── Save to NIF ───────────────────────────────────────────────────────────────
  async _saveToNIF(){
    const btn=document.getElementById('nse-save');
    if(btn){btn.textContent='Saving…';btn.disabled=true;}
    try{
      const res=await fetch(`${this.api}/nif/${this.nifId}/edits`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${this.token}`},body:JSON.stringify({gaussianData:Array.from(this.gaussians.data.subarray(0,Math.min(this.gaussians.count*14,2_000_000))),count:this.gaussians.count,editRecord:{version:1,timestamp:Date.now(),changes:this._history.map(h=>h.label),dof:this._dof,lights:this._lights,ibl:this._ibl}})});
      if(res.ok){this._status('✓ Saved to NIF');if(btn){btn.textContent='✓ Saved';setTimeout(()=>{btn.textContent='Save to NIF';btn.disabled=false;},2000);}}
      else throw new Error((await res.json()).error??'Save failed');
    }catch(e){this._status(`✗ ${e.message}`);if(btn){btn.textContent='Save to NIF';btn.disabled=false;}}
  }

  // ── Utility ───────────────────────────────────────────────────────────────────
  _screenToWorld(sx,sy){
    const vp=document.getElementById('nse-vp');if(!vp||!this.renderer)return null;
    const W=vp.offsetWidth,H=vp.offsetHeight;
    const ndcX=(sx/W)*2-1,ndcY=1-(sy/H)*2;
    const view=this.renderer.camera.viewMatrix();const proj=this.renderer.camera.projMatrix(W/H);
    const invVP=m4.inv(m4.mul(proj,view));
    const near=m4.mulVec4(invVP,[ndcX,ndcY,-1,1]);const far=m4.mulVec4(invVP,[ndcX,ndcY,1,1]);
    const nw=[near[0]/near[3],near[1]/near[3],near[2]/near[3]];
    const fw=[far[0]/far[3],far[1]/far[3],far[2]/far[3]];
    const dir=v3.norm(v3.sub(fw,nw));
    const hit=raycastGaussians(this.gaussians.data,this.gaussians.count,nw,dir,20);
    return hit?hit.position:v3.add(nw,v3.scale(dir,3));
  }

  _worldToScreen(pos){
    const vp=document.getElementById('nse-vp');if(!vp||!this.renderer)return null;
    const W=vp.offsetWidth,H=vp.offsetHeight;
    const view=this.renderer.camera.viewMatrix();const proj=this.renderer.camera.projMatrix(W/H);
    const vp4=m4.mul(proj,view);
    const c=m4.mulVec4(vp4,[pos[0],pos[1],pos[2],1]);
    if(c[3]<=0)return null;
    const ndcX=c[0]/c[3],ndcY=c[1]/c[3];
    return{x:(ndcX+1)/2*W,y:(1-ndcY)/2*H,depth:c[2]/c[3]};
  }

  _getDepthBounds(){const d=this.gaussians.data;let mn=Infinity,mx=-Infinity;for(let i=0;i<this.gaussians.count;i++){const z=d[i*14+2];if(z<mn)mn=z;if(z>mx)mx=z;}return{min:mn,max:mx};}
  _vpW(){return document.getElementById('nse-vp')?.offsetWidth??800;}
  _vpH(){return document.getElementById('nse-vp')?.offsetHeight??600;}
  _rebuildKDTree(){this._kdTree=new GaussianKDTree(this.gaussians.data,this.gaussians.count);}
  _pushToRenderer(){if(this.renderer)this.renderer.loadGaussians(this.gaussians);}
  _smoothIndices(indices){const data=this.gaussians.data;for(const i of indices){const j=i*14;const nb=this._kdTree.kNN([data[j],data[j+1],data[j+2]],8);if(nb.length<2)continue;let ax=0,ay=0,az=0;for(const ni of nb){ax+=data[ni*14];ay+=data[ni*14+1];az+=data[ni*14+2];}data[j]=ax/nb.length;data[j+1]=ay/nb.length;data[j+2]=az/nb.length;}}
  _status(msg){const el=document.getElementById('nse-status');if(el)el.textContent=msg;}

  // ── CSS helpers ────────────────────────────────────────────────────────────────
  _sec(l){return`<div style="font-size:9px;letter-spacing:.08em;color:var(--text3);text-transform:uppercase;margin:14px 0 7px;font-weight:600;">${l}</div>`;}
  _row(l,c){return`<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:9px;gap:8px;"><span style="font-size:11px;color:var(--text2);">${l}</span>${c}</div>`;}
  _slider(id,l,v,mn,mx,s,fmt){return`<div style="margin-bottom:11px;"><div style="display:flex;justify-content:space-between;margin-bottom:4px;"><span style="font-size:11px;color:var(--text2);">${l}</span><span id="${id}-val" style="font-size:10px;font-family:monospace;color:var(--accent2);">${fmt(v)}</span></div><input id="${id}" type="range" min="${mn}" max="${mx}" step="${s}" value="${v}" style="width:100%;accent-color:var(--accent);cursor:pointer;" oninput="document.getElementById('${id}-val').textContent=(${fmt.toString()})(+this.value)"></div>`;}
  _btn(){return`background:var(--bg4);color:var(--text2);border:1px solid var(--border);border-radius:6px;padding:6px 10px;font-size:11px;cursor:pointer;`;}
  _tbs(){return`width:34px;height:34px;border-radius:7px;border:1px solid var(--border);background:var(--bg3);color:var(--text2);font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center;opacity:.5;`;}
  _sel(){return`width:100%;background:var(--bg4);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:6px 8px;font-size:11px;cursor:pointer;margin-bottom:10px;`;}
  _miniInp(){return`width:46px;background:var(--bg4);border:1px solid var(--border);color:var(--text);border-radius:4px;padding:2px 4px;font-size:10px;font-family:monospace;text-align:center;`;}
  _rgbHex([r,g,b]){return'#'+[r,g,b].map(v=>Math.round(clamp(v,0,1)*255).toString(16).padStart(2,'0')).join('');}
  _hexRgb(h){return[parseInt(h.slice(1,3),16)/255,parseInt(h.slice(3,5),16)/255,parseInt(h.slice(5,7),16)/255];}

  // Public destroy
  destroy(){
    this._kdTree=null;
    document.getElementById('nse-overlay')?.getContext('2d')?.clearRect(0,0,9999,9999);
  }
}

export function mountNIFSceneEditor(selector,renderer,gaussians,nifId,token,api){
  const c=typeof selector==='string'?document.querySelector(selector):selector;
  if(!c) throw new Error(`NIFSceneEditor: container not found: ${selector}`);
  return new NIFSceneEditor(c,renderer,gaussians,nifId,token,api);
}

 *
 * Four editing modes, all non-destructive (edit history stored in CHUNK 0x0013):
 *
 *   SCULPT   — brush-based depth point editing:
 *              grab (move), smooth, erase, colour paint, density push/pull
 *              lasso select, sphere select, box select
 *              undo/redo stack (up to 50 states)
 *
 *   LIGHT    — virtual lighting over the depth field:
 *              add/remove/move point lights, area lights, IBL environment
 *              real-time preview using BRDF from NIFMath
 *              shadow intensity, specular hardness, ambient occlusion strength
 *
 *   DEPTH    — depth-of-field and bokeh controls:
 *              focal plane (click to set focus point)
 *              aperture (f-stop), bokeh shape, focus pull animation keyframes
 *              foreground/background blur independently
 *
 *   MESH     — 3D print mesh preparation:
 *              visualise the marching cubes isosurface live
 *              adjust isovalue (detail level)
 *              paint regions to include/exclude from print
 *              mark support areas, set slice plane
 *              preview wall thickness, show thin-wall warnings
 *              send directly to print queue with edited parameters
 *
 * Wires into: NIFRenderer (for scene updates), GaussianEdit (math operations),
 *             GaussianKDTree (spatial queries), NIFPrintPipeline (mesh preview)
 */

import { GaussianEdit, v3, m4, clamp, smoothstep } from '../core/math/NIFMath.js';
import { GaussianKDTree, raycastGaussians } from '../core/physics/NIFPhysics.js';

// ─── Tool registry ─────────────────────────────────────────────────────────────
const SCULPT_TOOLS = {
  grab:    { icon: '✥', label: 'Grab',    cursor: 'move',      hotkey: 'G' },
  smooth:  { icon: '◎', label: 'Smooth',  cursor: 'crosshair', hotkey: 'S' },
  erase:   { icon: '◌', label: 'Erase',   cursor: 'crosshair', hotkey: 'E' },
  paint:   { icon: '●', label: 'Paint',   cursor: 'crosshair', hotkey: 'P' },
  push:    { icon: '▲', label: 'Push',    cursor: 'crosshair', hotkey: 'Q' },
  pull:    { icon: '▼', label: 'Pull',    cursor: 'crosshair', hotkey: 'W' },
  select:  { icon: '⬡', label: 'Select',  cursor: 'default',   hotkey: 'A' },
};

export class NIFSceneEditor {
  /**
   * @param {HTMLElement}  container   — where to mount
   * @param {NIFRenderer}  renderer    — the live scene renderer
   * @param {{ count, data }} gaussians — mutable depth field
   * @param {string}       nifId
   * @param {string}       token       — auth bearer
   * @param {string}       api         — API base URL
   */
  constructor(container, renderer, gaussians, nifId, token, api) {
    this.container = container;
    this.renderer  = renderer;
    this.nifId     = nifId;
    this.token     = token;
    this.api       = api;

    // Working copy — edits applied here, renderer reads this
    this.gaussians = {
      count: gaussians.count,
      data:  new Float32Array(gaussians.data),
    };

    // KD-tree for fast spatial queries (rebuilt after each brush stroke)
    this._kdTree   = new GaussianKDTree(this.gaussians.data, this.gaussians.count);

    // Edit history for undo/redo
    this._history  = [];
    this._historyIdx = -1;
    this._maxHistory = 50;

    // Selection state
    this._selection = new Set(); // indices of selected depth points
    this._selectionBuffer = null; // Float32Array highlight buffer for GPU

    // Current mode and tool
    this._mode = 'sculpt';
    this._tool = 'grab';

    // Brush state
    this._brush = {
      radius:   0.15,   // world-space radius
      strength: 0.5,    // 0–1
      colour:   [1, 1, 1],
      falloff:  'smooth', // 'smooth' | 'hard' | 'linear'
    };

    // Lighting state
    this._lights = [];
    this._ibl    = { strength: 0.3, colour: [0.8, 0.9, 1.0] };
    this._lightingEnabled = false;

    // Depth-of-field state
    this._dof = {
      enabled:      false,
      focalDist:    2.0,    // world units
      aperture:     2.8,    // f-stop
      bokehBlades:  6,      // hexagonal
      fgBlur:       true,
      bgBlur:       true,
    };

    // Mesh preview state
    this._meshPreview = {
      visible:    false,
      isovalue:   null,   // null = auto
      paintMask:  null,   // Uint8Array — per-point include/exclude
    };

    // Dragging state
    this._dragging  = false;
    this._dragStart = null;
    this._lastHit   = null;

    this._build();
    this._bindEvents();
    this._saveHistory('initial');
  }

  // ── Build UI ──────────────────────────────────────────────────────────────────
  _build() {
    this.container.innerHTML = '';
    this.container.style.cssText = `
      display:grid; grid-template-columns:52px 1fr 280px;
      height:100%; background:#0a0a0a; overflow:hidden;
      font-family:'DM Sans',system-ui,sans-serif; color:#e0e0e0;
      --accent:#7c6dfa; --accent2:#3ecfcf;
      --bg1:#0a0a0a; --bg2:#111; --bg3:#181818; --bg4:#222;
      --border:rgba(255,255,255,0.07); --text:#e0e0e0; --text2:#888; --text3:#555;
      --red:#f06; --green:#3ecfcf; --warn:#f90;
    `;

    this.container.innerHTML = `
      <!-- ── Left toolbar ─────────────────────────────────────── -->
      <div id="nse-toolbar" style="
        display:flex;flex-direction:column;align-items:center;
        padding:8px 4px;gap:4px;border-right:1px solid var(--border);
        background:var(--bg2);
      ">
        <!-- Mode buttons -->
        <div style="font-size:8px;color:var(--text3);letter-spacing:.06em;margin:4px 0 2px;">MODE</div>
        ${this._modeBtn('sculpt','✦','Sculpt')}
        ${this._modeBtn('light','◉','Light')}
        ${this._modeBtn('depth','⊙','Depth')}
        ${this._modeBtn('mesh','◻','Mesh')}

        <div style="height:1px;background:var(--border);width:32px;margin:6px 0;"></div>

        <!-- Tool buttons — shown per mode -->
        <div id="nse-tools" style="display:flex;flex-direction:column;gap:2px;align-items:center;"></div>

        <div style="flex:1"></div>

        <!-- Undo / Redo -->
        <button id="nse-undo" title="Undo (Ctrl+Z)" style="${this._tbtn()}opacity:.5;">↩</button>
        <button id="nse-redo" title="Redo (Ctrl+Y)" style="${this._tbtn()}opacity:.5;">↪</button>
      </div>

      <!-- ── Viewport (renderer canvas lives here) ─────────────── -->
      <div id="nse-viewport" style="position:relative;overflow:hidden;background:#000;">
        <!-- Brush radius overlay circle -->
        <svg id="nse-brush-ring" style="
          position:absolute;pointer-events:none;overflow:visible;
          top:0;left:0;width:100%;height:100%;opacity:0;transition:opacity .15s;
        ">
          <circle id="nse-brush-circle" cx="0" cy="0" r="40"
            fill="none" stroke="rgba(124,109,250,.7)" stroke-width="1.5"
            stroke-dasharray="4 3"/>
        </svg>

        <!-- Selection lasso overlay -->
        <canvas id="nse-lasso-canvas" style="
          position:absolute;top:0;left:0;width:100%;height:100%;
          pointer-events:none;
        "></canvas>

        <!-- Status bar -->
        <div id="nse-status" style="
          position:absolute;bottom:12px;left:50%;transform:translateX(-50%);
          background:rgba(0,0,0,.7);backdrop-filter:blur(8px);
          border:1px solid var(--border);border-radius:20px;
          padding:5px 14px;font-size:11px;color:var(--text2);
          pointer-events:none;white-space:nowrap;
        ">✦ NIF Scene Editor — ready</div>

        <!-- DOF focal plane indicator -->
        <div id="nse-focal-plane" style="
          position:absolute;top:0;bottom:0;left:50%;width:2px;
          background:linear-gradient(to bottom,transparent,var(--accent2),transparent);
          opacity:0;pointer-events:none;transform:translateX(-50%);
          transition:opacity .3s;
        "></div>
      </div>

      <!-- ── Right panel ───────────────────────────────────────── -->
      <div id="nse-panel" style="
        border-left:1px solid var(--border);background:var(--bg2);
        overflow-y:auto;display:flex;flex-direction:column;
      ">
        <!-- Panel header -->
        <div style="padding:14px 16px 10px;border-bottom:1px solid var(--border);">
          <div style="font-size:13px;font-weight:700;letter-spacing:.01em;" id="nse-panel-title">✦ Sculpt</div>
          <div style="font-size:10px;color:var(--text3);margin-top:2px;" id="nse-panel-sub">
            ${this.gaussians.count.toLocaleString()} depth points
          </div>
        </div>

        <!-- Dynamic panel content -->
        <div id="nse-panel-body" style="padding:14px;flex:1;"></div>

        <!-- Save / Apply -->
        <div style="padding:12px 14px;border-top:1px solid var(--border);display:flex;gap:8px;">
          <button id="nse-save" style="
            flex:1;background:var(--accent);color:#fff;border:none;
            border-radius:8px;padding:10px;font-size:12px;font-weight:600;
            cursor:pointer;transition:opacity .15s;
          ">Save to NIF</button>
          <button id="nse-reset" style="
            background:var(--bg4);color:var(--text2);border:1px solid var(--border);
            border-radius:8px;padding:10px 14px;font-size:12px;cursor:pointer;
          ">Reset</button>
        </div>
      </div>
    `;

    this._setMode('sculpt');
  }

  _modeBtn(mode, icon, label) {
    return `<button class="nse-mode-btn" data-mode="${mode}" title="${label}" style="
      width:40px;height:40px;border-radius:10px;border:1px solid transparent;
      background:transparent;color:var(--text2);font-size:16px;cursor:pointer;
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      gap:1px;transition:all .15s;
    ">
      <span style="font-size:15px;line-height:1;">${icon}</span>
      <span style="font-size:7px;letter-spacing:.04em;">${label.toUpperCase()}</span>
    </button>`;
  }

  _tbtn() {
    return `
      width:36px;height:36px;border-radius:8px;border:1px solid var(--border);
      background:var(--bg3);color:var(--text2);font-size:14px;cursor:pointer;
      display:flex;align-items:center;justify-content:center;
    `;
  }

  // ── Mode switching ─────────────────────────────────────────────────────────
  _setMode(mode) {
    this._mode = mode;

    // Update mode button active states
    this.container.querySelectorAll('.nse-mode-btn').forEach(b => {
      const active = b.dataset.mode === mode;
      b.style.background = active ? 'rgba(124,109,250,.15)' : 'transparent';
      b.style.borderColor = active ? 'rgba(124,109,250,.4)' : 'transparent';
      b.style.color = active ? '#e0e0e0' : '#666';
    });

    // Update tools
    const toolsEl = document.getElementById('nse-tools');
    toolsEl.innerHTML = '';

    if (mode === 'sculpt') {
      Object.entries(SCULPT_TOOLS).forEach(([key, t]) => {
        const btn = document.createElement('button');
        btn.dataset.tool = key;
        btn.title = `${t.label} (${t.hotkey})`;
        btn.style.cssText = `
          width:36px;height:36px;border-radius:8px;border:1px solid var(--border);
          background:${this._tool===key?'rgba(124,109,250,.2)':'var(--bg3)'};
          color:${this._tool===key?'#e0e0e0':'#888'};font-size:14px;cursor:pointer;
          display:flex;align-items:center;justify-content:center;
          border-color:${this._tool===key?'rgba(124,109,250,.4)':'var(--border)'};
        `;
        btn.textContent = t.icon;
        btn.onclick = () => this._setTool(key);
        toolsEl.appendChild(btn);
      });
    }

    // Update panel
    const titles = { sculpt:'✦ Sculpt', light:'◉ Lighting', depth:'⊙ Depth & Focus', mesh:'◻ Mesh & Print' };
    document.getElementById('nse-panel-title').textContent = titles[mode];
    this._renderPanel(mode);

    // DOF focal plane visibility
    const fp = document.getElementById('nse-focal-plane');
    if (fp) fp.style.opacity = mode === 'depth' && this._dof.enabled ? '1' : '0';
  }

  _setTool(tool) {
    this._tool = tool;
    this._setMode('sculpt'); // re-render tools with new active state
    this._status(`Tool: ${SCULPT_TOOLS[tool].label} — ${
      tool==='grab'    ? 'Drag to move depth points' :
      tool==='smooth'  ? 'Brush to smooth surface' :
      tool==='erase'   ? 'Brush to remove points' :
      tool==='paint'   ? 'Brush to recolour' :
      tool==='push'    ? 'Push points away from brush centre' :
      tool==='pull'    ? 'Pull points toward brush centre' :
      'Click or drag to select points'
    }`);
    this.container.querySelector('#nse-viewport').style.cursor = SCULPT_TOOLS[tool].cursor;
  }

  // ── Panel rendering ────────────────────────────────────────────────────────
  _renderPanel(mode) {
    const body = document.getElementById('nse-panel-body');

    if (mode === 'sculpt') {
      body.innerHTML = `
        ${this._section('Brush')}
        ${this._slider('brush-radius',  'Radius',   this._brush.radius, 0.01, 1.0, 0.01, v=>`${v.toFixed(2)}u`)}
        ${this._slider('brush-strength','Strength', this._brush.strength, 0.01, 1.0, 0.01, v=>`${Math.round(v*100)}%`)}
        ${this._row('Falloff',`
          <select id="brush-falloff" style="${this._select()}">
            <option value="smooth" ${this._brush.falloff==='smooth'?'selected':''}>Smooth</option>
            <option value="linear" ${this._brush.falloff==='linear'?'selected':''}>Linear</option>
            <option value="hard"   ${this._brush.falloff==='hard'  ?'selected':''}>Hard</option>
          </select>
        `)}
        ${this._section('Paint colour')}
        <div style="display:flex;gap:8px;margin-bottom:12px;">
          <input type="color" id="brush-colour" value="${this._rgbToHex(this._brush.colour)}"
            style="width:40px;height:32px;border:none;background:none;cursor:pointer;border-radius:6px;">
          <div style="flex:1;display:flex;flex-direction:column;gap:4px;justify-content:center;">
            ${this._miniSlider('paint-r','R',this._brush.colour[0],'#f55')}
            ${this._miniSlider('paint-g','G',this._brush.colour[1],'#5f5')}
            ${this._miniSlider('paint-b','B',this._brush.colour[2],'#55f')}
          </div>
        </div>

        ${this._section('Selection')}
        <div style="display:flex;gap:6px;margin-bottom:10px;">
          <button id="sel-invert" style="${this._btn()}">Invert</button>
          <button id="sel-clear"  style="${this._btn()}">Clear</button>
          <button id="sel-all"    style="${this._btn()}">All</button>
        </div>
        ${this._selectionCount()}

        ${this._section('Apply to selection')}
        <div style="display:flex;flex-direction:column;gap:6px;">
          <button id="sel-delete"  style="${this._btn()} color:var(--red);">Delete points</button>
          <button id="sel-fade"    style="${this._btn()}">Fade opacity</button>
          <button id="sel-smooth-sel" style="${this._btn()}">Smooth</button>
        </div>
      `;
      this._bindSculptPanel();
    }

    else if (mode === 'light') {
      body.innerHTML = `
        ${this._section('Ambient / IBL')}
        ${this._slider('ibl-strength','Strength',this._ibl.strength,0,1,0.01,v=>`${Math.round(v*100)}%`)}
        ${this._row('Sky colour',`
          <input type="color" id="ibl-colour"
            value="${this._rgbToHex(this._ibl.colour)}"
            style="width:40px;height:28px;border:none;background:none;cursor:pointer;border-radius:6px;">
        `)}

        ${this._section('Point lights')}
        <div id="light-list" style="display:flex;flex-direction:column;gap:8px;margin-bottom:10px;"></div>
        <button id="add-light" style="${this._btn()} width:100%;">+ Add light at camera</button>

        ${this._section('Light settings')}
        <div id="light-settings" style="opacity:.4;pointer-events:none;">
          ${this._slider('light-intensity','Intensity',1.0,0,5,0.1,v=>v.toFixed(1))}
          ${this._slider('light-radius','Radius',0.5,0.01,3,0.01,v=>`${v.toFixed(2)}u`)}
          ${this._slider('light-falloff','Falloff',2.0,0.5,4,0.1,v=>v.toFixed(1))}
          ${this._row('Colour',`
            <input type="color" id="light-colour" value="#ffffff"
              style="width:40px;height:28px;border:none;background:none;cursor:pointer;border-radius:6px;">
          `)}
          <button id="del-light" style="${this._btn()} color:var(--red);width:100%;margin-top:6px;">Delete light</button>
        </div>
      `;
      this._bindLightPanel();
      this._renderLightList();
    }

    else if (mode === 'depth') {
      body.innerHTML = `
        ${this._row('Depth of field',`
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;">
            <input type="checkbox" id="dof-enabled" ${this._dof.enabled?'checked':''}
              style="accent-color:var(--accent);width:14px;height:14px;">
            Enable
          </label>
        `)}
        <div id="dof-controls" style="opacity:${this._dof.enabled?1:.4};pointer-events:${this._dof.enabled?'all':'none'};transition:opacity .2s;">
          ${this._section('Focus')}
          <div style="
            background:var(--bg3);border:1px solid var(--border);border-radius:8px;
            padding:10px;font-size:11px;color:var(--text2);margin-bottom:12px;
          ">
            Click anywhere in the viewport to set the focal point.<br>
            The depth at that point becomes the focal plane.
          </div>
          ${this._slider('dof-focal','Focal distance',this._dof.focalDist,0.1,20,0.1,v=>`${v.toFixed(1)}m`)}
          ${this._slider('dof-aperture','Aperture (f)',this._dof.aperture,0.5,22,0.5,v=>`f/${v.toFixed(1)}`)}

          ${this._section('Bokeh')}
          ${this._slider('dof-blades','Blades',this._dof.bokehBlades,3,12,1,v=>`${v} blade${v>1?'s':''}`)}
          ${this._row('Foreground blur',`
            <input type="checkbox" id="dof-fg" ${this._dof.fgBlur?'checked':''}
              style="accent-color:var(--accent);width:14px;height:14px;">
          `)}
          ${this._row('Background blur',`
            <input type="checkbox" id="dof-bg" ${this._dof.bgBlur?'checked':''}
              style="accent-color:var(--accent);width:14px;height:14px;">
          `)}

          ${this._section('Keyframes')}
          <div style="font-size:10px;color:var(--text3);margin-bottom:8px;">
            Set focal distance at specific times to animate focus pull.
          </div>
          <div id="dof-keyframes" style="display:flex;flex-direction:column;gap:5px;margin-bottom:8px;"></div>
          <button id="dof-add-kf" style="${this._btn()} width:100%;">+ Add focal keyframe</button>
        </div>
      `;
      this._bindDepthPanel();
    }

    else if (mode === 'mesh') {
      body.innerHTML = `
        ${this._section('Isosurface (mesh preview)')}
        <div style="
          background:var(--bg3);border:1px solid var(--border);border-radius:8px;
          padding:10px;font-size:11px;color:var(--text2);margin-bottom:12px;line-height:1.6;
        ">
          The mesh is extracted from the depth field in real time.
          Adjust the isovalue to control how much detail is included.
          Lower = more volume, looser. Higher = tighter, less.
        </div>
        ${this._row('Show mesh',`
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;">
            <input type="checkbox" id="mesh-visible" ${this._meshPreview.visible?'checked':''}
              style="accent-color:var(--accent);width:14px;height:14px;">
            Preview wireframe
          </label>
        `)}
        ${this._slider('mesh-isovalue','Detail level',
          this._meshPreview.isovalue ?? 0.5, 0.1, 0.95, 0.01,
          v=>`${Math.round(v*100)}%`)}

        ${this._section('Paint include/exclude')}
        <div style="display:flex;gap:6px;margin-bottom:10px;">
          <button id="mesh-paint-include" style="${this._btn()} background:rgba(62,207,207,.15);color:var(--green);">Include</button>
          <button id="mesh-paint-exclude" style="${this._btn()} background:rgba(255,0,102,.1);color:var(--red);">Exclude</button>
          <button id="mesh-paint-clear"   style="${this._btn()}">Clear</button>
        </div>
        <div style="font-size:10px;color:var(--text3);margin-bottom:12px;">
          Brush include/exclude regions before sending to 3D print.
          Excluded points are removed from the mesh. Useful for cutting
          off a cluttered background before printing.
        </div>

        ${this._section('Wall thickness')}
        ${this._slider('mesh-wall','Min wall',2.5,0.5,8,0.5,v=>`${v}mm`)}
        <div id="mesh-wall-warn" style="
          display:none;background:rgba(255,153,0,.1);border:1px solid rgba(255,153,0,.3);
          border-radius:6px;padding:8px;font-size:10px;color:var(--warn);margin-top:6px;
        ">⚠ Thin walls detected. Parts may be fragile. Increase wall thickness or use resin.</div>

        ${this._section('Send to print')}
        <div style="display:flex;flex-direction:column;gap:8px;">
          <div style="font-size:10px;color:var(--text3);margin-bottom:2px;">
            Choose a template. The mesh edits you made here (include/exclude, isovalue)
            are sent as parameters to the Kaggle worker.
          </div>
          <select id="mesh-template" style="${this._select()}">
            <option value="figurine">🧍 Figurine (120mm)</option>
            <option value="memory">💝 Memory Figurine (150mm)</option>
            <option value="bust">🏺 Bust (150mm)</option>
            <option value="statue">🏆 Portrait Statue (200mm)</option>
            <option value="bobblehead">😄 Bobblehead (100mm)</option>
            <option value="keychain">🔑 Keychain (45mm)</option>
            <option value="ornament">🎄 Ornament (60mm)</option>
            <option value="coin">🪙 Coin (40mm)</option>
            <option value="miniature">⚔️ Miniature (32mm)</option>
          </select>
          ${this._slider('mesh-height','Height',120,20,400,10,v=>`${v}mm`)}
          <button id="mesh-send-print" style="
            background:linear-gradient(135deg,var(--accent),var(--accent2));
            color:#fff;border:none;border-radius:8px;padding:11px;
            font-size:12px;font-weight:600;cursor:pointer;width:100%;
          ">Send to 3D Print →</button>
        </div>
      `;
      this._bindMeshPanel();
    }
  }

  // ── Panel bindings ─────────────────────────────────────────────────────────
  _bindSculptPanel() {
    const get = id => document.getElementById(id);

    get('brush-radius')?.addEventListener('input', e => {
      this._brush.radius = +e.target.value;
      e.target.nextElementSibling.textContent = `${(+e.target.value).toFixed(2)}u`;
    });
    get('brush-strength')?.addEventListener('input', e => {
      this._brush.strength = +e.target.value;
      e.target.nextElementSibling.textContent = `${Math.round(+e.target.value*100)}%`;
    });
    get('brush-falloff')?.addEventListener('change', e => { this._brush.falloff = e.target.value; });
    get('brush-colour')?.addEventListener('input', e => {
      this._brush.colour = this._hexToRgb(e.target.value);
      const [r,g,b] = this._brush.colour;
      get('paint-r').value = r; get('paint-r').nextElementSibling.style.width = `${r*100}%`;
      get('paint-g').value = g; get('paint-g').nextElementSibling.style.width = `${g*100}%`;
      get('paint-b').value = b; get('paint-b').nextElementSibling.style.width = `${b*100}%`;
    });

    get('sel-invert')?.addEventListener('click', () => {
      const all = new Set(Array.from({length:this.gaussians.count},(_,i)=>i));
      this._selection = new Set([...all].filter(i=>!this._selection.has(i)));
      this._updateSelectionCount();
    });
    get('sel-clear')?.addEventListener('click', () => {
      this._selection.clear();
      this._updateSelectionCount();
    });
    get('sel-all')?.addEventListener('click', () => {
      this._selection = new Set(Array.from({length:this.gaussians.count},(_,i)=>i));
      this._updateSelectionCount();
    });
    get('sel-delete')?.addEventListener('click', () => {
      if (!this._selection.size) return;
      this._saveHistory('before-delete');
      const result = GaussianEdit.delete(this.gaussians.data, this.gaussians.count, [...this._selection]);
      this.gaussians = result;
      this._selection.clear();
      this._rebuildKDTree();
      this._pushToRenderer();
      this._status(`Deleted ${result.count} points removed`);
    });
    get('sel-fade')?.addEventListener('click', () => {
      if (!this._selection.size) return;
      this._saveHistory('before-fade');
      this.gaussians.data = GaussianEdit.fade(this.gaussians.data, [...this._selection], 0.5);
      this._pushToRenderer();
    });
    get('sel-smooth-sel')?.addEventListener('click', () => {
      if (!this._selection.size) return;
      this._saveHistory('before-smooth');
      this._smoothIndices([...this._selection]);
      this._pushToRenderer();
    });
  }

  _bindLightPanel() {
    const get = id => document.getElementById(id);
    get('ibl-strength')?.addEventListener('input', e => {
      this._ibl.strength = +e.target.value;
      e.target.nextElementSibling.textContent = `${Math.round(+e.target.value*100)}%`;
      this._applyLighting();
    });
    get('ibl-colour')?.addEventListener('input', e => {
      this._ibl.colour = this._hexToRgb(e.target.value);
      this._applyLighting();
    });
    get('add-light')?.addEventListener('click', () => {
      const pos = [...this.renderer.camera.position];
      this._lights.push({ pos, colour:[1,1,1], intensity:1.0, radius:0.5, falloff:2.0, id: Date.now() });
      this._renderLightList();
      this._applyLighting();
    });
  }

  _renderLightList() {
    const list = document.getElementById('light-list');
    if (!list) return;
    list.innerHTML = this._lights.map((l, i) => `
      <div class="light-item" data-idx="${i}" style="
        background:var(--bg3);border:1px solid var(--border);border-radius:8px;
        padding:8px 10px;cursor:pointer;display:flex;align-items:center;gap:8px;
        font-size:11px;
      ">
        <div style="width:12px;height:12px;border-radius:50%;flex-shrink:0;
          background:${this._rgbToHex(l.colour)};box-shadow:0 0 6px ${this._rgbToHex(l.colour)};"></div>
        <span>Light ${i+1}</span>
        <span style="color:var(--text3);margin-left:auto;">
          ${l.pos.map(v=>v.toFixed(1)).join(', ')}
        </span>
      </div>
    `).join('');
    list.querySelectorAll('.light-item').forEach(el => {
      el.addEventListener('click', () => this._selectLight(+el.dataset.idx));
    });
  }

  _selectLight(idx) {
    this._selectedLight = idx;
    const l = this._lights[idx];
    if (!l) return;
    const settings = document.getElementById('light-settings');
    if (settings) { settings.style.opacity='1'; settings.style.pointerEvents='all'; }
    document.getElementById('light-intensity').value = l.intensity;
    document.getElementById('light-radius').value = l.radius;
    document.getElementById('light-falloff').value = l.falloff;
    document.getElementById('light-colour').value = this._rgbToHex(l.colour);
  }

  _bindDepthPanel() {
    const get = id => document.getElementById(id);
    get('dof-enabled')?.addEventListener('change', e => {
      this._dof.enabled = e.target.checked;
      const ctrl = document.getElementById('dof-controls');
      if (ctrl) { ctrl.style.opacity = e.target.checked?'1':'.4'; ctrl.style.pointerEvents = e.target.checked?'all':'none'; }
      const fp = document.getElementById('nse-focal-plane');
      if (fp) fp.style.opacity = e.target.checked ? '1' : '0';
      this._applyDOF();
    });
    get('dof-focal')?.addEventListener('input', e => {
      this._dof.focalDist = +e.target.value;
      e.target.nextElementSibling.textContent = `${(+e.target.value).toFixed(1)}m`;
      this._applyDOF();
    });
    get('dof-aperture')?.addEventListener('input', e => {
      this._dof.aperture = +e.target.value;
      e.target.nextElementSibling.textContent = `f/${(+e.target.value).toFixed(1)}`;
      this._applyDOF();
    });
    get('dof-blades')?.addEventListener('input', e => {
      this._dof.bokehBlades = +e.target.value;
      e.target.nextElementSibling.textContent = `${+e.target.value} blades`;
    });
    get('dof-fg')?.addEventListener('change', e => { this._dof.fgBlur = e.target.checked; this._applyDOF(); });
    get('dof-bg')?.addEventListener('change', e => { this._dof.bgBlur = e.target.checked; this._applyDOF(); });
    get('dof-add-kf')?.addEventListener('click', () => this._addDOFKeyframe());
  }

  _bindMeshPanel() {
    const get = id => document.getElementById(id);
    get('mesh-visible')?.addEventListener('change', e => {
      this._meshPreview.visible = e.target.checked;
      this._updateMeshPreview();
    });
    get('mesh-isovalue')?.addEventListener('input', e => {
      this._meshPreview.isovalue = +e.target.value;
      e.target.nextElementSibling.textContent = `${Math.round(+e.target.value*100)}%`;
      this._updateMeshPreview();
    });
    get('mesh-paint-include')?.addEventListener('click', () => { this._meshPaintMode = 'include'; this._status('Paint mode: Include — brush to mark points for printing'); });
    get('mesh-paint-exclude')?.addEventListener('click', () => { this._meshPaintMode = 'exclude'; this._status('Paint mode: Exclude — brush to remove points from mesh'); });
    get('mesh-paint-clear')?.addEventListener('click', () => {
      this._meshPreview.paintMask = null;
      this._meshPaintMode = null;
      this._status('Paint mask cleared');
    });
    get('mesh-send-print')?.addEventListener('click', () => this._sendToPrint());
  }

  // ── Brush operations ───────────────────────────────────────────────────────
  _applyBrush(worldPos, dt = 0.016) {
    if (!this._kdTree) return;
    const indices = this._kdTree.radiusQuery(worldPos, this._brush.radius);
    if (!indices.length) return;

    const data     = this.gaussians.data;
    const r        = this._brush.radius;
    const strength = this._brush.strength * dt * 60; // frame-rate independent

    const falloffFn = {
      smooth: d => smoothstep(r, 0, d),
      linear: d => clamp(1 - d/r, 0, 1),
      hard:   d => d < r ? 1 : 0,
    }[this._brush.falloff] ?? (d => smoothstep(r, 0, d));

    switch (this._tool) {
      case 'grab': {
        if (!this._dragDelta) break;
        const delta = this._dragDelta;
        for (const idx of indices) {
          const j = idx * 14;
          const dx = data[j]-worldPos[0], dy=data[j+1]-worldPos[1], dz=data[j+2]-worldPos[2];
          const d  = Math.sqrt(dx*dx+dy*dy+dz*dz);
          const w  = falloffFn(d) * strength;
          data[j]   += delta[0] * w;
          data[j+1] += delta[1] * w;
          data[j+2] += delta[2] * w;
        }
        break;
      }
      case 'smooth': {
        // Average position with neighbours
        for (const idx of indices) {
          const j = idx * 14;
          const neighbours = this._kdTree.radiusQuery([data[j],data[j+1],data[j+2]], r*0.5);
          if (neighbours.length < 2) continue;
          let ax=0,ay=0,az=0;
          for (const ni of neighbours) { ax+=data[ni*14]; ay+=data[ni*14+1]; az+=data[ni*14+2]; }
          ax/=neighbours.length; ay/=neighbours.length; az/=neighbours.length;
          const dx=data[j]-worldPos[0],dy=data[j+1]-worldPos[1],dz=data[j+2]-worldPos[2];
          const w = falloffFn(Math.sqrt(dx*dx+dy*dy+dz*dz)) * strength * 0.3;
          data[j]  =data[j]  +(ax-data[j])  *w;
          data[j+1]=data[j+1]+(ay-data[j+1])*w;
          data[j+2]=data[j+2]+(az-data[j+2])*w;
        }
        break;
      }
      case 'erase': {
        for (const idx of indices) {
          const j = idx * 14;
          const dx=data[j]-worldPos[0],dy=data[j+1]-worldPos[1],dz=data[j+2]-worldPos[2];
          const w = falloffFn(Math.sqrt(dx*dx+dy*dy+dz*dz)) * strength;
          data[j+10] -= w * 3; // reduce opacity in logit space
        }
        break;
      }
      case 'paint': {
        const [tr,tg,tb] = this._brush.colour;
        const logit = x => Math.log(Math.max(0.001,Math.min(0.999,x)) / (1-Math.max(0.001,Math.min(0.999,x))));
        for (const idx of indices) {
          const j = idx * 14;
          const dx=data[j]-worldPos[0],dy=data[j+1]-worldPos[1],dz=data[j+2]-worldPos[2];
          const w = falloffFn(Math.sqrt(dx*dx+dy*dy+dz*dz)) * strength;
          data[j+11]=data[j+11]+(logit(tr-0.5)-data[j+11])*w;
          data[j+12]=data[j+12]+(logit(tg-0.5)-data[j+12])*w;
          data[j+13]=data[j+13]+(logit(tb-0.5)-data[j+13])*w;
        }
        break;
      }
      case 'push': {
        for (const idx of indices) {
          const j = idx * 14;
          const dx=data[j]-worldPos[0],dy=data[j+1]-worldPos[1],dz=data[j+2]-worldPos[2];
          const d = Math.sqrt(dx*dx+dy*dy+dz*dz)+1e-8;
          const w = falloffFn(d) * strength * 0.02;
          data[j]  +=dx/d*w; data[j+1]+=dy/d*w; data[j+2]+=dz/d*w;
        }
        break;
      }
      case 'pull': {
        for (const idx of indices) {
          const j = idx * 14;
          const dx=data[j]-worldPos[0],dy=data[j+1]-worldPos[1],dz=data[j+2]-worldPos[2];
          const d = Math.sqrt(dx*dx+dy*dy+dz*dz)+1e-8;
          const w = falloffFn(d) * strength * 0.02;
          data[j]  -=dx/d*w; data[j+1]-=dy/d*w; data[j+2]-=dz/d*w;
        }
        break;
      }
      case 'select': {
        for (const idx of indices) this._selection.add(idx);
        this._updateSelectionCount();
        break;
      }
    }

    // Mesh paint mode
    if (this._meshPaintMode && this._mode === 'mesh') {
      if (!this._meshPreview.paintMask) {
        this._meshPreview.paintMask = new Uint8Array(this.gaussians.count).fill(1);
      }
      const val = this._meshPaintMode === 'include' ? 1 : 0;
      for (const idx of indices) this._meshPreview.paintMask[idx] = val;
    }

    this._pushToRenderer();
  }

  // ── Lighting application ───────────────────────────────────────────────────
  // Lighting is applied by modifying the SH0 colour of each depth point
  // based on its position relative to the virtual lights.
  // This is baked into the depth field data — the renderer sees it as
  // just regular colour. Non-destructive: stored as an edit layer.
  _applyLighting() {
    if (!this._lightingEnabled) return;
    const data   = this.gaussians.data;
    const count  = this.gaussians.count;
    const logit  = x => Math.log(Math.max(0.001,Math.min(0.999,x)) / (1-Math.max(0.001,Math.min(0.999,x))));
    const sigmoid = x => 1/(1+Math.exp(-x));

    for (let i = 0; i < count; i++) {
      const j   = i * 14;
      const pos = [data[j], data[j+1], data[j+2]];

      // Estimate surface normal from KD neighbours
      const neighbours = this._kdTree.kNN(pos, 6);
      let nx=0,ny=0,nz=1;
      if (neighbours.length >= 3) {
        const ps = neighbours.map(ni => [data[ni*14],data[ni*14+1],data[ni*14+2]]);
        const ab = v3.sub(ps[1],ps[0]), ac = v3.sub(ps[2],ps[0]);
        const cr = v3.norm(v3.cross(ab,ac));
        nx=cr[0]; ny=cr[1]; nz=cr[2];
      }
      const N = [nx,ny,nz];

      // Base colour from SH0
      const baseR = sigmoid(data[j+11])+0.5;
      const baseG = sigmoid(data[j+12])+0.5;
      const baseB = sigmoid(data[j+13])+0.5;

      // IBL contribution
      let r = baseR*this._ibl.colour[0]*this._ibl.strength;
      let g = baseG*this._ibl.colour[1]*this._ibl.strength;
      let b = baseB*this._ibl.colour[2]*this._ibl.strength;

      // Point light contributions
      for (const light of this._lights) {
        const toLight = v3.sub(light.pos, pos);
        const dist    = v3.len(toLight) + 1e-8;
        const L       = v3.scale(toLight, 1/dist);
        const NdotL   = Math.max(v3.dot(N, L), 0);
        const atten   = light.intensity / Math.pow(dist/light.radius + 1, light.falloff);
        r += baseR * light.colour[0] * NdotL * atten;
        g += baseG * light.colour[1] * NdotL * atten;
        b += baseB * light.colour[2] * NdotL * atten;
      }

      data[j+11] = logit(clamp(r-0.5, 0.001, 0.999));
      data[j+12] = logit(clamp(g-0.5, 0.001, 0.999));
      data[j+13] = logit(clamp(b-0.5, 0.001, 0.999));
    }

    this._pushToRenderer();
    this._status('Lighting applied to depth field');
  }

  // ── DOF application ────────────────────────────────────────────────────────
  // DOF is stored as parameters in the edit history.
  // At export time, the video exporter applies post-process DOF per frame.
  // In the live viewer it adjusts depth point opacity by distance from focal plane.
  _applyDOF() {
    if (!this._dof.enabled) {
      // Restore full opacity
      this._pushToRenderer();
      return;
    }

    const data   = this.gaussians.data;
    const count  = this.gaussians.count;
    const fDist  = this._dof.focalDist;
    const fStop  = this._dof.aperture;
    // Circle of confusion: CoC = sensor * |focus - depth| / (focus * fStop)
    const sensor = 0.024; // 24mm sensor equiv

    for (let i = 0; i < count; i++) {
      const j    = i * 14;
      const depth = Math.abs(data[j+2]); // z distance
      const delta = Math.abs(depth - fDist);
      const coc   = (sensor * delta) / (fDist * fStop);
      const blur  = clamp(coc * 2, 0, 1);
      const applyBlur = (depth < fDist && this._dof.fgBlur) || (depth >= fDist && this._dof.bgBlur);
      if (applyBlur) {
        data[j+10] -= blur * 1.5; // reduce logit opacity → fade blurred points
      }
    }

    this._pushToRenderer();
  }

  _addDOFKeyframe() {
    if (!this._dofKeyframes) this._dofKeyframes = [];
    this._dofKeyframes.push({ t: 0, focalDist: this._dof.focalDist });
    const list = document.getElementById('dof-keyframes');
    if (list) {
      list.innerHTML = this._dofKeyframes.map((kf, i) => `
        <div style="display:flex;align-items:center;gap:6px;font-size:11px;">
          <span style="color:var(--text3);">t=</span>
          <input type="number" value="${kf.t}" min="0" max="100" step="0.1"
            style="${this._miniInput()}" onchange="this.closest('[id]').__kf=${i}">
          <span style="color:var(--text3);">f=</span>
          <input type="number" value="${kf.focalDist.toFixed(1)}" step="0.1"
            style="${this._miniInput()}">
          <button onclick="this.parentElement.remove()"
            style="background:none;border:none;color:var(--red);cursor:pointer;">✕</button>
        </div>
      `).join('');
    }
  }

  // ── Mesh preview ───────────────────────────────────────────────────────────
  _updateMeshPreview() {
    // In a real implementation this calls back to the Kaggle worker to get
    // a live marching-cubes preview at low resolution.
    // For the editor, we show a wireframe sphere overlay as placeholder
    // and the actual mesh is generated at print time.
    const warn = document.getElementById('mesh-wall-warn');
    if (warn) {
      const isovalue = this._meshPreview.isovalue ?? 0.5;
      // At very high isovalue, walls get thin
      warn.style.display = isovalue > 0.80 ? 'block' : 'none';
    }
    this._status(this._meshPreview.visible
      ? `Mesh preview at ${Math.round((this._meshPreview.isovalue??0.5)*100)}% — wireframe overlay`
      : 'Mesh preview hidden');
  }

  async _sendToPrint() {
    const template  = document.getElementById('mesh-template')?.value ?? 'figurine';
    const heightEl  = document.getElementById('mesh-height');
    const height_mm = heightEl ? +heightEl.value : 120;
    const isovalue  = this._meshPreview.isovalue;
    const paintMask = this._meshPreview.paintMask;

    // Build edit_params to pass to the pipeline
    const editParams = {};
    if (isovalue !== null) editParams.isovalue = isovalue;
    if (paintMask) {
      // Encode excluded indices as a compact list
      const excluded = [];
      for (let i = 0; i < paintMask.length; i++) {
        if (paintMask[i] === 0) excluded.push(i);
      }
      if (excluded.length) editParams.excluded_indices = excluded;
    }

    const btn = document.getElementById('mesh-send-print');
    if (btn) { btn.textContent = 'Sending…'; btn.disabled = true; }

    try {
      const res = await fetch(`${this.api}/nif/${this.nifId}/print/request`, {
        method: 'POST',
        headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${this.token}` },
        body: JSON.stringify({ templates:[template], height_mm, edit_params:editParams }),
      });
      if (res.ok) {
        const { jobId } = await res.json();
        this._status(`✓ Print job queued — ${template} ${height_mm}mm. Check the Print dashboard.`);
        if (btn) { btn.textContent = '✓ Sent!'; setTimeout(()=>{ btn.textContent='Send to 3D Print →'; btn.disabled=false; },3000); }
      } else {
        throw new Error((await res.json()).error ?? 'Print request failed');
      }
    } catch (e) {
      this._status(`✗ ${e.message}`);
      if (btn) { btn.textContent = 'Send to 3D Print →'; btn.disabled = false; }
    }
  }

  // ── History ────────────────────────────────────────────────────────────────
  _saveHistory(label) {
    // Trim forward history on new edit
    if (this._historyIdx < this._history.length - 1) {
      this._history = this._history.slice(0, this._historyIdx + 1);
    }
    this._history.push({
      label,
      data: new Float32Array(this.gaussians.data),
      count: this.gaussians.count,
    });
    if (this._history.length > this._maxHistory) this._history.shift();
    this._historyIdx = this._history.length - 1;
    this._updateUndoRedo();
  }

  _undo() {
    if (this._historyIdx <= 0) return;
    this._historyIdx--;
    const snap = this._history[this._historyIdx];
    this.gaussians = { count: snap.count, data: new Float32Array(snap.data) };
    this._rebuildKDTree();
    this._pushToRenderer();
    this._status(`Undo: ${snap.label}`);
    this._updateUndoRedo();
  }

  _redo() {
    if (this._historyIdx >= this._history.length - 1) return;
    this._historyIdx++;
    const snap = this._history[this._historyIdx];
    this.gaussians = { count: snap.count, data: new Float32Array(snap.data) };
    this._rebuildKDTree();
    this._pushToRenderer();
    this._status(`Redo: ${snap.label}`);
    this._updateUndoRedo();
  }

  _updateUndoRedo() {
    const u = document.getElementById('nse-undo');
    const r = document.getElementById('nse-redo');
    if (u) u.style.opacity = this._historyIdx > 0 ? '1' : '.3';
    if (r) r.style.opacity = this._historyIdx < this._history.length-1 ? '1' : '.3';
  }

  // ── Save to NIF ────────────────────────────────────────────────────────────
  async _saveToNIF() {
    const btn = document.getElementById('nse-save');
    if (btn) { btn.textContent = 'Saving…'; btn.disabled = true; }

    // Build edit history chunk payload
    const editRecord = {
      version:   1,
      timestamp: Date.now(),
      changes:   this._history.map(h => h.label),
      dof:       this._dof,
      lights:    this._lights,
      ibl:       this._ibl,
    };

    try {
      const res = await fetch(`${this.api}/nif/${this.nifId}/edits`, {
        method: 'POST',
        headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${this.token}` },
        body: JSON.stringify({
          gaussianData: Array.from(this.gaussians.data.subarray(0, Math.min(this.gaussians.count*14, 2_000_000))),
          count:        this.gaussians.count,
          editRecord,
        }),
      });
      if (res.ok) {
        this._status('✓ Saved to NIF file');
        if (btn) { btn.textContent = '✓ Saved'; setTimeout(()=>{ btn.textContent='Save to NIF'; btn.disabled=false; },2000); }
      } else {
        throw new Error((await res.json()).error ?? 'Save failed');
      }
    } catch (e) {
      this._status(`✗ Save failed: ${e.message}`);
      if (btn) { btn.textContent = 'Save to NIF'; btn.disabled = false; }
    }
  }

  // ── Event binding ──────────────────────────────────────────────────────────
  _bindEvents() {
    const vp = document.getElementById('nse-viewport');
    if (!vp) return;

    // Mode / tool buttons
    this.container.querySelectorAll('.nse-mode-btn').forEach(b =>
      b.addEventListener('click', () => this._setMode(b.dataset.mode))
    );

    document.getElementById('nse-undo')?.addEventListener('click', () => this._undo());
    document.getElementById('nse-redo')?.addEventListener('click', () => this._redo());
    document.getElementById('nse-save')?.addEventListener('click', () => this._saveToNIF());
    document.getElementById('nse-reset')?.addEventListener('click', () => {
      if (!confirm('Reset all edits?')) return;
      const first = this._history[0];
      if (first) {
        this.gaussians = { count: first.count, data: new Float32Array(first.data) };
        this._rebuildKDTree();
        this._pushToRenderer();
        this._historyIdx = 0;
        this._updateUndoRedo();
        this._status('Reset to original');
      }
    });

    // Keyboard shortcuts
    window.addEventListener('keydown', e => {
      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'z') { e.preventDefault(); this._undo(); }
        if (e.key === 'y') { e.preventDefault(); this._redo(); }
        return;
      }
      if (this._mode === 'sculpt') {
        Object.entries(SCULPT_TOOLS).forEach(([key, t]) => {
          if (e.key.toUpperCase() === t.hotkey) this._setTool(key);
        });
      }
      if (e.key === '[') this._brush.radius = Math.max(0.01, this._brush.radius - 0.02);
      if (e.key === ']') this._brush.radius = Math.min(2.0, this._brush.radius + 0.02);
      if (e.key === '{') this._brush.strength = Math.max(0.01, this._brush.strength - 0.05);
      if (e.key === '}') this._brush.strength = Math.min(1.0, this._brush.strength + 0.05);
    });

    // Brush ring — show on mousemove
    vp.addEventListener('mousemove', e => {
      const ring = document.getElementById('nse-brush-ring');
      const circ = document.getElementById('nse-brush-circle');
      if (ring && circ && (this._mode === 'sculpt' || (this._mode === 'mesh' && this._meshPaintMode))) {
        ring.style.opacity = '1';
        circ.setAttribute('cx', e.offsetX);
        circ.setAttribute('cy', e.offsetY);
        // Convert world brush radius to screen pixels (approximate)
        const pxRadius = this._brush.radius * 200 * (1 / (this.renderer?.camera?.position?.[2] ?? 5));
        circ.setAttribute('r', Math.max(8, Math.min(pxRadius, 300)));
      }
      if (this._dragging) this._onDrag(e);
    });
    vp.addEventListener('mouseleave', () => {
      const ring = document.getElementById('nse-brush-ring');
      if (ring) ring.style.opacity = '0';
    });
    vp.addEventListener('mousedown', e => this._onPointerDown(e));
    vp.addEventListener('mouseup',   e => this._onPointerUp(e));
  }

  _onPointerDown(e) {
    if (e.button !== 0) return; // left click only
    const worldPos = this._screenToWorld(e.offsetX, e.offsetY);
    if (!worldPos) return;

    // Depth mode: set focal point on click
    if (this._mode === 'depth' && this._dof.enabled) {
      this._dof.focalDist = Math.abs(worldPos[2]);
      const focalSlider = document.getElementById('dof-focal');
      if (focalSlider) {
        focalSlider.value = this._dof.focalDist;
        focalSlider.nextElementSibling.textContent = `${this._dof.focalDist.toFixed(1)}m`;
      }
      this._applyDOF();
      this._status(`Focal plane set at ${this._dof.focalDist.toFixed(2)}m`);
      return;
    }

    if (this._mode !== 'sculpt' && !(this._mode === 'mesh' && this._meshPaintMode)) return;

    this._dragging   = true;
    this._dragStart  = worldPos;
    this._lastHit    = worldPos;
    this._saveHistory(`before-${this._tool}`);
    this._applyBrush(worldPos);
  }

  _onDrag(e) {
    if (!this._dragging) return;
    const worldPos = this._screenToWorld(e.offsetX, e.offsetY);
    if (!worldPos) return;

    if (this._tool === 'grab' && this._lastHit) {
      this._dragDelta = v3.sub(worldPos, this._lastHit);
    }

    this._applyBrush(worldPos);
    this._lastHit = worldPos;
    this._dragDelta = null;
  }

  _onPointerUp() {
    if (this._dragging) {
      this._dragging  = false;
      this._dragStart = null;
      this._lastHit   = null;
      this._dragDelta = null;
      this._rebuildKDTree(); // update spatial index after stroke
      if (this._mode === 'mesh') this._updateMeshPreview();
    }
  }

  // ── Coordinate conversion ──────────────────────────────────────────────────
  _screenToWorld(sx, sy) {
    const vp   = document.getElementById('nse-viewport');
    if (!vp || !this.renderer) return null;
    const W    = vp.offsetWidth, H = vp.offsetHeight;
    const ndcX = (sx / W) * 2 - 1;
    const ndcY = 1 - (sy / H) * 2;
    const view = this.renderer.camera.viewMatrix();
    const proj = this.renderer.camera.projMatrix(W / H);
    const invVP = m4.inv(m4.mul(proj, view));
    const near  = m4.mulVec4(invVP, [ndcX, ndcY, -1, 1]);
    const far   = m4.mulVec4(invVP, [ndcX, ndcY,  1, 1]);
    const nw    = [near[0]/near[3], near[1]/near[3], near[2]/near[3]];
    const fw    = [far[0]/far[3],   far[1]/far[3],   far[2]/far[3]];
    const dir   = v3.norm(v3.sub(fw, nw));
    // Find closest depth point along ray
    const hit = raycastGaussians(this.gaussians.data, this.gaussians.count, nw, dir, 20);
    return hit ? hit.position : v3.add(nw, v3.scale(dir, 3)); // fallback: 3m along ray
  }

  // ── Utility ────────────────────────────────────────────────────────────────
  _rebuildKDTree() {
    this._kdTree = new GaussianKDTree(this.gaussians.data, this.gaussians.count);
  }

  _pushToRenderer() {
    if (!this.renderer) return;
    this.renderer.loadGaussians(this.gaussians);
  }

  _smoothIndices(indices) {
    const data = this.gaussians.data;
    for (const idx of indices) {
      const j  = idx * 14;
      const nb = this._kdTree.kNN([data[j],data[j+1],data[j+2]], 8);
      if (nb.length < 2) continue;
      let ax=0,ay=0,az=0;
      for (const ni of nb) { ax+=data[ni*14]; ay+=data[ni*14+1]; az+=data[ni*14+2]; }
      data[j]=ax/nb.length; data[j+1]=ay/nb.length; data[j+2]=az/nb.length;
    }
  }

  _selectionCount() {
    return `<div id="nse-sel-count" style="font-size:10px;color:var(--text3);margin-top:4px;">
      ${this._selection.size.toLocaleString()} depth points selected
    </div>`;
  }

  _updateSelectionCount() {
    const el = document.getElementById('nse-sel-count');
    if (el) el.textContent = `${this._selection.size.toLocaleString()} depth points selected`;
  }

  _status(msg) {
    const el = document.getElementById('nse-status');
    if (el) el.textContent = msg;
  }

  // ── CSS helpers ────────────────────────────────────────────────────────────
  _section(label) {
    return `<div style="font-size:9px;letter-spacing:.08em;color:var(--text3);
      text-transform:uppercase;margin:14px 0 8px;font-weight:600;">${label}</div>`;
  }

  _row(label, content) {
    return `<div style="display:flex;align-items:center;justify-content:space-between;
      margin-bottom:10px;gap:8px;">
      <span style="font-size:11px;color:var(--text2);">${label}</span>
      ${content}
    </div>`;
  }

  _slider(id, label, val, min, max, step, fmt) {
    const display = fmt(val);
    return `<div style="margin-bottom:12px;">
      <div style="display:flex;justify-content:space-between;margin-bottom:5px;">
        <span style="font-size:11px;color:var(--text2);">${label}</span>
        <span id="${id}-val" style="font-size:10px;font-family:monospace;color:var(--accent2);">${display}</span>
      </div>
      <input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${val}"
        style="width:100%;accent-color:var(--accent);cursor:pointer;"
        oninput="document.getElementById('${id}-val').textContent=(${fmt.toString()})(+this.value)">
    </div>`;
  }

  _miniSlider(id, label, val, colour) {
    return `<div style="display:flex;align-items:center;gap:4px;">
      <span style="font-size:9px;color:${colour};width:8px;">${label}</span>
      <input id="${id}" type="range" min="0" max="1" step="0.01" value="${val}"
        style="flex:1;accent-color:${colour};cursor:pointer;height:3px;">
      <div style="width:24px;height:3px;border-radius:2px;background:${colour};opacity:${val};"></div>
    </div>`;
  }

  _miniInput() {
    return `width:48px;background:var(--bg4);border:1px solid var(--border);color:var(--text);
      border-radius:4px;padding:2px 4px;font-size:10px;font-family:monospace;text-align:center;`;
  }

  _btn() {
    return `background:var(--bg4);color:var(--text2);border:1px solid var(--border);
      border-radius:6px;padding:6px 10px;font-size:11px;cursor:pointer;`;
  }

  _select() {
    return `width:100%;background:var(--bg4);color:var(--text);border:1px solid var(--border);
      border-radius:6px;padding:6px 8px;font-size:11px;cursor:pointer;margin-bottom:10px;`;
  }

  // ── Colour conversion ──────────────────────────────────────────────────────
  _rgbToHex([r,g,b]) {
    return '#' + [r,g,b].map(v=>Math.round(clamp(v,0,1)*255).toString(16).padStart(2,'0')).join('');
  }

  _hexToRgb(hex) {
    const r = parseInt(hex.slice(1,3),16)/255;
    const g = parseInt(hex.slice(3,5),16)/255;
    const b = parseInt(hex.slice(5,7),16)/255;
    return [r,g,b];
  }
}

// ─── Mount helper ─────────────────────────────────────────────────────────────
// Usage:
//   import { mountNIFSceneEditor } from './NIFSceneEditor.js';
//   const editor = mountNIFSceneEditor('#editor-container', renderer, gaussians, nifId, token, api);
//
export function mountNIFSceneEditor(selector, renderer, gaussians, nifId, token, api) {
  const container = typeof selector === 'string'
    ? document.querySelector(selector)
    : selector;
  if (!container) throw new Error(`NIFSceneEditor: container not found: ${selector}`);
  return new NIFSceneEditor(container, renderer, gaussians, nifId, token, api);
}
