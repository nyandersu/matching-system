-- ================================================================
-- ログイン試行の制限（サーバー側）：auth_login の差し替え
-- 戻り値に status 列が増えるため、対応したクライアントのデプロイ後に適用すること
-- （login_failures テーブルは 20261019000000 で作成済み）
-- ================================================================

-- 失敗を記録する例外は使えない（例外でロールバックされ記録が消える）ため、
-- 認証失敗は status 列で返す：'ok' | 'invalid' | 'locked'
DROP FUNCTION IF EXISTS public.auth_login(text, text);
CREATE FUNCTION public.auth_login(p_username text, p_password text)
RETURNS TABLE(account_id uuid, account_username text, session_token text, status text, retry_after_seconds int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
DECLARE
  c_max_failures constant int := 10;
  c_window       constant interval := interval '15 minutes';
  c_lock         constant interval := interval '15 minutes';
  v_uname text := trim(coalesce(p_username, ''));
  v_key   text := lower(v_uname);   -- 大文字・小文字を変えた再試行で制限を回避されないように
  v_rec record;
  v_fail record;
  v_match boolean := false;
BEGIN
  -- 古い記録の掃除（1日以上前）
  DELETE FROM public.login_failures WHERE first_failed_at < now() - interval '1 day' AND (locked_until IS NULL OR locked_until < now());

  SELECT * INTO v_fail FROM public.login_failures WHERE username = v_key;
  IF v_fail.locked_until IS NOT NULL AND v_fail.locked_until > now() THEN
    -- 応答時間をそろえる
    PERFORM crypt(coalesce(p_password, ''), gen_salt('bf', 10));
    RETURN QUERY SELECT NULL::uuid, NULL::text, NULL::text, 'locked'::text,
      ceil(extract(epoch FROM v_fail.locked_until - now()))::int;
    RETURN;
  END IF;

  IF length(v_uname) BETWEEN 1 AND 64 AND p_password IS NOT NULL AND length(p_password) BETWEEN 1 AND 256 THEN
    SELECT a.id, a.username, a.password_hash INTO v_rec
      FROM public.accounts a
     WHERE a.username = v_uname;
  END IF;

  IF v_rec.id IS NULL THEN
    PERFORM crypt(coalesce(p_password, ''), gen_salt('bf', 10));
  ELSIF v_rec.password_hash LIKE '$2%' THEN
    v_match := (v_rec.password_hash = crypt(p_password, v_rec.password_hash));
  ELSIF v_rec.password_hash = encode(digest(p_password, 'sha256'), 'hex') THEN
    -- 旧SHA-256無塩形式 → bcrypt に自動移行
    v_match := true;
    UPDATE public.accounts SET password_hash = crypt(p_password, gen_salt('bf', 10)) WHERE id = v_rec.id;
  END IF;

  IF NOT v_match THEN
    INSERT INTO public.login_failures AS f (username, fail_count, first_failed_at)
    VALUES (v_key, 1, now())
    ON CONFLICT (username) DO UPDATE
       SET fail_count      = CASE WHEN f.first_failed_at < now() - c_window THEN 1 ELSE f.fail_count + 1 END,
           first_failed_at = CASE WHEN f.first_failed_at < now() - c_window THEN now() ELSE f.first_failed_at END,
           locked_until    = NULL
    RETURNING * INTO v_fail;

    IF v_fail.fail_count >= c_max_failures THEN
      UPDATE public.login_failures SET locked_until = now() + c_lock WHERE username = v_key;
      RETURN QUERY SELECT NULL::uuid, NULL::text, NULL::text, 'locked'::text,
        extract(epoch FROM c_lock)::int;
      RETURN;
    END IF;

    RETURN QUERY SELECT NULL::uuid, NULL::text, NULL::text, 'invalid'::text, NULL::int;
    RETURN;
  END IF;

  DELETE FROM public.login_failures WHERE username = v_key;
  RETURN QUERY SELECT v_rec.id, v_rec.username, public._session_create(v_rec.id), 'ok'::text, NULL::int;
END;
$$;
REVOKE ALL ON FUNCTION public.auth_login(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_login(text, text) TO anon, authenticated;

