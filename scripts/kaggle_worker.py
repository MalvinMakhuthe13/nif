"""
NIF GPU Worker — Kaggle Notebook
fumoca.co.za · © Fumoca Technologies

Paste this into a Kaggle notebook with GPU enabled (T4 free tier).
Set these in Kaggle → Settings → Secrets:
  SUPABASE_URL, SUPABASE_SECRET_KEY,
  CF_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
  GPU_WORKER_SECRET, API_BASE

Then run. The worker polls continuously until you stop it.
"""

# ── Cell 1: Install dependencies ──────────────────────────────────────────────
import subprocess

PACKAGES = [
    'gsplat',          # CUDA Gaussian rasteriser
    'boto3',           # Cloudflare R2
    'supabase',        # Supabase client
    'requests',
    'imageio[ffmpeg]',
    'torchvision',
    'Pillow',
    'trimesh',         # 3D mesh processing
    'scikit-image',    # marching cubes
    'scipy',           # spatial algorithms
    'manifold3d',      # boolean mesh ops (hollowing) — no Blender needed
]

for pkg in PACKAGES:
    result = subprocess.run(
        ['pip', 'install', '-q', pkg],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f'[warn] Failed to install {pkg}: {result.stderr[:200]}')

print('Dependencies installed')

# ── Cell 2: Load secrets ───────────────────────────────────────────────────────
import os
from kaggle_secrets import UserSecretsClient

secrets = UserSecretsClient()
REQUIRED = [
    'SUPABASE_URL', 'SUPABASE_SECRET_KEY',
    'CF_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
    'GPU_WORKER_SECRET',
]
for key in REQUIRED:
    try:
        os.environ[key] = secrets.get_secret(key)
        print(f'[ok] {key}')
    except Exception:
        print(f'[MISSING] {key} — add this to Kaggle Secrets')

# API_BASE: your hosted API or ngrok tunnel for local dev
# os.environ['API_BASE'] = secrets.get_secret('API_BASE') if 'API_BASE' in [s.label for s in secrets.list_secrets()] else 'https://api.fumoca.co.za'
try:
    os.environ['API_BASE'] = secrets.get_secret('API_BASE')
except:
    os.environ['API_BASE'] = 'https://api.fumoca.co.za'

print(f'[ok] API_BASE = {os.environ["API_BASE"]}')

# ── Cell 3: Import pipeline ────────────────────────────────────────────────────
# Upload pipeline.py to Kaggle as a dataset named 'nif-pipeline'
# or paste its contents directly here
import sys
sys.path.insert(0, '/kaggle/input/nif-pipeline/')

try:
    from pipeline import ReconstructionWorker
    print('[ok] Pipeline imported')
except ImportError as e:
    print(f'[error] Cannot import pipeline: {e}')
    print('Upload core/reconstruction/pipeline.py as a Kaggle dataset named nif-pipeline')
    raise

# ── Cell 4: Worker loop ────────────────────────────────────────────────────────
import time
from supabase import create_client

sb = create_client(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SECRET_KEY'])

print(f'\n[NIF Worker] GPU ready. Polling for jobs...\n')

consecutive_errors = 0

while True:
    try:
        # Atomically claim the next queued job
        result = sb.rpc('claim_next_reconstruction_job').execute()
        job = result.data[0] if result.data else None

        if job:
            print(f'\n[NIF Worker] ── Job {job["id"]} ──')
            print(f'  Vertical:     {job["vertical"]}')
            print(f'  Capture mode: {job["capture_mode"]}')
            print(f'  Raw R2 key:   {job["raw_r2_key"]}')

            try:
                worker  = ReconstructionWorker(job['id'], job['user_id'])
                nif_key = worker.run(
                    raw_r2_key   = job['raw_r2_key'],
                    vertical     = job['vertical'],
                    capture_mode = job['capture_mode'],
                    meta         = job.get('meta') or {},
                )
                print(f'[NIF Worker] ✓ Done → {nif_key}')
                consecutive_errors = 0
            except Exception as e:
                print(f'[NIF Worker] ✗ Job failed: {e}')
                consecutive_errors += 1
        else:
            # No jobs — wait and try again
            print('.', end='', flush=True)
            time.sleep(10)

    except Exception as e:
        consecutive_errors += 1
        print(f'\n[NIF Worker] Poll error: {e}')
        if consecutive_errors > 5:
            print('[NIF Worker] Too many consecutive errors. Waiting 60s...')
            time.sleep(60)
            consecutive_errors = 0
        else:
            time.sleep(15)


# ─── Cell 5: Print job worker loop ────────────────────────────────────────────
# Runs in parallel with the reconstruction loop in a separate notebook cell

import sys
sys.path.insert(0, '/kaggle/input/nif-pipeline/')

try:
    from NIFPrintPipeline import PrintJobWorker
    print('[ok] NIFPrintPipeline imported')
except ImportError as e:
    print(f'[error] Cannot import NIFPrintPipeline: {e}')
    print('Upload core/print/NIFPrintPipeline.py as a Kaggle dataset named nif-pipeline')
    raise

print('\n[NIF Print Worker] Polling for print jobs...\n')

while True:
    try:
        result = sb.rpc('claim_next_print_job').execute()
        job = result.data[0] if result.data else None

        if job:
            print(f'\n[Print Worker] ── Job {job["id"]} ──')
            print(f'  NIF ID:    {job["nif_id"]}')
            print(f'  Templates: {job["templates"]}')
            print(f'  Height:    {job.get("height_mm")} mm')
            print(f'  VoxelRes:  {job.get("voxel_res", 128)}')

            try:
                worker = PrintJobWorker(job['nif_id'], job['user_id'])
                worker.run(
                    templates   = job['templates'],
                    height_mm   = job.get('height_mm'),
                    voxel_res   = job.get('voxel_res', 128),
                    edit_params = (job.get('meta') or {}).get('edit_params', {}),
                )
                print(f'[Print Worker] ✓ Done')
            except Exception as e:
                print(f'[Print Worker] ✗ Failed: {e}')
        else:
            print('.', end='', flush=True)
            time.sleep(15)
    except Exception as e:
        print(f'\n[Print Worker] Poll error: {e}')
        time.sleep(20)
