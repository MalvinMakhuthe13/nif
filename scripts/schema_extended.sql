-- NIF Platform — Extended Schema
-- fumoca.co.za · © Fumoca Technologies
-- Run after schema.sql and schema_presentations.sql

-- ─── Analytics events ────────────────────────────────────────────────────────
create table if not exists public.analytics_events (
  id          bigserial primary key,
  event       text not null,
  user_id     uuid references auth.users(id) on delete set null,
  properties  jsonb not null default '{}',
  ts          timestamptz not null default now(),
  sdk_version text
);

create index if not exists analytics_event_idx   on public.analytics_events(event);
create index if not exists analytics_user_idx    on public.analytics_events(user_id);
create index if not exists analytics_ts_idx      on public.analytics_events(ts desc);
create index if not exists analytics_nif_idx     on public.analytics_events((properties->>'nifId'));

-- NIF view stats RPC (used by analytics summary endpoint)
create or replace function public.get_nif_view_stats(p_user_id uuid)
returns table(nif_id text, view_count bigint, unique_domains bigint, last_viewed timestamptz)
language sql stable as $$
  select
    properties->>'nifId'      as nif_id,
    count(*)                  as view_count,
    count(distinct properties->>'origin') as unique_domains,
    max(ts)                   as last_viewed
  from public.analytics_events
  where event = 'nif_viewed'
    and ts > now() - interval '30 days'
    and exists (
      select 1 from public.nif_files
      where id::text = properties->>'nifId'
      and user_id = p_user_id
    )
  group by properties->>'nifId'
  order by view_count desc
  limit 50;
$$;

-- ─── Webhooks ────────────────────────────────────────────────────────────────
create table if not exists public.webhooks (
  id         uuid primary key default uuid_generate_v4(),
  user_id    uuid references auth.users(id) on delete cascade not null,
  url        text not null,
  secret     text not null,
  events     text[] not null default '{*}',
  enabled    boolean not null default true,
  created_at timestamptz default now()
);

create index if not exists webhooks_user_idx on public.webhooks(user_id);

create table if not exists public.webhook_deliveries (
  id           uuid primary key default uuid_generate_v4(),
  webhook_id   uuid references public.webhooks(id) on delete cascade,
  event        text not null,
  status_code  int,
  response     text,
  attempt      int not null default 0,
  success      boolean not null default false,
  delivered_at timestamptz default now()
);

create index if not exists wd_webhook_idx on public.webhook_deliveries(webhook_id);
create index if not exists wd_event_idx   on public.webhook_deliveries(event);

-- RLS: users only see their own webhooks
alter table public.webhooks           enable row level security;
alter table public.webhook_deliveries enable row level security;

create policy "own webhooks" on public.webhooks for all using (auth.uid() = user_id);
create policy "own deliveries" on public.webhook_deliveries for select
  using (exists (select 1 from public.webhooks where id = webhook_id and user_id = auth.uid()));

-- ─── Notifications ───────────────────────────────────────────────────────────
create table if not exists public.notifications (
  id         uuid primary key default uuid_generate_v4(),
  user_id    uuid references auth.users(id) on delete cascade not null,
  type       text not null,  -- job_complete, job_failed, print_ready, license_issued
  title      text not null,
  body       text,
  url        text,           -- deep link
  read       boolean not null default false,
  meta       jsonb not null default '{}',
  created_at timestamptz default now()
);

create index if not exists notif_user_idx   on public.notifications(user_id);
create index if not exists notif_read_idx   on public.notifications(user_id, read) where read = false;
create index if not exists notif_ts_idx     on public.notifications(created_at desc);

alter table public.notifications enable row level security;
create policy "own notifications" on public.notifications for all using (auth.uid() = user_id);

-- Helper: create a notification (used by GPU worker callback routes)
create or replace function public.create_notification(
  p_user_id uuid, p_type text, p_title text, p_body text, p_url text, p_meta jsonb
) returns uuid language plpgsql security definer as $$
declare v_id uuid := uuid_generate_v4();
begin
  insert into public.notifications(id, user_id, type, title, body, url, meta)
  values (v_id, p_user_id, p_type, p_title, p_body, p_url, coalesce(p_meta,'{}'));
  return v_id;
end;
$$;

-- ─── SPAX export jobs ────────────────────────────────────────────────────────
create table if not exists public.spax_exports (
  id           uuid primary key default uuid_generate_v4(),
  user_id      uuid references auth.users(id) on delete cascade not null,
  nif_id       uuid references public.nif_files(id) on delete cascade not null,
  status       text not null default 'queued',  -- queued|processing|complete|failed
  r2_key       text,
  download_url text,
  file_size    bigint,
  lod_levels   int not null default 3,
  include_audio boolean not null default true,
  error_message text,
  created_at   timestamptz default now(),
  completed_at timestamptz
);

create index if not exists spax_user_idx on public.spax_exports(user_id);
create index if not exists spax_nif_idx  on public.spax_exports(nif_id);

alter table public.spax_exports enable row level security;
create policy "own spax" on public.spax_exports for all using (auth.uid() = user_id);

-- ─── Social shares ───────────────────────────────────────────────────────────
create table if not exists public.social_shares (
  id           uuid primary key default uuid_generate_v4(),
  nif_id       uuid references public.nif_files(id) on delete cascade not null,
  user_id      uuid references auth.users(id) on delete set null,
  platform     text not null,  -- twitter, linkedin, whatsapp, instagram, copy
  share_url    text,
  clicked      boolean not null default false,
  created_at   timestamptz default now()
);

create index if not exists shares_nif_idx  on public.social_shares(nif_id);
create index if not exists shares_user_idx on public.social_shares(user_id);

-- ─── Push subscriptions ──────────────────────────────────────────────────────
create table if not exists public.push_subscriptions (
  id           uuid primary key default uuid_generate_v4(),
  user_id      uuid references auth.users(id) on delete cascade not null,
  endpoint     text not null unique,
  p256dh       text not null,
  auth         text not null,
  user_agent   text,
  created_at   timestamptz default now(),
  last_used    timestamptz
);

create index if not exists push_user_idx on public.push_subscriptions(user_id);

alter table public.push_subscriptions enable row level security;
create policy "own push" on public.push_subscriptions for all using (auth.uid() = user_id);

-- ─── Vertical config ─────────────────────────────────────────────────────────
create table if not exists public.verticals (
  id            text primary key,  -- 'automotive','fashion','property', etc
  label         text not null,
  description   text,
  icon          text,
  capture_tips  jsonb default '[]',
  print_templates text[] default '{}',
  is_active     boolean default true
);

insert into public.verticals (id, label, description, icon, capture_tips) values
  ('generic',    'Generic',       'Any 3D object',               '⬡', '["Walk slowly around the object","Keep lighting consistent","Capture from multiple heights"]'),
  ('automotive', 'Automotive',    'Vehicles and car detail',     '🚗', '["Capture exterior first, then interior","Focus on badge and trim details","Ensure even lighting, avoid direct sun"]'),
  ('fashion',    'Fashion',       'Clothing and accessories',    '👗', '["Use a mannequin or model","Capture 360° with overlapping frames","Shoot in diffuse light, avoid shadows"]'),
  ('property',   'Property',      'Real estate and interiors',   '🏠', '["Start at doorway, move room to room","Capture ceiling and floor angles","Ensure all lights are on"]'),
  ('mining',     'Mining',        'Geological and site capture', '⛏', '["Use drone for site overview","Capture at multiple elevations","Include reference scale objects"]'),
  ('agriculture','Agriculture',   'Crop and land monitoring',    '🌾', '["Drone capture recommended","Fly grid pattern for best coverage","Capture after rain when soil contrast is high"]')
on conflict (id) do nothing;

-- ─── API keys (for programmatic access) ──────────────────────────────────────
create table if not exists public.api_keys (
  id           uuid primary key default uuid_generate_v4(),
  user_id      uuid references auth.users(id) on delete cascade not null,
  name         text not null,
  key_hash     text not null unique,  -- sha256(key) — never store raw
  key_prefix   text not null,         -- first 8 chars for display
  scopes       text[] not null default '{read}',
  last_used    timestamptz,
  expires_at   timestamptz,
  created_at   timestamptz default now()
);

create index if not exists apikeys_user_idx on public.api_keys(user_id);
create index if not exists apikeys_hash_idx on public.api_keys(key_hash);

alter table public.api_keys enable row level security;
create policy "own api keys" on public.api_keys for all using (auth.uid() = user_id);

-- ─── Usage quotas ────────────────────────────────────────────────────────────
create table if not exists public.usage_quotas (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  plan           text not null default 'free',
  nif_count      int  not null default 0,
  storage_bytes  bigint not null default 0,
  exports_month  int  not null default 0,
  views_month    bigint not null default 0,
  quota_nif      int  not null default 5,      -- free plan: 5 NIFs
  quota_storage  bigint not null default 536870912, -- 512MB
  quota_exports  int  not null default 3,      -- 3 exports/month
  reset_at       timestamptz default date_trunc('month', now()) + interval '1 month'
);

alter table public.usage_quotas enable row level security;
create policy "own quota" on public.usage_quotas for select using (auth.uid() = user_id);

-- Auto-create quota on signup
create or replace function public.create_user_quota()
returns trigger language plpgsql security definer as $$
begin
  insert into public.usage_quotas(user_id) values (new.id) on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists on_profile_created on public.profiles;
create trigger on_profile_created
  after insert on public.profiles
  for each row execute function public.create_user_quota();

-- ── Client delivery links ──────────────────────────────────────────────────────
create table if not exists public.deliveries (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references public.profiles(id) on delete cascade,
  token       text unique not null,
  nif_ids     uuid[] not null default '{}',
  title       text,
  message     text,
  branding    jsonb default '{}',
  expires_at  timestamptz not null,
  created_at  timestamptz default now()
);
alter table public.deliveries enable row level security;
create policy "Users manage own deliveries" on public.deliveries
  for all using (auth.uid() = user_id);

create table if not exists public.delivery_views (
  id          uuid primary key default gen_random_uuid(),
  delivery_id uuid references public.deliveries(id) on delete cascade,
  ip          text,
  user_agent  text,
  created_at  timestamptz default now()
);
