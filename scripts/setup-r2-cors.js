/**
 * R2 CORS Configuration Script
 * fumoca.co.za · © Fumoca Technologies
 *
 * Run this ONCE after creating your R2 bucket.
 * Without this, browsers on external websites cannot fetch NIF files
 * from R2 — the embed SDK will fail with CORS errors.
 *
 * Usage:
 *   node scripts/setup-r2-cors.js
 *
 * Requires: .env with CF_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 */

import 'dotenv/config';
import { S3Client, PutBucketCorsCommand, GetBucketCorsCommand } from '@aws-sdk/client-s3';

const r2 = new S3Client({
  region:   'auto',
  endpoint: `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET ?? 'fumoca-nif-storage';

// CORS rules that allow the embed SDK to fetch NIF files from any website
const corsConfig = {
  CORSRules: [
    {
      // Allow any website to fetch NIF files (read-only)
      // This is required for the embed SDK to work on client websites
      AllowedOrigins: ['*'],
      AllowedMethods: ['GET', 'HEAD'],
      AllowedHeaders: ['*'],
      ExposeHeaders:  ['Content-Length', 'Content-Type', 'ETag'],
      MaxAgeSeconds:  86400,
    },
    {
      // Allow the fumoca platform itself to do uploads (PUT)
      AllowedOrigins: [
        'https://fumoca.co.za',
        'https://api.fumoca.co.za',
      ],
      AllowedMethods: ['GET', 'PUT', 'HEAD', 'DELETE'],
      AllowedHeaders: ['*'],
      ExposeHeaders:  ['ETag'],
      MaxAgeSeconds:  3600,
    },
  ],
};

async function run() {
  console.log(`\nConfiguring CORS on R2 bucket: ${BUCKET}\n`);

  try {
    // Check current CORS config
    try {
      const existing = await r2.send(new GetBucketCorsCommand({ Bucket: BUCKET }));
      console.log('Current CORS rules:');
      console.log(JSON.stringify(existing.CORSRules, null, 2));
    } catch {
      console.log('No existing CORS configuration found.');
    }

    // Apply new CORS config
    await r2.send(new PutBucketCorsCommand({
      Bucket:            BUCKET,
      CORSConfiguration: corsConfig,
    }));

    console.log('\n✓ CORS configured successfully.\n');
    console.log('Rules applied:');
    console.log('  1. GET/HEAD from any origin (for embed SDK on client websites)');
    console.log('  2. GET/PUT/DELETE from fumoca.co.za and api.fumoca.co.za');
    console.log('\nThe embed SDK can now fetch NIF files from any website.');

  } catch (err) {
    console.error('\n✗ CORS configuration failed:', err.message);
    console.error('\nTroubleshooting:');
    console.error('  - Check CF_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY in .env');
    console.error('  - Confirm R2_BUCKET matches the exact bucket name in Cloudflare R2');
    console.error('  - Your R2 API token needs "Edit" permissions on the bucket');
    process.exit(1);
  }
}

run();
