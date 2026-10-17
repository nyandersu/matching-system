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
