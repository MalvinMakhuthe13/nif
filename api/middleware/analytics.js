/**
 * NIFAnalytics — Server-Side Event Tracking
 * © Fumoca Technologies · fumoca.co.za
 *
 * Captures:
 *   - NIF views (who, which NIF, from where, via embed or direct)
 *   - Reconstruction job lifecycle
 *   - Export events
 *   - License activations / usage
 *   - Presentation plays
 *   - Error events
 *
 * Events are written to the analytics_events table in Supabase.
 * Heavy aggregation (DAU, revenue, conversion) happens via Postgres views.
 *
 * Client-side SDK snippet:
 *   NIF.track('nif_viewed', { nifId, source:'embed', domain:'example.com' });
 */

import { supabaseAdmin } from '../supabase.js';

// Write-behind batch to avoid blocking API responses
const _queue  = [];
let   _flushing = false;

async function _flush() {
  if (_flushing || !_queue.length) return;
  _flushing = true;
  const batch = _queue.splice(0, 100);
  try {
    await supabaseAdmin.from('analytics_events').insert(batch);
  } catch (err) {
    console.error('[Analytics flush]', err.message);
    // Don't re-queue on failure — analytics is best-effort
  } finally {
    _flushing = false;
    if (_queue.length) setTimeout(_flush, 200);
  }
}

setInterval(_flush, 5000);

/**
 * Track an event.
 * Fire-and-forget — never awaited in request handlers.
 */
export function track(event, properties = {}, userId = null) {
  _queue.push({
    event,
    user_id:    userId,
    properties: JSON.stringify(properties),
    ts:         new Date().toISOString(),
    sdk_version:'1.0',
  });
  if (_queue.length >= 50) _flush();
}

/**
 * Express middleware — attaches track() to req and records
 * basic request telemetry automatically.
 */
export function analyticsMiddleware(req, res, next) {
  req.track = (event, props = {}) => track(event, {
    ...props,
    path:      req.path,
    method:    req.method,
    ip:        req.ip,
    ua:        req.headers['user-agent'],
    referer:   req.headers['referer'],
    origin:    req.headers['origin'],
  }, req.user?.id ?? null);

  // Record response time
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    if (ms > 2000) {
      track('slow_request', {
        path: req.path, method: req.method, ms, status: res.statusCode,
      });
    }
  });

  next();
}

/**
 * Routes: POST /api/analytics/event  (client-side tracking)
 *         GET  /api/analytics/summary (dashboard data)
 */
import express from 'express';
export const analyticsRouter = express.Router();

analyticsRouter.post('/api/analytics/event', async (req, res) => {
  const { event, properties, nifId, sessionId } = req.body;
  if (!event) return res.status(400).json({ error: 'event required' });

  // Allowlist — only accept safe client-side events
  const allowed = [
    'nif_viewed','nif_shared','nif_embed_loaded','nif_transition_triggered',
    'presentation_played','print_template_viewed','license_embed_loaded',
  ];
  if (!allowed.includes(event)) return res.status(400).json({ error: 'Unknown event' });

  track(event, {
    ...properties,
    nifId,
    sessionId,
    ip:      req.ip,
    ua:      req.headers['user-agent'],
    origin:  req.headers['origin'],
    referer: req.headers['referer'],
  });

  res.json({ ok: true });
});

analyticsRouter.get('/api/analytics/summary', async (req, res) => {
  // Requires auth — wired in index.js
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Auth required' });

  try {
    const [views, jobs, exports_, licenses] = await Promise.all([
      // NIF views for this user's files (last 30 days)
      supabaseAdmin.rpc('get_nif_view_stats', { p_user_id: userId }),
      // Job success/failure rates
      supabaseAdmin.from('reconstruction_jobs')
        .select('status, count:id', { count:'exact' })
        .eq('user_id', userId)
        .gte('created_at', new Date(Date.now() - 30*24*60*60*1000).toISOString()),
      // Export count
      supabaseAdmin.from('analytics_events')
        .select('id', { count:'exact', head:true })
        .eq('event', 'export_complete')
        .eq('user_id', userId),
      // Active licenses revenue
      supabaseAdmin.from('licenses')
        .select('monthly_fee, currency, is_active')
        .eq('issued_by', userId)
        .eq('is_active', true),
    ]);

    const monthly = (licenses.data ?? []).reduce((s,l) => s + parseFloat(l.monthly_fee ?? 0), 0);

    res.json({
      views:       views.data ?? [],
      jobs:        jobs.data  ?? [],
      exportCount: exports_.count ?? 0,
      revenue:     { monthly, annual: monthly * 12, currency:'ZAR' },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
