/**
 * ui.js — UI描画・イベント管理モジュール
 */

const UI = {
  currentTab: 'players',
  editingPlayerId: null,

  /**
   * 初期化
   */
  init() {
    this.bindTabEvents();
    this.bindPlayerFormEvents();
    this.bindMatchingEvents();
    this.bindSettingsEvents();
    this.renderPlayers();
    this.loadSettings();
    this.renderRounds();
    this.renderStandings();
    this.showTab('players');
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
      Storage.updatePlayer(this.editingPlayerId, { name, grade, rank });
      this.showToast(`${name} を更新しました`, 'success');
    } else {
      Storage.addPlayer({ name, grade, rank });
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
    const players = Storage.getPlayers();
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
    const players = Storage.getPlayers();
    const player = players.find(p => p.id === id);
    if (!player) return;

    if (confirm(`${player.name} を削除しますか？`)) {
      Storage.deletePlayer(id);
      this.showToast(`${player.name} を削除しました`, 'info');
      this.renderPlayers();
    }
  },

  renderPlayers() {
    const players = Storage.getPlayers();
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
      this.generateMatching();
    });

    document.getElementById('clear-rounds-btn').addEventListener('click', () => {
      if (confirm('生成された対戦表をすべてクリアしますか？結果も失われます。')) {
        Storage.saveRounds([]);
        this.renderMatchingResult();
        this.showToast('対戦表をクリアしました', 'info');
      }
    });

    document.getElementById('export-matches-btn').addEventListener('click', () => {
      const rounds = Storage.getRounds();
      const players = Storage.getPlayers();
      if (rounds.length === 0) {
        this.showToast('エクスポートする対戦表がありません', 'error');
        return;
      }
      PDF.exportMatchTable(rounds, players);
    });
  },

  generateMatching() {
    const players = Storage.getPlayers();
    const numRounds = parseInt(document.getElementById('num-rounds').value);

    if (players.length < 2) {
      this.showToast('最低2人の選手が必要です', 'error');
      return;
    }

    // 生成中表示
    const btn = document.getElementById('generate-btn');
    const originalText = btn.textContent;
    btn.textContent = '生成中...';
    btn.disabled = true;

    // 非同期で実行（UIブロック回避）
    setTimeout(() => {
      const result = Matching.generateAllRounds(players, numRounds);

      btn.textContent = originalText;
      btn.disabled = false;

      if (result.error) {
        this.showToast(result.error, 'error');
        return;
      }

      Storage.saveRounds(result.rounds);
      Storage.updateSettings({ numRounds });
      this.renderMatchingResult();
      this.showToast(`全${numRounds}回戦の対戦表を生成しました！`, 'success');
    }, 100);
  },

  renderMatchingResult() {
    const rounds = Storage.getRounds();
    const players = Storage.getPlayers();
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
    rounds.forEach(round => {
      html += `
        <div class="round-card">
          <h3 class="round-title">
            <span class="round-number">第${round.roundNumber}回戦</span>
            <span class="match-count">${round.matches.length}対局</span>
          </h3>
          <div class="match-list">
            ${round.matches.map((match, i) => {
              const resultClass = match.result ? 'has-result' : '';
              return `
                <div class="match-card ${resultClass}">
                  <div class="match-number">${i + 1}</div>
                  <div class="match-player player1 ${match.result === 'player1' ? 'winner' : match.result === 'player2' ? 'loser' : ''}">
                    <span class="player-info">
                      <span class="player-name-text">${this.escapeHtml(match.player1Name)}</span>
                      <span class="player-grade-text">${match.player1Grade}年</span>
                    </span>
                  </div>
                  <div class="match-vs">VS</div>
                  <div class="match-player player2 ${match.result === 'player2' ? 'winner' : match.result === 'player1' ? 'loser' : ''}">
                    <span class="player-info">
                      <span class="player-name-text">${this.escapeHtml(match.player2Name)}</span>
                      <span class="player-grade-text">${match.player2Grade}年</span>
                    </span>
                  </div>
                </div>`;
            }).join('')}
          </div>
          ${round.byePlayerId && playerMap[round.byePlayerId] ? `
            <div class="bye-info">
              <span class="bye-label">不戦:</span>
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
    const rounds = Storage.getRounds();
    const players = Storage.getPlayers();
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

      html += `
        <div class="round-card">
          <h3 class="round-title">
            <span class="round-number">第${round.roundNumber}回戦</span>
            <span class="progress-text">${completedCount}/${totalCount} 完了</span>
          </h3>
          <div class="progress-bar">
            <div class="progress-fill" style="width: ${progressPct}%"></div>
          </div>
          <div class="result-list">
            ${round.matches.map((match, mi) => `
              <div class="result-row ${match.result ? 'completed' : ''}">
                <div class="result-player p1 ${match.result === 'player1' ? 'winner' : ''}">
                  <span>${this.escapeHtml(match.player1Name)}</span>
                </div>
                <div class="result-buttons">
                  <button class="result-btn win-btn ${match.result === 'player1' ? 'active' : ''}"
                    onclick="UI.setResult(${ri}, ${mi}, 'player1')" title="${match.player1Name} の勝ち">○</button>
                  <button class="result-btn draw-btn ${match.result === 'draw' ? 'active' : ''}"
                    onclick="UI.setResult(${ri}, ${mi}, 'draw')" title="引き分け">△</button>
                  <button class="result-btn win-btn ${match.result === 'player2' ? 'active' : ''}"
                    onclick="UI.setResult(${ri}, ${mi}, 'player2')" title="${match.player2Name} の勝ち">○</button>
                  ${match.result ? `
                    <button class="result-btn reset-btn"
                      onclick="UI.setResult(${ri}, ${mi}, null)" title="リセット">✕</button>
                  ` : ''}
                </div>
                <div class="result-player p2 ${match.result === 'player2' ? 'winner' : ''}">
                  <span>${this.escapeHtml(match.player2Name)}</span>
                </div>
              </div>
            `).join('')}
          </div>
          ${round.byePlayerId && playerMap[round.byePlayerId] ? `
            <div class="bye-info">
              <span class="bye-label">不戦:</span>
              <span>${this.escapeHtml(playerMap[round.byePlayerId].name)}</span>
            </div>` : ''}
        </div>`;
    });

    container.innerHTML = html;
  },

  setResult(roundIndex, matchIndex, result) {
    Storage.updateMatchResult(roundIndex, matchIndex, result);
    this.renderRounds();
  },

  // ============================================
  // 成績表
  // ============================================

  renderStandings() {
    const players = Storage.getPlayers();
    const rounds = Storage.getRounds();
    const container = document.getElementById('standings-container');
    const settings = Storage.getSettings();

    if (rounds.length === 0 || players.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🏆</div>
          <p>まだ成績データがありません</p>
          <p class="empty-hint">対戦結果を入力すると成績が表示されます</p>
        </div>`;
      return;
    }

    const standings = Matching.calculateStandings(players, rounds, settings.byeCountsAsWin);

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
              <th>不戦</th>
              <th>勝率</th>
              <th>Pt</th>
            </tr>
          </thead>
          <tbody>
            ${standings.map((s, i) => `
              <tr class="${i < 3 ? 'top-' + (i+1) : ''}">
                <td class="position-cell">
                  ${s.position <= 3 ? `<span class="medal medal-${s.position}">${['🥇','🥈','🥉'][s.position-1]}</span>` : s.position}
                </td>
                <td class="name-cell">${this.escapeHtml(s.name)}</td>
                <td>${s.grade}年</td>
                <td class="win-cell">${s.wins}</td>
                <td class="loss-cell">${s.losses}</td>
                <td>${s.draws}</td>
                <td>${s.byes}</td>
                <td>${s.winRate.toFixed(1)}%</td>
                <td class="points-cell">${s.points}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>`;

    container.innerHTML = html;
  },

  // ============================================
  // 設定
  // ============================================

  bindSettingsEvents() {
    document.getElementById('export-standings-btn').addEventListener('click', () => {
      const players = Storage.getPlayers();
      const rounds = Storage.getRounds();
      const settings = Storage.getSettings();
      if (rounds.length === 0) {
        this.showToast('エクスポートするデータがありません', 'error');
        return;
      }
      const standings = Matching.calculateStandings(players, rounds, settings.byeCountsAsWin);
      PDF.exportStandings(standings);
    });

    document.getElementById('reset-all-btn').addEventListener('click', () => {
      if (confirm('すべてのデータをリセットしますか？この操作は元に戻せません。')) {
        Storage.resetAll();
        this.renderPlayers();
        this.renderMatchingResult();
        this.renderRounds();
        this.renderStandings();
        this.showToast('全データをリセットしました', 'info');
      }
    });
  },

  loadSettings() {
    const settings = Storage.getSettings();
    document.getElementById('num-rounds').value = settings.numRounds || 5;
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

    toast.innerHTML = `
      <span class="toast-icon">${icons[type] || 'ℹ'}</span>
      <span class="toast-message">${message}</span>
    `;

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
