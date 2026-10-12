-- 部屋の削除は作成者のみ。部屋のデータ（選手・対戦表・リーグ戦）と所有記録をまとめて削除する
CREATE OR REPLACE FUNCTION public.room_delete_owned(p_account_id uuid, p_room_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_room text := upper(trim(p_room_id));
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.rooms WHERE room_id = v_room AND owner_account_id = p_account_id
  ) THEN
    RAISE EXCEPTION 'not_owner';
  END IF;

  DELETE FROM public.players WHERE room_id = v_room;
  DELETE FROM public.rounds  WHERE room_id = v_room;
  DELETE FROM public.leagues WHERE room_id = v_room;
  DELETE FROM public.rooms   WHERE room_id = v_room;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.room_delete_owned(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.room_delete_owned(uuid, text) TO anon, authenticated;
