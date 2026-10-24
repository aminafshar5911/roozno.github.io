-- Roozno Snake XP: idempotent weekly leaderboard credit with a strict daily cap.
-- Run after 202610240001_social_profiles_friends_weekly_xp.sql and 202610240002_daily_mission_xp.sql.
-- Note: this limits abuse, but client-reported gameplay is not fully cheat-proof.

alter table public.xp_events drop constraint if exists xp_events_amount_check;
alter table public.xp_events alter column amount type numeric(12,2) using amount::numeric(12,2);
alter table public.xp_events add constraint xp_events_amount_check check (amount >= 0.20 and amount <= 10000);

create or replace function public.claim_snake_xp(p_total_items integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Tehran')::date;
  v_total_items integer := greatest(0, least(coalesce(p_total_items, 0), 100));
  v_event_key text;
  v_accepted integer := 0;
  v_inserted numeric(12,2) := 0;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  if v_total_items <= 0 then
    return jsonb_build_object('ok', true, 'today_xp', 0, 'accepted_items', 0);
  end if;

  v_event_key := 'snake-daily:' || v_today::text;
  insert into public.xp_events as current_event(user_id, event_key, event_type, amount, metadata)
  values (v_uid, v_event_key, 'snake_game', v_total_items * 0.20,
          jsonb_build_object('items', v_total_items, 'game_date', v_today, 'season', 'weekly'))
  on conflict (user_id, event_key) do update
    set amount = greatest(current_event.amount, excluded.amount),
        metadata = jsonb_build_object(
          'items', greatest(coalesce((current_event.metadata->>'items')::integer, 0), v_total_items),
          'game_date', v_today,
          'season', 'weekly'
        )
  returning greatest(coalesce((metadata->>'items')::integer, 0), 0), amount
    into v_accepted, v_inserted;

  return jsonb_build_object('ok', true, 'today_xp', v_inserted,
                            'accepted_items', v_accepted, 'daily_cap_xp', 20,
                            'game_date', v_today);
end;
$$;

revoke all on function public.claim_snake_xp(integer) from public, anon;
grant execute on function public.claim_snake_xp(integer) to authenticated;
