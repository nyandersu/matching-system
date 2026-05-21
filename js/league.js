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

  /** 昇降級の入替人数ドラフト（境界index → 人数）。提案値からの編集を保持 */
  _swapCounts: {},

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
        <p class="league-section-note">階級名はタップで編集できます。上にあるほど上位の階級です（▲▼で並び替え）。</p>
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
          ${this._renderCrossTable(league, term, cls, pmap)}
          <p class="league-cross-hint">セルをタップで結果を入力（空欄→○→△→●→空欄）。右端の「休」で休場。</p>`;
      }
      html += `
        <div class="card">
          <h3 class="league-class-heading">${this._esc(cls.name)}</h3>
          ${inner}
          ${this._renderParticipantStrip(league, cls)}
        </div>`;
    });

    return html;
  },

  /**
   * 階級内の星取り表（ラウンドロビン表）を描画。
   * 行＝各選手、列＝対戦相手。セル(行i,列j)は選手iの選手jに対する結果。
   * 右端に 勝/敗/分 の集計列を付ける。
   */
  _renderCrossTable(league, term, cls, pmap) {
    const ids = this._activeMemberIds(league, cls.id);
    const matches = term.matches[cls.id] || [];

    // 2選手間の対局を引く
    const matchOf = (a, b) => matches.find(m =>
      (m.p1Id === a && m.p2Id === b) || (m.p1Id === b && m.p2Id === a));

    // 行選手から見たセル結果: 'win'|'loss'|'draw'|null
    const cellOf = (rowId, colId) => {
      const m = matchOf(rowId, colId);
      if (!m || !m.result) return { m, res: null };
      if (m.result === 'draw') return { m, res: 'draw' };
      const winnerId = m.result === 'p1' ? m.p1Id : m.p2Id;
      return { m, res: winnerId === rowId ? 'win' : 'loss' };
    };

    const SYM = { win: '○', loss: '●', draw: '△' };

    // ヘッダー（列番号）
    let head = '<th class="lx-corner"></th>';
    ids.forEach((_, j) => { head += `<th class="lx-colhead">${j + 1}</th>`; });
    head += '<th class="lx-sum">勝</th><th class="lx-sum">敗</th><th class="lx-sum">分</th>';
    head += '<th class="lx-op"></th>';

    // 各行
    let body = '';
    ids.forEach((rowId, i) => {
      const p = pmap[rowId];
      const rowName = p ? this._esc(p.name) : '(不明)';
      let w = 0, l = 0, d = 0;
      let cells = '';
      ids.forEach((colId, j) => {
        if (i === j) {
          cells += '<td class="lx-diag"></td>';
          return;
        }
        const { m, res } = cellOf(rowId, colId);
        if (res === 'win') w++;
        else if (res === 'loss') l++;
        else if (res === 'draw') d++;
        const cls2 = res ? `lx-${res}` : 'lx-empty';
        cells += `<td class="lx-cell ${cls2}"
          onclick="League.cycleCell('${cls.id}','${m.id}','${rowId}')">${res ? SYM[res] : ''}</td>`;
      });
      body += `
        <tr>
          <th class="lx-rowhead"><span class="lx-rownum">${i + 1}</span>${rowName}</th>
          ${cells}
          <td class="lx-sum lx-sum-w">${w}</td>
          <td class="lx-sum lx-sum-l">${l}</td>
          <td class="lx-sum lx-sum-d">${d}</td>
          <td class="lx-op">
            <button class="lx-op-btn" title="${rowName} を休場にする"
                    onclick="League.benchPlayer('${rowId}')">休</button>
          </td>
        </tr>`;
    });

    return `
      <div class="league-cross-wrap">
        <table class="league-cross-table">
          <thead><tr>${head}</tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;
  },

  /**
   * 星取り表のセルをタップして結果を循環させる。
   * 行選手視点で 空欄→勝→分→負→空欄。
   */
  cycleCell(classId, matchId, rowId) {
    const league = AppStorage.getLeague();
    const term = this._getCurrentTerm(league);
    const m = (term.matches[classId] || []).find(mm => mm.id === matchId);
    if (!m) return;

    // 現在の行選手視点の状態
    let cur;
    if (!m.result) cur = null;
    else if (m.result === 'draw') cur = 'draw';
    else {
      const winnerId = m.result === 'p1' ? m.p1Id : m.p2Id;
      cur = winnerId === rowId ? 'win' : 'loss';
    }
    const order = [null, 'win', 'draw', 'loss'];
    const next = order[(order.indexOf(cur) + 1) % order.length];

    let res;
    if (next === null) {
      res = null;
    } else if (next === 'draw') {
      res = 'draw';
    } else {
      const rowIsP1 = m.p1Id === rowId;
      const rowWins = next === 'win';
      res = (rowWins === rowIsP1) ? 'p1' : 'p2';
    }
    m.result = res;
    AppStorage.saveLeague(league);
    this.render();
  },

  // ============================================
  // 参加者の管理（クロス表上で新規参入・休場・復帰）
  // ============================================

  /**
   * 階級の対局を出場メンバーに合わせて差分同期する。
   * - 両者が出場中のペアは既存対局（結果含む）を維持
   * - 出場中でないメンバーが絡む対局は削除
   * - 不足しているペアの対局を追加
   * すでに対局表が生成済み（matches が非空）のときのみ機能する。
   */
  _syncClassMatches(league, classId) {
    const term = this._getCurrentTerm(league);
    const existing = term.matches[classId] || [];
    if (existing.length === 0) return;  // 未生成なら何もしない

    const activeIds  = this._activeMemberIds(league, classId);
    const activeSet  = new Set(activeIds);
    const pairKey    = (a, b) => [a, b].slice().sort().join('|');

    // 両者出場中の対局のみ残す（結果保持）
    const kept = existing.filter(m => activeSet.has(m.p1Id) && activeSet.has(m.p2Id));
    const have = new Set(kept.map(m => pairKey(m.p1Id, m.p2Id)));

    // 不足ペアを追加
    for (let i = 0; i < activeIds.length; i++) {
      for (let j = i + 1; j < activeIds.length; j++) {
        const k = pairKey(activeIds[i], activeIds[j]);
        if (!have.has(k)) {
          kept.push({ id: this._genId(), p1Id: activeIds[i], p2Id: activeIds[j], result: null });
        }
      }
    }
    term.matches[classId] = kept;
  },

  /** 選手を休場にする（クロス表の行ボタンから） */
  benchPlayer(playerId) {
    const league = AppStorage.getLeague();
    const m = (league.members || []).find(mm => mm.playerId === playerId);
    if (!m) return;

    const term = this._getCurrentTerm(league);
    const pmap = this._playerMap();
    const name = pmap[playerId] ? pmap[playerId].name : '';

    // 結果入力済みの対局があるか
    const theirMatches = (term.matches[m.classId] || [])
      .filter(mm => mm.p1Id === playerId || mm.p2Id === playerId);
    if (theirMatches.some(mm => mm.result)) {
      if (!confirm(`${name} を休場にしますか？\nこの選手の対局結果は削除されます（復帰時に再作成されます）。`)) return;
    }

    m.status = 'absent';
    this._syncClassMatches(league, m.classId);
    AppStorage.saveLeague(league);
    this.render();
    UI.showToast(`${name} を休場にしました`, 'info');
  },

  /** 休場中の選手を復帰させる */
  reinstatePlayer(playerId) {
    const league = AppStorage.getLeague();
    const m = (league.members || []).find(mm => mm.playerId === playerId);
    if (!m) return;
    m.status = 'active';
    this._syncClassMatches(league, m.classId);
    AppStorage.saveLeague(league);
    this.render();
    const pmap = this._playerMap();
    UI.showToast(`${pmap[playerId] ? pmap[playerId].name : ''} が復帰しました`, 'success');
  },

  /** 新規参入：未所属の選手をこの階級に追加 */
  addEntrant(classId, playerId) {
    if (!playerId) return;
    const league = AppStorage.getLeague();
    if (!league.members) league.members = [];
    if (league.members.find(m => m.playerId === playerId)) return;  // 既にどこかに所属

    league.members.push({
      playerId,
      classId,
      status: 'active',
      joinedTerm: league.currentTerm || 1,
    });
    this._syncClassMatches(league, classId);
    AppStorage.saveLeague(league);
    this.render();
    const pmap = this._playerMap();
    UI.showToast(`${pmap[playerId] ? pmap[playerId].name : ''} が新規参入しました`, 'success');
  },

  /** 参加者管理ストリップ（休場中の復帰・新規参入） */
  _renderParticipantStrip(league, cls) {
    const pmap = this._playerMap();

    // 休場中メンバー
    const absent = (league.members || [])
      .filter(m => m.classId === cls.id && m.status === 'absent');
    // 新規参入候補：どの階級にも未所属の登録選手
    const memberIds = new Set((league.members || []).map(m => m.playerId));
    const candidates = AppStorage.getPlayers().filter(p => !memberIds.has(p.id));

    const absentHtml = absent.length === 0
      ? `<span class="league-pm-none">なし</span>`
      : absent.map(m => {
          const p = pmap[m.playerId];
          return `<span class="league-pm-chip">
            ${this._esc(p ? p.name : '?')}
            <button onclick="League.reinstatePlayer('${m.playerId}')">復帰</button>
          </span>`;
        }).join('');

    const entrantHtml = candidates.length === 0
      ? `<span class="league-pm-none">参入可能な未所属選手なし</span>`
      : `<select class="league-pm-select"
                onchange="League.addEntrant('${cls.id}', this.value); this.value='';">
          <option value="">＋ 新規参入する選手を選択</option>
          ${candidates.map(p => `<option value="${p.id}">${this._esc(p.name)}</option>`).join('')}
        </select>`;

    return `
      <div class="league-participant-mgmt">
        <div class="league-pm-row">
          <span class="league-pm-label">休場中</span>
          <div class="league-pm-items">${absentHtml}</div>
        </div>
        <div class="league-pm-row">
          <span class="league-pm-label">新規参入</span>
          <div class="league-pm-items">${entrantHtml}</div>
        </div>
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

    // 昇降級・期の移行
    html += this._renderPromotionSection(league, term);

    return html;
  },

  // ============================================
  // 昇降級・期の移行（Phase4）
  // ============================================

  /**
   * 各境界の推奨入替人数。
   * リーグの秩序維持の目安として「隣接2階級の少ない方の約1/3」を提案。
   * （上限は半数。中間階級は上下境界で最大 2×round(N/3) ≤ N となり破綻しない）
   */
  _suggestSwap(upperN, lowerN) {
    const smaller = Math.min(upperN, lowerN);
    if (smaller < 2) return 0;
    const byThird = Math.round(smaller / 3);
    return Math.max(1, Math.min(byThird, Math.floor(smaller / 2)));
  },

  setSwapCount(boundaryIndex, value) {
    this._swapCounts[boundaryIndex] = Math.max(0, parseInt(value) || 0);
    this.render();
  },

  /** 昇降級セクション（順位表ビュー末尾に表示） */
  _renderPromotionSection(league, term) {
    const classes = league.classes || [];
    if (classes.length < 2) {
      return `<div class="card"><p class="league-empty-hint">階級が2つ以上あると昇降級・期の移行を行えます。</p></div>`;
    }
    const pmap = this._playerMap();
    const nameList = (arr) =>
      arr.map(s => this._esc(pmap[s.id] ? pmap[s.id].name : '?')).join('、') || '—';

    let rows = '';
    for (let i = 0; i < classes.length - 1; i++) {
      const upper = classes[i], lower = classes[i + 1];
      const upperStand = this._classStandings(league, term, upper.id);
      const lowerStand = this._classStandings(league, term, lower.id);
      const maxSwap = Math.min(upperStand.length, lowerStand.length);
      const suggested = this._suggestSwap(upperStand.length, lowerStand.length);
      const swap = Math.min(this._swapCounts[i] != null ? this._swapCounts[i] : suggested, maxSwap);
      const demoted  = swap > 0 ? upperStand.slice(-swap) : [];
      const promoted = swap > 0 ? lowerStand.slice(0, swap) : [];

      rows += `
        <div class="league-boundary">
          <div class="league-boundary-head">
            <span class="league-boundary-title">${this._esc(upper.name)} ⇅ ${this._esc(lower.name)}</span>
            <div class="league-boundary-ctrl">
              <input type="number" class="league-swap-input" min="0" max="${maxSwap}"
                     value="${swap}" onchange="League.setSwapCount(${i}, this.value)">
              <span>名ずつ入替</span>
            </div>
          </div>
          <div class="league-boundary-preview">
            <span class="lb-demote">▼ ${this._esc(upper.name)} 降級: ${nameList(demoted)}</span>
            <span class="lb-promote">▲ ${this._esc(lower.name)} 昇級: ${nameList(promoted)}</span>
          </div>
        </div>`;
    }

    return `
      <div class="card">
        <h3 class="league-class-heading">昇降級・期の移行</h3>
        <p class="league-section-note">
          各階級の下位者が降級・下位階級の上位者が昇級します。入替人数は調整できます
          （リーグの秩序を保つ目安として各階級の約1/3を提案）。
          休場者は順位対象外・階級維持です。
        </p>
        ${rows}
        <button class="btn btn-primary league-finalize-btn" onclick="League.finalizeTerm()">
          第${league.currentTerm}期を確定して次の期へ
        </button>
      </div>`;
  },

  /** 現在の期を確定し、昇降級を適用して次の期へ進む */
  finalizeTerm() {
    const league = AppStorage.getLeague();
    const term = this._getCurrentTerm(league);
    const classes = league.classes || [];
    if (classes.length < 2) return;

    // 各境界の入替人数を確定
    const swaps = [];
    for (let i = 0; i < classes.length - 1; i++) {
      const upperStand = this._classStandings(league, term, classes[i].id);
      const lowerStand = this._classStandings(league, term, classes[i + 1].id);
      const maxSwap = Math.min(upperStand.length, lowerStand.length);
      const suggested = this._suggestSwap(upperStand.length, lowerStand.length);
      const v = this._swapCounts[i] != null ? this._swapCounts[i] : suggested;
      swaps.push(Math.max(0, Math.min(v, maxSwap)));
    }

    // 検証：各階級から出る合計（昇級out + 降級out）が出場者数を超えないか
    for (let i = 0; i < classes.length; i++) {
      const active = this._activeMemberIds(league, classes[i].id).length;
      const down = i < classes.length - 1 ? swaps[i]     : 0;
      const up   = i > 0                  ? swaps[i - 1] : 0;
      if (down + up > active) {
        alert(`「${classes[i].name}」は出場${active}名に対し昇降級の合計が${down + up}名で多すぎます。\n入替人数を減らしてください。`);
        return;
      }
    }

    // 未入力対局があれば警告
    let pending = 0, total = 0;
    classes.forEach(c => {
      (term.matches[c.id] || []).forEach(m => { total++; if (!m.result) pending++; });
    });
    let confirmMsg = `第${league.currentTerm}期を確定し、昇降級を適用して第${league.currentTerm + 1}期に進みますか？`;
    if (pending > 0) confirmMsg = `未入力の対局が${pending}局あります。\n` + confirmMsg;
    if (!confirm(confirmMsg)) return;

    // 昇降級を計算
    const changes = [];
    const newClassOf = {};
    for (let i = 0; i < classes.length - 1; i++) {
      const swap = swaps[i];
      if (swap <= 0) continue;
      const upper = classes[i], lower = classes[i + 1];
      const upperStand = this._classStandings(league, term, upper.id);
      const lowerStand = this._classStandings(league, term, lower.id);
      upperStand.slice(-swap).forEach(s => {
        newClassOf[s.id] = lower.id;
        changes.push({ playerId: s.id, fromClassId: upper.id, toClassId: lower.id, type: 'demote' });
      });
      lowerStand.slice(0, swap).forEach(s => {
        newClassOf[s.id] = upper.id;
        changes.push({ playerId: s.id, fromClassId: lower.id, toClassId: upper.id, type: 'promote' });
      });
    }

    // 適用
    term.finalized = true;
    term.changes = changes;
    (league.members || []).forEach(m => {
      if (newClassOf[m.playerId]) m.classId = newClassOf[m.playerId];
    });
    league.currentTerm = (league.currentTerm || 1) + 1;

    AppStorage.saveLeague(league);
    this._swapCounts = {};
    this.subView = 'manage';
    this.render();
    UI.showToast(
      `第${term.term}期を確定しました（昇降級${changes.length}件）。第${league.currentTerm}期を開始します。`,
      'success'
    );
  },
};
