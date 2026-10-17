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
  // 対戦相手の強さ（平均）の偏りへのペナルティ係数（レーティングモードのみ）
  MEAN_WEIGHTS:    [0,  5,  15,  40,  100],

  // ランクモードでの強さの数値
  RANK_STRENGTH: { S: 4, A: 3, B: 2, C: 1 },

  /** レーティングが未入力（数値でない）か */
  hasNoRating(p) {
    return p.rating == null || p.rating === '' || !Number.isFinite(Number(p.rating));
  },

  /** 選手の強さの数値（レーティングモードは入力値、ランクモードは S=4〜C=1） */
  strengthOf(p, mode) {
    if (mode === 'rating') return Number(p.rating);
    return this.RANK_STRENGTH[p.rank] ?? 0;
  },

  /** ランク帯の均等化に使う帯（レーティングモードではレーティング順の4分位） */
  bandOf(p) {
    return p._band ?? p.rank;
  },

  /**
   * 強さの準備。
   * - レーティングモード：レーティング順に4分位の帯（S〜C相当）を割り当て、
   *   「対戦相手の強さ（平均）の均等化」用の目標値を計算する
   *   目標値 = 自分以外の全員の平均（相手を均等に選んだ場合の期待値）
   * - ランクモード：従来どおり（平均の均等化は行わない）
   * @returns {{ players: Array, ctx: Object|null, error?: string }}
   */
  prepareStrength(players, options = {}) {
    if (options.strengthMode !== 'rating') return { players, ctx: null };

    const missing = players.filter(p => this.hasNoRating(p));
    if (missing.length > 0) {
      const names = missing.slice(0, 5).map(p => p.name).join('、');
      return { error: `レーティングが未入力の選手がいます: ${names}${missing.length > 5 ? ` ほか${missing.length - 5}人` : ''}` };
    }

    const strength = {};
    players.forEach(p => { strength[p.id] = this.strengthOf(p, 'rating'); });

    // 同じレーティングは同じ帯になるよう、最初に出現した順位で帯を決める
    const values = players.map(p => strength[p.id]).sort((a, b) => b - a);
    const bandFor = v => this.RANKS[Math.min(3, Math.floor(values.indexOf(v) * 4 / values.length))];
    const working = players.map(p => ({ ...p, _band: bandFor(strength[p.id]) }));

    const n     = players.length;
    const total = values.reduce((a, b) => a + b, 0);
    const mean  = total / n;
    const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / n;
    const target = {};
    players.forEach(p => { target[p.id] = n > 1 ? (total - strength[p.id]) / (n - 1) : mean; });

    const meanLevel = options.meanBalanceLevel ?? 2;
    return {
      players: working,
      ctx: {
        meanWeight: this.MEAN_WEIGHTS[meanLevel] ?? 15,
        strength, target,
        sigma2: variance > 0 ? variance : 1,
        oppSum: {}, games: {},
      },
    };
  },

  _resetMeanHistory(ctx, players) {
    if (!ctx) return;
    players.forEach(p => { ctx.oppSum[p.id] = 0; ctx.games[p.id] = 0; });
  },

  _recordMeanHistory(ctx, id1, id2) {
    if (!ctx || !(id1 in ctx.strength) || !(id2 in ctx.strength)) return;
    ctx.oppSum[id1] += ctx.strength[id2]; ctx.games[id1]++;
    ctx.oppSum[id2] += ctx.strength[id1]; ctx.games[id2]++;
  },

  /**
   * 対戦相手の強さ（平均）の偏りの増分。
   * 各選手の「相手の強さの合計 − 対局数 × 目標値」の二乗が、この対局でどれだけ増えるか。
   * 標準偏差1つ分のずれ ≒ ランク帯の重複1回分 になるよう分散で正規化する。
   */
  _meanCost(p1, p2, ctx) {
    if (!ctx || !ctx.meanWeight) return 0;
    const delta = (id, oppStrength) => {
      const before = ctx.oppSum[id] - ctx.games[id] * ctx.target[id];
      const after  = before + oppStrength - ctx.target[id];
      return after * after - before * before;
    };
    return (delta(p1.id, ctx.strength[p2.id]) + delta(p2.id, ctx.strength[p1.id]))
      / ctx.sigma2 * ctx.meanWeight;
  },


  /**
   * 全ラウンドの対戦組み合わせを生成
   * @param {Array} players - プレイヤー配列
   * @param {number} numRounds - ラウンド数
   * @returns {Array|null} ラウンド配列 or null（生成不可）
   */
  generateAllRounds(inputPlayers, numRounds, options = {}) {
    const prep = this.prepareStrength(inputPlayers, options);
    if (prep.error) return { error: prep.error };
    const players   = prep.players;
    const ctx       = prep.ctx;
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
      this._resetMeanHistory(ctx, players);
      allRounds.length = 0;

      let success = true;

      for (let round = 0; round < numRounds; round++) {
        const result = this.generateSingleRound(
          players, matchHistory, rankHistory, gradeHistory, byeCounts, round, gradeWeight, rankWeight, ctx
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
            rankHistory[p1.id][this.bandOf(p2)]++;
            rankHistory[p2.id][this.bandOf(p1)]++;
            gradeHistory[p1.id][p2.grade] = (gradeHistory[p1.id][p2.grade] ?? 0) + 1;
            gradeHistory[p2.id][p1.grade] = (gradeHistory[p2.id][p1.grade] ?? 0) + 1;
            this._recordMeanHistory(ctx, p1.id, p2.id);
          }
          if (assignSenteGote) senteHistory[match.player1Id]++;
        });

        if (result.byePlayerId) byeCounts[result.byePlayerId]++;
      }

      if (success) {
        // 回戦をまたいだ偏りを入れ替えで解消（先後の割り当てより前に行う）
        this._optimizeSchedule(allRounds, players, gradeWeight, rankWeight, ctx);
        if (assignSenteGote) {
          // 入れ替えで先後の初期割り当てが崩れるため、回数に応じて振り直してから最適化する
          const sente = {};
          players.forEach(p => { sente[p.id] = 0; });
          allRounds.forEach(r => {
            r.matches = this._assignSenteGote(r.matches, sente);
            r.matches.forEach(m => { sente[m.player1Id]++; });
          });
        }

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
  buildHistoryFromRounds(players, rounds, ctx = null) {
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
    this._resetMeanHistory(ctx, players);
    rounds.forEach(round => {
      round.matches.forEach(match => {
        matchHistory.add(this.makeMatchKey(match.player1Id, match.player2Id));
        const p1 = players.find(p => p.id === match.player1Id);
        const p2 = players.find(p => p.id === match.player2Id);
        if (p1 && p2) {
          rankHistory[p1.id][this.bandOf(p2)]++;
          rankHistory[p2.id][this.bandOf(p1)]++;
          gradeHistory[p1.id][p2.grade] = (gradeHistory[p1.id][p2.grade] ?? 0) + 1;
          gradeHistory[p2.id][p1.grade] = (gradeHistory[p2.id][p1.grade] ?? 0) + 1;
          this._recordMeanHistory(ctx, p1.id, p2.id);
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
  generateNextSwissRound(inputPlayers, existingRounds, options = {}) {
    if (inputPlayers.length < 2) {
      return { error: 'プレイヤーが2人以上必要です。' };
    }
    const prep = this.prepareStrength(inputPlayers, options);
    if (prep.error) return { error: prep.error };
    const players   = prep.players;
    const ctx       = prep.ctx;

    const gradeLevel   = options.gradeBalanceLevel ?? options.gradeAvoidLevel ?? 2;
    const rankLevel    = options.rankBalanceLevel ?? 2;
    const gradeWeight     = this.GRADE_WEIGHTS[gradeLevel] ?? 15;
    const rankWeight      = this.RANK_WEIGHTS[rankLevel]   ?? 15;
    const assignSenteGote = options.assignSenteGote ?? true;
    const { matchHistory, rankHistory, gradeHistory, byeCounts, senteHistory } = this.buildHistoryFromRounds(players, existingRounds, ctx);
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
        players, matchHistory, rankHistory, gradeHistory, byeCounts, pointsMap, gradeWeight, rankWeight, ctx
      );
      if (!res) continue;
      const score = this.evaluatePairing(res.pairs, players, rankHistory, gradeHistory, gradeWeight, rankWeight, ctx);
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

  _trySwissPairing(players, matchHistory, rankHistory, gradeHistory, byeCounts, pointsMap, gradeWeight, rankWeight, ctx = null) {
    // 得点降順にソート（同点はランダムでシャッフル）
    const sorted = [...players].sort((a, b) => {
      const diff = (pointsMap[b.id] ?? 0) - (pointsMap[a.id] ?? 0);
      return diff !== 0 ? diff : (Math.random() - 0.5);
    });

    let active    = sorted;
    let byePlayerId = null;

    if (active.length % 2 !== 0) {
      // BYE回数が最も少ない選手のうち、最も得点が低い選手にBYEを割り当て
      // （最下位の選手がすでにBYE済みでも候補が空にならないよう、BYE回数で先に絞る）
      const minBye   = Math.min(...active.map(p => byeCounts[p.id] ?? 0));
      const eligible = active.filter(p => (byeCounts[p.id] ?? 0) === minBye);
      const minPts   = Math.min(...eligible.map(p => pointsMap[p.id] ?? 0));
      const cands    = eligible.filter(p => (pointsMap[p.id] ?? 0) === minPts);
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
        const rankP      = ((rankHistory[active[i].id]?.[this.bandOf(active[j])] ?? 0) +
                            (rankHistory[active[j].id]?.[this.bandOf(active[i])] ?? 0)) * rankWeight;
        const meanP      = this._meanCost(active[i], active[j], ctx);

        const score = standingGap + ptsDiff + gradeP + rankP + meanP + Math.random() * 5;
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
  generateSingleRound(players, matchHistory, rankHistory, gradeHistory, byeCounts, roundIndex, gradeWeight = 15, rankWeight = 15, ctx = null) {
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
      const pairs = this.greedyPairing(shuffled, matchHistory, rankHistory, gradeHistory, gradeWeight, rankWeight, ctx);

      if (pairs) {
        const score = this.evaluatePairing(pairs, players, rankHistory, gradeHistory, gradeWeight, rankWeight, ctx);
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
  greedyPairing(players, matchHistory, rankHistory, gradeHistory, gradeWeight = 15, rankWeight = 15, ctx = null) {
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

        const score = this.pairScore(players[i], players[j], rankHistory, gradeHistory, gradeWeight, rankWeight, ctx);
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
  pairScore(p1, p2, rankHistory, gradeHistory, gradeWeight = 15, rankWeight = 15, ctx = null) {
    // ランダム性を追加して多様な組み合わせを生成
    return this._pairPenalty(p1, p2, rankHistory, gradeHistory, gradeWeight, rankWeight, ctx) + Math.random() * 10;
  },

  /**
   * 1組のペナルティ（低いほど良い・乱数なし）
   * 学年・ランクの「対戦履歴の偏り」と、対戦相手の強さ（平均）のずれ。
   */
  _pairPenalty(p1, p2, rankHistory, gradeHistory, gradeWeight = 15, rankWeight = 15, ctx = null) {
    let score = 0;

    // 学年分散ペナルティ：相手の学年と同じ学年と過去対戦した回数に比例
    const p1GradeHist = gradeHistory?.[p1.id];
    const p2GradeHist = gradeHistory?.[p2.id];
    if (p1GradeHist) score += (p1GradeHist[p2.grade] ?? 0) * gradeWeight;
    if (p2GradeHist) score += (p2GradeHist[p1.grade] ?? 0) * gradeWeight;

    // ランク分散ペナルティ
    const p1RankHist = rankHistory?.[p1.id];
    const p2RankHist = rankHistory?.[p2.id];
    if (p1RankHist) score += (p1RankHist[this.bandOf(p2)] ?? 0) * rankWeight;
    if (p2RankHist) score += (p2RankHist[this.bandOf(p1)] ?? 0) * rankWeight;

    // 対戦相手の強さ（平均）の均等化（レーティングモードのみ）
    score += this._meanCost(p1, p2, ctx);

    return score;
  },

  /**
   * ペアリング全体の評価スコア
   */
  evaluatePairing(pairs, allPlayers, rankHistory, gradeHistory, gradeWeight = 15, rankWeight = 15, ctx = null) {
    return pairs.reduce((sum, [p1, p2]) =>
      sum + this._pairPenalty(p1, p2, rankHistory, gradeHistory, gradeWeight, rankWeight, ctx), 0);
  },

  /**
   * 全回戦を通した仕上げ（局所探索）。
   *
   * 1回戦ずつ組む貪欲法は「その回戦での増分」しか見ないため、全体では偏りが残る。
   * 生成後に、ある回戦の2組 (a-b, c-d) を (a-c, b-d) / (a-d, b-c) に入れ替えたほうが
   * 全体のペナルティが小さくなるなら採用し、改善がなくなるまで（または時間切れまで）繰り返す。
   *
   * 全体のペナルティ（貪欲法の増分を全回戦で足し合わせたものと同じ）：
   *   学年・ランク帯 … 同じ学年・帯の相手と k 回当たった選手ごとに w × k(k−1)/2
   *   強さの平均     … 選手ごとに (相手の強さの合計 − 対局数 × 目安)² / 分散 × w
   * 入れ替えで変わるのは4人分だけなので、その4人の差分だけを計算する。
   * 開始点（貪欲法の結果）と探索順がランダムなので、仕上げ後もランダム性は保たれる。
   */
  _optimizeSchedule(rounds, players, gradeWeight, rankWeight, ctx, timeBudgetMs = 400) {
    const byId = {};
    players.forEach(p => { byId[p.id] = p; });

    // 選手ごとの状態（対戦相手の学年・帯の回数、強さの合計・対局数）
    const state = {};
    players.forEach(p => { state[p.id] = { grade: {}, band: {}, sum: 0, games: 0 }; });
    const pairCount = new Map();
    const add = (id, opp, sign) => {
      const st = state[id];
      st.grade[opp.grade] = (st.grade[opp.grade] ?? 0) + sign;
      const band = this.bandOf(opp);
      st.band[band] = (st.band[band] ?? 0) + sign;
      if (ctx) { st.sum += sign * ctx.strength[opp.id]; st.games += sign; }
    };
    const link = (a, b, sign) => {
      add(a.id, b, sign);
      add(b.id, a, sign);
      const key = this.makeMatchKey(a.id, b.id);
      pairCount.set(key, (pairCount.get(key) ?? 0) + sign);
    };

    // 1人分のペナルティ（その選手が関わる分）
    const tri = k => k * (k - 1) / 2;
    const playerCost = (id) => {
      const st = state[id];
      let c = 0;
      for (const g in st.grade) c += tri(st.grade[g]) * gradeWeight;
      for (const b in st.band)  c += tri(st.band[b])  * rankWeight;
      if (ctx && ctx.meanWeight) {
        const dev = st.sum - st.games * ctx.target[id];
        c += dev * dev / ctx.sigma2 * ctx.meanWeight;
      }
      return c;
    };

    const slots = [];   // [roundIndex, matchIndex]
    rounds.forEach((r, ri) => r.matches.forEach((m, mi) => {
      link(byId[m.player1Id], byId[m.player2Id], +1);
      slots.push([ri, mi]);
    }));

    const deadline = Date.now() + timeBudgetMs;

    // --- 焼きなまし：一時的に悪くなる入れ替えも確率的に受け入れ、局所解から抜け出す ---
    const totalCost = () => players.reduce((sum, p) => sum + playerCost(p.id), 0);
    const multi = rounds.filter(r => r.matches.length >= 2).map(r => r.matches);
    if (multi.length > 0) {
      let cur = totalCost();
      let best = cur;
      let bestSnap = rounds.map(r => r.matches.slice());
      const iterations = 30000;
      const t0 = Math.max(1, cur / Math.max(1, players.length) * 0.5);   // 初期温度：1人あたりのペナルティの半分程度
      for (let it = 0; it < iterations && (it % 1000 !== 0 || Date.now() < deadline); it++) {
        const temp = t0 * (1 - it / iterations) + 1e-6;
        const matches = multi[Math.floor(Math.random() * multi.length)];
        const i = Math.floor(Math.random() * matches.length);
        let j = Math.floor(Math.random() * (matches.length - 1));
        if (j >= i) j++;
        const a = byId[matches[i].player1Id], b = byId[matches[i].player2Id];
        const c = byId[matches[j].player1Id], d = byId[matches[j].player2Id];
        const [x1, y1, x2, y2] = Math.random() < 0.5 ? [a, c, b, d] : [a, d, b, c];
        if (pairCount.get(this.makeMatchKey(x1.id, y1.id)) || pairCount.get(this.makeMatchKey(x2.id, y2.id))) continue;

        const ids = [a.id, b.id, c.id, d.id];
        const before = ids.reduce((sum, id) => sum + playerCost(id), 0);
        link(a, b, -1); link(c, d, -1);
        link(x1, y1, +1); link(x2, y2, +1);
        const delta = ids.reduce((sum, id) => sum + playerCost(id), 0) - before;

        if (delta <= 0 || Math.random() < Math.exp(-delta / temp)) {
          matches[i] = this._makeMatch(x1, y1);
          matches[j] = this._makeMatch(x2, y2);
          cur += delta;
          if (cur < best - 1e-9) { best = cur; bestSnap = rounds.map(r => r.matches.slice()); }
        } else {
          link(x1, y1, -1); link(x2, y2, -1);
          link(a, b, +1); link(c, d, +1);
        }
      }
      // 最良だった状態に戻し、状態を作り直す
      rounds.forEach((r, ri) => { r.matches = bestSnap[ri]; });
      players.forEach(p => { state[p.id] = { grade: {}, band: {}, sum: 0, games: 0 }; });
      pairCount.clear();
      rounds.forEach(r => r.matches.forEach(m => link(byId[m.player1Id], byId[m.player2Id], +1)));
    }

    // --- 仕上げ：改善する入れ替えがなくなるまで ---
    for (let pass = 0; pass < 50 && Date.now() < deadline; pass++) {
      const order = this.shuffle(rounds.map((_, i) => i));
      let improved = false;
      for (const ri of order) {
        const matches = rounds[ri].matches;
        for (let i = 0; i < matches.length; i++) {
          for (let j = i + 1; j < matches.length; j++) {
            const a = byId[matches[i].player1Id], b = byId[matches[i].player2Id];
            const c = byId[matches[j].player1Id], d = byId[matches[j].player2Id];
            const ids = [a.id, b.id, c.id, d.id];
            const before = ids.reduce((sum, id) => sum + playerCost(id), 0);

            let best = null;
            let bestDelta = -1e-9;
            for (const [x1, y1, x2, y2] of this.shuffle([[a, c, b, d], [a, d, b, c]])) {
              if (pairCount.get(this.makeMatchKey(x1.id, y1.id)) || pairCount.get(this.makeMatchKey(x2.id, y2.id))) continue;
              link(a, b, -1); link(c, d, -1);
              link(x1, y1, +1); link(x2, y2, +1);
              const delta = ids.reduce((sum, id) => sum + playerCost(id), 0) - before;
              link(x1, y1, -1); link(x2, y2, -1);
              link(a, b, +1); link(c, d, +1);
              if (delta < bestDelta) { bestDelta = delta; best = [x1, y1, x2, y2]; }
            }

            if (best) {
              const [x1, y1, x2, y2] = best;
              link(a, b, -1); link(c, d, -1);
              link(x1, y1, +1); link(x2, y2, +1);
              matches[i] = this._makeMatch(x1, y1);
              matches[j] = this._makeMatch(x2, y2);
              improved = true;
            }
          }
        }
      }
      if (!improved) break;
    }
  },

  _makeMatch(p1, p2) {
    return {
      player1Id: p1.id,       player2Id: p2.id,
      player1Name: p1.name,   player2Name: p2.name,
      player1Rank: p1.rank,   player2Rank: p2.rank,
      player1Grade: p1.grade, player2Grade: p2.grade,
      result: null,
    };
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
