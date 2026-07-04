-- NIF Platform Database Schema
-- fumoca.co.za · © Fumoca Technologies
-- Run in Supabase SQL Editor → New query → paste → Run

create extension if not exists "uuid-ossp";

-- Profiles (created automatically on signup via trigger)
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  full_name   text,
  company     text,
  plan        text not null default 'free',
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Reconstruction jobs
create table if not exists public.reconstruction_jobs (
  id             uuid primary key default uuid_generate_v4(),
  user_id        uuid references auth.users(id) on delete cascade not null,
  status         text not null default 'queued',
  progress       int  not null default 0,
  vertical       text not null default 'generic',
  capture_mode   text not null default 'video',
  raw_r2_key     text,
  nif_r2_key     text,
  file_size      bigint,
  gaussian_count int,
  error_message  text,
  meta           jsonb default '{}',
  created_at     timestamptz default now(),
  started_at     timestamptz,
  completed_at   timestamptz
);

create index if not exists jobs_user_id_idx on public.reconstruction_jobs(user_id);
create index if not exists jobs_status_idx  on public.reconstruction_jobs(status);

-- NIF files
create table if not exists public.nif_files (
  id             uuid primary key default uuid_generate_v4(),
  user_id        uuid references auth.users(id) on delete cascade not null,
  job_id         uuid references public.reconstruction_jobs(id) on delete set null,
  title          text,
  description    text,
  vertical       text not null default 'generic',
  r2_key         text not null,
  thumbnail_url  text,
  file_size      bigint default 0,
  gaussian_count int    default 0,
  duration       float  default 0,
  is_public      boolean default false,
  tags           text[] default '{}',
  view_count     bigint default 0,
  meta           jsonb  default '{}',
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

create index if not exists nif_user_id_idx  on public.nif_files(user_id);
create index if not exists nif_vertical_idx on public.nif_files(vertical);
create index if not exists nif_public_idx   on public.nif_files(is_public) where is_public = true;

-- Licenses
create table if not exists public.licenses (
  id            uuid primary key default uuid_generate_v4(),
  license_key   text unique not null,
  client_name   text not null,
  client_email  text,
  domain        text,
  plan          text not null,
  monthly_fee   numeric(10,2) default 0,
  currency      text default 'ZAR',
  issued_by     uuid references auth.users(id),
  nif_ids       uuid[] default '{}',
  is_active     boolean default true,
  render_count  bigint default 0,
  issued_at     timestamptz default now(),
  expires_at    timestamptz
);

create index if not exists licenses_key_idx on public.licenses(license_key);

-- License usage (audit trail for billing)
create table if not exists public.license_usage (
  id          uuid primary key default uuid_generate_v4(),
  license_id  uuid references public.licenses(id) on delete cascade,
  nif_id      uuid references public.nif_files(id) on delete set null,
  event       text not null,
  origin      text,
  created_at  timestamptz default now()
);

-- Stored procedures

-- Atomic job claim (prevents race conditions between multiple GPU workers)
create or replace function public.claim_next_reconstruction_job()
returns setof public.reconstruction_jobs language sql as $$
  update public.reconstruction_jobs
  set status='processing', progress=1, started_at=now()
  where id = (
    select id from public.reconstruction_jobs
    where status='queued'
    order by created_at asc
    limit 1
    for update skip locked
  )
  returning *;
$$;

-- Increment view count (called on each NIF stream access)
create or replace function public.increment_view_count(nif_uuid uuid)
returns void language sql security definer as $$
  update public.nif_files set view_count = view_count + 1 where id = nif_uuid;
$$;

-- Revenue summary
create or replace function public.get_revenue_summary(owner_id uuid)
returns table(total_monthly numeric, active_licenses bigint) language sql security definer as $$
  select
    coalesce(sum(monthly_fee), 0) as total_monthly,
    count(*) as active_licenses
  from public.licenses
  where issued_by = owner_id and is_active = true;
$$;

-- Row Level Security
alter table public.profiles            enable row level security;
alter table public.reconstruction_jobs enable row level security;
alter table public.nif_files           enable row level security;
alter table public.licenses            enable row level security;
alter table public.license_usage       enable row level security;

drop policy if exists "own profile"   on public.profiles;
drop policy if exists "own jobs"      on public.reconstruction_jobs;
drop policy if exists "own nif files" on public.nif_files;
drop policy if exists "public nifs"   on public.nif_files;
drop policy if exists "own licenses"  on public.licenses;
drop policy if exists "own usage"     on public.license_usage;

create policy "own profile"   on public.profiles            for all using (auth.uid() = id);
create policy "own jobs"      on public.reconstruction_jobs for all using (auth.uid() = user_id);
create policy "own nif files" on public.nif_files           for all using (auth.uid() = user_id);
create policy "public nifs"   on public.nif_files           for select using (is_public = true);
create policy "own licenses"  on public.licenses            for all using (auth.uid() = issued_by);
create policy "own usage"     on public.license_usage       for select using (
  exists (select 1 from public.licenses l where l.id = license_id and l.issued_by = auth.uid())
);

-- ─── Print jobs ──────────────────────────────────────────────────────────────
create table if not exists public.print_jobs (
  id               uuid primary key default uuid_generate_v4(),
  nif_id           uuid references public.nif_files(id) on delete cascade not null,
  user_id          uuid references auth.users(id) on delete cascade not null,
  status           text not null default 'queued',
  progress         int  not null default 0,
  templates        text[] not null default '{}',
  current_template text,
  height_mm        numeric(8,2),
  voxel_res        int  default 128,
  results          jsonb default '{}',
  error_message    text,
  created_at       timestamptz default now(),
  completed_at     timestamptz
);

create index if not exists print_jobs_user_idx  on public.print_jobs(user_id);
create index if not exists print_jobs_nif_idx   on public.print_jobs(nif_id);
create index if not exists print_jobs_status_idx on public.print_jobs(status);

-- Add print columns to nif_files
alter table public.nif_files
  add column if not exists print_r2_keys  jsonb default '{}',
  add column if not exists print_stats    jsonb default '{}';

-- RLS
alter table public.print_jobs enable row level security;
drop policy if exists "own print jobs" on public.print_jobs;
create policy "own print jobs" on public.print_jobs for all using (auth.uid() = user_id);

-- Atomic print job claim (same skip-locked pattern as reconstruction)
create or replace function public.claim_next_print_job()
returns setof public.print_jobs language sql as $$
  update public.print_jobs
  set status='processing', progress=1
  where id = (
    select id from public.print_jobs
    where status='queued'
    order by created_at asc
    limit 1
    for update skip locked
  )
  returning *;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- NIF SOCIAL GRAPH — follows, reactions, comments, presence, notifications
-- ═══════════════════════════════════════════════════════════════════════════════

-- Profiles (extends auth.users)
alter table public.profiles
  add column if not exists username      text unique,
  add column if not exists display_name  text,
  add column if not exists avatar_url    text,
  add column if not exists bio           text,
  add column if not exists website       text,
  add column if not exists vertical      text,
  add column if not exists verified      boolean default false;

create unique index if not exists profiles_username_idx on public.profiles(lower(username));

-- Follows
create table if not exists public.follows (
  id           uuid primary key default uuid_generate_v4(),
  follower_id  uuid references auth.users(id) on delete cascade not null,
  following_id uuid references auth.users(id) on delete cascade not null,
  created_at   timestamptz default now(),
  unique(follower_id, following_id),
  check(follower_id <> following_id)
);
create index if not exists follows_follower_idx  on public.follows(follower_id);
create index if not exists follows_following_idx on public.follows(following_id);
alter table public.follows enable row level security;
create policy "anyone can read follows" on public.follows for select using (true);
create policy "own follows" on public.follows for all using (auth.uid() = follower_id);

-- Reactions — moment-anchored (can react to a specific timestamp + position)
create table if not exists public.nif_reactions (
  id           uuid primary key default uuid_generate_v4(),
  nif_id       uuid references public.nif_files(id) on delete cascade not null,
  user_id      uuid references auth.users(id) on delete cascade not null,
  reaction     text not null,
  moment_time  numeric(10,3),           -- timestamp in seconds (null = whole NIF)
  position_x   real,                    -- 3D world position (null = no position)
  position_y   real,
  position_z   real,
  created_at   timestamptz default now(),
  unique(nif_id, user_id, reaction)
);
create index if not exists reactions_nif_idx  on public.nif_reactions(nif_id);
create index if not exists reactions_user_idx on public.nif_reactions(user_id);
create index if not exists reactions_moment_idx on public.nif_reactions(nif_id, moment_time);
alter table public.nif_reactions enable row level security;
create policy "anyone can read reactions" on public.nif_reactions for select using (true);
create policy "own reactions" on public.nif_reactions for all using (auth.uid() = user_id);

-- Comments — spatial + temporal anchoring
create table if not exists public.nif_comments (
  id           uuid primary key default uuid_generate_v4(),
  nif_id       uuid references public.nif_files(id) on delete cascade not null,
  user_id      uuid references auth.users(id) on delete cascade not null,
  text         text not null check(length(text) between 1 and 2000),
  parent_id    uuid references public.nif_comments(id) on delete cascade,
  moment_time  numeric(10,3),
  position_x   real,
  position_y   real,
  position_z   real,
  edited       boolean default false,
  created_at   timestamptz default now()
);
create index if not exists comments_nif_idx    on public.nif_comments(nif_id, created_at);
create index if not exists comments_parent_idx on public.nif_comments(parent_id);
alter table public.nif_comments enable row level security;
create policy "anyone can read comments" on public.nif_comments for select
  using (exists(select 1 from nif_files where id=nif_id and is_public=true)
    or nif_id in (select id from nif_files where user_id=auth.uid()));
create policy "own comments" on public.nif_comments for all using (auth.uid() = user_id);

-- Notifications
create table if not exists public.nif_notifications (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid references auth.users(id) on delete cascade not null,
  type        text not null,  -- 'reaction','comment','follow','fork','mention'
  from_user   uuid references auth.users(id) on delete set null,
  nif_id      uuid references public.nif_files(id) on delete cascade,
  comment_id  uuid references public.nif_comments(id) on delete cascade,
  read        boolean default false,
  meta        jsonb default '{}',
  created_at  timestamptz default now()
);
create index if not exists notifs_user_idx on public.nif_notifications(user_id, read, created_at desc);
alter table public.nif_notifications enable row level security;
create policy "own notifications" on public.nif_notifications for all using (auth.uid() = user_id);

-- Collections / playlists
create table if not exists public.nif_collections (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid references auth.users(id) on delete cascade not null,
  name        text not null,
  description text,
  is_public   boolean default true,
  created_at  timestamptz default now()
);
create table if not exists public.nif_collection_items (
  collection_id uuid references public.nif_collections(id) on delete cascade not null,
  nif_id        uuid references public.nif_files(id) on delete cascade not null,
  added_at      timestamptz default now(),
  primary key(collection_id, nif_id)
);
alter table public.nif_collections enable row level security;
create policy "public collections readable" on public.nif_collections
  for select using (is_public or auth.uid()=user_id);
create policy "own collections" on public.nif_collections
  for all using (auth.uid() = user_id);

-- Feed view: NIFs from people you follow
create or replace view public.nif_feed as
  select
    nf.*, p.username, p.display_name, p.avatar_url,
    (select count(*) from nif_reactions r where r.nif_id=nf.id) as reaction_count,
    (select count(*) from nif_comments c where c.nif_id=nf.id) as comment_count,
    f.follower_id as viewer_id
  from public.nif_files nf
  join public.profiles p on p.id=nf.user_id
  join public.follows f on f.following_id=nf.user_id
  where nf.is_public=true
  order by nf.created_at desc;

-- Trending NIFs (most reactions in last 48h)
create or replace view public.nif_trending as
  select
    nf.id, nf.title, nf.vertical, nf.thumbnail_url, nf.view_count,
    nf.user_id, nf.created_at,
    p.username, p.display_name, p.avatar_url,
    count(r.id) as reaction_count
  from public.nif_files nf
  join public.profiles p on p.id=nf.user_id
  left join public.nif_reactions r
    on r.nif_id=nf.id and r.created_at > now()-interval '48 hours'
  where nf.is_public=true
  group by nf.id, p.id
  order by reaction_count desc, nf.view_count desc;

-- Moment highlights: moments with most reactions (crowd-sourced highlights)
create or replace view public.nif_moment_highlights as
  select
    nif_id,
    moment_time,
    reaction,
    count(*) as reaction_count,
    avg(position_x) as pos_x,
    avg(position_y) as pos_y,
    avg(position_z) as pos_z
  from public.nif_reactions
  where moment_time is not null
  group by nif_id, moment_time, reaction
  having count(*) >= 2
  order by reaction_count desc;

-- Fork a NIF (remix with attribution)
create or replace function public.fork_nif(
  source_nif_id uuid, new_title text, new_owner_id uuid
) returns uuid language plpgsql security definer as $$
declare
  new_id uuid := uuid_generate_v4();
  src record;
begin
  select * into src from public.nif_files where id=source_nif_id and is_public=true;
  if not found then raise exception 'NIF not found or not public'; end if;
  insert into public.nif_files(id,user_id,title,vertical,is_public,r2_key,meta)
  values(new_id, new_owner_id, new_title, src.vertical, false, src.r2_key,
    jsonb_build_object('forked_from',source_nif_id,'original_title',src.title));
  insert into public.nif_notifications(user_id,type,from_user,nif_id)
  values(src.user_id,'fork',new_owner_id,source_nif_id);
  return new_id;
end;$$;

-- Auto-notify on new comment
create or replace function public.notify_on_comment()
returns trigger language plpgsql security definer as $$
declare nif_owner uuid;
begin
  select user_id into nif_owner from nif_files where id=new.nif_id;
  if nif_owner <> new.user_id then
    insert into nif_notifications(user_id,type,from_user,nif_id,comment_id)
    values(nif_owner,'comment',new.user_id,new.nif_id,new.id);
  end if;
  return new;
end;$$;
drop trigger if exists on_comment on public.nif_comments;
create trigger on_comment after insert on public.nif_comments
  for each row execute function notify_on_comment();

-- Auto-notify on new follow
create or replace function public.notify_on_follow()
returns trigger language plpgsql security definer as $$
begin
  insert into nif_notifications(user_id,type,from_user)
  values(new.following_id,'follow',new.follower_id)
  on conflict do nothing;
  return new;
end;$$;
drop trigger if exists on_follow on public.follows;
create trigger on_follow after insert on public.follows
  for each row execute function notify_on_follow();
