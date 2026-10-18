/**
 * leagueLogic.js — リーグ戦・通算成績の計算（画面に依存しない純粋な関数）
 *
 * 部内戦管理アプリ（Electron 版）の src/shared/logic から移植。
 *   - 並設リーグ：同じ級（tier）を複数のグループに分ける
 *   - 昇降級の枠：隣り合う級の人数 × 割合
 *   - 次の期の構成：昇降級後の人数からグループ数を決め、成績順にスネーク配分
 *   - 自動再編：目標人数で級を作り直す
 *   - 通算成績：連勝・連敗、先後別、対戦相手別
 */

const LeagueLogic = {
  SIBLING_SUFFIX: ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'],

  /**
   * 合計 total を k グループへ和を保ったまま按分する。余りは上位グループから1ずつ。
   * 例: apportion(5, 2) => [3, 2]、apportion(2, 3) => [1, 1, 0]
   */
  apportion(total, k) {
    if (k <= 0) return [];
    const t = Math.max(0, Math.floor(total));
    const base = Math.floor(t / k);
    const remainder = t % k;
    return Array.from({ length: k }, (_, i) => base + (i < remainder ? 1 : 0));
  },

  /** 人数を1グループの目標人数で割った必要グループ数（最低1） */
  desiredGroupCount(headcount, targetSize) {
    const size = Math.max(1, Math.floor(targetSize));
    if (headcount <= 0) return 1;
    return Math.max(1, Math.ceil(headcount / size));
  },

  /**
   * 次の期のグループ数。自動では増やさない（増やすのは手動の分割のみ）。
   * 人数が減れば必要数まで縮み、いずれ1つに統合される。
   */
  nextGroupCount(current, headcount, targetSize) {
    const cur = Math.max(1, Math.floor(current));
    return Math.min(cur, Math.max(1, this.desiredGroupCount(headcount, targetSize)));
  },

  /**
   * 強い順に並んだ配列を k グループへスネーク（蛇行）配分し、強さを均等に散らす。
   * 例: distributeSnake([1,2,3,4,5,6], 2) => [[1,4,5], [2,3,6]]
   */
  distributeSnake(sorted, k) {
    const groups = Array.from({ length: Math.max(0, k) }, () => []);
    if (k <= 0) return groups;
    let idx = 0;
    let forward = true;
    for (const item of sorted) {
      groups[idx].push(item);
      if (forward) {
        if (idx === k - 1) forward = false; else idx++;
      } else {
        if (idx === 0) forward = true; else idx--;
      }
    }
    return groups;
  },

  /**
   * 並設グループの添字を取り除いた級の名前。
   * 「B級 甲」「B級 2」→「B級」、「B1」「B2」→「B」（数字の直前が空白でなくても外す。ただし名前が空になる場合は外さない）
   */
  stripSiblingSuffix(name) {
    const str = String(name);
    const spaced = str.match(/^(.*?)\s+([甲乙丙丁戊己庚辛壬癸]|\d+)$/);
    if (spaced) return spaced[1];
    const digits = str.match(/^(.*?\D)\d+$/);
    return digits && digits[1].trim() ? digits[1] : str;
  },

  /**
   * 既存のグループ名から名前の付け方を読み取る。
   * 「B1・B2」のように数字で付けていれば 'number'、「B級 甲・B級 乙」なら 'kanji'、判断できなければ null
   */
  siblingStyleOf(names) {
    if (names.length >= 2 && names.every(n => /\s[甲乙丙丁戊己庚辛壬癸]$/.test(n))) return 'kanji';
    if (names.length >= 2 && names.every(n => /\d$/.test(n))) return 'number';
    return null;
  },

  /**
   * 並設グループの既定名。1つなら元の名前。
   * 複数なら style='number' で「B1・B2…」、style='kanji' で「B級 甲・B級 乙…」
   */
  defaultSiblingNames(baseName, k, style = 'kanji') {
    const stripped = this.stripSiblingSuffix(baseName);
    if (k <= 1) return [stripped];
    return Array.from({ length: k }, (_, i) => style === 'number'
      ? `${stripped}${i + 1}`
      : `${stripped} ${i < this.SIBLING_SUFFIX.length ? this.SIBLING_SUFFIX[i] : String(i + 1)}`);
  },

  /**
   * 級の境界ごとの入替人数（割合）。
   * min(上の級の出場者数, 下の級の出場者数) × ratio を四捨五入。最低1人、少ない側の半数まで。
   * @param {number[]} activeByTier 級（上から順）ごとの出場者数
   * @returns {number[]} 境界（上から順、長さ = 級の数 − 1）ごとの人数
   */
  ratioSwapCounts(activeByTier, ratio) {
    const out = [];
    for (let i = 0; i < activeByTier.length - 1; i++) {
      const baseline = Math.min(activeByTier[i], activeByTier[i + 1]);
      let count = Math.round(baseline * ratio);
      if (baseline > 0 && count < 1) count = 1;
      const cap = Math.max(0, Math.floor(baseline / 2));
      if (count > cap) count = cap;
      out.push(count);
    }
    return out;
  },

  /**
   * 同点の判定：順位表で cut 番目（0始まり）の直前と直後が同じ成績か。
   * 昇降級の境目が同点ならプレーオフで決めるため、その範囲の選手を返す。
   * @param {Array} standings 成績順の配列（pts / w / l を持つ）
   * @param {number} cut 境目（上から cut 人が対象）
   * @returns {{ tied: boolean, from: number, to: number }} 同点の範囲 [from, to)
   */
  tieAtCut(standings, cut) {
    if (cut <= 0 || cut >= standings.length) return { tied: false, from: cut, to: cut };
    const same = (a, b) => a.pts === b.pts && a.w === b.w && a.l === b.l;
    if (!same(standings[cut - 1], standings[cut])) return { tied: false, from: cut, to: cut };
    let from = cut - 1;
    while (from > 0 && same(standings[from - 1], standings[cut - 1])) from--;
    let to = cut + 1;
    while (to < standings.length && same(standings[to], standings[cut])) to++;
    return { tied: true, from, to };
  },

  /**
   * 次の期の構成（並設グループ込み）。
   * @param {Array} tiers [{ tier, classIds:[...], baseName, style }]（上から順。style はグループ名の付け方）
   * @param {Object} incomingByTier tier → [{ playerId, finalRank }]（finalRank が小さいほど上位、null は最後）
   * @param {number} targetSize 1グループの目標人数
   * @returns {Array} [{ tier, groups: [{ name, playerIds }] }]
   */
  planNextTermLayout(tiers, incomingByTier, targetSize) {
    return tiers.map(t => {
      const incoming = (incomingByTier[t.tier] || []).slice().sort((a, b) =>
        (a.finalRank ?? Infinity) - (b.finalRank ?? Infinity) || String(a.playerId).localeCompare(String(b.playerId)));
      const groupCount = this.nextGroupCount(t.classIds.length, incoming.length, targetSize);
      const names = this.defaultSiblingNames(t.baseName, groupCount, t.style);
      const groups = this.distributeSnake(incoming.map(m => m.playerId), groupCount);
      return { tier: t.tier, groups: groups.map((ids, g) => ({ name: names[g], playerIds: ids })) };
    });
  },

  /**
   * 総当たり表（円卓法）。奇数人数は仮想の休みを入れて回す。
   * 各対局で「これまで先手が少ない側」を先手（p1）にするので、
   * 各選手の先手回数は (人数−1)/2 の切り捨て〜切り上げに収まる。
   * @returns {Array} [{ round, p1Id, p2Id }]
   */
  roundRobin(playerIds) {
    if (playerIds.length < 2) return [];
    const BYE = '__bye__';
    const ids = [...playerIds];
    if (ids.length % 2 === 1) ids.push(BYE);
    const n = ids.length;
    const sente = new Map(ids.map(id => [id, 0]));
    let arr = [...ids];
    const matches = [];
    for (let r = 0; r < n - 1; r++) {
      for (let i = 0; i < n / 2; i++) {
        const a = arr[i], b = arr[n - 1 - i];
        if (a === BYE || b === BYE) continue;
        const swap = sente.get(b) < sente.get(a) || (sente.get(b) === sente.get(a) && String(b) < String(a));
        const p1 = swap ? b : a, p2 = swap ? a : b;
        sente.set(p1, sente.get(p1) + 1);
        matches.push({ round: r + 1, p1Id: p1, p2Id: p2 });
      }
      arr = [arr[0], arr[n - 1], ...arr.slice(1, n - 1)];
    }

    // 仕上げ：先手が多すぎる選手から少なすぎる選手へ、「先手→後手」の対局をたどる経路を見つけて
    // 経路上の対局の先後をまとめて入れ替える（途中の選手の先手回数は変わらない）。
    // 直接対局していない2人の間でも先手を移せるので、奇数人数でも全員が理想の回数に収まる。
    const lo = Math.floor((playerIds.length - 1) / 2);
    const hi = Math.ceil((playerIds.length - 1) / 2);
    // sources のどれかから goal を満たす選手まで、「先手→後手」の対局をたどって先後を入れ替える。
    // 経路の始点の先手が1つ減り、終点の先手が1つ増える（途中の選手は変わらない）。
    const shift = (sources, isGoal) => {
      const prev = new Map(sources.map(id => [id, null]));
      const queue = [...sources];
      while (queue.length) {
        const u = queue.shift();
        for (const m of matches) {
          if (m.p1Id !== u || prev.has(m.p2Id)) continue;
          prev.set(m.p2Id, m);
          if (!isGoal(m.p2Id)) { queue.push(m.p2Id); continue; }
          const goal = m.p2Id;
          let v = goal;
          while (prev.get(v)) {
            const e = prev.get(v);
            [e.p1Id, e.p2Id] = [e.p2Id, e.p1Id];
            v = e.p2Id;   // 入れ替え後の後手 = 経路の1つ前の選手
          }
          sente.set(v, sente.get(v) - 1);      // v は経路の始点
          sente.set(goal, sente.get(goal) + 1);
          return true;
        }
      }
      return false;
    };
    for (let guard = 0; guard < playerIds.length * playerIds.length; guard++) {
      const over  = playerIds.find(id => sente.get(id) > hi);
      const under = playerIds.find(id => sente.get(id) < lo);
      let moved = false;
      if (over !== undefined) {
        moved = shift([over], id => sente.get(id) + 1 <= hi);
      } else if (under !== undefined) {
        moved = shift(playerIds.filter(id => sente.get(id) - 1 >= lo), id => id === under);
      }
      if (!moved) break;
    }
    return matches;
  },

  /** 自動再編での級の既定名 */
  defaultClassName(rank, total) {
    if (total === 1) return '本戦';
    if (total <= 5) return ['A級', 'B級', 'C級', 'D級', 'E級'][rank - 1];
    return `${rank}組`;
  },

  /**
   * 自動再編：強い順の選手を目標人数で級に分ける（上位の級を厚めに）。
   * @returns {Array} [{ name, playerIds }]（上の級から）
   */
  planAutoRestructure(rankedIds, targetSize) {
    const n = rankedIds.length;
    if (n === 0) return [];
    const count = Math.max(1, Math.ceil(n / Math.max(1, targetSize)));
    const sizes = this.apportion(n, count);
    let cursor = 0;
    return sizes.map((size, i) => {
      const ids = rankedIds.slice(cursor, cursor + size);
      cursor += size;
      return { name: this.defaultClassName(i + 1, count), playerIds: ids };
    });
  },

  /**
   * 連勝・連敗（引き分けでリセット）。timeline は古い順の 'W' | 'L' | 'D'。
   */
  computeStreaks(timeline) {
    let longestWin = 0, longestLose = 0, winRun = 0, loseRun = 0;
    for (const r of timeline) {
      if (r === 'W') { winRun++; loseRun = 0; longestWin = Math.max(longestWin, winRun); }
      else if (r === 'L') { loseRun++; winRun = 0; longestLose = Math.max(longestLose, loseRun); }
      else { winRun = 0; loseRun = 0; }
    }
    return { longestWin, longestLose, currentWin: winRun, currentLose: loseRun };
  },

  _wld() { return { wins: 0, losses: 0, draws: 0, played: 0, winRate: 0 }; },
  _apply(stat, outcome) {
    stat.played++;
    if (outcome === 'W') stat.wins++;
    else if (outcome === 'L') stat.losses++;
    else stat.draws++;
  },
  _finish(stat) {
    // 勝率は引き分けを0.5勝として計算
    stat.winRate = stat.played > 0 ? (stat.wins + stat.draws * 0.5) / stat.played : 0;
    return stat;
  },

  /**
   * 通算成績。games は古い順の [{ outcome: 'W'|'L'|'D', sente: true|false|null, opponentId, opponentName }]
   * sente が null の対局（リーグ戦など先後の記録がないもの）は先後別に含めない。
   */
  careerStats(games) {
    const total = this._wld();
    const asSente = this._wld();
    const asGote = this._wld();
    const opponents = new Map();
    for (const g of games) {
      this._apply(total, g.outcome);
      if (g.sente === true) this._apply(asSente, g.outcome);
      if (g.sente === false) this._apply(asGote, g.outcome);
      const key = g.opponentId || g.opponentName;
      if (!opponents.has(key)) opponents.set(key, { opponentId: g.opponentId, name: g.opponentName, ...this._wld() });
      this._apply(opponents.get(key), g.outcome);
    }
    return {
      total: this._finish(total),
      sente: this._finish(asSente),
      gote:  this._finish(asGote),
      streaks: this.computeStreaks(games.map(g => g.outcome)),
      opponents: [...opponents.values()].map(o => this._finish(o))
        .sort((a, b) => b.played - a.played || b.winRate - a.winRate),
    };
  },
};

if (typeof module !== 'undefined') module.exports = LeagueLogic;
