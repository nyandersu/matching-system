/**
 * league.js — リーグ戦モード
 *
 * 階級（A級・B級…）を作り、同一階級内で総当たりを行い、
 * 期（シーズン）ごとに昇級・降級を処理する運用モード。
 *
 * データ構造（AppStorage.getLeague()）:
 *   league {
 *     enabled, currentTerm,
 *     classes: [{id, name}]                          配列順が序列。先頭が最上位
 *     members: [{playerId, classId, status, joinedTerm}]  status: 'active'|'absent'
 *     terms:   [{term, matches:{[classId]:[...]}, finalized, changes:[...]}]
 *   }
 */

const League = {
  /** 現在のサブビュー: 'manage' | 'matches' | 'standings' */
  subView: 'manage',

  /** 階級IDを生成 */
  _genClassId() {
    return 'cls_' + Math.random().toString(36).slice(2, 9);
  },

  /** 汎用IDを生成（対局など） */
  _genId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'id_' + Math.random().toString(36).slice(2, 11);
  },

  /** 現在の期オブジェクトを取得（無ければ作成） */
  _getCurrentTerm(league) {
    if (!league.terms) league.terms = [];
    let t = league.terms.find(tt => tt.term === league.currentTerm);
    if (!t) {
      t = { term: league.currentTerm, matches: {}, finalized: false, changes: [] };
      league.terms.push(t);
    }
    if (!t.matches) t.matches = {};
    return t;
  },

  /** 選手ID→選手オブジェクトのマップ */
  _playerMap() {
    const map = {};
    AppStorage.getPlayers().forEach(p => { map[p.id] = p; });
    return map;
  },

  /** HTMLエスケープ */
  _esc(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },

  // ============================================
  // 描画
  // ============================================

  render() {
    const container = document.getElementById('league-content');
    if (!container) return;
    const league = AppStorage.getLeague();

    if (!league.enabled) {
      container.innerHTML = this._renderIntro();
      return;
    }

    let body;
    if (this.subView === 'matches') {
      body = this._renderMatchesView(league);
    } else if (this.subView === 'standings') {
      body = this._renderStandingsView(league);
    } else {
      body = this._renderClassSection(league) + this._renderMemberSection(league);
    }

    container.innerHTML =
      this._renderHeader(league) +
      this._renderSubNav() +
      body;
  },

  /** サブビュー切り替えナビ */
  _renderSubNav() {
    const tabs = [
      { id: 'manage',    label: '階級・選手' },
      { id: 'matches',   label: '対局・結果' },
      { id: 'standings', label: '順位表' },
    ];
    return `
      <div class="league-subnav">
        ${tabs.map(t => `
          <button class="league-subnav-btn ${this.subView === t.id ? 'active' : ''}"
                  onclick="League.switchView('${t.id}')">${t.label}</button>
        `).join('')}
      </div>`;
  },

  switchView(view) {
    this.subView = view;
    this.render();
  },

  /** 未開始時の案内 */
  _renderIntro() {
    return `
      <div class="league-intro">
        <div class="empty-icon">🏛</div>
        <h2 class="league-intro-title">リーグ戦モード</h2>
        <p class="league-intro-desc">
          A級・B級などの階級を作成し、同一階級内で総当たり戦を行います。<br>
          期（シーズン）ごとに成績上位者が昇級・下位者が降級します。
        </p>
        <button class="btn btn-primary" onclick="League.enable()">
          この部屋でリーグ戦を開始する
        </button>
      </div>`;
  },

  /** ヘッダー（期表示・モード解除） */
  _renderHeader(league) {
    return `
      <div class="league-header">
        <div class="league-term-badge">第 ${league.currentTerm} 期</div>
        <button class="btn btn-ghost btn-sm" onclick="League.disable()">
          リーグ戦モードを終了
        </button>
      </div>`;
  },

  /** 階級管理セクション */
  _renderClassSection(league) {
    const classes = league.classes || [];
    let rows = '';
    classes.forEach((cls, i) => {
      const memberCount = (league.members || []).filter(m => m.classId === cls.id).length;
      rows += `
        <div class="league-class-row">
          <span class="league-class-order">${i + 1}</span>
          <input type="text" class="league-class-name-input"
                 value="${this._esc(cls.name)}" maxlength="16"
                 onchange="League.renameClass('${cls.id}', this.value)">
          <span class="league-class-count">${memberCount}名</span>
          <div class="league-class-actions">
            <button class="league-icon-btn" title="上へ" ${i === 0 ? 'disabled' : ''}
                    onclick="League.moveClass('${cls.id}', -1)">▲</button>
            <button class="league-icon-btn" title="下へ" ${i === classes.length - 1 ? 'disabled' : ''}
                    onclick="League.moveClass('${cls.id}', 1)">▼</button>
            <button class="league-icon-btn league-icon-danger" title="削除"
                    onclick="League.deleteClass('${cls.id}')">✕</button>
          </div>
        </div>`;
    });

    if (classes.length === 0) {
      rows = `<p class="league-empty-hint">階級がまだありません。「階級を追加」で A級・B級 などを作成してください。</p>`;
    }

    return `
      <div class="card">
        <h2 class="card-title"><span class="icon">🏅</span> 階級</h2>
        <p class="league-section-note">上にあるほど上位の階級です（▲▼で並び替え）。</p>
        <div class="league-class-list">${rows}</div>
        <button class="btn btn-secondary league-add-class-btn" onclick="League.addClass()">
          ＋ 階級を追加
        </button>
      </div>`;
  },

  /** 選手の階級割当セクション */
  _renderMemberSection(league) {
    const players = AppStorage.getPlayers();
    const classes = league.classes || [];
    const members = league.members || [];
    const memberMap = {};
    members.forEach(m => { memberMap[m.playerId] = m; });

    if (players.length === 0) {
      return `
        <div class="card">
          <h2 class="card-title"><span class="icon">👥</span> 選手の階級割当</h2>
          <p class="league-empty-hint">「選手管理」タブで選手を登録してください。</p>
        </div>`;
    }

    // 階級セレクトの option 群
    const classOptions = (selectedId) => {
      let opts = `<option value="">未所属</option>`;
      classes.forEach(c => {
        opts += `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>${this._esc(c.name)}</option>`;
      });
      return opts;
    };

    let rows = '';
    players.forEach(p => {
      const m = memberMap[p.id];
      const classId = m ? m.classId : '';
      const isAbsent = m && m.status === 'absent';
      rows += `
        <div class="league-member-row ${isAbsent ? 'league-member-absent' : ''}">
          <span class="league-member-name">${this._esc(p.name)}</span>
          <span class="league-member-meta">${this._esc(p.grade)}年</span>
          <select class="league-member-class-select"
                  onchange="League.assignMember('${p.id}', this.value)">
            ${classOptions(classId)}
          </select>
          <button class="league-icon-btn ${isAbsent ? 'league-icon-active' : ''}"
                  title="${isAbsent ? '休場を解除' : '休場にする'}"
                  ${classId ? '' : 'disabled'}
                  onclick="League.toggleAbsent('${p.id}')">休</button>
        </div>`;
    });

    return `
      <div class="card">
        <h2 class="card-title"><span class="icon">👥</span> 選手の階級割当</h2>
        <p class="league-section-note">各選手の所属階級を選択します。「休」ボタンでその期の休場を設定できます（階級は維持されます）。</p>
        <div class="league-member-list">${rows}</div>
      </div>`;
  },

  // ============================================
  // 操作
  // ============================================

  enable() {
    const league = AppStorage.getLeague();
    league.enabled = true;
    if (!league.currentTerm) league.currentTerm = 1;
    AppStorage.saveLeague(league);
    UI.applyLeagueMode();
    this.render();
    UI.showToast('リーグ戦モードを開始しました', 'success');
  },

  disable() {
    if (!confirm('リーグ戦モードを終了しますか？\n（階級・選手割当などのリーグデータは保持されます）')) return;
    const league = AppStorage.getLeague();
    league.enabled = false;
    AppStorage.saveLeague(league);
    UI.applyLeagueMode();
    UI.showTab('players');
    UI.showToast('リーグ戦モードを終了しました', 'info');
  },

  addClass() {
    const league = AppStorage.getLeague();
    if (!league.classes) league.classes = [];
    // デフォルト名：A級, B級, C級 …（既存数に応じて）
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const idx = league.classes.length;
    const defaultName = idx < letters.length ? `${letters[idx]}級` : `第${idx + 1}階級`;
    league.classes.push({ id: this._genClassId(), name: defaultName });
    AppStorage.saveLeague(league);
    this.render();
  },

  renameClass(classId, name) {
    const league = AppStorage.getLeague();
    const cls = (league.classes || []).find(c => c.id === classId);
    if (!cls) return;
    const trimmed = (name || '').trim();
    cls.name = trimmed || cls.name;
    AppStorage.saveLeague(league);
    this.render();
  },

  moveClass(classId, dir) {
    const league = AppStorage.getLeague();
    const classes = league.classes || [];
    const i = classes.findIndex(c => c.id === classId);
    if (i === -1) return;
    const j = i + dir;
    if (j < 0 || j >= classes.length) return;
    [classes[i], classes[j]] = [classes[j], classes[i]];
    AppStorage.saveLeague(league);
    this.render();
  },

  deleteClass(classId) {
    const league = AppStorage.getLeague();
    const cls = (league.classes || []).find(c => c.id === classId);
    if (!cls) return;
    const memberCount = (league.members || []).filter(m => m.classId === classId).length;
    const msg = memberCount > 0
      ? `「${cls.name}」を削除しますか？\nこの階級に所属する${memberCount}名は「未所属」になります。`
      : `「${cls.name}」を削除しますか？`;
    if (!confirm(msg)) return;
    league.classes = (league.classes || []).filter(c => c.id !== classId);
    // 所属メンバーを未所属化
    league.members = (league.members || []).filter(m => m.classId !== classId);
    AppStorage.saveLeague(league);
    this.render();
  },

  assignMember(playerId, classId) {
    const league = AppStorage.getLeague();
    if (!league.members) league.members = [];
    const existing = league.members.find(m => m.playerId === playerId);

    if (!classId) {
      // 未所属に戻す
      league.members = league.members.filter(m => m.playerId !== playerId);
    } else if (existing) {
      existing.classId = classId;
    } else {
      league.members.push({
        playerId,
        classId,
        status: 'active',
        joinedTerm: league.currentTerm || 1,
      });
    }
    AppStorage.saveLeague(league);
    this.render();
  },

  toggleAbsent(playerId) {
    const league = AppStorage.getLeague();
    const m = (league.members || []).find(mm => mm.playerId === playerId);
    if (!m) return;
    m.status = m.status === 'absent' ? 'active' : 'absent';
    AppStorage.saveLeague(league);
    this.render();
  },

  // ============================================
  // 対局・結果（Phase3）
  // ============================================

  /** 階級の出場メンバー（休場を除く active のみ）の選手ID配列 */
  _activeMemberIds(league, classId) {
    return (league.members || [])
      .filter(m => m.classId === classId && m.status === 'active')
      .map(m => m.playerId);
  },

  /** 対局・結果ビュー */
  _renderMatchesView(league) {
    const term = this._getCurrentTerm(league);
    const classes = league.classes || [];
    const pmap = this._playerMap();

    if (classes.length === 0) {
      return `<div class="card"><p class="league-empty-hint">先に「階級・選手」タブで階級を作成してください。</p></div>`;
    }

    // 総当たり対局が1つでも存在するか
    const hasAnyMatches = classes.some(c => (term.matches[c.id] || []).length > 0);

    let html = `
      <div class="card">
        <h2 class="card-title"><span class="icon">⚔</span> 第${league.currentTerm}期 対局</h2>
        <p class="league-section-note">各階級内で総当たり（全員と1局ずつ）を行います。休場者は除外されます。</p>
        <button class="btn btn-primary" onclick="League.generateRoundRobin()">
          ${hasAnyMatches ? '総当たり表を再生成' : '総当たり表を生成'}
        </button>
      </div>`;

    classes.forEach(cls => {
      const matches = term.matches[cls.id] || [];
      const activeCount = this._activeMemberIds(league, cls.id).length;
      let inner;
      if (matches.length === 0) {
        inner = `<p class="league-empty-hint">${
          activeCount < 2
            ? '出場選手が2名未満のため対局はありません。'
            : '「総当たり表を生成」を押すと対局が作成されます。'
        }</p>`;
      } else {
        const done = matches.filter(m => m.result).length;
        inner = `
          <p class="league-class-progress">${done} / ${matches.length} 局 完了</p>
          <div class="league-match-list">
            ${matches.map((m, i) => this._renderMatchRow(cls.id, m, i, pmap)).join('')}
          </div>`;
      }
      html += `
        <div class="card">
          <h3 class="league-class-heading">${this._esc(cls.name)}</h3>
          ${inner}
        </div>`;
    });

    return html;
  },

  /** 対局1行 */
  _renderMatchRow(classId, m, idx, pmap) {
    const p1 = pmap[m.p1Id];
    const p2 = pmap[m.p2Id];
    const n1 = p1 ? this._esc(p1.name) : '(不明)';
    const n2 = p2 ? this._esc(p2.name) : '(不明)';
    const r = m.result;
    return `
      <div class="league-match-row ${r ? 'done' : ''}">
        <span class="league-match-no">${idx + 1}</span>
        <span class="league-match-player ${r === 'p1' ? 'winner' : r === 'p2' ? 'loser' : ''}">${n1}</span>
        <div class="league-match-btns">
          <button class="league-res-btn ${r === 'p1' ? 'active' : ''}"
                  title="${n1} の勝ち"
                  onclick="League.setMatchResult('${classId}','${m.id}','p1')">○</button>
          <button class="league-res-btn draw ${r === 'draw' ? 'active' : ''}"
                  title="引き分け"
                  onclick="League.setMatchResult('${classId}','${m.id}','draw')">△</button>
          <button class="league-res-btn ${r === 'p2' ? 'active' : ''}"
                  title="${n2} の勝ち"
                  onclick="League.setMatchResult('${classId}','${m.id}','p2')">○</button>
          ${r ? `<button class="league-res-btn reset"
                  title="リセット"
                  onclick="League.setMatchResult('${classId}','${m.id}',null)">✕</button>` : ''}
        </div>
        <span class="league-match-player ${r === 'p2' ? 'winner' : r === 'p1' ? 'loser' : ''}">${n2}</span>
      </div>`;
  },

  /** 総当たり表を生成 */
  generateRoundRobin() {
    const league = AppStorage.getLeague();
    const term = this._getCurrentTerm(league);

    // 既存の結果があれば警告
    const hasResults = Object.values(term.matches || {})
      .some(arr => (arr || []).some(m => m.result));
    if (hasResults) {
      if (!confirm('総当たり表を再生成しますか？\n入力済みの対局結果はすべて消去されます。')) return;
    }

    (league.classes || []).forEach(cls => {
      const ids = this._activeMemberIds(league, cls.id);
      const matches = [];
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          matches.push({ id: this._genId(), p1Id: ids[i], p2Id: ids[j], result: null });
        }
      }
      term.matches[cls.id] = matches;
    });

    AppStorage.saveLeague(league);
    this.render();
    UI.showToast('総当たり表を生成しました', 'success');
  },

  /** 対局結果を設定 */
  setMatchResult(classId, matchId, result) {
    const league = AppStorage.getLeague();
    const term = this._getCurrentTerm(league);
    const m = (term.matches[classId] || []).find(mm => mm.id === matchId);
    if (!m) return;
    m.result = result;  // 'p1' | 'p2' | 'draw' | null
    AppStorage.saveLeague(league);
    this.render();
  },

  // ============================================
  // 順位表（Phase3）
  // ============================================

  /** 階級内の成績を集計（勝2pt・分1pt） */
  _classStandings(league, term, classId) {
    const ids = this._activeMemberIds(league, classId);
    const stats = {};
    ids.forEach(id => { stats[id] = { id, w: 0, l: 0, d: 0, pts: 0, games: 0 }; });

    (term.matches[classId] || []).forEach(m => {
      if (!stats[m.p1Id] || !stats[m.p2Id]) return;
      if (m.result === 'p1') {
        stats[m.p1Id].w++; stats[m.p2Id].l++;
      } else if (m.result === 'p2') {
        stats[m.p2Id].w++; stats[m.p1Id].l++;
      } else if (m.result === 'draw') {
        stats[m.p1Id].d++; stats[m.p2Id].d++;
      }
    });

    Object.values(stats).forEach(s => {
      s.pts   = s.w * 2 + s.d;
      s.games = s.w + s.l + s.d;
    });

    // Pt降順 → 勝数降順 → 敗数昇順
    return Object.values(stats).sort((a, b) =>
      b.pts - a.pts || b.w - a.w || a.l - b.l
    );
  },

  /** 順位表ビュー */
  _renderStandingsView(league) {
    const term = this._getCurrentTerm(league);
    const classes = league.classes || [];
    const pmap = this._playerMap();

    if (classes.length === 0) {
      return `<div class="card"><p class="league-empty-hint">先に「階級・選手」タブで階級を作成してください。</p></div>`;
    }

    let html = `
      <div class="card">
        <h2 class="card-title"><span class="icon">🏆</span> 第${league.currentTerm}期 順位表</h2>
        <p class="league-section-note">勝利2pt・引き分け1pt で集計。</p>
      </div>`;

    classes.forEach(cls => {
      const standings = this._classStandings(league, term, cls.id);
      let inner;
      if (standings.length === 0) {
        inner = `<p class="league-empty-hint">出場選手がいません。</p>`;
      } else {
        inner = `
          <table class="league-standings-table">
            <thead>
              <tr><th>順位</th><th>選手</th><th>勝</th><th>敗</th><th>分</th><th>Pt</th></tr>
            </thead>
            <tbody>
              ${standings.map((s, i) => {
                const p = pmap[s.id];
                return `
                  <tr>
                    <td class="ls-pos">${i + 1}</td>
                    <td class="ls-name">${p ? this._esc(p.name) : '(不明)'}</td>
                    <td>${s.w}</td>
                    <td>${s.l}</td>
                    <td>${s.d}</td>
                    <td class="ls-pts">${s.pts}</td>
                  </tr>`;
              }).join('')}
            </tbody>
          </table>`;
      }
      html += `
        <div class="card">
          <h3 class="league-class-heading">${this._esc(cls.name)}</h3>
          ${inner}
        </div>`;
    });

    return html;
  },
};
