-- Roozno fix: allow the leaderboard RPC to read protected XP rows safely.
-- Run this in Supabase SQL Editor on the same project used by GitHub Pages.
create or replace function public.get_weekly_leaderboard()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare local_now timestamp; local_date date; start_date date; start_at timestamptz; end_at timestamptz; result jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  local_now := now() at time zone 'Asia/Tehran';
  local_date := local_now::date;
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
