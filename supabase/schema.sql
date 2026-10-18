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

create table if not exists public.family_photo_metadata (
  storage_path text primary key,
  gps_latitude double precision,
  gps_longitude double precision,
  city text,
  country text,
  trip text,
  year text,
  notes text,
  people text[],
  owner uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (gps_latitude is null and gps_longitude is null)
    or (
      gps_latitude is not null
      and gps_longitude is not null
      and gps_latitude between -90 and 90
      and gps_longitude between -180 and 180
    )
  )
);

alter table public.family_photo_metadata
  add column if not exists people text[];

create index if not exists family_photo_metadata_people_idx
  on public.family_photo_metadata using gin (people);

alter table public.family_photo_metadata enable row level security;

drop policy if exists "Signed-in family can read own photo metadata" on public.family_photo_metadata;
create policy "Signed-in family can read own photo metadata"
  on public.family_photo_metadata for select
  to authenticated
  using ((storage.foldername(storage_path))[1] = auth.uid()::text);

drop policy if exists "Signed-in family can create own photo metadata" on public.family_photo_metadata;
create policy "Signed-in family can create own photo metadata"
  on public.family_photo_metadata for insert
  to authenticated
  with check (
    (storage.foldername(storage_path))[1] = auth.uid()::text
    and (owner is null or owner = auth.uid())
  );

drop policy if exists "Signed-in family can update own photo metadata" on public.family_photo_metadata;
create policy "Signed-in family can update own photo metadata"
  on public.family_photo_metadata for update
  to authenticated
  using ((storage.foldername(storage_path))[1] = auth.uid()::text)
  with check (
    (storage.foldername(storage_path))[1] = auth.uid()::text
    and (owner is null or owner = auth.uid())
  );

drop policy if exists "Signed-in family can delete own photo metadata" on public.family_photo_metadata;
create policy "Signed-in family can delete own photo metadata"
  on public.family_photo_metadata for delete
  to authenticated
  using ((storage.foldername(storage_path))[1] = auth.uid()::text);

grant select, insert, update, delete on public.family_photo_metadata to authenticated;

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
