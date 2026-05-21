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
  /** 階級IDを生成 */
  _genClassId() {
    return 'cls_' + Math.random().toString(36).slice(2, 9);
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

    container.innerHTML =
      this._renderHeader(league) +
      this._renderClassSection(league) +
      this._renderMemberSection(league);
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
};
