-- Roozno: safe, idempotent daily-mission XP claims for the weekly leaderboard.
-- Run this AFTER the social/weekly-XP migration and the leaderboard-permissions fix.
-- Clients cannot choose an XP amount; rewards and mission schedule are fixed here.
create or replace function public.claim_daily_mission_xp(p_mission_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Tehran')::date;
  v_dow integer;
  v_week_number integer;
  v_pool text[];
  v_omit_index integer;
  v_reward integer;
  v_inserted integer;
  v_event_key text;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;

  v_dow := extract(dow from v_today)::integer; -- Sunday=0 ... Saturday=6
  v_pool := case v_dow
    when 6 then array['tasks2','habit1','focus15','perfect','note']
    when 0 then array['tasks3','habit2','focus25','note','tasks5']
    when 1 then array['tasks2','habit1','focus45','perfect','focus15']
    when 2 then array['tasks5','habit1','focus25','note','perfect']
    when 3 then array['tasks3','habit2','focus15','perfect','note']
    when 4 then array['tasks2','habit2','focus45','tasks5','note']
    else array['tasks3','habit1','focus25','perfect','focus45']
  end;

  -- Same Saturday-based weekly rotation as the client: 1970-01-03 was Saturday.
  v_week_number := floor((v_today - date '1970-01-03') / 7.0)::integer;
  v_omit_index := ((v_week_number % cardinality(v_pool)) + cardinality(v_pool)) % cardinality(v_pool);
  if array_position(v_pool, p_mission_id) is null
     or array_position(v_pool, p_mission_id) - 1 = v_omit_index then
    return jsonb_build_object('ok', false, 'reason', 'mission_not_scheduled_today', 'mission_date', v_today);
  end if;

  v_reward := case p_mission_id
    when 'tasks2' then 15 when 'tasks3' then 20 when 'tasks5' then 30
    when 'habit1' then 10 when 'habit2' then 20
    when 'focus15' then 15 when 'focus25' then 25 when 'focus45' then 35
    when 'perfect' then 30 when 'note' then 10
    else null
  end;
  if v_reward is null then raise exception 'Unknown mission'; end if;

  v_event_key := 'daily-mission:' || v_today::text || ':' || p_mission_id;
  insert into public.xp_events(user_id, event_key, event_type, amount, metadata)
  values (v_uid, v_event_key, 'daily_mission', v_reward,
          jsonb_build_object('mission_id', p_mission_id, 'mission_date', v_today, 'season', 'weekly'))
  on conflict (user_id, event_key) do nothing;
  get diagnostics v_inserted = row_count;

  return jsonb_build_object('ok', true, 'awarded', v_inserted = 1,
                            'xp', case when v_inserted = 1 then v_reward else 0 end,
                            'mission_date', v_today);
end;
$$;
revoke all on function public.claim_daily_mission_xp(text) from public, anon;
grant execute on function public.claim_daily_mission_xp(text) to authenticated;
