-- Run in Supabase SQL Editor after confirming public.planner_data exists.
-- WARNING: this replaces ALL existing policies on public.planner_data with owner-only policies.
-- It does not modify rows or the table schema.
alter table public.planner_data enable row level security;

do $$
declare p record;
begin
  for p in
    select policyname
    from pg_policies
    where schemaname = 'public' and tablename = 'planner_data'
  loop
    execute format('drop policy if exists %I on public.planner_data', p.policyname);
  end loop;
end $$;

create policy "Users can read their own planner data"
  on public.planner_data for select to authenticated
  using (auth.uid() = user_id);

create policy "Users can insert their own planner data"
  on public.planner_data for insert to authenticated
  with check (auth.uid() = user_id);

create policy "Users can update their own planner data"
  on public.planner_data for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete their own planner data"
  on public.planner_data for delete to authenticated
  using (auth.uid() = user_id);

grant select, insert, update, delete on public.planner_data to authenticated;
