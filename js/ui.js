/**
 * ui.js — UI描画・イベント管理モジュール
 */

const UI = {
  currentTab: 'players',
  editingPlayerId: null,
  displayOpts: { showGrade: true, showRank: true },

  /** レーティングモードか（リーグ戦モード中は常にランク扱い） */
  isRatingMode() {
    if ((AppStorage.getLeague() || {}).enabled) return false;
    return AppStorage.getSettings().strengthMode === 'rating';
  },

  /** レーティングの表示用文字列（未入力は —） */
  formatRating(rating) {
    if (Matching.hasNoRating({ rating })) return '—';
    return String(Math.round(Number(rating) * 10) / 10);
  },

  /**
   * 対戦表などでの強さの表示。
   * ランクモード：対戦表生成時のランク（snapshotRank）のバッジ
   * レーティングモード：選手の現在のレーティング
   */
  strengthBadgeHtml(playerId, snapshotRank, playerMap, ratingMode) {
    if (ratingMode) {
      return `<span class="rating-badge">${this.escapeHtml(this.formatRating(playerMap[playerId]?.rating))}</span>`;
    }
    return `<span class="rank-badge rank-${snapshotRank}">${snapshotRank}</span>`;
  },
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

    // リーグ戦モードに応じてタブ表示を切り替え
    this.applyLeagueMode();

    // 初回のローカル描画
    this.renderAll();

    // Supabaseからのリアルタイム同期が来た時のハンドラ
    AppStorage.initRealtime(() => {
      this.applyLeagueMode();
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
      if (password.length < 8) {
        errEl.textContent = 'パスワードは8文字以上にしてください';
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

    // 部の一覧 → 自分が作成した部屋（サーバー）と最近参加した部屋（この端末）を表示
    this._renderClubs().then(() => this._renderRoomLists());
    this._bindClubEvents();

    // 新規作成ボタン（作成した部屋はアカウントに紐づけて保存。部を選んでいればその部にひも付け）
    const createBtn = document.getElementById('room-create-btn');
    createBtn.addEventListener('click', async () => {
      const newId = AppStorage.generateRoomId();
      const clubId = document.getElementById('room-club-select').value || null;
      try { localStorage.setItem('shogi_last_club', clubId || ''); } catch {}
      createBtn.disabled = true;
      try {
        await AppStorage.registerOwnedRoom(newId, clubId);
      } catch (err) {
        console.warn(err);
        alert(`部屋をアカウントに登録できませんでした。\n部屋コード「${newId}」を控えておいてください。`);
      }
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

  /** 自分が作成した部屋（サーバー）と最近参加した部屋（この端末）を描画 */
  async _renderRoomLists() {
    const roomCodeRe = /^[A-Z0-9]{4,32}$/;
    const renderList = (sectionId, listId, items, deleteTitle, onDelete) => {
      const section = document.getElementById(sectionId);
      const list    = document.getElementById(listId);
      if (!section || !list) return;
      section.classList.toggle('hidden', items.length === 0);
      list.innerHTML = items.map(({ roomId, meta, linkable }) => `
        <div class="room-history-item">
          <button class="room-history-enter" data-room="${this.escapeHtml(roomId)}">
            <span class="room-history-code">${this.escapeHtml(roomId)}</span>
            ${meta ? `<span class="room-history-meta">${this.escapeHtml(meta)}</span>` : ''}
            <span class="room-history-arrow">→</span>
          </button>
          ${linkable ? `<button class="room-history-delete room-history-link" data-room="${this.escapeHtml(roomId)}" title="部にひも付ける">🔗</button>` : ''}
          <button class="room-history-delete" data-room="${this.escapeHtml(roomId)}" title="${deleteTitle}">✕</button>
        </div>
      `).join('');
      list.querySelectorAll('.room-history-link').forEach(btn => {
        btn.addEventListener('click', () => this._showClubLink(btn.dataset.room));
      });
      list.querySelectorAll('.room-history-enter').forEach(btn => {
        btn.addEventListener('click', () => this._enterRoom(btn.dataset.room));
      });
      list.querySelectorAll('.room-history-delete:not(.room-history-link)').forEach(btn => {
        btn.addEventListener('click', () => onDelete(btn.dataset.room));
      });
    };

    let owned = [];
    try {
      owned = await AppStorage.listOwnedRooms();
    } catch (err) {
      console.warn(err);
    }
    renderList('owned-rooms-section', 'owned-rooms-list',
      owned.filter(r => roomCodeRe.test(r.roomId)).map(r => {
        const date = new Date(r.createdAt);
        const parts = [`${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}作成`, `${r.playerCount}人`];
        if (r.roundCount > 0) parts.push(`${r.roundCount}回戦`);
        if (r.clubName) parts.unshift(r.clubName);
        return { roomId: r.roomId, meta: parts.join('・'), linkable: !r.clubId && (this._clubs || []).length > 0 };
      }),
      'この部屋を削除', roomId => this._deleteRoom(roomId));

    // 自分の部屋は上に出ているので、最近参加した部屋からは除外
    // 他アカウントの部屋は削除できないため、✕は履歴から外すだけ
    const ownedIds = new Set(owned.map(r => r.roomId));
    renderList('room-history-section', 'room-history-list',
      AppStorage.getRoomHistory()
        .filter(r => roomCodeRe.test(r) && !ownedIds.has(r))
        .map(r => ({ roomId: r, meta: '' })),
      '履歴から外す', roomId => {
        AppStorage.removeFromRoomHistory(roomId);
        this._renderRoomLists();
      });
  },

  // ============================================
  // 部と名簿（部屋選択画面）
  // ============================================

  async _renderClubs() {
    const list = document.getElementById('club-list');
    try {
      this._clubs = await AppStorage.listClubs();
    } catch (err) {
      console.warn(err);
      this._clubs = [];
    }
    list.innerHTML = this._clubs.length === 0
      ? '<p class="history-empty">部を作ると、選手とレーティングを部屋をまたいで引き継げます</p>'
      : this._clubs.map((c, i) => `
        <div class="room-history-item">
          <button class="room-history-enter" onclick="UI.showRoster(${i})">
            <span class="room-history-code">${this.escapeHtml(c.name)}</span>
            <span class="room-history-meta">部コード ${this.escapeHtml(c.clubId)}・名簿${c.playerCount}人・部屋${c.roomCount}</span>
            <span class="room-history-arrow">名簿 →</span>
          </button>
        </div>`).join('');

    // 新しい部屋の部の選択肢（前回選んだ部を初期値に）
    const group  = document.getElementById('room-club-select-group');
    const select = document.getElementById('room-club-select');
    group.classList.toggle('hidden', this._clubs.length === 0);
    let last = null;
    try { last = localStorage.getItem('shogi_last_club'); } catch {}
    // 前回「部なし」を選んだ（空文字）ならそのまま。未選択・存在しない部なら先頭の部
    const initial = last === '' ? '' : (this._clubs.some(c => c.clubId === last) ? last : (this._clubs[0]?.clubId || ''));
    select.innerHTML = this._clubs.map(c => `<option value="${this.escapeHtml(c.clubId)}">${this.escapeHtml(c.name)}</option>`).join('')
      + '<option value="">部なし（名簿を使わない）</option>';
    select.value = initial;
  },

  _bindClubEvents() {
    document.getElementById('club-create-btn').addEventListener('click', async () => {
      const name = (prompt('部の名前を入力してください（例: 〇〇高校将棋部）') || '').trim();
      if (!name) return;
      try {
        const code = await AppStorage.createClub(name.slice(0, 50));
        try { localStorage.setItem('shogi_last_club', code); } catch {}
        alert(`「${name}」を作成しました。\n\n部コード: ${code}\n他の部員がこのコードで参加すると、同じ名簿を使えます。`);
        await this._renderClubs();
        this._renderRoomLists();
      } catch (err) {
        alert(err.message);
      }
    });
    const join = async () => {
      const input = document.getElementById('club-code-input');
      const code = input.value.trim().toUpperCase();
      if (code.length < 4) return;
      try {
        const club = await AppStorage.joinClub(code);
        input.value = '';
        this.showToast(`「${club.name}」に参加しました`, 'success');
        await this._renderClubs();
        this._renderRoomLists();
      } catch (err) {
        alert(err.message);
      }
    };
    document.getElementById('club-join-btn').addEventListener('click', join);
    document.getElementById('club-code-input').addEventListener('keydown', e => { if (e.key === 'Enter') join(); });
    document.getElementById('club-code-input').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase(); });
  },

  /** 部の名簿（追加・編集・引退・レーティング履歴・進級） */
  async showRoster(clubOrIndex) {
    const club = typeof clubOrIndex === 'number' ? (this._clubs || [])[clubOrIndex] : clubOrIndex;
    if (!club) return;
    this._rosterClub = club;
    const modal = document.getElementById('roster-modal');
    if (!modal.dataset.bound) {
      modal.dataset.bound = '1';
      const close = () => {
        modal.classList.add('hidden');
        // 部屋選択画面なら人数の表示を更新、部屋の中なら名簿の変更を取り込む
        if (!document.getElementById('room-selector-overlay').classList.contains('hidden')) this._renderClubs();
        else if (AppStorage.roomId) AppStorage._scheduleRefetch();
      };
      document.getElementById('roster-close').addEventListener('click', close);
      modal.addEventListener('click', e => { if (e.target === modal) close(); });
      document.getElementById('roster-form').addEventListener('submit', e => { e.preventDefault(); this._saveRosterForm(); });
      document.getElementById('roster-cancel').addEventListener('click', () => this._resetRosterForm());
      document.getElementById('roster-show-retired').addEventListener('change', () => this._renderRosterTable());
      document.getElementById('roster-promote-btn').addEventListener('click', () => this._promoteRosterGrades());
    }
    document.getElementById('roster-title').textContent = `${club.name} の名簿`;
    document.getElementById('roster-note').textContent =
      `部コード ${club.clubId}（他の部員がこのコードで参加すると同じ名簿を使えます）。名簿の変更は、この部にひも付いた部屋に反映されます。`;
    this._resetRosterForm();
    modal.classList.remove('hidden');
    await this._loadRoster();
  },

  async _loadRoster() {
    const table = document.getElementById('roster-table');
    table.innerHTML = '<tbody><tr><td>読み込み中...</td></tr></tbody>';
    try {
      this._roster = await AppStorage.listRoster(this._rosterClub.clubId);
    } catch (err) {
      table.innerHTML = `<tbody><tr><td>${this.escapeHtml(err.message)}</td></tr></tbody>`;
      return;
    }
    this._renderRosterTable();
  },

  _renderRosterTable() {
    const showRetired = document.getElementById('roster-show-retired').checked;
    const rows = (this._roster || []).filter(p => showRetired || !p.retired);
    const table = document.getElementById('roster-table');
    if (rows.length === 0) {
      table.innerHTML = '<tbody><tr><td class="opp-muted">名簿に選手がいません。上の欄から追加してください。</td></tr></tbody>';
      return;
    }
    table.innerHTML = `
      <thead><tr><th>名前</th><th>学年</th><th>ランク</th><th>レート</th><th></th></tr></thead>
      <tbody>${rows.map(p => `
        <tr class="${p.retired ? 'player-withdrawn' : ''}">
          <td class="opp-name">${this.escapeHtml(p.name)}${p.retired ? ' <span class="withdrawn-badge">引退</span>' : ''}</td>
          <td>${p.grade ?? '—'}${p.grade ? '年' : ''}</td>
          <td>${p.rank ? `<span class="rank-badge rank-${p.rank}">${p.rank}</span>` : '—'}</td>
          <td>${this.escapeHtml(this.formatRating(p.rating))}</td>
          <td class="roster-actions">
            <button type="button" class="btn btn-ghost btn-sm" onclick="UI._editRosterPlayer('${p.id}')">編集</button>
            <button type="button" class="btn btn-ghost btn-sm" onclick="UI.showCareer('${p.id}', '${this.escapeHtml(p.name).replace(/'/g, '&#39;')}')">成績</button>
            <button type="button" class="btn btn-ghost btn-sm" onclick="UI._toggleRatingHistory('${p.id}')">履歴</button>
            <button type="button" class="btn btn-ghost btn-sm" onclick="UI._toggleRetired('${p.id}')">${p.retired ? '復帰' : '引退'}</button>
          </td>
        </tr>
        <tr class="roster-history-row hidden" id="roster-history-${p.id}"><td colspan="5"></td></tr>`).join('')}
      </tbody>`;
  },

  _resetRosterForm() {
    document.getElementById('roster-form').reset();
    document.getElementById('roster-edit-id').value = '';
    document.getElementById('roster-rank').value = 'C';
    document.getElementById('roster-submit').textContent = '追加';
    document.getElementById('roster-cancel').classList.add('hidden');
  },

  _editRosterPlayer(id) {
    const p = (this._roster || []).find(x => x.id === id);
    if (!p) return;
    document.getElementById('roster-edit-id').value = p.id;
    document.getElementById('roster-name').value = p.name;
    document.getElementById('roster-grade').value = p.grade ?? 1;
    document.getElementById('roster-rank').value = p.rank || 'C';
    document.getElementById('roster-rating').value = Matching.hasNoRating(p) ? '' : p.rating;
    document.getElementById('roster-submit').textContent = '更新';
    document.getElementById('roster-cancel').classList.remove('hidden');
    document.getElementById('roster-name').focus();
  },

  async _saveRosterForm() {
    const id     = document.getElementById('roster-edit-id').value || null;
    const name   = document.getElementById('roster-name').value.trim();
    const raw    = document.getElementById('roster-rating').value.trim();
    const rating = raw === '' ? null : Number(raw);
    if (!name) return;
    if (rating !== null && !Number.isFinite(rating)) {
      this.showToast('レーティングを数値で入力してください', 'error');
      return;
    }
    const current = id ? (this._roster || []).find(x => x.id === id) : null;
    try {
      await AppStorage.saveRosterPlayer(this._rosterClub.clubId, {
        id, name, rating,
        grade: parseInt(document.getElementById('roster-grade').value),
        rank: document.getElementById('roster-rank').value,
        retired: current ? current.retired : false,
      });
      this.showToast(id ? `${name} を更新しました` : `${name} を名簿に追加しました`, 'success');
      this._resetRosterForm();
      await this._loadRoster();
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  async _toggleRetired(id) {
    const p = (this._roster || []).find(x => x.id === id);
    if (!p) return;
    const msg = p.retired
      ? `${p.name} を名簿に戻しますか？`
      : `${p.name} を引退にしますか？\n（名簿の一覧と「名簿から追加」に出なくなります。成績とレーティングの履歴は残ります）`;
    if (!confirm(msg)) return;
    try {
      await AppStorage.saveRosterPlayer(this._rosterClub.clubId, { ...p, retired: !p.retired });
      await this._loadRoster();
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  async _promoteRosterGrades() {
    const targets = (this._roster || []).filter(p => !p.retired && p.grade);
    if (targets.length === 0) return;
    if (!confirm(`引退していない${targets.length}人の学年を1つずつ上げますか？（新年度の進級用。8年が上限です）`)) return;
    try {
      for (const p of targets) {
        await AppStorage.saveRosterPlayer(this._rosterClub.clubId, { ...p, grade: Math.min(8, p.grade + 1) });
      }
      this.showToast(`${targets.length}人の学年を上げました`, 'success');
      await this._loadRoster();
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  async _toggleRatingHistory(id) {
    const row = document.getElementById(`roster-history-${id}`);
    if (!row) return;
    if (!row.classList.contains('hidden')) { row.classList.add('hidden'); return; }
    row.classList.remove('hidden');
    const cell = row.querySelector('td');
    cell.textContent = '読み込み中...';
    try {
      cell.innerHTML = this._ratingHistoryHtml(await AppStorage.listRatingHistory(id));
    } catch (err) {
      cell.textContent = err.message;
    }
  },

  /** レーティング履歴（日付・部屋・回戦・変化） */
  _ratingHistoryHtml(history) {
    if (history.length === 0) return '<span class="opp-muted">まだレーティングの更新はありません</span>';
    return `<ul class="rating-history-list">${history.map(h => {
      const d = new Date(h.created_at);
      const before = Number(h.before), after = Number(h.after);
      const delta = Math.round(after - before);
      const sign = delta > 0 ? `+${delta}` : delta < 0 ? `−${-delta}` : '±0';
      return `<li>${d.getMonth() + 1}/${d.getDate()}　部屋 ${this.escapeHtml(h.room_id || '')} 第${this.escapeHtml((h.rounds || []).join('・'))}回戦　`
        + `${this.escapeHtml(this.formatRating(before))} → <strong>${this.escapeHtml(this.formatRating(after))}</strong>`
        + ` <span class="${delta > 0 ? 'opp-diff-up' : delta < 0 ? 'opp-diff-down' : ''}">(${sign})</span></li>`;
    }).join('')}</ul>`;
  },

  /** 名簿から部屋に選手を追加 */
  async showRosterPick() {
    const club = AppStorage.getRoomClub();
    if (!club) return;
    const modal = document.getElementById('roster-pick-modal');
    const close = () => modal.classList.add('hidden');
    if (!modal.dataset.bound) {
      modal.dataset.bound = '1';
      document.getElementById('roster-pick-close').addEventListener('click', close);
      document.getElementById('roster-pick-cancel').addEventListener('click', close);
      modal.addEventListener('click', e => { if (e.target === modal) close(); });
      document.getElementById('roster-pick-all').addEventListener('change', e => {
        modal.querySelectorAll('.roster-pick-item input').forEach(cb => { cb.checked = e.target.checked; });
      });
      document.getElementById('roster-pick-apply').addEventListener('click', () => {
        const ids = [...modal.querySelectorAll('.roster-pick-item input:checked')].map(cb => cb.value);
        const picked = (this._rosterPickCandidates || []).filter(p => ids.includes(p.id));
        if (picked.length === 0) { close(); return; }
        const added = AppStorage.addPlayersFromRoster(picked);
        close();
        this.renderAll();
        this.showToast(`名簿から${added.length}人を追加しました`, 'success');
      });
    }
    const list = document.getElementById('roster-pick-list');
    document.getElementById('roster-pick-all').checked = false;
    list.innerHTML = '<p class="history-empty">読み込み中...</p>';
    modal.classList.remove('hidden');

    let roster;
    try {
      roster = await AppStorage.listRoster(club.clubId);
    } catch (err) {
      list.innerHTML = `<p class="history-empty">${this.escapeHtml(err.message)}</p>`;
      return;
    }
    const inRoom = new Set(AppStorage.getPlayers().map(p => p.clubPlayerId).filter(Boolean));
    this._rosterPickCandidates = roster.filter(p => !p.retired && !inRoom.has(p.id));
    list.innerHTML = this._rosterPickCandidates.length === 0
      ? '<p class="history-empty">追加できる選手はいません（名簿の全員がこの部屋に入っています）</p>'
      : this._rosterPickCandidates.map(p => `
        <label class="history-item roster-pick-item">
          <span class="history-info">
            <span class="history-label"><input type="checkbox" value="${this.escapeHtml(p.id)}"> ${this.escapeHtml(p.name)}</span>
            <span class="history-meta">${p.grade ? `${p.grade}年` : ''}${p.rank ? `・${p.rank}` : ''}${Matching.hasNoRating(p) ? '' : `・レート ${this.escapeHtml(this.formatRating(p.rating))}`}</span>
          </span>
        </label>`).join('');
  },

  /**
   * 通算成績（部にひも付いた全部屋の内戦・リーグ戦）。
   * 通算・連勝連敗・先後別・対戦相手別・直近の対局、リーグ戦の級とレーティングの推移。
   */
  async showCareer(clubPlayerId, name) {
    const modal = document.getElementById('career-modal');
    if (!modal.dataset.bound) {
      modal.dataset.bound = '1';
      document.getElementById('career-close').addEventListener('click', () => modal.classList.add('hidden'));
      modal.addEventListener('click', e => { if (e.target === modal) modal.classList.add('hidden'); });
    }
    const content = document.getElementById('career-content');
    content.innerHTML = `<h3 class="pt-info-title">${this.escapeHtml(name)} の通算成績</h3><p class="history-empty">読み込み中...</p>`;
    modal.classList.remove('hidden');

    let games, ratings;
    try {
      [games, ratings] = await Promise.all([
        AppStorage.getPlayerCareer(clubPlayerId),
        AppStorage.listRatingHistory(clubPlayerId).catch(() => []),
      ]);
    } catch (err) {
      content.innerHTML = `<h3 class="pt-info-title">${this.escapeHtml(name)} の通算成績</h3><p class="history-empty">${this.escapeHtml(err.message)}</p>`;
      return;
    }

    const stats = LeagueLogic.careerStats(games.map(g => ({
      outcome: g.outcome, sente: g.sente, opponentId: g.opponent_club_player_id, opponentName: g.opponent_name || '?',
    })));
    const rec = s => `${s.wins}勝${s.losses}敗${s.draws ? `${s.draws}分` : ''}`;
    const pct = s => (s.played ? `${(s.winRate * 100).toFixed(1)}%` : '—');
    const where = g => g.kind === 'league'
      ? `${this.escapeHtml(g.room_id)} リーグ第${g.round_no}期${g.class_name ? ` ${this.escapeHtml(g.class_name)}` : ''}`
      : `${this.escapeHtml(g.room_id)} 第${g.round_no}回戦`;
    const mark = { W: '<span class="pd-result win">○ 勝</span>', L: '<span class="pd-result loss">● 敗</span>', D: '<span class="pd-result draw">△ 分</span>' };

    // リーグ戦の級の推移（期ごと）
    const leaguePoints = [];
    games.filter(g => g.kind === 'league' && g.class_tier != null).forEach(g => {
      const key = `${g.room_id}#${g.round_no}`;
      if (!leaguePoints.some(p => p.key === key)) leaguePoints.push({ key, label: `第${g.round_no}期`, value: g.class_tier, name: g.class_name });
    });
    const ratingPoints = ratings.map((h, i) => ({ label: String(i + 1), value: Number(h.after) }));
    if (ratings.length > 0) ratingPoints.unshift({ label: '0', value: Number(ratings[0].before) });

    content.innerHTML = `
      <h3 class="pt-info-title">${this.escapeHtml(name)} の通算成績</h3>
      ${games.length === 0 ? '<p class="history-empty">まだ結果が入力された対局はありません（部にひも付いた部屋の対局が対象です）</p>' : `
      <div class="pd-summary career-summary">
        <div class="pd-stat-box"><span class="pd-stat-val">${stats.total.played}</span><span class="pd-stat-lbl">対局</span></div>
        <div class="pd-stat-box"><span class="pd-stat-val win-color">${stats.total.wins}</span><span class="pd-stat-lbl">勝</span></div>
        <div class="pd-stat-box"><span class="pd-stat-val loss-color">${stats.total.losses}</span><span class="pd-stat-lbl">敗</span></div>
        <div class="pd-stat-box"><span class="pd-stat-val">${stats.total.draws}</span><span class="pd-stat-lbl">分</span></div>
        <div class="pd-stat-box"><span class="pd-stat-val">${pct(stats.total)}</span><span class="pd-stat-lbl">勝率</span></div>
      </div>
      <div class="career-facts">
        <div><span class="career-fact-label">最長連勝</span><strong>${stats.streaks.longestWin}</strong></div>
        <div><span class="career-fact-label">最長連敗</span><strong>${stats.streaks.longestLose}</strong></div>
        <div><span class="career-fact-label">現在</span><strong>${stats.streaks.currentWin ? `${stats.streaks.currentWin}連勝中` : stats.streaks.currentLose ? `${stats.streaks.currentLose}連敗中` : '—'}</strong></div>
        <div><span class="career-fact-label">先手</span><strong>${rec(stats.sente)}</strong> <span class="opp-muted">${pct(stats.sente)}</span></div>
        <div><span class="career-fact-label">後手</span><strong>${rec(stats.gote)}</strong> <span class="opp-muted">${pct(stats.gote)}</span></div>
      </div>
      <p class="pt-info-note">勝率は引き分けを0.5勝として計算。先手・後手は対戦表の左側（先手）・右側で集計しています（先後指定なしで行った内戦も含みます）。連勝・連敗は部屋の作成順・回戦順に並べて数えています。</p>`}

      ${leaguePoints.length >= 2 ? `
      <div class="pd-section"><h3 class="pd-section-title">リーグ戦の級の推移</h3>
        ${this._lineChartSvg(leaguePoints, { invert: true, valueLabel: p => p.name || '' })}</div>` : ''}
      ${ratingPoints.length >= 2 ? `
      <div class="pd-section"><h3 class="pd-section-title">レーティングの推移</h3>
        ${this._lineChartSvg(ratingPoints, { valueLabel: p => this.formatRating(p.value) })}</div>` : ''}

      ${stats.opponents.length > 0 ? `
      <div class="pd-section"><h3 class="pd-section-title">対戦相手別</h3>
        <div class="opp-strength-table-wrapper"><table class="opp-strength-table">
          <thead><tr><th>相手</th><th>対局</th><th>成績</th><th>勝率</th></tr></thead>
          <tbody>${stats.opponents.slice(0, 20).map(o => `
            <tr><td class="opp-name">${this.escapeHtml(o.name)}</td><td>${o.played}</td><td>${rec(o)}</td><td>${pct(o)}</td></tr>`).join('')}
          </tbody></table></div></div>` : ''}

      ${games.length > 0 ? `
      <div class="pd-section"><h3 class="pd-section-title">直近の対局</h3>
        <table class="pd-history-table"><tbody>${games.slice(-20).reverse().map(g => `
          <tr><td class="pd-round">${where(g)}</td>
              <td class="pd-opponent"><span class="pd-opp-name">${this.escapeHtml(g.opponent_name || '?')}</span>
                <span class="pd-opp-meta">${g.sente ? '先手' : '後手'}</span></td>
              <td>${mark[g.outcome] || ''}</td></tr>`).join('')}
        </tbody></table></div>` : ''}`;
  },

  /**
   * 折れ線グラフ（SVG）。points: [{ label, value }]。invert=true で値が小さいほど上（級の推移用）
   */
  _lineChartSvg(points, { invert = false, valueLabel = () => '' } = {}) {
    const W = 560, H = 160, pad = { l: 16, r: 16, t: 22, b: 24 };
    const vals = points.map(p => p.value);
    let min = Math.min(...vals), max = Math.max(...vals);
    if (min === max) { min -= 1; max += 1; }
    const x = i => pad.l + (points.length === 1 ? 0 : i * (W - pad.l - pad.r) / (points.length - 1));
    const y = v => {
      const r = (v - min) / (max - min);
      return pad.t + (invert ? r : 1 - r) * (H - pad.t - pad.b);
    };
    const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
    const showEvery = Math.ceil(points.length / 12);
    return `
      <svg class="career-chart" viewBox="0 0 ${W} ${H}" role="img" preserveAspectRatio="none">
        <path d="${path}" fill="none" stroke="var(--amber-light)" stroke-width="2"/>
        ${points.map((p, i) => `
          <circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="3.5" fill="var(--amber)"/>
          ${i % showEvery === 0 || i === points.length - 1 ? `
          <text x="${x(i).toFixed(1)}" y="${(y(p.value) - 8).toFixed(1)}" text-anchor="middle" class="career-chart-value">${this.escapeHtml(valueLabel(p))}</text>
          <text x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="career-chart-label">${this.escapeHtml(p.label)}</text>` : ''}`).join('')}
      </svg>`;
  },

  /** 部屋を部にひも付けるダイアログ */
  _showClubLink(roomId) {
    const modal = document.getElementById('club-link-modal');
    const close = () => modal.classList.add('hidden');
    if (!modal.dataset.bound) {
      modal.dataset.bound = '1';
      document.getElementById('club-link-close').addEventListener('click', close);
      document.getElementById('club-link-cancel').addEventListener('click', close);
      modal.addEventListener('click', e => { if (e.target === modal) close(); });
      document.getElementById('club-link-apply').addEventListener('click', async () => {
        const target = modal.dataset.room;
        const clubId = document.getElementById('club-link-select').value;
        try {
          const created = await AppStorage.linkRoomToClub(target, clubId);
          close();
          this.showToast(`部屋 ${target} を部にひも付けました（名簿に${created}人を追加）`, 'success');
          await this._renderClubs();
          this._renderRoomLists();
        } catch (err) {
          alert(err.message);
        }
      });
    }
    modal.dataset.room = roomId;
    document.getElementById('club-link-note').textContent =
      `部屋 ${roomId} の選手を部の名簿にひも付けます。名簿に同じ名前の選手がいればその選手に、いなければ名簿に追加します。`;
    document.getElementById('club-link-select').innerHTML = (this._clubs || [])
      .map(c => `<option value="${this.escapeHtml(c.clubId)}">${this.escapeHtml(c.name)}</option>`).join('');
    modal.classList.remove('hidden');
  },

  /** 自分が作成した部屋を削除（確認あり） */
  async _deleteRoom(roomId) {
    const msg = `部屋「${roomId}」を削除しますか？\n\n`
      + 'この部屋の選手・対戦表・リーグ戦データがすべて削除され、元に戻せません。';
    if (!confirm(msg)) return;
    try {
      await AppStorage.deleteRoom(roomId);
      this.showToast(`部屋「${roomId}」を削除しました`, 'info');
    } catch (err) {
      this.showToast(err.message, 'error');
    }
    this._renderRoomLists();
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

      document.getElementById('history-btn').addEventListener('click', () => this.showHistory());
      document.getElementById('room-club-display').addEventListener('click', () => {
        const club = AppStorage.getRoomClub();
        if (club) this.showRoster(club);
      });
      document.getElementById('add-from-roster-btn').addEventListener('click', () => this.showRosterPick());

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

      document.getElementById('logout-btn').addEventListener('click', async () => {
        if (confirm('ログアウトしますか？')) {
          await AppStorage.logout();
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
    if (typeof League !== 'undefined') League.render();
  },

  /**
   * リーグ戦モードに応じてタブの表示を切り替える。
   * - リーグ戦タブは常に表示（無効時はイントロ＝開始ボタンを表示するため）
   * - league.enabled=true  : マッチング/結果入力/成績表 を隠す
   * - league.enabled=false : 通常タブをすべて表示
   * 選手管理タブは両モード共通で常に表示。
   */
  applyLeagueMode() {
    const enabled = !!(AppStorage.getLeague() || {}).enabled;
    const tournamentTabs = ['matching', 'results', 'standings'];
    tournamentTabs.forEach(t => {
      const btn = document.getElementById(`tab-btn-${t}`);
      if (btn) btn.classList.toggle('hidden', enabled);
    });
    // リーグ戦タブは常に見えるようにする（モード開始の入口を兼ねる）
    const leagueBtn = document.getElementById('tab-btn-league');
    if (leagueBtn) leagueBtn.classList.remove('hidden');

    // リーグ戦モードではランクを使わないため、選手登録フォームの
    // ランク欄を隠す（hidden な required はフォーム送信を妨げるため
    // required も外す）
    // レーティングモードではランク欄の代わりにレーティング欄を出す
    const ratingMode   = this.isRatingMode();
    const hideRank     = enabled || ratingMode;
    const rankGroup    = document.getElementById('player-rank-group');
    const rankSelect   = document.getElementById('player-rank');
    const ratingGroup  = document.getElementById('player-rating-group');
    const ratingInput  = document.getElementById('player-rating');
    if (rankGroup)  rankGroup.classList.toggle('hidden', hideRank);
    if (rankSelect) {
      if (hideRank) rankSelect.removeAttribute('required');
      else          rankSelect.setAttribute('required', '');
    }
    if (ratingGroup) ratingGroup.classList.toggle('hidden', !ratingMode);
    if (ratingInput) {
      if (ratingMode) ratingInput.setAttribute('required', '');
      else            ratingInput.removeAttribute('required');
    }

    // 強さの入力方式の切り替え（リーグ戦ではランクを使わないため非表示）
    const modeBar = document.getElementById('strength-mode-bar');
    if (modeBar) {
      modeBar.classList.toggle('hidden', enabled);
      modeBar.querySelectorAll('.sort-chip').forEach(chip => {
        const active = chip.dataset.mode === (ratingMode ? 'rating' : 'rank');
        chip.classList.toggle('active', active);
        chip.setAttribute('aria-pressed', active);
      });
    }

    // マッチング設定・表示項目の文言
    const rankLabel = document.getElementById('rank-balance-label');
    if (rankLabel) {
      rankLabel.textContent = ratingMode
        ? '対戦相手の強さの散らばり（上位〜下位をまんべんなく）'
        : '対戦相手のランク帯の均等化';
    }
    document.getElementById('mean-balance-group')?.classList.toggle('hidden', !ratingMode);
    document.getElementById('rating-update-btn')?.classList.toggle('hidden', !ratingMode);

    // 部にひも付いた部屋：ヘッダーに部の名前、選手管理に「名簿から追加」
    const club = AppStorage.getRoomClub();
    const clubEl = document.getElementById('room-club-display');
    if (clubEl) {
      clubEl.classList.toggle('hidden', !club);
      clubEl.textContent = club ? `部: ${club.name}` : '';
      clubEl.title = club ? '名簿を開く' : '';
    }
    document.getElementById('add-from-roster-btn')?.classList.toggle('hidden', !club);
    document.getElementById('fill-initial-ratings-btn')?.classList.toggle('hidden', !ratingMode);
    document.querySelectorAll('.display-chip[data-key="rank"]').forEach(chip => {
      chip.textContent = ratingMode ? 'レーティング' : 'ランク';
    });

    // リーグ有効化でトーナメントタブが隠れた場合、そのタブにいたらリーグ戦へ退避
    const activePanel = document.querySelector('.tab-panel.active');
    const activeId = activePanel ? activePanel.id.replace('tab-', '') : 'players';
    if (enabled && tournamentTabs.includes(activeId)) {
      this.showTab('league');
    }
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
    if (tabId === 'league' && typeof League !== 'undefined') League.render();
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

    // 強さの入力方式（ランク／レーティング）の切り替え。部屋ごとに保存・同期される
    document.querySelectorAll('#strength-mode-bar .sort-chip').forEach(chip => {
      chip.addEventListener('click', () => this.setStrengthMode(chip.dataset.mode));
    });
    document.getElementById('fill-initial-ratings-btn').addEventListener('click', () => this.fillInitialRatings());
  },

  setStrengthMode(mode) {
    const next = mode === 'rating' ? 'rating' : 'rank';
    if ((AppStorage.getSettings().strengthMode || 'rank') === next) return;
    AppStorage.updateSettings({ strengthMode: next });
    this.applyLeagueMode();
    this.renderAll();
    if (next === 'rating') {
      const missing = AppStorage.getPlayers().filter(p => Matching.hasNoRating(p)).length;
      this.showToast(missing > 0
        ? `レーティングモードにしました。${missing}人のレーティングが未入力です`
        : 'レーティングモードにしました', 'info');
    } else {
      this.showToast('ランクモードにしました', 'info');
    }
  },

  handlePlayerSubmit() {
    const name = document.getElementById('player-name').value.trim();
    const grade = parseInt(document.getElementById('player-grade').value);

    // リーグ戦モードではランクを使わない。
    // 編集時は既存ランクを保持、新規はプレースホルダ 'C'。
    const leagueMode = !!(AppStorage.getLeague() || {}).enabled;
    let rank;
    if (leagueMode) {
      rank = this.editingPlayerId
        ? (AppStorage.getPlayers().find(p => p.id === this.editingPlayerId)?.rank || 'C')
        : 'C';
    } else if (this.isRatingMode()) {
      // レーティングモードではランクを入力しない。編集時は既存ランクを保持
      rank = this.editingPlayerId
        ? (AppStorage.getPlayers().find(p => p.id === this.editingPlayerId)?.rank || 'C')
        : 'C';
    } else {
      rank = document.getElementById('player-rank').value;
    }

    if (!name) {
      this.showToast('名前を入力してください', 'error');
      return;
    }

    const updates = { name, grade, rank };
    if (this.isRatingMode()) {
      const raw = document.getElementById('player-rating').value.trim();
      const rating = Number(raw);
      if (raw === '' || !Number.isFinite(rating) || rating < -99999 || rating > 99999) {
        this.showToast('レーティングを数値で入力してください', 'error');
        return;
      }
      updates.rating = rating;
    }

    if (this.editingPlayerId) {
      AppStorage.updatePlayer(this.editingPlayerId, updates);
      this.showToast(`${name} を更新しました`, 'success');
    } else {
      AppStorage.addPlayer(updates);
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
    document.getElementById('player-rating').value = Matching.hasNoRating(player) ? '' : player.rating;
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

    // 対戦表に入っている選手を削除すると、対戦相手の成績からもその対局が消えてしまう。
    // そのため削除ではなく「途中棄権」にする
    if (this._appearsInRounds(id, AppStorage.getRounds())) {
      this.withdrawPlayer(id);
      return;
    }

    if (confirm(`${player.name} を削除しますか？`)) {
      AppStorage.createSnapshot(`${player.name} を削除する前`);
      AppStorage.deletePlayer(id);
      this.showToast(`${player.name} を削除しました`, 'info');
      this.renderPlayers();
    }
  },

  _appearsInRounds(id, rounds) {
    return rounds.some(r => r.byePlayerId === id
      || r.matches.some(m => m.player1Id === id || m.player2Id === id));
  },

  /** 途中棄権：過去の対局と相手の成績は残し、以後の対戦表から外す */
  withdrawPlayer(id) {
    const player = AppStorage.getPlayers().find(p => p.id === id);
    if (!player || player.withdrawn) return;
    const msg = `${player.name} は対戦表に入っているため、削除ではなく「途中棄権」にします。\n\n`
      + '・過去の対局と、対戦相手の成績はそのまま残ります\n'
      + '・以後の対戦表からは外れます\n\n'
      + '途中棄権にしますか？';
    if (!confirm(msg)) return;

    AppStorage.createSnapshot(`${player.name} を途中棄権にする前`);
    AppStorage.updatePlayer(id, { withdrawn: true });
    this._rebuildRoundsWithout(player);
    this.renderAll();
  },

  reinstatePlayer(id) {
    const player = AppStorage.getPlayers().find(p => p.id === id);
    if (!player || !player.withdrawn) return;
    if (!confirm(`${player.name} の途中棄権を取り消しますか？\n（すでに組まれている回戦には入りません。対戦表を作り直すか、手動編集で追加してください）`)) return;
    AppStorage.updatePlayer(id, { withdrawn: false });
    this.renderAll();
    this.showToast(`${player.name} の途中棄権を取り消しました`, 'info');
  },

  /**
   * 結果をまだ入力していない回戦に棄権した選手が入っていれば、その回戦以降を組み直す。
   * 結果入力済み（または確定済み）の最後の回戦までは、そのまま残す。
   */
  _rebuildRoundsWithout(player) {
    const rounds = AppStorage.getRounds();
    let keep = 0;
    rounds.forEach((r, i) => { if (r.confirmed || r.matches.some(m => m.result)) keep = i + 1; });
    const future = rounds.slice(keep);
    if (!this._appearsInRounds(player.id, future)) {
      this.showToast(`${player.name} を途中棄権にしました`, 'info');
      return;
    }

    const from = future[0].roundNumber;
    const ask = `第${from}回戦以降（結果が未入力の${future.length}回戦）に ${player.name} が入っています。\n`
      + `これらの回戦を、${player.name} を除いて組み直しますか？\n\n`
      + '（組み直さない場合は、手動編集で調整してください）';
    if (!confirm(ask)) {
      this.showToast(`${player.name} を途中棄権にしました`, 'info');
      return;
    }

    const settings   = AppStorage.getSettings();
    const allPlayers = AppStorage.getPlayers();
    const active     = allPlayers.filter(p => !p.withdrawn);
    const fixed      = rounds.slice(0, keep);
    const opts = {
      gradeAvoidLevel:  settings.gradeAvoidLevel  ?? 2,
      rankBalanceLevel: settings.rankBalanceLevel ?? 2,
      meanBalanceLevel: settings.meanBalanceLevel ?? 2,
      assignSenteGote:  settings.assignSenteGote  ?? true,
      strengthMode:     this.isRatingMode() ? 'rating' : 'rank',
      numRounds:        rounds.length,
      allPlayers,
    };

    let newRounds;
    if ((settings.matchingFormat || 'random') === 'swiss') {
      // スイスドローは成績に応じて次の1回戦だけを組む
      const res = Matching.generateNextSwissRound(active, fixed, opts);
      if (res.error) { this.showToast(res.error, 'error'); return; }
      newRounds = [res.round];
    } else {
      const res = Matching.generateAllRounds(active, rounds.length, { ...opts, fixedRounds: fixed });
      if (res.error) { this.showToast(res.error, 'error'); return; }
      newRounds = res.rounds;
    }

    AppStorage.saveRounds([...fixed, ...newRounds]);
    this.showToast(`${player.name} を途中棄権にし、第${from}回戦以降を組み直しました`, 'success');
  },

  playerSortKey: (() => {
    try { return localStorage.getItem('shogi_player_sort') === 'rank' ? 'rank' : 'grade'; }
    catch { return 'grade'; }
  })(),

  setPlayerSort(key) {
    this.playerSortKey = key;
    try { localStorage.setItem('shogi_player_sort', key); } catch {}
    this.renderPlayers();
  },

  renderPlayers() {
    const players = AppStorage.getPlayers();
    const rounds  = AppStorage.getRounds();
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

    // リーグ戦モードではランクを使わない
    const leagueMode = !!(AppStorage.getLeague() || {}).enabled;

    const ratingMode = this.isRatingMode();
    const strengthLabel = ratingMode ? 'レーティング' : 'ランク';

    // 並び順：学年順（学年→強さ）／ランク順・レーティング順（強さ→学年）。リーグ戦モードは学年順のみ
    const sortKey = leagueMode ? 'grade' : this.playerSortKey;
    const rankOrder = { S: 0, A: 1, B: 2, C: 3 };
    const ratingValue = p => Matching.hasNoRating(p) ? -Infinity : Number(p.rating);
    const byGrade = (a, b) => a.grade - b.grade;
    const byRank  = ratingMode
      ? (a, b) => ratingValue(b) - ratingValue(a) || 0
      : (a, b) => (rankOrder[a.rank] ?? 9) - (rankOrder[b.rank] ?? 9);
    const [first, second] = sortKey === 'rank' ? [byRank, byGrade] : [byGrade, byRank];
    const sorted = [...players].sort((a, b) =>
      first(a, b) || second(a, b) || a.name.localeCompare(b.name, 'ja'));

    container.innerHTML = `
      ${leagueMode ? '' : `
      <div class="display-opts-bar">
        <span class="display-opts-label">並び順</span>
        ${[['grade', '学年順'], ['rank', `${strengthLabel}順`]].map(([key, label]) => `
          <button type="button" class="sort-chip${sortKey === key ? ' active' : ''}"
            aria-pressed="${sortKey === key}" onclick="UI.setPlayerSort('${key}')">${label}</button>`).join('')}
      </div>`}
      <div class="player-table-wrapper">
        <table class="player-table">
          <thead>
            <tr>
              <th>名前</th>
              <th>学年</th>
              ${leagueMode ? '' : `<th>${strengthLabel}</th>`}
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${sorted.map(p => `
              <tr class="${p.withdrawn ? 'player-withdrawn' : ''}">
                <td class="player-name-cell">${this.escapeHtml(p.name)}${p.withdrawn ? ' <span class="withdrawn-badge">棄権</span>' : ''}</td>
                <td>${p.grade}年</td>
                ${leagueMode ? '' : ratingMode
                  ? `<td>${Matching.hasNoRating(p)
                      ? '<span class="rating-missing">未入力</span>'
                      : `<span class="rating-badge">${this.escapeHtml(this.formatRating(p.rating))}</span>`}</td>`
                  : `<td><span class="rank-badge rank-${p.rank}">${p.rank}</span></td>`}
                <td class="actions-cell">
                  <button class="btn-icon btn-edit" onclick="UI.editPlayer('${p.id}')" title="編集">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                  </button>
                  ${p.withdrawn ? `
                  <button class="btn-icon btn-reinstate" onclick="UI.reinstatePlayer('${p.id}')" title="途中棄権を取り消す">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                  </button>` : `
                  <button class="btn-icon btn-delete" onclick="UI.deletePlayer('${p.id}')" title="${this._appearsInRounds(p.id, rounds) ? '途中棄権にする' : '削除'}">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                  </button>`}
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
        ${leagueMode ? '' : ratingMode ? this._ratingStatsHtml(players) : `
        <div class="stat-group">
          <span class="stat-label">ランク分布:</span>
          ${Object.entries(rankStats).filter(([,c]) => c > 0).map(([r, c]) => `<span class="stat-chip rank-${r}">${r}: ${c}人</span>`).join('')}
        </div>`}
      </div>`;

    container.innerHTML += statsHtml;
  },

  _ratingStatsHtml(players) {
    const rated   = players.filter(p => !Matching.hasNoRating(p)).map(p => Number(p.rating));
    const missing = players.length - rated.length;
    const chips = [];
    if (rated.length > 0) {
      const avg = rated.reduce((a, b) => a + b, 0) / rated.length;
      chips.push(`<span class="stat-chip">平均 ${this.formatRating(avg)}</span>`);
      chips.push(`<span class="stat-chip">最高 ${this.formatRating(Math.max(...rated))}</span>`);
      chips.push(`<span class="stat-chip">最低 ${this.formatRating(Math.min(...rated))}</span>`);
    }
    if (missing > 0) chips.push(`<span class="stat-chip rating-missing-chip">未入力 ${missing}人</span>`);
    return `
        <div class="stat-group">
          <span class="stat-label">レーティング:</span>
          ${chips.join('')}
        </div>`;
  },

  // ============================================
  // マッチング
  // ============================================

  bindMatchingEvents() {
    document.getElementById('generate-btn').addEventListener('click', () => {
      if (this.editMode) this.exitEditMode(true);
      this.generateMatching();
    });

    // セグメントコントロール（先後割り当て・対戦相手の学年/ランク帯の均等化）
    ['sente-gote', 'grade-avoid', 'rank-balance', 'mean-balance'].forEach(id => {
      document.querySelectorAll(`#${id}-segment .wseg-btn`).forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll(`#${id}-segment .wseg-btn`)
            .forEach(b => b.classList.remove('wseg-active'));
          btn.classList.add('wseg-active');
          document.getElementById(`${id}-weight`).value = btn.dataset.value;
        });
      });
    });

    document.getElementById('matching-format').addEventListener('change', () => {
      this.updateGenerateButton();
    });

    document.getElementById('clear-rounds-btn').addEventListener('click', () => {
      if (confirm('生成された対戦表をすべてクリアしますか？結果も失われます。\n（ヘッダーの「↩ 元に戻す」から復元できます）')) {
        if (this.editMode) this.exitEditMode(true);
        AppStorage.createSnapshot('対戦表をクリアする前');
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
      const assignSenteGote = parseInt(document.getElementById('sente-gote-weight').value) === 1;
      PDF.exportMatchTable(rounds, players, {
        ...this.displayOpts,
        ratingMode: this.isRatingMode(),
        assignSenteGote,
      });
    });
  },

  generateMatching() {
    // 途中棄権した選手は対戦表に入れない
    const allPlayers     = AppStorage.getPlayers();
    const players        = allPlayers.filter(p => !p.withdrawn);
    const numRounds        = parseInt(document.getElementById('num-rounds').value);
    const gradeAvoidLevel  = parseInt(document.getElementById('grade-avoid-weight').value);
    const rankBalanceLevel = parseInt(document.getElementById('rank-balance-weight').value);
    const meanBalanceLevel = parseInt(document.getElementById('mean-balance-weight').value);
    const matchingFormat   = document.getElementById('matching-format').value;
    const assignSenteGote  = parseInt(document.getElementById('sente-gote-weight').value) === 1;

    if (players.length < 2) {
      this.showToast('最低2人の選手が必要です', 'error');
      return;
    }

    // ランダム方式は全回戦を作り直すため、入力済みの結果が消える
    if (matchingFormat !== 'swiss') {
      const existing = AppStorage.getRounds();
      const entered  = existing.reduce((n, r) => n + r.matches.filter(m => m.result).length, 0);
      if (entered > 0) {
        if (!confirm(`入力済みの結果が${entered}件あります。対戦表を作り直すと、すべて消えます。\n作り直しますか？（ヘッダーの「↩ 元に戻す」から復元できます）`)) return;
      }
      if (existing.length > 0) AppStorage.createSnapshot('対戦表を作り直す前');
    }

    const btn = document.getElementById('generate-btn');
    btn.textContent = '生成中...';
    btn.disabled = true;

    setTimeout(() => {
      const settings = AppStorage.getSettings();
      const strengthMode = this.isRatingMode() ? 'rating' : 'rank';
      const opts = { gradeAvoidLevel, rankBalanceLevel, meanBalanceLevel, strengthMode, assignSenteGote, numRounds, allPlayers };

      if (matchingFormat === 'swiss') {
        this._generateSwissRound(players, numRounds, opts);
      } else {
        this._generateAllRoundsRandom(players, numRounds, opts);
      }

      AppStorage.updateSettings({ numRounds, gradeAvoidLevel, rankBalanceLevel, meanBalanceLevel, matchingFormat, assignSenteGote });
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

    // 既存の回戦（他の端末が入力した結果を含む）には触れず、新しい回戦だけ保存
    AppStorage.appendRound(result.round);
    const updatedRounds = [...existingRounds, result.round];

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
    AppStorage.createSnapshot('手動編集の前');
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

    const ratingMode = this.isRatingMode();
    let html = this.editMode ? ''
      : ratingMode ? this.renderOpponentStrengthStats(rounds, players)
      : this.renderRankMatchupStats(rounds, playerMap);
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
                const playerBtn = (side, id, name, grade, rank) => `
                  <button type="button"
                    class="edit-player-btn${(side === 'player1' ? isSel1 : isSel2) ? ' edit-selected' : ''}"
                    onclick="UI.selectPlayerForSwap(${ri}, ${i}, '${side}')">
                    <span class="edit-player-name">${this.escapeHtml(name)}</span>
                    ${showGrade ? `<span class="edit-player-meta">${grade}年</span>` : ''}
                    ${showRank  ? this.strengthBadgeHtml(id, rank, playerMap, ratingMode) : ''}
                  </button>`;
                return `
                  <div class="match-card editing-card">
                    <div class="match-number">${i + 1}</div>
                    ${playerBtn('player1', match.player1Id, match.player1Name, match.player1Grade, match.player1Rank)}
                    <button type="button" class="swap-btn" onclick="UI.swapSenteGote(${ri}, ${i})" title="先後交代">⇄</button>
                    ${playerBtn('player2', match.player2Id, match.player2Name, match.player2Grade, match.player2Rank)}
                  </div>`;
              }

              // ---- 通常表示 ----
              const resultClass   = match.result ? 'has-result' : '';
              const showSenteGote = parseInt(document.getElementById('sente-gote-weight')?.value ?? '1') === 1;
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
                      ${showRank  ? this.strengthBadgeHtml(match.player1Id, match.player1Rank, playerMap, ratingMode) : ''}
                    </span>
                  </div>
                  <div class="match-vs">VS</div>
                  <div class="match-player player2 ${match.result === 'player2' ? 'winner' : match.result === 'player1' ? 'loser' : ''}">
                    ${p2label}
                    <span class="player-info">
                      <span class="player-name-text">${this.escapeHtml(match.player2Name)}</span>
                      ${showGrade ? `<span class="player-grade-text">${match.player2Grade}年</span>` : ''}
                      ${showRank  ? this.strengthBadgeHtml(match.player2Id, match.player2Rank, playerMap, ratingMode) : ''}
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

  /**
   * ランク帯別の対戦回数（平均）
   * 選択したランク帯の選手1人あたり、各ランク帯の相手と平均何回当たるかを表示する。
   * 「均等なら」は相手を全員から均等に選んだ場合の期待値（自分を除く人数比 × 対局数）。
   */
  rankStatsView: null,
  rankStatsOpen: true,

  renderRankMatchupStats(rounds, playerMap) {
    const RANKS = Matching.RANKS;
    const rankOf = (id, fallback) => playerMap[id]?.rank || fallback;

    // 選手ごとの対戦相手ランク内訳
    const perPlayer = {};
    Object.values(playerMap).forEach(p => {
      perPlayer[p.id] = { rank: p.rank, games: 0, vs: { S: 0, A: 0, B: 0, C: 0 } };
    });
    rounds.forEach(round => round.matches.forEach(m => {
      const r1 = rankOf(m.player1Id, m.player1Rank);
      const r2 = rankOf(m.player2Id, m.player2Rank);
      const s1 = perPlayer[m.player1Id];
      const s2 = perPlayer[m.player2Id];
      if (s1 && r2 in s1.vs) { s1.vs[r2]++; s1.games++; }
      if (s2 && r1 in s2.vs) { s2.vs[r1]++; s2.games++; }
    }));

    const counts = { S: 0, A: 0, B: 0, C: 0 };
    Object.values(perPlayer).forEach(s => { if (s.rank in counts) counts[s.rank]++; });
    const available = RANKS.filter(r => counts[r] > 0);
    if (available.length === 0) return '';
    if (!available.includes(this.rankStatsView)) this.rankStatsView = available[0];
    const view = this.rankStatsView;

    const members = Object.values(perPlayer).filter(s => s.rank === view);
    const total   = Object.values(counts).reduce((a, b) => a + b, 0);
    const fmt = n => (Math.round(n * 10) / 10).toFixed(1);

    const rows = RANKS.filter(r => counts[r] > 0).map(r => {
      const vals = members.map(s => s.vs[r]);
      const avg  = vals.reduce((a, b) => a + b, 0) / members.length;
      const min  = Math.min(...vals);
      const max  = Math.max(...vals);
      const others   = counts[r] - (r === view ? 1 : 0);
      const expected = total > 1
        ? members.reduce((a, s) => a + s.games * others / (total - 1), 0) / members.length
        : 0;
      return { r, avg, min, max, expected };
    });
    const maxAvg = Math.max(...rows.map(x => Math.max(x.avg, x.expected)), 0.0001);
    const avgGames = members.reduce((a, s) => a + s.games, 0) / members.length;

    return `
      <details class="card rank-stats" ${this.rankStatsOpen ? 'open' : ''}
        ontoggle="UI.rankStatsOpen = this.open">
        <summary class="rank-stats-summary">
          <span class="icon">📊</span> ランク帯別の対戦回数（平均）
        </summary>
        <div class="rank-stats-body">
          <div class="rank-stats-views" role="tablist" aria-label="目線のランク帯">
            <span class="rank-stats-views-label">目線</span>
            ${available.map(r => `
              <button type="button" role="tab" aria-selected="${r === view}"
                class="rank-stats-view-btn${r === view ? ' active' : ''}"
                onclick="UI.setRankStatsView('${r}')">
                <span class="rank-badge rank-${r}">${r}</span>
                <span class="rank-stats-view-count">${counts[r]}人</span>
              </button>`).join('')}
          </div>
          <p class="rank-stats-caption">
            <strong>${view}</strong> の選手1人あたり（平均 ${fmt(avgGames)} 局）が、各ランク帯と何回当たるか
          </p>
          <div class="rank-stats-rows">
            ${rows.map(x => `
              <div class="rank-stats-row">
                <span class="rank-badge rank-${x.r}">${x.r}</span>
                <div class="rank-stats-bar-track">
                  <div class="rank-stats-bar rank-${x.r}" style="width:${(x.avg / maxAvg * 100).toFixed(1)}%"></div>
                  <div class="rank-stats-expected" style="left:${(x.expected / maxAvg * 100).toFixed(1)}%" title="均等なら ${fmt(x.expected)} 回"></div>
                </div>
                <span class="rank-stats-avg">${fmt(x.avg)}<small>回</small></span>
                <span class="rank-stats-range">${x.min === x.max ? `全員 ${x.min}回` : `${x.min}〜${x.max}回`}・均等なら ${fmt(x.expected)}</span>
              </div>`).join('')}
          </div>
          <p class="rank-stats-note">縦線は、相手を全員から均等に選んだ場合の目安です。</p>
        </div>
      </details>`;
  },

  /**
   * 対戦相手の強さ（レーティングモード）
   * 選手ごとに、対戦相手の平均レーティングと目安（自分以外の全員の平均）との差を表示する。
   */
  renderOpponentStrengthStats(rounds, players) {
    const rated = players.filter(p => !Matching.hasNoRating(p));
    if (rated.length < 2) return '';
    const rating = {};
    rated.forEach(p => { rating[p.id] = Number(p.rating); });
    const total = rated.reduce((a, p) => a + rating[p.id], 0);

    const sum = {}, games = {};
    rated.forEach(p => { sum[p.id] = 0; games[p.id] = 0; });
    rounds.forEach(round => round.matches.forEach(m => {
      if (!(m.player1Id in rating) || !(m.player2Id in rating)) return;
      sum[m.player1Id] += rating[m.player2Id]; games[m.player1Id]++;
      sum[m.player2Id] += rating[m.player1Id]; games[m.player2Id]++;
    }));

    const rows = rated
      .map(p => {
        const target = (total - rating[p.id]) / (rated.length - 1);
        const avg    = games[p.id] > 0 ? sum[p.id] / games[p.id] : null;
        return { p, games: games[p.id], avg, target, diff: avg == null ? null : avg - target };
      })
      .sort((a, b) => rating[b.p.id] - rating[a.p.id]);

    const diffs = rows.filter(r => r.diff != null).map(r => r.diff);
    const rms   = diffs.length > 0 ? Math.sqrt(diffs.reduce((a, d) => a + d * d, 0) / diffs.length) : 0;
    const fmt   = n => this.formatRating(n);
    const fmtDiff = d => `${d >= 0 ? '+' : '−'}${fmt(Math.abs(d))}`;

    return `
      <details class="card rank-stats" ${this.rankStatsOpen ? 'open' : ''}
        ontoggle="UI.rankStatsOpen = this.open">
        <summary class="rank-stats-summary">
          <span class="icon">📊</span> 対戦相手の強さ（平均レーティング）
        </summary>
        <div class="rank-stats-body">
          <p class="rank-stats-caption">
            目安との差の大きさ（全員の二乗平均）: <strong>${fmt(rms)}</strong>　小さいほど全員の対戦相手の強さがそろっています
          </p>
          <div class="opp-strength-table-wrapper">
            <table class="opp-strength-table">
              <thead>
                <tr><th>選手</th><th>レート</th><th>対局</th><th>相手の平均</th><th>目安</th><th>差</th></tr>
              </thead>
              <tbody>
                ${rows.map(r => `
                  <tr>
                    <td class="opp-name">${this.escapeHtml(r.p.name)}</td>
                    <td>${fmt(rating[r.p.id])}</td>
                    <td>${r.games}</td>
                    <td>${r.avg == null ? '—' : fmt(r.avg)}</td>
                    <td class="opp-muted">${fmt(r.target)}</td>
                    <td class="${r.diff == null ? '' : r.diff >= 0 ? 'opp-diff-up' : 'opp-diff-down'}">${r.diff == null ? '—' : fmtDiff(r.diff)}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
          <p class="rank-stats-note">目安は、相手を自分以外の全員から均等に選んだ場合の平均です。差が＋なら目安より強い相手、−なら弱い相手と多く当たっています。</p>
        </div>
      </details>`;
  },

  setRankStatsView(rank) {
    this.rankStatsView = rank;
    this.renderMatchingResult();
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
    const ratingMode = this.isRatingMode();

    // ヒント文を「先後あり/なし」で切り替え
    const showSenteGote = parseInt(document.getElementById('sente-gote-weight')?.value ?? '1') === 1;
    const hintEl = document.getElementById('results-hint');
    if (hintEl) {
      hintEl.innerHTML = showSenteGote
        ? '各対局の結果を入力してください。左側の <strong>○</strong> は先手（左）の勝ち、右側の <strong>○</strong> は後手（右）の勝ち、<strong>△</strong> は引き分けです。'
        : '各対局の結果を入力してください。左側の <strong>○</strong> は左側の選手の勝ち、右側の <strong>○</strong> は右側の選手の勝ち、<strong>△</strong> は引き分けです。';
    }

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
              const strengthText = (id, rank) => ratingMode
                ? this.escapeHtml(this.formatRating(playerMap[id]?.rating))
                : rank;
              const p1meta = [
                showGrade ? `${match.player1Grade}年` : '',
                showRank  ? strengthText(match.player1Id, match.player1Rank) : ''
              ].filter(Boolean).join(' ');
              const p2meta = [
                showGrade ? `${match.player2Grade}年` : '',
                showRank  ? strengthText(match.player2Id, match.player2Rank) : ''
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
    if (round.rated && !confirm(`第${round.roundNumber}回戦の結果は、すでにレーティングに反映済みです。\n確定を解除して結果を直しても、レーティングは自動では直りません（「↩ 元に戻す」で反映前に戻せます）。\n確定を解除しますか？`)) return;
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
    const indexSummary = Matching.summarizeIndices(standings);
    const showPt = this.standingsOpts.showPoints;
    const fmt1 = v => v == null ? '—' : (Math.round(v * 10) / 10).toFixed(1);
    const indexCell = (value, rank) => rank == null
      ? '<td class="index-cell">—</td>'
      : `<td class="index-cell">${value}<span class="index-rank">${rank}位</span></td>`;

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
              <th title="結果が入力された対局の相手の Pt の合計">ソルコフ</th>
              <th title="ソルコフから自分の敗数を引いた値">ソルコフ−敗数</th>
            </tr>
          </thead>
          <tbody>
            ${standings.map((s, i) => `
              <tr class="${i < 3 ? 'top-' + (i+1) : ''}">
                <td class="position-cell">
                  ${s.position <= 3 ? `<span class="medal medal-${s.position}">${['🥇','🥈','🥉'][s.position-1]}</span>` : s.position}
                </td>
                <td class="name-cell name-cell-link" onclick="UI.showPlayerDetail('${s.id}')">${this.escapeHtml(s.name)}${s.withdrawn ? ' <span class="withdrawn-badge">棄権</span>' : ''} <span class="name-cell-hint">›</span></td>
                <td>${s.grade}年</td>
                <td class="win-cell">${s.wins}</td>
                <td class="loss-cell">${s.losses}</td>
                <td>${s.draws}</td>
                <td>${s.byes}</td>
                <td>${s.winRate.toFixed(1)}%</td>
                ${showPt ? `<td class="points-cell">${s.points}</td>` : ''}
                ${indexCell(s.solkoff, s.solkoffRank)}
                ${indexCell(s.solkoffMinusLosses, s.solkoffMinusLossesRank)}
              </tr>
            `).join('')}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="${showPt ? 9 : 8}" class="index-summary-label">平均 ／ 標準偏差</td>
              <td class="index-cell">${fmt1(indexSummary.solkoff.mean)}<span class="index-rank">σ ${fmt1(indexSummary.solkoff.sd)}</span></td>
              <td class="index-cell">${fmt1(indexSummary.solkoffMinusLosses.mean)}<span class="index-rank">σ ${fmt1(indexSummary.solkoffMinusLosses.sd)}</span></td>
            </tr>
          </tfoot>
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

  // ============================================
  // レーティング（初期値・結果からの更新）
  // ============================================

  /** レーティング未入力の選手に、ランクから初期値を入れる（S=1800 / A=1600 / B=1400 / C=1200） */
  fillInitialRatings() {
    const table   = Matching.INITIAL_RATING_BY_RANK;
    const targets = AppStorage.getPlayers().filter(p => Matching.hasNoRating(p));
    if (targets.length === 0) {
      this.showToast('レーティング未入力の選手はいません', 'info');
      return;
    }
    const msg = `レーティング未入力の${targets.length}人に、ランクから初期値を入れますか？\n\n`
      + `S=${table.S} / A=${table.A} / B=${table.B} / C=${table.C}\n`
      + '（1段階200点差。強いほうの期待勝率が約76%になる差です。入力済みの選手は変更しません）';
    if (!confirm(msg)) return;
    AppStorage.createSnapshot('ランクから初期値を入れる前');
    targets.forEach(p => AppStorage.updatePlayer(p.id, { rating: table[p.rank] ?? table.C }));
    this.renderAll();
    this.showToast(`${targets.length}人にレーティングの初期値を入れました`, 'success');
  },

  showRatingUpdate() {
    const modal = document.getElementById('rating-update-modal');
    if (!modal.dataset.bound) {
      modal.dataset.bound = '1';
      const close = () => modal.classList.add('hidden');
      document.getElementById('rating-update-close').addEventListener('click', close);
      document.getElementById('rating-update-cancel').addEventListener('click', close);
      modal.addEventListener('click', e => { if (e.target === modal) close(); });
      document.querySelectorAll('#rating-k-segment .wseg-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('#rating-k-segment .wseg-btn').forEach(b => b.classList.toggle('wseg-active', b === btn));
          this._renderRatingPreview();
        });
      });
      document.getElementById('rating-update-apply').addEventListener('click', () => this._applyRatingUpdate());
    }
    if (this._renderRatingPreview()) modal.classList.remove('hidden');
  },

  _ratingK() {
    const active = document.querySelector('#rating-k-segment .wseg-active');
    return active ? Number(active.dataset.value) : 32;
  },

  /** プレビューを描画。対象がなければトーストを出して false */
  _renderRatingPreview() {
    const rounds = AppStorage.getRounds();
    const res = Matching.computeRatingUpdate(AppStorage.getPlayers(), rounds, { k: this._ratingK() });
    if (res.error) { this.showToast(res.error, 'error'); return false; }
    if (res.roundNumbers.length === 0 || res.rows.length === 0) {
      const unconfirmed = rounds.filter(r => !r.confirmed).length;
      this.showToast(unconfirmed > 0
        ? 'レーティングに反映できる回戦がありません（結果入力タブで回戦を確定すると反映できます）'
        : 'すべての確定済みの回戦は、すでにレーティングに反映済みです', 'info');
      return false;
    }
    this._ratingPreview = res;

    const nums = res.roundNumbers;
    document.getElementById('rating-update-summary').textContent =
      `確定済みでまだ反映していない第${nums.join('・')}回戦の結果で、${res.rows.length}人のレーティングを更新します。`;
    const fmt = n => (Math.round(n * 10) / 10).toFixed(1);
    const signed = d => (d > 0 ? `+${d}` : d < 0 ? `−${-d}` : '±0');
    document.getElementById('rating-update-table').innerHTML = `
      <thead><tr><th>選手</th><th>現在</th><th>対局</th><th>期待勝数</th><th>実際</th><th>変化</th><th>更新後</th></tr></thead>
      <tbody>${res.rows.map(r => `
        <tr>
          <td class="opp-name">${this.escapeHtml(r.name)}</td>
          <td>${this.escapeHtml(this.formatRating(r.before))}</td>
          <td>${r.games}</td>
          <td class="opp-muted">${fmt(r.expected)}</td>
          <td>${fmt(r.actual)}</td>
          <td class="${r.delta > 0 ? 'opp-diff-up' : r.delta < 0 ? 'opp-diff-down' : ''}">${signed(r.delta)}</td>
          <td><strong>${this.escapeHtml(this.formatRating(r.after))}</strong></td>
        </tr>`).join('')}
      </tbody>`;
    return true;
  },

  _applyRatingUpdate() {
    const res = this._ratingPreview;
    if (!res) return;
    AppStorage.createSnapshot('レーティング更新の前');
    AppStorage.applyRatingUpdate(res.rows, res.roundNumbers);
    this._ratingPreview = null;
    document.getElementById('rating-update-modal').classList.add('hidden');
    this.renderAll();
    this.showToast(`${res.rows.length}人のレーティングを更新しました（第${res.roundNumbers.join('・')}回戦）`, 'success');
  },

  // ============================================
  // 元に戻す（変更履歴）
  // ============================================

  async showHistory() {
    const modal = document.getElementById('history-modal');
    const list  = document.getElementById('history-list');
    if (!modal.dataset.bound) {
      modal.dataset.bound = '1';
      document.getElementById('history-close').addEventListener('click', () => modal.classList.add('hidden'));
      modal.addEventListener('click', e => { if (e.target === modal) modal.classList.add('hidden'); });
    }
    list.innerHTML = '<p class="history-empty">読み込み中...</p>';
    modal.classList.remove('hidden');

    let snapshots;
    try {
      snapshots = await AppStorage.listSnapshots();
    } catch (err) {
      list.innerHTML = `<p class="history-empty">${this.escapeHtml(err.message)}（オフラインの可能性があります）</p>`;
      return;
    }
    if (snapshots.length === 0) {
      list.innerHTML = '<p class="history-empty">まだ保存された状態はありません</p>';
      return;
    }

    this._historySnapshots = snapshots;
    list.innerHTML = snapshots.map((snap, i) => {
      const d = snap.data || {};
      const results = (d.rounds || []).reduce((n, r) => n + (r.matches || []).filter(m => m.result).length, 0);
      const when = new Date(snap.created_at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      return `
        <div class="history-item">
          <div class="history-info">
            <span class="history-label">${this.escapeHtml(snap.label)}</span>
            <span class="history-meta">${this.escapeHtml(when)}・選手${(d.players || []).length}人・${(d.rounds || []).length}回戦・結果${results}件</span>
          </div>
          <button class="btn btn-secondary btn-sm" onclick="UI.restoreHistory(${i})">この状態に戻す</button>
        </div>`;
    }).join('');
  },

  restoreHistory(index) {
    const snap = (this._historySnapshots || [])[index];
    if (!snap) return;
    if (!confirm(`「${snap.label}」の状態に戻しますか？\n今の状態も履歴に保存されるので、あとから戻せます。`)) return;
    if (this.editMode) this.exitEditMode(true);
    AppStorage.restoreSnapshot(snap);
    document.getElementById('history-modal').classList.add('hidden');
    this.applyLeagueMode();
    this.loadSettings();
    this.renderAll();
    this.showToast('以前の状態に戻しました', 'success');
  },

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
    const ratingMode = this.isRatingMode();
    const playerMap  = {};
    players.forEach(p => { playerMap[p.id] = p; });

    // レーティングモード：対戦相手の平均レーティング
    const oppRatings = history
      .filter(h => h.type === 'match' && !Matching.hasNoRating(playerMap[h.opponentId] || {}))
      .map(h => Number(playerMap[h.opponentId].rating));
    const oppAvg = oppRatings.length > 0 ? oppRatings.reduce((a, b) => a + b, 0) / oppRatings.length : null;

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

    // 先後指定なしの場合は「先後」列を非表示
    const showSenteGote = parseInt(document.getElementById('sente-gote-weight')?.value ?? '1') === 1;

    const historyRowsHtml = history.length === 0
      ? '<p class="pd-empty">対戦データがありません</p>'
      : history.map(h => {
          if (h.type === 'bye') return `
            <tr>
              <td class="pd-round">第${h.roundNumber}回戦</td>
              <td ${showSenteGote ? 'colspan="2"' : ''} class="pd-bye-cell">— 空き手合い —</td>
              <td>${resultBadge('bye')}</td>
            </tr>`;
          const sideLabel = showSenteGote
            ? (h.side === 'player1' ? '<span class="pd-side sente">先手</span>' : '<span class="pd-side gote">後手</span>')
            : '';
          return `
            <tr>
              <td class="pd-round">第${h.roundNumber}回戦</td>
              <td class="pd-opponent">
                <span class="pd-opp-name">${this.escapeHtml(h.opponentName)}</span>
                <span class="pd-opp-meta">${h.opponentGrade}年 ${ratingMode
                  ? `<span class="rating-badge">${this.escapeHtml(this.formatRating(playerMap[h.opponentId]?.rating))}</span>`
                  : `<span class="rank-badge rank-${h.opponentRank}" style="font-size:10px;padding:1px 5px;">${h.opponentRank}</span>`}</span>
              </td>
              ${showSenteGote ? `<td>${sideLabel}</td>` : ''}
              <td>${resultBadge(h.result)}</td>
            </tr>`;
        }).join('');

    const totalGames = (stat.wins || 0) + (stat.losses || 0) + (stat.draws || 0);
    const winPct = totalGames > 0 ? ((stat.wins || 0) / totalGames * 100).toFixed(0) : 0;

    // 名簿にひも付いた選手は、部屋をまたいだレーティング履歴を後から読み込む
    if (player.clubPlayerId) {
      AppStorage.listRatingHistory(player.clubPlayerId).then(history => {
        const el = document.getElementById('pd-rating-history');
        if (el) el.innerHTML = this._ratingHistoryHtml(history);
      }).catch(() => {});
    }

    document.getElementById('player-detail-content').innerHTML = `
      <div class="pd-header">
        ${ratingMode
          ? `<span class="rating-badge pd-rank-badge">${this.escapeHtml(this.formatRating(player.rating))}</span>`
          : `<span class="rank-badge rank-${player.rank} pd-rank-badge">${player.rank}</span>`}
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

      ${ratingMode ? (oppAvg != null ? `
      <div class="pd-section">
        <h3 class="pd-section-title">対戦相手の平均レーティング</h3>
        <p class="pd-opp-avg"><strong>${this.escapeHtml(this.formatRating(oppAvg))}</strong>（${oppRatings.length}局）</p>
      </div>` : '') : rankRowHtml ? `
      <div class="pd-section">
        <h3 class="pd-section-title">ランク別戦績</h3>
        <div class="pd-rank-stats">${rankRowHtml}</div>
      </div>` : ''}

      ${player.clubPlayerId ? `
      <div class="pd-section">
        <h3 class="pd-section-title">レーティングの推移（部の名簿）
          <button type="button" class="btn btn-ghost btn-sm pd-career-btn" onclick="UI.showCareer('${player.clubPlayerId}', '${this.escapeHtml(player.name).replace(/'/g, '&#39;')}')">部での通算成績 ›</button></h3>
        <div id="pd-rating-history" class="opp-muted">読み込み中...</div>
      </div>` : ''}

      <div class="pd-section">
        <h3 class="pd-section-title">対戦履歴</h3>
        <table class="pd-history-table">
          <thead>
            <tr><th>回戦</th><th>対戦相手</th>${showSenteGote ? '<th>先後</th>' : ''}<th>結果</th></tr>
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
    if (next.length < 8) {
      this.showToast('新しいパスワードは8文字以上にしてください', 'error');
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
    document.getElementById('rating-update-btn').addEventListener('click', () => this.showRatingUpdate());

    document.getElementById('export-standings-btn').addEventListener('click', () => {
      const players = AppStorage.getPlayers();
      const rounds = AppStorage.getRounds();
      const settings = AppStorage.getSettings();
      if (rounds.length === 0) {
        this.showToast('エクスポートするデータがありません', 'error');
        return;
      }
      const standings = Matching.calculateStandings(players, rounds, true);
      const indexSummary = Matching.summarizeIndices(standings);
      PDF.exportStandings(standings, { showPoints: this.standingsOpts.showPoints, indexSummary });
    });

    document.getElementById('reset-all-btn').addEventListener('click', () => {
      if (confirm('すべてのデータをリセットしますか？\n（ヘッダーの「↩ 元に戻す」から復元できます）')) {
        AppStorage.createSnapshot('全データリセットの前');
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
    this._setSegmentValue('mean-balance', settings.meanBalanceLevel ?? 2);
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
