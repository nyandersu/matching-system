/**
 * storage.js — LocalStorage & Supabase 同期モジュール
 * オフライン時はLocalStorage、オンライン時はSupabaseと同期する
 */

const STORAGE_KEY = 'shogi_matching_system';
const SUPABASE_URL = 'https://nwxpgvefyjzabuwdtrii.supabase.co';
const SUPABASE_KEY = 'sb_publishable_jI0RZ1qkuXdOeacCNX928A_m8dRQGwV';
const supabaseClient = window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;

const AppStorage = {
  _isSyncing: false,

  /**
   * リアルタイム同期の初期化
   */
  initRealtime(onUpdateCallback) {
    if (!supabaseClient) return;

    // 初回にSupabaseから最新データを取得してローカルを更新
    this.fetchFromSupabase().then(() => {
      if (onUpdateCallback) onUpdateCallback();
    });

    // データベースの変更を購読（誰かが更新したらローカルを上書きして再描画）
    supabaseClient
      .channel('public:any')
      .on('postgres_changes', { event: '*', schema: 'public' }, () => {
        this.fetchFromSupabase().then(() => {
          if (onUpdateCallback) onUpdateCallback();
        });
      })
      .subscribe();
  },

  /**
   * Supabaseから全データを取得してLocalStorageを上書きする
   */
  async fetchFromSupabase() {
    if (!supabaseClient) return;
    try {
      this._isSyncing = true; // 上書き時に自分の保存処理が走らないようにする

      const [sQuery, pQuery, rQuery] = await Promise.all([
        supabaseClient.from('settings').select('*').eq('id', 'global').maybeSingle(),
        supabaseClient.from('players').select('*'),
        supabaseClient.from('rounds').select('*').order('round_number')
      ]);

      if (sQuery.error || pQuery.error || rQuery.error) {
        throw new Error('Database fetch error');
      }

      const sRes = sQuery.data;
      const pRes = pQuery.data;
      const rRes = rQuery.data;

      const data = this.getDefaultData();

      if (sRes) {
        data.settings.numRounds = sRes.num_rounds;
        data.settings.byeCountsAsWin = sRes.bye_counts_as_win;
      }

      if (pRes) {
        data.players = pRes.map(p => ({
          id: p.id,
          name: p.name,
          grade: p.grade,
          rank: p.rank
        }));
      }

      if (rRes) {
        data.rounds = rRes.map(r => ({
          roundNumber: r.round_number,
          matches: r.matches,
          byePlayerId: r.bye_player_id
        }));
      }

      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      this._isSyncing = false;
    } catch (e) {
      console.warn('Supabaseからのデータ取得に失敗しました(オフラインの可能性があります):', e);
      this._isSyncing = false;
    }
  },

  /**
   * Supabaseへ全データを同期送信する (バックグラウンド処理)
   */
  async syncToSupabase(data) {
    if (!supabaseClient || this._isSyncing) return;

    try {
      // 設定の同期
      await supabaseClient.from('settings').upsert({
        id: 'global',
        num_rounds: data.settings.numRounds,
        bye_counts_as_win: data.settings.byeCountsAsWin
      });

      // 選手の同期
      if (data.players.length > 0) {
        await supabaseClient.from('players').upsert(data.players.map(p => ({
          id: p.id,
          name: p.name,
          grade: p.grade,
          rank: p.rank
        })));
      }

      // ラウンド（対戦表）の同期。配列が空の場合はSupabaseの全ラウンドを削除
      if (data.rounds.length === 0) {
        await supabaseClient.from('rounds').delete().neq('round_number', -1);
      } else {
        await supabaseClient.from('rounds').upsert(data.rounds.map(r => ({
          round_number: r.roundNumber,
          matches: r.matches,
          bye_player_id: r.byePlayerId
        })));
      }
    } catch (err) {
      console.warn('Supabaseへの同期に失敗:(オフライン)', err);
    }
  },

  /**
   * 全データを取得
   */
  loadAll() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return this.getDefaultData();
      return JSON.parse(raw);
    } catch (e) {
      return this.getDefaultData();
    }
  },

  /**
   * 全データを保存してSupabaseに同期
   */
  saveAll(data) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      this.syncToSupabase(data);
    } catch (e) {
      console.error('ローカル保存失敗:', e);
    }
  },

  getDefaultData() {
    return {
      players: [],
      rounds: [],
      settings: { numRounds: 5, byeCountsAsWin: true, gradeAvoidLevel: 2, rankBalanceLevel: 2 }
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

  getPlayers() {
    return this.loadAll().players;
  },

  saveRounds(rounds) {
    const data = this.loadAll();
    data.rounds = rounds;
    this.saveAll(data);
  },

  getRounds() {
    return this.loadAll().rounds;
  },

  updateMatchResult(roundIndex, matchIndex, result) {
    const data = this.loadAll();
    if (data.rounds[roundIndex] && data.rounds[roundIndex].matches[matchIndex]) {
      data.rounds[roundIndex].matches[matchIndex].result = result;
      this.saveAll(data);
    }
  },

  updateSettings(settings) {
    const data = this.loadAll();
    data.settings = { ...data.settings, ...settings };
    this.saveAll(data);
  },

  getSettings() {
    return this.loadAll().settings;
  },

  resetAll() {
    localStorage.removeItem(STORAGE_KEY);
    if (supabaseClient) {
      supabaseClient.from('players').delete().neq('id', 'dummy').then();
      supabaseClient.from('rounds').delete().neq('round_number', -1).then();
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
      .from('settings')
      .update({ admin_password_hash: hash })
      .eq('id', 'global');
    if (error) throw error;
  },

  generateId() {
    return 'xxxx-xxxx-xxxx'.replace(/x/g, () =>
      Math.floor(Math.random() * 16).toString(16)
    );
  }
};
