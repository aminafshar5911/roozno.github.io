-- Roozno incremental social/profile/weekly XP migration.
-- Additive: does not drop or rewrite planner_data or existing planner content.
-- Run only after taking a database backup.

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text null check (display_name is null or char_length(btrim(display_name)) between 2 and 40),
  lifetime_xp bigint not null default 0 check (lifetime_xp >= 0),
  public_streak integer not null default 0 check (public_streak >= 0),
  public_achievements jsonb not null default '[]'::jsonb check (jsonb_typeof(public_achievements) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
drop policy if exists "Authenticated users can view public profiles" on public.profiles;
create policy "Authenticated users can view public profiles"
  on public.profiles for select to authenticated using (true);
drop policy if exists "Users can create own profile" on public.profiles;
create policy "Users can create own profile"
  on public.profiles for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "Users can update own display name" on public.profiles;
create policy "Users can update own display name"
  on public.profiles for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
revoke all on public.profiles from anon, authenticated;
grant select (user_id, display_name, public_streak, public_achievements) on public.profiles to authenticated;
grant insert (user_id, display_name) on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;

-- Automatically provision a profile when a Supabase Auth user is created.
create or replace function public.roozno_create_profile_for_auth_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(user_id, display_name)
  values (new.id, null)
  on conflict (user_id) do nothing;
  return new;
end;
$$;
drop trigger if exists roozno_auth_user_profile on auth.users;
create trigger roozno_auth_user_profile after insert on auth.users
for each row execute function public.roozno_create_profile_for_auth_user();

create table if not exists public.friend_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles(user_id) on delete cascade,
  addressee_id uuid not null references public.profiles(user_id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted','rejected','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint friend_requests_not_self check (requester_id <> addressee_id)
);
create index if not exists friend_requests_addressee_status_idx on public.friend_requests(addressee_id, status, created_at desc);
create index if not exists friend_requests_requester_status_idx on public.friend_requests(requester_id, status, created_at desc);
create unique index if not exists friend_requests_one_pending_pair_idx
  on public.friend_requests(least(requester_id, addressee_id), greatest(requester_id, addressee_id)) where status = 'pending';
alter table public.friend_requests enable row level security;
drop policy if exists "Users can view their own friend requests" on public.friend_requests;
create policy "Users can view their own friend requests" on public.friend_requests
  for select to authenticated using (auth.uid() = requester_id or auth.uid() = addressee_id);
drop policy if exists "Users can send friend requests as themselves" on public.friend_requests;
create policy "Users can send friend requests as themselves" on public.friend_requests
  for insert to authenticated with check (auth.uid() = requester_id and requester_id <> addressee_id and status = 'pending');
revoke update, delete on public.friend_requests from authenticated;
grant select, insert on public.friend_requests to authenticated;

create table if not exists public.friendships (
  user_low uuid not null references public.profiles(user_id) on delete cascade,
  user_high uuid not null references public.profiles(user_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(user_low, user_high),
  constraint friendships_ordered_pair check (user_low < user_high)
);
alter table public.friendships enable row level security;
drop policy if exists "Users can view their own friendships" on public.friendships;
create policy "Users can view their own friendships" on public.friendships
  for select to authenticated using (auth.uid() = user_low or auth.uid() = user_high);
revoke insert, update, delete on public.friendships from anon, authenticated;
grant select on public.friendships to authenticated;

create or replace function public.accept_friend_request(p_request_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.friend_requests%rowtype; a uuid; b uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into r from public.friend_requests where id = p_request_id for update;
  if not found or r.addressee_id <> auth.uid() or r.status <> 'pending' then raise exception 'Request unavailable'; end if;
  a := least(r.requester_id, r.addressee_id); b := greatest(r.requester_id, r.addressee_id);
  insert into public.friendships(user_low,user_high) values(a,b) on conflict do nothing;
  update public.friend_requests set status='accepted', updated_at=now() where id=p_request_id;
  update public.friend_requests set status='cancelled', updated_at=now()
    where status='pending' and least(requester_id,addressee_id)=a and greatest(requester_id,addressee_id)=b and id<>p_request_id;
end; $$;

create or replace function public.reject_friend_request(p_request_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  update public.friend_requests set status='rejected',updated_at=now()
    where id=p_request_id and addressee_id=auth.uid() and status='pending';
  if not found then raise exception 'Request unavailable'; end if;
end; $$;

create or replace function public.cancel_friend_request(p_request_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  update public.friend_requests set status='cancelled',updated_at=now()
    where id=p_request_id and requester_id=auth.uid() and status='pending';
  if not found then raise exception 'Request unavailable'; end if;
end; $$;

create or replace function public.remove_friend(p_friend_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare a uuid; b uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_friend_id = auth.uid() then raise exception 'Cannot remove self'; end if;
  a := least(auth.uid(),p_friend_id); b := greatest(auth.uid(),p_friend_id);
  delete from public.friendships where user_low=a and user_high=b;
  if not found then raise exception 'Friendship unavailable'; end if;
end; $$;

create or replace function public.list_my_friends()
returns table(user_id uuid, display_name text, public_streak integer, public_achievements jsonb)
language sql stable security invoker set search_path = '' as $$
  select p.user_id, p.display_name, p.public_streak, p.public_achievements
  from public.friendships f
  join public.profiles p on p.user_id = case when f.user_low = auth.uid() then f.user_high else f.user_low end
  where auth.uid() in (f.user_low, f.user_high)
  order by coalesce(p.display_name, ''), p.user_id;
$$;

revoke all on function public.accept_friend_request(uuid) from public, anon;
revoke all on function public.reject_friend_request(uuid) from public, anon;
revoke all on function public.cancel_friend_request(uuid) from public, anon;
revoke all on function public.remove_friend(uuid) from public, anon;
revoke all on function public.list_my_friends() from public, anon;
grant execute on function public.accept_friend_request(uuid) to authenticated;
grant execute on function public.reject_friend_request(uuid) to authenticated;
grant execute on function public.cancel_friend_request(uuid) to authenticated;
grant execute on function public.remove_friend(uuid) to authenticated;
grant execute on function public.list_my_friends() to authenticated;

-- New competitive season ledger. Existing client-side XP is intentionally not imported as trusted XP.
create table if not exists public.xp_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  event_key text not null,
  event_type text not null check (char_length(event_type) between 2 and 80),
  amount integer not null check (amount between 1 and 10000),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(user_id, event_key)
);
grant select on public.xp_events to service_role;
grant insert on public.xp_events to service_role;

create index if not exists xp_events_created_at_user_idx on public.xp_events(created_at desc, user_id);
alter table public.xp_events enable row level security;
revoke all on public.xp_events from anon, authenticated;

create table if not exists public.security_alerts (
  id bigint generated always as identity primary key,
  user_id uuid references public.profiles(user_id) on delete set null,
  reason text not null,
  evidence jsonb not null default '{}'::jsonb,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.security_alerts enable row level security;
revoke all on public.security_alerts from anon, authenticated;

create or replace function public.roozno_add_lifetime_xp()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.profiles set lifetime_xp=lifetime_xp+new.amount, updated_at=now() where user_id=new.user_id;
  return new;
end; $$;
drop trigger if exists xp_events_update_lifetime on public.xp_events;
create trigger xp_events_update_lifetime after insert on public.xp_events
for each row execute function public.roozno_add_lifetime_xp();

-- This is intentionally service-role-only. Do not grant it to authenticated clients.
create or replace function public.grant_verified_xp(
  p_user_id uuid, p_event_key text, p_event_type text, p_amount integer, p_metadata jsonb default '{}'::jsonb
) returns boolean language plpgsql security definer set search_path = '' as $$
declare inserted_count integer;
begin
  if p_user_id is null or p_event_key is null or length(p_event_key) < 3 or p_event_type is null
     or p_amount is null or p_amount < 1 or p_amount > 10000 then raise exception 'Invalid XP event'; end if;
  insert into public.xp_events(user_id,event_key,event_type,amount,metadata)
  values(p_user_id,p_event_key,p_event_type,p_amount,coalesce(p_metadata,'{}'::jsonb))
  on conflict(user_id,event_key) do nothing;
  get diagnostics inserted_count = row_count;
  return inserted_count = 1;
end; $$;
revoke all on function public.grant_verified_xp(uuid,text,text,integer,jsonb) from public, anon, authenticated;
grant execute on function public.grant_verified_xp(uuid,text,text,integer,jsonb) to service_role;

create or replace function public.get_weekly_leaderboard()
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare local_now timestamp; local_date date; start_date date; start_at timestamptz; end_at timestamptz; result jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  local_now := now() at time zone 'Asia/Tehran';
  local_date := local_now::date;
  -- PostgreSQL DOW: Sunday=0 ... Saturday=6. The computed start is Saturday in Tehran.
  start_date := local_date - ((extract(dow from local_date)::integer + 1) % 7);
  start_at := start_date::timestamp at time zone 'Asia/Tehran';
  end_at := (start_date + 7)::timestamp at time zone 'Asia/Tehran';
  with totals as (
    select p.user_id, p.display_name, coalesce(sum(e.amount),0)::bigint as weekly_xp
    from public.profiles p left join public.xp_events e
      on e.user_id=p.user_id and e.created_at >= start_at and e.created_at < end_at
    where p.display_name is not null and btrim(p.display_name) <> ''
    group by p.user_id,p.display_name
  ), ranked as (
    select row_number() over(order by weekly_xp desc, user_id asc)::bigint as rank,
      user_id,display_name,weekly_xp from totals
  ), top_rows as (select * from ranked order by rank limit 100), own as (select * from ranked where user_id=auth.uid())
  select jsonb_build_object(
    'week_start', start_at, 'week_end', end_at,
    'top', coalesce((select jsonb_agg(jsonb_build_object('rank',rank,'user_id',user_id,'display_name',display_name,'weekly_xp',weekly_xp) order by rank) from top_rows),'[]'::jsonb),
    'current_user', (select jsonb_build_object('rank',rank,'user_id',user_id,'display_name',display_name,'weekly_xp',weekly_xp) from own)
  ) into result;
  return result;
end; $$;
revoke all on function public.get_weekly_leaderboard() from public, anon;
grant execute on function public.get_weekly_leaderboard() to authenticated;

-- Friend requests can be inserted only by their requester; all state transitions are server RPCs.
-- UUID is public profile ID, not an authentication token. Never expose emails or planner_data here.
