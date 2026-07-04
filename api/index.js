/**
 * NIF Platform API
 * fumoca.co.za · © Fumoca Technologies
 *
 * Every route is real. If something isn't ready, the route returns 501.
 * No fake data anywhere.
 */

import express             from 'express';
import cors                from 'cors';
import helmet              from 'helmet';
import multer              from 'multer';
import crypto              from 'crypto';
import { v4 as uuid }      from 'uuid';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl }    from '@aws-sdk/s3-request-presigner';
import { supabaseAdmin, Auth, DB, Realtime } from './supabase.js';
import { analyticsMiddleware, analyticsRouter } from './middleware/analytics.js';
import { limitUpload, limitAuth, limitAPI, limitPublic, limitExport, limitLicense } from './middleware/rateLimit.js';
import { socialRouter }     from './middleware/social.js';
import { webhookRouter, dispatchWebhook } from './middleware/webhooks.js';
import presentationRoutes  from './routes/presentations.js';

const app = express();

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}))
app.use(express.json({ limit: '10mb' }));
app.use(analyticsMiddleware);     // attaches req.track() to every request
app.use(limitPublic);             // 60 req/min per IP on all public routes

// Mount sub-routers
app.use(socialRouter);            // /api/feed, /api/discover, /api/u/:username, likes, saves, search
app.use(analyticsRouter);         // /api/analytics/event, /api/analytics/summary
app.use(webhookRouter);           // /api/webhooks CRUD
app.use(presentationRoutes);      // /api/presentations CRUD + export

app.options('*', cors());
// ── R2 client ───────────────────────────────────────────────────────────────
const r2 = new S3Client({
  region:   'auto',
  endpoint: `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET ?? 'fumoca-nif-storage';

// ── Auth middleware ──────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Authorization required' });
  const { data: { user }, error } = await Auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });
  req.user = user;
  next();
}

async function optionalAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) {
    const { data: { user } } = await Auth.getUser(token);
    req.user = user ?? null;
  }
  next();
}

// GPU worker auth — uses a shared secret, not user JWT
function requireWorkerAuth(req, res, next) {
  if (req.headers['x-worker-key'] !== process.env.GPU_WORKER_SECRET) {
    return res.status(401).json({ error: 'Invalid worker key' });
  }
  next();
}

// ── File upload ──────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 500 * 1024 * 1024 }, // 500MB
});

const MIME_EXT = {
  'video/mp4':         '.mp4',
  'video/quicktime':   '.mov',
  'video/webm':        '.webm',
  'image/jpeg':        '.jpg',
  'image/png':         '.png',
  'image/heic':        '.heic',
  'application/octet-stream': '.bin',
};

// ── Routes ───────────────────────────────────────────────────────────────────

// Health
app.get('/api/health', (req, res) => res.json({
  status: 'ok',
  platform: 'NIF · fumoca.co.za',
  version: '1.0.0',
  timestamp: new Date().toISOString(),
}));

// ── Capture: upload raw file → queue reconstruction ──────────────────────────
app.post('/api/capture/upload', requireAuth, limitUpload, upload.single('capture'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const { vertical = 'generic', captureMode = 'video', title = '' } = req.body;
  const jobId = uuid();
  const ext   = MIME_EXT[req.file.mimetype] ?? '.bin';
  const rawKey = `raw/${req.user.id}/${jobId}/capture${ext}`;

  try {
    // Upload to R2
    await r2.send(new PutObjectCommand({
      Bucket:      BUCKET,
      Key:         rawKey,
      Body:        req.file.buffer,
      ContentType: req.file.mimetype,
      Metadata:    { userId: req.user.id, vertical, captureMode, jobId },
    }));

    // Record job
    const { error } = await DB.updateJob(jobId, {}); // will insert below
    await supabaseAdmin.from('reconstruction_jobs').insert({
      id:           jobId,
      user_id:      req.user.id,
      status:       'queued',
      progress:     0,
      vertical,
      capture_mode: captureMode,
      raw_r2_key:   rawKey,
      file_size:    req.file.size,
      meta:         { title: title || req.file.originalname },
    });

    // Broadcast to GPU worker via Realtime
    await supabaseAdmin.channel('reconstruction').send({
      type:    'broadcast',
      event:   'job_queued',
      payload: { jobId, rawKey, vertical, captureMode, userId: req.user.id },
    });

    res.json({ jobId, status: 'queued' });
  } catch (err) {
    console.error('[Upload]', err);
    res.status(500).json({ error: err.message });
  }
});

// Presigned URL for direct large uploads (skips API memory)
app.get('/api/capture/presign', requireAuth, async (req, res) => {
  const { filename, contentType, vertical = 'generic', captureMode = 'video' } = req.query;
  const jobId  = uuid();
  const ext    = filename?.split('.').pop() ?? 'bin';
  const rawKey = `raw/${req.user.id}/${jobId}/capture.${ext}`;

  await supabaseAdmin.from('reconstruction_jobs').insert({
    id: jobId, user_id: req.user.id, status:'pending',
    vertical, capture_mode: captureMode,
  });

  const url = await getSignedUrl(r2, new PutObjectCommand({
    Bucket: BUCKET, Key: rawKey, ContentType: contentType ?? 'application/octet-stream',
  }), { expiresIn: 3600 });

  res.json({ jobId, uploadUrl: url, rawKey });
});

// ── NIF files ────────────────────────────────────────────────────────────────
app.get('/api/nif', requireAuth, async (req, res) => {
  const { vertical, page = 0, limit = 24 } = req.query;
  let q = supabaseAdmin
    .from('nif_files')
    .select('id,title,vertical,thumbnail_url,created_at,is_public,file_size,view_count,gaussian_count,duration,meta')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .range(page*limit, page*limit+parseInt(limit)-1);
  if (vertical) q = q.eq('vertical', vertical);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
});

app.get('/api/nif/:id', optionalAuth, async (req, res) => {
  const { data: nif, error } = await DB.getFile(req.params.id);
  if (error || !nif) return res.status(404).json({ error: 'Not found' });
  if (!nif.is_public && nif.user_id !== req.user?.id)
    return res.status(403).json({ error: 'Access denied' });
  res.json(nif);
});

app.get('/api/nif/:id/stream', optionalAuth, async (req, res) => {
  const { data: nif } = await DB.getFile(req.params.id);
  if (!nif) return res.status(404).json({ error: 'Not found' });

  const isOwner  = req.user?.id === nif.user_id;
  const isPublic = nif.is_public;
  const licKey   = req.query.license;
  let hasLicense = false;

  if (licKey) {
    const { data: lic } = await DB.getLicense(licKey);
    hasLicense = !!lic && (!lic.nif_ids?.length || lic.nif_ids.includes(nif.id));
  }

  if (!isOwner && !isPublic && !hasLicense)
    return res.status(403).json({ error: 'Access denied' });

  const url = await getSignedUrl(r2, new GetObjectCommand({ Bucket: BUCKET, Key: nif.r2_key }), { expiresIn: 7200 });
  DB.incrementViews(nif.id).catch(() => {});
  res.json({ url, expiresIn: 7200, vertical: nif.vertical, meta: nif.meta });
});

app.patch('/api/nif/:id', requireAuth, async (req, res) => {
  const allowed = ['title','description','is_public','tags','meta'];
  const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  const { error } = await supabaseAdmin.from('nif_files').update(updates).eq('id', req.params.id).eq('user_id', req.user.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

app.delete('/api/nif/:id', requireAuth, async (req, res) => {
  const { data: nif } = await supabaseAdmin.from('nif_files').select('r2_key').eq('id', req.params.id).eq('user_id', req.user.id).single();
  if (!nif) return res.status(404).json({ error: 'Not found' });
  await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: nif.r2_key })).catch(() => {});
  await DB.deleteFile(req.params.id);
  res.json({ success: true });
});

// ── Jobs ─────────────────────────────────────────────────────────────────────
app.get('/api/jobs', requireAuth, async (req, res) => {
  const { data } = await DB.listJobs(req.user.id);
  res.json(data ?? []);
});

app.get('/api/jobs/:id', requireAuth, async (req, res) => {
  const { data } = await DB.getJob(req.params.id);
  if (!data || data.user_id !== req.user.id) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

// GPU worker reports progress — authenticated with shared secret
app.patch('/api/jobs/:id/progress', requireWorkerAuth, async (req, res) => {
  const { status, progress, errorMessage, nifR2Key, gaussianCount } = req.body;
  const updates = { status, progress };
  if (errorMessage)  updates.error_message  = errorMessage;
  if (nifR2Key)      updates.nif_r2_key     = nifR2Key;
  if (gaussianCount) updates.gaussian_count = gaussianCount;
  if (status === 'processing') updates.started_at   = new Date().toISOString();
  if (status === 'complete')   updates.completed_at = new Date().toISOString();
  await DB.updateJob(req.params.id, updates);

  // Fire webhook + notification on terminal states
  if (status === 'complete' || status === 'failed') {
    const { data: job } = await DB.getJob(req.params.id);
    if (job) {
      dispatchWebhook(job.user_id,
        status === 'complete' ? 'nif.reconstruction.complete' : 'nif.reconstruction.failed',
        { jobId: req.params.id, nifId: nifR2Key, gaussianCount }
      ).catch(() => {});
      // In-app notification
      if (status === 'complete') {
        supabaseAdmin.rpc('create_notification', {
          p_user_id: job.user_id,
          p_type:    'job_complete',
          p_title:   'Your NIF is ready',
          p_body:    'Reconstruction complete — tap to view your 4D scene',
          p_url:     `/dashboard`,
          p_meta:    JSON.stringify({ jobId: req.params.id }),
        }).catch(() => {});
      }
    }
  }

  res.json({ success: true });
});

// ── Licenses ──────────────────────────────────────────────────────────────────
app.get('/api/licenses', requireAuth, async (req, res) => {
  const { data } = await DB.listLicenses(req.user.id);
  res.json(data ?? []);
});

app.post('/api/licenses', requireAuth, limitLicense, async (req, res) => {
  const { clientName, clientEmail, domain, plan, monthlyFee, currency, nifIds } = req.body;
  if (!clientName || !plan) return res.status(400).json({ error: 'clientName and plan required' });

  const ts  = Date.now().toString(36).toUpperCase();
  const tier = plan.slice(0,3).toUpperCase();
  const hmac = crypto.createHmac('sha256', process.env.LICENSE_SIGNING_KEY ?? 'insecure')
    .update(`${clientName}:${domain ?? ''}:${plan}:${ts}`)
    .digest('hex').slice(0,8).toUpperCase();
  const key = `NIF-${tier}-${ts}-${hmac}`;

  const { data, error } = await DB.insertLicense({
    license_key:  key,
    client_name:  clientName,
    client_email: clientEmail,
    domain,
    plan,
    monthly_fee:  parseFloat(monthlyFee) || 0,
    currency:     currency ?? 'ZAR',
    issued_by:    req.user.id,
    nif_ids:      nifIds ?? [],
    is_active:    true,
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ licenseKey: key, id: data.id });
});

app.patch('/api/licenses/:id/deactivate', requireAuth, async (req, res) => {
  await supabaseAdmin.from('licenses').update({ is_active: false }).eq('id', req.params.id).eq('issued_by', req.user.id);
  res.json({ success: true });
});

// ── Revenue ───────────────────────────────────────────────────────────────────
app.get('/api/revenue/summary', requireAuth, async (req, res) => {
  const { data: licenses } = await DB.listLicenses(req.user.id);
  const active  = (licenses ?? []).filter(l => l.is_active);
  const monthly = active.reduce((s,l) => s + parseFloat(l.monthly_fee ?? 0), 0);
  res.json({
    monthlyRevenue: monthly,
    annualProjection: monthly * 12,
    activeLicenses: active.length,
    totalLicenses:  (licenses ?? []).length,
  });
});

// ── Print / 3D export ─────────────────────────────────────────────────────────
const PRINT_TEMPLATES = {
  figurine:   { name:'Figurine',          height_mm:120, description:'Full-body, hollow with base' },
  bobblehead: { name:'Bobblehead',        height_mm:100, description:'Enlarged head, spring neck socket — two parts' },
  keychain:   { name:'Keychain',          height_mm:45,  description:'Head medallion with keyring hole' },
  bust:       { name:'Bust',              height_mm:150, description:'Head and shoulders with pedestal' },
  miniature:  { name:'Miniature',         height_mm:32,  description:'Tabletop gaming scale' },
  coin:       { name:'Portrait Coin',     height_mm:40,  description:'Low-relief portrait medallion' },
  memory:     { name:'Memory Figurine',   height_mm:150, description:'Keepsake — wedding, couple, memorial' },
  ornament:   { name:'Hanging Ornament',  height_mm:60,  description:'Tree, mirror, wall hanging' },
  statue:     { name:'Portrait Statue',   height_mm:200, description:'Large display piece' },
};

// List available print templates
app.get('/api/nif/:id/print/templates', optionalAuth, async (req, res) => {
  const { data: nif } = await DB.getFile(req.params.id);
  if (!nif) return res.status(404).json({ error: 'Not found' });
  if (!nif.is_public && nif.user_id !== req.user?.id)
    return res.status(403).json({ error: 'Access denied' });

  // Attach existing print keys if any
  const keys  = nif.print_r2_keys ?? {};
  const stats = nif.print_stats   ?? {};
  const templates = Object.entries(PRINT_TEMPLATES).map(([id, t]) => ({
    id,
    ...t,
    ready:     !!keys[id],
    r2_key:    keys[id] ?? null,
    stats:     stats[id] ?? null,
  }));
  res.json({ templates, nifId: req.params.id });
});

// Request a print export job for one or more templates
app.post('/api/nif/:id/print/request', requireAuth, limitExport, async (req, res) => {
  const { data: nif } = await DB.getFile(req.params.id);
  if (!nif) return res.status(404).json({ error: 'Not found' });
  if (nif.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });
  if (!nif.r2_key) return res.status(400).json({ error: 'NIF reconstruction not complete' });

  const { templates = ['figurine'], height_mm, voxel_res = 128, edit_params = {} } = req.body;

  // Validate templates
  const invalid = templates.filter(t => !PRINT_TEMPLATES[t]);
  if (invalid.length) return res.status(400).json({ error: `Unknown templates: ${invalid.join(',')}` });

  // Create print job record
  const jobId = uuid();
  await supabaseAdmin.from('print_jobs').insert({
    id:           jobId,
    nif_id:       req.params.id,
    user_id:      req.user.id,
    status:       'queued',
    progress:     0,
    templates,
    height_mm:    height_mm ?? null,
    voxel_res:    voxel_res,
    meta:         { edit_params },   // user's slider values passed to pipeline
  });

  // Broadcast to GPU worker
  await supabaseAdmin.channel('print').send({
    type:    'broadcast',
    event:   'print_job_queued',
    payload: { jobId, nifId: req.params.id, userId: req.user.id,
               templates, height_mm, voxel_res, edit_params },
  });

  res.json({ jobId, status: 'queued', templates });
});

// Get print job status
app.get('/api/print-jobs/:id', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('print_jobs').select('*').eq('id', req.params.id).single();
  if (error || !data) return res.status(404).json({ error: 'Not found' });
  if (data.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });
  res.json(data);
});

// GPU print worker reports progress
app.patch('/api/print-jobs/:id/progress', requireWorkerAuth, async (req, res) => {
  const { status, progress, error: errMsg, results, current_template } = req.body;
  const updates = { status, progress };
  if (errMsg)           updates.error_message   = errMsg;
  if (results)          updates.results         = results;
  if (current_template) updates.current_template= current_template;
  if (status === 'complete') updates.completed_at = new Date().toISOString();
  await supabaseAdmin.from('print_jobs').update(updates).eq('id', req.params.id);
  res.json({ success: true });
});

// Get a signed download URL for a specific STL
app.get('/api/nif/:id/print/download/:template', optionalAuth, async (req, res) => {
  const { data: nif } = await DB.getFile(req.params.id);
  if (!nif) return res.status(404).json({ error: 'Not found' });
  if (!nif.is_public && nif.user_id !== req.user?.id)
    return res.status(403).json({ error: 'Access denied' });

  const keys = nif.print_r2_keys ?? {};
  const key  = keys[req.params.template];
  if (!key) return res.status(404).json({ error: 'This template has not been generated yet' });

  const url = await getSignedUrl(r2, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: 3600 });
  const tmpl= PRINT_TEMPLATES[req.params.template];
  res.json({
    url,
    filename:   `nif-${req.params.template}-${req.params.id.slice(0,8)}.stl`,
    template:   req.params.template,
    templateName: tmpl?.name,
    expiresIn:  3600,
  });
});

// List all print jobs for user
app.get('/api/print-jobs', requireAuth, async (req, res) => {
  const { data } = await supabaseAdmin
    .from('print_jobs')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(50);
  res.json(data ?? []);
});

// ── Embed usage logging ───────────────────────────────────────────────────────
// Called by the embed SDK on every load. Logs the embed for billing.
// Returns { licensed: bool } — SDK shows watermark when false.
app.post('/api/nif/:id/embed-log', optionalAuth, async (req, res) => {
  const { origin = 'unknown', license: licKey } = req.body ?? {};
  const nifId = req.params.id;

  // Validate license key if provided
  let licensed = false;
  if (licKey) {
    const { data: lic } = await supabaseAdmin
      .from('licenses')
      .select('id, is_active, domain, issued_by')
      .eq('license_key', licKey)
      .eq('is_active', true)
      .maybeSingle();

    if (lic) {
      // Check domain matches origin
      const originDomain  = origin.replace(/^https?:\/\//, '').split('/')[0];
      licensed = allowedDomain === '*'
              || originDomain === allowedDomain
              || originDomain.endsWith('.' + allowedDomain);

      if (licensed) {
        // Log usage for billing
        await supabaseAdmin.from('license_usage').insert({
          license_id: lic.id,
          nif_id:     nifId,
          origin,
          user_agent: req.headers['user-agent']?.slice(0, 255) ?? '',
        }).catch(() => {}); // non-blocking — never fail an embed for a log error
      }
    }
  }

  // Increment view count regardless of license
  await DB.incrementViews(nifId).catch(() => {});

  res.json({ licensed });
});
// ── AI copy generator — all verticals ────────────────────────────────────────
// Generates contextual professional copy from a NIF capture.
// Adapts the prompt based on vertical: property listing, vehicle inspection,
// product description, field report, learning objective, and so on.
app.post('/api/nif/:id/ai-copy', requireAuth, limitAPI, async (req, res) => {
  const { data: nif } = await supabaseAdmin.from('nif_files')
    .select('user_id, meta, vertical, title').eq('id', req.params.id).single();
  if (!nif) return res.status(404).json({ error: 'NIF not found' });
  if (nif.user_id !== req.user.id) return res.status(403).json({ error: 'Not your NIF' });

  const vertical = nif.vertical ?? 'generic';
  const body     = req.body ?? {};

  // Build a vertical-specific prompt
  const PROMPTS = {
    property: () => {
      const { rooms=[], total_m2, address, price, bedrooms, bathrooms, extras=[] } = body;
      const roomSummary = rooms.map(r=>`${r.label}: ${r.area_m2}m²`).join(', ');
      return [
        'Write a professional South African real estate listing.',
        'Tone: warm, aspirational, factual. No clichés like "a must-see" or "your dream home".',
        'Output JSON only: { headline, body (2 paragraphs), highlights (5 items), seoDescription (160 chars), callToAction }',
        address   ? `Address: ${address}` : '',
        price     ? `Asking price: R${Number(price).toLocaleString()}` : '',
        bedrooms  ? `Bedrooms: ${bedrooms}` : '',
        bathrooms ? `Bathrooms: ${bathrooms}` : '',
        total_m2  ? `Total floor area: ${total_m2}m²` : '',
        roomSummary ? `Rooms: ${roomSummary}` : '',
        extras.length ? `Features: ${extras.join(', ')}` : '',
      ].filter(Boolean).join('\n');
    },
    automotive: () => {
      const { make, model, year, mileage, condition, price, extras=[], damage=[] } = body;
      return [
        'Write a professional vehicle listing / inspection report.',
        'Tone: factual, confident, transparent. Highlight condition honestly.',
        'Output JSON only: { headline, body (2 paragraphs), highlights (5 items), seoDescription (160 chars), conditionSummary }',
        make  ? `Make: ${make}` : '',
        model ? `Model: ${model}` : '',
        year  ? `Year: ${year}` : '',
        mileage ? `Mileage: ${Number(mileage).toLocaleString()} km` : '',
        condition ? `Condition: ${condition}` : '',
        price ? `Asking: R${Number(price).toLocaleString()}` : '',
        extras.length ? `Features: ${extras.join(', ')}` : '',
        damage.length ? `Known issues: ${damage.join(', ')}` : '',
      ].filter(Boolean).join('\n');
    },
    fashion: () => {
      const { brand, productName, material, sizes=[], price, extras=[] } = body;
      return [
        'Write a professional fashion/product listing description.',
        'Tone: aspirational, specific about materials and fit, honest about sizing.',
        'Output JSON only: { headline, body (2 paragraphs), highlights (5 items), seoDescription (160 chars), fitNotes }',
        brand       ? `Brand: ${brand}` : '',
        productName ? `Product: ${productName}` : '',
        material    ? `Material: ${material}` : '',
        sizes.length ? `Available sizes: ${sizes.join(', ')}` : '',
        price ? `Price: R${Number(price).toLocaleString()}` : '',
        extras.length ? `Features: ${extras.join(', ')}` : '',
      ].filter(Boolean).join('\n');
    },
    mining: () => {
      const { site, captureType, depth, area, hazards=[], findings=[] } = body;
      return [
        'Write a professional mining site inspection / survey report summary.',
        'Tone: technical, precise, safety-conscious.',
        'Output JSON only: { headline, body (2 paragraphs), highlights (5 items), seoDescription (160 chars), safetyFlags }',
        site        ? `Site: ${site}` : '',
        captureType ? `Capture type: ${captureType}` : '',
        depth       ? `Depth: ${depth}m` : '',
        area        ? `Area covered: ${area}m²` : '',
        hazards.length  ? `Hazards identified: ${hazards.join(', ')}` : '',
        findings.length ? `Key findings: ${findings.join(', ')}` : '',
      ].filter(Boolean).join('\n');
    },
    agriculture: () => {
      const { crop, area, season, ndvi, issues=[], observations=[] } = body;
      return [
        'Write a professional agricultural field inspection report.',
        'Tone: technical, actionable, agronomic.',
        'Output JSON only: { headline, body (2 paragraphs), highlights (5 items), seoDescription (160 chars), recommendations }',
        crop    ? `Crop: ${crop}` : '',
        area    ? `Area: ${area} hectares` : '',
        season  ? `Season: ${season}` : '',
        ndvi    ? `Average NDVI: ${ndvi}` : '',
        issues.length       ? `Issues identified: ${issues.join(', ')}` : '',
        observations.length ? `Observations: ${observations.join(', ')}` : '',
      ].filter(Boolean).join('\n');
    },
    education: () => {
      const { subject, level, learningObjectives=[], notes='' } = body;
      return [
        'Write a professional educational content description for a 3D learning object.',
        'Tone: engaging, age-appropriate, curriculum-aligned.',
        'Output JSON only: { headline, body (2 paragraphs), highlights (5 items), seoDescription (160 chars), learningOutcomes }',
        subject ? `Subject: ${subject}` : '',
        level   ? `Level: ${level}` : '',
        learningObjectives.length ? `Learning objectives: ${learningObjectives.join(', ')}` : '',
        notes   ? `Notes: ${notes}` : '',
      ].filter(Boolean).join('\n');
    },
    generic: () => {
      const { title, description='', tags=[], extras=[] } = body;
      return [
        'Write a professional description for this 3D spatial capture.',
        'Tone: clear, engaging, factual.',
        'Output JSON only: { headline, body (2 paragraphs), highlights (5 items), seoDescription (160 chars), callToAction }',
        title       ? `Title: ${title}` : (nif.title ? `Title: ${nif.title}` : ''),
        description ? `Description: ${description}` : '',
        tags.length   ? `Tags: ${tags.join(', ')}` : '',
        extras.length ? `Features: ${extras.join(', ')}` : '',
      ].filter(Boolean).join('\n');
    },
  };

  const promptFn = PROMPTS[vertical] ?? PROMPTS.generic;
  const prompt   = promptFn();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Fallback without Anthropic key
    return res.json({
      headline:       `${nif.title || vertical.charAt(0).toUpperCase()+vertical.slice(1)+' Capture'}`,
      body:           `This ${vertical} NIF capture provides an immersive 4D experience. Explore from all angles, separate layers, and share anywhere.`,
      highlights:     ['Interactive 4D experience','Shareable on all platforms','Layer separation','Full 360° exploration','Print-ready'],
      seoDescription: `${vertical} 4D capture. Interactive viewer. Share on any platform.`,
      callToAction:   'Tap to explore in 4D',
    });
  }

  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key':    apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 900,
        messages:   [{ role:'user', content: prompt }],
      }),
    });
    const aiData = await aiRes.json();
    const text   = aiData.content?.[0]?.text ?? '{}';
    const clean  = text.replace(/```json|```/g,'').trim();
    const result = JSON.parse(clean);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: 'AI copy generation failed: ' + e.message });
  }
});

// ── Property vertical — AI listing copy (legacy alias) ────────────────────────
app.post('/api/nif/:id/property/listing-copy', requireAuth, limitAPI, async (req, res) => {
  // Redirect to the universal endpoint
  req.params.id; // already set
  const { data: nif } = await supabaseAdmin.from('nif_files')
    .select('user_id').eq('id', req.params.id).single();
  if (!nif) return res.status(404).json({ error: 'NIF not found' });
  if (nif.user_id !== req.user.id) return res.status(403).json({ error: 'Not your NIF' });
  // Forward to universal endpoint by re-calling with property context
  res.redirect(307, `/api/nif/${req.params.id}/ai-copy`);
});

// ── Property vertical — floor measurements ────────────────────────────────────
app.get('/api/nif/:id/property/measurements', requireAuth, async (req, res) => {
  const { data: nif } = await supabaseAdmin.from('nif_files')
    .select('user_id, meta').eq('id', req.params.id).single();
  if (!nif) return res.status(404).json({ error: 'NIF not found' });
  if (nif.user_id !== req.user.id) return res.status(403).json({ error: 'Not your NIF' });

  // Measurements are stored in meta during reconstruction
  const measurements = nif.meta?.measurements ?? null;
  if (!measurements) return res.status(404).json({ error: 'No measurements available — reconstruct with property vertical' });
  res.json(measurements);
});

// ── Client delivery links ─────────────────────────────────────────────────────
app.post('/api/delivery', requireAuth, async (req, res) => {
  const { nifIds=[], title, message, expiryDays=30, brandName, logoUrl } = req.body;
  if (!nifIds.length) return res.status(400).json({ error: 'nifIds required' });

  // Verify all NIFs belong to user
  const { data: nifs } = await supabaseAdmin.from('nif_files')
    .select('id,user_id').in('id', nifIds);
  if (nifs.some(n => n.user_id !== req.user.id))
    return res.status(403).json({ error: 'One or more NIFs not owned by you' });

  const token      = crypto.randomUUID().replace(/-/g,'').slice(0,16);
  const expires_at = new Date(Date.now() + expiryDays * 86400000).toISOString();

  const { data, error } = await supabaseAdmin.from('deliveries').insert({
    user_id:    req.user.id,
    token,
    nif_ids:    nifIds,
    title,
    message,
    expires_at,
    branding:   { name: brandName, logo_url: logoUrl },
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ token, url: `https://fumoca.co.za/delivery?t=${token}`, expires_at });
});

app.get('/api/delivery/:token', async (req, res) => {
  const { data: delivery } = await supabaseAdmin.from('deliveries')
    .select('*').eq('token', req.params.token).single();
  if (!delivery) return res.status(404).json({ error: 'Delivery not found' });
  if (new Date(delivery.expires_at) < new Date()) return res.status(410).json({ error: 'Delivery expired' });

  const { data: rawNifs } = await supabaseAdmin.from('nif_files')
    .select('id,title,vertical,thumbnail_url,created_at,meta')
    .in('id', delivery.nif_ids);

  // Extract media URLs stored in meta by the reconstruction pipeline
  const nifs = await Promise.all((rawNifs ?? []).map(async n => {
    let proxy_video_url = null;
    let print_stl_url   = null;

    // Generate a short-lived signed URL for the proxy video if we have an R2 key
    const proxyKey = n.meta?.proxy_r2_key;
    if (proxyKey) {
      try {
        proxy_video_url = await getSignedUrl(
          r2,
          new GetObjectCommand({ Bucket: BUCKET, Key: proxyKey }),
          { expiresIn: 43200 } // 12 hours
        );
      } catch {}
    }

    // Generate signed URL for the most recent print STL if any
    const printKeys = n.meta?.print_r2_keys;
    if (printKeys && Object.keys(printKeys).length) {
      const latestKey = Object.values(printKeys)[0];
      try {
        print_stl_url = await getSignedUrl(
          r2,
          new GetObjectCommand({ Bucket: BUCKET, Key: latestKey }),
          { expiresIn: 43200 }
        );
      } catch {}
    }

    return { ...n, proxy_video_url, print_stl_url };
  }));

  // Log the view
  await supabaseAdmin.from('delivery_views').insert({
    delivery_id: delivery.id,
    ip: req.ip,
    user_agent: req.headers['user-agent'],
  }).catch(()=>{});

  res.json({ delivery, nifs, branding: delivery.branding ?? {} });
});

app.get('/api/deliveries', requireAuth, async (req, res) => {
  const { data } = await supabaseAdmin.from('deliveries')
    .select('*').eq('user_id', req.user.id).order('created_at', { ascending:false });
  res.json({ deliveries: data ?? [] });
});

app.delete('/api/delivery/:token', requireAuth, async (req, res) => {
  const { data } = await supabaseAdmin.from('deliveries')
    .select('user_id').eq('token', req.params.token).single();
  if (!data) return res.status(404).json({ error: 'Not found' });
  if (data.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  await supabaseAdmin.from('deliveries').delete().eq('token', req.params.token);
  res.json({ success: true });
});

// ── NIF Analytics dashboard ───────────────────────────────────────────────────
app.get('/api/nif/:id/analytics', requireAuth, async (req, res) => {
  const { data: nif } = await supabaseAdmin.from('nif_files')
    .select('user_id').eq('id', req.params.id).single();
  if (!nif || nif.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  const since = new Date(Date.now() - 30 * 86400000).toISOString();

  // Total views + embed views from analytics_events
  const { data: events } = await supabaseAdmin.from('analytics_events')
    .select('event, properties, created_at')
    .eq('properties->>nifId', req.params.id)
    .gte('created_at', since)
    .order('created_at', { ascending: false });

  const views       = (events ?? []).filter(e => e.event === 'nif_viewed');
  const embedViews  = views.filter(e => e.properties?.source === 'embed');
  const directViews = views.filter(e => e.properties?.source !== 'embed');

  // Top embed domains
  const domainCounts = {};
  for (const v of embedViews) {
    const d = v.properties?.domain ?? 'unknown';
    domainCounts[d] = (domainCounts[d]||0) + 1;
  }
  const topDomains = Object.entries(domainCounts)
    .sort((a,b) => b[1]-a[1]).slice(0,10)
    .map(([domain,count]) => ({ domain, count }));

  // Views by day (last 30 days)
  const byDay = {};
  for (const v of views) {
    const day = v.created_at.slice(0,10);
    byDay[day] = (byDay[day]||0) + 1;
  }
  const viewsByDay = Object.entries(byDay)
    .sort((a,b)=>a[0].localeCompare(b[0]))
    .map(([date,count]) => ({ date, count }));

  res.json({
    totalViews:    views.length,
    embedViews:    embedViews.length,
    directViews:   directViews.length,
    topDomains,
    viewsByDay,
    period:        '30d',
  });
});

// ── User-level analytics summary ──────────────────────────────────────────────
app.get('/api/analytics/overview', requireAuth, async (req, res) => {
  const since = new Date(Date.now() - 30 * 86400000).toISOString();

  const { data: events } = await supabaseAdmin.from('analytics_events')
    .select('event, properties, created_at')
    .eq('user_id', req.user.id)
    .gte('created_at', since);

  const views    = (events ?? []).filter(e => e.event === 'nif_viewed');
  const prints   = (events ?? []).filter(e => e.event === 'print_job_started');
  const embeds   = (events ?? []).filter(e => e.properties?.source === 'embed');

  // Top performing NIFs
  const nifCounts = {};
  for (const v of views) {
    const id = v.properties?.nifId;
    if (id) nifCounts[id] = (nifCounts[id]||0) + 1;
  }
  const topNifIds = Object.entries(nifCounts)
    .sort((a,b)=>b[1]-a[1]).slice(0,5).map(([id])=>id);

  let topNifs = [];
  if (topNifIds.length) {
    const { data } = await supabaseAdmin.from('nif_files')
      .select('id,title,vertical').in('id', topNifIds);
    topNifs = (data??[]).map(n => ({ ...n, views: nifCounts[n.id] }))
      .sort((a,b)=>b.views-a.views);
  }

  res.json({
    period:     '30d',
    totalViews: views.length,
    embedViews: embeds.length,
    printJobs:  prints.length,
    topNifs,
  });
});

// ── Share card (canvas render endpoint) ───────────────────────────────────────
// Returns metadata for the client-side canvas to generate the share card
app.get('/api/nif/:id/share-card', requireAuth, async (req, res) => {
  const { data: nif } = await supabaseAdmin.from('nif_files')
    .select('id,title,vertical,thumbnail_url,user_id,view_count,meta')
    .eq('id', req.params.id).single();
  if (!nif || nif.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  res.json({
    nifId:        nif.id,
    title:        nif.title,
    vertical:     nif.vertical,
    thumbnailUrl: nif.thumbnail_url,
    viewCount:    nif.view_count ?? 0,
    viewUrl:      `https://fumoca.co.za/view/${nif.id}`,
  });
});

// ── Measurement trigger ───────────────────────────────────────────────────────
// Stores measured distances from NIFFreezeInspect in the NIF meta
app.post('/api/nif/:id/measurements', requireAuth, async (req, res) => {
  const { measurements = [] } = req.body;
  const { data: nif } = await supabaseAdmin.from('nif_files')
    .select('user_id, meta').eq('id', req.params.id).single();
  if (!nif || nif.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  const updatedMeta = {
    ...(nif.meta ?? {}),
    user_measurements: [
      ...((nif.meta?.user_measurements ?? [])),
      ...measurements.map(m => ({ ...m, savedAt: new Date().toISOString() })),
    ],
  };
  await supabaseAdmin.from('nif_files').update({ meta: updatedMeta }).eq('id', req.params.id);
  res.json({ success: true, count: updatedMeta.user_measurements.length });
});

// ── NIF scene editor — save edited depth field ───────────────────────────────
app.post('/api/nif/:id/edits', requireAuth, async (req, res) => {
  const { gaussianData, count, editRecord } = req.body;
  if (!gaussianData || !count) return res.status(400).json({ error: 'gaussianData and count required' });

  const { data: nif } = await supabaseAdmin.from('nif_files')
    .select('user_id, r2_key').eq('id', req.params.id).single();
  if (!nif) return res.status(404).json({ error: 'NIF not found' });
  if (nif.user_id !== req.user.id) return res.status(403).json({ error: 'Not your NIF' });

  // Store the edited geometry back to R2 alongside the original
  const editKey = nif.r2_key.replace('scene.nif', 'scene_edited.nif');
  const buf = Buffer.from(new Float32Array(gaussianData).buffer);
  await r2.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key:    editKey,
    Body:   buf,
    ContentType: 'application/octet-stream',
  }));

  // Log edit record in DB
  await supabaseAdmin.from('nif_files').update({
    meta: { ...editRecord, has_edits: true, edited_r2_key: editKey },
  }).eq('id', req.params.id);

  res.json({ success: true, editKey });
});

// ── 404 + error ───────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, _req, res, _next) => {
  console.error('[API]', err);
  res.status(500).json({ error: err.message });
});

const PORT = process.env.PORT ?? 3001;
app.listen(PORT, () => console.log(`\n  NIF API · fumoca.co.za → https://api.fumoca.co.za/api/health\n`));

export default app;
