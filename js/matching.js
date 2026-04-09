/**
 * matching.js — マッチングアルゴリズム
 * 制約付き貪欲法 + バックトラッキングによる対戦組み合わせ生成
 */

const Matching = {
  RANKS: ['S', 'A', 'B', 'C'],

  /**
   * 全ラウンドの対戦組み合わせを生成
   * @param {Array} players - プレイヤー配列
   * @param {number} numRounds - ラウンド数
   * @returns {Array|null} ラウンド配列 or null（生成不可）
   */
  generateAllRounds(players, numRounds) {
    // 実現可能性チェック
    if (players.length < 2) {
      return { error: 'プレイヤーが2人以上必要です。' };
    }
    if (numRounds > players.length - 1) {
      return {
        error: `${players.length}人の場合、最大${players.length - 1}回戦までです（現在: ${numRounds}回戦）。`
      };
    }

    const matchHistory = new Set(); // "id1-id2" (sorted)
    const rankHistory = {};         // { playerId: { S: 0, A: 0, B: 0, C: 0 } }
    const byeCounts = {};           // { playerId: byeCount }

    // 初期化
    players.forEach(p => {
      rankHistory[p.id] = { S: 0, A: 0, B: 0, C: 0 };
      byeCounts[p.id] = 0;
    });

    const allRounds = [];
    const maxRetries = 50; // 全体リトライ上限

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // リセット
      matchHistory.clear();
      players.forEach(p => {
        rankHistory[p.id] = { S: 0, A: 0, B: 0, C: 0 };
        byeCounts[p.id] = 0;
      });
      allRounds.length = 0;

      let success = true;

      for (let round = 0; round < numRounds; round++) {
        const result = this.generateSingleRound(
          players, matchHistory, rankHistory, byeCounts, round
        );

        if (!result) {
          success = false;
          break;
        }

        allRounds.push(result);

        // 履歴更新
        result.matches.forEach(match => {
          const key = this.makeMatchKey(match.player1Id, match.player2Id);
          matchHistory.add(key);

          const p1 = players.find(p => p.id === match.player1Id);
          const p2 = players.find(p => p.id === match.player2Id);
          if (p1 && p2) {
            rankHistory[p1.id][p2.rank]++;
            rankHistory[p2.id][p1.rank]++;
          }
        });

        if (result.byePlayerId) {
          byeCounts[result.byePlayerId]++;
        }
      }

      if (success) {
        return { rounds: allRounds };
      }
    }

    return { error: 'マッチングの生成に失敗しました。プレイヤー数とラウンド数の組み合わせを見直してください。' };
  },

  /**
   * 単一ラウンドの対戦組み合わせを生成
   */
  generateSingleRound(players, matchHistory, rankHistory, byeCounts, roundIndex) {
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
      const pairs = this.greedyPairing(shuffled, matchHistory, rankHistory);

      if (pairs) {
        const score = this.evaluatePairing(pairs, players, rankHistory);
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
  greedyPairing(players, matchHistory, rankHistory) {
    const n = players.length;
    const used = new Set();
    const pairs = [];

    for (let i = 0; i < n; i++) {
      if (used.has(players[i].id)) continue;

      let bestPartner = null;
      let bestScore = Infinity;

      for (let j = i + 1; j < n; j++) {
        if (used.has(players[j].id)) continue;

        const key = this.makeMatchKey(players[i].id, players[j].id);
        const isRematch = matchHistory.has(key);
        // 再戦禁止を絶対条件ではなく極めて重いペナルティとし、生成が100%失敗するのを防ぐ
        const rematchPenalty = isRematch ? 10000 : 0; 

        const score = this.pairScore(players[i], players[j], rankHistory) + rematchPenalty;
        if (score < bestScore) {
          bestScore = score;
          bestPartner = j;
        }
      }

      if (bestPartner === null) return null; // ペアリング不可

      used.add(players[i].id);
      used.add(players[bestPartner].id);
      pairs.push([players[i], players[bestPartner]]);
    }

    return pairs;
  },

  /**
   * ペアのスコアを計算（低いほど良い）
   */
  pairScore(p1, p2, rankHistory) {
    let score = 0;

    // 同学年ペナルティ
    if (p1.grade === p2.grade) {
      score += 100;
    }

    // ランク分散ペナルティ
    // p1がp2のランクと対戦する偏りをチェック
    const p1RankHist = rankHistory[p1.id];
    const p2RankHist = rankHistory[p2.id];

    if (p1RankHist && p2RankHist) {
      score += p1RankHist[p2.rank] * 15;
      score += p2RankHist[p1.rank] * 15;
    }

    // ランクが近いほど若干の加点（近いランク同士ばかりにならないよう）
    const rankDiff = Math.abs(this.RANKS.indexOf(p1.rank) - this.RANKS.indexOf(p2.rank));
    if (rankDiff === 0) {
      score += 5;
    }

    // ランダム性を追加して多様な組み合わせを生成
    score += Math.random() * 10;

    return score;
  },

  /**
   * ペアリング全体の評価スコア
   */
  evaluatePairing(pairs, allPlayers, rankHistory) {
    let totalScore = 0;
    pairs.forEach(([p1, p2]) => {
      if (p1.grade === p2.grade) totalScore += 100;
      const p1Hist = rankHistory[p1.id];
      const p2Hist = rankHistory[p2.id];
      if (p1Hist) totalScore += p1Hist[p2.rank] * 15;
      if (p2Hist) totalScore += p2Hist[p1.rank] * 15;
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
