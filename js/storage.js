/**
 * storage.js — LocalStorage管理モジュール
 * プレイヤーデータ、対戦カード、勝敗結果の永続化
 */

const STORAGE_KEY = 'shogi_matching_system';

const Storage = {
  /**
   * 全データを取得
   */
  loadAll() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return this.getDefaultData();
      return JSON.parse(raw);
    } catch (e) {
      console.error('データの読み込みに失敗しました:', e);
      return this.getDefaultData();
    }
  },

  /**
   * 全データを保存
   */
  saveAll(data) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.error('データの保存に失敗しました:', e);
    }
  },

  /**
   * デフォルトデータ
   */
  getDefaultData() {
    return {
      players: [],
      rounds: [],
      settings: {
        numRounds: 5,
        byeCountsAsWin: true
      }
    };
  },

  /**
   * プレイヤーを追加
   */
  addPlayer(player) {
    const data = this.loadAll();
    player.id = this.generateId();
    player.createdAt = Date.now();
    data.players.push(player);
    this.saveAll(data);
    return player;
  },

  /**
   * プレイヤーを更新
   */
  updatePlayer(id, updates) {
    const data = this.loadAll();
    const idx = data.players.findIndex(p => p.id === id);
    if (idx === -1) return null;
    data.players[idx] = { ...data.players[idx], ...updates };
    this.saveAll(data);
    return data.players[idx];
  },

  /**
   * プレイヤーを削除
   */
  deletePlayer(id) {
    const data = this.loadAll();
    data.players = data.players.filter(p => p.id !== id);
    this.saveAll(data);
  },

  /**
   * プレイヤー一覧を取得
   */
  getPlayers() {
    return this.loadAll().players;
  },

  /**
   * ラウンドデータを保存
   */
  saveRounds(rounds) {
    const data = this.loadAll();
    data.rounds = rounds;
    this.saveAll(data);
  },

  /**
   * ラウンドデータを取得
   */
  getRounds() {
    return this.loadAll().rounds;
  },

  /**
   * 対局結果を更新
   */
  updateMatchResult(roundIndex, matchIndex, result) {
    const data = this.loadAll();
    if (data.rounds[roundIndex] && data.rounds[roundIndex].matches[matchIndex]) {
      data.rounds[roundIndex].matches[matchIndex].result = result;
      this.saveAll(data);
    }
  },

  /**
   * 設定を更新
   */
  updateSettings(settings) {
    const data = this.loadAll();
    data.settings = { ...data.settings, ...settings };
    this.saveAll(data);
  },

  /**
   * 設定を取得
   */
  getSettings() {
    return this.loadAll().settings;
  },

  /**
   * 全データをリセット
   */
  resetAll() {
    localStorage.removeItem(STORAGE_KEY);
  },

  /**
   * UUID生成
   */
  generateId() {
    return 'xxxx-xxxx-xxxx'.replace(/x/g, () =>
      Math.floor(Math.random() * 16).toString(16)
    );
  }
};
