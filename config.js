/**
 * NIF Platform — Runtime Configuration
 * fumoca.co.za · © Fumoca Technologies
 *
 * Fill in your values below.
 * This file is loaded by every HTML page before any other script.
 * Never commit this file to a public repository.
 *
 * Deploy: drag the entire nif-real folder to Cloudflare Pages.
 * No GitHub, no build step, no CLI needed.
 */

window.NIF_CONFIG = {

  // ── Supabase ───────────────────────────────────────────────────────────────
  // supabase.com → your project → Settings → API
  supabaseUrl:    'https://ijfimuodpvbuwrspzfra.supabase.co',
  supabaseAnonKey:'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlqZmltdW9kcHZidXdyc3B6ZnJhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5MzIzNzgsImV4cCI6MjA5MzUwODM3OH0.rqAwagwnh7VxA-j5vrAo14P07N7ZawYZ9pFE85X517c',

  // ── API server ─────────────────────────────────────────────────────────────
  // Your Railway API URL — set after deploying api/index.js to Railway
  apiBase:        'http://localhost:3001/api',

  // ── Platform ───────────────────────────────────────────────────────────────
  siteUrl:        'https://fumoca.co.za',

};
