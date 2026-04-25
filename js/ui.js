/**
 * ui.js — UI描画・イベント管理モジュール
 */

const UI = {
  currentTab: 'players',
  editingPlayerId: null,
  displayOpts: { showGrade: true, showRank: true },
  standingsOpts: { showPoints: true },

  // 手動編集モード
  editMode: false,
  editSelected: null,   // { ri, mi, side } — 選択中の選手
  _editSnapshot: null,  // キャンセル用スナップショット

  /**
   * 初期化
   */
  init() {
    this.bindTabEvents();
    this.bindPlayerFormEvents();
    this.bindMatchingEvents();
    this.bindDisplayOpts();
    this.bindStandingsOpts();
    this.bindSettingsEvents();
    this.bindPasswordChangeEvents();
    this._bindPlayerDetailModal();

    // 部屋バッジを表示
    this._showRoomBadge();

    // 初回のローカル描画
    this.renderAll();

    // Supabaseからのリアルタイム同期が来た時のハンドラ
    AppStorage.initRealtime(() => {
      this.renderAll();
    });

    this.showTab('players');
  },

  // ============================================
  // ログイン画面
  // ============================================

  showLoginScreen() {
    document.getElementById('app-main').classList.add('hidden');
    document.getElementById('room-selector-overlay').classList.add('hidden');
    const overlay = document.getElementById('login-overlay');
    overlay.classList.remove('hidden');

    // タブ切り替え
    overlay.querySelectorAll('.login-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        overlay.querySelectorAll('.login-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const isLogin = tab.dataset.tab === 'login';
        document.getElementById('login-form').classList.toggle('hidden', !isLogin);
        document.getElementById('register-form').classList.toggle('hidden', isLogin);
        document.getElementById('login-error').classList.add('hidden');
        document.getElementById('register-error').classList.add('hidden');
      });
    });

    // 目のアイコン（パスワード表示切り替え）
    overlay.querySelectorAll('.toggle-pw').forEach(btn => {
      btn.addEventListener('click', () => {
        const input = document.getElementById(btn.dataset.target);
        const isText = input.type === 'text';
        input.type = isText ? 'password' : 'text';
        btn.textContent = isText ? '👁' : '🙈';
      });
    });

    // ログインフォーム送信
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('login-submit-btn');
      const errEl = document.getElementById('login-error');
      const username = document.getElementById('login-username').value;
      const password = document.getElementById('login-password').value;

      btn.disabled = true;
      btn.textContent = '確認中...';
      errEl.classList.add('hidden');

      try {
        await AppStorage.login(username, password);
        // ログイン成功 → ページリロードして部屋選択へ
        window.location.reload();
      } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
        btn.disabled = false;
        btn.textContent = 'ログイン';
      }
    });

    // 登録フォーム送信
    document.getElementById('register-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('register-submit-btn');
      const errEl = document.getElementById('register-error');
      const username = document.getElementById('register-username').value;
      const password = document.getElementById('register-password').value;
      const confirm  = document.getElementById('register-confirm').value;

      errEl.classList.add('hidden');

      if (username.trim().length < 4) {
        errEl.textContent = 'ユーザー名は4文字以上にしてください';
        errEl.classList.remove('hidden');
        return;
      }
      if (password.length < 6) {
        errEl.textContent = 'パスワードは6文字以上にしてください';
        errEl.classList.remove('hidden');
        return;
      }
      if (password !== confirm) {
        errEl.textContent = 'パスワードが一致しません';
        errEl.classList.remove('hidden');
        return;
      }

      btn.disabled = true;
      btn.textContent = '作成中...';

      try {
        await AppStorage.register(username, password);
        window.location.reload();
      } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
        btn.disabled = false;
        btn.textContent = 'アカウントを作成';
      }
    });
  },

  // ============================================
  // 部屋選択
  // ============================================

  showRoomSelector() {
    // メインコンテンツを隠してオーバーレイを表示
    document.getElementById('app-main').classList.add('hidden');
    const overlay = document.getElementById('room-selector-overlay');
    overlay.classList.remove('hidden');

    // 最近使った部屋を表示
    const history = AppStorage.getRoomHistory();
    if (history.length > 0) {
      const section = document.getElementById('room-history-section');
      const list    = document.getElementById('room-history-list');
      section.classList.remove('hidden');
      list.innerHTML = history.map(r => `
        <button class="room-history-item" data-room="${r}">
          <span class="room-history-code">${r}</span>
          <span class="room-history-arrow">→</span>
        </button>
      `).join('');
      list.querySelectorAll('.room-history-item').forEach(btn => {
        btn.addEventListener('click', () => {
          this._enterRoom(btn.dataset.room);
        });
      });
    }

    // 新規作成ボタン
    document.getElementById('room-create-btn').addEventListener('click', () => {
      const newId = AppStorage.generateRoomId();
      this._enterRoom(newId);
    });

    // 参加ボタン
    document.getElementById('room-join-btn').addEventListener('click', () => {
      this._joinRoomFromInput();
    });

    // Enterキーでも参加
    document.getElementById('room-code-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._joinRoomFromInput();
    });

    // 自動大文字変換
    document.getElementById('room-code-input').addEventListener('input', (e) => {
      const pos = e.target.selectionStart;
      e.target.value = e.target.value.toUpperCase();
      e.target.setSelectionRange(pos, pos);
    });
  },

  _joinRoomFromInput() {
    const code = document.getElementById('room-code-input').value.trim().toUpperCase();
    if (code.length < 4) {
      // 軽いシェイクアニメーション
      const input = document.getElementById('room-code-input');
      input.classList.add('shake');
      setTimeout(() => input.classList.remove('shake'), 400);
      return;
    }
    this._enterRoom(code);
  },

  _enterRoom(roomId) {
    const url = new URL(window.location.href);
    url.searchParams.set('room', roomId.toUpperCase());
    window.location.href = url.toString();
  },

  _showRoomBadge() {
    // 部屋コードバッジ
    const bar = document.getElementById('room-info-bar');
    const display = document.getElementById('room-code-display');
    if (bar && display && AppStorage.roomId) {
      display.textContent = AppStorage.roomId;
      bar.classList.remove('hidden');

      document.getElementById('change-room-btn').addEventListener('click', () => {
        const url = new URL(window.location.href);
        url.searchParams.delete('room');
        window.location.href = url.toString();
      });
    }

    // ユーザー情報バー
    const userBar = document.getElementById('user-info-bar');
    const userNameEl = document.getElementById('user-display-name');
    const session = AppStorage.getSession();
    if (userBar && session) {
      userNameEl.textContent = session.username;
      userBar.classList.remove('hidden');

      document.getElementById('logout-btn').addEventListener('click', () => {
        if (confirm('ログアウトしますか？')) {
          AppStorage.clearSession();
          window.location.href = window.location.pathname; // room param も消す
        }
      });
    }
  },

  renderAll() {
    // 現在のタブに応じて必要な描画を行うか、もしくは全再描画する
    this.renderPlayers();
    this.loadSettings();
    this.renderMatchingResult();
    this.renderRounds();
    this.renderStandings();
  },

  // ============================================
  // タブ管理
  // ============================================

  bindTabEvents() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.showTab(btn.dataset.tab);
      });
    });
  },

  showTab(tabId) {
    this.currentTab = tabId;
    
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabId);
    });

    document.querySelectorAll('.tab-panel').forEach(panel => {
      panel.classList.toggle('active', panel.id === `tab-${tabId}`);
    });

    // タブ切り替え時にデータ更新
    if (tabId === 'results') this.renderRounds();
    if (tabId === 'standings') this.renderStandings();
  },

  // ============================================
  // 選手管理
  // ============================================

  bindPlayerFormEvents() {
    const form = document.getElementById('player-form');
    const cancelBtn = document.getElementById('cancel-edit-btn');

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handlePlayerSubmit();
    });

    cancelBtn.addEventListener('click', () => {
      this.resetPlayerForm();
    });
  },

  handlePlayerSubmit() {
    const name = document.getElementById('player-name').value.trim();
    const grade = parseInt(document.getElementById('player-grade').value);
    const rank = document.getElementById('player-rank').value;

    if (!name) {
      this.showToast('名前を入力してください', 'error');
      return;
    }

    if (this.editingPlayerId) {
      AppStorage.updatePlayer(this.editingPlayerId, { name, grade, rank });
      this.showToast(`${name} を更新しました`, 'success');
    } else {
      AppStorage.addPlayer({ name, grade, rank });
      this.showToast(`${name} を追加しました`, 'success');
    }

    this.resetPlayerForm();
    this.renderPlayers();
  },

  resetPlayerForm() {
    this.editingPlayerId = null;
    document.getElementById('player-form').reset();
    document.getElementById('form-title').textContent = '選手を追加';
    document.getElementById('submit-btn').textContent = '追加';
    document.getElementById('cancel-edit-btn').classList.add('hidden');
    document.getElementById('player-name').focus();
  },

  editPlayer(id) {
    const players = AppStorage.getPlayers();
    const player = players.find(p => p.id === id);
    if (!player) return;

    this.editingPlayerId = id;
    document.getElementById('player-name').value = player.name;
    document.getElementById('player-grade').value = player.grade;
    document.getElementById('player-rank').value = player.rank;
    document.getElementById('form-title').textContent = '選手を編集';
    document.getElementById('submit-btn').textContent = '更新';
    document.getElementById('cancel-edit-btn').classList.remove('hidden');
    document.getElementById('player-name').focus();

    // フォームまでスクロール
    document.getElementById('player-form').scrollIntoView({ behavior: 'smooth' });
  },

  deletePlayer(id) {
    const players = AppStorage.getPlayers();
    const player = players.find(p => p.id === id);
    if (!player) return;

    if (confirm(`${player.name} を削除しますか？`)) {
      AppStorage.deletePlayer(id);
      this.showToast(`${player.name} を削除しました`, 'info');
      this.renderPlayers();
    }
  },

  renderPlayers() {
    const players = AppStorage.getPlayers();
    const container = document.getElementById('player-list');
    const countEl = document.getElementById('player-count');

    countEl.textContent = `${players.length}人`;

    if (players.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">♟</div>
          <p>まだ選手が登録されていません</p>
          <p class="empty-hint">上のフォームから選手を追加してください</p>
        </div>`;
      return;
    }

    // 学年→ランク順にソート
    const sorted = [...players].sort((a, b) => {
      if (a.grade !== b.grade) return a.grade - b.grade;
      const rankOrder = { S: 0, A: 1, B: 2, C: 3 };
      return rankOrder[a.rank] - rankOrder[b.rank];
    });

    container.innerHTML = `
      <div class="player-table-wrapper">
        <table class="player-table">
          <thead>
            <tr>
              <th>名前</th>
              <th>学年</th>
              <th>ランク</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${sorted.map(p => `
              <tr>
                <td class="player-name-cell">${this.escapeHtml(p.name)}</td>
                <td>${p.grade}年</td>
                <td><span class="rank-badge rank-${p.rank}">${p.rank}</span></td>
                <td class="actions-cell">
                  <button class="btn-icon btn-edit" onclick="UI.editPlayer('${p.id}')" title="編集">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                  </button>
                  <button class="btn-icon btn-delete" onclick="UI.deletePlayer('${p.id}')" title="削除">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                  </button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>`;

    // 統計サマリー
    const gradeStats = {};
    const rankStats = { S: 0, A: 0, B: 0, C: 0 };
    players.forEach(p => {
      gradeStats[p.grade] = (gradeStats[p.grade] || 0) + 1;
      rankStats[p.rank]++;
    });

    const statsHtml = `
      <div class="player-stats">
        <div class="stat-group">
          <span class="stat-label">学年分布:</span>
          ${Object.entries(gradeStats).sort((a,b) => a[0]-b[0]).map(([g, c]) => `<span class="stat-chip">${g}年: ${c}人</span>`).join('')}
        </div>
        <div class="stat-group">
          <span class="stat-label">ランク分布:</span>
          ${Object.entries(rankStats).filter(([,c]) => c > 0).map(([r, c]) => `<span class="stat-chip rank-${r}">${r}: ${c}人</span>`).join('')}
        </div>
      </div>`;

    container.innerHTML += statsHtml;
  },

  // ============================================
  // マッチング
  // ============================================

  bindMatchingEvents() {
    document.getElementById('generate-btn').addEventListener('click', () => {
      if (this.editMode) this.exitEditMode(true);
      this.generateMatching();
    });

    // セグメントコントロール（先後割り当て・同学年回避・ランク均等化）
    // ※ sente-gote の hidden input は命名が異なるため個別にマップ
    const segmentInputMap = {
      'sente-gote':   'assign-sente-gote',
      'grade-avoid':  'grade-avoid-weight',
      'rank-balance': 'rank-balance-weight',
    };
    Object.entries(segmentInputMap).forEach(([id, inputId]) => {
      document.querySelectorAll(`#${id}-segment .wseg-btn`).forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll(`#${id}-segment .wseg-btn`)
            .forEach(b => b.classList.remove('wseg-active'));
          btn.classList.add('wseg-active');
          document.getElementById(inputId).value = btn.dataset.value;
        });
      });
    });

    document.getElementById('matching-format').addEventListener('change', () => {
      this.updateGenerateButton();
    });

    document.getElementById('clear-rounds-btn').addEventListener('click', () => {
      if (confirm('生成された対戦表をすべてクリアしますか？結果も失われます。')) {
        if (this.editMode) this.exitEditMode(true);
        AppStorage.saveRounds([]);
        this.renderMatchingResult();
        this.showToast('対戦表をクリアしました', 'info');
      }
    });

    // 手動編集モード
    document.getElementById('edit-matches-btn').addEventListener('click', () => {
      const rounds = AppStorage.getRounds();
      if (rounds.length === 0) {
        this.showToast('先に対戦表を生成してください', 'error');
        return;
      }
      this.enterEditMode();
    });
    document.getElementById('edit-done-btn').addEventListener('click', () => {
      this.exitEditMode(false);
      this.showToast('対戦表を保存しました', 'success');
    });
    document.getElementById('edit-cancel-btn').addEventListener('click', () => {
      this.exitEditMode(true);
      this.showToast('編集をキャンセルしました', 'info');
    });

    document.getElementById('export-matches-btn').addEventListener('click', () => {
      const rounds = AppStorage.getRounds();
      const players = AppStorage.getPlayers();
      if (rounds.length === 0) {
        this.showToast('エクスポートする対戦表がありません', 'error');
        return;
      }
      const assignSenteGote = parseInt(document.getElementById('assign-sente-gote').value) === 1;
      PDF.exportMatchTable(rounds, players, {
        ...this.displayOpts,
        assignSenteGote,
      });
    });
  },

  generateMatching() {
    const players        = AppStorage.getPlayers();
    const numRounds        = parseInt(document.getElementById('num-rounds').value);
    const gradeAvoidLevel  = parseInt(document.getElementById('grade-avoid-weight').value);
    const rankBalanceLevel = parseInt(document.getElementById('rank-balance-weight').value);
    const matchingFormat   = document.getElementById('matching-format').value;
    const assignSenteGote  = parseInt(document.getElementById('assign-sente-gote').value) === 1;

    if (players.length < 2) {
      this.showToast('最低2人の選手が必要です', 'error');
      return;
    }

    const btn = document.getElementById('generate-btn');
    btn.textContent = '生成中...';
    btn.disabled = true;

    setTimeout(() => {
      const settings = AppStorage.getSettings();
      const opts = { gradeAvoidLevel, rankBalanceLevel, assignSenteGote };

      if (matchingFormat === 'swiss') {
        this._generateSwissRound(players, numRounds, opts);
      } else {
        this._generateAllRoundsRandom(players, numRounds, opts);
      }

      AppStorage.updateSettings({ numRounds, gradeAvoidLevel, rankBalanceLevel, matchingFormat, assignSenteGote });
      this.renderMatchingResult();
    }, 100);
  },

  _generateAllRoundsRandom(players, numRounds, opts) {
    const btn    = document.getElementById('generate-btn');
    const result = Matching.generateAllRounds(players, numRounds, opts);

    btn.textContent = '⚡ 対戦表を生成';
    btn.disabled    = false;

    if (result.error) {
      this.showToast(result.error, 'error');
      return;
    }
    AppStorage.saveRounds(result.rounds);
    this.showToast(`全${numRounds}回戦の対戦表を生成しました！`, 'success');
  },

  _generateSwissRound(players, numRounds, opts) {
    const btn          = document.getElementById('generate-btn');
    const existingRounds = AppStorage.getRounds();

    // 上限チェック
    if (existingRounds.length >= numRounds) {
      btn.textContent = `✓ 全${numRounds}回戦完了`;
      btn.disabled    = true;
      this.showToast('全ラウンド完了しています', 'info');
      return;
    }

    // 前ラウンドの結果が未入力なら生成不可
    if (existingRounds.length > 0) {
      const last = existingRounds[existingRounds.length - 1];
      if (last.matches.some(m => m.result === null)) {
        btn.textContent = `⚡ 第${existingRounds.length + 1}回戦を生成`;
        btn.disabled    = false;
        this.showToast(`第${existingRounds.length}回戦の結果をすべて入力してください`, 'error');
        return;
      }
    }

    const result = Matching.generateNextSwissRound(players, existingRounds, opts);

    if (result.error) {
      btn.textContent = `⚡ 第${existingRounds.length + 1}回戦を生成`;
      btn.disabled    = false;
      this.showToast(result.error, 'error');
      return;
    }

    const updatedRounds = [...existingRounds, result.round];
    AppStorage.saveRounds(updatedRounds);

    const next = updatedRounds.length + 1;
    if (updatedRounds.length >= numRounds) {
      btn.textContent = `✓ 全${numRounds}回戦完了`;
      btn.disabled    = true;
    } else {
      btn.textContent = `⚡ 第${next}回戦を生成`;
      btn.disabled    = false;
    }
    this.showToast(`第${result.round.roundNumber}回戦の対戦表を生成しました！`, 'success');
  },

  // フォーマット・ラウンド数に応じてボタン表示を更新
  updateGenerateButton() {
    const format    = document.getElementById('matching-format').value;
    const numRounds = parseInt(document.getElementById('num-rounds').value);
    const btn       = document.getElementById('generate-btn');
    const rounds    = AppStorage.getRounds();

    if (format === 'random') {
      btn.textContent = '⚡ 対戦表を生成';
      btn.disabled    = false;
      return;
    }

    // スイスドロー
    if (rounds.length === 0) {
      btn.textContent = '⚡ 第1回戦を生成';
      btn.disabled    = false;
    } else if (rounds.length >= numRounds) {
      btn.textContent = `✓ 全${numRounds}回戦完了`;
      btn.disabled    = true;
    } else {
      const last    = rounds[rounds.length - 1];
      const allDone = last.matches.every(m => m.result !== null);
      btn.textContent = `⚡ 第${rounds.length + 1}回戦を生成`;
      btn.disabled    = !allDone;
    }
  },

  // ============================================
  // 手動編集モード
  // ============================================

  enterEditMode() {
    this.editMode = true;
    this.editSelected = null;
    this._editSnapshot = JSON.parse(JSON.stringify(AppStorage.getRounds()));
    document.getElementById('edit-matches-btn').classList.add('hidden');
    document.getElementById('edit-mode-bar').classList.remove('hidden');
    this.renderMatchingResult();
  },

  exitEditMode(cancel = false) {
    if (cancel && this._editSnapshot) {
      AppStorage.saveRounds(this._editSnapshot);
    }
    this.editMode = false;
    this.editSelected = null;
    this._editSnapshot = null;
    document.getElementById('edit-matches-btn').classList.remove('hidden');
    document.getElementById('edit-mode-bar').classList.add('hidden');
    this.renderMatchingResult();
  },

  /** 先後交代（同一対局内でplayer1↔player2を入れ替え） */
  swapSenteGote(ri, mi) {
    const rounds = AppStorage.getRounds();
    const m = rounds[ri].matches[mi];
    const tmp = {
      id: m.player1Id, name: m.player1Name,
      grade: m.player1Grade, rank: m.player1Rank
    };
    m.player1Id    = m.player2Id;    m.player2Id    = tmp.id;
    m.player1Name  = m.player2Name;  m.player2Name  = tmp.name;
    m.player1Grade = m.player2Grade; m.player2Grade = tmp.grade;
    m.player1Rank  = m.player2Rank;  m.player2Rank  = tmp.rank;
    // 結果も反転
    if (m.result === 'player1') m.result = 'player2';
    else if (m.result === 'player2') m.result = 'player1';
    AppStorage.saveRounds(rounds);
    this.renderMatchingResult();
  },

  /** 選手をタップして選択 → 2人目タップで入れ替え */
  selectPlayerForSwap(ri, mi, side) {
    const sel = this.editSelected;
    // 同じ選手を再タップ → 選択解除
    if (sel && sel.ri === ri && sel.mi === mi && sel.side === side) {
      this.editSelected = null;
      this.renderMatchingResult();
      return;
    }
    // 1人目の選択
    if (!sel) {
      this.editSelected = { ri, mi, side };
      this.renderMatchingResult();
      return;
    }
    // 2人目の選択 → 入れ替え実行
    this._swapPlayers(sel.ri, sel.mi, sel.side, ri, mi, side);
    this.editSelected = null;
  },

  _swapPlayers(ri1, mi1, side1, ri2, mi2, side2) {
    const rounds = AppStorage.getRounds();
    const m1 = rounds[ri1].matches[mi1];
    const m2 = rounds[ri2].matches[mi2];

    const get = (m, s) => ({
      id:    m[s + 'Id'],
      name:  m[s + 'Name'],
      grade: m[s + 'Grade'],
      rank:  m[s + 'Rank'],
    });
    const set = (m, s, p) => {
      m[s + 'Id']    = p.id;
      m[s + 'Name']  = p.name;
      m[s + 'Grade'] = p.grade;
      m[s + 'Rank']  = p.rank;
    };

    const p1 = get(m1, side1);
    const p2 = get(m2, side2);
    set(m1, side1, p2);
    set(m2, side2, p1);

    // 入れ替えた対局の結果をリセット
    let cleared = false;
    if (m1.result) { m1.result = null; cleared = true; }
    if (!(ri1 === ri2 && mi1 === mi2) && m2.result) { m2.result = null; cleared = true; }

    AppStorage.saveRounds(rounds);
    if (cleared) {
      this.showToast('組み合わせを変更したため対局結果をリセットしました', 'info');
    }
    this.renderMatchingResult();
  },

  renderMatchingResult() {
    const rounds = AppStorage.getRounds();
    const players = AppStorage.getPlayers();
    const container = document.getElementById('matching-result');
    const playerMap = {};
    players.forEach(p => playerMap[p.id] = p);

    if (rounds.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">⚔</div>
          <p>対戦表がまだ生成されていません</p>
          <p class="empty-hint">上のボタンから対戦表を生成してください</p>
        </div>`;
      return;
    }

    let html = '';
    rounds.forEach((round, ri) => {
      html += `
        <div class="round-card">
          <h3 class="round-title">
            <span class="round-number">第${round.roundNumber}回戦</span>
            <span class="match-count">${round.matches.length}対局</span>
          </h3>
          <div class="match-list">
            ${round.matches.map((match, i) => {
              const { showGrade, showRank } = this.displayOpts;

              if (this.editMode) {
                // ---- 編集モード ----
                const sel = this.editSelected;
                const isSel1 = sel && sel.ri === ri && sel.mi === i && sel.side === 'player1';
                const isSel2 = sel && sel.ri === ri && sel.mi === i && sel.side === 'player2';
                const playerBtn = (side, name, grade, rank) => `
                  <button type="button"
                    class="edit-player-btn${(side === 'player1' ? isSel1 : isSel2) ? ' edit-selected' : ''}"
                    onclick="UI.selectPlayerForSwap(${ri}, ${i}, '${side}')">
                    <span class="edit-player-name">${this.escapeHtml(name)}</span>
                    ${showGrade ? `<span class="edit-player-meta">${grade}年</span>` : ''}
                    ${showRank  ? `<span class="rank-badge rank-${rank}">${rank}</span>` : ''}
                  </button>`;
                return `
                  <div class="match-card editing-card">
                    <div class="match-number">${i + 1}</div>
                    ${playerBtn('player1', match.player1Name, match.player1Grade, match.player1Rank)}
                    <button type="button" class="swap-btn" onclick="UI.swapSenteGote(${ri}, ${i})" title="先後交代">⇄</button>
                    ${playerBtn('player2', match.player2Name, match.player2Grade, match.player2Rank)}
                  </div>`;
              }

              // ---- 通常表示 ----
              const resultClass   = match.result ? 'has-result' : '';
              const showSenteGote = parseInt(document.getElementById('assign-sente-gote')?.value ?? '1') === 1;
              const p1label = showSenteGote ? '<span class="sente-label">先</span>' : '';
              const p2label = showSenteGote ? '<span class="gote-label">後</span>'  : '';
              return `
                <div class="match-card ${resultClass}">
                  <div class="match-number">${i + 1}</div>
                  <div class="match-player player1 ${match.result === 'player1' ? 'winner' : match.result === 'player2' ? 'loser' : ''}">
                    ${p1label}
                    <span class="player-info">
                      <span class="player-name-text">${this.escapeHtml(match.player1Name)}</span>
                      ${showGrade ? `<span class="player-grade-text">${match.player1Grade}年</span>` : ''}
                      ${showRank  ? `<span class="rank-badge rank-${match.player1Rank}">${match.player1Rank}</span>` : ''}
                    </span>
                  </div>
                  <div class="match-vs">VS</div>
                  <div class="match-player player2 ${match.result === 'player2' ? 'winner' : match.result === 'player1' ? 'loser' : ''}">
                    ${p2label}
                    <span class="player-info">
                      <span class="player-name-text">${this.escapeHtml(match.player2Name)}</span>
                      ${showGrade ? `<span class="player-grade-text">${match.player2Grade}年</span>` : ''}
                      ${showRank  ? `<span class="rank-badge rank-${match.player2Rank}">${match.player2Rank}</span>` : ''}
                    </span>
                  </div>
                </div>`;
            }).join('')}
          </div>
          ${round.byePlayerId && playerMap[round.byePlayerId] ? `
            <div class="bye-info">
              <span class="bye-label">不戦勝:</span>
              <span>${this.escapeHtml(playerMap[round.byePlayerId].name)}</span>
            </div>` : ''}
        </div>`;
    });

    container.innerHTML = html;
  },

  // ============================================
  // 結果入力
  // ============================================

  renderRounds() {
    const rounds = AppStorage.getRounds();
    const players = AppStorage.getPlayers();
    const container = document.getElementById('results-container');
    const playerMap = {};
    players.forEach(p => playerMap[p.id] = p);

    if (rounds.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📝</div>
          <p>対戦表がまだ生成されていません</p>
          <p class="empty-hint">「マッチング」タブから対戦表を生成してください</p>
        </div>`;
      return;
    }

    let html = '';
    rounds.forEach((round, ri) => {
      const completedCount = round.matches.filter(m => m.result).length;
      const totalCount = round.matches.length;
      const progressPct = totalCount > 0 ? (completedCount / totalCount * 100) : 0;
      const isConfirmed = !!round.confirmed;

      html += `
        <div class="round-card${isConfirmed ? ' round-confirmed' : ''}">
          <h3 class="round-title">
            <span class="round-number">第${round.roundNumber}回戦</span>
            <span class="progress-text">${completedCount}/${totalCount} 完了</span>
          </h3>
          <div class="progress-bar">
            <div class="progress-fill" style="width: ${progressPct}%"></div>
          </div>
          <div class="result-list">
            ${round.matches.map((match, mi) => {
              const { showGrade, showRank } = this.displayOpts;
              const p1meta = [
                showGrade ? `${match.player1Grade}年` : '',
                showRank  ? match.player1Rank : ''
              ].filter(Boolean).join(' ');
              const p2meta = [
                showGrade ? `${match.player2Grade}年` : '',
                showRank  ? match.player2Rank : ''
              ].filter(Boolean).join(' ');
              const onclick1 = isConfirmed ? '' : `onclick="UI.setResult(${ri}, ${mi}, 'player1')"`;
              const onclickD = isConfirmed ? '' : `onclick="UI.setResult(${ri}, ${mi}, 'draw')"`;
              const onclick2 = isConfirmed ? '' : `onclick="UI.setResult(${ri}, ${mi}, 'player2')"`;
              const onclickR = isConfirmed ? '' : `onclick="UI.setResult(${ri}, ${mi}, null)"`;
              return `
              <div class="result-row ${match.result ? 'completed' : ''}">
                <div class="result-player p1 ${match.result === 'player1' ? 'winner' : ''}">
                  <span class="result-player-name">${this.escapeHtml(match.player1Name)}</span>
                  ${p1meta ? `<span class="result-player-meta">${p1meta}</span>` : ''}
                </div>
                <div class="result-buttons">
                  <button class="result-btn win-btn ${match.result === 'player1' ? 'active' : ''}"
                    ${isConfirmed ? 'disabled' : ''} ${onclick1} title="${match.player1Name} の勝ち">○</button>
                  <button class="result-btn draw-btn ${match.result === 'draw' ? 'active' : ''}"
                    ${isConfirmed ? 'disabled' : ''} ${onclickD} title="引き分け">△</button>
                  <button class="result-btn win-btn ${match.result === 'player2' ? 'active' : ''}"
                    ${isConfirmed ? 'disabled' : ''} ${onclick2} title="${match.player2Name} の勝ち">○</button>
                  ${match.result && !isConfirmed ? `
                    <button class="result-btn reset-btn" ${onclickR} title="リセット">✕</button>
                  ` : ''}
                </div>
                <div class="result-player p2 ${match.result === 'player2' ? 'winner' : ''}">
                  <span class="result-player-name">${this.escapeHtml(match.player2Name)}</span>
                  ${p2meta ? `<span class="result-player-meta">${p2meta}</span>` : ''}
                </div>
              </div>`;
            }).join('')}
          </div>
          ${round.byePlayerId && playerMap[round.byePlayerId] ? `
            <div class="bye-info">
              <span class="bye-label">不戦勝:</span>
              <span>${this.escapeHtml(playerMap[round.byePlayerId].name)}</span>
            </div>` : ''}
          <div class="round-confirm-bar">
            ${isConfirmed ? `
              <span class="confirm-badge">✓ 確定済み</span>
              <button class="btn btn-ghost btn-sm" onclick="UI.unconfirmRound(${ri})">確定を解除</button>
            ` : `
              <button class="btn btn-confirm btn-sm" onclick="UI.confirmRound(${ri})">この回戦を確定する</button>
            `}
          </div>
        </div>`;
    });

    container.innerHTML = html;
  },

  setResult(roundIndex, matchIndex, result) {
    AppStorage.updateMatchResult(roundIndex, matchIndex, result);
    this.renderRounds();
    this.updateGenerateButton();
  },

  confirmRound(roundIndex) {
    const rounds = AppStorage.getRounds();
    const round = rounds[roundIndex];
    if (!round) return;
    const pending = round.matches.filter(m => !m.result).length;
    if (pending > 0) {
      if (!confirm(`${pending}件の結果が未入力ですが、この回戦を確定しますか？`)) return;
    }
    AppStorage.setRoundConfirmed(roundIndex, true);
    this.renderRounds();
    this.showToast(`第${round.roundNumber}回戦を確定しました`, 'success');
  },

  unconfirmRound(roundIndex) {
    const rounds = AppStorage.getRounds();
    const round = rounds[roundIndex];
    if (!round) return;
    AppStorage.setRoundConfirmed(roundIndex, false);
    this.renderRounds();
    this.showToast(`第${round.roundNumber}回戦の確定を解除しました`, 'info');
  },

  // ============================================
  // 成績表
  // ============================================

  renderStandings() {
    const players = AppStorage.getPlayers();
    const rounds = AppStorage.getRounds();
    const container = document.getElementById('standings-container');
    const settings = AppStorage.getSettings();

    if (rounds.length === 0 || players.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🏆</div>
          <p>まだ成績データがありません</p>
          <p class="empty-hint">対戦結果を入力すると成績が表示されます</p>
        </div>`;
      return;
    }

    const standings = Matching.calculateStandings(players, rounds, true);
    const showPt = this.standingsOpts.showPoints;

    // 完了数
    let totalMatches = 0, completedMatches = 0;
    rounds.forEach(r => {
      r.matches.forEach(m => {
        totalMatches++;
        if (m.result) completedMatches++;
      });
    });

    let html = `
      <div class="standings-header">
        <div class="standings-progress">
          <span>進行状況: ${completedMatches}/${totalMatches} 対局完了</span>
          <div class="progress-bar">
            <div class="progress-fill" style="width: ${totalMatches > 0 ? (completedMatches/totalMatches*100) : 0}%"></div>
          </div>
        </div>
      </div>
      <div class="standings-table-wrapper">
        <table class="standings-table">
          <thead>
            <tr>
              <th>順位</th>
              <th>名前</th>
              <th>学年</th>
              <th>勝</th>
              <th>敗</th>
              <th>分</th>
              <th>不戦勝</th>
              <th>勝率</th>
              ${showPt ? '<th>Pt</th>' : ''}
            </tr>
          </thead>
          <tbody>
            ${standings.map((s, i) => `
              <tr class="${i < 3 ? 'top-' + (i+1) : ''}">
                <td class="position-cell">
                  ${s.position <= 3 ? `<span class="medal medal-${s.position}">${['🥇','🥈','🥉'][s.position-1]}</span>` : s.position}
                </td>
                <td class="name-cell name-cell-link" onclick="UI.showPlayerDetail('${s.id}')">${this.escapeHtml(s.name)} <span class="name-cell-hint">›</span></td>
                <td>${s.grade}年</td>
                <td class="win-cell">${s.wins}</td>
                <td class="loss-cell">${s.losses}</td>
                <td>${s.draws}</td>
                <td>${s.byes}</td>
                <td>${s.winRate.toFixed(1)}%</td>
                ${showPt ? `<td class="points-cell">${s.points}</td>` : ''}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>`;

    container.innerHTML = html;
  },

  // ============================================
  // 成績表オプション（Pt表示トグル・算出方法）
  // ============================================

  bindStandingsOpts() {
    // Pt 表示トグル
    const toggleBtn = document.getElementById('toggle-pt-btn');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        this.standingsOpts.showPoints = !this.standingsOpts.showPoints;
        toggleBtn.textContent = this.standingsOpts.showPoints ? 'Pt 表示中' : 'Pt 非表示';
        toggleBtn.classList.toggle('toggle-active', this.standingsOpts.showPoints);
        this.renderStandings();
      });
    }

    // Pt算出方法モーダル
    const infoBtn  = document.getElementById('pt-info-btn');
    const infoModal = document.getElementById('pt-info-modal');
    const infoClose = document.getElementById('pt-info-close');
    if (infoBtn && infoModal) {
      infoBtn.addEventListener('click', () => infoModal.classList.remove('hidden'));
      infoClose.addEventListener('click', () => infoModal.classList.add('hidden'));
      infoModal.addEventListener('click', e => {
        if (e.target === infoModal) infoModal.classList.add('hidden');
      });
    }
  },

  // ============================================
  // 個人成績モーダル
  // ============================================

  _bindPlayerDetailModal() {
    document.getElementById('player-detail-close').addEventListener('click', () => {
      document.getElementById('player-detail-modal').classList.add('hidden');
    });
    document.getElementById('player-detail-modal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) {
        e.currentTarget.classList.add('hidden');
      }
    });
  },

  showPlayerDetail(playerId) {
    const players  = AppStorage.getPlayers();
    const rounds   = AppStorage.getRounds();
    const player   = players.find(p => p.id === playerId);
    if (!player) return;

    const standings = Matching.calculateStandings(players, rounds, true);
    const stat      = standings.find(s => s.id === playerId) || {};
    const history   = this._getPlayerHistory(playerId, rounds);

    // ランク別戦績
    const rankStats = { S: { w:0, l:0, d:0 }, A: { w:0, l:0, d:0 }, B: { w:0, l:0, d:0 }, C: { w:0, l:0, d:0 } };
    history.filter(h => h.type === 'match').forEach(h => {
      const r = rankStats[h.opponentRank];
      if (!r || !h.result) return;
      if (h.result === 'win')  r.w++;
      else if (h.result === 'loss') r.l++;
      else if (h.result === 'draw') r.d++;
    });

    const resultBadge = (r) =>
        r === 'win'  ? '<span class="pd-result win">○ 勝</span>'
      : r === 'loss' ? '<span class="pd-result loss">● 敗</span>'
      : r === 'draw' ? '<span class="pd-result draw">△ 分</span>'
      : r === 'bye'  ? '<span class="pd-result bye">不戦勝</span>'
      :                '<span class="pd-result pending">未入力</span>';

    const rankRowHtml = Object.entries(rankStats)
      .filter(([, v]) => v.w + v.l + v.d > 0)
      .map(([rank, v]) => `
        <div class="pd-rank-row">
          <span class="rank-badge rank-${rank}">${rank}</span>
          <span class="pd-rank-record">
            <span class="pd-w">${v.w}勝</span>
            <span class="pd-l">${v.l}敗</span>
            ${v.d > 0 ? `<span class="pd-d">${v.d}分</span>` : ''}
          </span>
          <div class="pd-rank-bar">
            ${v.w + v.l + v.d > 0 ? `
              <div class="pd-bar-win"  style="width:${v.w/(v.w+v.l+v.d)*100}%"></div>
              <div class="pd-bar-loss" style="width:${v.l/(v.w+v.l+v.d)*100}%"></div>
              <div class="pd-bar-draw" style="width:${v.d/(v.w+v.l+v.d)*100}%"></div>
            ` : ''}
          </div>
        </div>`).join('');

    const historyRowsHtml = history.length === 0
      ? '<p class="pd-empty">対戦データがありません</p>'
      : history.map(h => {
          if (h.type === 'bye') return `
            <tr>
              <td class="pd-round">第${h.roundNumber}回戦</td>
              <td colspan="2" class="pd-bye-cell">— 空き手合い —</td>
              <td>${resultBadge('bye')}</td>
            </tr>`;
          const sideLabel = h.side === 'player1' ? '<span class="pd-side sente">先手</span>' : '<span class="pd-side gote">後手</span>';
          return `
            <tr>
              <td class="pd-round">第${h.roundNumber}回戦</td>
              <td class="pd-opponent">
                <span class="pd-opp-name">${this.escapeHtml(h.opponentName)}</span>
                <span class="pd-opp-meta">${h.opponentGrade}年 <span class="rank-badge rank-${h.opponentRank}" style="font-size:10px;padding:1px 5px;">${h.opponentRank}</span></span>
              </td>
              <td>${sideLabel}</td>
              <td>${resultBadge(h.result)}</td>
            </tr>`;
        }).join('');

    const totalGames = (stat.wins || 0) + (stat.losses || 0) + (stat.draws || 0);
    const winPct = totalGames > 0 ? ((stat.wins || 0) / totalGames * 100).toFixed(0) : 0;

    document.getElementById('player-detail-content').innerHTML = `
      <div class="pd-header">
        <span class="rank-badge rank-${player.rank} pd-rank-badge">${player.rank}</span>
        <div class="pd-name-block">
          <span class="pd-name">${this.escapeHtml(player.name)}</span>
          <span class="pd-grade">${player.grade}年</span>
        </div>
        <div class="pd-position">${stat.position ? `<span class="pd-pos-num">${stat.position}</span>位` : '—'}</div>
      </div>

      <div class="pd-summary">
        <div class="pd-stat-box"><span class="pd-stat-val win-color">${stat.wins ?? 0}</span><span class="pd-stat-lbl">勝</span></div>
        <div class="pd-stat-box"><span class="pd-stat-val loss-color">${stat.losses ?? 0}</span><span class="pd-stat-lbl">敗</span></div>
        <div class="pd-stat-box"><span class="pd-stat-val">${stat.draws ?? 0}</span><span class="pd-stat-lbl">分</span></div>
        <div class="pd-stat-box"><span class="pd-stat-val bye-color">${stat.byes ?? 0}</span><span class="pd-stat-lbl">不戦勝</span></div>
        <div class="pd-stat-box"><span class="pd-stat-val">${winPct}%</span><span class="pd-stat-lbl">勝率</span></div>
        <div class="pd-stat-box"><span class="pd-stat-val amber-color">${stat.points ?? 0}</span><span class="pd-stat-lbl">Pt</span></div>
      </div>

      ${rankRowHtml ? `
      <div class="pd-section">
        <h3 class="pd-section-title">ランク別戦績</h3>
        <div class="pd-rank-stats">${rankRowHtml}</div>
      </div>` : ''}

      <div class="pd-section">
        <h3 class="pd-section-title">対戦履歴</h3>
        <table class="pd-history-table">
          <thead>
            <tr><th>回戦</th><th>対戦相手</th><th>先後</th><th>結果</th></tr>
          </thead>
          <tbody>${historyRowsHtml}</tbody>
        </table>
      </div>`;

    document.getElementById('player-detail-modal').classList.remove('hidden');
  },

  _getPlayerHistory(playerId, rounds) {
    const history = [];
    rounds.forEach(round => {
      if (round.byePlayerId === playerId) {
        history.push({ roundNumber: round.roundNumber, type: 'bye', result: 'bye' });
        return;
      }
      const match = round.matches.find(m => m.player1Id === playerId || m.player2Id === playerId);
      if (!match) return;
      const isP1 = match.player1Id === playerId;
      let result = null;
      if (match.result) {
        if (match.result === 'draw') result = 'draw';
        else result = (match.result === 'player1') === isP1 ? 'win' : 'loss';
      }
      history.push({
        roundNumber:   round.roundNumber,
        type:          'match',
        opponentId:    isP1 ? match.player2Id    : match.player1Id,
        opponentName:  isP1 ? match.player2Name  : match.player1Name,
        opponentGrade: isP1 ? match.player2Grade : match.player1Grade,
        opponentRank:  isP1 ? match.player2Rank  : match.player1Rank,
        side:          isP1 ? 'player1' : 'player2',
        result,
      });
    });
    return history;
  },

  // ============================================
  // 設定
  // ============================================

  bindPasswordChangeEvents() {
    document.getElementById('password-change-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      await this.handlePasswordChange();
    });

    // 入力欄の表示/非表示トグル
    document.querySelectorAll('.toggle-pw').forEach(btn => {
      btn.addEventListener('click', () => {
        const input = document.getElementById(btn.dataset.target);
        const isText = input.type === 'text';
        input.type = isText ? 'password' : 'text';
        btn.textContent = isText ? '👁' : '🙈';
      });
    });
  },

  async handlePasswordChange() {
    const current  = document.getElementById('pw-current').value;
    const next     = document.getElementById('pw-new').value;
    const confirm  = document.getElementById('pw-confirm').value;

    if (!current || !next || !confirm) {
      this.showToast('すべての項目を入力してください', 'error');
      return;
    }
    if (next.length < 6) {
      this.showToast('新しいパスワードは6文字以上にしてください', 'error');
      return;
    }
    if (next !== confirm) {
      this.showToast('新しいパスワードが一致しません', 'error');
      return;
    }

    const btn = document.getElementById('pw-submit-btn');
    btn.disabled = true;
    btn.textContent = '変更中...';

    try {
      await AppStorage.updatePassword(current, next);
      this.showToast('パスワードを変更しました', 'success');
      document.getElementById('password-change-form').reset();
    } catch (err) {
      this.showToast('変更に失敗しました: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'パスワードを変更';
    }
  },

  bindSettingsEvents() {
    document.getElementById('export-standings-btn').addEventListener('click', () => {
      const players = AppStorage.getPlayers();
      const rounds = AppStorage.getRounds();
      const settings = AppStorage.getSettings();
      if (rounds.length === 0) {
        this.showToast('エクスポートするデータがありません', 'error');
        return;
      }
      const standings = Matching.calculateStandings(players, rounds, true);
      PDF.exportStandings(standings, { showPoints: this.standingsOpts.showPoints });
    });

    document.getElementById('reset-all-btn').addEventListener('click', () => {
      if (confirm('すべてのデータをリセットしますか？この操作は元に戻せません。')) {
        AppStorage.resetAll();
        this.renderPlayers();
        this.renderMatchingResult();
        this.renderRounds();
        this.renderStandings();
        this.showToast('全データをリセットしました', 'info');
      }
    });
  },

  loadSettings() {
    const settings = AppStorage.getSettings();
    document.getElementById('num-rounds').value       = settings.numRounds || 5;
    document.getElementById('matching-format').value  = settings.matchingFormat || 'random';

    const gradeLevel      = settings.gradeAvoidLevel  ?? 2;
    const rankLevel       = settings.rankBalanceLevel ?? 2;
    const assignSenteGote = settings.assignSenteGote  ?? true;
    this._setSegmentValue('sente-gote',   assignSenteGote ? 1 : 0);
    this._setSegmentValue('grade-avoid',  gradeLevel);
    this._setSegmentValue('rank-balance', rankLevel);
    this.updateGenerateButton();
  },

  _setSegmentValue(id, value) {
    document.getElementById(`${id}-weight`).value = value;
    document.querySelectorAll(`#${id}-segment .wseg-btn`).forEach(btn => {
      btn.classList.toggle('wseg-active', parseInt(btn.dataset.value) === parseInt(value));
    });
  },

  // ============================================
  // 表示オプション（学年・ランク）
  // ============================================

  bindDisplayOpts() {
    document.querySelectorAll('.display-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const key = chip.dataset.key;
        const optKey = key === 'grade' ? 'showGrade' : 'showRank';
        this.displayOpts[optKey] = !this.displayOpts[optKey];

        // 同じ key のチップを全タブで同期
        document.querySelectorAll(`.display-chip[data-key="${key}"]`).forEach(c => {
          c.classList.toggle('active', this.displayOpts[optKey]);
        });

        this.renderMatchingResult();
        this.renderRounds();
      });
    });
  },

  // ============================================
  // ユーティリティ
  // ============================================

  showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    const icons = {
      success: '✓',
      error: '✕',
      info: 'ℹ'
    };

    // XSS対策：textContent で挿入（選手名などユーザー入力がメッセージに混入するため）
    const iconEl = document.createElement('span');
    iconEl.className = 'toast-icon';
    iconEl.textContent = icons[type] || 'ℹ';
    const msgEl = document.createElement('span');
    msgEl.className = 'toast-message';
    msgEl.textContent = message;
    toast.appendChild(iconEl);
    toast.appendChild(msgEl);

    container.appendChild(toast);

    // アニメーション
    requestAnimationFrame(() => {
      toast.classList.add('show');
    });

    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  },

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
};
