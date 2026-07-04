# NIF — Neural Interactive Format
### fumoca.co.za · © Fumoca Technologies · Proprietary

NIF turns any capture (video, photo burst, LiDAR, 360°) into an interactive,
shareable, replayable 4D experience. It is a file format, a runtime, and a
platform — not a viewer application.

---

## Architecture

```
.nif binary (portable, lightweight, versioned)
  ├─ 0x0002  PROXY_VIDEO    H.264 preview — plays natively on any device/platform
  ├─ 0x0003  KEYFRAME_GEO   3D depth field (N × 14 float32: pos,scale,rot,opacity,colour)
  ├─ 0x0007  DEPTH_MAP      Per-pixel metric depth float16 HxW (DepthAnything v2)
  ├─ 0x0008  ALPHA_MASK     Foreground alpha uint8 HxW (BiRefNet/rembg)
  ├─ 0x0009  LAYER_GEO      Layered geometry: foreground/midground/background + segments
  ├─ 0x000A  ASSET_REF      External refs: glTF, USD, LAS, video, image (URL + type)
  ├─ 0x0010  SPATIAL_AUDIO  Ambisonics B-format + HRTF positions
  ├─ 0x0011  INTERACTION    Trigger/action graph (clicks, gaze, proximity, time)
  ├─ 0x0013  EDIT_HISTORY   Non-destructive edits (reversible)
  ├─ 0x0014  PRINT_EXPORT   Pre-computed STL for 3D printing
  ├─ 0x0016  SEMANTIC_MAP   Per-point industry labels (BIM, agriculture, etc)
  └─ 0x00FF  WATERMARK      Steganographic ownership mark

NIF Platform (this repo)
  ├── api/                       Express API (Node.js ≥18, ES modules)
  │   ├── index.js               All routes: capture, nif, jobs, print, social, licenses
  │   └── supabase.js            DB helpers, auth, realtime
  ├── core/
  │   ├── format/NIFSpec.js      Binary spec — browser + Node safe (DataView/Uint8Array)
  │   ├── math/NIFMath.js        Complete 4D math: vectors, quaternions, splines,
  │   │                          noise, structural analysis, constraint solver, SDF,
  │   │                          state machine, moment timeline, BRDF, HRTF, SO(3)
  │   ├── physics/NIFPhysics.js  XPBD cloth (bending+shear+self-collision),
  │   │                          rigid body + impulse contact, spring-damper,
  │   │                          BVH Möller-Trumbore, FEM tetrahedral, structural frame
  │   ├── graph/NIFGraph.js      4-layer scene graph: spatial/temporal/semantic/interaction
  │   │                          + plugin registry (architecture/events/commerce/education)
  │   ├── social/NIFSocial.js    Follow, moment reactions, spatial comments,
  │   │                          live presence, co-viewing, highlights, fork
  │   ├── reconstruction/        GPU pipeline (Kaggle T4)
  │   │   ├── pipeline.py        Deblur→Depth→BgRemoval→SAM2→COLMAP→gsplat→Layers→Pack
  │   │   └── requirements.txt   torch, gsplat, rembg, depth-anything-v2, sam2, etc
  │   └── print/                 3D print pipeline
  │       └── NIFPrintPipeline.py  Density field→Marching cubes→Repair→Layers→STL
  ├── viewer/
  │   ├── public/view.html       Complete viewer: proxy→transition→scene, layer UI
  │   └── src/
  │       ├── NIFViewer.js       Load pipeline orchestrator
  │       ├── NIFDeviceTier.js   Benchmark-based budget: LOW/MID/HIGH
  │       ├── NIFFreezeInspect.js Freeze-frame inspection (video/stream/canvas)
  │       ├── sort.worker.js     Off-thread depth sort (zero-copy Transferable)
  │       ├── renderer/          WebGL2 EWA splat renderer, layer selection, parallax
  │       ├── transition/        4-stage solidification (dissociation→nebula→crystallise→solid)
  │       └── preview/           Proxy video player + transition trigger
  ├── dashboard/
  │   ├── index.html             Full dashboard: files, upload, jobs, video editor,
  │   │                          3D print, licenses, revenue, social feed
  │   ├── print.html             3D print export UI (6 templates)
  │   └── video-editor.html      Non-interactive video composer with share guide
  ├── sdk/embed/nif-viewer.js    Self-contained embed (no build tools needed)
  ├── verticals/                 Industry-specific plugin configs
  ├── scripts/
  │   ├── schema.sql             Complete Supabase schema (run once)
  │   ├── kaggle_worker.py       GPU worker polling loop
  │   └── generate-secrets.js   Generate .env secrets
  └── .env.example               All required environment variables
```

---

## Quick Start (30 minutes to live)

### 1. Supabase
- Create project at supabase.com → region: af-south-1
- SQL Editor → run in order: `schema.sql` → `schema_extended.sql` → `schema_social.sql` → `schema_presentations.sql`
- Authentication → Providers → enable Email
- Settings → API → copy URL and anon key

### 2. Cloudflare R2
- dash.cloudflare.com → R2 → Create bucket: `fumoca-nif-storage`
- Manage R2 API Tokens → Create: Account ID, Access Key ID, Secret

### 3. Secrets
```bash
cp .env.example .env
node scripts/generate-secrets.js   # paste output into .env
# Then fill: SUPABASE_URL, SUPABASE_SECRET_KEY, CF_ACCOUNT_ID, R2 keys
```

### 4. API
```bash
npm install && npm run dev          # http://localhost:3001/api/health
```

### 5. Frontend
Deploy `dashboard/`, `viewer/public/`, `sdk/embed/` to Cloudflare Pages.
Update `API` const in view.html and dashboard/index.html to your Railway/VPS URL.

### 6. GPU Worker (Kaggle)
- Upload `core/reconstruction/pipeline.py` as Kaggle dataset `nif-pipeline`
- Add Kaggle secrets (all .env vars)
- Paste `scripts/kaggle_worker.py` into a T4 notebook cell, Run All

---

## API Quick Reference

All write routes: `Authorization: Bearer <supabase-jwt>`
Worker routes: `x-worker-key: <GPU_WORKER_SECRET>`

```
POST  /api/capture/upload              Upload + queue reconstruction
GET   /api/capture/presign             Presigned R2 URL (large files)
GET   /api/nif                         List user NIFs
GET   /api/nif/:id/stream              Signed stream URL
POST  /api/nif/:id/print/request       Request 3D print export
GET   /api/social/feed                 Feed from followed creators
GET   /api/social/trending             Trending NIFs (48h)
POST  /api/nif/:id/reactions           React to a NIF (moment-anchored)
GET   /api/nif/:id/highlights          Crowd-sourced moment highlights
POST  /api/nif/:id/comments            Add spatial+temporal comment
GET   /api/notifications               User notifications
GET   /api/profile/:username           Public profile
POST  /api/nif/:id/fork                Fork/remix a NIF
GET   /api/licenses                    Issued licenses
POST  /api/licenses                    Issue new license
GET   /api/revenue/summary             MRR + projections
```

---

## Embed (one line)

```html
<div data-nif-id="YOUR-UUID" style="width:100%;aspect-ratio:16/9"></div>
<script src="https://fumoca.co.za/viewer/nif-viewer.min.js"></script>
```

---

## Cost at Launch
Supabase Free · Cloudflare Pages Free · Cloudflare R2 R0.015/GB ·
Railway API ~R90/mo · Kaggle GPU Free → **Under R100/month until first paying client**

---

© Fumoca Technologies · fumoca.co.za · All rights reserved
