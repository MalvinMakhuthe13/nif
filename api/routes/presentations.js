/**
 * NIF Presentation API Routes
 * fumoca.co.za · © Fumoca Technologies
 *
 * Mount into the main API with:
 *   import presentationRoutes from './routes/presentations.js';
 *   app.use(presentationRoutes);
 *
 * Routes:
 *   GET    /api/presentations                     list user's presentations
 *   POST   /api/presentations                     create new presentation
 *   GET    /api/presentations/:id                 get presentation
 *   PATCH  /api/presentations/:id                 update presentation
 *   DELETE /api/presentations/:id                 delete presentation
 *   POST   /api/presentations/:id/export/upload   receive client-encoded MP4 → R2
 *   POST   /api/presentations/:id/export/frames   receive JPEG frames → assemble server-side
 *   POST   /api/presentations/:id/export/assemble trigger server-side ffmpeg assembly
 *   GET    /api/presentations/:id/export/download get signed download URL for exported video
 */

import express    from 'express';
import multer     from 'multer';
import { v4 as uuid } from 'uuid';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { exec }   from 'child_process';
import { promisify } from 'util';
import fs         from 'fs/promises';
import path       from 'path';
import os         from 'os';
import { supabaseAdmin, Auth, DB } from '../supabase.js';

const execAsync = promisify(exec);
const router    = express.Router();

// ── R2 client (shared config from env) ───────────────────────────────────────
const r2 = new S3Client({
  region:   'auto',
  endpoint: `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});
const BUCKET = process.env.R2_BUCKET ?? 'fumoca-nif-storage';

// ── Auth middleware (copied from index.js — consider extracting to shared) ────
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Authorization required' });
  const { data: { user }, error } = await Auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });
  req.user = user;
  next();
}

// ── File upload (video) ───────────────────────────────────────────────────────
const videoUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 2 * 1024 * 1024 * 1024 }, // 2 GB
  fileFilter: (_req, file, cb) => {
    const okVideo = ['video/mp4','video/quicktime','video/webm','application/octet-stream'];
    const okAudio = ['audio/wav','audio/wave','audio/x-wav','audio/mpeg','audio/ogg'];
    cb(null, okVideo.includes(file.mimetype) || okAudio.includes(file.mimetype) ||
             file.originalname?.match(/\.(mp4|wav|mp3|ogg)$/i));
  },
});

// ── Routes ────────────────────────────────────────────────────────────────────

// List presentations (optionally filtered by nifId)
router.get('/api/presentations', requireAuth, async (req, res) => {
  const { nifId, limit = 20, page = 0 } = req.query;
  let q = supabaseAdmin
    .from('presentations')
    .select(`
      id, nif_id, title, duration, fps, loop_type,
      bg_color, bg_opacity, logo_url, logo_position, show_watermark,
      camera_path, hotspots, share_url,
      exported_video_r2_key, exported_video_url,
      created_at, updated_at
    `)
    .eq('user_id', req.user.id)
    .order('updated_at', { ascending: false })
    .range(page * limit, page * limit + parseInt(limit) - 1);

  if (nifId) q = q.eq('nif_id', nifId);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
});

// Get single presentation
router.get('/api/presentations/:id', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('presentations')
    .select('*')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .single();
  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

// Create presentation
router.post('/api/presentations', requireAuth, async (req, res) => {
  const {
    nifId, title, duration, fps, loopType,
    bgColor, bgOpacity, logoUrl, logoPosition, showWatermark,
    cameraPath, hotspots, shareUrl,
  } = req.body;

  if (!nifId) return res.status(400).json({ error: 'nifId required' });

  // Verify the NIF belongs to this user
  const { data: nif } = await supabaseAdmin
    .from('nif_files').select('id').eq('id', nifId).eq('user_id', req.user.id).single();
  if (!nif) return res.status(403).json({ error: 'NIF not found or access denied' });

  const { data, error } = await supabaseAdmin
    .from('presentations')
    .insert({
      id:            uuid(),
      user_id:       req.user.id,
      nif_id:        nifId,
      title:         title         ?? 'Untitled Presentation',
      duration:      duration      ?? 10,
      fps:           fps           ?? 30,
      loop_type:     loopType      ?? 'pingpong',
      bg_color:      bgColor       ?? '#000000',
      bg_opacity:    bgOpacity     ?? 1.0,
      logo_url:      logoUrl       ?? null,
      logo_position: logoPosition  ?? 'bottom-right',
      show_watermark:showWatermark ?? true,
      camera_path:   cameraPath    ?? null,
      hotspots:      hotspots      ?? [],
      share_url:     shareUrl      ?? null,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Update presentation
router.patch('/api/presentations/:id', requireAuth, async (req, res) => {
  const allowed = [
    'title','duration','fps','loop_type','bg_color','bg_opacity',
    'logo_url','logo_position','show_watermark','camera_path','hotspots',
    'share_url','exported_video_r2_key','exported_video_url',
  ];

  // Map camelCase from client to snake_case
  const camelToSnake = {
    loopType:           'loop_type',
    bgColor:            'bg_color',
    bgOpacity:          'bg_opacity',
    logoUrl:            'logo_url',
    logoPosition:       'logo_position',
    showWatermark:      'show_watermark',
    cameraPath:         'camera_path',
    shareUrl:           'share_url',
    exportedVideoR2Key: 'exported_video_r2_key',
    exportedVideoUrl:   'exported_video_url',
  };

  const updates = {};
  for (const [k, v] of Object.entries(req.body)) {
    const col = camelToSnake[k] ?? k;
    if (allowed.includes(col)) updates[col] = v;
  }
  updates.updated_at = new Date().toISOString();

  const { error } = await supabaseAdmin
    .from('presentations')
    .update(updates)
    .eq('id', req.params.id)
    .eq('user_id', req.user.id);

  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

// Delete presentation + its R2 video
router.delete('/api/presentations/:id', requireAuth, async (req, res) => {
  const { data: p } = await supabaseAdmin
    .from('presentations').select('exported_video_r2_key')
    .eq('id', req.params.id).eq('user_id', req.user.id).single();
  if (!p) return res.status(404).json({ error: 'Not found' });

  if (p.exported_video_r2_key) {
    await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: p.exported_video_r2_key }))
      .catch(() => {});
  }
  await supabaseAdmin.from('presentations').delete().eq('id', req.params.id);
  res.json({ success: true });
});

// ── Export: receive client-encoded MP4 ───────────────────────────────────────
router.post(
  '/api/presentations/:id/export/upload',
  requireAuth,
  videoUpload.fields([{ name: 'video', maxCount: 1 }, { name: 'audio', maxCount: 1 }]),
  async (req, res) => {
    const videoFile = req.files?.['video']?.[0];
    const audioFile = req.files?.['audio']?.[0];
    if (!videoFile) return res.status(400).json({ error: 'No video file received' });

    const { nifId, duration, fps, width, height, loopType } = req.body;
    const pId    = req.params.id;
    const r2Key  = `presentations/${req.user.id}/${pId}/export-${Date.now()}.mp4`;

    // Upload video to R2
    await r2.send(new PutObjectCommand({
      Bucket:      BUCKET,
      Key:         r2Key,
      Body:        videoFile.buffer,
      ContentType: 'video/mp4',
      Metadata: {
        userId:       req.user.id,
        presentationId: pId,
        nifId:        nifId ?? '',
        duration:     duration ?? '',
        fps:          fps ?? '',
        width:        width ?? '',
        height:       height ?? '',
      },
    }));

    // Upload audio to R2 if present
    let audioR2Key = null;
    if (audioFile) {
      audioR2Key = `presentations/${req.user.id}/${pId}/audio-${Date.now()}.wav`;
      await r2.send(new PutObjectCommand({
        Bucket:      BUCKET,
        Key:         audioR2Key,
        Body:        audioFile.buffer,
        ContentType: 'audio/wav',
      }));
    }

    // Get 24h signed download URL with proper filename
    const safeTitle = ((req.body.title ?? 'nif-presentation')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50))
      || pId.slice(0, 8);
    const videoFilename = `${safeTitle}.mp4`;

    const downloadUrl = await getSignedUrl(
      r2,
      new GetObjectCommand({
        Bucket: BUCKET,
        Key:    r2Key,
        ResponseContentDisposition: `attachment; filename="${videoFilename}"`,
        ResponseContentType:        'video/mp4',
      }),
      { expiresIn: 86400 }
    );

    // Update presentation record
    const updateData = {
      exported_video_r2_key: r2Key,
      exported_video_url:    downloadUrl,
      updated_at:            new Date().toISOString(),
    };
    if (audioR2Key) updateData.exported_audio_r2_key = audioR2Key;

    await supabaseAdmin
      .from('presentations')
      .update(updateData)
      .eq('id', pId)
      .eq('user_id', req.user.id);

    res.json({ r2Key, downloadUrl, audioR2Key });
  }
);

// ── Export: receive JPEG frames for server-side assembly ─────────────────────
// Used as fallback when client doesn't support WebCodecs (Firefox / Safari)
router.post('/api/presentations/:id/export/frames', requireAuth, async (req, res) => {
  const { frames, lastFrame, totalFrames } = req.body;
  if (!Array.isArray(frames) || !frames.length) {
    return res.status(400).json({ error: 'frames array required' });
  }

  const pId     = req.params.id;
  const tmpDir  = path.join(os.tmpdir(), `nif_frames_${pId}`);
  await fs.mkdir(tmpDir, { recursive: true });

  // Write frames to temp dir
  const startIdx = lastFrame - frames.length + 1;
  await Promise.all(frames.map(async (b64, i) => {
    const frameNum = String(startIdx + i).padStart(6, '0');
    const buf      = Buffer.from(b64, 'base64');
    await fs.writeFile(path.join(tmpDir, `frame_${frameNum}.jpg`), buf);
  }));

  // Track progress in DB
  const pct = Math.round((lastFrame / totalFrames) * 100);
  await supabaseAdmin
    .from('presentations')
    .update({ meta: { frameProgress: pct } })
    .eq('id', pId).eq('user_id', req.user.id);

  res.json({ received: frames.length, progress: pct });
});

// ── Export: assemble frames into MP4 with ffmpeg ──────────────────────────────
router.post('/api/presentations/:id/export/assemble', requireAuth, async (req, res) => {
  const { fps = 30, width = 1920, height = 1080, loopType = 'pingpong' } = req.body;
  const pId    = req.params.id;
  const tmpDir = path.join(os.tmpdir(), `nif_frames_${pId}`);

  // Verify frames exist
  let frameFiles;
  try {
    frameFiles = (await fs.readdir(tmpDir)).filter(f => f.endsWith('.jpg')).sort();
  } catch {
    return res.status(400).json({ error: 'No frames found — did frame upload complete?' });
  }

  if (!frameFiles.length) {
    return res.status(400).json({ error: 'No frames found' });
  }

  const outPath = path.join(os.tmpdir(), `nif_export_${pId}_${Date.now()}.mp4`);

  try {
    // Build ffmpeg command
    let ffmpegCmd;

    if (loopType === 'pingpong') {
      // Create reversed copy and concatenate
      const reverseList = path.join(tmpDir, 'reverse.txt');
      const fwd = `file '${tmpDir}/frame_%06d.jpg'\n`.repeat(1);
      const rev = [...frameFiles].reverse().map(f => `file '${tmpDir}/${f}'`).join('\n');
      await fs.writeFile(reverseList, rev);

      ffmpegCmd = [
        'ffmpeg -y',
        `-framerate ${fps} -i '${tmpDir}/frame_%06d.jpg'`,
        `-framerate ${fps} -f concat -safe 0 -i '${reverseList}'`,
        '-filter_complex "[0:v][1:v]concat=n=2:v=1[out]" -map "[out]"',
        `-vf scale=${width}:${height}`,
        `-c:v libx264 -crf 18 -preset slow -movflags +faststart`,
        `-pix_fmt yuv420p '${outPath}'`,
      ].join(' ');
    } else if (loopType === 'loop') {
      ffmpegCmd = [
        'ffmpeg -y',
        `-framerate ${fps} -i '${tmpDir}/frame_%06d.jpg'`,
        `-vf scale=${width}:${height},loop=5:${frameFiles.length}`,
        `-c:v libx264 -crf 18 -preset slow -movflags +faststart`,
        `-pix_fmt yuv420p '${outPath}'`,
      ].join(' ');
    } else {
      ffmpegCmd = [
        'ffmpeg -y',
        `-framerate ${fps} -i '${tmpDir}/frame_%06d.jpg'`,
        `-vf scale=${width}:${height}`,
        `-c:v libx264 -crf 18 -preset slow -movflags +faststart`,
        `-pix_fmt yuv420p '${outPath}'`,
      ].join(' ');
    }

    await execAsync(ffmpegCmd, { timeout: 10 * 60 * 1000 }); // 10 min max

    // Upload to R2
    const videoBuffer = await fs.readFile(outPath);
    const r2Key = `presentations/${req.user.id}/${pId}/export-${Date.now()}.mp4`;

    await r2.send(new PutObjectCommand({
      Bucket: BUCKET, Key: r2Key,
      Body:   videoBuffer, ContentType: 'video/mp4',
    }));

    const downloadUrl = await getSignedUrl(
      r2, new GetObjectCommand({
        Bucket: BUCKET,
        Key:    r2Key,
        ResponseContentDisposition: `attachment; filename="nif-presentation-${pId.slice(0,8)}.mp4"`,
        ResponseContentType:        'video/mp4',
      }), { expiresIn: 86400 }
    );

    // Update presentation
    await supabaseAdmin
      .from('presentations')
      .update({ exported_video_r2_key: r2Key, exported_video_url: downloadUrl })
      .eq('id', pId);

    // Clean up
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(outPath, { force: true }).catch(() => {});

    res.json({ r2Key, downloadUrl });

  } catch (err) {
    console.error('[PresentationAssemble]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Export: get signed download URL ──────────────────────────────────────────
router.get('/api/presentations/:id/export/download', requireAuth, async (req, res) => {
  const { data: p } = await supabaseAdmin
    .from('presentations').select('exported_video_r2_key, title')
    .eq('id', req.params.id).eq('user_id', req.user.id).single();

  if (!p)                        return res.status(404).json({ error: 'Presentation not found' });
  if (!p.exported_video_r2_key)  return res.status(404).json({ error: 'No exported video yet' });

  const safeTitle = ((p.title ?? 'nif-presentation')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50))
    || req.params.id.slice(0, 8);
  const filename = `${safeTitle}.mp4`;

  const url = await getSignedUrl(
    r2, new GetObjectCommand({
      Bucket: BUCKET,
      Key:    p.exported_video_r2_key,
      ResponseContentDisposition: `attachment; filename="${filename}"`,
      ResponseContentType:        'video/mp4',
    }), { expiresIn: 3600 }
  );
  res.json({ downloadUrl: url, filename, expiresIn: 3600 });
});

export default router;
