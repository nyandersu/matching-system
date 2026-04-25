/**
 * storage.js — LocalStorage & Supabase 同期モジュール
 * オフライン時はLocalStorage、オンライン時はSupabaseと同期する
 * アカウントごとに部屋を管理し、部屋（roomId）ごとにデータを分離する
 */

const SUPABASE_URL = 'https://nwxpgvefyjzabuwdtrii.supabase.co';
const SUPABASE_KEY = 'sb_publishable_jI0RZ1qkuXdOeacCNX928A_m8dRQGwV';
const supabaseClient = window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;

const SESSION_KEY = 'shogi_session';  // ログインセッション

const AppStorage = {
  _isSyncing: false,
  roomId: null,   // 現在の部屋ID（null = 未選択）

  // ============================================
  // セッション管理（ログイン・ログアウト）
  // ============================================

  /** セッション取得（7日で期限切れ、未ログイン時は null） */
  getSession() {
    try {
      const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      if (!s) return null;
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
  saveSession(accountId, username) {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      accountId, username, createdAt: Date.now()
    }));
  },

  /** ログアウト */
  clearSession() {
    localStorage.removeItem(SESSION_KEY);
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
    this.saveSession(row.account_id, row.account_username);
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
    this.saveSession(row.account_id, row.account_username);
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

    const { error } = await supabaseClient.rpc('auth_update_password', {
      p_account_id:       session.accountId,
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

  // ============================================
  // リアルタイム同期
  // ============================================

  initRealtime(onUpdateCallback) {
    if (!supabaseClient) return;

    this.fetchFromSupabase().then(() => {
      if (onUpdateCallback) onUpdateCallback();
    });

    supabaseClient
      .channel(`room:${this.roomId}`)
      .on('postgres_changes', { event: '*', schema: 'public' }, () => {
        this.fetchFromSupabase().then(() => {
          if (onUpdateCallback) onUpdateCallback();
        });
      })
      .subscribe();
  },

  // ============================================
  // Supabase 同期
  // ============================================

  async fetchFromSupabase() {
    if (!supabaseClient || !this.roomId) return;
    try {
      this._isSyncing = true;

      const [sQuery, pQuery, rQuery] = await Promise.all([
        supabaseClient.from('settings').select('*').eq('id', 'global').maybeSingle(),
        supabaseClient.from('players').select('*').eq('room_id', this.roomId),
        supabaseClient.from('rounds').select('*').eq('room_id', this.roomId).order('round_number')
      ]);

      if (sQuery.error || pQuery.error || rQuery.error) {
        throw new Error('Database fetch error');
      }

      // 既存のローカルデータをベースにして Supabase のデータで上書き
      // （settings の Supabase 非管理フィールドを保持するため）
      const data = this.loadAll();

      if (sQuery.data) {
        data.settings.numRounds = sQuery.data.num_rounds;
      }

      // Supabase が実際にデータを持っている場合のみ上書き
      // 空配列 [] は truthy なので length チェックが必要
      // → Supabase にデータがない（同期失敗・オフライン生成）場合はローカルを保持する
      if (pQuery.data && pQuery.data.length > 0) {
        data.players = pQuery.data.map(p => ({
          id: p.id, name: p.name, grade: p.grade, rank: p.rank
        }));
      }

      if (rQuery.data && rQuery.data.length > 0) {
        data.rounds = rQuery.data.map(r => {
          const local = data.rounds.find(lr => lr.roundNumber === r.round_number);
          return {
            roundNumber:  r.round_number,
            matches:      r.matches,
            byePlayerId:  r.bye_player_id,
            confirmed:    local?.confirmed || false,
          };
        });
      }

      localStorage.setItem(this.getStorageKey(), JSON.stringify(data));
      this._isSyncing = false;
    } catch (e) {
      console.warn('Supabaseからのデータ取得に失敗しました(オフラインの可能性があります):', e);
      this._isSyncing = false;
    }
  },

  async syncToSupabase(data) {
    if (!supabaseClient || this._isSyncing || !this.roomId) return;

    try {
      await supabaseClient.from('settings').upsert({
        id: 'global',
        num_rounds:        data.settings.numRounds,
        bye_counts_as_win: true   // 常に不戦勝扱い
      });

      if (data.players.length > 0) {
        await supabaseClient.from('players').upsert(
          data.players.map(p => ({
            id: p.id, name: p.name, grade: p.grade, rank: p.rank,
            room_id: this.roomId
          }))
        );
      }

      if (data.rounds.length === 0) {
        await supabaseClient.from('rounds').delete()
          .eq('room_id', this.roomId);
      } else {
        await supabaseClient.from('rounds').upsert(
          data.rounds.map(r => ({
            room_id:       this.roomId,
            round_number:  r.roundNumber,
            matches:       r.matches,
            bye_player_id: r.byePlayerId
          }))
        );
      }
    } catch (err) {
      console.warn('Supabaseへの同期に失敗:(オフライン)', err);
    }
  },

  // ============================================
  // ローカルデータ操作
  // ============================================

  loadAll() {
    try {
      const raw = localStorage.getItem(this.getStorageKey());
      if (!raw) return this.getDefaultData();
      return JSON.parse(raw);
    } catch {
      return this.getDefaultData();
    }
  },

  saveAll(data) {
    try {
      localStorage.setItem(this.getStorageKey(), JSON.stringify(data));
      this.syncToSupabase(data);
    } catch (e) {
      console.error('ローカル保存失敗:', e);
    }
  },

  getDefaultData() {
    return {
      players: [],
      rounds:  [],
      settings: {
        numRounds: 5,
        gradeAvoidLevel: 2, rankBalanceLevel: 2, matchingFormat: 'random',
        assignSenteGote: true
      }
    };
  },

  addPlayer(player) {
    const data = this.loadAll();
    player.id = this.generateId();
    data.players.push(player);
    this.saveAll(data);
    return player;
  },

  updatePlayer(id, updates) {
    const data = this.loadAll();
    const idx = data.players.findIndex(p => p.id === id);
    if (idx === -1) return null;
    data.players[idx] = { ...data.players[idx], ...updates };
    this.saveAll(data);
    return data.players[idx];
  },

  deletePlayer(id) {
    const data = this.loadAll();
    data.players = data.players.filter(p => p.id !== id);
    this.saveAll(data);
    if (supabaseClient) {
      supabaseClient.from('players').delete().eq('id', id).then().catch(console.warn);
    }
  },

  getPlayers()  { return this.loadAll().players; },
  getRounds()   { return this.loadAll().rounds; },
  getSettings() { return this.loadAll().settings; },

  saveRounds(rounds) {
    const data = this.loadAll();
    data.rounds = rounds;
    this.saveAll(data);
  },

  updateMatchResult(roundIndex, matchIndex, result) {
    const data = this.loadAll();
    if (data.rounds[roundIndex]?.matches[matchIndex]) {
      data.rounds[roundIndex].matches[matchIndex].result = result;
      this.saveAll(data);
    }
  },

  setRoundConfirmed(roundIndex, confirmed) {
    const data = this.loadAll();
    if (data.rounds[roundIndex]) {
      data.rounds[roundIndex].confirmed = confirmed;
      this.saveAll(data);
    }
  },

  updateSettings(settings) {
    const data = this.loadAll();
    data.settings = { ...data.settings, ...settings };
    this.saveAll(data);
  },

  resetAll() {
    localStorage.removeItem(this.getStorageKey());
    if (supabaseClient && this.roomId) {
      supabaseClient.from('players').delete().eq('room_id', this.roomId).then();
      supabaseClient.from('rounds').delete().eq('room_id', this.roomId).then();
    }
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
