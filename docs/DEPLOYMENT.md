# NIF Platform — Deployment Guide
## fumoca.co.za · © Fumoca Technologies
### Everything runs online. No local testing needed.

The API is already live at `https://api.fumoca.co.za`.
The dashboard deploys to `https://fumoca.co.za`.
The Kaggle worker runs on free GPU.
Nothing runs on your machine.

---

## PART 1 — Files (2 minutes)

Unzip `nif-platform-real.zip` → folder called `nif-real`.

Open a terminal in that folder:
```
npm install
node scripts/generate-secrets.js
```

Copy the four generated values (JWT_SECRET, LICENSE_SIGNING_KEY, WATERMARK_KEY, GPU_WORKER_SECRET).
Copy `.env.example` → `.env`. Paste the four values in. Leave it open.

---

## PART 2 — Supabase (15 minutes)

**supabase.com → New project**
- Name: `fumoca-nif`
- Region: Africa (South Africa) — `af-south-1`
- Wait 2–3 minutes for green "Project ready"

**Settings → API** — copy into `.env`:
```
SUPABASE_URL=https://YOURPROJECT.supabase.co
SUPABASE_PUBLISHABLE_KEY=eyJ...   ← anon/public key
SUPABASE_SECRET_KEY=eyJ...        ← service_role key (keep secret)
```

**SQL Editor → 4 runs in order:**
1. Paste `scripts/schema.sql` → Run
2. Paste `scripts/schema_extended.sql` → Run
3. Paste `scripts/schema_social.sql` → Run
4. Paste `scripts/schema_presentations.sql` → Run

Then one more query:
```sql
grant select on public.nif_feed to authenticated;
grant select on public.nif_trending to authenticated;
grant select on public.nif_moment_highlights to authenticated;
grant select on public.social_feed to authenticated, anon;
grant select on public.discover_feed to authenticated, anon;
grant execute on function public.fork_nif to authenticated;
grant execute on function public.get_revenue_summary to authenticated;
```

**Authentication → Providers → Email** — turn confirmation OFF (turn back on after first test).

**Authentication → URL Configuration:**
- Site URL: `https://fumoca.co.za`
- Redirect URLs: `https://fumoca.co.za/dashboard`

**Database → Replication** — enable for:
`reconstruction_jobs`, `print_jobs`, `nif_notifications`, `nif_reactions`, `nif_comments`

---

## PART 3 — Cloudflare R2 (10 minutes)

**dash.cloudflare.com → R2 → Create bucket**
- Name: `fumoca-nif-storage`
- No public access

**R2 → Manage R2 API Tokens → Create API Token**
- Permissions: Object Read & Write on `fumoca-nif-storage`

Copy all three into `.env`. **You only see these once.**
```
CF_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=fumoca-nif-storage
```

---

## PART 4 — API to Railway — no GitHub needed (10 minutes)

**Install the Railway CLI once:**
```
npm install -g @railway/cli
railway login
```

**In your terminal, in the `nif-real` folder:**
```
railway init
railway up
```

Railway uploads your code directly. No GitHub. It detects Node.js automatically.

**Set environment variables:**
```
railway variables set SUPABASE_URL=https://toujfhriwgcpsqmqrqar.supabase.co
railway variables set SUPABASE_SECRET_KEY=your_service_role_key
railway variables set CF_ACCOUNT_ID=your_cloudflare_account_id
railway variables set R2_ACCESS_KEY_ID=your_r2_key
railway variables set R2_SECRET_ACCESS_KEY=your_r2_secret
railway variables set R2_BUCKET=fumoca-nif-storage
railway variables set GPU_WORKER_SECRET=your_generated_secret
railway variables set JWT_SECRET=your_generated_jwt_secret
railway variables set LICENSE_SIGNING_KEY=your_generated_key
railway variables set WATERMARK_KEY=your_generated_key
railway variables set ALLOWED_ORIGINS=https://fumoca.co.za,https://www.fumoca.co.za
railway variables set NODE_ENV=production
railway variables set PORT=3001
```

Or set them all in the Railway dashboard under Variables after the first deploy.

**Custom domain:**

In Railway dashboard → your service → Settings → Networking → Custom Domain → add `api.fumoca.co.za`

Add CNAME at your domain registrar (or Cloudflare DNS):
```
Host:   api
Target: your-service.up.railway.app
TTL:    300
```

**To redeploy after changes:** run `railway up` again in the `nif-real` folder.

**Verify:** `https://api.fumoca.co.za/api/health` → `{"status":"ok",...}`

---

## PART 5 — Frontend to Cloudflare Pages — no GitHub needed (5 minutes)

**This is a direct upload — drag and drop. No GitHub, no CLI, no build step.**

**dash.cloudflare.com → Pages → Create project → "Upload assets"**

Drag the entire `nif-real` folder into the upload box.
Give the project a name: `nif-platform`
Click Deploy.

Cloudflare Pages hosts it instantly.

**Custom domains** → add `fumoca.co.za` and `www.fumoca.co.za`

Since fumoca.co.za is already on Cloudflare DNS, the records are added automatically.

**To update the site** — go back to your Pages project → "Create new deployment" → drag the folder again. Takes 30 seconds. No code, no terminal.

The `_redirects` file handles all clean URLs:
- `https://fumoca.co.za/dashboard` → dashboard
- `https://fumoca.co.za/view/NIFID` → viewer
- `https://fumoca.co.za/feed` → social feed
- `https://fumoca.co.za/print` → 3D print
- `https://fumoca.co.za/editor` → video editor

---

## PART 6 — GPU Worker on Kaggle (20 minutes)

**kaggle.com → New Dataset** — name it exactly `nif-pipeline`

Upload:
- `core/reconstruction/pipeline.py`
- `core/print/NIFPrintPipeline.py`

Set Private. Create.

**kaggle.com → Settings → Secrets** — add each:

| Name | Value |
|---|---|
| `SUPABASE_URL` | your Supabase URL |
| `SUPABASE_SECRET_KEY` | your service_role key |
| `CF_ACCOUNT_ID` | your Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | your R2 key |
| `R2_SECRET_ACCESS_KEY` | your R2 secret |
| `GPU_WORKER_SECRET` | from your .env |
| `API_BASE` | `https://api.fumoca.co.za` |

**New Notebook** → GPU T4 x1, Internet ON, Persistence: Files only

Add data → search `nif-pipeline` → add it.

Paste entire `scripts/kaggle_worker.py` into a code cell.

**Save version → Save & Run All (Commit)**

Output should show:
```
[ok] SUPABASE_URL
[ok] Pipeline imported
[Worker] Polling for reconstruction jobs...
```

---

## PART 7 — Test everything online (10 minutes)

Open `https://fumoca.co.za/dashboard` — create an account.

Upload a short video (film any object for 10–30 seconds, walking slowly around it).

Watch the progress bar update live.

When complete → View → proxy video plays → tap → 4-stage transition → interactive 4D scene.

**Checklist:**
- [ ] `https://api.fumoca.co.za/api/health` returns `{"status":"ok"}`
- [ ] Login works at `https://fumoca.co.za/dashboard`
- [ ] Upload queues a job
- [ ] Kaggle worker picks it up (check notebook output)
- [ ] Dashboard progress updates without refresh
- [ ] Notification appears when complete
- [ ] NIF viewer loads, proxy plays, tap triggers transition
- [ ] Layer buttons appear (Foreground / Background)
- [ ] 3D print → select NIF → pick template → Generate → STL downloads
- [ ] Social feed shows NIFs from followed users

---

## PART 8 — Email from your domain (optional, 10 minutes)

**resend.com** → Add domain `fumoca.co.za` → add their DNS records in Cloudflare.

Get a Resend API key.

**Supabase → Authentication → SMTP:**
- Host: `smtp.resend.com` · Port: `465`
- Username: `resend` · Password: Resend API key
- From: `hello@fumoca.co.za`

Turn email confirmation back ON.

---

## When something breaks

| What you see | Where to look |
|---|---|
| Upload fails | Railway logs → check R2 credentials in Variables |
| Job stuck at 5% | Kaggle notebook output — rerun the cell |
| Dashboard blank | Browser F12 → Console — import error or auth issue |
| Login loops | Supabase → Auth → Logs + check Redirect URLs |
| Viewer black screen | F12 → `!!document.createElement('canvas').getContext('webgl2')` → must be `true` |
| Print job never starts | Kaggle notebook print worker section |
| API health fails | Railway → Deployments → check build log |

---

## Live URLs

| | |
|---|---|
| Dashboard | `https://fumoca.co.za/dashboard` |
| Viewer | `https://fumoca.co.za/view/{nif-id}` |
| Feed | `https://fumoca.co.za/feed` |
| Video editor | `https://fumoca.co.za/editor` |
| 3D Print | `https://fumoca.co.za/print` |
| API | `https://api.fumoca.co.za/api/health` |
| Embed SDK | `https://fumoca.co.za/sdk/embed/nif-viewer.js` |
