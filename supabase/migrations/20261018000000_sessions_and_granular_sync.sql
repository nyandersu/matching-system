-- ================================================================
-- セッショントークンと、1件ずつの保存（同時入力で結果が消えない）
--   - ログイン時にセッショントークンを発行（DBにはハッシュのみ保存）
--   - クライアントは毎リクエストに x-session-token / x-room-id ヘッダーを付ける
--   - 結果入力・確定・リーグ戦の結果は、その1件だけを書き換える RPC で保存
-- 追加のみ（既存クライアントは引き続き動作）。RLS の切り替えは次のマイグレーションで行う
-- ================================================================

-- ---------- セッション ----------
CREATE TABLE IF NOT EXISTS public.sessions (
  token_hash  text PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_account_idx ON public.sessions(account_id);
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sessions FROM anon, authenticated;

-- リクエストヘッダーの値（PostgREST 経由以外では NULL）
CREATE OR REPLACE FUNCTION public.app_header(p_name text)
RETURNS text
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT nullif(
    coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json ->> p_name,
    ''
  );
$$;

-- 有効なセッションのアカウントID（無効なら NULL）
CREATE OR REPLACE FUNCTION public.app_session_account()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
  SELECT s.account_id
    FROM public.sessions s
   WHERE s.token_hash = encode(digest(public.app_header('x-session-token'), 'sha256'), 'hex')
     AND s.expires_at > now();
$$;

-- リクエストが対象としている部屋コード
CREATE OR REPLACE FUNCTION public.app_room()
RETURNS text
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT upper(trim(public.app_header('x-room-id')));
$$;

-- 現在の部屋にアクセスできなければ例外（RPC 用）
CREATE OR REPLACE FUNCTION public.app_require_room()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_room text := public.app_room();
BEGIN
  IF public.app_session_account() IS NULL THEN
    RAISE EXCEPTION 'not_logged_in';
  END IF;
  IF v_room IS NULL OR v_room !~ '^[A-Z0-9]{4,32}$' THEN
    RAISE EXCEPTION 'invalid_room';
  END IF;
  RETURN v_room;
END;
$$;

-- セッション発行（トークン本体は返すだけで保存しない）
CREATE OR REPLACE FUNCTION public._session_create(p_account_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
DECLARE
  v_token text := encode(gen_random_bytes(32), 'hex');
BEGIN
  DELETE FROM public.sessions WHERE account_id = p_account_id AND expires_at <= now();
  INSERT INTO public.sessions(token_hash, account_id, expires_at)
  VALUES (encode(digest(v_token, 'sha256'), 'hex'), p_account_id, now() + interval '7 days');
  RETURN v_token;
END;
$$;
REVOKE ALL ON FUNCTION public._session_create(uuid) FROM PUBLIC, anon, authenticated;

-- ---------- ログイン・登録（セッショントークンも返す） ----------
DROP FUNCTION IF EXISTS public.auth_login(text, text);
CREATE FUNCTION public.auth_login(p_username text, p_password text)
RETURNS TABLE(account_id uuid, account_username text, session_token text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
DECLARE
  v_uname text;
  v_rec record;
  v_legacy_hash text;
  v_match boolean := false;
BEGIN
  v_uname := trim(p_username);

  IF v_uname IS NULL OR length(v_uname) < 1 OR length(v_uname) > 64 THEN
    -- タイミング攻撃緩和
    PERFORM crypt(COALESCE(p_password, ''), gen_salt('bf', 10));
    RAISE EXCEPTION 'invalid_credentials';
  END IF;
  IF p_password IS NULL OR length(p_password) < 1 OR length(p_password) > 256 THEN
    PERFORM crypt(COALESCE(p_password, ''), gen_salt('bf', 10));
    RAISE EXCEPTION 'invalid_credentials';
  END IF;

  SELECT a.id, a.username, a.password_hash
    INTO v_rec
    FROM public.accounts a
   WHERE a.username = v_uname;

  IF v_rec IS NULL THEN
    -- 存在しないユーザーでもcryptを実行して応答時間を均一化
    PERFORM crypt(p_password, gen_salt('bf', 10));
    RAISE EXCEPTION 'invalid_credentials';
  END IF;

  -- bcrypt形式（$2a$ or $2b$）
  IF v_rec.password_hash LIKE '$2%' THEN
    v_match := (v_rec.password_hash = crypt(p_password, v_rec.password_hash));
  ELSE
    -- 旧SHA-256無塩形式
    v_legacy_hash := encode(digest(p_password, 'sha256'), 'hex');
    IF v_rec.password_hash = v_legacy_hash THEN
      v_match := true;
      -- 新形式(bcrypt)に自動移行
      UPDATE public.accounts
         SET password_hash = crypt(p_password, gen_salt('bf', 10))
       WHERE id = v_rec.id;
    END IF;
  END IF;

  IF NOT v_match THEN
    RAISE EXCEPTION 'invalid_credentials';
  END IF;

  RETURN QUERY SELECT v_rec.id, v_rec.username, public._session_create(v_rec.id);
END;
$$;

DROP FUNCTION IF EXISTS public.auth_register(text, text);
CREATE FUNCTION public.auth_register(p_username text, p_password text)
RETURNS TABLE(account_id uuid, account_username text, session_token text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
DECLARE
  v_id uuid;
  v_uname text;
BEGIN
  v_uname := trim(p_username);

  -- 入力バリデーション（防御的多層）
  IF v_uname IS NULL OR length(v_uname) < 4 OR length(v_uname) > 32 THEN
    RAISE EXCEPTION 'invalid_username' USING HINT = 'length 4-32';
  END IF;
  IF v_uname !~ '^[A-Za-z0-9_\-]+$' THEN
    RAISE EXCEPTION 'invalid_username' USING HINT = 'charset';
  END IF;
  IF p_password IS NULL OR length(p_password) < 6 OR length(p_password) > 128 THEN
    RAISE EXCEPTION 'weak_password';
  END IF;

  INSERT INTO public.accounts (username, password_hash)
  VALUES (v_uname, crypt(p_password, gen_salt('bf', 10)))
  RETURNING id INTO v_id;

  RETURN QUERY SELECT v_id, v_uname, public._session_create(v_id);
END;
$$;

-- 現在のセッションの確認
CREATE OR REPLACE FUNCTION public.auth_session()
RETURNS TABLE(account_id uuid, account_username text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT a.id, a.username FROM public.accounts a WHERE a.id = public.app_session_account();
$$;

CREATE OR REPLACE FUNCTION public.auth_logout()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
  DELETE FROM public.sessions
   WHERE token_hash = encode(digest(public.app_header('x-session-token'), 'sha256'), 'hex');
$$;

-- パスワード変更（セッションのアカウントが対象。変更後は他端末のセッションを無効化）
CREATE OR REPLACE FUNCTION public.auth_change_password(p_current_password text, p_new_password text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
DECLARE
  v_account uuid := public.app_session_account();
  v_current_hash text;
  v_match boolean := false;
BEGIN
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'not_logged_in';
  END IF;
  IF p_new_password IS NULL OR length(p_new_password) < 6 OR length(p_new_password) > 128 THEN
    RAISE EXCEPTION 'weak_password';
  END IF;

  SELECT password_hash INTO v_current_hash FROM public.accounts WHERE id = v_account;

  IF v_current_hash LIKE '$2%' THEN
    v_match := (v_current_hash = crypt(p_current_password, v_current_hash));
  ELSE
    v_match := (v_current_hash = encode(digest(p_current_password, 'sha256'), 'hex'));
  END IF;
  IF NOT v_match THEN
    RAISE EXCEPTION 'invalid_current_password';
  END IF;

  UPDATE public.accounts
     SET password_hash = crypt(p_new_password, gen_salt('bf', 10))
   WHERE id = v_account;

  DELETE FROM public.sessions
   WHERE account_id = v_account
     AND token_hash <> encode(digest(public.app_header('x-session-token'), 'sha256'), 'hex');
END;
$$;

-- ---------- 部屋（セッションのアカウントが対象） ----------
CREATE OR REPLACE FUNCTION public.my_room_register(p_room_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_account uuid := public.app_session_account();
  v_room text := upper(trim(p_room_id));
BEGIN
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'not_logged_in';
  END IF;
  IF v_room IS NULL OR v_room !~ '^[A-Z0-9]{4,32}$' THEN
    RAISE EXCEPTION 'invalid_room';
  END IF;

  INSERT INTO public.rooms(room_id, owner_account_id)
  VALUES (v_room, v_account)
  ON CONFLICT (room_id) DO NOTHING;

  RETURN EXISTS (SELECT 1 FROM public.rooms WHERE room_id = v_room AND owner_account_id = v_account);
END;
$$;

CREATE OR REPLACE FUNCTION public.my_room_list()
RETURNS TABLE(room_id text, created_at timestamptz, player_count bigint, round_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_account uuid := public.app_session_account();
BEGIN
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'not_logged_in';
  END IF;

  RETURN QUERY
  SELECT r.room_id,
         r.created_at,
         (SELECT count(*) FROM public.players p WHERE p.room_id = r.room_id),
         (SELECT count(*) FROM public.rounds  x WHERE x.room_id = r.room_id)
    FROM public.rooms r
   WHERE r.owner_account_id = v_account
   ORDER BY r.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.my_room_delete(p_room_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_account uuid := public.app_session_account();
  v_room text := upper(trim(p_room_id));
BEGIN
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'not_logged_in';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.rooms WHERE room_id = v_room AND owner_account_id = v_account) THEN
    RAISE EXCEPTION 'not_owner';
  END IF;

  DELETE FROM public.players  WHERE room_id = v_room;
  DELETE FROM public.rounds   WHERE room_id = v_room;
  DELETE FROM public.leagues  WHERE room_id = v_room;
  DELETE FROM public.settings WHERE id      = v_room;
  DELETE FROM public.rooms    WHERE room_id = v_room;
  RETURN true;
END;
$$;

-- ---------- 1件ずつの保存 ----------
ALTER TABLE public.rounds ADD COLUMN IF NOT EXISTS confirmed boolean NOT NULL DEFAULT false;

-- 対局結果を1局だけ書き換える（他の局は触らない）
CREATE OR REPLACE FUNCTION public.round_set_result(p_round int, p_match_index int, p_result text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_room text := public.app_require_room();
  v_rec record;
BEGIN
  IF p_result IS NOT NULL AND p_result NOT IN ('player1', 'player2', 'draw') THEN
    RAISE EXCEPTION 'invalid_result';
  END IF;

  SELECT matches, confirmed INTO v_rec
    FROM public.rounds
   WHERE room_id = v_room AND round_number = p_round
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'round_not_found';
  END IF;
  IF v_rec.confirmed THEN
    RAISE EXCEPTION 'round_confirmed';
  END IF;
  IF p_match_index < 0 OR p_match_index >= jsonb_array_length(v_rec.matches) THEN
    RAISE EXCEPTION 'match_not_found';
  END IF;

  UPDATE public.rounds
     SET matches = jsonb_set(matches, ARRAY[p_match_index::text, 'result'], coalesce(to_jsonb(p_result), 'null'::jsonb))
   WHERE room_id = v_room AND round_number = p_round;
END;
$$;

CREATE OR REPLACE FUNCTION public.round_set_confirmed(p_round int, p_confirmed boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_room text := public.app_require_room();
BEGIN
  UPDATE public.rounds
     SET confirmed = coalesce(p_confirmed, false)
   WHERE room_id = v_room AND round_number = p_round;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'round_not_found';
  END IF;
END;
$$;

-- リーグ戦の対局結果を1局だけ書き換える
CREATE OR REPLACE FUNCTION public.league_set_result(p_term int, p_class_id text, p_match_id text, p_result text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_room text := public.app_require_room();
  v_data jsonb;
  v_terms jsonb;
  v_ti int;
  v_mi int;
BEGIN
  IF p_result IS NOT NULL AND p_result NOT IN ('p1', 'p2', 'draw') THEN
    RAISE EXCEPTION 'invalid_result';
  END IF;

  SELECT data INTO v_data FROM public.leagues WHERE room_id = v_room FOR UPDATE;
  IF v_data IS NULL THEN
    RAISE EXCEPTION 'league_not_found';
  END IF;

  v_terms := coalesce(v_data -> 'terms', '[]'::jsonb);
  SELECT i - 1 INTO v_ti
    FROM jsonb_array_elements(v_terms) WITH ORDINALITY AS t(term, i)
   WHERE (t.term ->> 'term')::int = p_term
   LIMIT 1;
  IF v_ti IS NULL THEN
    RAISE EXCEPTION 'term_not_found';
  END IF;

  SELECT i - 1 INTO v_mi
    FROM jsonb_array_elements(coalesce(v_terms -> v_ti -> 'matches' -> p_class_id, '[]'::jsonb))
         WITH ORDINALITY AS m(match, i)
   WHERE m.match ->> 'id' = p_match_id
   LIMIT 1;
  IF v_mi IS NULL THEN
    RAISE EXCEPTION 'match_not_found';
  END IF;

  UPDATE public.leagues
     SET data = jsonb_set(data, ARRAY['terms', v_ti::text, 'matches', p_class_id, v_mi::text, 'result'],
                          coalesce(to_jsonb(p_result), 'null'::jsonb)),
         updated_at = now()
   WHERE room_id = v_room;
END;
$$;

-- ---------- 実行権限 ----------
REVOKE ALL ON FUNCTION public.auth_login(text, text)              FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_register(text, text)           FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_session()                      FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_logout()                       FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_change_password(text, text)    FROM PUBLIC;
REVOKE ALL ON FUNCTION public.my_room_register(text)              FROM PUBLIC;
REVOKE ALL ON FUNCTION public.my_room_list()                      FROM PUBLIC;
REVOKE ALL ON FUNCTION public.my_room_delete(text)                FROM PUBLIC;
REVOKE ALL ON FUNCTION public.round_set_result(int, int, text)    FROM PUBLIC;
REVOKE ALL ON FUNCTION public.round_set_confirmed(int, boolean)   FROM PUBLIC;
REVOKE ALL ON FUNCTION public.league_set_result(int, text, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.auth_login(text, text)              TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_register(text, text)           TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_session()                      TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_logout()                       TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_change_password(text, text)    TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.my_room_register(text)              TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.my_room_list()                      TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.my_room_delete(text)                TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.round_set_result(int, int, text)    TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.round_set_confirmed(int, boolean)   TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.league_set_result(int, text, text, text) TO anon, authenticated;
