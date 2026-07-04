/**
 * Supabase Client — NIF Platform
 * fumoca.co.za · © Fumoca Technologies
 */
import 'dotenv/config';


import WebSocket from 'ws';
import { createClient } from '@supabase/supabase-js';

console.log("SUPABASE KEY:", process.env.SUPABASE_PUBLISHABLE_KEY);

const URL = process.env.SUPABASE_URL         ?? 'https://ijfimuodpvbuwrspzfra.supabase.co';
const PUB = process.env.SUPABASE_PUBLISHABLE_KEY;
const SEC = process.env.SUPABASE_SECRET_KEY;

if (!PUB) throw new Error('SUPABASE_PUBLISHABLE_KEY not set in .env');
if (!SEC && typeof window === 'undefined') throw new Error('SUPABASE_SECRET_KEY not set in .env');

// Public client — use in browser, subject to RLS
export const supabasePublic = createClient(URL, PUB, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
  },
  realtime: {
    transport: WebSocket,
    params: {
      eventsPerSecond: 10,
    },
  },
});

// Admin client — server only, bypasses RLS
export const supabaseAdmin = createClient(URL, SEC ?? '', {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
  realtime: {
    transport: WebSocket,
  },
});
// Auth helpers
export const Auth = {
  signUp:       (email, password, meta={}) => supabasePublic.auth.signUp({ email, password, options:{data:meta} }),
  signIn:       (email, password)          => supabasePublic.auth.signInWithPassword({ email, password }),
  signOut:      ()                         => supabasePublic.auth.signOut(),
  getUser:      token                      => supabaseAdmin.auth.getUser(token),
  getSession:   ()                         => supabasePublic.auth.getSession(),
  onAuthChange: cb                         => supabasePublic.auth.onAuthStateChange(cb),
};

// Realtime subscriptions
export const Realtime = {
  // Watch a job's progress update in real-time
  jobProgress: (jobId, cb) =>
    supabasePublic
      .channel(`job:${jobId}`)
      .on('postgres_changes', { event:'UPDATE', schema:'public', table:'reconstruction_jobs', filter:`id=eq.${jobId}` }, p => cb(p.new))
      .subscribe(),

  // Watch for new NIF files (dashboard live update)
  userFiles: (userId, cb) =>
    supabasePublic
      .channel(`files:${userId}`)
      .on('postgres_changes', { event:'INSERT', schema:'public', table:'nif_files', filter:`user_id=eq.${userId}` }, p => cb(p.new))
      .subscribe(),

  // GPU worker listens for jobs
  newJobs: cb =>
    supabaseAdmin
      .channel('reconstruction')
      .on('broadcast', { event:'job_queued' }, ({ payload }) => cb(payload))
      .subscribe(),
};

// DB helpers — thin wrappers so we don't repeat table names everywhere
export const DB = {
  // Jobs
  getJob:       id      => supabaseAdmin.from('reconstruction_jobs').select('*').eq('id', id).single(),
  listJobs:     userId  => supabaseAdmin.from('reconstruction_jobs').select('*').eq('user_id', userId).order('created_at',{ascending:false}),
  updateJob:    (id,d)  => supabaseAdmin.from('reconstruction_jobs').update(d).eq('id', id),
  claimNextJob: ()      => supabaseAdmin.rpc('claim_next_reconstruction_job'),

  // NIF files
  listFiles:    (userId, filters={}) => {
    let q = supabaseAdmin.from('nif_files').select('*').eq('user_id', userId).order('created_at',{ascending:false});
    if (filters.vertical) q = q.eq('vertical', filters.vertical);
    return q;
  },
  getFile:      id      => supabaseAdmin.from('nif_files').select('*').eq('id', id).single(),
  insertFile:   d       => supabaseAdmin.from('nif_files').insert(d).select().single(),
  updateFile:   (id,d)  => supabaseAdmin.from('nif_files').update(d).eq('id', id),
  deleteFile:   id      => supabaseAdmin.from('nif_files').delete().eq('id', id),
  incrementViews: id    => supabaseAdmin.rpc('increment_view_count', { nif_uuid: id }),

  // Licenses
  getLicense:    key    => supabaseAdmin.from('licenses').select('*').eq('license_key', key).eq('is_active', true).single(),
  insertLicense: d      => supabaseAdmin.from('licenses').insert(d).select().single(),
  logUsage:      d      => supabaseAdmin.from('license_usage').insert(d),
  listLicenses:  userId => supabaseAdmin.from('licenses').select('*').eq('issued_by', userId).order('issued_at',{ascending:false}),
  revenueSummary: uid   => supabaseAdmin.rpc('get_revenue_summary', { owner_id: uid }),

  // Profiles
  getProfile:    userId => supabasePublic.from('profiles').select('*').eq('id', userId).single(),
  updateProfile: (uid,d)=> supabasePublic.from('profiles').update(d).eq('id', uid),
};
