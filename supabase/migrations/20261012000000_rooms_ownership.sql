-- 部屋の所有者を記録し、作成したアカウントでは部屋一覧を常に表示できるようにする
-- rooms テーブルは anon から直接読めない（RLS有効・ポリシーなし）ため、
-- 他アカウントが部屋コードを列挙することはできない。アクセスは下記RPC経由のみ。

CREATE TABLE IF NOT EXISTS public.rooms (
  room_id          text PRIMARY KEY CHECK (room_id ~ '^[A-Z0-9]{4,32}$'),
  owner_account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rooms_owner_idx ON public.rooms(owner_account_id);

ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rooms FROM anon, authenticated;

-- 部屋の作成者として登録（既に所有者がいる部屋は変更しない）
CREATE OR REPLACE FUNCTION public.room_register(p_account_id uuid, p_room_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_room text := upper(trim(p_room_id));
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = p_account_id) THEN
    RAISE EXCEPTION 'invalid_account';
  END IF;
  IF v_room IS NULL OR v_room !~ '^[A-Z0-9]{4,32}$' THEN
    RAISE EXCEPTION 'invalid_room';
  END IF;

  INSERT INTO public.rooms(room_id, owner_account_id)
  VALUES (v_room, p_account_id)
  ON CONFLICT (room_id) DO NOTHING;

  RETURN EXISTS (
    SELECT 1 FROM public.rooms WHERE room_id = v_room AND owner_account_id = p_account_id
  );
END;
$$;

-- 自分が作成した部屋の一覧（新しい順）
CREATE OR REPLACE FUNCTION public.room_list_mine(p_account_id uuid)
RETURNS TABLE(room_id text, created_at timestamptz, player_count bigint, round_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = p_account_id) THEN
    RAISE EXCEPTION 'invalid_account';
  END IF;

  RETURN QUERY
  SELECT r.room_id,
         r.created_at,
         (SELECT count(*) FROM public.players p WHERE p.room_id = r.room_id),
         (SELECT count(*) FROM public.rounds  x WHERE x.room_id = r.room_id)
    FROM public.rooms r
   WHERE r.owner_account_id = p_account_id
   ORDER BY r.created_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.room_register(uuid, text)  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.room_list_mine(uuid)       FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.room_register(uuid, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.room_list_mine(uuid)      TO anon, authenticated;
