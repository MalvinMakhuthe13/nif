# NIF Platform — Complete Implementation Guide
## fumoca.co.za · © Fumoca Technologies
### From zero to fully live — every step, every click, every value

---

## What you are building

Five services working together:

```
fumoca.co.za              ← Cloudflare Pages (free) — your dashboard, viewer, editor
api.fumoca.co.za          ← Railway ($5/month) — your API server
Supabase                  ← database, auth, realtime (free tier)
Cloudflare R2             ← file storage (pay per use, pennies)
Kaggle                    ← free GPU for 3D reconstruction and 3D printing
```

Total cost until your first paying client: **under R100/month**

Time to complete this guide: **60–90 minutes**

---

## BEFORE YOU START

You need accounts at these five services. All have free tiers.
Create them now before reading further — some take a few minutes to activate.

1. **supabase.com** — sign up free
2. **cloudflare.com** — sign up free (fumoca.co.za should already be here)
3. **railway.app** — sign up free, connect with Google or GitHub
4. **kaggle.com** — sign up free
5. **Node.js 18 or higher** on your computer —
   check by opening a terminal and typing `node --version`
   If you see v18 or higher you are good.
   If not: download from nodejs.org

---

## STEP 1 — Unzip the project

Unzip `nif-platform-real.zip`.
You get a folder called `nif-real`.

Put it somewhere permanent — not your Downloads folder.
Desktop, Documents, or a Projects folder all work.

Open a terminal inside the `nif-real` folder:
- **Mac:** right-click the `nif-real` folder → New Terminal at Folder
- **Windows:** open Command Prompt, type `cd ` (with a space), drag the folder in, press Enter

Run this command:
```
npm install
```

You will see packages downloading. This takes 30–60 seconds. Normal.

---

## STEP 2 — Generate your security secrets

In the same terminal, run:
```
node scripts/generate-secrets.js
```

You will see four lines like:
```
JWT_SECRET=a3f8c2d1e4b7...
LICENSE_SIGNING_KEY=b7d4e1f2a9...
WATERMARK_KEY=c9f2a4d8b1...
GPU_WORKER_SECRET=d5e8b3c7f0...
```

**Copy all four lines. Keep this terminal open.**

---

## STEP 3 — Create your .env file

In the `nif-real` folder, find the file called `.env.example`.

**Duplicate it** and name the copy `.env`

Mac/Linux terminal:
```
cp .env.example .env
```

Windows terminal:
```
copy .env.example .env
```

Open `.env` in any text editor — Notepad, TextEdit, VS Code, anything.

**Paste the four secrets** from Step 2 into the matching lines:
```
JWT_SECRET=paste your value here
LICENSE_SIGNING_KEY=paste your value here
WATERMARK_KEY=paste your value here
GPU_WORKER_SECRET=paste your value here
```

Leave everything else as-is for now. You will fill in the rest as you go.
**Keep `.env` open** — you will be pasting into it throughout this guide.

---

## STEP 4 — Supabase (database + auth + realtime)

### 4.1 Create your project

Go to **supabase.com** → sign in → click **New project**

Fill in:
- **Organisation:** create one with your name or Fumoca Technologies
- **Project name:** `fumoca-nif`
- **Database password:** click Generate, then copy and save it somewhere safe
  (you will not need it in code, but keep it)
- **Region:** select **South Africa (Cape Town)** — `af-south-1`
  This is important — it puts your database physically close to your users

Click **Create new project**.

A spinner appears for 2–3 minutes. Wait for the green **Project is ready** message.

### 4.2 Copy your API keys

In your project, look at the left sidebar. Click the **cog icon** at the very bottom → **Project Settings** → **API**

You need to copy three values into your `.env` file:

**Project URL** — looks like `https://toujfhriwgcpsqmqrqar.supabase.co`
Your `.env` already has the correct value in `SUPABASE_URL` — it was pre-filled.
Confirm it matches what you see on screen. If different, update it.

**anon public key** — a long string starting with `eyJ` (scroll down, labelled "anon public")
Your `.env` already has this in `SUPABASE_PUBLISHABLE_KEY`.
Confirm it matches. If different, update it.

**service_role key** — another long string starting with `eyJ` (labelled "service_role", marked secret)
Find this line in `.env`:
```
SUPABASE_SECRET_KEY=PASTE_YOUR_sb_secret_KEY
```
Replace `PASTE_YOUR_sb_secret_KEY` with the actual service_role key you see on screen.

The service_role key has full database access. Never share it. Never put it in HTML.

### 4.3 Run the database schema

Go to the left sidebar in your Supabase project → click the **SQL Editor icon** (looks like `</>`)

Click **New query** (top left of the SQL editor).

You will run four separate queries, in this exact order:

---

**Query 1 of 4:**

Open the file `scripts/schema.sql` from your `nif-real` folder in a text editor.
Select all the text (Ctrl+A or Cmd+A), copy it.
Paste it into the Supabase SQL editor.
Click **Run** (or press Ctrl+Enter).

Wait for **"Success. No rows returned."** in green at the bottom.

If you see a red error: read it carefully. The most common cause is running the wrong file.

---

**Query 2 of 4:**

Click **New query** again.
Open `scripts/schema_extended.sql`, select all, copy, paste.
Click **Run**. Wait for success.

---

**Query 3 of 4:**

Click **New query** again.
Open `scripts/schema_social.sql`, select all, copy, paste.
Click **Run**. Wait for success.

This query depends on functions created in Query 2.
If it errors, confirm Query 2 ran successfully first.

---

**Query 4 of 4:**

Click **New query** again.
Open `scripts/schema_presentations.sql`, select all, copy, paste.
Click **Run**. Wait for success.

---

**One more query — permissions:**

Click **New query** again.
Copy and paste this exactly:

```sql
grant select on public.nif_feed to authenticated;
grant select on public.nif_trending to authenticated;
grant select on public.nif_moment_highlights to authenticated;
grant select on public.social_feed to authenticated, anon;
grant select on public.discover_feed to authenticated, anon;
grant execute on function public.fork_nif to authenticated;
grant execute on function public.get_revenue_summary to authenticated;
```

Click **Run**. Wait for success.

You now have 16 tables, 5 views, 8 functions, and 3 triggers in your database.

### 4.4 Configure authentication

In the left sidebar → **Authentication** → **Providers**

Under **Email:**
- Turn **"Confirm email"** to **OFF**
  (You will turn this back on after you confirm the full system works end-to-end)

In the left sidebar → **Authentication** → **URL Configuration**

Set:
- **Site URL:** `https://fumoca.co.za`
- **Redirect URLs:** click Add URL, add `https://fumoca.co.za/dashboard`

Click **Save**

### 4.5 Enable realtime

In the left sidebar → **Database** → **Replication**

Find these tables and turn their replication **ON**:
- `reconstruction_jobs`
- `print_jobs`
- `nif_notifications`
- `nif_reactions`
- `nif_comments`

This is what makes your dashboard update live without the user refreshing.

---

## STEP 5 — Cloudflare R2 (file storage)

### 5.1 Create the storage bucket

Go to **dash.cloudflare.com** → sign in

In the left sidebar, click **R2 Object Storage**

If you do not see it, click **Storage** first.

Click **Create bucket**

- **Bucket name:** `fumoca-nif-storage`
  (This exact name is already in your `.env` as `R2_BUCKET`)
- **Location:** leave as Automatic
- Do **NOT** enable public access

Click **Create bucket**

### 5.2 Create API credentials for R2

Still on the R2 page, look for **Manage R2 API Tokens** in the top-right area.
Click it.

Click **Create API Token**

- **Token name:** `fumoca-nif-api`
- **Permissions:** Object Read & Write
- Under **Specify bucket(s):** select `fumoca-nif-storage` specifically

Click **Create API Token**

**The next screen shows credentials you can only see once.**
Do not close this page until you have copied all three values into your `.env`.

Copy into `.env`:
```
CF_ACCOUNT_ID=    ← copy the Account ID shown on this page
R2_ACCESS_KEY_ID= ← copy the Access Key ID shown on this page
R2_SECRET_ACCESS_KEY= ← copy the Secret Access Key shown on this page
```

After copying all three, click away. You cannot retrieve the secret key again.

### 5.3 Verify your .env is complete

Your `.env` should now look like this (with your real values):

```
SUPABASE_URL=https://toujfhriwgcpsqmqrqar.supabase.co
SUPABASE_PUBLISHABLE_KEY=eyJ...your anon key...
SUPABASE_SECRET_KEY=eyJ...your service_role key...

CF_ACCOUNT_ID=abc123def456...
R2_ACCESS_KEY_ID=abc123...
R2_SECRET_ACCESS_KEY=very_long_secret...
R2_BUCKET=fumoca-nif-storage

PORT=3001
NODE_ENV=production
ALLOWED_ORIGINS=https://fumoca.co.za,https://www.fumoca.co.za

JWT_SECRET=...generated in Step 2...
LICENSE_SIGNING_KEY=...generated in Step 2...
WATERMARK_KEY=...generated in Step 2...
GPU_WORKER_SECRET=...generated in Step 2...

PLATFORM_DOMAIN=fumoca.co.za
```

Every line must have a real value. If any line still says PASTE or GENERATE, go back and fill it in.

---

## STEP 6 — Deploy the API to Railway

Railway hosts the Node.js API server. No GitHub needed — you deploy directly from your computer.

### 6.1 Install the Railway CLI

In your terminal (still in the `nif-real` folder):
```
npm install -g @railway/cli
```

### 6.2 Log in to Railway

```
railway login
```

A browser window opens. Log in. Come back to the terminal.

### 6.3 Create a new Railway project

```
railway init
```

When asked for a project name, type: `nif-platform`
When asked about a template, press Enter to skip (empty project).

### 6.4 Deploy the API

```
railway up
```

Railway uploads your code. You will see upload progress, then a build log.
This takes 1–2 minutes the first time.

At the end you will see something like:
```
  Deployment finished ✓
  View logs: https://railway.app/...
```

### 6.5 Add your environment variables to Railway

Go to **railway.app** → sign in → click your `nif-platform` project → click your service

Click the **Variables** tab → click **Raw Editor**

Open your `.env` file in a text editor.
Select all the content, copy it.
Paste it into Railway's Raw Editor.
Click **Update Variables**

Railway redeploys automatically. Wait about 30 seconds.

### 6.6 Set your custom domain

Still in Railway, click your service → **Settings** tab → scroll to **Networking** → click **Generate Domain**

Railway gives you a domain like `nif-platform-production.up.railway.app`

Click **Custom Domain** → type `api.fumoca.co.za` → click **Add**

Railway shows you a CNAME record to add. Keep this page open.

### 6.7 Add the DNS record

Go to **dash.cloudflare.com** → click on `fumoca.co.za` → **DNS** → **Records**

Click **Add record**

- **Type:** CNAME
- **Name:** api
- **Target:** paste the Railway domain (e.g. `nif-platform-production.up.railway.app`)
- **Proxy status:** DNS only (grey cloud, not orange)
- **TTL:** Auto

Click **Save**

DNS changes propagate in 1–5 minutes.

### 6.8 Verify the API is live

Open a browser and go to:
```
https://api.fumoca.co.za/api/health
```

You should see:
```json
{"status":"ok","platform":"NIF · fumoca.co.za","version":"1.0.0"}
```

If you see a browser error after 5 minutes, check:
- The CNAME record was saved correctly in Cloudflare DNS
- The Railway deployment completed without errors (check Railway logs)
- All environment variables are set in Railway Variables

---

## STEP 7 — Deploy the frontend to Cloudflare Pages

No GitHub, no build step, no terminal. Just drag and drop.

### 7.1 Open Cloudflare Pages

Go to **dash.cloudflare.com** → in the left sidebar, click **Workers & Pages** → click **Pages**

### 7.2 Create the project

Click **Create** → click **Upload assets**

- **Project name:** `nif-platform`
- Click **Create project**

### 7.3 Upload your files

In the upload area, drag your entire `nif-real` folder in.

Or click **Select from computer** and select the `nif-real` folder.

Cloudflare uploads all 64 files. Takes about 30 seconds.

Click **Deploy site**

You will see a Cloudflare URL like `nif-platform-xyz.pages.dev` — it works, but you want your own domain.

### 7.4 Add your custom domain

Click **Custom domains** tab → **Set up a custom domain**

Type `fumoca.co.za` → click **Continue**

Since fumoca.co.za is already on Cloudflare DNS, the records are added automatically.
Click **Activate domain**.

Do it again for `www.fumoca.co.za` → it should redirect to `fumoca.co.za` automatically.

### 7.5 Verify the dashboard is live

Open a browser and go to:
```
https://fumoca.co.za/dashboard
```

You should see the NIF login screen.

### 7.6 How to update the frontend in future

When you need to update files:
- Go to your Pages project → **Deployments** tab
- Click **Create new deployment**
- Drag your updated `nif-real` folder in
- Takes 30 seconds

That is the entire update process. No commands, no GitHub.

---

## STEP 8 — Create your first account

Go to `https://fumoca.co.za/dashboard`

Click **Create account**

Enter your email and a password.

You should land on the dashboard showing:
- "No NIF files yet"
- Upload button
- Empty Jobs list

This confirms auth is working.

---

## STEP 9 — GPU worker on Kaggle (reconstruction + 3D printing)

This is what converts a phone video into a NIF file.
It runs on Kaggle's free T4 GPU — 15GB of VRAM, completely free.

### 9.1 Upload the pipeline as a Kaggle dataset

Go to **kaggle.com** → sign in

Click your profile icon (top right) → **New Dataset**

- Click **Create**
- Dataset name: `nif-pipeline` (this exact name matters)
- Privacy: **Private**

Upload these two files from your `nif-real` folder:
- `core/reconstruction/pipeline.py`
- `core/print/NIFPrintPipeline.py`

Click **Create Dataset**

Wait for it to finish processing (usually under a minute).

### 9.2 Add your secrets to Kaggle

Click your profile icon → **Settings** → scroll down to **Secrets**

Click **Add New Secret** for each of these. The name must match exactly.

| Secret name | Where to get the value |
|---|---|
| `SUPABASE_URL` | your `.env` file, `SUPABASE_URL` line |
| `SUPABASE_SECRET_KEY` | your `.env` file, `SUPABASE_SECRET_KEY` line |
| `CF_ACCOUNT_ID` | your `.env` file, `CF_ACCOUNT_ID` line |
| `R2_ACCESS_KEY_ID` | your `.env` file, `R2_ACCESS_KEY_ID` line |
| `R2_SECRET_ACCESS_KEY` | your `.env` file, `R2_SECRET_ACCESS_KEY` line |
| `GPU_WORKER_SECRET` | your `.env` file, `GPU_WORKER_SECRET` line |
| `API_BASE` | type exactly: `https://api.fumoca.co.za` |

### 9.3 Create the worker notebook

Go to kaggle.com → top navigation → **Create** → **New Notebook**

In the notebook settings panel (right side of the screen):

- **Accelerator:** GPU T4 x1
  (Click the dropdown, select GPU T4 x1)
- **Internet:** turn ON
  (Required — the worker downloads ML models on first run)
- **Persistence:** Files only

**Add your dataset:**
Click **Add Data** (right panel) → search for `nif-pipeline` → click **+** to add it

**Add the worker code:**

Delete the empty cell that appears by default.

Click **+ Code** to add a new code cell.

Open the file `scripts/kaggle_worker.py` from your `nif-real` folder in a text editor.
Select all the content, copy it.
Paste it into the Kaggle code cell.

### 9.4 Run the worker

Click **Save Version** (top right) →
Select **Save & Run All (Commit)** →
Tick **"Always use the latest version for datasets"** →
Click **Save**

Kaggle starts running. Click **View Active Events** to watch the output.

After 2–3 minutes of package installation, you should see:
```
[ok] SUPABASE_URL
[ok] SUPABASE_SECRET_KEY
[ok] CF_ACCOUNT_ID
[ok] R2_ACCESS_KEY_ID
[ok] R2_SECRET_ACCESS_KEY
[ok] GPU_WORKER_SECRET
[ok] API_BASE
[ok] Pipeline imported
[ok] Print pipeline imported

[Worker] Polling for reconstruction jobs...
[Worker] Polling for print jobs...
[Worker] No jobs. Sleeping 15s...
```

The worker runs for up to 9 hours on the free tier.
When it stops, come back to Kaggle and click **Run All** to restart it.
Kaggle resets the session limit each day — you get 30 free GPU hours per week.

---

## STEP 10 — Test the full system end to end

Work through this in order. Each step confirms a piece of the system.

### 10.1 Upload test

Go to `https://fumoca.co.za/dashboard`

Click **Upload**

Film a short video on your phone:
- Film any object — a coffee mug, a shoe, a product
- Walk slowly around it in a circle
- 15–30 seconds total
- Keep the object centred in frame

Upload that video. Fill in a title. Select "Generic" as the vertical.

Click **Upload & Reconstruct**

**What you should see:**
- A job appears in the Jobs section with status "Queued"
- Within 30 seconds, status changes to "Processing" with a percentage
- The percentage increases as the Kaggle worker processes it
- This happens without you refreshing the page (realtime)

**What to do if the job stays at "Queued" for more than 2 minutes:**
- Check the Kaggle notebook output — is the worker running?
- If the notebook stopped, click Run All to restart it

**Reconstruction takes 5–15 minutes** depending on video length.

### 10.2 Viewer test

When the job reaches 100% (status: Complete):
- A file card appears in your Files section
- Click **View**

**What you should see:**
- A video plays (the proxy video — this is your raw footage, re-encoded)
- After a moment, a "Tap to explore in 4D ✦" button appears
- Tap or click it
- The video shatters into particles (Stage 1 — Dissociation)
- Particles swirl in a nebula (Stage 2 — Nebula)
- Structure emerges (Stage 3 — Crystallisation)
- A ripple sweeps the scene and it solidifies (Stage 4 — Solidification)
- You are now in the interactive 4D scene
- Drag to orbit, scroll to zoom, two-finger on mobile

**What to check in the viewer:**
- Layer buttons appear at the bottom (Foreground / Background / Segments)
- Tapping Foreground shows only the main subject
- Tapping All restores the full scene

### 10.3 3D print test

Go to `https://fumoca.co.za/print`

- Select your NIF file from the list
- Click **Bobblehead**
- The edit panel opens showing sliders:
  - Head scale (try 2.5 for a more exaggerated look)
  - Neck split height
  - Spring gap
  - Socket radius
- Set your size (100mm is standard)
- Click **Generate**

A print job appears. The Kaggle worker picks it up.
Processing takes 3–8 minutes.

When complete, two download buttons appear:
- **Download head.stl**
- **Download body.stl**

Download both. Open them in your slicer (Bambu Studio, Cura, PrusaSlicer).
Print the body first, then the head. Insert a coil spring between them.

### 10.4 Social test

Go to `https://fumoca.co.za/dashboard`

Find your NIF file → click the three dots menu → **Make Public**

Go to `https://fumoca.co.za/feed`

Your NIF should appear in the discover tab.

---

## STEP 11 — Issue your first license (for a client)

When a client wants to embed a NIF on their website, you issue them a license key.
Unlicensed embeds show a NIF watermark — licensed ones are clean.

### 11.1 Create the license

Go to `https://fumoca.co.za/dashboard` → click **Licenses** tab

Click **New License**

Fill in:
- **Domain:** the client's domain (e.g. `clientname.co.za`)
- **Plan:** Starter / Professional / Enterprise
- **Monthly fee:** what you agreed with the client

Click **Issue License**

A license key is generated. Copy it — give it to your client.

### 11.2 Client embed code

Give your client this code to paste on their website:

```html
<div data-nif-id="THEIR-NIF-UUID"
     data-nif-license="THEIR-LICENSE-KEY"
     style="width:100%;aspect-ratio:16/9">
</div>
<script src="https://fumoca.co.za/sdk/embed/nif-viewer.js"></script>
```

Replace `THEIR-NIF-UUID` with the NIF's ID (shown in the dashboard URL when viewing it)
and `THEIR-LICENSE-KEY` with the key you just issued.

The embed checks the license on load. If valid and domain matches, clean view.
If not licensed, a small "✦ NIF · fumoca.co.za" badge appears in the corner.

---

## STEP 12 — Custom email for auth (optional but professional)

Without this, Supabase sends auth emails from `noreply@mail.supabase.io`.
With this, they come from `hello@fumoca.co.za`.

### 12.1 Set up Resend

Go to **resend.com** → sign up free

Click **Add Domain** → type `fumoca.co.za`

Resend shows you DNS records to add. Go to Cloudflare DNS and add each one.
(Usually 2–3 TXT/MX records — takes 5 minutes)

Click **Verify** in Resend. Wait for all records to go green.

Click **API Keys** → **Create API Key** → copy the key.

### 12.2 Connect to Supabase

In your Supabase project → **Project Settings** → **Authentication** → **SMTP Settings**

Turn **Custom SMTP** ON and fill in:
- **Host:** `smtp.resend.com`
- **Port:** `465`
- **Username:** `resend`
- **Password:** paste your Resend API key
- **Sender email:** `hello@fumoca.co.za`
- **Sender name:** `NIF · fumoca.co.za`

Click **Save**

Now go to **Authentication** → **Providers** → **Email**
Turn **Confirm email** ON.

From now on, new signups get a confirmation email from your domain.

---

## STEP 13 — What to do when things break

### API health check fails
`https://api.fumoca.co.za/api/health` shows an error or doesn't load.

- Go to railway.app → your project → **Deployments** tab
- Click the latest deployment → read the build log
- Most common cause: a required environment variable is missing
- Go to **Variables** tab and check every variable has a value

### Job stays at "Queued" forever
The Kaggle notebook has stopped.

- Go to kaggle.com → Notebooks → your worker notebook
- Click **Edit** → click **Run All**
- Watch the output — confirm you see "Polling for reconstruction jobs..."

### Dashboard shows blank or white screen
Open browser DevTools (F12) → Console tab.
Read the error message — it will tell you exactly what failed.
Most common causes:
- `config.js` not loading (check network tab for 404 on config.js)
- Supabase auth error (check the error message text)

### Viewer shows black canvas
In browser DevTools → Console, run:
```javascript
!!document.createElement('canvas').getContext('webgl2')
```
If this returns `false`, the browser does not support WebGL2.
Use Chrome or Edge — both support WebGL2. Safari requires iOS 15+.

### 3D print job fails
- Check the Kaggle notebook output — the print worker section shows the error
- Most common: `manifold3d` not installed — the worker installs it on first run
- If the error says "No boolean engine available": the hollow operation was skipped,
  the model will be solid instead of hollow (still printable, just heavier)

### Login works but dashboard is empty after login
Go to Supabase → Authentication → Logs → check for any auth errors.
Also confirm the Redirect URL `https://fumoca.co.za/dashboard` is in
Authentication → URL Configuration → Redirect URLs.

---

## STEP 14 — Pricing and getting your first client

### What to charge

**Starter — R500/month**
- 5 NIF files per month
- All 9 print templates (figurine, bobblehead, keychain, bust, miniature, coin, memory, ornament, statue)
- Video editor with share guide
- Embed on their website
- Best for: photographers, content creators, product sellers

**Professional — R1,500/month**
- 20 NIF files per month
- All vertical features (property walkthroughs, product configurator, architecture)
- White-label embed (their domain, clean)
- Priority GPU queue
- Best for: estate agents, product brands, architects, events companies

**Enterprise — R5,000+/month (negotiated)**
- Unlimited NIF files
- Dedicated GPU queue (no waiting)
- Custom vertical plugin
- API access for their developers
- SLA and support
- Best for: large brands, property groups, event companies with volume

### What to show them

Film something in their presence — their product, their space, their face.
Upload it on your phone. While it processes (5–15 minutes), show them:
- The dashboard
- The 3D print templates
- The video editor
- The share guide showing every platform

When it finishes, open it on their phone.
Let them orbit it themselves — do not do it for them.
Let them tap it on their own screen.

That moment — when it comes alive from the video — is the sale.

### What to say

*"This is a NIF file. You film something for 30 seconds. We turn it into a 4D
experience that plays like a video on Instagram or WhatsApp, but when someone
taps it they can explore it in full 3D. We can also 3D print it — figurine,
keychain, bobblehead, whatever you want. No one else does this from a phone
video in 15 minutes."*

---

## Quick reference — all your live URLs

| What | URL |
|---|---|
| Dashboard | `https://fumoca.co.za/dashboard` |
| View a NIF | `https://fumoca.co.za/view/{nif-id}` |
| Social feed | `https://fumoca.co.za/feed` |
| Video editor | `https://fumoca.co.za/editor` |
| 3D print | `https://fumoca.co.za/print` |
| API health | `https://api.fumoca.co.za/api/health` |
| Embed SDK | `https://fumoca.co.za/sdk/embed/nif-viewer.js` |

---

## Quick reference — how to update after changes

**Update the frontend** (dashboard, viewer, editor):
1. Make your changes in the `nif-real` folder
2. Go to dash.cloudflare.com → Workers & Pages → nif-platform
3. Click Deployments → Create new deployment
4. Drag the `nif-real` folder in
5. Done in 30 seconds

**Update the API** (api/index.js and related files):
1. Make your changes in the `nif-real` folder
2. In terminal in the `nif-real` folder: `railway up`
3. Done in 60 seconds

**Update the GPU pipeline** (reconstruction, print):
1. Upload the updated `.py` files to your Kaggle dataset `nif-pipeline`
2. Click Edit on the notebook → Run All
3. Done

---

*© Fumoca Technologies · fumoca.co.za · Proprietary and confidential*
