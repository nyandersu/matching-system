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

    this._checkLoginRateLimit(uname);

    const { data, error } = await supabaseClient.rpc('auth_login', {
      p_username: uname,
      p_password: password,
    });

    if (error) {
      this._recordLoginFailure(uname);
      // サーバーが返すエラーメッセージ名を意味のある日本語に翻訳
      const msg = (error.message || '').toLowerCase();
      if (msg.includes('invalid_credentials')) {
        throw new Error('ユーザー名またはパスワードが違います');
      }
      throw new Error('ログインに失敗しました');
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      this._recordLoginFailure(uname);
      throw new Error('ユーザー名またはパスワードが違います');
    }

    this._clearLoginFailures(uname);
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
    if (password.length < 6 || password.length > 128) {
      throw new Error('パスワードは6〜128文字にしてください');
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
        throw new Error('パスワードは6文字以上にしてください');
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
    if (newPassword.length < 6 || newPassword.length > 128) {
      throw new Error('新しいパスワードは6〜128文字にしてください');
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

  // ============================================
  // ログイン試行制限（クライアント側ベストエフォート）
  // ============================================
  _loginFailKey(username) {
    return 'shogi_loginfail_' + (username || '').toLowerCase();
  },
  _checkLoginRateLimit(username) {
    try {
      const raw = localStorage.getItem(this._loginFailKey(username));
      if (!raw) return;
      const data = JSON.parse(raw);
      const WINDOW = 15 * 60 * 1000; // 15分
      const MAX    = 5;
      const now    = Date.now();
      if (now - (data.first || 0) > WINDOW) return;  // 期限切れ
      if ((data.count || 0) >= MAX) {
        const wait = Math.ceil((WINDOW - (now - data.first)) / 60000);
        throw new Error(`ログイン試行回数が上限を超えました。約${wait}分後に再度お試しください。`);
      }
    } catch (e) {
      if (e.message && e.message.includes('ログイン試行')) throw e;
    }
  },
  _recordLoginFailure(username) {
    try {
      const key = this._loginFailKey(username);
      const raw = localStorage.getItem(key);
      const now = Date.now();
      const data = raw ? JSON.parse(raw) : { count: 0, first: now };
      if (!data.first || now - data.first > 15 * 60 * 1000) {
        data.first = now;
        data.count = 0;
      }
      data.count = (data.count || 0) + 1;
      localStorage.setItem(key, JSON.stringify(data));
    } catch {}
  },
  _clearLoginFailures(username) {
    try { localStorage.removeItem(this._loginFailKey(username)); } catch {}
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
  async registerOwnedRoom(roomId) {
    if (!supabaseClient) throw new Error('Supabase未接続');
    const session = this.getSession();
    if (!session) throw new Error('ログインが必要です');
    const { error } = await supabaseClient.rpc('my_room_register', {
      p_room_id: roomId.toUpperCase().trim(),
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
    }));
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

      let sQuery, pQuery, rQuery, lQuery, authQuery;
      try {
        [authQuery, sQuery, pQuery, rQuery, lQuery] = await Promise.all([
          supabaseClient.rpc('auth_session'),
          supabaseClient.from('settings').select('*').eq('id', this.roomId).maybeSingle(),
          supabaseClient.from('players').select('*').eq('room_id', this.roomId),
          supabaseClient.from('rounds').select('*').eq('room_id', this.roomId).order('round_number'),
          supabaseClient.from('leagues').select('data').eq('room_id', this.roomId).maybeSingle(),
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

      const remotePlayers = pQuery.data || [];
      if (remotePlayers.length > 0 || !initial) {
        data.players = remotePlayers.map(p => ({
          id: p.id, name: p.name, grade: p.grade, rank: p.rank,
          rating: p.rating == null ? null : Number(p.rating),
        }));
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
    data.players.push(player);
    this._saveLocal(data);
    this._remote('選手の追加', () => supabaseClient.from('players').upsert(this._playerRow(player)));
    return player;
  },

  updatePlayer(id, updates) {
    const data = this.loadAll();
    const idx = data.players.findIndex(p => p.id === id);
    if (idx === -1) return null;
    data.players[idx] = { ...data.players[idx], ...updates };
    const player = data.players[idx];
    this._saveLocal(data);
    this._remote('選手の更新', () => supabaseClient.from('players').upsert(this._playerRow(player)));
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
