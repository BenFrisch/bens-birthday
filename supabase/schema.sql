create table if not exists public.family_app_state (
  id text primary key check (id = 'shared'),
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  updated_from text not null default ''
);

alter table public.family_app_state
  add column if not exists updated_from text not null default '';

alter table public.family_app_state enable row level security;

drop policy if exists "Signed-in family can read shared app state" on public.family_app_state;
create policy "Signed-in family can read shared app state"
  on public.family_app_state for select
  to authenticated
  using (id = 'shared');

drop policy if exists "Signed-in family can create shared app state" on public.family_app_state;
create policy "Signed-in family can create shared app state"
  on public.family_app_state for insert
  to authenticated
  with check (id = 'shared' and updated_by = auth.uid());

drop policy if exists "Signed-in family can update shared app state" on public.family_app_state;
create policy "Signed-in family can update shared app state"
  on public.family_app_state for update
  to authenticated
  using (id = 'shared')
  with check (id = 'shared' and updated_by = auth.uid());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('family-photos', 'family-photos', false, 20971520, array['image/webp'])
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Signed-in family can read private photos" on storage.objects;
create policy "Signed-in family can read private photos"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'family-photos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Signed-in family can upload private photos" on storage.objects;
create policy "Signed-in family can upload private photos"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'family-photos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Signed-in family can update private photos" on storage.objects;
create policy "Signed-in family can update private photos"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'family-photos' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'family-photos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Signed-in family can delete private photos" on storage.objects;
create policy "Signed-in family can delete private photos"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'family-photos' and (storage.foldername(name))[1] = auth.uid()::text);

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'family_app_state'
  ) then
    alter publication supabase_realtime add table public.family_app_state;
  end if;
end
$$;
