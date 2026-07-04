/**
 * NIF Social API Routes
 * fumoca.co.za · © Fumoca Technologies
 *
 * GET  /api/feed                    — personalised feed (following + own)
 * GET  /api/discover                — trending public NIFs
 * GET  /api/u/:username             — public profile + their NIFs
 * POST /api/follow/:userId          — follow a user
 * DELETE /api/follow/:userId        — unfollow
 * POST /api/nif/:id/like            — like a NIF
 * DELETE /api/nif/:id/like          — unlike
 * POST /api/nif/:id/save            — save/bookmark
 * DELETE /api/nif/:id/save          — unsave
 * GET  /api/nif/:id/comments        — get comments
 * POST /api/nif/:id/comments        — post comment
 * DELETE /api/nif/:id/comments/:cid — delete own comment
 * PATCH /api/profile                — update own profile (username, bio, avatar)
 * GET  /api/profile/me              — own profile with social counts
 * POST /api/nif/:id/publish         — make NIF public
 * PATCH /api/nif/:id/meta           — update title, description, tags, thumbnail
 */

import express from 'express';
import { supabaseAdmin } from '../supabase.js';
import { limitAPI, limitPublic } from './rateLimit.js';
import { track } from './analytics.js';

export const socialRouter = express.Router();

// ── Auth middleware (copy from index.js — refactor to shared later) ────────────
async function optAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) {
    const { data: { user } } = await supabaseAdmin.auth.getUser(token).catch(() => ({ data: {} }));
    req.user = user ?? null;
  } else {
    req.user = null;
  }
  next();
}

async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Auth required' });
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });
  req.user = user;
  next();
}

// ── Feed ──────────────────────────────────────────────────────────────────────
// Personalised: NIFs from users you follow + your own, newest first
socialRouter.get('/api/feed', requireAuth, limitAPI, async (req, res) => {
  const { page = 0, limit = 20, vertical } = req.query;
  const offset = parseInt(page) * parseInt(limit);

  // Get list of users this person follows
  const { data: follows } = await supabaseAdmin
    .from('follows')
    .select('following_id')
    .eq('follower_id', req.user.id);

  const followingIds = (follows ?? []).map(f => f.following_id);
  followingIds.push(req.user.id); // include own NIFs

  let q = supabaseAdmin
    .from('social_feed')
    .select('*')
    .in('user_id', followingIds)
    .order('created_at', { ascending: false })
    .range(offset, offset + parseInt(limit) - 1);

  if (vertical) q = q.eq('vertical', vertical);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  // Annotate with viewer's like/save status
  const nifIds = (data ?? []).map(n => n.id);
  const [likedRes, savedRes] = await Promise.all([
    supabaseAdmin.from('nif_likes').select('nif_id').eq('user_id', req.user.id).in('nif_id', nifIds),
    supabaseAdmin.from('nif_saves').select('nif_id').eq('user_id', req.user.id).in('nif_id', nifIds),
  ]);
  const liked = new Set((likedRes.data ?? []).map(l => l.nif_id));
  const saved = new Set((savedRes.data ?? []).map(s => s.nif_id));

  const annotated = (data ?? []).map(n => ({
    ...n,
    viewer_liked: liked.has(n.id),
    viewer_saved: saved.has(n.id),
  }));

  res.json(annotated);
});

// ── Discover ──────────────────────────────────────────────────────────────────
socialRouter.get('/api/discover', optAuth, limitPublic, async (req, res) => {
  const { page = 0, limit = 20, vertical, sort = 'trending' } = req.query;
  const offset = parseInt(page) * parseInt(limit);

  let q;
  if (sort === 'trending') {
    q = supabaseAdmin.from('discover_feed').select('*');
  } else if (sort === 'new') {
    q = supabaseAdmin.from('social_feed').select('*').order('created_at', { ascending: false });
  } else {
    q = supabaseAdmin.from('social_feed').select('*').order('like_count', { ascending: false });
  }

  if (vertical) q = q.eq('vertical', vertical);
  q = q.range(offset, offset + parseInt(limit) - 1);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
});

// ── Public profile ────────────────────────────────────────────────────────────
socialRouter.get('/api/u/:username', optAuth, limitPublic, async (req, res) => {
  const { data: profile, error } = await supabaseAdmin
    .from('profiles')
    .select('id, username, display_name, bio, avatar_url, website, is_brand, brand_color, verified, follower_count, following_count, nif_count, total_views, created_at')
    .eq('username', req.params.username)
    .single();

  if (error || !profile) return res.status(404).json({ error: 'Profile not found' });

  // Get their public NIFs
  const { data: nifs } = await supabaseAdmin
    .from('nif_files')
    .select('id, title, description, thumbnail_url, vertical, gaussian_count, like_count, view_count, tags, created_at')
    .eq('user_id', profile.id)
    .eq('is_public', true)
    .order('created_at', { ascending: false })
    .limit(24);

  // Is viewer following this profile?
  let viewerFollowing = false;
  if (req.user) {
    const { data: f } = await supabaseAdmin
      .from('follows')
      .select('follower_id')
      .eq('follower_id', req.user.id)
      .eq('following_id', profile.id)
      .single();
    viewerFollowing = !!f;
  }

  res.json({ profile, nifs: nifs ?? [], viewerFollowing });
});

// ── Own profile ───────────────────────────────────────────────────────────────
socialRouter.get('/api/profile/me', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('*')
    .eq('id', req.user.id)
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

socialRouter.patch('/api/profile', requireAuth, async (req, res) => {
  const allowed = ['username','display_name','bio','avatar_url','website','is_brand','brand_color'];
  const updates = {};
  for (const [k, v] of Object.entries(req.body)) {
    if (allowed.includes(k)) updates[k] = v;
  }

  if (updates.username) {
    // Validate format
    const { data: valid } = await supabaseAdmin.rpc('is_valid_username', { u: updates.username });
    if (!valid) return res.status(400).json({ error: 'Username must be 3–30 lowercase letters, numbers, underscores. Cannot be a reserved word.' });

    // Check uniqueness
    const { data: existing } = await supabaseAdmin
      .from('profiles').select('id').eq('username', updates.username).single();
    if (existing && existing.id !== req.user.id) {
      return res.status(409).json({ error: 'Username already taken' });
    }
  }

  const { data, error } = await supabaseAdmin
    .from('profiles').update(updates).eq('id', req.user.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// ── Follow / Unfollow ─────────────────────────────────────────────────────────
socialRouter.post('/api/follow/:userId', requireAuth, limitAPI, async (req, res) => {
  if (req.params.userId === req.user.id)
    return res.status(400).json({ error: 'Cannot follow yourself' });

  const { error } = await supabaseAdmin.from('follows').insert({
    follower_id: req.user.id,
    following_id: req.params.userId,
  });
  if (error?.code === '23505') return res.status(409).json({ error: 'Already following' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ following: true });
});

socialRouter.delete('/api/follow/:userId', requireAuth, async (req, res) => {
  await supabaseAdmin.from('follows')
    .delete().eq('follower_id', req.user.id).eq('following_id', req.params.userId);
  res.json({ following: false });
});

// ── Like / Unlike ─────────────────────────────────────────────────────────────
socialRouter.post('/api/nif/:id/like', requireAuth, limitAPI, async (req, res) => {
  const { error } = await supabaseAdmin.from('nif_likes').insert({
    user_id: req.user.id, nif_id: req.params.id,
  });
  if (error?.code === '23505') return res.status(409).json({ error: 'Already liked' });
  if (error) return res.status(500).json({ error: error.message });
  track('nif_liked', { nifId: req.params.id }, req.user.id);
  res.json({ liked: true });
});

socialRouter.delete('/api/nif/:id/like', requireAuth, async (req, res) => {
  await supabaseAdmin.from('nif_likes')
    .delete().eq('user_id', req.user.id).eq('nif_id', req.params.id);
  res.json({ liked: false });
});

// ── Save / Unsave ─────────────────────────────────────────────────────────────
socialRouter.post('/api/nif/:id/save', requireAuth, limitAPI, async (req, res) => {
  const { error } = await supabaseAdmin.from('nif_saves').insert({
    user_id: req.user.id, nif_id: req.params.id,
  });
  if (error?.code === '23505') return res.status(409).json({ error: 'Already saved' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ saved: true });
});

socialRouter.delete('/api/nif/:id/save', requireAuth, async (req, res) => {
  await supabaseAdmin.from('nif_saves')
    .delete().eq('user_id', req.user.id).eq('nif_id', req.params.id);
  res.json({ saved: false });
});

// ── Comments ──────────────────────────────────────────────────────────────────
socialRouter.get('/api/nif/:id/comments', optAuth, limitPublic, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('nif_comments')
    .select(`
      id, body, like_count, created_at, parent_id,
      profiles:user_id (username, display_name, avatar_url, verified)
    `)
    .eq('nif_id', req.params.id)
    .is('parent_id', null)          // top-level only
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
});

socialRouter.post('/api/nif/:id/comments', requireAuth, limitAPI, async (req, res) => {
  const { body, parentId } = req.body;
  if (!body?.trim()) return res.status(400).json({ error: 'Comment body required' });
  if (body.length > 1000) return res.status(400).json({ error: 'Comment too long (max 1000 chars)' });

  const { data, error } = await supabaseAdmin.from('nif_comments').insert({
    nif_id:    req.params.id,
    user_id:   req.user.id,
    body:      body.trim(),
    parent_id: parentId ?? null,
  }).select('id, body, created_at, parent_id').single();

  if (error) return res.status(500).json({ error: error.message });

  // Notify NIF owner
  const { data: nif } = await supabaseAdmin
    .from('nif_files').select('user_id, title').eq('id', req.params.id).single();
  if (nif && nif.user_id !== req.user.id) {
    const { data: commenter } = await supabaseAdmin
      .from('profiles').select('display_name, username').eq('id', req.user.id).single();
    await supabaseAdmin.rpc('create_notification', {
      p_user_id: nif.user_id,
      p_type:    'new_comment',
      p_title:   'New comment',
      p_body:    `${commenter?.display_name ?? 'Someone'} commented on "${nif.title}"`,
      p_url:     `/v/${req.params.id}`,
      p_meta:    JSON.stringify({ commentId: data.id, nifId: req.params.id }),
    }).catch(() => {});
  }

  res.json(data);
});

socialRouter.delete('/api/nif/:id/comments/:cid', requireAuth, async (req, res) => {
  const { error } = await supabaseAdmin.from('nif_comments')
    .delete()
    .eq('id', req.params.cid)
    .eq('user_id', req.user.id)  // can only delete own comments
    .eq('nif_id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ deleted: true });
});

// ── Publish a NIF ─────────────────────────────────────────────────────────────
socialRouter.post('/api/nif/:id/publish', requireAuth, async (req, res) => {
  const { error } = await supabaseAdmin.from('nif_files')
    .update({ is_public: true })
    .eq('id', req.params.id)
    .eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });

  // Increment profile NIF count
  await supabaseAdmin.rpc('increment_nif_count', { p_user_id: req.user.id }).catch(() => {});

  res.json({ published: true });
});

// ── Update NIF metadata ────────────────────────────────────────────────────────
socialRouter.patch('/api/nif/:id/meta', requireAuth, async (req, res) => {
  const allowed = ['title','description','tags','thumbnail_url','is_public','vertical'];
  const updates = {};
  for (const [k, v] of Object.entries(req.body)) {
    if (allowed.includes(k)) updates[k] = v;
  }
  const { data, error } = await supabaseAdmin.from('nif_files')
    .update(updates)
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── Saved NIFs ────────────────────────────────────────────────────────────────
socialRouter.get('/api/saved', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('nif_saves')
    .select(`
      created_at,
      nif:nif_id (
        id, title, thumbnail_url, vertical, like_count, view_count, gaussian_count, created_at,
        profiles:user_id (username, display_name, avatar_url)
      )
    `)
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json((data ?? []).map(s => s.nif));
});

// ── Search ────────────────────────────────────────────────────────────────────
socialRouter.get('/api/search', limitPublic, async (req, res) => {
  const { q, limit = 20, page = 0, vertical } = req.query;
  if (!q?.trim()) return res.json([]);

  const { data, error } = await supabaseAdmin.rpc('search_nifs', {
    query: q.trim(),
    lim:   parseInt(limit),
    off:   parseInt(page) * parseInt(limit),
  });
  if (error) return res.status(500).json({ error: error.message });

  // Join with profiles
  const userIds = [...new Set((data ?? []).map(n => n.user_id))];
  const { data: profiles } = await supabaseAdmin
    .from('profiles')
    .select('id, username, display_name, avatar_url, verified, is_brand')
    .in('id', userIds);

  const pMap = Object.fromEntries((profiles ?? []).map(p => [p.id, p]));
  const enriched = (data ?? []).map(n => ({ ...n, ...pMap[n.user_id] }));

  res.json(enriched);
});
