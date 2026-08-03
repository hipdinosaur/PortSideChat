-- Hybrid RAG schema for Backcountry Marketing Podcast transcripts
-- Run in Supabase SQL editor after enabling the vector extension.
-- Safe to re-run for functions/policies. Does NOT drop chunks (that would wipe RAG).
-- For a clean chunks rebuild, drop manually then re-upload + re-embed.

create extension if not exists vector;

-- ---------------------------------------------------------------------------
-- Episodes (one row per CMS podcast-feed item)
-- ---------------------------------------------------------------------------
create table if not exists public.episodes (
  id uuid primary key default gen_random_uuid(),
  cms_item_id text not null unique,
  podcast_index integer,
  name text not null,
  slug text not null unique,
  web_url text not null,
  guest_name text,
  guest_title text,
  categories text[] not null default '{}',
  short_description text,
  show_notes_html text,
  podcast_length text,
  spotify_embed text,
  next_slug text,
  published_at timestamptz,
  has_transcript boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists episodes_podcast_index_idx on public.episodes (podcast_index);
create index if not exists episodes_categories_gin on public.episodes using gin (categories);
create index if not exists episodes_guest_name_idx on public.episodes (guest_name);

-- array_to_string is STABLE; generated columns require IMMUTABLE helpers.
create or replace function public.immutable_array_to_string(arr text[], sep text)
returns text
language sql
immutable
parallel safe
as $$
  select array_to_string(arr, sep);
$$;

create or replace function public.chunk_fts(
  episode_name text,
  guest_name text,
  categories text[],
  content text
)
returns tsvector
language sql
immutable
parallel safe
as $$
  select
    setweight(to_tsvector('english'::regconfig, coalesce(episode_name, '')), 'A') ||
    setweight(to_tsvector('english'::regconfig, coalesce(guest_name, '')), 'A') ||
    setweight(
      to_tsvector(
        'english'::regconfig,
        coalesce(public.immutable_array_to_string(categories, ' '), '')
      ),
      'B'
    ) ||
    setweight(to_tsvector('english'::regconfig, coalesce(content, '')), 'C');
$$;

-- Chunks already exist in production — do not drop on re-run.
-- If you need a clean rebuild: DROP TABLE public.chunks CASCADE; then re-run
-- this file and re-upload + re-embed from Transcripts/supabase-ready/.
create table if not exists public.chunks (
  id uuid primary key default gen_random_uuid(),
  episode_id uuid not null references public.episodes (id) on delete cascade,
  cms_item_id text not null,
  chunk_index integer not null,
  content text not null,
  token_estimate integer not null default 0,
  speakers text[] not null default '{}',
  start_timestamp text,
  end_timestamp text,
  -- Denormalized episode metadata for filter/boost without joins
  podcast_index integer,
  episode_name text not null,
  slug text not null,
  web_url text not null,
  guest_name text,
  guest_title text,
  categories text[] not null default '{}',
  short_description text,
  podcast_length text,
  -- Hybrid search columns
  fts tsvector generated always as (
    public.chunk_fts(episode_name, guest_name, categories, content)
  ) stored,
  embedding vector(1536),
  created_at timestamptz not null default now(),
  unique (episode_id, chunk_index)
);

create index if not exists chunks_episode_id_idx on public.chunks (episode_id);
create index if not exists chunks_cms_item_id_idx on public.chunks (cms_item_id);
create index if not exists chunks_categories_gin on public.chunks using gin (categories);
create index if not exists chunks_fts_gin on public.chunks using gin (fts);
-- Create after embeddings are populated:
create index if not exists chunks_embedding_hnsw on public.chunks
  using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64);

-- Batch embedding updates (service role / trusted callers only)
create or replace function public.update_chunk_embeddings(items jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  updated integer;
begin
  update public.chunks c
  set embedding = (x.embedding)::vector(1536)
  from jsonb_to_recordset(items) as x(id uuid, embedding text)
  where c.id = x.id;

  get diagnostics updated = row_count;
  return updated;
end;
$$;

revoke all on function public.update_chunk_embeddings(jsonb) from public;
grant execute on function public.update_chunk_embeddings(jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Hybrid match: vector similarity + full-text, optional category filter
-- ---------------------------------------------------------------------------
create or replace function public.match_chunks(
  query_embedding vector(1536),
  query_text text,
  match_count int default 8,
  filter_categories text[] default null,
  full_text_weight float default 1.0,
  semantic_weight float default 1.0,
  rrf_k int default 50
)
returns table (
  id uuid,
  episode_id uuid,
  cms_item_id text,
  chunk_index int,
  content text,
  speakers text[],
  start_timestamp text,
  end_timestamp text,
  podcast_index int,
  episode_name text,
  slug text,
  web_url text,
  guest_name text,
  guest_title text,
  categories text[],
  short_description text,
  podcast_length text,
  score float
)
language sql
stable
as $$
  with semantic as (
    select
      c.id,
      row_number() over (order by c.embedding <=> query_embedding) as rank
    from public.chunks c
    where c.embedding is not null
      and (
        filter_categories is null
        or cardinality(filter_categories) = 0
        or c.categories && filter_categories
      )
    order by c.embedding <=> query_embedding
    limit least(match_count * 4, 40)
  ),
  keyword as (
    select
      c.id,
      row_number() over (
        order by ts_rank_cd(c.fts, websearch_to_tsquery('english', query_text)) desc
      ) as rank
    from public.chunks c
    where query_text is not null
      and length(trim(query_text)) > 0
      and c.fts @@ websearch_to_tsquery('english', query_text)
      and (
        filter_categories is null
        or cardinality(filter_categories) = 0
        or c.categories && filter_categories
      )
    order by ts_rank_cd(c.fts, websearch_to_tsquery('english', query_text)) desc
    limit least(match_count * 4, 40)
  ),
  fused as (
    select
      coalesce(s.id, k.id) as id,
      coalesce(1.0 / (rrf_k + s.rank), 0) * semantic_weight
        + coalesce(1.0 / (rrf_k + k.rank), 0) * full_text_weight as score
    from semantic s
    full outer join keyword k on s.id = k.id
  )
  select
    c.id,
    c.episode_id,
    c.cms_item_id,
    c.chunk_index,
    c.content,
    c.speakers,
    c.start_timestamp,
    c.end_timestamp,
    c.podcast_index,
    c.episode_name,
    c.slug,
    c.web_url,
    c.guest_name,
    c.guest_title,
    c.categories,
    c.short_description,
    c.podcast_length,
    f.score::float
  from fused f
  join public.chunks c on c.id = f.id
  order by f.score desc
  limit match_count;
$$;

-- Read-only access for anon/authenticated if using client-side reads later.
-- Prefer server-side service role for ingest + chat API.
alter table public.episodes enable row level security;
alter table public.chunks enable row level security;

drop policy if exists "Public read episodes" on public.episodes;
drop policy if exists "Public read chunks" on public.chunks;

create policy "Public read episodes"
  on public.episodes for select
  to anon, authenticated
  using (true);

create policy "Public read chunks"
  on public.chunks for select
  to anon, authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- Anonymous prompt sampling (max 10 per UTC day, write-only via RPC)
-- ---------------------------------------------------------------------------
create table if not exists public.anonymous_prompt_samples (
  id uuid primary key default gen_random_uuid(),
  prompt text not null,
  created_at timestamptz not null default now()
);

create index if not exists anonymous_prompt_samples_created_at_idx
  on public.anonymous_prompt_samples (created_at desc);

create table if not exists public.anonymous_prompt_daily (
  day date primary key,
  sample_count integer not null default 0
    check (sample_count >= 0 and sample_count <= 10)
);

alter table public.anonymous_prompt_samples enable row level security;
alter table public.anonymous_prompt_daily enable row level security;

-- No policies for anon/authenticated: table access is via service role or
-- the security-definer RPC below.

create or replace function public.try_sample_anonymous_prompt(p_prompt text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  d date := (timezone('utc', now()))::date;
  allowed boolean;
  cleaned text;
begin
  cleaned := left(trim(coalesce(p_prompt, '')), 2000);
  if cleaned = '' then
    return false;
  end if;

  -- Redact obvious email/phone here (not just in the calling API layer) so
  -- the RPC is safe even when invoked directly with the public anon key.
  cleaned := regexp_replace(
    cleaned,
    '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}',
    '[email]',
    'g'
  );
  cleaned := regexp_replace(
    cleaned,
    '(\+?\d{1,3}[-.\s]?)?(\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}',
    '[phone]',
    'g'
  );

  insert into public.anonymous_prompt_daily (day, sample_count)
  values (d, 0)
  on conflict (day) do nothing;

  update public.anonymous_prompt_daily
  set sample_count = sample_count + 1
  where day = d
    and sample_count < 10
  returning true into allowed;

  if not coalesce(allowed, false) then
    return false;
  end if;

  insert into public.anonymous_prompt_samples (prompt)
  values (cleaned);

  return true;
end;
$$;

revoke all on function public.try_sample_anonymous_prompt(text) from public;
grant execute on function public.try_sample_anonymous_prompt(text)
  to anon, authenticated;
