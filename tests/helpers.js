// テスト用：ブラウザ向けのスクリプトを Node で読み込む
const fs = require('fs');
const path = require('path');

function loadMatching() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'matching.js'), 'utf8');
  return new Function(src + '; return Matching;')();
}

function makePlayers(n, { rated = false } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    id: 'p' + i,
    name: '選手' + (i + 1),
    grade: (i % 3) + 1,
    rank: ['S', 'A', 'B', 'C'][Math.min(3, Math.floor(i * 4 / n))],
    rating: rated ? 2100 - i * 40 : undefined,
  }));
}

/** 各選手の「相手の平均レーティング − 目安（自分以外の全員の平均）」の二乗平均 */
function opponentStrengthRms(players, rounds) {
  const rating = {};
  players.forEach(p => { rating[p.id] = p.rating; });
  const total = players.reduce((a, p) => a + p.rating, 0);
  const sum = {}, games = {};
  players.forEach(p => { sum[p.id] = 0; games[p.id] = 0; });
  rounds.forEach(r => r.matches.forEach(m => {
    sum[m.player1Id] += rating[m.player2Id]; games[m.player1Id]++;
    sum[m.player2Id] += rating[m.player1Id]; games[m.player2Id]++;
  }));
  const diffs = players.map(p => sum[p.id] / games[p.id] - (total - p.rating) / (players.length - 1));
  return Math.sqrt(diffs.reduce((a, d) => a + d * d, 0) / diffs.length);
}

const pairKeys = rounds => new Set(rounds.flatMap(r => r.matches.map(m => [m.player1Id, m.player2Id].sort().join('-'))));

module.exports = { loadMatching, makePlayers, opponentStrengthRms, pairKeys };
