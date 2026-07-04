-- NIF Social Schema
-- fumoca.co.za · © Fumoca Technologies
-- Run after schema_extended.sql

-- ─── Public profile extensions ────────────────────────────────────────────────
alter table public.profiles
  add column if not exists username        text unique,
  add column if not exists display_name   text,
  add column if not exists bio            text,
  add column if not exists avatar_url     text,
  add column if not exists website        text,
  add column if not exists is_brand       boolean not null default false,
  add column if not exists brand_color    text,        -- hex, for brand theming
  add column if not exists verified       boolean not null default false,
  add column if not exists follower_count int     not null default 0,
  add column if not exists following_count int    not null default 0,
  add column if not exists nif_count      int     not null default 0,
  add column if not exists total_views    bigint  not null default 0;

create index if not exists profiles_username_idx on public.profiles(username) where username is not null;
create index if not exists profiles_brand_idx    on public.profiles(is_brand) where is_brand = true;

-- ─── Follows ─────────────────────────────────────────────────────────────────
create table if not exists public.follows (
  follower_id uuid references auth.users(id) on delete cascade not null,
  following_id uuid references auth.users(id) on delete cascade not null,
  created_at  timestamptz default now(),
  primary key (follower_id, following_id),
  constraint no_self_follow check (follower_id <> following_id)
);

create index if not exists follows_follower_idx  on public.follows(follower_id);
create index if not exists follows_following_idx on public.follows(following_id);

alter table public.follows enable row level security;
create policy "view follows"   on public.follows for select using (true);
create policy "manage follows" on public.follows for all   using (auth.uid() = follower_id);

-- Update follower/following counts atomically
create or replace function public.handle_follow()
returns trigger language plpgsql security definer as $$
begin
  if tg_op = 'INSERT' then
    update public.profiles set follower_count  = follower_count  + 1 where id = new.following_id;
    update public.profiles set following_count = following_count + 1 where id = new.follower_id;
    -- Notify the followed user
    perform public.create_notification(
      new.following_id, 'new_follower', 'New follower',
      (select coalesce(display_name, username, email) from public.profiles where id = new.follower_id) || ' started following you',
      '/u/' || (select username from public.profiles where id = new.follower_id),
      json_build_object('followerId', new.follower_id)::jsonb
    );
  elsif tg_op = 'DELETE' then
    update public.profiles set follower_count  = greatest(0, follower_count  - 1) where id = old.following_id;
    update public.profiles set following_count = greatest(0, following_count - 1) where id = old.follower_id;
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists on_follow_change on public.follows;
create trigger on_follow_change
  after insert or delete on public.follows
  for each row execute function public.handle_follow();

-- ─── NIF Likes ───────────────────────────────────────────────────────────────
create table if not exists public.nif_likes (
  user_id uuid references auth.users(id) on delete cascade not null,
  nif_id  uuid references public.nif_files(id) on delete cascade not null,
  created_at timestamptz default now(),
  primary key (user_id, nif_id)
);

create index if not exists likes_nif_idx  on public.nif_likes(nif_id);
create index if not exists likes_user_idx on public.nif_likes(user_id);

alter table public.nif_likes enable row level security;
create policy "view likes"   on public.nif_likes for select using (true);
create policy "manage likes" on public.nif_likes for all   using (auth.uid() = user_id);

-- Add like_count to nif_files
alter table public.nif_files
  add column if not exists like_count  int    not null default 0,
  add column if not exists view_count  int    not null default 0,
  add column if not exists save_count  int    not null default 0,
  add column if not exists description text,
  add column if not exists tags        text[] default '{}',
  add column if not exists thumbnail_url text;

create or replace function public.handle_like()
returns trigger language plpgsql security definer as $$
begin
  if tg_op = 'INSERT' then
    update public.nif_files set like_count = like_count + 1 where id = new.nif_id;
  elsif tg_op = 'DELETE' then
    update public.nif_files set like_count = greatest(0, like_count - 1) where id = old.nif_id;
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists on_like_change on public.nif_likes;
create trigger on_like_change
  after insert or delete on public.nif_likes
  for each row execute function public.handle_like();

-- ─── NIF Saves (bookmarks) ────────────────────────────────────────────────────
create table if not exists public.nif_saves (
  user_id uuid references auth.users(id) on delete cascade not null,
  nif_id  uuid references public.nif_files(id) on delete cascade not null,
  created_at timestamptz default now(),
  primary key (user_id, nif_id)
);

alter table public.nif_saves enable row level security;
create policy "own saves" on public.nif_saves for all using (auth.uid() = user_id);

-- ─── Comments ────────────────────────────────────────────────────────────────
create table if not exists public.nif_comments (
  id          uuid primary key default uuid_generate_v4(),
  nif_id      uuid references public.nif_files(id) on delete cascade not null,
  user_id     uuid references auth.users(id) on delete cascade not null,
  parent_id   uuid references public.nif_comments(id) on delete cascade, -- for threads
  body        text not null check (length(body) > 0 and length(body) <= 1000),
  like_count  int not null default 0,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

create index if not exists comments_nif_idx on public.nif_comments(nif_id, created_at desc);
create index if not exists comments_user_idx on public.nif_comments(user_id);
create index if not exists comments_parent_idx on public.nif_comments(parent_id) where parent_id is not null;

alter table public.nif_comments enable row level security;
create policy "view comments" on public.nif_comments for select using (true);
create policy "own comments"  on public.nif_comments for all   using (auth.uid() = user_id);

-- ─── Feed (materialised social feed) ─────────────────────────────────────────
-- A view that shows public NIFs from users you follow, ordered by time.
-- For performance: paginated, uses covering index.

create or replace view public.social_feed as
  select
    nf.id,
    nf.title,
    nf.description,
    nf.thumbnail_url,
    nf.vertical,
    nf.gaussian_count,
    nf.like_count,
    nf.view_count,
    nf.tags,
    nf.created_at,
    nf.user_id,
    p.username,
    p.display_name,
    p.avatar_url,
    p.is_brand,
    p.verified
  from public.nif_files nf
  join public.profiles p on p.id = nf.user_id
  where nf.is_public = true
  order by nf.created_at desc;

-- ─── Discover feed (trending — high views + likes in last 7 days) ─────────────
create or replace view public.discover_feed as
  select
    nf.*,
    p.username, p.display_name, p.avatar_url, p.is_brand, p.verified,
    (nf.like_count * 3 + nf.view_count) as score
  from public.nif_files nf
  join public.profiles p on p.id = nf.user_id
  where nf.is_public = true
    and nf.created_at > now() - interval '7 days'
  order by score desc;

-- ─── Username validation ──────────────────────────────────────────────────────
create or replace function public.is_valid_username(u text)
returns boolean language plpgsql as $$
begin
  return u ~ '^[a-z0-9_]{3,30}$' and u not in (
    'admin','api','www','app','mail','nif','fumoca','support','help',
    'about','terms','privacy','legal','careers','jobs','press'
  );
end;
$$;

alter table public.profiles
  add constraint username_format check (username is null or public.is_valid_username(username));

-- ─── RLS: public profiles readable by anyone ──────────────────────────────────
drop policy if exists "public profiles" on public.profiles;
create policy "public profiles" on public.profiles for select using (true);

-- ─── increment_nif_count helper ────────────────────────────────────────────────
create or replace function public.increment_nif_count(p_user_id uuid)
returns void language plpgsql security definer as $$
begin
  update public.profiles set nif_count = nif_count + 1 where id = p_user_id;
end;
$$;

-- ─── Discover search (full-text on title + description + tags) ─────────────────
alter table public.nif_files
  add column if not exists search_vector tsvector
    generated always as (
      setweight(to_tsvector('english', coalesce(title,'')), 'A') ||
      setweight(to_tsvector('english', coalesce(description,'')), 'B') ||
      setweight(to_tsvector('english', coalesce(array_to_string(tags,' '),'')), 'C')
    ) stored;

create index if not exists nif_search_idx on public.nif_files using gin(search_vector);

-- Search function
create or replace function public.search_nifs(query text, lim int default 20, off int default 0)
returns setof public.nif_files language sql stable as $$
  select * from public.nif_files
  where is_public = true
    and search_vector @@ plainto_tsquery('english', query)
  order by ts_rank(search_vector, plainto_tsquery('english', query)) desc,
           like_count desc
  limit lim offset off;
$$;
