-- ================================================================
-- 部の名簿（部屋をまたいで選手・レーティング・履歴を保持する）
--   clubs          部（部コードで参加。部屋コードと同じく、コードを知っている人が参加できる）
--   club_members   部に参加しているアカウント
--   club_players   部の名簿（名前・学年・ランク・レーティング・引退）
--   rating_history レーティングの変化の履歴
--   rooms.club_id / players.club_player_id  部屋・部屋の選手と、部・名簿の選手のひも付け
-- アクセスできるのは「部に参加しているアカウント」か「部にひも付いた部屋を開いている人」
-- ================================================================

CREATE TABLE IF NOT EXISTS public.clubs (
  club_id          text PRIMARY KEY CHECK (club_id ~ '^[A-Z0-9]{4,32}$'),
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 50),
  owner_account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.club_members (
  club_id    text NOT NULL REFERENCES public.clubs(club_id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  joined_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (club_id, account_id)
);
CREATE INDEX IF NOT EXISTS club_members_account_idx ON public.club_members(account_id);

CREATE TABLE IF NOT EXISTS public.club_players (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id    text NOT NULL REFERENCES public.clubs(club_id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  grade      int,
  rank       text CHECK (rank IS NULL OR rank IN ('S', 'A', 'B', 'C')),
  rating     numeric CHECK (rating IS NULL OR (rating >= -99999 AND rating <= 99999)),
  retired    boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS club_players_club_idx ON public.club_players(club_id);

CREATE TABLE IF NOT EXISTS public.rating_history (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  club_id        text NOT NULL REFERENCES public.clubs(club_id) ON DELETE CASCADE,
  club_player_id uuid NOT NULL REFERENCES public.club_players(id) ON DELETE CASCADE,
  room_id        text,
  rounds         int[],
  before         numeric,
  after          numeric,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rating_history_player_idx ON public.rating_history(club_player_id, created_at);

ALTER TABLE public.rooms   ADD COLUMN IF NOT EXISTS club_id text REFERENCES public.clubs(club_id) ON DELETE SET NULL;
ALTER TABLE public.players ADD COLUMN IF NOT EXISTS club_player_id uuid REFERENCES public.club_players(id) ON DELETE SET NULL;

-- 部にアクセスできるか（部に参加している、または部にひも付いた部屋を開いている）
CREATE OR REPLACE FUNCTION public.app_can_access_club(p_club text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT public.app_session_account() IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.club_members m
             WHERE m.club_id = p_club AND m.account_id = public.app_session_account())
    OR EXISTS (SELECT 1 FROM public.rooms r
                WHERE r.room_id = public.app_room() AND r.club_id = p_club)
  );
$$;

-- ---------- RLS ----------
ALTER TABLE public.clubs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_members   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_players   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rating_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.clubs, public.club_members, public.club_players, public.rating_history FROM anon, authenticated;

GRANT SELECT ON public.clubs TO anon, authenticated;
CREATE POLICY clubs_access ON public.clubs FOR SELECT TO anon, authenticated
  USING (public.app_can_access_club(club_id));

-- 名簿：閲覧・追加・更新のみ（削除はせず「引退」にする）
GRANT SELECT, INSERT, UPDATE ON public.club_players TO anon, authenticated;
CREATE POLICY club_players_access ON public.club_players FOR ALL TO anon, authenticated
  USING (public.app_can_access_club(club_id))
  WITH CHECK (public.app_can_access_club(club_id));

-- 履歴：閲覧のみ（追加は rating_apply から）
GRANT SELECT ON public.rating_history TO anon, authenticated;
CREATE POLICY rating_history_access ON public.rating_history FOR SELECT TO anon, authenticated
  USING (public.app_can_access_club(club_id));

-- 部屋の選手を名簿にひも付けるとき、ひも付け先は同じ部の選手に限る
CREATE OR REPLACE FUNCTION public.players_check_club_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NEW.club_player_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.club_players cp
      JOIN public.rooms r ON r.club_id = cp.club_id
     WHERE cp.id = NEW.club_player_id AND r.room_id = NEW.room_id
  ) THEN
    RAISE EXCEPTION 'invalid_club_player';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS players_check_club_link ON public.players;
CREATE TRIGGER players_check_club_link
  BEFORE INSERT OR UPDATE OF club_player_id, room_id ON public.players
  FOR EACH ROW EXECUTE FUNCTION public.players_check_club_link();

-- ---------- 部の作成・参加・一覧 ----------
CREATE OR REPLACE FUNCTION public.club_create(p_name text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
DECLARE
  v_account uuid := public.app_session_account();
  v_chars   text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code    text;
  v_bytes   bytea;
BEGIN
  IF v_account IS NULL THEN RAISE EXCEPTION 'not_logged_in'; END IF;
  IF p_name IS NULL OR length(trim(p_name)) NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'invalid_name'; END IF;

  LOOP
    v_bytes := gen_random_bytes(6);
    v_code := 'B';
    FOR i IN 0..5 LOOP
      v_code := v_code || substr(v_chars, (get_byte(v_bytes, i) % 32) + 1, 1);
    END LOOP;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.clubs WHERE club_id = v_code)
          AND NOT EXISTS (SELECT 1 FROM public.rooms WHERE room_id = v_code);
  END LOOP;

  INSERT INTO public.clubs(club_id, name, owner_account_id) VALUES (v_code, trim(p_name), v_account);
  INSERT INTO public.club_members(club_id, account_id) VALUES (v_code, v_account);
  RETURN v_code;
END;
$$;

CREATE OR REPLACE FUNCTION public.club_join(p_club_id text)
RETURNS TABLE(club_id text, name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_account uuid := public.app_session_account();
  v_club text := upper(trim(p_club_id));
BEGIN
  IF v_account IS NULL THEN RAISE EXCEPTION 'not_logged_in'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.club_id = v_club) THEN RAISE EXCEPTION 'club_not_found'; END IF;
  INSERT INTO public.club_members(club_id, account_id) VALUES (v_club, v_account) ON CONFLICT DO NOTHING;
  RETURN QUERY SELECT c.club_id, c.name FROM public.clubs c WHERE c.club_id = v_club;
END;
$$;

CREATE OR REPLACE FUNCTION public.my_clubs()
RETURNS TABLE(club_id text, name text, is_owner boolean, player_count bigint, room_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_account uuid := public.app_session_account();
BEGIN
  IF v_account IS NULL THEN RAISE EXCEPTION 'not_logged_in'; END IF;
  RETURN QUERY
  SELECT c.club_id, c.name, c.owner_account_id = v_account,
         (SELECT count(*) FROM public.club_players p WHERE p.club_id = c.club_id AND NOT p.retired),
         (SELECT count(*) FROM public.rooms r WHERE r.club_id = c.club_id)
    FROM public.clubs c
    JOIN public.club_members m ON m.club_id = c.club_id AND m.account_id = v_account
   ORDER BY m.joined_at;
END;
$$;

-- 開いている部屋の部（未登録の部屋・部なしは空）
CREATE OR REPLACE FUNCTION public.room_info()
RETURNS TABLE(room_id text, club_id text, club_name text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_room text := public.app_require_room();
BEGIN
  RETURN QUERY
  SELECT r.room_id, r.club_id, c.name
    FROM public.rooms r LEFT JOIN public.clubs c ON c.club_id = r.club_id
   WHERE r.room_id = v_room;
END;
$$;

-- 部屋を部にひも付ける（部屋の作成者で、部に参加している人のみ）。
-- 部屋の選手は、名簿に同じ名前の選手（引退していない）がいればその選手に、いなければ名簿に追加してひも付ける。
-- p_club_id が NULL ならひも付けを外す（名簿はそのまま）。
CREATE OR REPLACE FUNCTION public.room_set_club(p_room_id text, p_club_id text)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_account uuid := public.app_session_account();
  v_room text := upper(trim(p_room_id));
  v_club text := upper(trim(p_club_id));
  v_player record;
  v_cp uuid;
  v_created int := 0;
BEGIN
  IF v_account IS NULL THEN RAISE EXCEPTION 'not_logged_in'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.rooms WHERE room_id = v_room AND owner_account_id = v_account) THEN
    RAISE EXCEPTION 'not_owner';
  END IF;

  IF p_club_id IS NULL THEN
    UPDATE public.players SET club_player_id = NULL WHERE room_id = v_room;
    UPDATE public.rooms SET club_id = NULL WHERE room_id = v_room;
    RETURN 0;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.club_members WHERE club_id = v_club AND account_id = v_account) THEN
    RAISE EXCEPTION 'not_member';
  END IF;

  UPDATE public.players SET club_player_id = NULL WHERE room_id = v_room;
  UPDATE public.rooms SET club_id = v_club WHERE room_id = v_room;

  FOR v_player IN SELECT * FROM public.players WHERE room_id = v_room ORDER BY name LOOP
    SELECT cp.id INTO v_cp
      FROM public.club_players cp
     WHERE cp.club_id = v_club AND cp.name = v_player.name AND NOT cp.retired
     ORDER BY cp.created_at
     LIMIT 1;
    IF v_cp IS NULL THEN
      INSERT INTO public.club_players(club_id, name, grade, rank, rating)
      VALUES (v_club, v_player.name, v_player.grade, v_player.rank, v_player.rating)
      RETURNING id INTO v_cp;
      v_created := v_created + 1;
    END IF;
    UPDATE public.players SET club_player_id = v_cp WHERE id = v_player.id;
  END LOOP;
  RETURN v_created;
END;
$$;

-- ---------- 部屋の登録・一覧（部を含む） ----------
DROP FUNCTION IF EXISTS public.my_room_register(text);
CREATE FUNCTION public.my_room_register(p_room_id text, p_club_id text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_account uuid := public.app_session_account();
  v_room text := upper(trim(p_room_id));
  v_club text := upper(trim(p_club_id));
BEGIN
  IF v_account IS NULL THEN RAISE EXCEPTION 'not_logged_in'; END IF;
  IF v_room IS NULL OR v_room !~ '^[A-Z0-9]{4,32}$' THEN RAISE EXCEPTION 'invalid_room'; END IF;
  IF v_club IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.club_members WHERE club_id = v_club AND account_id = v_account
  ) THEN
    RAISE EXCEPTION 'not_member';
  END IF;

  INSERT INTO public.rooms(room_id, owner_account_id, club_id)
  VALUES (v_room, v_account, v_club)
  ON CONFLICT (room_id) DO NOTHING;

  RETURN EXISTS (SELECT 1 FROM public.rooms WHERE room_id = v_room AND owner_account_id = v_account);
END;
$$;

DROP FUNCTION IF EXISTS public.my_room_list();
CREATE FUNCTION public.my_room_list()
RETURNS TABLE(room_id text, created_at timestamptz, player_count bigint, round_count bigint, club_id text, club_name text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_account uuid := public.app_session_account();
BEGIN
  IF v_account IS NULL THEN RAISE EXCEPTION 'not_logged_in'; END IF;
  RETURN QUERY
  SELECT r.room_id, r.created_at,
         (SELECT count(*) FROM public.players p WHERE p.room_id = r.room_id),
         (SELECT count(*) FROM public.rounds  x WHERE x.room_id = r.room_id),
         r.club_id, c.name
    FROM public.rooms r LEFT JOIN public.clubs c ON c.club_id = r.club_id
   WHERE r.owner_account_id = v_account
   ORDER BY r.created_at DESC;
END;
$$;

-- ---------- レーティング更新：名簿と履歴にも反映 ----------
CREATE OR REPLACE FUNCTION public.rating_apply(p_updates jsonb, p_rounds int[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_room text := public.app_require_room();
  v_item jsonb;
  v_player record;
  v_before numeric;
BEGIN
  IF p_rounds IS NULL OR array_length(p_rounds, 1) IS NULL THEN
    RAISE EXCEPTION 'no_rounds';
  END IF;

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
    SELECT * INTO v_player FROM public.players WHERE room_id = v_room AND id = v_item ->> 'id';
    CONTINUE WHEN NOT FOUND;
    v_before := v_player.rating;

    UPDATE public.players SET rating = (v_item ->> 'rating')::numeric WHERE id = v_player.id;

    IF v_player.club_player_id IS NOT NULL THEN
      SELECT rating INTO v_before FROM public.club_players WHERE id = v_player.club_player_id FOR UPDATE;
      UPDATE public.club_players
         SET rating = (v_item ->> 'rating')::numeric, updated_at = now()
       WHERE id = v_player.club_player_id;
      INSERT INTO public.rating_history(club_id, club_player_id, room_id, rounds, before, after)
      SELECT cp.club_id, cp.id, v_room, p_rounds, v_before, (v_item ->> 'rating')::numeric
        FROM public.club_players cp WHERE cp.id = v_player.club_player_id;
    END IF;
  END LOOP;

  UPDATE public.rounds
     SET rated = true
   WHERE room_id = v_room AND round_number = ANY(p_rounds);
END;
$$;

-- 部屋削除時：部屋の選手のひも付けは部屋ごと消える（名簿と履歴は部に残る）

-- ---------- 実行権限 ----------
REVOKE ALL ON FUNCTION public.club_create(text)               FROM PUBLIC;
REVOKE ALL ON FUNCTION public.club_join(text)                 FROM PUBLIC;
REVOKE ALL ON FUNCTION public.my_clubs()                      FROM PUBLIC;
REVOKE ALL ON FUNCTION public.room_info()                     FROM PUBLIC;
REVOKE ALL ON FUNCTION public.room_set_club(text, text)       FROM PUBLIC;
REVOKE ALL ON FUNCTION public.my_room_register(text, text)    FROM PUBLIC;
REVOKE ALL ON FUNCTION public.my_room_list()                  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.club_create(text)            TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.club_join(text)              TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.my_clubs()                   TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.room_info()                  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.room_set_club(text, text)    TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.my_room_register(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.my_room_list()               TO anon, authenticated;
