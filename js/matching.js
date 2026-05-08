/**
 * matching.js — マッチングアルゴリズム
 * 制約付き貪欲法 + バックトラッキングによる対戦組み合わせ生成
 */

const Matching = {
  RANKS: ['S', 'A', 'B', 'C'],

  // 段階別ウェイト（0=無効, 1=低, 2=標準, 3=高, 4=最高）
  // それぞれ「対戦相手の(学年|ランク)分布の偏り」へのペナルティ係数
  GRADE_WEIGHTS:   [0,  5,  15,  40,  100],
  RANK_WEIGHTS:    [0,  5,  15,  40,  100],

  /**
   * 全ラウンドの対戦組み合わせを生成
   * @param {Array} players - プレイヤー配列
   * @param {number} numRounds - ラウンド数
   * @returns {Array|null} ラウンド配列 or null（生成不可）
   */
  generateAllRounds(players, numRounds, options = {}) {
    const gradeLevel      = options.gradeBalanceLevel ?? options.gradeAvoidLevel ?? 2;
    const rankLevel       = options.rankBalanceLevel ?? 2;
    const gradeWeight     = this.GRADE_WEIGHTS[gradeLevel] ?? 15;
    const rankWeight      = this.RANK_WEIGHTS[rankLevel]   ?? 15;
    const assignSenteGote = options.assignSenteGote ?? true;

    if (players.length < 2) {
      return { error: 'プレイヤーが2人以上必要です。' };
    }
    if (numRounds > players.length - 1) {
      return {
        error: `${players.length}人の場合、最大${players.length - 1}回戦までです（現在: ${numRounds}回戦）。`
      };
    }

    const matchHistory = new Set();
    const rankHistory  = {};
    const gradeHistory = {};
    const byeCounts    = {};
    const senteHistory = {};

    players.forEach(p => {
      rankHistory[p.id]  = { S: 0, A: 0, B: 0, C: 0 };
      gradeHistory[p.id] = {};
      byeCounts[p.id]    = 0;
      senteHistory[p.id] = 0;
    });

    const allRounds = [];
    const maxRetries = 50;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      matchHistory.clear();
      players.forEach(p => {
        rankHistory[p.id]  = { S: 0, A: 0, B: 0, C: 0 };
        gradeHistory[p.id] = {};
        byeCounts[p.id]    = 0;
        senteHistory[p.id] = 0;
      });
      allRounds.length = 0;

      let success = true;

      for (let round = 0; round < numRounds; round++) {
        const result = this.generateSingleRound(
          players, matchHistory, rankHistory, gradeHistory, byeCounts, round, gradeWeight, rankWeight
        );

        if (!result) { success = false; break; }

        // 先後割り当て：今ラウンドの BYE 決定を反映した byeCounts を渡し、
        // 不戦勝のある選手の目標 (floor((numRounds-bye)/2)) に近づくよう
        // 重み付き貪欲で初期割り当て。最終最適化は全ラウンド生成後に行う。
        if (assignSenteGote) {
          const effectiveByeCounts = { ...byeCounts };
          if (result.byePlayerId) effectiveByeCounts[result.byePlayerId] = (effectiveByeCounts[result.byePlayerId] ?? 0) + 1;
          result.matches = this._assignSenteGote(result.matches, senteHistory, effectiveByeCounts, numRounds);
        }

        allRounds.push(result);

        // 履歴更新
        result.matches.forEach(match => {
          matchHistory.add(this.makeMatchKey(match.player1Id, match.player2Id));
          const p1 = players.find(p => p.id === match.player1Id);
          const p2 = players.find(p => p.id === match.player2Id);
          if (p1 && p2) {
            rankHistory[p1.id][p2.rank]++;
            rankHistory[p2.id][p1.rank]++;
            gradeHistory[p1.id][p2.grade] = (gradeHistory[p1.id][p2.grade] ?? 0) + 1;
            gradeHistory[p2.id][p1.grade] = (gradeHistory[p2.id][p1.grade] ?? 0) + 1;
          }
          if (assignSenteGote) senteHistory[match.player1Id]++;
        });

        if (result.byePlayerId) byeCounts[result.byePlayerId]++;
      }

      if (success) {
        // 全ラウンド生成後の最終パス：不戦勝のある選手の先後カウントを
        // 「先手 floor(playedGames/2) 回」に揃える。
        // 例：6回戦・1回不戦勝 → 5局のうち先手2回・後手3回。
        // この目標は不戦勝のない選手の均等化よりも優先される（重み付け）。
        if (assignSenteGote) {
          this._optimizeSenteGote(allRounds, players, byeCounts, numRounds);
        }
        return { rounds: allRounds };
      }
    }

    return { error: 'マッチングの生成に失敗しました。プレイヤー数とラウンド数の組み合わせを見直してください。' };
  },

  /**
   * 既存ラウンドから対戦・ランク履歴を再構築
   */
  buildHistoryFromRounds(players, rounds) {
    const matchHistory = new Set();
    const rankHistory  = {};
    const gradeHistory = {};
    const byeCounts    = {};
    const senteHistory = {};  // 各選手の先手回数
    players.forEach(p => {
      rankHistory[p.id]  = { S: 0, A: 0, B: 0, C: 0 };
      gradeHistory[p.id] = {};
      byeCounts[p.id]    = 0;
      senteHistory[p.id] = 0;
    });
    rounds.forEach(round => {
      round.matches.forEach(match => {
        matchHistory.add(this.makeMatchKey(match.player1Id, match.player2Id));
        const p1 = players.find(p => p.id === match.player1Id);
        const p2 = players.find(p => p.id === match.player2Id);
        if (p1 && p2) {
          rankHistory[p1.id][p2.rank]++;
          rankHistory[p2.id][p1.rank]++;
          gradeHistory[p1.id][p2.grade] = (gradeHistory[p1.id][p2.grade] ?? 0) + 1;
          gradeHistory[p2.id][p1.grade] = (gradeHistory[p2.id][p1.grade] ?? 0) + 1;
        }
        // player1 = 先手としてカウント
        if (senteHistory[match.player1Id] !== undefined) senteHistory[match.player1Id]++;
      });
      if (round.byePlayerId) byeCounts[round.byePlayerId]++;
    });
    return { matchHistory, rankHistory, gradeHistory, byeCounts, senteHistory };
  },

  /**
   * スイスドロー方式：現在の成績に基づいて次の1ラウンドを生成
   */
  generateNextSwissRound(players, existingRounds, options = {}) {
    if (players.length < 2) {
      return { error: 'プレイヤーが2人以上必要です。' };
    }

    const gradeLevel   = options.gradeBalanceLevel ?? options.gradeAvoidLevel ?? 2;
    const rankLevel    = options.rankBalanceLevel ?? 2;
    const gradeWeight     = this.GRADE_WEIGHTS[gradeLevel] ?? 15;
    const rankWeight      = this.RANK_WEIGHTS[rankLevel]   ?? 15;
    const assignSenteGote = options.assignSenteGote ?? true;
    const { matchHistory, rankHistory, gradeHistory, byeCounts, senteHistory } = this.buildHistoryFromRounds(players, existingRounds);
    const roundIndex = existingRounds.length;

    // 現在の得点マップを構築（空き手合いは常に不戦勝扱い）
    const pointsMap = {};
    players.forEach(p => { pointsMap[p.id] = 0; });
    if (existingRounds.length > 0) {
      this.calculateStandings(players, existingRounds, true)
        .forEach(s => { pointsMap[s.id] = s.points; });
    }

    // 複数試行で最良ペアリングを選択
    let bestPairs = null;
    let bestByeId = null;
    let bestScore = Infinity;

    for (let trial = 0; trial < 80; trial++) {
      const res = this._trySwissPairing(
        players, matchHistory, rankHistory, gradeHistory, byeCounts, pointsMap, gradeWeight, rankWeight
      );
      if (!res) continue;
      const score = this.evaluatePairing(res.pairs, players, rankHistory, gradeHistory, gradeWeight, rankWeight);
      if (score < bestScore) {
        bestScore  = score;
        bestPairs  = res.pairs;
        bestByeId  = res.byePlayerId;
      }
    }

    if (!bestPairs) {
      return { error: 'スイスドローの生成に失敗しました。' };
    }

    // 先後割り当て：今ラウンドのBYE決定を反映した byeCounts を渡し、
    // 不戦勝あり選手の目標先手回数 (floor((numRounds-bye)/2)) を優先する
    const effectiveByeCounts = { ...byeCounts };
    if (bestByeId) effectiveByeCounts[bestByeId] = (effectiveByeCounts[bestByeId] ?? 0) + 1;
    const swissNumRounds = options.numRounds ?? null;

    const assignedPairs = assignSenteGote
      ? this._assignSenteGote(
          bestPairs.map(([p1, p2]) => ({
            player1Id: p1.id, player1Name: p1.name,
            player1Rank: p1.rank, player1Grade: p1.grade,
            player2Id: p2.id, player2Name: p2.name,
            player2Rank: p2.rank, player2Grade: p2.grade,
            result: null
          })),
          senteHistory,
          effectiveByeCounts,
          swissNumRounds
        )
      : bestPairs.map(([p1, p2]) => ({
          player1Id: p1.id, player1Name: p1.name,
          player1Rank: p1.rank, player1Grade: p1.grade,
          player2Id: p2.id, player2Name: p2.name,
          player2Rank: p2.rank, player2Grade: p2.grade,
          result: null
        }));

    return {
      round: {
        roundNumber: roundIndex + 1,
        matches:     assignedPairs,
        byePlayerId: bestByeId
      }
    };
  },

  /**
   * 全ラウンド生成後の先後最適化。
   *
   * ルール：
   * - 各選手の目標先手回数 = floor(対局数 / 2)
   *   - 6回戦・1回不戦勝 → 5局 → 先手2回・後手3回
   *   - 6回戦・不戦勝なし → 6局 → 先手3回・後手3回
   * - 不戦勝のある選手の目標達成を「不戦勝のない選手の均等化」よりも優先する
   *   （重み 1000 倍で評価）
   *
   * 単一の入れ替え（1-flip）では局所最適に陥るため、
   *   - 試合ペアを同時に入れ替える 2-flip
   *   - ランダム初期化からの多重リスタート
   * を組み合わせて最良解を探索する。
   */
  _optimizeSenteGote(rounds, players, byeCounts, numRounds) {
    // 目標先手回数
    const target = {};
    const isBye  = {};
    players.forEach(p => {
      const bye = byeCounts[p.id] ?? 0;
      target[p.id] = Math.floor((numRounds - bye) / 2);
      isBye[p.id]  = bye > 0;
    });
    const weightOf = (id) => isBye[id] ? 1000 : 1;

    // 全ての試合への参照を平坦化
    const allMatches = [];
    rounds.forEach(r => r.matches.forEach(m => allMatches.push(m)));
    if (allMatches.length === 0) return;

    // 入れ替え操作（in place + result反転）
    const flipMatch = (m) => {
      const t = {
        player1Id:    m.player1Id,    player2Id:    m.player2Id,
        player1Name:  m.player1Name,  player2Name:  m.player2Name,
        player1Grade: m.player1Grade, player2Grade: m.player2Grade,
        player1Rank:  m.player1Rank,  player2Rank:  m.player2Rank,
      };
      m.player1Id    = t.player2Id;    m.player2Id    = t.player1Id;
      m.player1Name  = t.player2Name;  m.player2Name  = t.player1Name;
      m.player1Grade = t.player2Grade; m.player2Grade = t.player1Grade;
      m.player1Rank  = t.player2Rank;  m.player2Rank  = t.player1Rank;
      if (m.result === 'player1') m.result = 'player2';
      else if (m.result === 'player2') m.result = 'player1';
    };

    // senteCount を集計
    const buildSenteCount = () => {
      const sc = {};
      players.forEach(p => { sc[p.id] = 0; });
      allMatches.forEach(m => { sc[m.player1Id]++; });
      return sc;
    };

    // 全選手の総合エラー
    const totalError = (sc) => {
      let sum = 0;
      for (const p of players) {
        const dev = sc[p.id] - target[p.id];
        sum += weightOf(p.id) * dev * dev;
      }
      return sum;
    };

    // 1-flip + 2-flip + 3-flip（必要時のみ）を収束まで反復
    // 時間予算でカット：大規模構成での暴走防止
    const localSearch = (deadline) => {
      const sc = buildSenteCount();

      const evalFlipSet = (matches) => {
        const delta = {};
        matches.forEach(m => {
          delta[m.player1Id] = (delta[m.player1Id] ?? 0) - 1;
          delta[m.player2Id] = (delta[m.player2Id] ?? 0) + 1;
        });
        let before = 0, after = 0;
        for (const id in delta) {
          const d = delta[id];
          if (d === 0) continue;
          const cur  = sc[id] - target[id];
          const newD = cur + d;
          before += weightOf(id) * cur * cur;
          after  += weightOf(id) * newD * newD;
        }
        if (after < before) {
          matches.forEach(m => flipMatch(m));
          for (const id in delta) sc[id] += delta[id];
          return true;
        }
        return false;
      };

      const checkTimeout = () => deadline != null && Date.now() > deadline;

      let improved = true;
      let guard = 0;
      while (improved && guard < 200) {
        improved = false;
        guard++;
        if (checkTimeout()) break;

        // --- 1-flip ---
        for (const m of allMatches) {
          if (evalFlipSet([m])) improved = true;
        }

        // --- 2-flip ---
        for (let i = 0; i < allMatches.length; i++) {
          if (checkTimeout()) break;
          for (let j = i + 1; j < allMatches.length; j++) {
            if (evalFlipSet([allMatches[i], allMatches[j]])) improved = true;
          }
        }

        // --- 3-flip（1-flip / 2-flip で改善がなく、かつエラーが残る場合のみ） ---
        if (!improved && totalError(sc) > 0) {
          outer3:
          for (let i = 0; i < allMatches.length; i++) {
            if (checkTimeout()) break;
            for (let j = i + 1; j < allMatches.length; j++) {
              for (let k = j + 1; k < allMatches.length; k++) {
                if (evalFlipSet([allMatches[i], allMatches[j], allMatches[k]])) {
                  improved = true;
                  break outer3;
                }
              }
            }
          }
        }
      }
      return totalError(sc);
    };

    // ランダムリスタート：初期状態を変えて複数回試し最良を採用
    const snapshot = () => allMatches.map(m => ({
      a: m.player1Id, b: m.player2Id, an: m.player1Name, bn: m.player2Name,
      ag: m.player1Grade, bg: m.player2Grade, ar: m.player1Rank, br: m.player2Rank,
      r: m.result,
    }));
    const restoreFrom = (snap) => allMatches.forEach((m, i) => {
      const s = snap[i];
      m.player1Id = s.a; m.player2Id = s.b;
      m.player1Name = s.an; m.player2Name = s.bn;
      m.player1Grade = s.ag; m.player2Grade = s.bg;
      m.player1Rank = s.ar; m.player2Rank = s.br;
      m.result = s.r;
    });

    // 全体の時間予算（合計で 1.5 秒）
    const overallDeadline = Date.now() + 1500;

    // 1回目：現状から localSearch
    let bestSnap  = snapshot();
    let bestError = localSearch(overallDeadline);
    bestSnap = snapshot();
    if (bestError === 0) { restoreFrom(bestSnap); return; }

    // 構造化リスタート：不戦勝なし選手を試合内で先手にする初期状態
    const structuredRestart = () => {
      allMatches.forEach(m => {
        const b1 = isBye[m.player1Id];
        const b2 = isBye[m.player2Id];
        if (b1 && !b2) flipMatch(m);
      });
    };

    structuredRestart();
    let e = localSearch(overallDeadline);
    if (e < bestError) { bestError = e; bestSnap = snapshot(); }
    if (bestError === 0) { restoreFrom(bestSnap); return; }

    // ランダム初期化での再試行（時間予算が許す限り）
    let restarts = 0;
    while (Date.now() < overallDeadline && restarts < 200) {
      restarts++;
      allMatches.forEach(m => { if (Math.random() < 0.5) flipMatch(m); });
      e = localSearch(overallDeadline);
      if (e < bestError) {
        bestError = e;
        bestSnap  = snapshot();
        if (bestError === 0) break;
      }
    }
    restoreFrom(bestSnap);
  },

  /**
   * 先後均等化：各マッチに先手・後手を割り当てる
   * 引数 byeCounts/numRounds が与えられると、不戦勝あり選手を優先して
   * 目標先手回数 (= floor((numRounds-bye)/2)) に合わせる重み付けを行う。
   * generateAllRounds は最終パスで _optimizeSenteGote を実行するため、
   * 主に Swiss draw（逐次生成）でこの強化版を使う。
   */
  _assignSenteGote(matches, senteHistory, byeCounts = null, numRounds = null) {
    const swap = (m) => ({
      player1Id:    m.player2Id,    player2Id:    m.player1Id,
      player1Name:  m.player2Name,  player2Name:  m.player1Name,
      player1Rank:  m.player2Rank,  player2Rank:  m.player1Rank,
      player1Grade: m.player2Grade, player2Grade: m.player1Grade,
      result: null,
    });

    return matches.map(match => {
      const s1 = senteHistory[match.player1Id] ?? 0;
      const s2 = senteHistory[match.player2Id] ?? 0;

      if (byeCounts && numRounds) {
        // 目標先手回数（不戦勝考慮）
        const b1 = byeCounts[match.player1Id] ?? 0;
        const b2 = byeCounts[match.player2Id] ?? 0;
        const t1 = Math.floor((numRounds - b1) / 2);
        const t2 = Math.floor((numRounds - b2) / 2);
        // 不戦勝のある選手は重み 1000（最優先）
        const w1 = b1 > 0 ? 1000 : 1;
        const w2 = b2 > 0 ? 1000 : 1;
        // p1 が先手の場合と p2 が先手の場合のエラーを比較
        const errIfP1 = w1*(s1+1-t1)*(s1+1-t1) + w2*(s2-t2)*(s2-t2);
        const errIfP2 = w1*(s1-t1)*(s1-t1)     + w2*(s2+1-t2)*(s2+1-t2);
        if (errIfP1 > errIfP2 || (errIfP1 === errIfP2 && Math.random() < 0.5)) {
          return swap(match);
        }
        return { ...match, result: null };
      }

      // 単純な均等化（後方互換）
      if (s1 > s2 || (s1 === s2 && Math.random() < 0.5)) {
        return swap(match);
      }
      return { ...match, result: null };
    });
  },

  _trySwissPairing(players, matchHistory, rankHistory, gradeHistory, byeCounts, pointsMap, gradeWeight, rankWeight) {
    // 得点降順にソート（同点はランダムでシャッフル）
    const sorted = [...players].sort((a, b) => {
      const diff = (pointsMap[b.id] ?? 0) - (pointsMap[a.id] ?? 0);
      return diff !== 0 ? diff : (Math.random() - 0.5);
    });

    let active    = sorted;
    let byePlayerId = null;

    if (active.length % 2 !== 0) {
      // 最も得点が低くBYE回数が少ない選手にBYEを割り当て
      const minBye = Math.min(...active.map(p => byeCounts[p.id] ?? 0));
      const minPts = Math.min(...active.map(p => pointsMap[p.id] ?? 0));
      const cands  = active.filter(p =>
        (pointsMap[p.id] ?? 0) === minPts && (byeCounts[p.id] ?? 0) === minBye
      );
      const byeP   = cands[Math.floor(Math.random() * cands.length)];
      byePlayerId  = byeP.id;
      active       = active.filter(p => p.id !== byePlayerId);
    }

    const used  = new Set();
    const pairs = [];

    for (let i = 0; i < active.length; i++) {
      if (used.has(active[i].id)) continue;

      let bestJ    = -1;
      let bestScore = Infinity;

      for (let j = i + 1; j < active.length; j++) {
        if (used.has(active[j].id)) continue;

        // 再戦は絶対禁止
        if (matchHistory.has(this.makeMatchKey(active[i].id, active[j].id))) continue;

        const standingGap = (j - i) * 25;          // 順位差ペナルティ（スイスの核心）
        const ptsDiff    = Math.abs((pointsMap[active[i].id] ?? 0) - (pointsMap[active[j].id] ?? 0)) * 20;
        const gradeP     = ((gradeHistory[active[i].id]?.[active[j].grade] ?? 0) +
                            (gradeHistory[active[j].id]?.[active[i].grade] ?? 0)) * gradeWeight;
        const rankP      = ((rankHistory[active[i].id]?.[active[j].rank] ?? 0) +
                            (rankHistory[active[j].id]?.[active[i].rank] ?? 0)) * rankWeight;

        const score = standingGap + ptsDiff + gradeP + rankP + Math.random() * 5;
        if (score < bestScore) { bestScore = score; bestJ = j; }
      }

      if (bestJ === -1) return null;
      used.add(active[i].id);
      used.add(active[bestJ].id);
      pairs.push([active[i], active[bestJ]]);
    }

    return { pairs, byePlayerId };
  },

  /**
   * 単一ラウンドの対戦組み合わせを生成
   */
  generateSingleRound(players, matchHistory, rankHistory, gradeHistory, byeCounts, roundIndex, gradeWeight = 15, rankWeight = 15) {
    const isOdd = players.length % 2 !== 0;
    let byePlayerId = null;
    let activePlayers = [...players];

    // 奇数人数の場合、BYEプレイヤーを選出
    if (isOdd) {
      // BYE回数が最も少ないプレイヤーからランダムに選出
      const minBye = Math.min(...activePlayers.map(p => byeCounts[p.id]));
      const candidates = activePlayers.filter(p => byeCounts[p.id] === minBye);
      byePlayerId = candidates[Math.floor(Math.random() * candidates.length)].id;
      activePlayers = activePlayers.filter(p => p.id !== byePlayerId);
    }

    // 複数試行で最良のペアリングを選択
    const maxTrials = 100;
    let bestPairs = null;
    let bestScore = Infinity;

    for (let trial = 0; trial < maxTrials; trial++) {
      const shuffled = this.shuffle([...activePlayers]);
      const pairs = this.greedyPairing(shuffled, matchHistory, rankHistory, gradeHistory, gradeWeight, rankWeight);

      if (pairs) {
        const score = this.evaluatePairing(pairs, players, rankHistory, gradeHistory, gradeWeight, rankWeight);
        if (score < bestScore) {
          bestScore = score;
          bestPairs = pairs;
        }
      }
    }

    if (!bestPairs) return null;

    return {
      roundNumber: roundIndex + 1,
      matches: bestPairs.map(pair => ({
        player1Id: pair[0].id,
        player2Id: pair[1].id,
        player1Name: pair[0].name,
        player2Name: pair[1].name,
        player1Rank: pair[0].rank,
        player2Rank: pair[1].rank,
        player1Grade: pair[0].grade,
        player2Grade: pair[1].grade,
        result: null // null | 'player1' | 'player2' | 'draw'
      })),
      byePlayerId: byePlayerId
    };
  },

  /**
   * 貪欲法によるペアリング
   */
  greedyPairing(players, matchHistory, rankHistory, gradeHistory, gradeWeight = 15, rankWeight = 15) {
    const n = players.length;
    const used = new Set();
    const pairs = [];

    for (let i = 0; i < n; i++) {
      if (used.has(players[i].id)) continue;

      let bestPartner = null;
      let bestScore = Infinity;

      for (let j = i + 1; j < n; j++) {
        if (used.has(players[j].id)) continue;

        // 再戦は絶対禁止 — スキップして別シャッフルに委ねる
        if (matchHistory.has(this.makeMatchKey(players[i].id, players[j].id))) continue;

        const score = this.pairScore(players[i], players[j], rankHistory, gradeHistory, gradeWeight, rankWeight);
        if (score < bestScore) {
          bestScore = score;
          bestPartner = j;
        }
      }

      if (bestPartner === null) return null; // 再試行（別シャッフルで解決）

      used.add(players[i].id);
      used.add(players[bestPartner].id);
      pairs.push([players[i], players[bestPartner]]);
    }

    return pairs;
  },

  /**
   * ペアのスコアを計算（低いほど良い）
   * 学年・ランクの「対戦履歴の偏り」をペナルティ化することで、
   * 各プレイヤーの対戦相手が多様な学年・ランクに分散するようにする。
   */
  pairScore(p1, p2, rankHistory, gradeHistory, gradeWeight = 15, rankWeight = 15) {
    let score = 0;

    // 学年分散ペナルティ：相手の学年と同じ学年と過去対戦した回数に比例
    const p1GradeHist = gradeHistory?.[p1.id];
    const p2GradeHist = gradeHistory?.[p2.id];
    if (p1GradeHist) score += (p1GradeHist[p2.grade] ?? 0) * gradeWeight;
    if (p2GradeHist) score += (p2GradeHist[p1.grade] ?? 0) * gradeWeight;

    // ランク分散ペナルティ
    const p1RankHist = rankHistory?.[p1.id];
    const p2RankHist = rankHistory?.[p2.id];
    if (p1RankHist) score += (p1RankHist[p2.rank] ?? 0) * rankWeight;
    if (p2RankHist) score += (p2RankHist[p1.rank] ?? 0) * rankWeight;

    // ランダム性を追加して多様な組み合わせを生成
    score += Math.random() * 10;

    return score;
  },

  /**
   * ペアリング全体の評価スコア
   */
  evaluatePairing(pairs, allPlayers, rankHistory, gradeHistory, gradeWeight = 15, rankWeight = 15) {
    let totalScore = 0;
    pairs.forEach(([p1, p2]) => {
      const p1GHist = gradeHistory?.[p1.id];
      const p2GHist = gradeHistory?.[p2.id];
      if (p1GHist) totalScore += (p1GHist[p2.grade] ?? 0) * gradeWeight;
      if (p2GHist) totalScore += (p2GHist[p1.grade] ?? 0) * gradeWeight;
      const p1RHist = rankHistory?.[p1.id];
      const p2RHist = rankHistory?.[p2.id];
      if (p1RHist) totalScore += (p1RHist[p2.rank] ?? 0) * rankWeight;
      if (p2RHist) totalScore += (p2RHist[p1.rank] ?? 0) * rankWeight;
    });
    return totalScore;
  },

  /**
   * 対戦キーを生成（ID順でソート）
   */
  makeMatchKey(id1, id2) {
    return [id1, id2].sort().join('-vs-');
  },

  /**
   * 配列をシャッフル（Fisher-Yates）
   */
  shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  },

  /**
   * 成績を計算
   */
  calculateStandings(players, rounds, byeCountsAsWin = true) {
    const stats = {};

    players.forEach(p => {
      stats[p.id] = {
        id: p.id,
        name: p.name,
        grade: p.grade,
        rank: p.rank,
        wins: 0,
        losses: 0,
        draws: 0,
        byes: 0,
        played: 0,
        winRate: 0,
        points: 0 // 勝ち=2点, 引き分け=1点, BYE勝ち=2点
      };
    });

    rounds.forEach(round => {
      round.matches.forEach(match => {
        if (!match.result) return;

        const s1 = stats[match.player1Id];
        const s2 = stats[match.player2Id];
        if (!s1 || !s2) return;

        s1.played++;
        s2.played++;

        if (match.result === 'player1') {
          s1.wins++;
          s2.losses++;
          s1.points += 2;
        } else if (match.result === 'player2') {
          s2.wins++;
          s1.losses++;
          s2.points += 2;
        } else if (match.result === 'draw') {
          s1.draws++;
          s2.draws++;
          s1.points += 1;
          s2.points += 1;
        }
      });

      // BYE処理（不戦勝：winsには加算しない、byes と points のみ加算）
      if (round.byePlayerId && stats[round.byePlayerId]) {
        stats[round.byePlayerId].byes++;
        stats[round.byePlayerId].points += 2;
      }
    });

    // 勝率計算（不戦勝は対局数に含めない）
    Object.values(stats).forEach(s => {
      const totalGames = s.wins + s.losses + s.draws;
      s.winRate = totalGames > 0 ? (s.wins / totalGames * 100) : 0;
    });

    // ソート: ポイント降順 → (勝+不戦勝)降順 → 勝率降順
    const sorted = Object.values(stats).sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      const totalA = a.wins + a.byes;
      const totalB = b.wins + b.byes;
      if (totalB !== totalA) return totalB - totalA;
      return b.winRate - a.winRate;
    });

    // 順位付け
    sorted.forEach((s, i) => {
      if (i === 0) {
        s.position = 1;
      } else {
        const prev = sorted[i - 1];
        const samePoints = s.points === prev.points;
        const sameWins   = (s.wins + s.byes) === (prev.wins + prev.byes);
        s.position = (samePoints && sameWins) ? prev.position : i + 1;
      }
    });

    return sorted;
  }
};
