-- ADB Smart — ecosistema Annunci
create extension if not exists pgcrypto;

create table if not exists public.adb_annunci (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('job','client','marketplace','service')),
  title text not null check (char_length(title) between 2 and 80),
  company text not null check (char_length(company) between 2 and 80),
  location text not null,
  category text,
  price_label text,
  work_mode text,
  extra text,
  contact text,
  description text not null,
  image_url text,
  image_path text,
  badge text check (badge is null or badge in ('new','urgent','sponsored')),
  promotion text not null default 'standard' check (promotion in ('standard','featured','sponsored')),
  visibility text not null default 'public' check (visibility in ('public','draft','archived')),
  author_kind text not null default 'fleet' check (author_kind in ('fleet','admin')),
  author_fleet_slug text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days')
);

create index if not exists adb_annunci_type_idx on public.adb_annunci(type, visibility, created_at desc);
create index if not exists adb_annunci_fleet_idx on public.adb_annunci(author_fleet_slug, created_at desc);
create index if not exists adb_annunci_promo_idx on public.adb_annunci(promotion, created_at desc);

create or replace function public.adb_annunci_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists adb_annunci_touch on public.adb_annunci;
create trigger adb_annunci_touch before update on public.adb_annunci
for each row execute function public.adb_annunci_touch_updated_at();

alter table public.adb_annunci enable row level security;
-- Nessun accesso diretto dal browser: tutte le operazioni passano dalla Edge Function annunci.
revoke all on public.adb_annunci from anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('adb-annunci','adb-annunci',true,10240,array['image/webp','image/jpeg','image/png'])
on conflict (id) do update set public=true, file_size_limit=10240, allowed_mime_types=array['image/webp','image/jpeg','image/png'];
