/**
 * NIFWebhooks — Outbound Webhook System
 * © Fumoca Technologies · fumoca.co.za
 *
 * Sends signed POST requests to user-registered endpoints when platform
 * events occur. Signature: X-NIF-Signature: sha256=HMAC(secret, body)
 *
 * Events:
 *   nif.reconstruction.complete   — NIF is ready to view
 *   nif.reconstruction.failed     — Job errored
 *   nif.print.complete            — STL ready for download
 *   nif.presentation.exported     — Video export done
 *   nif.license.activated         — New license issued
 *   nif.license.usage             — Embed loaded (real-time billing)
 *
 * Retry: 3 attempts with exponential backoff (5s, 25s, 125s).
 * Delivery logs written to webhook_deliveries table.
 */

import crypto  from 'crypto';
import { supabaseAdmin } from '../supabase.js';
import express from 'express';

const MAX_RETRIES  = 3;
const RETRY_DELAYS = [5_000, 25_000, 125_000];

/**
 * Dispatch an event to all registered webhooks for this user.
 * Fire-and-forget — never blocks the caller.
 */
export async function dispatchWebhook(userId, event, payload) {
  if (!userId || !event) return;

  let endpoints;
  try {
    const { data } = await supabaseAdmin
      .from('webhooks')
      .select('id, url, secret, events')
      .eq('user_id', userId)
      .eq('enabled', true);
    endpoints = data ?? [];
  } catch { return; }

  for (const endpoint of endpoints) {
    if (!endpoint.events.includes(event) && !endpoint.events.includes('*')) continue;
    _deliver(endpoint, event, payload, 0);
  }
}

async function _deliver(endpoint, event, payload, attempt) {
  const body = JSON.stringify({
    event,
    payload,
    deliveredAt: new Date().toISOString(),
    attempt,
  });

  const sig = crypto
    .createHmac('sha256', endpoint.secret ?? '')
    .update(body)
    .digest('hex');

  const deliveryId = crypto.randomUUID();
  let status = 0, responseBody = '';

  try {
    const res = await fetch(endpoint.url, {
      method:  'POST',
      headers: {
        'Content-Type':     'application/json',
        'X-NIF-Event':      event,
        'X-NIF-Signature':  `sha256=${sig}`,
        'X-NIF-Delivery':   deliveryId,
        'User-Agent':       'NIF-Webhooks/1.0 (fumoca.co.za)',
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    status       = res.status;
    responseBody = await res.text().catch(() => '');
  } catch (err) {
    responseBody = err.message;
  }

  const success = status >= 200 && status < 300;

  // Log delivery
  await supabaseAdmin.from('webhook_deliveries').insert({
    id:          deliveryId,
    webhook_id:  endpoint.id,
    event,
    status_code: status,
    response:    responseBody.slice(0, 500),
    attempt,
    success,
    delivered_at: new Date().toISOString(),
  }).catch(() => {});

  // Retry on failure
  if (!success && attempt < MAX_RETRIES - 1) {
    setTimeout(() => _deliver(endpoint, event, payload, attempt + 1), RETRY_DELAYS[attempt]);
  }
}

// ── Webhook management routes ─────────────────────────────────────────────────
export const webhookRouter = express.Router();

webhookRouter.get('/api/webhooks', async (req, res) => {
  const { data } = await supabaseAdmin
    .from('webhooks')
    .select('id, url, events, enabled, created_at')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false });
  res.json(data ?? []);
});

webhookRouter.post('/api/webhooks', async (req, res) => {
  const { url, events = ['*'], secret } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  const whSecret = secret ?? crypto.randomBytes(24).toString('hex');
  const { data, error } = await supabaseAdmin.from('webhooks').insert({
    user_id: req.user.id,
    url,
    events:  Array.isArray(events) ? events : [events],
    secret:  whSecret,
    enabled: true,
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ...data, secret: whSecret }); // only time secret is returned
});

webhookRouter.delete('/api/webhooks/:id', async (req, res) => {
  await supabaseAdmin.from('webhooks').delete()
    .eq('id', req.params.id).eq('user_id', req.user.id);
  res.json({ success: true });
});

webhookRouter.get('/api/webhooks/:id/deliveries', async (req, res) => {
  const { data } = await supabaseAdmin
    .from('webhook_deliveries')
    .select('id, event, status_code, success, attempt, delivered_at')
    .eq('webhook_id', req.params.id)
    .order('delivered_at', { ascending: false })
    .limit(50);
  res.json(data ?? []);
});

webhookRouter.post('/api/webhooks/:id/test', async (req, res) => {
  const { data: wh } = await supabaseAdmin.from('webhooks')
    .select('*').eq('id', req.params.id).eq('user_id', req.user.id).single();
  if (!wh) return res.status(404).json({ error: 'Not found' });
  _deliver(wh, 'nif.test', { message: 'NIF webhook test delivery', timestamp: new Date().toISOString() }, 0);
  res.json({ sent: true });
});
