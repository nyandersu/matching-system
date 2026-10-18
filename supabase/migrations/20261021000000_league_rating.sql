-- ================================================================
-- リーグ戦の結果からのレーティング更新
--   - rating_history に、どの種類の対局（内戦／リーグ戦の第n期）で変わったかを記録
--   - rating_apply_league：期の結果で、部屋の選手・名簿のレーティングと履歴を更新する
--     （同じ期を二重に反映しないよう、leagues.data の terms[].rated を同じトランザクションで立てる）
-- ================================================================
ALTER TABLE public.rating_history ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'tournament'
  CHECK (source IN ('tournament', 'league'));
ALTER TABLE public.rating_history ADD COLUMN IF NOT EXISTS term int;

CREATE OR REPLACE FUNCTION public.rating_apply_league(p_updates jsonb, p_term int)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_room text := public.app_require_room();
  v_data jsonb;
  v_ti int;
  v_item jsonb;
  v_player record;
  v_before numeric;
BEGIN
  SELECT data INTO v_data FROM public.leagues WHERE room_id = v_room FOR UPDATE;
  IF v_data IS NULL THEN RAISE EXCEPTION 'league_not_found'; END IF;

  SELECT i - 1 INTO v_ti
    FROM jsonb_array_elements(coalesce(v_data -> 'terms', '[]'::jsonb)) WITH ORDINALITY AS t(term, i)
   WHERE (t.term ->> 'term')::int = p_term
   LIMIT 1;
  IF v_ti IS NULL THEN RAISE EXCEPTION 'term_not_found'; END IF;
  IF coalesce((v_data -> 'terms' -> v_ti ->> 'rated')::boolean, false) THEN
    RAISE EXCEPTION 'already_rated';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(coalesce(p_updates, '[]'::jsonb)) LOOP
    SELECT * INTO v_player FROM public.players WHERE room_id = v_room AND id = v_item ->> 'id';
    CONTINUE WHEN NOT FOUND;
    UPDATE public.players SET rating = (v_item ->> 'rating')::numeric WHERE id = v_player.id;

    IF v_player.club_player_id IS NOT NULL THEN
      SELECT rating INTO v_before FROM public.club_players WHERE id = v_player.club_player_id FOR UPDATE;
      UPDATE public.club_players
         SET rating = (v_item ->> 'rating')::numeric, updated_at = now()
       WHERE id = v_player.club_player_id;
      INSERT INTO public.rating_history(club_id, club_player_id, room_id, rounds, before, after, source, term)
      SELECT cp.club_id, cp.id, v_room, NULL, v_before, (v_item ->> 'rating')::numeric, 'league', p_term
        FROM public.club_players cp WHERE cp.id = v_player.club_player_id;
    END IF;
  END LOOP;

  UPDATE public.leagues
     SET data = jsonb_set(data, ARRAY['terms', v_ti::text, 'rated'], 'true'::jsonb), updated_at = now()
   WHERE room_id = v_room;
END;
$$;
REVOKE ALL ON FUNCTION public.rating_apply_league(jsonb, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rating_apply_league(jsonb, int) TO anon, authenticated;
