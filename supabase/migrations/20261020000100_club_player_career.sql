-- ================================================================
-- 名簿の選手の通算成績用：部にひも付いた全部屋の対局を集める
--   内戦（rounds.matches）とリーグ戦（leagues.data の各期の対局）の、結果が入力された対局
--   リーグ戦の階級は、確定した期の記録（memberSnapshot）→ 期の階級名 → 現在の階級 の順に引く
-- ================================================================
CREATE OR REPLACE FUNCTION public.club_player_career(p_club_player_id uuid)
RETURNS TABLE(
  room_id text, room_created_at timestamptz, kind text, round_no int, seq int,
  sente boolean, outcome text, opponent_club_player_id uuid, opponent_name text,
  class_name text, class_tier int
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_club text;
BEGIN
  SELECT cp.club_id INTO v_club FROM public.club_players cp WHERE cp.id = p_club_player_id;
  IF v_club IS NULL OR NOT public.app_can_access_club(v_club) THEN
    RAISE EXCEPTION 'not_allowed';
  END IF;

  RETURN QUERY
  WITH rp AS (
    SELECT p.id AS pid, p.room_id AS rid, r.created_at AS rcreated
      FROM public.players p
      JOIN public.rooms r ON r.room_id = p.room_id AND r.club_id = v_club
     WHERE p.club_player_id = p_club_player_id
  ),
  games AS (
    -- 内戦
    SELECT rp.rid, rp.rcreated, 'tournament'::text AS kind, x.round_number AS rn, m.ord::int AS sq,
           (m.match ->> 'player1Id') = rp.pid AS is_p1,
           CASE m.match ->> 'result'
             WHEN 'draw' THEN 'D'
             WHEN 'player1' THEN CASE WHEN (m.match ->> 'player1Id') = rp.pid THEN 'W' ELSE 'L' END
             WHEN 'player2' THEN CASE WHEN (m.match ->> 'player2Id') = rp.pid THEN 'W' ELSE 'L' END
           END AS oc,
           CASE WHEN (m.match ->> 'player1Id') = rp.pid THEN m.match ->> 'player2Id' ELSE m.match ->> 'player1Id' END AS opp,
           NULL::text AS cname, NULL::int AS ctier
      FROM rp
      JOIN public.rounds x ON x.room_id = rp.rid
      CROSS JOIN LATERAL jsonb_array_elements(x.matches) WITH ORDINALITY AS m(match, ord)
     WHERE rp.pid IN (m.match ->> 'player1Id', m.match ->> 'player2Id')
       AND m.match ->> 'result' IN ('player1', 'player2', 'draw')
    UNION ALL
    -- リーグ戦
    SELECT rp.rid, rp.rcreated, 'league'::text, (t.term ->> 'term')::int, mm.ord::int,
           (mm.match ->> 'p1Id') = rp.pid,
           CASE mm.match ->> 'result'
             WHEN 'draw' THEN 'D'
             WHEN 'p1' THEN CASE WHEN (mm.match ->> 'p1Id') = rp.pid THEN 'W' ELSE 'L' END
             WHEN 'p2' THEN CASE WHEN (mm.match ->> 'p2Id') = rp.pid THEN 'W' ELSE 'L' END
           END,
           CASE WHEN (mm.match ->> 'p1Id') = rp.pid THEN mm.match ->> 'p2Id' ELSE mm.match ->> 'p1Id' END,
           coalesce(
             (SELECT s ->> 'className' FROM jsonb_array_elements(coalesce(t.term -> 'memberSnapshot', '[]'::jsonb)) s
               WHERE s ->> 'playerId' = rp.pid LIMIT 1),
             t.term -> 'classNames' ->> c.key,
             (SELECT cl ->> 'name' FROM jsonb_array_elements(coalesce(l.data -> 'classes', '[]'::jsonb)) cl
               WHERE cl ->> 'id' = c.key LIMIT 1)
           ),
           coalesce(
             (SELECT (s ->> 'tier')::int FROM jsonb_array_elements(coalesce(t.term -> 'memberSnapshot', '[]'::jsonb)) s
               WHERE s ->> 'playerId' = rp.pid LIMIT 1),
             (SELECT coalesce((cl ->> 'tier')::int, i::int)
                FROM jsonb_array_elements(coalesce(l.data -> 'classes', '[]'::jsonb)) WITH ORDINALITY AS cc(cl, i)
               WHERE cl ->> 'id' = c.key LIMIT 1)
           )
      FROM rp
      JOIN public.leagues l ON l.room_id = rp.rid
      CROSS JOIN LATERAL jsonb_array_elements(coalesce(l.data -> 'terms', '[]'::jsonb)) AS t(term)
      CROSS JOIN LATERAL jsonb_each(coalesce(t.term -> 'matches', '{}'::jsonb)) AS c(key, arr)
      CROSS JOIN LATERAL jsonb_array_elements(c.arr) WITH ORDINALITY AS mm(match, ord)
     WHERE rp.pid IN (mm.match ->> 'p1Id', mm.match ->> 'p2Id')
       AND mm.match ->> 'result' IN ('p1', 'p2', 'draw')
  )
  SELECT g.rid, g.rcreated, g.kind, g.rn, g.sq, g.is_p1, g.oc,
         op.club_player_id, coalesce(ocp.name, op.name),
         g.cname, g.ctier
    FROM games g
    LEFT JOIN public.players op ON op.id = g.opp AND op.room_id = g.rid
    LEFT JOIN public.club_players ocp ON ocp.id = op.club_player_id
   ORDER BY g.rcreated, g.rid, g.kind DESC, g.rn, g.sq;
END;
$$;
REVOKE ALL ON FUNCTION public.club_player_career(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.club_player_career(uuid) TO anon, authenticated;
