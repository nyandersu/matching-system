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
    } else if (this.subView === 'history') {
      body = this._renderHistoryView(league);
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
      { id: 'history',   label: '過去の期' },
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

  /** リーグ戦の設定（昇降級の割合・1グループの目標人数） */
  _settings(league) {
    return { ratio: 0.25, targetSize: 8, ...(league.settings || {}) };
  },

  /**
   * 級（tier）の補完と並べ替え。
   * 旧データ（tier なし）は上から順に別々の級として扱う。同じ tier の階級は並設グループ。
   * tier は 1 から連番に振り直す。
   */
  _normalize(league) {
    const classes = league.classes || (league.classes = []);
    let prev = 0;
    classes.forEach(c => {
      if (!Number.isFinite(c.tier)) c.tier = prev + 1;
      prev = c.tier;
    });
    classes.sort((a, b) => a.tier - b.tier);   // 安定ソート：同じ級の中の順番は保つ
    const map = new Map();
    classes.forEach(c => { if (!map.has(c.tier)) map.set(c.tier, map.size + 1); });
    classes.forEach(c => { c.tier = map.get(c.tier); });
    return league;
  },

  /** 級ごとにまとめた階級 [{ tier, classes }]（上の級から） */
  _tiers(league) {
    this._normalize(league);
    const out = [];
    (league.classes || []).forEach(c => {
      let t = out.find(x => x.tier === c.tier);
      if (!t) { t = { tier: c.tier, classes: [] }; out.push(t); }
      t.classes.push(c);
    });
    return out;
  },

  /** 級の名前（並設グループの添字を除いた名前） */
  _tierName(t) {
    return LeagueLogic.stripSiblingSuffix(t.classes[0].name);
  },

  /**
   * 選手の強い順（グループ分け・自動再編の並び順）。
   * 直前に確定した期の順位（上の級から、級内の順位順）→ レーティング → ランク → 名前。
   */
  _seedOrder(league, ids) {
    const lastTerm = (league.terms || []).filter(t => t.finalized && t.memberSnapshot)
      .sort((a, b) => b.term - a.term)[0];
    const snap = new Map((lastTerm?.memberSnapshot || []).map(s => [s.playerId, s]));
    const pmap = this._playerMap();
    const rankOrder = { S: 0, A: 1, B: 2, C: 3 };
    const key = id => {
      const s = snap.get(id);
      const p = pmap[id] || {};
      return [
        s ? s.tier : Infinity,
        s && s.finalRank != null ? s.finalRank : Infinity,
        Matching.hasNoRating(p) ? Infinity : -Number(p.rating),
        rankOrder[p.rank] ?? 9,
      ];
    };
    return [...ids].sort((a, b) => {
      const ka = key(a), kb = key(b);
      for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
      return String(pmap[a]?.name || '').localeCompare(String(pmap[b]?.name || ''), 'ja');
    });
  },

  /** 指定した階級に、結果入力済みの対局があるか */
  _hasResults(league, classIds) {
    const term = this._getCurrentTerm(league);
    return classIds.some(id => (term.matches[id] || []).some(m => m.result));
  },

  /** 階級管理セクション（級ごと。同じ級を複数のグループに分けられる） */
  _renderClassSection(league) {
    const tiers = this._tiers(league);
    const settings = this._settings(league);
    const memberCount = id => (league.members || []).filter(m => m.classId === id).length;

    let rows = '';
    tiers.forEach((t, ti) => {
      const total = t.classes.reduce((n, c) => n + memberCount(c.id), 0);
      const multi = t.classes.length > 1;
      rows += `
        <div class="league-tier">
          <div class="league-tier-head">
            <span class="league-class-order">${ti + 1}</span>
            <span class="league-tier-title">${multi ? `${this._esc(this._tierName(t))}（${t.classes.length}グループ）` : ''}</span>
            <span class="league-class-count">${total}名</span>
            <div class="league-class-actions">
              <button class="league-icon-btn" title="上へ" ${ti === 0 ? 'disabled' : ''}
                      onclick="League.moveTier(${t.tier}, -1)">▲</button>
              <button class="league-icon-btn" title="下へ" ${ti === tiers.length - 1 ? 'disabled' : ''}
                      onclick="League.moveTier(${t.tier}, 1)">▼</button>
              <button class="league-icon-btn league-text-btn" title="この級を複数のグループに分ける"
                      onclick="League.splitTier(${t.tier})">分ける</button>
              ${multi ? `<button class="league-icon-btn league-text-btn" title="グループを1つにまとめる"
                      onclick="League.mergeTier(${t.tier})">まとめる</button>` : ''}
            </div>
          </div>
          ${t.classes.map(cls => `
            <div class="league-class-row ${multi ? 'league-class-sibling' : ''}">
              <input type="text" class="league-class-name-input"
                     value="${this._esc(cls.name)}" maxlength="16"
                     onchange="League.renameClass('${cls.id}', this.value)">
              ${multi ? `<span class="league-class-count">${memberCount(cls.id)}名</span>` : ''}
              <button class="league-icon-btn league-icon-danger" title="削除"
                      onclick="League.deleteClass('${cls.id}')">✕</button>
            </div>`).join('')}
        </div>`;
    });

    if (tiers.length === 0) {
      rows = `<p class="league-empty-hint">階級がまだありません。「階級を追加」で A級・B級 などを作成してください。</p>`;
    }

    return `
      <div class="card">
        <h2 class="card-title"><span class="icon">🏅</span> 階級</h2>
        <p class="league-section-note">上にあるほど上位の級です（▲▼で並び替え、名前はタップで編集）。
          人数が多い級は「分ける」で複数のグループ（甲・乙…）にでき、各グループで総当たりを行います。
          グループに分けた級は、人数が減ると期の移行時に自動でまとまります。</p>
        <div class="league-class-list">${rows}</div>
        <button class="btn btn-secondary league-add-class-btn" onclick="League.addClass()">
          ＋ 階級を追加
        </button>
      </div>
      <div class="card">
        <h2 class="card-title"><span class="icon">⚙</span> 昇降級と級の構成</h2>
        <div class="league-settings">
          <label class="league-setting">
            <span>昇降級の割合</span>
            <input type="number" class="league-swap-input" min="0" max="50" step="5"
                   value="${Math.round(settings.ratio * 100)}"
                   onchange="League.setSetting('ratio', this.value / 100)">
            <span>%</span>
          </label>
          <label class="league-setting">
            <span>1グループの目標人数</span>
            <input type="number" class="league-swap-input" min="2" max="50"
                   value="${settings.targetSize}"
                   onchange="League.setSetting('targetSize', this.value)">
            <span>人</span>
          </label>
        </div>
        <p class="league-section-note">
          昇降級の人数は、隣り合う級の少ない方の人数 × 割合（最低1人・半数まで）を初期値にし、順位表タブで調整できます。
          目標人数は、グループ分けした級を期の移行時にまとめるかどうかと、下の「自動で作り直す」に使います。
        </p>
        <button class="btn btn-secondary" onclick="League.autoRestructure()">人数に合わせて階級を自動で作り直す</button>
      </div>`;
  },

  setSetting(key, value) {
    const league = AppStorage.getLeague();
    const settings = this._settings(league);
    if (key === 'ratio') settings.ratio = Math.max(0, Math.min(0.5, Number(value) || 0));
    if (key === 'targetSize') settings.targetSize = Math.max(2, Math.min(50, parseInt(value) || 8));
    league.settings = settings;
    AppStorage.saveLeague(league);
    this._swapCounts = {};
    this.render();
  },

  addClass() {
    const league = this._normalize(AppStorage.getLeague());
    const tiers = this._tiers(league);
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const idx = tiers.length;
    const defaultName = idx < letters.length ? `${letters[idx]}級` : `第${idx + 1}階級`;
    league.classes.push({ id: this._genClassId(), name: defaultName, tier: idx + 1 });
    AppStorage.saveLeague(league);
    this.render();
  },

  /** 級ごと上下に動かす（並設グループもまとめて動く） */
  moveTier(tier, dir) {
    const league = this._normalize(AppStorage.getLeague());
    const other = tier + dir;
    if (!league.classes.some(c => c.tier === other)) return;
    league.classes.forEach(c => {
      if (c.tier === tier) c.tier = other;
      else if (c.tier === other) c.tier = tier;
    });
    this._normalize(league);
    AppStorage.saveLeague(league);
    this.render();
  },

  splitTier(tier) {
    const league = this._normalize(AppStorage.getLeague());
    const t = this._tiers(league).find(x => x.tier === tier);
    if (!t) return;
    const members = (league.members || []).filter(m => t.classes.some(c => c.id === m.classId));
    const settings = this._settings(league);
    const suggested = Math.max(2, LeagueLogic.desiredGroupCount(members.length, settings.targetSize));
    const input = prompt(`「${this._tierName(t)}」（${members.length}名）をいくつのグループに分けますか？`, String(suggested));
    if (input == null) return;
    const k = parseInt(input);
    if (!(k >= 2 && k <= 10)) { UI.showToast('2〜10で指定してください', 'error'); return; }
    this._regroupTier(tier, k);
  },

  mergeTier(tier) {
    const league = this._normalize(AppStorage.getLeague());
    const t = this._tiers(league).find(x => x.tier === tier);
    if (!t || !confirm(`「${this._tierName(t)}」のグループを1つにまとめますか？`)) return;
    this._regroupTier(tier, 1);
  },

  /**
   * 級のメンバーを k グループに組み直す（強い順にスネーク配分）。
   * 結果入力済みの対局がある級はできない。総当たり表は組み直したグループで作り直す。
   */
  _regroupTier(tier, k) {
    const league = this._normalize(AppStorage.getLeague());
    const t = this._tiers(league).find(x => x.tier === tier);
    if (!t) return;
    const classIds = t.classes.map(c => c.id);
    if (this._hasResults(league, classIds)) {
      UI.showToast('結果を入力済みの対局があるため、この級のグループは変更できません（期の移行時に変更してください）', 'error');
      return;
    }
    AppStorage.createSnapshot(`リーグ戦「${this._tierName(t)}」のグループを変更する前`);

    const members = (league.members || []).filter(m => classIds.includes(m.classId));
    const ordered = this._seedOrder(league, members.map(m => m.playerId));
    const groups = LeagueLogic.distributeSnake(ordered, k);
    const names = LeagueLogic.defaultSiblingNames(this._tierName(t), k);
    const ids = groups.map((_, g) => classIds[g] || this._genClassId());

    league.classes = league.classes.filter(c => c.tier !== tier || ids.includes(c.id));
    ids.forEach((id, g) => {
      let cls = league.classes.find(c => c.id === id);
      if (!cls) { cls = { id, tier }; league.classes.push(cls); }
      cls.name = names[g];
      cls.tier = tier;
    });
    const groupOf = new Map();
    groups.forEach((g, gi) => g.forEach(pid => groupOf.set(pid, ids[gi])));
    members.forEach(m => { m.classId = groupOf.get(m.playerId); });

    const term = this._getCurrentTerm(league);
    const hadMatches = classIds.some(id => (term.matches[id] || []).length > 0);
    classIds.forEach(id => { delete term.matches[id]; });
    if (hadMatches) ids.forEach(id => { term.matches[id] = this._roundRobinMatches(league, id); });

    this._normalize(league);
    AppStorage.saveLeague(league);
    this.render();
    UI.showToast(k === 1 ? 'グループを1つにまとめました' : `${k}グループに分けました`, 'success');
  },

  /** 人数に合わせて階級を作り直す（自動再編） */
  autoRestructure() {
    const league = this._normalize(AppStorage.getLeague());
    if (this._hasResults(league, (league.classes || []).map(c => c.id))) {
      UI.showToast('この期に結果を入力済みの対局があるため、作り直せません（次の期の開始前に行ってください）', 'error');
      return;
    }
    const members = league.members || [];
    if (members.length === 0) { UI.showToast('階級に所属している選手がいません', 'error'); return; }
    const settings = this._settings(league);
    const plan = LeagueLogic.planAutoRestructure(this._seedOrder(league, members.map(m => m.playerId)), settings.targetSize);

    // 既存の級の名前を上から引き継ぐ（足りない分は既定名）
    const tiers = this._tiers(league);
    plan.forEach((c, i) => { if (tiers[i]) c.name = this._tierName(tiers[i]); });
    const summary = plan.map(c => `・${c.name}：${c.playerIds.length}名`).join('\n');
    if (!confirm(`所属している${members.length}名を、目標${settings.targetSize}人で次の階級に分けます（強い順：前の期の順位→レーティング→ランク）。\n\n${summary}\n\n実行しますか？`)) return;
    AppStorage.createSnapshot('リーグ戦の階級を自動で作り直す前');

    const oldIds = (league.classes || []).map(c => c.id);
    const term = this._getCurrentTerm(league);
    const hadMatches = oldIds.some(id => (term.matches[id] || []).length > 0);
    oldIds.forEach(id => { delete term.matches[id]; });

    league.classes = plan.map((c, i) => ({ id: oldIds[i] || this._genClassId(), name: c.name, tier: i + 1 }));
    const classOf = new Map();
    plan.forEach((c, i) => c.playerIds.forEach(pid => classOf.set(pid, league.classes[i].id)));
    members.forEach(m => { m.classId = classOf.get(m.playerId); });
    if (hadMatches) league.classes.forEach(c => { term.matches[c.id] = this._roundRobinMatches(league, c.id); });

    AppStorage.saveLeague(league);
    this._swapCounts = {};
    this.render();
    UI.showToast(`${plan.length}つの階級に作り直しました`, 'success');
  },

  /** 階級の出場メンバーで総当たり表を作る（先手回数を均等に） */
  _roundRobinMatches(league, classId) {
    return LeagueLogic.roundRobin(this._activeMemberIds(league, classId))
      .map(m => ({ id: this._genId(), p1Id: m.p1Id, p2Id: m.p2Id, result: null }));
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

  renameClass(classId, name) {
    const league = AppStorage.getLeague();
    const cls = (league.classes || []).find(c => c.id === classId);
    if (!cls) return;
    const trimmed = (name || '').trim();
    cls.name = trimmed || cls.name;
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
    // 1局だけ保存（他の端末が入力した結果を上書きしない）
    AppStorage.setLeagueMatchResult(term.term, classId, matchId, res);
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

    // 不足ペアを追加（先手回数の少ない側を先手に）
    const sente = {};
    activeIds.forEach(id => { sente[id] = 0; });
    kept.forEach(m => { if (m.p1Id in sente) sente[m.p1Id]++; });
    for (let i = 0; i < activeIds.length; i++) {
      for (let j = i + 1; j < activeIds.length; j++) {
        const k = pairKey(activeIds[i], activeIds[j]);
        if (!have.has(k)) {
          const [p1, p2] = sente[activeIds[j]] < sente[activeIds[i]]
            ? [activeIds[j], activeIds[i]] : [activeIds[i], activeIds[j]];
          sente[p1]++;
          kept.push({ id: this._genId(), p1Id: p1, p2Id: p2, result: null });
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
      if (!confirm('総当たり表を再生成しますか？\n入力済みの対局結果はすべて消去されます。\n（ヘッダーの「↩ 元に戻す」から復元できます）')) return;
      AppStorage.createSnapshot('リーグ戦の総当たり表を再生成する前');
    }

    (league.classes || []).forEach(cls => {
      term.matches[cls.id] = this._roundRobinMatches(league, cls.id);
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
    // 'p1' | 'p2' | 'draw' | null。1局だけ保存（他の端末が入力した結果を上書きしない）
    AppStorage.setLeagueMatchResult(term.term, classId, matchId, result);
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

  /** 同点時のプレーオフ結果（classId:down|up → 移動する選手ID） */
  _tieChoices: {},

  setSwapCount(boundaryIndex, value) {
    this._swapCounts[boundaryIndex] = Math.max(0, parseInt(value) || 0);
    this._tieChoices = {};
    this.render();
  },

  setTieChoice(key, playerId, checked) {
    const set = new Set(this._tieChoices[key] || this._lastPlan?.ties.find(t => t.key === key)?.chosen || []);
    if (checked) set.add(playerId); else set.delete(playerId);
    this._tieChoices[key] = [...set];
    this.render();
  },

  /**
   * 昇降級の計画（級の境界ごと）。
   * - 入替人数の初期値は「隣り合う級の少ない方の出場者数 × 割合」。境界ごとに変更できる
   * - 級をグループに分けている場合、人数は各グループへ按分（上位グループから）
   * - 境目が同点の場合は自動では決めず、プレーオフの結果で移動する選手を選ぶ
   */
  _promotionPlan(league) {
    const term = this._getCurrentTerm(league);
    const tiers = this._tiers(league);
    const settings = this._settings(league);
    const groups = tiers.map(t => t.classes.map(cls => ({ cls, standings: this._classStandings(league, term, cls.id) })));
    const activeByTier = groups.map(gs => gs.reduce((n, g) => n + g.standings.length, 0));
    const suggested = LeagueLogic.ratioSwapCounts(activeByTier, settings.ratio);

    const moves = {};   // classId → { down: [], up: [] }
    groups.flat().forEach(g => { moves[g.cls.id] = { down: [], up: [] }; });
    const ties = [];

    // 上から cut 人（dir='up'）／下から（dir='down'）を選ぶ。境目が同点ならプレーオフの選択を使う
    const pick = (g, n, dir) => {
      const st = g.standings;
      n = Math.min(n, st.length);
      if (n <= 0) return [];
      const cut = dir === 'up' ? n : st.length - n;
      const tie = LeagueLogic.tieAtCut(st, cut);
      const base = dir === 'up' ? st.slice(0, n) : st.slice(cut);
      if (!tie.tied) return base.map(s => s.id);
      const range = st.slice(tie.from, tie.to).map(s => s.id);
      const need = dir === 'up' ? cut - tie.from : tie.to - cut;
      const key = `${g.cls.id}:${dir}`;
      const fallback = dir === 'up' ? range.slice(0, need) : range.slice(range.length - need);
      const chosen = (this._tieChoices[key] || fallback).filter(id => range.includes(id));
      ties.push({ key, classId: g.cls.id, className: g.cls.name, dir, range, need, chosen, ok: chosen.length === need });
      const fixed = dir === 'up' ? st.slice(0, tie.from) : st.slice(tie.to);
      return [...fixed.map(s => s.id), ...chosen];
    };

    const boundaries = suggested.map((sug, i) => {
      const max = Math.min(activeByTier[i], activeByTier[i + 1]);
      const count = Math.max(0, Math.min(this._swapCounts[i] ?? sug, max));
      const relParts = LeagueLogic.apportion(count, groups[i].length);
      const proParts = LeagueLogic.apportion(count, groups[i + 1].length);
      groups[i].forEach((g, gi) => { moves[g.cls.id].down = pick(g, relParts[gi], 'down'); });
      groups[i + 1].forEach((g, gi) => { moves[g.cls.id].up = pick(g, proParts[gi], 'up'); });
      return { index: i, upper: tiers[i], lower: tiers[i + 1], count, suggested: sug, max,
               upperGroups: groups[i], lowerGroups: groups[i + 1] };
    });

    const plan = { tiers, groups, boundaries, moves, ties, settings };
    this._lastPlan = plan;
    return plan;
  },

  /** 昇降級セクション（順位表ビュー末尾に表示） */
  _renderPromotionSection(league, term) {
    const tiers = this._tiers(league);
    if (tiers.length < 2) {
      return `<div class="card"><p class="league-empty-hint">級が2つ以上あると昇降級・期の移行を行えます。</p></div>`;
    }
    const plan = this._promotionPlan(league);
    const pmap = this._playerMap();
    const name = id => this._esc(pmap[id] ? pmap[id].name : '?');
    const nameList = ids => ids.map(name).join('、') || '—';
    const tieHtml = (classId, dir) => {
      const t = plan.ties.find(x => x.key === `${classId}:${dir}`);
      if (!t) return '';
      return `
        <div class="league-tie">
          <span class="league-tie-title">⚠ 境目が同点です。プレーオフの結果で${dir === 'up' ? '昇級' : '降級'}する${t.need}名を選んでください</span>
          <div class="league-tie-options">
            ${t.range.map(id => `
              <label><input type="checkbox" ${t.chosen.includes(id) ? 'checked' : ''}
                onchange="League.setTieChoice('${t.key}', '${id}', this.checked)"> ${name(id)}</label>`).join('')}
          </div>
          ${t.ok ? '' : `<span class="league-tie-warn">${t.chosen.length}名選択中（${t.need}名選んでください）</span>`}
        </div>`;
    };

    const rows = plan.boundaries.map(b => `
      <div class="league-boundary">
        <div class="league-boundary-head">
          <span class="league-boundary-title">${this._esc(this._tierName(b.upper))} ⇅ ${this._esc(this._tierName(b.lower))}</span>
          <div class="league-boundary-ctrl">
            <input type="number" class="league-swap-input" min="0" max="${b.max}"
                   value="${b.count}" onchange="League.setSwapCount(${b.index}, this.value)">
            <span>名ずつ入替</span>
            ${b.count !== b.suggested ? `<span class="league-swap-hint">（割合では${b.suggested}名）</span>` : ''}
          </div>
        </div>
        <div class="league-boundary-preview">
          ${b.upperGroups.map(g => `
            <span class="lb-demote">▼ ${this._esc(g.cls.name)} 降級: ${nameList(plan.moves[g.cls.id].down)}</span>
            ${tieHtml(g.cls.id, 'down')}`).join('')}
          ${b.lowerGroups.map(g => `
            <span class="lb-promote">▲ ${this._esc(g.cls.name)} 昇級: ${nameList(plan.moves[g.cls.id].up)}</span>
            ${tieHtml(g.cls.id, 'up')}`).join('')}
        </div>
      </div>`).join('');

    return `
      <div class="card">
        <h3 class="league-class-heading">昇降級・期の移行</h3>
        <p class="league-section-note">
          各級の下位者が降級し、下の級の上位者が昇級します。入替人数の初期値は
          「隣り合う級の少ない方の出場者数 × ${Math.round(plan.settings.ratio * 100)}%」です（階級・選手タブで変更できます）。
          グループに分けた級は、人数を各グループに割り振ります。休場者は順位対象外で、級を維持します。
          境目が同点のときは、プレーオフの結果で移動する選手を選んでください。
        </p>
        ${rows}
        <button class="btn btn-primary league-finalize-btn" onclick="League.finalizeTerm()">
          第${league.currentTerm}期を確定して次の期へ
        </button>
      </div>`;
  },

  /**
   * 現在の期を確定し、昇降級を適用して次の期へ進む。
   * 次の期のグループ数は、級ごとの人数と目標人数から決める（自動では増やさず、人数が減ればまとめる）。
   * グループに分ける級は、成績順にスネーク配分して強さを均等にする。
   */
  finalizeTerm() {
    const league = this._normalize(AppStorage.getLeague());
    const term = this._getCurrentTerm(league);
    const plan = this._promotionPlan(league);
    if (plan.tiers.length < 2) return;

    const badTie = plan.ties.find(t => !t.ok);
    if (badTie) {
      alert(`「${badTie.className}」の同点の選手から、${badTie.dir === 'up' ? '昇級' : '降級'}する${badTie.need}名を選んでください。`);
      return;
    }
    for (const g of plan.groups.flat()) {
      const mv = plan.moves[g.cls.id];
      const overlap = mv.down.filter(id => mv.up.includes(id));
      if (mv.down.length + mv.up.length > g.standings.length || overlap.length > 0) {
        alert(`「${g.cls.name}」は出場${g.standings.length}名に対し昇降級が多すぎます。\n入替人数を減らしてください。`);
        return;
      }
    }

    let pending = 0;
    plan.groups.flat().forEach(g => (term.matches[g.cls.id] || []).forEach(m => { if (!m.result) pending++; }));
    let confirmMsg = `第${league.currentTerm}期を確定し、昇降級を適用して第${league.currentTerm + 1}期に進みますか？`;
    if (pending > 0) confirmMsg = `未入力の対局が${pending}局あります。\n` + confirmMsg;
    if (!confirm(confirmMsg)) return;
    AppStorage.createSnapshot(`リーグ戦 第${league.currentTerm}期を確定する前`);

    // 期の記録（あとから過去の期を見られるように、所属と順位を残す）
    const classById = new Map(league.classes.map(c => [c.id, c]));
    const rankOf = new Map();
    plan.groups.flat().forEach(g => g.standings.forEach((s, i) => rankOf.set(s.id, i + 1)));
    term.memberSnapshot = (league.members || []).filter(m => classById.has(m.classId)).map(m => ({
      playerId: m.playerId, classId: m.classId, className: classById.get(m.classId).name,
      tier: classById.get(m.classId).tier, status: m.status, finalRank: rankOf.get(m.playerId) ?? null,
    }));
    term.classNames = Object.fromEntries(league.classes.map(c => [c.id, c.name]));

    // 次の期の級：昇級は1つ上、降級は1つ下、それ以外（休場を含む）は同じ級
    const targetTier = new Map();
    const changes = [];
    plan.groups.flat().forEach(g => {
      const mv = plan.moves[g.cls.id];
      mv.up.forEach(id => { targetTier.set(id, g.cls.tier - 1); changes.push({ playerId: id, fromClassId: g.cls.id, fromName: g.cls.name, type: 'promote' }); });
      mv.down.forEach(id => { targetTier.set(id, g.cls.tier + 1); changes.push({ playerId: id, fromClassId: g.cls.id, fromName: g.cls.name, type: 'demote' }); });
    });
    const incomingByTier = {};
    (league.members || []).filter(m => classById.has(m.classId)).forEach(m => {
      const tier = targetTier.get(m.playerId) ?? classById.get(m.classId).tier;
      (incomingByTier[tier] ||= []).push({ playerId: m.playerId, finalRank: m.status === 'active' ? rankOf.get(m.playerId) ?? null : null });
    });
    const layout = LeagueLogic.planNextTermLayout(
      plan.tiers.map(t => ({ tier: t.tier, classIds: t.classes.map(c => c.id), baseName: this._tierName(t) })),
      incomingByTier, plan.settings.targetSize);

    // 適用：グループ数が減った級は余った階級を削除し、名前を付け直す
    const newClasses = [];
    const classOf = new Map();
    layout.forEach(l => {
      const oldIds = plan.tiers.find(t => t.tier === l.tier).classes.map(c => c.id);
      l.groups.forEach((g, gi) => {
        const id = oldIds[gi] || this._genClassId();
        newClasses.push({ id, name: l.groups.length === 1 && oldIds.length === 1 ? classById.get(oldIds[0]).name : g.name, tier: l.tier });
        g.playerIds.forEach(pid => classOf.set(pid, id));
      });
    });
    league.classes = newClasses;
    (league.members || []).forEach(m => { if (classOf.has(m.playerId)) m.classId = classOf.get(m.playerId); });
    const newName = new Map(newClasses.map(c => [c.id, c.name]));
    changes.forEach(c => {
      const m = (league.members || []).find(mm => mm.playerId === c.playerId);
      c.toClassId = m?.classId; c.toName = newName.get(m?.classId);
    });

    term.finalized = true;
    term.changes = changes;
    league.currentTerm = (league.currentTerm || 1) + 1;

    AppStorage.saveLeague(league);
    this._swapCounts = {};
    this._tieChoices = {};
    this.subView = 'manage';
    this.render();
    UI.showToast(
      `第${term.term}期を確定しました（昇降級${changes.length}件）。第${league.currentTerm}期を開始します。`,
      'success'
    );
  },

  // ============================================
  // 過去の期
  // ============================================

  historyTerm: null,

  setHistoryTerm(term) {
    this.historyTerm = Number(term);
    this.render();
  },

  /**
   * 確定した期の所属（階級ごとの選手）。記録がない古い期は対局から復元する。
   * @returns {Array} [{ classId, className, tier, playerIds }]
   */
  _termClasses(league, term) {
    if (term.memberSnapshot) {
      const out = [];
      term.memberSnapshot.forEach(s => {
        let c = out.find(x => x.classId === s.classId);
        if (!c) { c = { classId: s.classId, className: s.className, tier: s.tier, playerIds: [] }; out.push(c); }
        if (s.status === 'active') c.playerIds.push(s.playerId);
      });
      return out.sort((a, b) => a.tier - b.tier);
    }
    const order = (league.classes || []).map(c => c.id);
    return Object.entries(term.matches || {}).map(([classId, ms]) => {
      const ids = new Set();
      (ms || []).forEach(m => { ids.add(m.p1Id); ids.add(m.p2Id); });
      const cls = (league.classes || []).find(c => c.id === classId);
      return { classId, className: term.classNames?.[classId] || cls?.name || '（削除された階級）',
               tier: cls ? cls.tier : 999, order: order.indexOf(classId), playerIds: [...ids] };
    }).filter(c => c.playerIds.length > 0).sort((a, b) => a.tier - b.tier || a.order - b.order);
  },

  /** 過去の期の順位（その期の対局から集計） */
  _historyStandings(term, classId, playerIds) {
    const stats = {};
    playerIds.forEach(id => { stats[id] = { id, w: 0, l: 0, d: 0, pts: 0 }; });
    (term.matches[classId] || []).forEach(m => {
      if (!stats[m.p1Id] || !stats[m.p2Id]) return;
      if (m.result === 'p1') { stats[m.p1Id].w++; stats[m.p2Id].l++; }
      else if (m.result === 'p2') { stats[m.p2Id].w++; stats[m.p1Id].l++; }
      else if (m.result === 'draw') { stats[m.p1Id].d++; stats[m.p2Id].d++; }
    });
    Object.values(stats).forEach(s => { s.pts = s.w * 2 + s.d; });
    return Object.values(stats).sort((a, b) => b.pts - a.pts || b.w - a.w || a.l - b.l);
  },

  _renderHistoryView(league) {
    const finalized = (league.terms || []).filter(t => t.finalized).sort((a, b) => b.term - a.term);
    if (finalized.length === 0) {
      return `<div class="card"><p class="league-empty-hint">まだ確定した期はありません。順位表タブで期を確定すると、ここで振り返れます。</p></div>`;
    }
    const pmap = this._playerMap();
    const name = id => this._esc(pmap[id] ? pmap[id].name : '（削除された選手）');
    const selected = finalized.find(t => t.term === this.historyTerm) || finalized[0];
    const classes = this._termClasses(league, selected);
    const changeOf = new Map((selected.changes || []).map(c => [c.playerId, c]));

    const termTables = classes.map(c => {
      const st = this._historyStandings(selected, c.classId, c.playerIds);
      return `
        <div class="card">
          <h3 class="league-class-heading">${this._esc(c.className)}</h3>
          <table class="league-standings-table">
            <thead><tr><th>順位</th><th>選手</th><th>勝</th><th>敗</th><th>分</th><th>Pt</th><th></th></tr></thead>
            <tbody>${st.map((s, i) => {
              const ch = changeOf.get(s.id);
              const mark = ch ? (ch.type === 'promote' ? '<span class="lb-promote">▲ 昇級</span>' : '<span class="lb-demote">▼ 降級</span>') : '';
              return `<tr><td class="ls-pos">${i + 1}</td><td class="ls-name">${name(s.id)}</td>
                <td>${s.w}</td><td>${s.l}</td><td>${s.d}</td><td class="ls-pts">${s.pts}</td><td>${mark}</td></tr>`;
            }).join('')}</tbody>
          </table>
        </div>`;
    }).join('');

    // 級の推移：選手ごとに、各期で所属した階級
    const terms = finalized.slice().reverse();
    const byPlayer = new Map();
    terms.forEach(t => this._termClasses(league, t).forEach(c => c.playerIds.forEach(pid => {
      if (!byPlayer.has(pid)) byPlayer.set(pid, {});
      byPlayer.get(pid)[t.term] = { name: c.className, tier: c.tier };
    })));
    const currentTier = new Map((league.members || []).map(m => [m.playerId, (league.classes || []).find(c => c.id === m.classId)?.tier ?? 999]));
    const playersSorted = [...byPlayer.keys()].sort((a, b) => (currentTier.get(a) ?? 999) - (currentTier.get(b) ?? 999)
      || String(pmap[a]?.name || '').localeCompare(String(pmap[b]?.name || ''), 'ja'));
    const trend = `
      <div class="card">
        <h3 class="league-class-heading">級の推移</h3>
        <div class="league-cross-wrap">
          <table class="league-history-table">
            <thead><tr><th>選手</th>${terms.map(t => `<th>第${t.term}期</th>`).join('')}</tr></thead>
            <tbody>${playersSorted.map(pid => `
              <tr><th class="ls-name">${name(pid)}</th>${terms.map(t => {
                const v = byPlayer.get(pid)[t.term];
                return `<td class="${v ? `league-tier-cell league-tier-${Math.min(v.tier, 6)}` : ''}">${v ? this._esc(v.name) : '—'}</td>`;
              }).join('')}</tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;

    return `
      <div class="card">
        <h2 class="card-title"><span class="icon">📜</span> 過去の期</h2>
        <select class="form-select league-history-select" onchange="League.setHistoryTerm(this.value)">
          ${finalized.map(t => `<option value="${t.term}" ${t.term === selected.term ? 'selected' : ''}>第${t.term}期</option>`).join('')}
        </select>
      </div>
      ${termTables}
      ${trend}`;
  },
};
