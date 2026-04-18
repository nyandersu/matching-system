/**
 * storage.js — LocalStorage & Supabase 同期モジュール
 * オフライン時はLocalStorage、オンライン時はSupabaseと同期する
 * 部屋（roomId）ごとにデータを分離する
 */

const SUPABASE_URL = 'https://nwxpgvefyjzabuwdtrii.supabase.co';
const SUPABASE_KEY = 'sb_publishable_jI0RZ1qkuXdOeacCNX928A_m8dRQGwV';
const supabaseClient = window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;

const ROOM_HISTORY_KEY = 'shogi_room_history';  // 最近使った部屋一覧

const AppStorage = {
  _isSyncing: false,
  roomId: null,   // 現在の部屋ID（null = 未選択）

  // ============================================
  // 部屋管理
  // ============================================

  /** 部屋IDに対応するローカルストレージキー */
  getStorageKey() {
    return `shogi_${this.roomId || '_default'}`;
  },

  /** ランダムな6文字の部屋コードを生成（見間違えやすい文字を除外） */
  generateRoomId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from({ length: 6 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join('');
  },

  /** 部屋をセットし、最近の部屋リストに追加 */
  setRoom(roomId) {
    this.roomId = roomId.toUpperCase().trim();
    this._addToRoomHistory(this.roomId);
    return this.roomId;
  },

  /** 最近使った部屋リストを取得 */
  getRoomHistory() {
    try {
      return JSON.parse(localStorage.getItem(ROOM_HISTORY_KEY) || '[]');
    } catch {
      return [];
    }
  },

  _addToRoomHistory(roomId) {
    const history = this.getRoomHistory().filter(r => r !== roomId);
    history.unshift(roomId);
    localStorage.setItem(ROOM_HISTORY_KEY, JSON.stringify(history.slice(0, 5)));
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

      const data = this.getDefaultData();

      if (sQuery.data) {
        data.settings.numRounds      = sQuery.data.num_rounds;
        data.settings.byeCountsAsWin = sQuery.data.bye_counts_as_win;
      }

      if (pQuery.data) {
        data.players = pQuery.data.map(p => ({
          id: p.id, name: p.name, grade: p.grade, rank: p.rank
        }));
      }

      if (rQuery.data) {
        data.rounds = rQuery.data.map(r => ({
          roundNumber:  r.round_number,
          matches:      r.matches,
          byePlayerId:  r.bye_player_id
        }));
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
        num_rounds:       data.settings.numRounds,
        bye_counts_as_win: data.settings.byeCountsAsWin
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
        numRounds: 5, byeCountsAsWin: true,
        gradeAvoidLevel: 2, rankBalanceLevel: 2, matchingFormat: 'random'
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

  async updateAdminPassword(newPassword) {
    if (!supabaseClient) throw new Error('Supabase未接続');
    const encoded = new TextEncoder().encode(newPassword);
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
    const hash = Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    const { error } = await supabaseClient
      .from('settings').update({ admin_password_hash: hash }).eq('id', 'global');
    if (error) throw error;
  },

  generateId() {
    return 'xxxx-xxxx-xxxx'.replace(/x/g, () =>
      Math.floor(Math.random() * 16).toString(16)
    );
  }
};
