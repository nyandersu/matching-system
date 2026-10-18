// マッチングの性質テスト（node --test tests/）
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadMatching, makePlayers, opponentStrengthRms, pairKeys } = require('./helpers');

const Matching = loadMatching();
const avg = xs => xs.reduce((a, b) => a + b, 0) / xs.length;

/** 対戦表として成立しているか（全員が各回戦にちょうど1回登場・再戦なし・不戦勝の偏りなし） */
function assertValidSchedule(players, rounds, numRounds) {
  assert.equal(rounds.length, numRounds);
  const seenPairs = new Set();
  const byes = Object.fromEntries(players.map(p => [p.id, 0]));
  rounds.forEach((round, ri) => {
    const seen = new Set();
    round.matches.forEach(m => {
      assert.notEqual(m.player1Id, m.player2Id);
      for (const id of [m.player1Id, m.player2Id]) {
        assert.ok(!seen.has(id), `第${ri + 1}回戦で ${id} が2回登場`);
        seen.add(id);
      }
      const key = [m.player1Id, m.player2Id].sort().join('-');
      assert.ok(!seenPairs.has(key), `再戦: ${key}`);
      seenPairs.add(key);
    });
    if (round.byePlayerId) {
      assert.ok(!seen.has(round.byePlayerId));
      seen.add(round.byePlayerId);
      byes[round.byePlayerId]++;
    }
    assert.equal(seen.size, players.length, `第${ri + 1}回戦で全員が登場していない`);
  });
  const b = Object.values(byes);
  assert.ok(Math.max(...b) - Math.min(...b) <= 1, '不戦勝が特定の選手に偏っている');
}

test('さまざまな人数・回戦数で対戦表が成立する（奇数人数・総当たりを含む）', () => {
  for (const [n, numRounds] of [[2, 1], [5, 4], [8, 7], [11, 10], [16, 6], [23, 6], [30, 10]]) {
    const players = makePlayers(n);
    for (let k = 0; k < 3; k++) {
      const res = Matching.generateAllRounds(players, numRounds, {});
      assert.ok(!res.error, `${n}人・${numRounds}回戦: ${res.error}`);
      assertValidSchedule(players, res.rounds, numRounds);
    }
  }
});

test('回戦数が人数−1を超えるとエラー', () => {
  const res = Matching.generateAllRounds(makePlayers(4), 4, {});
  assert.match(res.error, /最大3回戦/);
});

test('先手・後手の回数がほぼ均等（対局数の半分±1以内）', () => {
  const players = makePlayers(13);
  const res = Matching.generateAllRounds(players, 6, { assignSenteGote: true });
  const sente = {}, games = {};
  players.forEach(p => { sente[p.id] = 0; games[p.id] = 0; });
  res.rounds.forEach(r => r.matches.forEach(m => {
    sente[m.player1Id]++; games[m.player1Id]++; games[m.player2Id]++;
  }));
  players.forEach(p => {
    assert.ok(Math.abs(sente[p.id] - games[p.id] / 2) <= 1, `${p.id}: 先手${sente[p.id]} / ${games[p.id]}局`);
  });
});

test('ランクモード：各選手の対戦相手がランク帯に散らばる', () => {
  const players = makePlayers(23);
  const res = Matching.generateAllRounds(players, 6, { rankBalanceLevel: 2 });
  const rankOf = Object.fromEntries(players.map(p => [p.id, p.rank]));
  const spread = players.map(p => {
    const c = { S: 0, A: 0, B: 0, C: 0 };
    res.rounds.forEach(r => r.matches.forEach(m => {
      if (m.player1Id === p.id) c[rankOf[m.player2Id]]++;
      if (m.player2Id === p.id) c[rankOf[m.player1Id]]++;
    }));
    return Math.max(...Object.values(c)) - Math.min(...Object.values(c));
  });
  // 6局を4帯に分けるので理論上の最小は1。平均でほぼ最小に近いこと
  assert.ok(avg(spread) <= 1.3, `ランク帯の偏り（最多−最少の平均）= ${avg(spread).toFixed(2)}`);
});

test('レーティングモード：未入力の選手がいるとエラー', () => {
  const players = makePlayers(6, { rated: true });
  players[2].rating = null;
  const res = Matching.generateAllRounds(players, 3, { strengthMode: 'rating' });
  assert.match(res.error, /レーティングが未入力/);
  assert.match(res.error, /選手3/);
});

test('レーティングモード：対戦相手の強さの平均がそろう', () => {
  const players = makePlayers(23, { rated: true });
  const rms = level => avg(Array.from({ length: 8 }, () => {
    const res = Matching.generateAllRounds(players, 6, { strengthMode: 'rating', meanBalanceLevel: level });
    assert.ok(!res.error, res.error);
    return opponentStrengthRms(players, res.rounds);
  }));
  const off = rms(0);
  const std = rms(2);
  // 改善前（貪欲法のみ）は標準で約30。全体の仕上げで約20まで下がる
  assert.ok(std < 25, `標準での相手平均のずれ = ${std.toFixed(1)}`);
  assert.ok(std < off * 0.6, `均等化なし ${off.toFixed(1)} → 標準 ${std.toFixed(1)}`);
});

test('ランダム性：同じ条件で作った2つの対戦表は大きく異なる', () => {
  for (const mode of ['rank', 'rating']) {
    const players = makePlayers(23, { rated: true });
    const sets = Array.from({ length: 8 }, () =>
      pairKeys(Matching.generateAllRounds(players, 6, { strengthMode: mode }).rounds));
    const overlaps = [];
    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < sets.length; j++) {
        overlaps.push([...sets[i]].filter(k => sets[j].has(k)).length / sets[i].size);
      }
    }
    // 完全ランダムでも 66局/253通り ≈ 26% は共通する
    assert.ok(avg(overlaps) < 0.35, `${mode}: 共通する対局 ${(avg(overlaps) * 100).toFixed(1)}%`);
  }
});

test('スイスドロー：再戦なしで1回戦ずつ生成できる', () => {
  const players = makePlayers(11, { rated: true });
  const rounds = [];
  for (let r = 0; r < 5; r++) {
    const res = Matching.generateNextSwissRound(players, rounds, { strengthMode: 'rating', numRounds: 5 });
    assert.ok(!res.error, res.error);
    res.round.matches.forEach((m, i) => { m.result = i % 2 ? 'player1' : 'player2'; });
    rounds.push(res.round);
  }
  assertValidSchedule(players, rounds, 5);
});

test('成績：ソルコフとソルコフ−敗数、その順位・平均・標準偏差', () => {
  // A>B, A>C, B>C, D は不戦勝のみ（対局なし）
  const players = ['A', 'B', 'C', 'D'].map(id => ({ id, name: id, grade: 1, rank: 'B' }));
  const rounds = [
    { roundNumber: 1, byePlayerId: 'D', matches: [{ player1Id: 'A', player2Id: 'B', result: 'player1' }] },
    { roundNumber: 2, byePlayerId: null, matches: [{ player1Id: 'A', player2Id: 'C', result: 'player1' },
                                                   { player1Id: 'B', player2Id: 'D', result: null }] },
    { roundNumber: 3, byePlayerId: null, matches: [{ player1Id: 'B', player2Id: 'C', result: 'player1' }] },
  ];
  const standings = Matching.calculateStandings(players, rounds, true);
  const by = Object.fromEntries(standings.map(s => [s.id, s]));
  // 勝ち点：A=4, B=2, C=0, D=2（不戦勝）
  assert.equal(by.A.points, 4); assert.equal(by.B.points, 2); assert.equal(by.C.points, 0);
  // ソルコフ：A=B+C=2, B=A+C=4, C=A+B=6。未入力の対局（B-D）は含めない
  assert.equal(by.A.solkoff, 2); assert.equal(by.B.solkoff, 4); assert.equal(by.C.solkoff, 6);
  assert.equal(by.D.solkoff, 0);
  // ソルコフ−敗数：A=2-0=2, B=4-1=3, C=6-2=4
  assert.equal(by.A.solkoffMinusLosses, 2); assert.equal(by.B.solkoffMinusLosses, 3); assert.equal(by.C.solkoffMinusLosses, 4);

  const summary = Matching.summarizeIndices(standings);
  assert.equal(by.C.solkoffRank, 1); assert.equal(by.B.solkoffRank, 2); assert.equal(by.A.solkoffRank, 3);
  assert.equal(by.D.solkoffRank, null, '対局のない選手は順位なし');
  assert.equal(summary.solkoff.count, 3);
  assert.equal(summary.solkoff.mean, 4);
  assert.ok(Math.abs(summary.solkoff.sd - Math.sqrt(8 / 3)) < 1e-9, '母標準偏差');
  assert.equal(summary.solkoffMinusLosses.mean, 3);
});

test('成績：同じ値は同順位（1, 1, 3）', () => {
  const standings = [
    { played: 1, solkoff: 5, solkoffMinusLosses: 5 },
    { played: 1, solkoff: 5, solkoffMinusLosses: 4 },
    { played: 1, solkoff: 3, solkoffMinusLosses: 3 },
  ];
  Matching.summarizeIndices(standings);
  assert.deepEqual(standings.map(s => s.solkoffRank), [1, 1, 3]);
});

test('途中棄権：残す回戦の続きだけを、棄権した選手を除いて組み直せる', () => {
  const all = makePlayers(12);
  const first = Matching.generateAllRounds(all, 6, {});
  const fixed = first.rounds.slice(0, 2);   // 2回戦まで結果入力済み
  const active = all.filter(p => p.id !== 'p5');
  const res = Matching.generateAllRounds(active, 6, { fixedRounds: fixed, assignSenteGote: true });
  assert.ok(!res.error, res.error);
  assert.deepEqual(res.rounds.map(r => r.roundNumber), [3, 4, 5, 6]);
  res.rounds.forEach(r => {
    const ids = r.matches.flatMap(m => [m.player1Id, m.player2Id]).concat(r.byePlayerId ? [r.byePlayerId] : []);
    assert.ok(!ids.includes('p5'), '棄権した選手は以後の回戦に入らない');
    assert.equal(new Set(ids).size, active.length);
  });
  // 残した回戦を含めて再戦がない
  const keys = [...fixed, ...res.rounds].flatMap(r => r.matches.map(m => [m.player1Id, m.player2Id].sort().join('-')));
  assert.equal(new Set(keys).size, keys.length, '再戦なし');
  // 残した回戦は変更されない
  assert.deepEqual(fixed, first.rounds.slice(0, 2));
  // 先後は残した回戦も含めて均等
  const sente = {}, games = {};
  active.forEach(p => { sente[p.id] = 0; games[p.id] = 0; });
  [...fixed, ...res.rounds].forEach(r => r.matches.forEach(m => {
    if (m.player1Id in sente) sente[m.player1Id]++;
    if (m.player1Id in games) games[m.player1Id]++;
    if (m.player2Id in games) games[m.player2Id]++;
  }));
  active.forEach(p => assert.ok(Math.abs(sente[p.id] - games[p.id] / 2) <= 1, `${p.id}: 先手${sente[p.id]} / ${games[p.id]}局`));
});

test('レーティング更新：期待勝率・変化量・対象の回戦', () => {
  assert.ok(Math.abs(Matching.expectedScore(1600, 1400) - 0.7597) < 1e-3, '200点差で約76%');
  assert.equal(Matching.expectedScore(1500, 1500), 0.5);

  const players = [
    { id: 'a', name: 'A', rating: 1500 }, { id: 'b', name: 'B', rating: 1500 },
    { id: 'c', name: 'C', rating: 1700 }, { id: 'd', name: 'D', rating: 1300 },
  ];
  const rounds = [
    { roundNumber: 1, confirmed: true, rated: false, byePlayerId: null, matches: [
      { player1Id: 'a', player2Id: 'b', result: 'player1' },   // 同じレート：勝ち +16 / 負け −16
      { player1Id: 'c', player2Id: 'd', result: 'draw' } ] },  // 400点差の引き分け：強いほうが下がる
    { roundNumber: 2, confirmed: true, rated: true,  byePlayerId: null, matches: [
      { player1Id: 'a', player2Id: 'c', result: 'player1' } ] },   // 反映済み → 対象外
    { roundNumber: 3, confirmed: false, rated: false, byePlayerId: null, matches: [
      { player1Id: 'b', player2Id: 'd', result: 'player1' } ] },   // 未確定 → 対象外
  ];
  const res = Matching.computeRatingUpdate(players, rounds, { k: 32 });
  assert.equal(res.error, undefined);
  assert.deepEqual(res.roundNumbers, [1]);
  const by = Object.fromEntries(res.rows.map(r => [r.id, r]));
  assert.equal(by.a.delta, 16); assert.equal(by.b.delta, -16);
  assert.equal(by.c.delta, -13); assert.equal(by.d.delta, 13);   // 32 × (0.5 − 0.909) ≒ −13
  assert.equal(by.a.after, 1516);
  assert.equal(res.rows.reduce((s, r) => s + r.delta, 0), 0, '変化量の合計は0');
});

test('レーティング更新：未入力の選手がいるとエラー', () => {
  const players = [{ id: 'a', name: 'A', rating: 1500 }, { id: 'b', name: 'B', rating: null }];
  const rounds = [{ roundNumber: 1, confirmed: true, rated: false, matches: [{ player1Id: 'a', player2Id: 'b', result: 'player1' }] }];
  assert.match(Matching.computeRatingUpdate(players, rounds).error, /未入力.*B/);
});
