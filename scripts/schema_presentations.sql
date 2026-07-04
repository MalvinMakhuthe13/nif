-- NIF Presentation Schema
-- Append to scripts/schema.sql or run separately in Supabase SQL Editor
-- fumoca.co.za · © Fumoca Technologies

-- ─── Presentations ────────────────────────────────────────────────────────────
-- A presentation is a non-destructive styling layer on top of a NIF file.
-- It stores a camera path, hotspots, and export settings.
-- The original NIF file is never modified.

create table if not exists public.presentations (
  id                     uuid primary key default uuid_generate_v4(),
  user_id                uuid references auth.users(id) on delete cascade not null,
  nif_id                 uuid references public.nif_files(id) on delete cascade not null,

  -- Basic metadata
  title                  text not null default 'Untitled Presentation',
  duration               float not null default 10,
  fps                    int   not null default 30,
  loop_type              text  not null default 'pingpong',   -- loop | pingpong | once

  -- Visual settings
  bg_color               text  not null default '#000000',
  bg_opacity             float not null default 1.0,
  logo_url               text,
  logo_position          text  not null default 'bottom-right',
  show_watermark         boolean not null default true,

  -- Non-destructive edit data
  -- camera_path: { duration, keyframes:[{t,phi,theta,radius,targetX,targetY,targetZ}], autoOrbit }
  camera_path            jsonb,
  -- hotspots: [{id,label,style,color,fontSize,worldX,worldY,worldZ,visible}]
  hotspots               jsonb not null default '[]',

  -- Export state
  exported_video_r2_key  text,
  exported_video_url     text,
  share_url              text,

  -- Frame upload state (for server-side ffmpeg assembly fallback)
  meta                   jsonb not null default '{}',

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists presentations_user_idx   on public.presentations(user_id);
create index if not exists presentations_nif_idx    on public.presentations(nif_id);
create index if not exists presentations_updated_idx on public.presentations(updated_at desc);

-- Auto-update updated_at
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists presentations_updated_at on public.presentations;
create trigger presentations_updated_at
  before update on public.presentations
  for each row execute function public.set_updated_at();

-- RLS
alter table public.presentations enable row level security;

drop policy if exists "own presentations"        on public.presentations;
drop policy if exists "public presentation share" on public.presentations;

-- Owner: full access
create policy "own presentations"
  on public.presentations
  for all
  using (auth.uid() = user_id);

-- Public share: anyone can read a presentation that has a share_url set
create policy "public presentation share"
  on public.presentations
  for select
  using (share_url is not null);

-- ─── Atomic claim for future GPU-rendered presentations ───────────────────────
-- (reserved for when server-side rendering is added)
create or replace function public.claim_next_presentation_render()
returns setof public.presentations language sql as $$
  update public.presentations
  set meta = meta || '{"render_status":"processing"}'::jsonb
  where id = (
    select id from public.presentations
    where meta->>'render_status' = 'queued'
    order by created_at asc
    limit 1
    for update skip locked
  )
  returning *;
$$;

-- ─── Audio additions (run after initial schema) ───────────────────────────────
alter table public.presentations
  add column if not exists audio              jsonb,         -- NIFAudioLayer.exportState()
  add column if not exists exported_audio_r2_key text;       -- mixed WAV in R2
