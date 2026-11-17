-- Supabase > SQL Editor ga qo'yib, "Run" ni bosing (bir marta).

create table if not exists public.users (
  id bigint generated always as identity primary key,
  full_name text not null,
  grade text not null,
  email text unique,
  password text,
  role text not null default 'student',
  telegram_id bigint unique,
  created_at timestamptz not null default now()
);

create table if not exists public.certificates (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.users(id) on delete cascade,
  title text not null,
  score text,
  issued_date date,
  original_name text not null,
  storage_path text not null,
  file_hash text,
  source text not null default 'web',
  created_at timestamptz not null default now(),
  unique (user_id, file_hash)
);

create table if not exists public.bot_sessions (
  telegram_id bigint primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

create index if not exists certificates_user_idx on public.certificates(user_id);

-- Jadvallarga to'g'ridan-to'g'ri (brauzerdan) kirishni yopish.
-- Server service_role kaliti bilan ishlaydi va bu cheklovni chetlab o'tadi.
alter table public.users enable row level security;
alter table public.certificates enable row level security;
alter table public.bot_sessions enable row level security;
