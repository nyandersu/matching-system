-- ================================================================
-- 途中棄権・元に戻す（スナップショット）・ログイン試行の制限
-- ================================================================

-- ---------- 途中棄権 ----------
-- 対局記録のある選手は削除せず「棄権」にする（過去の対局と相手の成績を残す）
ALTER TABLE public.players ADD COLUMN IF NOT EXISTS withdrawn boolean NOT NULL DEFAULT false;

-- ---------- 元に戻す（部屋ごとのスナップショット） ----------
CREATE TABLE IF NOT EXISTS public.room_snapshots (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id     text NOT NULL,
  label       text NOT NULL CHECK (length(label) <= 100),
  data        jsonb NOT NULL,
  created_by  uuid DEFAULT public.app_session_account(),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS room_snapshots_room_idx ON public.room_snapshots(room_id, created_at DESC);

ALTER TABLE public.room_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.room_snapshots FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.room_snapshots TO anon, authenticated;
CREATE POLICY room_snapshots_session_room ON public.room_snapshots
  FOR ALL TO anon, authenticated
  USING      (room_id = (SELECT public.app_room()) AND (SELECT public.app_session_account()) IS NOT NULL)
  WITH CHECK (room_id = (SELECT public.app_room()) AND (SELECT public.app_session_account()) IS NOT NULL);

-- 部屋ごとに新しい20件だけ残す
CREATE OR REPLACE FUNCTION public.room_snapshots_trim()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  DELETE FROM public.room_snapshots
   WHERE room_id = NEW.room_id
     AND id NOT IN (
       SELECT id FROM public.room_snapshots
        WHERE room_id = NEW.room_id
        ORDER BY created_at DESC, id DESC
        LIMIT 20
     );
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS room_snapshots_trim ON public.room_snapshots;
CREATE TRIGGER room_snapshots_trim
  AFTER INSERT ON public.room_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.room_snapshots_trim();

-- 部屋削除でスナップショットも削除
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

  DELETE FROM public.players        WHERE room_id = v_room;
  DELETE FROM public.rounds         WHERE room_id = v_room;
  DELETE FROM public.leagues        WHERE room_id = v_room;
  DELETE FROM public.settings       WHERE id      = v_room;
  DELETE FROM public.room_snapshots WHERE room_id = v_room;
  DELETE FROM public.rooms          WHERE room_id = v_room;
  RETURN true;
END;
$$;

-- ---------- ログイン試行の制限（サーバー側） ----------
-- ユーザー名ごとに、15分間に10回失敗したら15分間ログインを止める。
-- 存在しないユーザー名も同じように扱い、アカウントの有無を推測させない。
CREATE TABLE IF NOT EXISTS public.login_failures (
  username         text PRIMARY KEY,
  fail_count       int NOT NULL DEFAULT 0,
  first_failed_at  timestamptz NOT NULL DEFAULT now(),
  locked_until     timestamptz
);
ALTER TABLE public.login_failures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.login_failures FROM anon, authenticated;

-- ---------- 新しく設定するパスワードは8文字以上 ----------
CREATE OR REPLACE FUNCTION public.auth_register(p_username text, p_password text)
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

  IF v_uname IS NULL OR length(v_uname) < 4 OR length(v_uname) > 32 THEN
    RAISE EXCEPTION 'invalid_username' USING HINT = 'length 4-32';
  END IF;
  IF v_uname !~ '^[A-Za-z0-9_\-]+$' THEN
    RAISE EXCEPTION 'invalid_username' USING HINT = 'charset';
  END IF;
  IF p_password IS NULL OR length(p_password) < 8 OR length(p_password) > 128 THEN
    RAISE EXCEPTION 'weak_password';
  END IF;

  INSERT INTO public.accounts (username, password_hash)
  VALUES (v_uname, crypt(p_password, gen_salt('bf', 10)))
  RETURNING id INTO v_id;

  RETURN QUERY SELECT v_id, v_uname, public._session_create(v_id);
END;
$$;

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
  IF p_new_password IS NULL OR length(p_new_password) < 8 OR length(p_new_password) > 128 THEN
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
