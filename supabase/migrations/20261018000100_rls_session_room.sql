-- ================================================================
-- RLS を「有効なセッション」かつ「x-room-id ヘッダーの部屋」に限定する
--   - 公開キーだけでは、どの部屋のデータも読み書きできない
--   - ログインしていても、部屋コードを知らない部屋は読み書きできない（一覧もできない）
-- 新クライアント（ヘッダー送信）のデプロイ後に適用すること
-- ================================================================

-- players
DROP POLICY IF EXISTS players_by_room ON public.players;
CREATE POLICY players_session_room ON public.players
  FOR ALL TO anon, authenticated
  USING      (room_id = (SELECT public.app_room()) AND (SELECT public.app_session_account()) IS NOT NULL)
  WITH CHECK (room_id = (SELECT public.app_room()) AND (SELECT public.app_session_account()) IS NOT NULL);

-- rounds
DROP POLICY IF EXISTS rounds_by_room ON public.rounds;
CREATE POLICY rounds_session_room ON public.rounds
  FOR ALL TO anon, authenticated
  USING      (room_id = (SELECT public.app_room()) AND (SELECT public.app_session_account()) IS NOT NULL)
  WITH CHECK (room_id = (SELECT public.app_room()) AND (SELECT public.app_session_account()) IS NOT NULL);

-- leagues
DROP POLICY IF EXISTS leagues_by_room ON public.leagues;
CREATE POLICY leagues_session_room ON public.leagues
  FOR ALL TO anon, authenticated
  USING      (room_id = (SELECT public.app_room()) AND (SELECT public.app_session_account()) IS NOT NULL)
  WITH CHECK (room_id = (SELECT public.app_room()) AND (SELECT public.app_session_account()) IS NOT NULL);

-- settings（id = 部屋コード）
DROP POLICY IF EXISTS settings_read_write ON public.settings;
CREATE POLICY settings_session_room ON public.settings
  FOR ALL TO anon, authenticated
  USING      (id = (SELECT public.app_room()) AND (SELECT public.app_session_account()) IS NOT NULL)
  WITH CHECK (id = (SELECT public.app_room()) AND (SELECT public.app_session_account()) IS NOT NULL);

-- API から使わない権限は外す
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.players, public.rounds, public.leagues, public.settings FROM anon, authenticated;

-- アカウントIDを引数で受け取っていた旧 RPC（セッション版に置き換え済み）
DROP FUNCTION IF EXISTS public.room_register(uuid, text);
DROP FUNCTION IF EXISTS public.room_list_mine(uuid);
DROP FUNCTION IF EXISTS public.room_delete_owned(uuid, text);
DROP FUNCTION IF EXISTS public.auth_update_password(uuid, text, text);
