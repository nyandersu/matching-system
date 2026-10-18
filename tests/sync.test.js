// 端末間の同期テスト（node --test tests/）
// 2台の端末（独立した localStorage）と、サーバーの挙動を再現した疑似DBで、
// 同時に結果を入力しても他の端末の入力が消えないことを確認する
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'storage.js'), 'utf8');

// ---- 疑似DB（サーバー側の挙動を再現） ----
const db = { players: [], rounds: [], settings: [], leagues: [], room_snapshots: [], club_players: [] };
let roomClub = null;   // room_info が返す部（null なら部なし）
let snapshotSeq = 0;
const listeners = [];
const clone = x => JSON.parse(JSON.stringify(x));
const pk = { players: r => r.id, rounds: r => r.room_id + '#' + r.round_number, settings: r => r.id, leagues: r => r.room_id, room_snapshots: r => r.id, club_players: r => r.id };

function query(table) {
  const filters = [];
  const q = {
    _op: 'select', _rows: null,
    select() { return q; },
    eq(c, v) { filters.push(r => r[c] === v); return q; },
    gt(c, v) { filters.push(r => r[c] > v); return q; },
    not(c, op, list) {
      const values = list.replace(/^\(|\)$/g, '').split(',').map(v => v.replace(/^"|"$/g, ''));
      filters.push(r => !values.includes(r[c]));
      return q;
    },
    order(c, opts) { q._order = c; q._desc = opts && opts.ascending === false; return q; },
    limit() { return q; },
    in(c, list) { filters.push(r => list.includes(r[c])); return q; },
    update(row) { q._op = 'update'; q._rows = [row]; return q; },
    insert(rows) {
      q._op = 'upsert';
      q._rows = [].concat(rows).map(r => ({ ...r, id: ++snapshotSeq, created_at: new Date(Date.now() + snapshotSeq).toISOString() }));
      return q;
    },
    maybeSingle() { q._single = true; return q; },
    upsert(rows) { q._op = 'upsert'; q._rows = [].concat(rows); return q; },
    delete() { q._op = 'delete'; return q; },
    then(res, rej) {
      return new Promise(r => setTimeout(r, Math.random() * 5)).then(() => {
        const match = r => filters.every(f => f(r));
        if (q._op === 'upsert') {
          q._rows.forEach(row => {
            const i = db[table].findIndex(x => pk[table](x) === pk[table](row));
            if (i >= 0) db[table][i] = { ...db[table][i], ...clone(row) }; else db[table].push(clone(row));
          });
          return { error: null };
        }
        if (q._op === 'delete') { db[table] = db[table].filter(r => !match(r)); return { error: null }; }
        if (q._op === 'update') {
          db[table].filter(match).forEach(r => Object.assign(r, clone(q._rows[0])));
          return { error: null };
        }
        let rows = clone(db[table].filter(match));
        if (q._order) rows.sort((a, b) => (a[q._order] > b[q._order] ? 1 : a[q._order] < b[q._order] ? -1 : 0) * (q._desc ? -1 : 1));
        return { data: q._single ? (rows[0] || null) : rows, error: null };
      }).then(res, rej);
    },
  };
  return q;
}

function makeClient() {
  return {
    from: query,
    rpc(name, args) {
      return new Promise(r => setTimeout(r, Math.random() * 5)).then(() => {
        if (name === 'auth_session') return { data: [{ account_id: 'a' }], error: null };
        if (name === 'room_info') return { data: roomClub ? [{ room_id: 'TEST01', club_id: roomClub.id, club_name: roomClub.name }] : [], error: null };
        if (name === 'round_set_result') {
          const r = db.rounds.find(x => x.round_number === args.p_round);
          if (r.confirmed) return { error: { message: 'round_confirmed' } };
          r.matches[args.p_match_index].result = args.p_result;
          return { error: null };
        }
        if (name === 'round_set_confirmed') {
          db.rounds.find(x => x.round_number === args.p_round).confirmed = args.p_confirmed;
          return { error: null };
        }
        return { error: { message: 'unknown rpc ' + name } };
      });
    },
    channel() {
      const ch = {
        on(_t, _f, cb) { ch._cb = cb; return ch; },
        subscribe() { listeners.push(ch); return ch; },
        send() { listeners.filter(l => l !== ch).forEach(l => setTimeout(() => l._cb(), 1)); return Promise.resolve(); },
      };
      return ch;
    },
  };
}

// ---- 端末（独立した localStorage を持つ AppStorage） ----
function makeDevice(name) {
  const store = {};
  const localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
  };
  const window = { supabase: { createClient: () => makeClient() }, location: { search: '?room=TEST01' } };
  const document = { addEventListener() {}, visibilityState: 'visible' };
  const AppStorage = new Function('window', 'localStorage', 'document', 'crypto',
    src + '; return AppStorage;')(window, localStorage, document, require('crypto').webcrypto);
  localStorage.setItem('shogi_session', JSON.stringify({ accountId: 'a', username: name, token: 't', createdAt: Date.now() }));
  AppStorage.setRoom('TEST01');
  let updates = 0;
  AppStorage.initRealtime(() => { updates++; });
  return { AppStorage, get updates() { return updates; } };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('2台の端末で同時に入力しても、両方の結果が残り全端末に反映される', async () => {
  const A = makeDevice('A');
  await sleep(50);
  ['p1', 'p2', 'p3', 'p4'].forEach(n => A.AppStorage.addPlayer({ name: n, grade: 1, rank: 'B' }));
  const ps = A.AppStorage.getPlayers();
  A.AppStorage.saveRounds([{ roundNumber: 1, byePlayerId: null, confirmed: false, matches: [
    { player1Id: ps[0].id, player2Id: ps[1].id, result: null },
    { player1Id: ps[2].id, player2Id: ps[3].id, result: null },
  ] }]);
  await sleep(100);

  // B が後から部屋を開く
  const B = makeDevice('B');
  await sleep(100);
  assert.equal(B.AppStorage.getRounds().length, 1, 'Bは部屋を開くとAの対戦表を受け取る');
  assert.equal(B.AppStorage.getPlayers().length, 4, 'Bは部屋を開くとAの選手を受け取る');

  // A と B が同時に別の対局の結果を入力
  A.AppStorage.updateMatchResult(0, 0, 'player1');
  B.AppStorage.updateMatchResult(0, 1, 'player2');
  await sleep(600);
  assert.deepEqual(db.rounds[0].matches.map(m => m.result), ['player1', 'player2'], 'サーバーに両方の結果が残る');
  assert.deepEqual(A.AppStorage.getRounds()[0].matches.map(m => m.result), ['player1', 'player2'], 'Aの画面に両方の結果');
  assert.deepEqual(B.AppStorage.getRounds()[0].matches.map(m => m.result), ['player1', 'player2'], 'Bの画面に両方の結果');

  // A が確定 → B に反映。確定後の B からの変更はサーバーで拒否され、B の画面もサーバーの状態に戻る
  A.AppStorage.setRoundConfirmed(0, true);
  await sleep(600);
  assert.equal(B.AppStorage.getRounds()[0].confirmed, true, '確定状態がBにも反映');
  const warn = console.warn;
  console.warn = () => {};
  B.AppStorage.updateMatchResult(0, 0, null);
  await sleep(600);
  console.warn = warn;
  assert.equal(db.rounds[0].matches[0].result, 'player1', '確定後の書き換えはサーバーで拒否');
  assert.equal(B.AppStorage.getRounds()[0].matches[0].result, 'player1', 'Bの画面はサーバーの状態に戻る');

  // 削除・クリアも他の端末に反映
  B.AppStorage.deletePlayer(ps[3].id);
  await sleep(600);
  assert.equal(A.AppStorage.getPlayers().length, 3, '選手の削除が他の端末にも反映');
  A.AppStorage.saveRounds([]);
  await sleep(600);
  assert.equal(db.rounds.length, 0);
  assert.equal(B.AppStorage.getRounds().length, 0, '対戦表のクリアが他の端末にも反映');
});

test('途中棄権が他の端末に反映され、元に戻すで全端末が以前の状態に戻る', async () => {
  const A = makeDevice('A');
  await sleep(50);
  ['q1', 'q2', 'q3', 'q4'].forEach(n => A.AppStorage.addPlayer({ name: n, grade: 1, rank: 'B' }));
  const ps = A.AppStorage.getPlayers();
  A.AppStorage.saveRounds([{ roundNumber: 1, byePlayerId: null, confirmed: false, matches: [
    { player1Id: ps[0].id, player2Id: ps[1].id, result: 'player1' },
    { player1Id: ps[2].id, player2Id: ps[3].id, result: null },
  ] }]);
  await sleep(100);
  const B = makeDevice('B');
  await sleep(100);

  // 途中棄権
  A.AppStorage.updatePlayer(ps[1].id, { withdrawn: true });
  await sleep(600);
  assert.equal(B.AppStorage.getPlayers().find(p => p.id === ps[1].id).withdrawn, true, '途中棄権がBにも反映');

  // クリアする前に保存 → クリア → 元に戻す
  A.AppStorage.createSnapshot('対戦表をクリアする前');
  A.AppStorage.saveRounds([]);
  await sleep(600);
  assert.equal(B.AppStorage.getRounds().length, 0);

  const snaps = await B.AppStorage.listSnapshots();
  assert.equal(snaps[0].label, '対戦表をクリアする前');
  B.AppStorage.restoreSnapshot(snaps[0]);
  await sleep(800);
  for (const [name, dev] of [['A', A], ['B', B]]) {
    const r = dev.AppStorage.getRounds();
    assert.equal(r.length, 1, `${name}：対戦表が復元される`);
    assert.equal(r[0].matches[0].result, 'player1', `${name}：結果も復元される`);
    assert.equal(dev.AppStorage.getPlayers().find(p => p.id === ps[1].id).withdrawn, true, `${name}：途中棄権の状態も復元される`);
  }
  const labels = (await A.AppStorage.listSnapshots()).map(sn => sn.label);
  assert.ok(labels.includes('復元する前の状態'), '復元前の状態も保存される（復元自体も元に戻せる）');
});

test('部の名簿：部屋で追加・編集した選手は名簿にも入り、名簿の変更は部屋に反映される', async () => {
  db.players = []; db.rounds = []; db.club_players = [];
  roomClub = { id: 'BCLUB01', name: 'テスト将棋部' };
  const A = makeDevice('A');
  await sleep(100);
  assert.deepEqual(A.AppStorage.getRoomClub(), { clubId: 'BCLUB01', name: 'テスト将棋部' });

  // 部屋で追加 → 名簿にも追加されひも付く
  const p = A.AppStorage.addPlayer({ name: '山田', grade: 1, rank: 'S', rating: 1800 });
  await sleep(100);
  assert.equal(db.club_players.length, 1);
  assert.equal(db.club_players[0].club_id, 'BCLUB01');
  assert.equal(db.players[0].club_player_id, db.club_players[0].id);

  // 部屋で編集 → 名簿にも反映
  A.AppStorage.updatePlayer(p.id, { name: '山田太郎', rating: 1820 });
  await sleep(100);
  assert.equal(db.club_players[0].name, '山田太郎');
  assert.equal(db.club_players[0].rating, 1820);

  // 途中棄権は部屋ごとの状態なので名簿は変わらない
  A.AppStorage.updatePlayer(p.id, { withdrawn: true });
  await sleep(100);
  assert.equal(db.club_players[0].withdrawn, undefined);

  // 別の部屋で名簿のレーティングが変わった → この部屋を開き直すと名簿の値になる
  db.club_players[0].rating = 1900;
  const B = makeDevice('B');
  await sleep(150);
  assert.equal(B.AppStorage.getPlayers()[0].rating, 1900, '名簿の値が部屋に反映される');

  // 名簿から追加：すでに部屋にいる選手は重複しない
  const added = B.AppStorage.addPlayersFromRoster([
    { id: db.club_players[0].id, name: '山田太郎', grade: 1, rank: 'S', rating: 1900 },
    { id: 'cp-2', name: '佐藤', grade: 2, rank: null, rating: null },
  ]);
  assert.equal(added.length, 1);
  assert.equal(added[0].rank, 'C', 'ランク未設定の名簿の選手は C として追加');
  roomClub = null;
});
