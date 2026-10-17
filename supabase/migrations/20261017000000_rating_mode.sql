-- レーティングモード：選手ごとのレーティングと、部屋ごとの強さの入力方式
ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS rating numeric
  CHECK (rating IS NULL OR (rating >= -99999 AND rating <= 99999));

-- settings は部屋ごとに id = 部屋コード の行を持つ（従来の id='global' 共有行は使わない）
ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS strength_mode text NOT NULL DEFAULT 'rank'
  CHECK (strength_mode IN ('rank', 'rating'));

-- 部屋削除時に部屋ごとの設定行も削除する
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

  DELETE FROM public.players  WHERE room_id = v_room;
  DELETE FROM public.rounds   WHERE room_id = v_room;
  DELETE FROM public.leagues  WHERE room_id = v_room;
  DELETE FROM public.settings WHERE id      = v_room;
  DELETE FROM public.rooms    WHERE room_id = v_room;
  RETURN true;
END;
$$;
