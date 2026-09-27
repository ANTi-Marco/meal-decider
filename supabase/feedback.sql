create table if not exists public.meal_feedback (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  category text not null check (category in ('recommendation', 'home-cooking', 'draw', 'usability', 'other')),
  message text not null check (char_length(message) between 5 and 1200),
  contact text check (contact is null or char_length(contact) <= 120),
  page_path text not null default '/' check (char_length(page_path) <= 160)
);

alter table public.meal_feedback enable row level security;
revoke all on table public.meal_feedback from anon, authenticated;
grant usage on schema public to service_role;
grant insert on table public.meal_feedback to service_role;
