-- ================================================================
-- 対局結果からのレーティング更新
--   - rounds.rated：その回戦の結果をレーティングに反映済みか（二重反映の防止）
--   - rating_apply：レーティングの更新と「反映済み」の記録を1つのトランザクションで行う
--     （2台の端末で同時に押しても、同じ回戦が二重に反映されない）
-- ================================================================

ALTER TABLE public.rounds ADD COLUMN IF NOT EXISTS rated boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.rating_apply(p_updates jsonb, p_rounds int[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_room text := public.app_require_room();
  v_item jsonb;
BEGIN
  IF p_rounds IS NULL OR array_length(p_rounds, 1) IS NULL THEN
    RAISE EXCEPTION 'no_rounds';
  END IF;

  -- 対象の回戦をロックし、確定済み・未反映であることを確認
  PERFORM 1 FROM public.rounds
   WHERE room_id = v_room AND round_number = ANY(p_rounds)
   FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM public.rounds
     WHERE room_id = v_room AND round_number = ANY(p_rounds) AND (rated OR NOT confirmed)
  ) OR (
    SELECT count(*) FROM public.rounds WHERE room_id = v_room AND round_number = ANY(p_rounds)
  ) <> array_length(p_rounds, 1) THEN
    RAISE EXCEPTION 'already_rated_or_not_confirmed';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(coalesce(p_updates, '[]'::jsonb)) LOOP
    UPDATE public.players
       SET rating = (v_item ->> 'rating')::numeric
     WHERE room_id = v_room AND id = v_item ->> 'id';
  END LOOP;

  UPDATE public.rounds
     SET rated = true
   WHERE room_id = v_room AND round_number = ANY(p_rounds);
END;
$$;
REVOKE ALL ON FUNCTION public.rating_apply(jsonb, int[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rating_apply(jsonb, int[]) TO anon, authenticated;
