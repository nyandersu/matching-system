// リーグ戦・通算成績の計算テスト（部内戦管理アプリのテストから移植・追加）
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../js/leagueLogic.js');

test('按分：合計を保ち、余りは上位グループへ', () => {
  for (const [total, k] of [[0, 1], [5, 2], [7, 3], [10, 4], [1, 5]]) {
    const parts = L.apportion(total, k);
    assert.equal(parts.length, k);
    assert.equal(parts.reduce((a, b) => a + b, 0), total);
  }
  assert.deepEqual(L.apportion(2, 2), [1, 1]);
  assert.deepEqual(L.apportion(2, 3), [1, 1, 0]);
  assert.deepEqual(L.apportion(5, 2), [3, 2]);
  assert.deepEqual(L.apportion(5, 0), []);
});

test('グループ数：必要数は人数÷目標人数の切り上げ、自動では増やさず人数が減れば縮む', () => {
  assert.equal(L.desiredGroupCount(9, 8), 2);
  assert.equal(L.desiredGroupCount(8, 8), 1);
  assert.equal(L.desiredGroupCount(17, 8), 3);
  assert.equal(L.desiredGroupCount(0, 8), 1);
  assert.equal(L.nextGroupCount(1, 30, 8), 1, '自動では増やさない');
  assert.equal(L.nextGroupCount(3, 20, 8), 3);
  assert.equal(L.nextGroupCount(3, 9, 8), 2);
  assert.equal(L.nextGroupCount(2, 6, 8), 1);
  assert.equal(L.nextGroupCount(2, 0, 8), 1);
});

test('スネーク配分：強さが各グループに均等に散る', () => {
  assert.deepEqual(L.distributeSnake([1, 2, 3, 4, 5, 6], 2), [[1, 4, 5], [2, 3, 6]]);
  const groups = L.distributeSnake(Array.from({ length: 11 }, (_, i) => i), 3);
  const sizes = groups.map(g => g.length);
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1);
});

test('並設グループ名：甲乙…、付け直しでも重複しない', () => {
  assert.deepEqual(L.defaultSiblingNames('B級', 1), ['B級']);
  assert.deepEqual(L.defaultSiblingNames('B級', 3), ['B級 甲', 'B級 乙', 'B級 丙']);
  assert.deepEqual(L.defaultSiblingNames('B級 乙', 2), ['B級 甲', 'B級 乙']);
  assert.equal(L.stripSiblingSuffix('C級 12'), 'C級');
  assert.equal(L.stripSiblingSuffix('A級'), 'A級');
});

test('割合の昇降級枠：少ない側×割合、最低1人・半数まで', () => {
  assert.deepEqual(L.ratioSwapCounts([8, 8, 8], 0.25), [2, 2]);
  assert.deepEqual(L.ratioSwapCounts([10, 3], 0.25), [1], '少ない側(3)×0.25=0.75→1');
  assert.deepEqual(L.ratioSwapCounts([10, 4], 0.9), [2], '半数(2)まで');
  assert.deepEqual(L.ratioSwapCounts([5, 0], 0.25), [0]);
  assert.deepEqual(L.ratioSwapCounts([6], 0.25), []);
});

test('境目の同点（プレーオフの対象）', () => {
  const s = (pts, w, l) => ({ pts, w, l });
  const standings = [s(8, 4, 0), s(6, 3, 1), s(6, 3, 1), s(6, 3, 1), s(2, 1, 3)];
  assert.deepEqual(L.tieAtCut(standings, 2), { tied: true, from: 1, to: 4 }, '2位〜4位が同点');
  assert.deepEqual(L.tieAtCut(standings, 1), { tied: false, from: 1, to: 1 });
  assert.equal(L.tieAtCut(standings, 4).tied, false);
  assert.equal(L.tieAtCut(standings, 0).tied, false);
});

test('次の期の構成：人数が減ればグループを統合し、成績順にスネーク配分', () => {
  const tiers = [
    { tier: 1, classIds: ['a'], baseName: 'A級' },
    { tier: 2, classIds: ['b1', 'b2'], baseName: 'B級' },
  ];
  const incoming = {
    1: [{ playerId: 'x1', finalRank: 1 }, { playerId: 'x2', finalRank: 2 }],
    2: Array.from({ length: 9 }, (_, i) => ({ playerId: 'y' + i, finalRank: i + 1 })),
  };
  const layout = L.planNextTermLayout(tiers, incoming, 8);
  assert.equal(layout[0].groups.length, 1);
  assert.equal(layout[1].groups.length, 2, '9人・目標8人 → 2グループのまま');
  assert.deepEqual(layout[1].groups.map(g => g.name), ['B級 甲', 'B級 乙']);
  assert.deepEqual(layout[1].groups[0].playerIds, ['y0', 'y3', 'y4', 'y7', 'y8']);

  incoming[2] = incoming[2].slice(0, 6);
  const merged = L.planNextTermLayout(tiers, incoming, 8);
  assert.equal(merged[1].groups.length, 1, '6人 → 1グループに統合');
  assert.equal(merged[1].groups[0].name, 'B級');
});

test('自動再編：目標人数で級を作り、上位の級を厚めにする', () => {
  const ids = n => Array.from({ length: n }, (_, i) => i + 1);
  assert.deepEqual(L.planAutoRestructure(ids(6), 8).map(c => [c.name, c.playerIds.length]), [['本戦', 6]]);
  assert.deepEqual(L.planAutoRestructure(ids(16), 8).map(c => c.playerIds.length), [8, 8]);
  assert.deepEqual(L.planAutoRestructure(ids(13), 8).map(c => c.playerIds.length), [7, 6]);
  assert.deepEqual(L.planAutoRestructure(ids(20), 6).map(c => c.name), ['A級', 'B級', 'C級', 'D級']);
  assert.deepEqual(L.planAutoRestructure(ids(16), 8)[0].playerIds, ids(8), '上位8人がA級');
  assert.deepEqual(L.planAutoRestructure([], 8), []);
});

test('連勝・連敗：引き分けでリセット', () => {
  assert.deepEqual(L.computeStreaks(['W', 'W', 'W', 'L', 'W', 'D', 'L', 'L']),
    { longestWin: 3, longestLose: 2, currentWin: 0, currentLose: 2 });
  assert.deepEqual(L.computeStreaks([]), { longestWin: 0, longestLose: 0, currentWin: 0, currentLose: 0 });
});

test('通算成績：合計・先後別（記録のある対局のみ）・対戦相手別', () => {
  const g = (outcome, sente, opp) => ({ outcome, sente, opponentId: opp, opponentName: opp.toUpperCase() });
  const stats = L.careerStats([
    g('W', true, 'a'), g('L', false, 'a'), g('D', true, 'b'), g('W', null, 'c'), g('W', false, 'a'),
  ]);
  assert.deepEqual([stats.total.wins, stats.total.losses, stats.total.draws, stats.total.played], [3, 1, 1, 5]);
  assert.equal(stats.total.winRate, 3.5 / 5, '引き分けは0.5勝');
  assert.deepEqual([stats.sente.wins, stats.sente.draws, stats.sente.played], [1, 1, 2]);
  assert.deepEqual([stats.gote.wins, stats.gote.losses, stats.gote.played], [1, 1, 2]);
  assert.equal(stats.opponents[0].opponentId, 'a');
  assert.equal(stats.opponents[0].played, 3);
  assert.equal(stats.streaks.currentWin, 2, '最後の2局が勝ち');
});

test('総当たり表：全ペアが1回ずつ、先手回数が均等', () => {
  for (const n of [2, 5, 6, 9]) {
    const ids = Array.from({ length: n }, (_, i) => 'p' + i);
    const ms = L.roundRobin(ids);
    assert.equal(ms.length, n * (n - 1) / 2);
    const keys = new Set(ms.map(m => [m.p1Id, m.p2Id].sort().join('-')));
    assert.equal(keys.size, ms.length, '同じ組み合わせがない');
    const sente = Object.fromEntries(ids.map(id => [id, 0]));
    ms.forEach(m => sente[m.p1Id]++);
    ids.forEach(id => {
      assert.ok(sente[id] >= Math.floor((n - 1) / 2) && sente[id] <= Math.ceil((n - 1) / 2), `${n}人: ${id} 先手${sente[id]}`);
    });
  }
  assert.deepEqual(L.roundRobin(['a']), []);
});

test('グループ名の付け方：「B1・B2」の数字方式も崩れない', () => {
  assert.equal(L.stripSiblingSuffix('B1'), 'B');
  assert.equal(L.stripSiblingSuffix('B級2'), 'B級');
  assert.equal(L.stripSiblingSuffix('1組'), '1組', '名前が空になる場合は外さない');
  assert.equal(L.stripSiblingSuffix('A級'), 'A級');
  assert.equal(L.siblingStyleOf(['B1', 'B2']), 'number');
  assert.equal(L.siblingStyleOf(['B級 甲', 'B級 乙']), 'kanji');
  assert.equal(L.siblingStyleOf(['A級']), null);
  assert.deepEqual(L.defaultSiblingNames('B1', 2, 'number'), ['B1', 'B2']);
  assert.deepEqual(L.defaultSiblingNames('B1', 3, 'number'), ['B1', 'B2', 'B3']);
  assert.deepEqual(L.defaultSiblingNames('B2', 1, 'number'), ['B']);
  const layout = L.planNextTermLayout([{ tier: 2, classIds: ['b1', 'b2'], baseName: 'B1', style: 'number' }],
    { 2: Array.from({ length: 11 }, (_, i) => ({ playerId: 'p' + i, finalRank: i + 1 })) }, 8);
  assert.deepEqual(layout[0].groups.map(g => g.name), ['B1', 'B2']);
});
