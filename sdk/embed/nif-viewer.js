/**
 * NIF Embed SDK — nif-viewer.min.js (source)
 * fumoca.co.za · © Fumoca Technologies
 *
 * Drop this script on any website to embed a NIF viewer:
 *
 *   <div data-nif-id="UUID" data-nif-token="LICENSE_KEY" style="width:100%;aspect-ratio:16/9"></div>
 *   <script src="https://fumoca.co.za/viewer/nif-viewer.min.js"></script>
 *
 * Or mount programmatically:
 *   NIFViewer.mount('element-id', { nifId:'UUID', token:'LICENSE_KEY' });
 *
 * The viewer:
 *   1. Validates the license key against the API
 *   2. Fetches a signed R2 stream URL
 *   3. Fetches and parses the .nif binary
 *   4. Renders 60fps WebGL2 Gaussian splats
 *   5. Logs embed usage for billing
 */

(function(global) {
  'use strict';

  const API    = (window.NIF_CONFIG?.apiBase) ?? 'https://api.fumoca.co.za/api';
  const ORIGIN = window.location.origin;

  // ── Minimal NIF binary parser (no Node Buffer — browser ArrayBuffer only) ──
  const NIF_MAGIC = 0x4E494600;

  function parseNIF(arrayBuffer) {
    const dv = new DataView(arrayBuffer);

    // Validate magic
    const magic = dv.getUint32(0, false); // big-endian
    if (magic !== NIF_MAGIC) throw new Error(`Not a valid .nif file (magic 0x${magic.toString(16)})`);

    const version  = `${dv.getUint8(4)}.${dv.getUint8(5)}`;
    const vertical = readAscii(dv, 72, 24).trim().replace(/\0/g,'') || 'generic';

    // Parse chunks starting at byte 256
    const chunks = [];
    let offset   = 256;
    while (offset < arrayBuffer.byteLength) {
      if (offset + 16 > arrayBuffer.byteLength) break;
      const type  = dv.getUint16(offset,     false);
      const codec = dv.getUint8 (offset + 2);
      const size  = dv.getUint32(offset + 4, false);
      const crc   = dv.getUint32(offset + 8, false);
      const data  = arrayBuffer.slice(offset + 16, offset + 16 + size);
      chunks.push({ type, codec, size, crc, data });
      offset += 16 + size;
    }

    // Find KEYFRAME_GEO (0x0003)
    const geoChunk = chunks.find(c => c.type === 0x0003);
    if (!geoChunk) throw new Error('No KEYFRAME_GEO chunk. Reconstruction may be incomplete.');

    const geoDV = new DataView(geoChunk.data);
    const count = geoDV.getUint32(0, false);
    const data  = new Float32Array(geoChunk.data, 4, count * 14);

    return { count, data, vertical, version };
  }

  function readAscii(dv, offset, len) {
    let str = '';
    for (let i = 0; i < len; i++) {
      const c = dv.getUint8(offset + i);
      if (c === 0) break;
      str += String.fromCharCode(c);
    }
    return str;
  }

  // ── WebGL2 Gaussian Splat Renderer (self-contained for embed) ──────────────
  const VS = `#version 300 es
precision highp float;
in vec2 a_quad;
in vec3 a_pos; in vec3 a_scale; in vec4 a_rot; in float a_opa; in vec3 a_sh0;
uniform mat4 u_view; uniform mat4 u_proj; uniform vec2 u_vp;
out vec2 v_uv; out vec4 v_col;
mat3 q2m(vec4 q){float w=q.x,x=q.y,y=q.z,z=q.w;return mat3(1.-2.*(y*y+z*z),2.*(x*y+w*z),2.*(x*z-w*y),2.*(x*y-w*z),1.-2.*(x*x+z*z),2.*(y*z+w*x),2.*(x*z+w*y),2.*(y*z-w*x),1.-2.*(x*x+y*y));}
float sig(float x){return 1./(1.+exp(-x));}
void main(){
  vec4 cam=u_view*vec4(a_pos,1.);
  if(cam.z>=-0.01){gl_Position=vec4(2,2,2,1);return;}
  vec3 s=exp(a_scale); mat3 R=mat3(u_view)*q2m(a_rot);
  mat3 Sig3=R*mat3(s.x*s.x,0,0,0,s.y*s.y,0,0,0,s.z*s.z)*transpose(R);
  float fx=u_proj[0][0]*u_vp.x*.5,fy=u_proj[1][1]*u_vp.y*.5,iz=1./max(-cam.z,.001);
  mat3 J=mat3(fx*iz,0,-fx*cam.x*iz*iz,0,fy*iz,-fy*cam.y*iz*iz,0,0,0);
  mat3 S2=J*Sig3*transpose(J);
  float a=S2[0][0]+.3,b=S2[1][0],d=S2[1][1]+.3;
  float dc=sqrt(max((a-d)*(a-d)*.25+b*b,0.));
  float l1=(a+d)*.5+dc,l2=max((a+d)*.5-dc,0.);
  vec2 v1=normalize(vec2(b,l1-a)),sz=3.*sqrt(vec2(l1,l2));
  vec4 cl=u_proj*cam; vec2 ndc=cl.xy/cl.w;
  vec2 off=v1*a_quad.x*sz.x+vec2(-v1.y,v1.x)*a_quad.y*sz.y;
  gl_Position=vec4(ndc+off/u_vp*2.,cl.z/cl.w,1.);
  v_uv=a_quad; v_col=vec4(vec3(sig(a_sh0.x),sig(a_sh0.y),sig(a_sh0.z))+.5,sig(a_opa));
}`;

  const FS = `#version 300 es
precision highp float;
in vec2 v_uv; in vec4 v_col;
out vec4 fc;
void main(){
  float r2=dot(v_uv,v_uv);
  if(r2>1.)discard;
  float g=exp(-r2*2.),a=v_col.a*g;
  if(a<.004)discard;
  fc=vec4(v_col.rgb*a,a);
}`;

  class EmbedRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      const gl = canvas.getContext('webgl2', { premultipliedAlpha:true, antialias:false });
      if (!gl) throw new Error('WebGL2 not supported');
      this.gl = gl;
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.ONE_MINUS_DST_ALPHA,gl.ONE,gl.ONE_MINUS_DST_ALPHA,gl.ONE);
      gl.blendEquationSeparate(gl.FUNC_ADD,gl.FUNC_ADD);
      gl.disable(gl.DEPTH_TEST);
      this._init();
    }

    _shader(type, src) {
      const gl = this.gl, s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
        throw new Error('[NIFEmbed shader] ' + gl.getShaderInfoLog(s));
      return s;
    }

    _init() {
      const gl   = this.gl;
      const prog = gl.createProgram();
      gl.attachShader(prog, this._shader(gl.VERTEX_SHADER,   VS));
      gl.attachShader(prog, this._shader(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
        throw new Error('[NIFEmbed link] ' + gl.getProgramInfoLog(prog));
      this.prog = prog;

      this.quadBuf  = gl.createBuffer();
      this.splatBuf = gl.createBuffer();
      this.vao      = gl.createVertexArray();

      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);

      gl.bindVertexArray(this.vao);
      const qLoc = gl.getAttribLocation(prog,'a_quad');
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
      gl.enableVertexAttribArray(qLoc); gl.vertexAttribPointer(qLoc,2,gl.FLOAT,false,0,0);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.splatBuf);
      const stride=56, attrs=[
        ['a_pos',3,0],['a_scale',3,12],['a_rot',4,24],['a_opa',1,40],['a_sh0',3,44],
      ];
      for(const [name,size,off] of attrs){
        const loc=gl.getAttribLocation(prog,name);
        if(loc<0) continue;
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc,size,gl.FLOAT,false,stride,off);
        gl.vertexAttribDivisor(loc,1);
      }
      gl.bindVertexArray(null);
      this.count  = 0;
      this.sorted = null;
    }

    load(count, data) {
      this.count      = count;
      this.rawData    = data;
      this.eye        = [0,0,5];
      this.target     = [0,0,0];
      this._bindEvents();
    }

    _sort(viewMat) {
      const {count:n, rawData:d} = this;
      const depths = new Float32Array(n);
      for(let i=0;i<n;i++){
        const j=i*14;
        depths[i]=-(viewMat[2]*d[j]+viewMat[6]*d[j+1]+viewMat[10]*d[j+2]+viewMat[14]);
      }
      const idx = new Uint32Array(n).map((_,i)=>i).sort((a,b)=>depths[a]-depths[b]);
      const out = new Float32Array(n*14);
      for(let i=0;i<n;i++) out.set(d.subarray(idx[i]*14,idx[i]*14+14), i*14);
      return out;
    }

    _lookAt(eye,target) {
      const sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
      const len=v=>{const l=Math.sqrt(v[0]**2+v[1]**2+v[2]**2)+1e-8;return v.map(x=>x/l);};
      const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
      const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
      const f=len(sub(target,eye)), r=len(cross(f,[0,1,0])), u=cross(r,f);
      return [r[0],u[0],-f[0],0, r[1],u[1],-f[1],0, r[2],u[2],-f[2],0, -dot(r,eye),-dot(u,eye),dot(f,eye),1];
    }

    _proj(fov,asp,near,far) {
      const f=1/Math.tan(fov/2),nf=1/(near-far);
      return [f/asp,0,0,0, 0,f,0,0, 0,0,(far+near)*nf,-1, 0,0,2*far*near*nf,0];
    }

    render() {
      const gl=this.gl, W=this.canvas.width=this.canvas.offsetWidth, H=this.canvas.height=this.canvas.offsetHeight;
      gl.viewport(0,0,W,H); gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
      const view=this._lookAt(this.eye,this.target);
      const proj=this._proj(Math.PI/3,W/H,0.01,1000);
      const sorted=this._sort(view);
      gl.bindBuffer(gl.ARRAY_BUFFER,this.splatBuf);
      gl.bufferData(gl.ARRAY_BUFFER,sorted,gl.DYNAMIC_DRAW);
      gl.useProgram(this.prog);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.prog,'u_view'),false,new Float32Array(view));
      gl.uniformMatrix4fv(gl.getUniformLocation(this.prog,'u_proj'),false,new Float32Array(proj));
      gl.uniform2f(gl.getUniformLocation(this.prog,'u_vp'),W,H);
      gl.bindVertexArray(this.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP,0,4,this.count);
      gl.bindVertexArray(null);
    }

    start() {
      this._running=true;
      const loop=()=>{if(!this._running)return;this.render();requestAnimationFrame(loop);};
      requestAnimationFrame(loop);
    }

    stop(){this._running=false;}

    _bindEvents() {
      const c=this.canvas;
      let drag=false, last={x:0,y:0};
      c.addEventListener('mousedown',  e=>{drag=true; last={x:e.clientX,y:e.clientY};});
      c.addEventListener('mouseup',    ()=>drag=false);
      c.addEventListener('mouseleave', ()=>drag=false);
      c.addEventListener('mousemove',  e=>{
        if(!drag)return;
        const dx=e.clientX-last.x, dy=e.clientY-last.y;
        last={x:e.clientX,y:e.clientY};
        this._orbit(dx*0.4,dy*0.4);
      });
      c.addEventListener('wheel', e=>{e.preventDefault(); this._zoom(e.deltaY);},{passive:false});
      c.addEventListener('touchstart', e=>{drag=true;last={x:e.touches[0].clientX,y:e.touches[0].clientY};});
      c.addEventListener('touchend',   ()=>drag=false);
      c.addEventListener('touchmove',  e=>{
        const dx=e.touches[0].clientX-last.x, dy=e.touches[0].clientY-last.y;
        last={x:e.touches[0].clientX,y:e.touches[0].clientY};
        this._orbit(dx*0.4,dy*0.4);
      });
    }

    _orbit(dAz,dEl){
      const [x,y,z]=this.eye.map((v,i)=>v-this.target[i]);
      const r=Math.sqrt(x*x+y*y+z*z);
      let az=Math.atan2(x,z)+dAz*Math.PI/180;
      let el=Math.max(-1.56,Math.min(1.56,Math.asin(Math.max(-0.99,Math.min(0.99,y/r)))+dEl*Math.PI/180));
      this.eye=[this.target[0]+r*Math.cos(el)*Math.sin(az),this.target[1]+r*Math.sin(el),this.target[2]+r*Math.cos(el)*Math.cos(az)];
    }

    _zoom(delta){
      const d=this.eye.map((v,i)=>v-this.target[i]);
      const r=Math.max(0.1,Math.sqrt(d[0]**2+d[1]**2+d[2]**2)*(1+delta*0.001));
      const n=Math.sqrt(d[0]**2+d[1]**2+d[2]**2)+1e-8;
      this.eye=this.target.map((v,i)=>v+d[i]/n*r);
    }
  }

  // ── NIFViewer public class ─────────────────────────────────────────────────
  class NIFViewer {
    constructor(el, opts={}) {
      this.el       = typeof el==='string' ? document.getElementById(el) : el;
      this.nifId    = opts.nifId;
      this.token    = opts.token;
      this.api      = opts.api ?? API;
      this._renderer= null;
    }

    async load() {
      // 1. Get stream URL + meta
      const qs  = this.token ? `?license=${encodeURIComponent(this.token)}` : '';
      const hdrs= {};
      if (this.token && this.token.startsWith('ey')) hdrs['Authorization'] = `Bearer ${this.token}`;

      const sRes = await fetch(`${this.api}/nif/${this.nifId}/stream${qs}`, { headers: hdrs });
      if (!sRes.ok) { const e=await sRes.json(); throw new Error(e.error??`Stream error ${sRes.status}`); }
      const { url, meta, vertical } = await sRes.json();

      // 2. WebGL2 check — degrade gracefully on old browsers/devices
      const webgl2 = (() => {
        try { return !!document.createElement('canvas').getContext('webgl2'); }
        catch { return false; }
      })();

      if (!webgl2) {
        this._showFallback(meta);
        this._showWatermark();
        return { count: 0, vertical: vertical ?? 'generic' };
      }

      // 3. Fetch .nif binary from R2 signed URL
      const nifRes = await fetch(url);
      if (!nifRes.ok) throw new Error(`R2 fetch failed: ${nifRes.status}`);
      const buf = await nifRes.arrayBuffer();

      // 4. Parse depth field
      const { count, data } = parseNIF(buf);

      // 5. Render
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:100%;height:100%;display:block;touch-action:none';
      this.el.innerHTML = '';
      this.el.appendChild(canvas);

      const r = new EmbedRenderer(canvas);
      r.load(count, data);
      r.start();
      this._renderer = r;

      // 6. Log + license check
      fetch(`${this.api}/nif/${this.nifId}/embed-log`, {
        method: 'POST',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({ origin: ORIGIN, license: this.token }),
      }).then(res => res.ok ? res.json() : { licensed: false })
        .then(({ licensed }) => { if (!licensed) this._showWatermark(); })
        .catch(() => this._showWatermark());

      return { count, vertical: vertical ?? 'generic' };
    }

    _showFallback(meta) {
      // No WebGL2 — show proxy video (H.264) as graceful fallback.
      // Devices without WebGL2 include: old Android WebViews, Safari < 15,
      // and some embedded browsers. They can still watch the video preview.
      const proxyUrl = meta?.proxy_r2_key
        ? null   // need signed URL — can't generate client-side
        : null;

      this.el.style.cssText += ';background:#000;overflow:hidden';
      this.el.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;
          justify-content:center;height:100%;min-height:200px;
          background:#0a0a0b;color:#888;font-size:12px;
          font-family:sans-serif;padding:20px;text-align:center;gap:10px">
          <div style="font-size:28px;opacity:.4">✦</div>
          <div style="color:#e0e0e0;font-size:13px;font-weight:600">
            4D viewer requires a modern browser
          </div>
          <div style="max-width:240px;line-height:1.6">
            Use Chrome, Edge, or Safari 15+ on iOS for the full interactive experience.
          </div>
          <a href="https://fumoca.co.za/view/${this.nifId}"
            style="color:#7b5ef8;font-size:12px;margin-top:4px;
            background:rgba(123,94,248,.1);padding:7px 16px;border-radius:8px;
            text-decoration:none;border:1px solid rgba(123,94,248,.3)">
            View on fumoca.co.za →
          </a>
        </div>`;
    }

    _showWatermark() {
      // Unobtrusive corner watermark — visible but not disruptive
      const wm = document.createElement('a');
      wm.href   = 'https://fumoca.co.za';
      wm.target = '_blank';
      wm.rel    = 'noopener';
      wm.style.cssText = [
        'position:absolute', 'bottom:8px', 'right:8px',
        'background:rgba(0,0,0,0.55)', 'color:#fff',
        'font-size:10px', 'font-family:sans-serif',
        'padding:3px 7px', 'border-radius:4px',
        'text-decoration:none', 'z-index:99',
        'letter-spacing:0.04em', 'pointer-events:auto',
        'backdrop-filter:blur(4px)',
      ].join(';');
      wm.textContent = '✦ NIF · fumoca.co.za';
      // The container element
      const container = this._el?.parentElement ?? document.body;
      if (container.style.position !== 'relative' &&
          container.style.position !== 'absolute') {
        container.style.position = 'relative';
      }
      container.appendChild(wm);
    }

    stop() { this._renderer?.stop(); }

    static mount(elId, opts) {
      const v = new NIFViewer(elId, opts);
      v.load().catch(err => {
        const el = document.getElementById(elId);
        if(el) el.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#888;font-size:12px;font-family:sans-serif;padding:20px;text-align:center">NIF: ${err.message}</div>`;
      });
      return v;
    }

    static autoMount() {
      document.querySelectorAll('[data-nif-id]').forEach(el => {
        const v = new NIFViewer(el, {
          nifId: el.dataset.nifId,
          token: el.dataset.nifToken ?? el.dataset.nifLicense,
          api:   el.dataset.nifApi ?? API,
        });
        v.load().catch(err => {
          el.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#888;font-size:12px;font-family:sans-serif">NIF unavailable</div>`;
        });
      });
    }
  }

  // Expose globally
  global.NIFViewer = NIFViewer;

  // Auto-mount on script load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => NIFViewer.autoMount());
  } else {
    NIFViewer.autoMount();
  }

})(window);
