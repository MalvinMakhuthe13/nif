/**
 * Generate secure secrets for .env
 * Run: node scripts/generate-secrets.js
 */

import crypto from 'crypto';

const secrets = {
  JWT_SECRET:          crypto.randomBytes(48).toString('hex'),
  LICENSE_SIGNING_KEY: crypto.randomBytes(48).toString('hex'),
  WATERMARK_KEY:       crypto.randomBytes(32).toString('hex'),
  GPU_WORKER_SECRET:   crypto.randomBytes(32).toString('hex'),
};

console.log('\n# Paste into your .env file:\n');
for (const [k,v] of Object.entries(secrets)) console.log(`${k}=${v}`);
console.log('\n# Never share or commit these.\n');
