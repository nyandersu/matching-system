/**
 * matching.js — マッチングアルゴリズム
 * 制約付き貪欲法 + バックトラッキングによる対戦組み合わせ生成
 */

const Matching = {
  RANKS: ['S', 'A', 'B', 'C'],

  // 段階別ペナルティ値（0=無効, 1=低, 2=標準, 3=高, 4=最高）
  GRADE_PENALTIES: [0, 30, 100, 300, 1000],
  RANK_WEIGHTS:    [0,  5,  15,  40,  100],

  /**
   * 全ラウンドの対戦組み合わせを生成
   * @param {Array} players - プレイヤー配列
   * @param {number} numRounds - ラウンド数
   * @returns {Array|null} ラウンド配列 or null（生成不可）
   */
  generateAllRounds(players, numRounds, options = {}) {
    const gradeLevel      = options.gradeAvoidLevel  ?? 2;
    const rankLevel       = options.rankBalanceLevel ?? 2;
    const gradePenalty    = this.GRADE_PENALTIES[gradeLevel] ?? 100;
    const rankWeight      = this.RANK_WEIGHTS[rankLevel]     ?? 15;
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
    const byeCounts    = {};
    const senteHistory = {};

    players.forEach(p => {
      rankHistory[p.id]  = { S: 0, A: 0, B: 0, C: 0 };
      byeCounts[p.id]    = 0;
      senteHistory[p.id] = 0;
    });

    const allRounds = [];
    const maxRetries = 50;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      matchHistory.clear();
      players.forEach(p => {
        rankHistory[p.id]  = { S: 0, A: 0, B: 0, C: 0 };
        byeCounts[p.id]    = 0;
        senteHistory[p.id] = 0;
      });
      allRounds.length = 0;

      let success = true;

      for (let round = 0; round < numRounds; round++) {
        const result = this.generateSingleRound(
          players, matchHistory, rankHistory, byeCounts, round, gradePenalty, rankWeight
        );

        if (!result) { success = false; break; }

        // 先後割り当て
        if (assignSenteGote) {
          result.matches = this._assignSenteGote(result.matches, senteHistory);
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
          }
          if (assignSenteGote) senteHistory[match.player1Id]++;
        });

        if (result.byePlayerId) byeCounts[result.byePlayerId]++;
      }

      if (success) return { rounds: allRounds };
    }

    return { error: 'マッチングの生成に失敗しました。プレイヤー数とラウンド数の組み合わせを見直してください。' };
  },

  /**
   * 既存ラウンドから対戦・ランク履歴を再構築
   */
  buildHistoryFromRounds(players, rounds) {
    const matchHistory = new Set();
    const rankHistory  = {};
    const byeCounts    = {};
    const senteHistory = {};  // 各選手の先手回数
    players.forEach(p => {
      rankHistory[p.id]  = { S: 0, A: 0, B: 0, C: 0 };
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
        }
        // player1 = 先手としてカウント
        if (senteHistory[match.player1Id] !== undefined) senteHistory[match.player1Id]++;
      });
      if (round.byePlayerId) byeCounts[round.byePlayerId]++;
    });
    return { matchHistory, rankHistory, byeCounts, senteHistory };
  },

  /**
   * スイスドロー方式：現在の成績に基づいて次の1ラウンドを生成
   */
  generateNextSwissRound(players, existingRounds, options = {}) {
    if (players.length < 2) {
      return { error: 'プレイヤーが2人以上必要です。' };
    }

    const gradeLevel   = options.gradeAvoidLevel  ?? 2;
    const rankLevel    = options.rankBalanceLevel ?? 2;
    const gradePenalty    = this.GRADE_PENALTIES[gradeLevel] ?? 100;
    const rankWeight      = this.RANK_WEIGHTS[rankLevel]     ?? 15;
    const assignSenteGote = options.assignSenteGote ?? true;
    const { matchHistory, rankHistory, byeCounts, senteHistory } = this.buildHistoryFromRounds(players, existingRounds);
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
        players, matchHistory, rankHistory, byeCounts, pointsMap, gradePenalty, rankWeight
      );
      if (!res) continue;
      const score = this.evaluatePairing(res.pairs, players, rankHistory, gradePenalty, rankWeight);
      if (score < bestScore) {
        bestScore  = score;
        bestPairs  = res.pairs;
        bestByeId  = res.byePlayerId;
      }
    }

    if (!bestPairs) {
      return { error: 'スイスドローの生成に失敗しました。' };
    }

    // 先後割り当て
    const assignedPairs = assignSenteGote
      ? this._assignSenteGote(
          bestPairs.map(([p1, p2]) => ({
            player1Id: p1.id, player1Name: p1.name,
            player1Rank: p1.rank, player1Grade: p1.grade,
            player2Id: p2.id, player2Name: p2.name,
            player2Rank: p2.rank, player2Grade: p2.grade,
            result: null
          })),
          senteHistory
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
   * 先後均等化：各マッチに先手・後手を割り当てる
   * match オブジェクト（player1Id/player2Id等を持つ）の配列を受け取り、
   * 先手回数が少ない方を player1（先手）にして返す
   */
  _assignSenteGote(matches, senteHistory) {
    return matches.map(match => {
      const s1 = senteHistory[match.player1Id] ?? 0;
      const s2 = senteHistory[match.player2Id] ?? 0;
      // player1 の先手回数が多い場合は先後を入れ替え
      if (s1 > s2 || (s1 === s2 && Math.random() < 0.5)) {
        return {
          player1Id:    match.player2Id,    player2Id:    match.player1Id,
          player1Name:  match.player2Name,  player2Name:  match.player1Name,
          player1Rank:  match.player2Rank,  player2Rank:  match.player1Rank,
          player1Grade: match.player2Grade, player2Grade: match.player1Grade,
          result: null
        };
      }
      return { ...match, result: null };
    });
  },

  _trySwissPairing(players, matchHistory, rankHistory, byeCounts, pointsMap, gradePenalty, rankWeight) {
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
        const gradeP     = active[i].grade === active[j].grade ? gradePenalty : 0;
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
  generateSingleRound(players, matchHistory, rankHistory, byeCounts, roundIndex, gradePenalty = 100, rankWeight = 15) {
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
      const pairs = this.greedyPairing(shuffled, matchHistory, rankHistory, gradePenalty, rankWeight);

      if (pairs) {
        const score = this.evaluatePairing(pairs, players, rankHistory, gradePenalty, rankWeight);
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
  greedyPairing(players, matchHistory, rankHistory, gradePenalty = 100, rankWeight = 15) {
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

        const score = this.pairScore(players[i], players[j], rankHistory, gradePenalty, rankWeight);
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
   */
  pairScore(p1, p2, rankHistory, gradePenalty = 100, rankWeight = 15) {
    let score = 0;

    // 同学年ペナルティ
    if (p1.grade === p2.grade) {
      score += gradePenalty;
    }

    // ランク分散ペナルティ（同一ランク同士のボーナス/ペナルティは設けない）
    const p1RankHist = rankHistory[p1.id];
    const p2RankHist = rankHistory[p2.id];

    if (p1RankHist && p2RankHist) {
      score += p1RankHist[p2.rank] * rankWeight;
      score += p2RankHist[p1.rank] * rankWeight;
    }

    // ランダム性を追加して多様な組み合わせを生成
    score += Math.random() * 10;

    return score;
  },

  /**
   * ペアリング全体の評価スコア
   */
  evaluatePairing(pairs, allPlayers, rankHistory, gradePenalty = 100, rankWeight = 15) {
    let totalScore = 0;
    pairs.forEach(([p1, p2]) => {
      if (p1.grade === p2.grade) totalScore += gradePenalty;
      const p1Hist = rankHistory[p1.id];
      const p2Hist = rankHistory[p2.id];
      if (p1Hist) totalScore += p1Hist[p2.rank] * rankWeight;
      if (p2Hist) totalScore += p2Hist[p1.rank] * rankWeight;
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

      // BYE処理
      if (round.byePlayerId && stats[round.byePlayerId]) {
        stats[round.byePlayerId].byes++;
        if (byeCountsAsWin) {
          stats[round.byePlayerId].wins++;
          stats[round.byePlayerId].points += 2;
        }
      }
    });

    // 勝率計算
    Object.values(stats).forEach(s => {
      const totalGames = s.wins + s.losses + s.draws;
      s.winRate = totalGames > 0 ? (s.wins / totalGames * 100) : 0;
    });

    // ソート: ポイント降順 → 勝数降順 → 勝率降順
    const sorted = Object.values(stats).sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.wins !== a.wins) return b.wins - a.wins;
      return b.winRate - a.winRate;
    });

    // 順位付け
    sorted.forEach((s, i) => {
      if (i === 0) {
        s.position = 1;
      } else {
        const prev = sorted[i - 1];
        s.position = (s.points === prev.points && s.wins === prev.wins)
          ? prev.position
          : i + 1;
      }
    });

    return sorted;
  }
};
