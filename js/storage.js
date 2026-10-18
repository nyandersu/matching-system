/**
 * storage.js — LocalStorage & Supabase 同期モジュール
 * オフライン時はLocalStorage、オンライン時はSupabaseと同期する
 * アカウントごとに部屋を管理し、部屋（roomId）ごとにデータを分離する
 */

const SUPABASE_URL = 'https://nwxpgvefyjzabuwdtrii.supabase.co';
const SUPABASE_KEY = 'sb_publishable_jI0RZ1qkuXdOeacCNX928A_m8dRQGwV';

const SESSION_KEY = 'shogi_session';  // ログインセッション

/**
 * Supabase クライアント。
 * サーバー側の RLS は「有効なセッション」かつ「x-room-id の部屋」の行だけを許可するため、
 * ページ読み込み時点のセッショントークンと URL の部屋コードをヘッダーに付ける
 * （ログイン・部屋の切り替えはいずれもページ遷移を伴うので、読み込み時に決めれば足りる）。
 */
const supabaseClient = (() => {
  if (!window.supabase) return null;
  const headers = {};
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (s && s.token) headers['x-session-token'] = s.token;
  } catch {}
  const room = (new URLSearchParams(window.location.search).get('room') || '').toUpperCase().trim();
  if (/^[A-Z0-9]{4,32}$/.test(room)) headers['x-room-id'] = room;
  return window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    global: { headers },
    auth:   { persistSession: false, autoRefreshToken: false },
  });
})();

const AppStorage = {
  roomId: null,   // 現在の部屋ID（null = 未選択）

  // ============================================
  // セッション管理（ログイン・ログアウト）
  // ============================================

  /** セッション取得（7日で期限切れ、未ログイン時は null） */
  getSession() {
    try {
      const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      if (!s) return null;
      // セッショントークン導入前のセッションは無効（再ログインが必要）
      if (!s.token) {
        this.clearSession();
        return null;
      }
      const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7日
      if (s.createdAt && Date.now() - s.createdAt > SESSION_TTL_MS) {
        this.clearSession();
        return null;
      }
      return s;
    } catch {
      return null;
    }
  },

  /** セッション保存（作成時刻付き） */
  saveSession(accountId, username, token) {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      accountId, username, token, createdAt: Date.now()
    }));
  },

  /** ローカルのセッション情報を消す */
  clearSession() {
    localStorage.removeItem(SESSION_KEY);
  },

  /** ログアウト（サーバー側のセッションも無効化） */
  async logout() {
    if (supabaseClient && this.getSession()) {
      try { await supabaseClient.rpc('auth_logout'); } catch {}
    }
    this.clearSession();
  },

  /**
   * サーバー側でセッションが有効か確認する。
   * @returns {Promise<boolean|null>} true=有効 / false=無効 / null=確認できない（オフライン等）
   */
  async validateSession() {
    if (!supabaseClient || !this.getSession()) return null;
    try {
      const { data, error } = await supabaseClient.rpc('auth_session');
      if (error) return null;
      return Array.isArray(data) && data.length > 0;
    } catch {
      return null;
    }
  },

  /**
   * ログイン（サーバー側RPCで認証、パスワードハッシュはクライアントに露出しない）
   * - サーバーはbcrypt（10ラウンド）でハッシュ比較
   * - 旧SHA-256ハッシュはログイン成功時にbcryptへ自動移行
   * - クライアント側ログイン試行制限（5回/15分）
   */
  async login(username, password) {
    if (!supabaseClient) throw new Error('Supabase未接続');
    const uname = username.trim();

    // 試行回数の制限はサーバー側（同じユーザー名で15分間に10回失敗すると15分間ロック）
    const { data, error } = await supabaseClient.rpc('auth_login', {
      p_username: uname,
      p_password: password,
    });

    if (error) {
      // サーバーが返すエラーメッセージ名を意味のある日本語に翻訳
      const msg = (error.message || '').toLowerCase();
      if (msg.includes('invalid_credentials')) {
        throw new Error('ユーザー名またはパスワードが違います');
      }
      throw new Error('ログインに失敗しました');
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (row && row.status === 'locked') {
      const minutes = Math.max(1, Math.ceil((row.retry_after_seconds || 900) / 60));
      throw new Error(`ログインの失敗が続いたため、一時的にログインできません。約${minutes}分後に再度お試しください。`);
    }
    if (!row || !row.account_id || !row.session_token || (row.status && row.status !== 'ok')) {
      throw new Error('ユーザー名またはパスワードが違います');
    }

    this.saveSession(row.account_id, row.account_username, row.session_token);
    return { id: row.account_id, username: row.account_username };
  },

  /** 新規アカウント登録（サーバー側RPCでbcryptハッシュ生成） */
  async register(username, password) {
    if (!supabaseClient) throw new Error('Supabase未接続');
    const uname = username.trim();

    if (!/^[A-Za-z0-9_\-]{4,32}$/.test(uname)) {
      throw new Error('ユーザー名は半角英数字・ハイフン・アンダースコアで4〜32文字にしてください');
    }
    if (password.length < 8 || password.length > 128) {
      throw new Error('パスワードは8〜128文字にしてください');
    }
    if (this._isCommonPassword(password)) {
      throw new Error('このパスワードは推測されやすいため使用できません');
    }

    const { data, error } = await supabaseClient.rpc('auth_register', {
      p_username: uname,
      p_password: password,
    });

    if (error) {
      const msg = (error.message || '').toLowerCase();
      if (msg.includes('23505') || msg.includes('duplicate') || msg.includes('unique')) {
        throw new Error('そのユーザー名はすでに使われています');
      }
      if (msg.includes('invalid_username')) {
        throw new Error('ユーザー名の形式が正しくありません');
      }
      if (msg.includes('weak_password')) {
        throw new Error('パスワードは8文字以上にしてください');
      }
      throw new Error('アカウント作成に失敗しました');
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error('アカウント作成に失敗しました');
    this.saveSession(row.account_id, row.account_username, row.session_token);
    return { id: row.account_id, username: row.account_username };
  },

  /** パスワード変更（サーバー側RPCで検証・更新） */
  async updatePassword(currentPassword, newPassword) {
    if (!supabaseClient) throw new Error('Supabase未接続');
    const session = this.getSession();
    if (!session) throw new Error('ログインが必要です');
    if (newPassword.length < 8 || newPassword.length > 128) {
      throw new Error('新しいパスワードは8〜128文字にしてください');
    }
    if (this._isCommonPassword(newPassword)) {
      throw new Error('このパスワードは推測されやすいため使用できません');
    }

    const { error } = await supabaseClient.rpc('auth_change_password', {
      p_current_password: currentPassword,
      p_new_password:     newPassword,
    });

    if (error) {
      const msg = (error.message || '').toLowerCase();
      if (msg.includes('invalid_current_password')) {
        throw new Error('現在のパスワードが違います');
      }
      if (msg.includes('weak_password')) {
        throw new Error('新しいパスワードが弱すぎます');
      }
      throw new Error('パスワード変更に失敗しました');
    }
  },

  /** よく使われる脆弱なパスワードの簡易ブロックリスト */
  _isCommonPassword(pw) {
    const blocked = new Set([
      'password','password1','password12','password123',
      '123456','1234567','12345678','123456789','1234567890',
      'qwerty','qwerty123','abc123','111111','000000',
      'letmein','welcome','admin','admin123','root','iloveyou',
      'monkey','dragon','master','shogi','shogi123','tournament',
    ]);
    return blocked.has(pw.toLowerCase());
  },

  // ============================================
  // 部屋管理
  // ============================================

  /** 部屋IDに対応するローカルストレージキー */
  getStorageKey() {
    return `shogi_${this.roomId || '_default'}`;
  },

  /** アカウントごとの部屋履歴キー */
  _getRoomHistoryKey() {
    const session = this.getSession();
    return `shogi_room_history_${session?.accountId || '_anon'}`;
  },

  /** ランダムな6文字の部屋コードを生成（見間違えやすい文字を除外、暗号学的乱数使用） */
  generateRoomId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32文字
    const buf = new Uint8Array(6);
    crypto.getRandomValues(buf);
    // 32=2^5 なので上位5bitを使って偏りなくマッピング
    return Array.from(buf, b => chars[b & 0x1f]).join('');
  },

  /** 新しく作成した部屋を、ログイン中アカウントの所有部屋としてサーバーに登録 */
  async registerOwnedRoom(roomId, clubId = null) {
    if (!supabaseClient) throw new Error('Supabase未接続');
    const session = this.getSession();
    if (!session) throw new Error('ログインが必要です');
    const { error } = await supabaseClient.rpc('my_room_register', {
      p_room_id: roomId.toUpperCase().trim(),
      p_club_id: clubId,
    });
    if (error) throw new Error('部屋の登録に失敗しました');
  },

  /** ログイン中アカウントが作成した部屋の一覧（新しい順） */
  async listOwnedRooms() {
    if (!supabaseClient) return [];
    const session = this.getSession();
    if (!session) return [];
    const { data, error } = await supabaseClient.rpc('my_room_list');
    if (error) throw new Error('部屋一覧の取得に失敗しました');
    return (data || []).map(r => ({
      roomId:      r.room_id,
      createdAt:   r.created_at,
      playerCount: Number(r.player_count) || 0,
      roundCount:  Number(r.round_count) || 0,
      clubId:      r.club_id || null,
      clubName:    r.club_name || null,
    }));
  },

  // ============================================
  // 部と名簿（部屋をまたいで選手・レーティング・履歴を保持）
  // ============================================

  async _rpc(name, args, message) {
    if (!supabaseClient) throw new Error('Supabase未接続');
    const { data, error } = await supabaseClient.rpc(name, args);
    if (error) {
      const msg = error.message || '';
      if (msg.includes('club_not_found')) throw new Error('その部コードの部は見つかりません');
      if (msg.includes('not_member'))     throw new Error('その部に参加していません');
      if (msg.includes('not_owner'))      throw new Error('自分が作成した部屋のみ変更できます');
      throw new Error(message);
    }
    return data;
  },

  async listClubs() {
    const data = await this._rpc('my_clubs', {}, '部の一覧の取得に失敗しました');
    return (data || []).map(c => ({
      clubId: c.club_id, name: c.name, isOwner: !!c.is_owner,
      playerCount: Number(c.player_count) || 0, roomCount: Number(c.room_count) || 0,
    }));
  },

  async createClub(name) {
    return this._rpc('club_create', { p_name: name }, '部の作成に失敗しました');
  },

  async joinClub(code) {
    const data = await this._rpc('club_join', { p_club_id: code }, '部への参加に失敗しました');
    return Array.isArray(data) ? data[0] : data;
  },

  /** 部屋を部にひも付ける（部屋の選手は同名の名簿の選手に、いなければ名簿に追加してひも付け） */
  async linkRoomToClub(roomId, clubId) {
    return this._rpc('room_set_club', { p_room_id: roomId, p_club_id: clubId }, '部へのひも付けに失敗しました');
  },

  async listRoster(clubId) {
    if (!supabaseClient) return [];
    const { data, error } = await supabaseClient.from('club_players')
      .select('id, name, grade, rank, rating, retired')
      .eq('club_id', clubId)
      .order('retired').order('grade').order('name');
    if (error) throw new Error('名簿の取得に失敗しました');
    return (data || []).map(p => ({ ...p, rating: p.rating == null ? null : Number(p.rating) }));
  },

  /** 名簿の選手を追加・更新（id があれば更新） */
  async saveRosterPlayer(clubId, player) {
    if (!supabaseClient) throw new Error('Supabase未接続');
    const row = {
      id: player.id || this._uuid(), club_id: clubId,
      name: player.name, grade: player.grade ?? null, rank: player.rank ?? null,
      rating: player.rating ?? null, retired: !!player.retired, updated_at: new Date().toISOString(),
    };
    const { error } = await supabaseClient.from('club_players').upsert(row);
    if (error) throw new Error('名簿の保存に失敗しました');
    return row;
  },

  async listRatingHistory(clubPlayerId) {
    if (!supabaseClient) return [];
    const { data, error } = await supabaseClient.from('rating_history')
      .select('room_id, rounds, before, after, created_at')
      .eq('club_player_id', clubPlayerId)
      .order('created_at');
    if (error) throw new Error('レーティング履歴の取得に失敗しました');
    return data || [];
  },

  /** 開いている部屋の部（ひも付いていなければ null） */
  getRoomClub() {
    return this.loadAll().club || null;
  },

  /** 名簿の選手を部屋に追加する（名簿の値をコピーし、名簿にひも付ける） */
  addPlayersFromRoster(rosterPlayers) {
    const data = this.loadAll();
    const existing = new Set(data.players.map(p => p.clubPlayerId).filter(Boolean));
    const added = rosterPlayers.filter(rp => !existing.has(rp.id)).map(rp => ({
      id: this.generateId(), name: rp.name, grade: rp.grade ?? 1, rank: rp.rank || 'C',
      rating: rp.rating ?? null, clubPlayerId: rp.id,
    }));
    if (added.length === 0) return [];
    data.players.push(...added);
    this._saveLocal(data);
    this._remote('名簿から追加', () => supabaseClient.from('players').upsert(added.map(p => this._playerRow(p))));
    return added;
  },

  _uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  },

  /** 名簿の選手を部屋の選手の値で更新（部屋の編集を名簿にも反映） */
  _rosterRow(p) {
    return {
      id: p.clubPlayerId, name: p.name, grade: p.grade ?? null, rank: p.rank ?? null,
      rating: p.rating ?? null, updated_at: new Date().toISOString(),
    };
  },

  /** 部屋をセットし、最近の部屋リストに追加 */
  setRoom(roomId) {
    this.roomId = roomId.toUpperCase().trim();
    this._addToRoomHistory(this.roomId);
    return this.roomId;
  },

  /** 最近使った部屋リストを取得（アカウントごとに分離） */
  getRoomHistory() {
    try {
      return JSON.parse(localStorage.getItem(this._getRoomHistoryKey()) || '[]');
    } catch {
      return [];
    }
  },

  _addToRoomHistory(roomId) {
    const history = this.getRoomHistory().filter(r => r !== roomId);
    history.unshift(roomId);
    localStorage.setItem(this._getRoomHistoryKey(), JSON.stringify(history.slice(0, 5)));
  },

  /** 自分が作成した部屋を削除（サーバー側で作成者か確認し、データと所有記録をまとめて削除） */
  async deleteRoom(roomId) {
    const rid = (roomId || '').toUpperCase().trim();
    if (!rid) return;
    if (!supabaseClient) throw new Error('Supabase未接続');
    const session = this.getSession();
    if (!session) throw new Error('ログインが必要です');

    const { error } = await supabaseClient.rpc('my_room_delete', {
      p_room_id: rid,
    });
    if (error) {
      if ((error.message || '').includes('not_owner')) {
        throw new Error('自分が作成した部屋のみ削除できます');
      }
      throw new Error('部屋の削除に失敗しました');
    }

    this.removeFromRoomHistory(rid);
    localStorage.removeItem(`shogi_${rid}`);
  },

  /** 最近参加した部屋リストから外す（部屋のデータは消さない） */
  removeFromRoomHistory(roomId) {
    const rid = (roomId || '').toUpperCase().trim();
    const history = this.getRoomHistory().filter(r => r !== rid);
    localStorage.setItem(this._getRoomHistoryKey(), JSON.stringify(history));
  },

  // ============================================
  // 同期（端末間）
  // ============================================
  //
  // - 保存は「変更した1件だけ」をサーバーに書く（結果は1局単位の RPC）。
  //   他の端末が入力した結果を、古いローカルデータで上書きしないため。
  // - 書き込みが終わったら同じ部屋の端末へ broadcast で通知し、受け取った側は再取得する。
  // - 書き込みは順番どおりに送るためキューで直列化する。

  _writeQueue: Promise.resolve(),
  _localVersion: 0,
  _channel: null,
  _onRemoteUpdate: null,
  _refetchTimer: null,

  initRealtime(onUpdateCallback) {
    if (!supabaseClient || !this.roomId) return;
    this._onRemoteUpdate = onUpdateCallback;

    this.fetchFromSupabase({ initial: true }).then(() => {
      if (onUpdateCallback) onUpdateCallback();
    });

    this._channel = supabaseClient
      .channel(`room:${this.roomId}`, { config: { broadcast: { self: false } } })
      .on('broadcast', { event: 'changed' }, () => this._scheduleRefetch())
      .subscribe();

    // 画面に戻ってきたとき（スリープ復帰など）に取りこぼしを補う
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this._scheduleRefetch();
    });
  },

  _scheduleRefetch() {
    clearTimeout(this._refetchTimer);
    this._refetchTimer = setTimeout(async () => {
      await this.fetchFromSupabase();
      if (this._onRemoteUpdate) this._onRemoteUpdate();
    }, 300);
  },

  /** 同じ部屋の他の端末に「変更あり」を通知 */
  _notifyChanged() {
    if (!this._channel) return;
    this._channel.send({ type: 'broadcast', event: 'changed', payload: {} }).catch(() => {});
  },

  /**
   * サーバーへの書き込みをキューに積む。
   * 失敗したら（他端末で確定済み・オフラインなど）サーバーの状態を取り直して画面に反映する。
   */
  _remote(label, fn) {
    if (!supabaseClient || !this.roomId) return;
    this._writeQueue = this._writeQueue.then(async () => {
      try {
        const res = await fn();
        const err = res && res.error;
        if (err) throw err;
        this._notifyChanged();
      } catch (err) {
        console.warn(`Supabaseへの保存に失敗（${label}）:`, err);
        this._scheduleRefetch();
      }
    });
  },

  _playerRow(p) {
    return {
      id: p.id, name: p.name, grade: p.grade, rank: p.rank,
      rating: p.rating ?? null,
      withdrawn: !!p.withdrawn,
      club_player_id: p.clubPlayerId || null,
      room_id: this.roomId,
    };
  },

  _roundRow(r) {
    return {
      room_id:       this.roomId,
      round_number:  r.roundNumber,
      matches:       r.matches,
      bye_player_id: r.byePlayerId,
      confirmed:     !!r.confirmed,
      rated:         !!r.rated,
    };
  },

  _settingsRow(settings) {
    return {
      id:                this.roomId,
      num_rounds:        settings.numRounds,
      bye_counts_as_win: true,   // 常に不戦勝扱い
      strength_mode:     settings.strengthMode === 'rating' ? 'rating' : 'rank',
    };
  },

  _leagueHasContent(league) {
    return !!league && (league.enabled || (league.classes || []).length > 0 || (league.terms || []).length > 0);
  },

  /**
   * サーバーから部屋のデータを取得してローカルに反映する。
   * - 通常はサーバーを正とする（他端末での削除も反映）
   * - initial（ページ読み込み時）は、サーバーが空でローカルにデータがある場合に限り
   *   ローカルをサーバーへ送る（オフラインで作ったデータの初回同期）
   * - セッションが無効なときは何も反映しない（RLS で空に見えるため）
   */
  async fetchFromSupabase({ initial = false } = {}) {
    if (!supabaseClient || !this.roomId) return;

    for (let attempt = 0; attempt < 3; attempt++) {
      await this._writeQueue;               // 自分の未送信の書き込みを先に反映させる
      const versionAtStart = this._localVersion;

      let sQuery, pQuery, rQuery, lQuery, authQuery, infoQuery;
      try {
        [authQuery, sQuery, pQuery, rQuery, lQuery, infoQuery] = await Promise.all([
          supabaseClient.rpc('auth_session'),
          supabaseClient.from('settings').select('*').eq('id', this.roomId).maybeSingle(),
          supabaseClient.from('players').select('*').eq('room_id', this.roomId),
          supabaseClient.from('rounds').select('*').eq('room_id', this.roomId).order('round_number'),
          supabaseClient.from('leagues').select('data').eq('room_id', this.roomId).maybeSingle(),
          supabaseClient.rpc('room_info'),
        ]);
      } catch (e) {
        console.warn('Supabaseからのデータ取得に失敗しました(オフラインの可能性があります):', e);
        return;
      }

      if (authQuery.error || sQuery.error || pQuery.error || rQuery.error) {
        console.warn('Supabaseからのデータ取得に失敗しました:', authQuery.error || sQuery.error || pQuery.error || rQuery.error);
        return;
      }
      if (!Array.isArray(authQuery.data) || authQuery.data.length === 0) {
        console.warn('セッションが無効なため同期を停止しました');
        if (this.onSessionInvalid) this.onSessionInvalid();
        return;
      }

      // 取得中にローカルで変更があったら、その書き込みを待ってから取り直す
      if (this._localVersion !== versionAtStart) continue;

      const data = this.loadAll();

      if (sQuery.data) {
        data.settings.numRounds    = sQuery.data.num_rounds;
        data.settings.strengthMode = sQuery.data.strength_mode === 'rating' ? 'rating' : 'rank';
      } else if (initial) {
        this._remote('設定', () => supabaseClient.from('settings').upsert(this._settingsRow(data.settings)));
      }

      // 部屋の部（部にひも付いていれば、名簿の選手の名前・学年・ランク・レーティングを正とする）
      if (infoQuery && !infoQuery.error) {
        const info = Array.isArray(infoQuery.data) ? infoQuery.data[0] : infoQuery.data;
        data.club = info && info.club_id ? { clubId: info.club_id, name: info.club_name } : null;
      }
      const remotePlayers = pQuery.data || [];
      let roster = {};
      const linkedIds = remotePlayers.map(p => p.club_player_id).filter(Boolean);
      if (data.club && linkedIds.length > 0) {
        const rq = await supabaseClient.from('club_players').select('id, name, grade, rank, rating').in('id', linkedIds);
        if (!rq.error) roster = Object.fromEntries((rq.data || []).map(cp => [cp.id, cp]));
      }
      if (remotePlayers.length > 0 || !initial) {
        data.players = remotePlayers.map(p => {
          const cp = roster[p.club_player_id];
          const src = cp ? { ...p, name: cp.name, grade: cp.grade ?? p.grade, rank: cp.rank ?? p.rank, rating: cp.rating } : p;
          return {
            id: p.id, name: src.name, grade: src.grade, rank: src.rank,
            rating: src.rating == null ? null : Number(src.rating),
            withdrawn: !!p.withdrawn,
            clubPlayerId: p.club_player_id || null,
          };
        });
      } else if (data.players.length > 0) {
        this._remote('選手', () => supabaseClient.from('players').upsert(data.players.map(p => this._playerRow(p))));
      }

      const remoteRounds = rQuery.data || [];
      if (remoteRounds.length > 0 || !initial) {
        data.rounds = remoteRounds.map(r => ({
          roundNumber: r.round_number,
          matches:     r.matches,
          byePlayerId: r.bye_player_id,
          confirmed:   !!r.confirmed,
          rated:       !!r.rated,
        }));
      } else if (data.rounds.length > 0) {
        this._remote('対戦表', () => supabaseClient.from('rounds').upsert(data.rounds.map(r => this._roundRow(r))));
      }

      // leagues テーブルのエラーは致命的としない（テーブル未作成の旧環境互換）
      if (lQuery && !lQuery.error) {
        const remoteLeague = lQuery.data && lQuery.data.data;
        if (remoteLeague && typeof remoteLeague === 'object') {
          data.league = { ...this.getDefaultLeague(), ...remoteLeague };
        } else if (initial && this._leagueHasContent(data.league)) {
          const league = data.league;
          this._remote('リーグ戦', () => supabaseClient.from('leagues').upsert({
            room_id: this.roomId, data: league, updated_at: new Date().toISOString(),
          }));
        } else if (!initial) {
          data.league = this.getDefaultLeague();
        }
      }

      this._writeLocal(data);
      return;
    }
  },

  // ============================================
  // ローカルデータ操作
  // ============================================

  loadAll() {
    try {
      const raw = localStorage.getItem(this.getStorageKey());
      if (!raw) return this.getDefaultData();
      const data = JSON.parse(raw);
      // 旧データ互換：league キーが無ければ補完
      if (!data.league) data.league = this.getDefaultLeague();
      return data;
    } catch {
      return this.getDefaultData();
    }
  },

  /** ローカルにだけ保存（サーバーへの送信は各操作で個別に行う） */
  _writeLocal(data) {
    try {
      localStorage.setItem(this.getStorageKey(), JSON.stringify(data));
    } catch (e) {
      console.error('ローカル保存失敗:', e);
    }
  },

  _saveLocal(data) {
    this._localVersion++;
    this._writeLocal(data);
  },

  getDefaultData() {
    return {
      players: [],
      rounds:  [],
      settings: {
        numRounds: 5,
        gradeAvoidLevel: 2, rankBalanceLevel: 2, matchingFormat: 'random',
        assignSenteGote: true,
        strengthMode: 'rank',      // 'rank'（S〜Cの4段階）| 'rating'（数値を手入力）
        meanBalanceLevel: 2        // 対戦相手の強さ（平均）の均等化（レーティングモードのみ）
      },
      league: this.getDefaultLeague()
    };
  },

  /** リーグ戦データの初期値 */
  getDefaultLeague() {
    return {
      enabled:     false,  // この部屋でリーグ戦モードを使うか
      currentTerm: 1,      // 現在の期（シーズン）
      classes:     [],     // [{id, name}] 配列順が序列。先頭が最上位
      members:     [],     // [{playerId, classId, status:'active'|'absent', joinedTerm}]
      terms:       []      // [{term, matches:{[classId]:[...]}, finalized, changes:[...]}]
    };
  },

  getLeague() {
    return this.loadAll().league || this.getDefaultLeague();
  },

  /** リーグ戦データ全体を保存（クラス編集・総当たり生成など構造の変更用） */
  saveLeague(league) {
    const data = this.loadAll();
    data.league = league;
    this._saveLocal(data);
    this._remote('リーグ戦', () => supabaseClient.from('leagues').upsert({
      room_id: this.roomId, data: league, updated_at: new Date().toISOString(),
    }));
  },

  /** リーグ戦の対局結果を1局だけ保存（他の端末の入力を上書きしない） */
  setLeagueMatchResult(term, classId, matchId, result) {
    const data = this.loadAll();
    const t = (data.league.terms || []).find(tt => tt.term === term);
    const m = t && (t.matches[classId] || []).find(mm => mm.id === matchId);
    if (!m) return;
    m.result = result;
    this._saveLocal(data);
    this._remote('リーグ戦の結果', async () => {
      const res = await supabaseClient.rpc('league_set_result', {
        p_term: term, p_class_id: classId, p_match_id: matchId, p_result: result,
      });
      // サーバーにまだ無い期・対局ならリーグ全体を保存
      if (res.error && /league_not_found|term_not_found|match_not_found/.test(res.error.message || '')) {
        return supabaseClient.from('leagues').upsert({
          room_id: this.roomId, data: this.loadAll().league, updated_at: new Date().toISOString(),
        });
      }
      return res;
    });
  },

  addPlayer(player) {
    const data = this.loadAll();
    player.id = this.generateId();
    // 部にひも付いた部屋では、名簿にも追加してひも付ける
    const club = data.club;
    if (club && !player.clubPlayerId) player.clubPlayerId = this._uuid();
    data.players.push(player);
    this._saveLocal(data);
    this._remote('選手の追加', async () => {
      if (club) {
        const res = await supabaseClient.from('club_players').upsert({ ...this._rosterRow(player), club_id: club.clubId });
        if (res.error) return res;
      }
      return supabaseClient.from('players').upsert(this._playerRow(player));
    });
    return player;
  },

  updatePlayer(id, updates) {
    const data = this.loadAll();
    const idx = data.players.findIndex(p => p.id === id);
    if (idx === -1) return null;
    data.players[idx] = { ...data.players[idx], ...updates };
    const player = data.players[idx];
    this._saveLocal(data);
    // 名前・学年・ランク・レーティングの変更は名簿にも反映（途中棄権は部屋ごとの状態なので反映しない）
    const touchesRoster = player.clubPlayerId && ['name', 'grade', 'rank', 'rating'].some(k => k in updates);
    this._remote('選手の更新', async () => {
      if (touchesRoster) {
        const res = await supabaseClient.from('club_players').update(this._rosterRow(player)).eq('id', player.clubPlayerId);
        if (res.error) return res;
      }
      return supabaseClient.from('players').upsert(this._playerRow(player));
    });
    return player;
  },

  deletePlayer(id) {
    const data = this.loadAll();
    data.players = data.players.filter(p => p.id !== id);
    this._saveLocal(data);
    this._remote('選手の削除', () => supabaseClient.from('players').delete().eq('id', id).eq('room_id', this.roomId));
  },

  getPlayers()  { return this.loadAll().players; },
  getRounds()   { return this.loadAll().rounds; },
  getSettings() { return this.loadAll().settings; },

  /** 対戦表全体を置き換える（生成・クリア・手動編集） */
  saveRounds(rounds) {
    const data = this.loadAll();
    data.rounds = rounds;
    this._saveLocal(data);
    const rows = rounds.map(r => this._roundRow(r));
    const maxRound = rounds.reduce((m, r) => Math.max(m, r.roundNumber), 0);
    this._remote('対戦表', async () => {
      if (rows.length > 0) {
        const res = await supabaseClient.from('rounds').upsert(rows);
        if (res.error) return res;
      }
      return supabaseClient.from('rounds').delete().eq('room_id', this.roomId).gt('round_number', maxRound);
    });
  },

  /** 1回戦分を追加（スイスドロー。既存の回戦の結果には触れない） */
  appendRound(round) {
    const data = this.loadAll();
    data.rounds.push(round);
    this._saveLocal(data);
    this._remote('対戦表の追加', () => supabaseClient.from('rounds').upsert(this._roundRow(round)));
  },

  /** 対局結果を1局だけ保存（他の端末の入力を上書きしない） */
  updateMatchResult(roundIndex, matchIndex, result) {
    const data = this.loadAll();
    const round = data.rounds[roundIndex];
    if (!round?.matches[matchIndex]) return;
    round.matches[matchIndex].result = result;
    this._saveLocal(data);
    this._remote('結果', () => supabaseClient.rpc('round_set_result', {
      p_round: round.roundNumber, p_match_index: matchIndex, p_result: result,
    }));
  },

  setRoundConfirmed(roundIndex, confirmed) {
    const data = this.loadAll();
    const round = data.rounds[roundIndex];
    if (!round) return;
    round.confirmed = confirmed;
    this._saveLocal(data);
    this._remote('確定', () => supabaseClient.rpc('round_set_confirmed', {
      p_round: round.roundNumber, p_confirmed: confirmed,
    }));
  },

  updateSettings(settings) {
    const data = this.loadAll();
    const before = data.settings;
    data.settings = { ...data.settings, ...settings };
    this._saveLocal(data);
    // サーバーで共有するのはラウンド数と強さの入力方式のみ（他は端末ごとの設定）
    if (before.numRounds !== data.settings.numRounds || before.strengthMode !== data.settings.strengthMode) {
      const row = this._settingsRow(data.settings);
      this._remote('設定', () => supabaseClient.from('settings').upsert(row));
    }
  },

  // ============================================
  // 元に戻す（スナップショット）
  // ============================================

  /** 部屋の現在の状態（選手・対戦表・共有設定・リーグ戦） */
  _snapshotData() {
    const data = this.loadAll();
    return {
      players:  data.players,
      rounds:   data.rounds,
      settings: { numRounds: data.settings.numRounds, strengthMode: data.settings.strengthMode || 'rank' },
      league:   data.league,
    };
  },

  /**
   * 取り返しのつかない操作の直前に、現在の状態をサーバーに保存する（部屋ごとに最新20件）。
   * 書き込みキューに積むので、直後の上書きより必ず先に保存される。
   */
  createSnapshot(label) {
    const data = this._snapshotData();
    if (data.players.length === 0 && data.rounds.length === 0 && !this._leagueHasContent(data.league)) return;
    this._remote('元に戻す用の保存', () => supabaseClient.from('room_snapshots').insert({
      room_id: this.roomId, label: String(label).slice(0, 100), data,
    }));
  },

  async listSnapshots() {
    if (!supabaseClient || !this.roomId) return [];
    await this._writeQueue;
    const { data, error } = await supabaseClient.from('room_snapshots')
      .select('id, label, data, created_at')
      .eq('room_id', this.roomId)
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) throw new Error('履歴の取得に失敗しました');
    return data || [];
  },

  /** スナップショットの状態に戻す（戻す前の状態も保存するので、復元自体も元に戻せる） */
  restoreSnapshot(snapshot) {
    const snap = snapshot.data || {};
    this.createSnapshot('復元する前の状態');

    const data = this.loadAll();
    data.players = snap.players || [];
    data.rounds  = snap.rounds  || [];
    data.league  = { ...this.getDefaultLeague(), ...(snap.league || {}) };
    if (snap.settings) {
      data.settings.numRounds    = snap.settings.numRounds ?? data.settings.numRounds;
      data.settings.strengthMode = snap.settings.strengthMode === 'rating' ? 'rating' : 'rank';
    }
    this._saveLocal(data);

    const players  = data.players.map(p => this._playerRow(p));
    const rounds   = data.rounds.map(r => this._roundRow(r));
    const maxRound = data.rounds.reduce((m, r) => Math.max(m, r.roundNumber), 0);
    const settings = this._settingsRow(data.settings);
    const league   = data.league;
    this._remote('復元', async () => {
      // 選手：スナップショットに無い選手を削除してから書き込む
      const ids = players.map(p => p.id);
      let del = supabaseClient.from('players').delete().eq('room_id', this.roomId);
      if (ids.length > 0) del = del.not('id', 'in', `(${ids.map(id => `"${id}"`).join(',')})`);
      let res = await del;
      if (res.error) return res;
      if (players.length > 0) {
        res = await supabaseClient.from('players').upsert(players);
        if (res.error) return res;
      }
      // 対戦表
      if (rounds.length > 0) {
        res = await supabaseClient.from('rounds').upsert(rounds);
        if (res.error) return res;
      }
      res = await supabaseClient.from('rounds').delete().eq('room_id', this.roomId).gt('round_number', maxRound);
      if (res.error) return res;
      // 設定・リーグ戦
      res = await supabaseClient.from('settings').upsert(settings);
      if (res.error) return res;
      return supabaseClient.from('leagues').upsert({
        room_id: this.roomId, data: league, updated_at: new Date().toISOString(),
      });
    });
  },

  /**
   * レーティング更新の反映。選手のレーティングと回戦の「反映済み」を、サーバーで1回の処理として更新する
   * （他の端末と同時に押しても二重に反映されない。失敗したらサーバーの状態に戻る）。
   */
  applyRatingUpdate(rows, roundNumbers) {
    const data = this.loadAll();
    const after = Object.fromEntries(rows.map(r => [r.id, r.after]));
    data.players.forEach(p => { if (p.id in after) p.rating = after[p.id]; });
    data.rounds.forEach(r => { if (roundNumbers.includes(r.roundNumber)) r.rated = true; });
    this._saveLocal(data);
    this._remote('レーティング更新', () => supabaseClient.rpc('rating_apply', {
      p_updates: rows.map(r => ({ id: r.id, rating: r.after })),
      p_rounds:  roundNumbers,
    }));
  },

  resetAll() {
    localStorage.removeItem(this.getStorageKey());
    this._localVersion++;
    this._remote('全データリセット', async () => {
      for (const table of ['players', 'rounds', 'leagues']) {
        const res = await supabaseClient.from(table).delete().eq('room_id', this.roomId);
        if (res.error) return res;
      }
      return null;
    });
  },

  generateId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    // フォールバック（暗号学的乱数）
    const buf = new Uint8Array(12);
    crypto.getRandomValues(buf);
    return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
  },

  // 認証関連のハッシュ処理はサーバー側RPC（bcrypt）に移行済み。
  // クライアント側でパスワードをハッシュ化する処理は削除した。
};
