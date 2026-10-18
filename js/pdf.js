/**
 * pdf.js — PDF出力モジュール
 * html2pdf.js（jsPDF + html2canvas）でPDFを生成し、印刷ダイアログを経由せず
 * 直接ファイルとしてダウンロードする。
 */

const PDF = {
  /** XSS対策：ユーザー入力をPDF HTMLに埋め込む前にエスケープ */
  _esc(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  /** YYYY-MM-DD 形式の今日の日付（ファイル名用） */
  _today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  },

  /**
   * 対戦表をPDFとしてダウンロード
   */
  exportMatchTable(rounds, players, opts = { showGrade: true, showRank: true }) {
    const html = this.buildMatchTableHTML(rounds, players, opts);
    return this._downloadPDF(html, `対戦表_${this._today()}.pdf`);
  },

  /**
   * 成績表をPDFとしてダウンロード
   */
  exportStandings(standings, opts = { showPoints: true }) {
    const html = this.buildStandingsHTML(standings, opts);
    return this._downloadPDF(html, `成績表_${this._today()}.pdf`);
  },

  /**
   * 完全隔離 iframe 内で html2canvas + jsPDF を実行して PDF をダウンロード。
   *
   * 本体ページの CSS（body の radial-gradient 等）が html2canvas の
   * canvas gradient 計算で non-finite 値を生み、無限ループや白紙化を
   * 引き起こすため、iframe を完全に独立した document として扱い、
   * その中で全ての PDF 描画ロジックを完結させる。
   *
   * 印刷ダイアログは経由しない。
   */
  async _downloadPDF(contentHtml, filename, opts = {}) {
    // orientation: 'portrait'（A4縦）| 'landscape'（A4横）
    const orientation = opts.orientation === 'landscape' ? 'landscape' : 'portrait';
    if (typeof html2canvas === 'undefined' || typeof window.jspdf === 'undefined') {
      alert('PDF生成ライブラリが読み込まれていません。ページを再読み込みしてください。');
      return;
    }

    const styleCss = `
      *,*::before,*::after { box-sizing: border-box; margin: 0; padding: 0; }
      html, body { background: #fff; }
      body {
        font-family: 'Hiragino Sans', 'Yu Gothic', sans-serif;
        font-size: 13px;
        color: #1a1a2e;
        padding: 24px 28px;
        width: ${orientation === 'landscape' ? 1123 : 794}px;
      }
      h1 { font-size: 22px; text-align: center; margin-bottom: 4px; }
      .subtitle { text-align: center; color: #666; font-size: 12px; margin-bottom: 20px; }
      h2 {
        font-size: 15px; margin: 20px 0 8px; padding-bottom: 5px;
        border-bottom: 2px solid #333; color: #1a1a2e;
      }
      table { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
      th {
        background: #2d2d44; color: #fff; font-size: 12px;
        font-weight: 600; padding: 8px 10px; border: 1px solid #555;
        text-align: center;
      }
      td {
        border: 1px solid #bbb; padding: 7px 10px; font-size: 12px;
        text-align: center; color: #1a1a2e; background: #fff;
      }
      tr:nth-child(even) td { background: #f5f5f5; }
      .name-td { text-align: left !important; }
      .win-td { color: #8a5800; font-weight: bold; }
      .loss-td { color: #c0392b; }
      .pt-td { font-weight: bold; color: #8a5800; }
      .rank-S { background:#ffd700; color:#1a1a2e; padding:1px 5px; border-radius:3px; font-weight:bold; font-size:11px; display:inline-block; }
      .rank-A { background:#e74c3c; color:#fff; padding:1px 5px; border-radius:3px; font-weight:bold; font-size:11px; display:inline-block; }
      .rank-B { background:#3498db; color:#fff; padding:1px 5px; border-radius:3px; font-weight:bold; font-size:11px; display:inline-block; }
      .rank-C { background:#2ecc71; color:#1a1a2e; padding:1px 5px; border-radius:3px; font-weight:bold; font-size:11px; display:inline-block; }
      .bye-note { color: #888; font-size: 12px; margin: 4px 0 14px; }
      .pdf-round { display: block; }
      /* リーグ戦：星取り表・個人成績書 */
      table.lx { width: auto; margin: 0 auto 10px; }
      .lx th, .lx td { padding: 5px 4px; font-size: 11px; }
      .lx .lx-no { width: 26px; }
      .lx .lx-name { text-align: left; white-space: nowrap; padding: 5px 10px; min-width: 110px; }
      .lx .lx-diag { background: #ddd !important; }
      .lx .lx-cell { width: 30px; height: 26px; font-size: 14px; }
      .lx .lx-win { color: #8a5800; font-weight: bold; }
      .lx .lx-loss { color: #c0392b; }
      .lx .lx-sum { width: 30px; font-weight: bold; }
      .note { color: #666; font-size: 11px; margin: 6px 0 14px; }
      .report-meta { display: flex; justify-content: center; gap: 18px; color: #444; font-size: 12px; margin-bottom: 14px; }
      .report-summary td { font-size: 13px; }
      .promote { color: #1f7a3a; font-weight: bold; }
      .demote { color: #c0392b; font-weight: bold; }
      .tie { color: #8a5800; font-weight: bold; }
    `;

    // 既存のレンダリング用 iframe があれば削除
    const oldIf = document.getElementById('__pdf_iframe__');
    if (oldIf) oldIf.remove();

    const iframe = document.createElement('iframe');
    iframe.id = '__pdf_iframe__';
    iframe.setAttribute('aria-hidden', 'true');
    // 視覚的に消す方法は html2canvas を妨げないものに限定する。
    // - opacity:0 や position:fixed top/left:0 は html2canvas の無限ループを誘発した
    // - そのため、ページ末尾に追加（normal flow）し、サイズは 0×0 で可視 0 にする
    // iframe を 0x0 や visibility:hidden にすると rendering pipeline が止まり
    // 中の requestAnimationFrame / html2canvas が動作しなくなる。
    // 視認上は見えないが正の寸法を持つよう、極小サイズで画面右下に配置する。
    iframe.style.cssText = `
      width: ${orientation === 'landscape' ? 1130 : 800}px; height: 1px; border: 0;
      position: fixed; right: 0; bottom: 0;
      overflow: hidden;
      pointer-events: none;
    `;
    document.body.appendChild(iframe);

    try {
      const blob = await this._renderPdfInIframe(iframe, contentHtml, styleCss, orientation);
      // ダウンロードトリガー
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Blob URL のクリーンアップは少し遅らせる（Safari 対策）
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      console.error('[PDF] generation failed:', e);
      alert('PDFの生成に失敗しました: ' + (e.message || e));
    } finally {
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    }
  },

  /**
   * iframe 内に html2canvas + jsPDF を再ロードして、その中で完結する形で
   * PDF blob を生成する。本体ページの CSS の影響を完全に遮断するため、
   * ライブラリ自体も iframe 内で読み込み直す。
   * 完了したら postMessage で blob を親に返す。
   */
  _renderPdfInIframe(iframe, contentHtml, styleCss, orientation = 'portrait') {
    const reqId = '__pdf_req_' + Date.now() + '_' + Math.random().toString(36).slice(2);

    return new Promise((resolve, reject) => {
      const TIMEOUT_MS = 20000;
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMessage);
        reject(new Error('PDF生成がタイムアウトしました'));
      }, TIMEOUT_MS);

      const onMessage = (ev) => {
        if (ev.source !== iframe.contentWindow) return;
        const data = ev.data;
        if (!data || data.__pdfReq !== reqId) return;
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        if (data.ok && data.blob) resolve(data.blob);
        else reject(new Error(data.error || '不明なエラー'));
      };
      window.addEventListener('message', onMessage);

      // iframe document を構築
      const idoc = iframe.contentDocument || iframe.contentWindow.document;
      idoc.open();
      idoc.write(`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>pdf</title>
<style>${styleCss}</style>
<script src="https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js" crossorigin="anonymous"></scr` + `ipt>
<script src="https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js" crossorigin="anonymous"></scr` + `ipt>
</head>
<body>${contentHtml}<scr` + `ipt>
(async function () {
  const send = (msg) => parent.postMessage(Object.assign({ __pdfReq: ${JSON.stringify(reqId)} }, msg), '*');
  try {
    if (typeof html2canvas === 'undefined') throw new Error('html2canvas not loaded in iframe');
    if (typeof window.jspdf === 'undefined') throw new Error('jspdf not loaded in iframe');
    // フォント読込待ちは最大2秒に制限（iframeで永遠にpending状態が起こりうる）
    if (document.fonts && document.fonts.ready) {
      try {
        await Promise.race([
          document.fonts.ready,
          new Promise(r => setTimeout(r, 2000))
        ]);
      } catch (_) {}
    }
    // setTimeout で1tick遅らせる（極小iframeでは requestAnimationFrame が発火しないため）
    await new Promise(r => setTimeout(r, 50));

    // 各回戦（.pdf-round）の document 内 Y 範囲を採取。
    // html2canvas でレンダリングする前に取得する（DOM 構造はその時点で確定済み）。
    // 1ページ1回戦の方針のため、各ブロックの top も後で「ページ先頭オフセット」として使う。
    const SCALE = 2;
    const blocks = [];
    document.querySelectorAll('.pdf-round').forEach(el => {
      const r = el.getBoundingClientRect();
      // iframe document 内の coords。スクロールしてないので rect そのままで OK。
      blocks.push({ topPx: r.top * SCALE, bottomPx: r.bottom * SCALE });
    });

    const canvas = await html2canvas(document.body, {
      scale: SCALE,
      useCORS: true,
      backgroundColor: '#ffffff',
      logging: false,
      windowWidth: document.documentElement.scrollWidth,
      windowHeight: document.documentElement.scrollHeight,
    });
    if (!canvas || canvas.width === 0 || canvas.height === 0) {
      throw new Error('canvas size invalid: ' + canvas?.width + 'x' + canvas?.height);
    }

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: ${JSON.stringify(orientation)} });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const margin = 10;
    const imgW = pageW - margin * 2;
    const imgH = canvas.height * imgW / canvas.width;

    const pageContentH = pageH - margin * 2;
    const pxPerMm      = canvas.width / imgW;
    const pageHeightPx = Math.floor(pageContentH * pxPerMm);

    // 各回戦（.pdf-round）が定義されている場合は「1ページ1回戦」モード：
    //   1ページ目はヘッダー（h1+subtitle）+ 第1回戦
    //   2ページ目以降は各回戦を1ページずつ
    //   各回戦が単独でページ高さを超える場合のみ内部スライス（フォールバック）
    if (blocks.length > 0) {
      // 各ページに描画する範囲を構築
      // 1ページ目: [0, blocks[0].bottomPx]（ヘッダー + 第1回戦）
      // 以降: [blocks[i-1].bottomPx, blocks[i].bottomPx] ではなく
      //        [blocks[i].topPx, blocks[i].bottomPx] で各回戦のみ
      const pageRanges = [];
      // 1ページ目はヘッダーから第1回戦末尾まで
      pageRanges.push({ from: 0, to: blocks[0].bottomPx });
      // 2回戦以降は各回戦単独
      for (let i = 1; i < blocks.length; i++) {
        pageRanges.push({ from: blocks[i].topPx, to: blocks[i].bottomPx });
      }

      let firstPage = true;
      for (const range of pageRanges) {
        const totalH = range.to - range.from;
        if (totalH <= 0) continue;

        // ページに収まる場合はそのまま貼り付け
        if (totalH <= pageHeightPx) {
          const slice = document.createElement('canvas');
          slice.width  = canvas.width;
          slice.height = totalH;
          const sctx = slice.getContext('2d');
          sctx.fillStyle = '#ffffff';
          sctx.fillRect(0, 0, slice.width, slice.height);
          sctx.drawImage(canvas, 0, -range.from);
          const sliceMm = totalH / pxPerMm;
          if (!firstPage) pdf.addPage();
          pdf.addImage(slice.toDataURL('image/jpeg', 0.95), 'JPEG', margin, margin, imgW, sliceMm);
          firstPage = false;
        } else {
          // 単独でページ高さを超える巨大な回戦：内部分割（複数ページに分割）
          let cursor = range.from;
          while (cursor < range.to) {
            const remaining = range.to - cursor;
            const sliceH = Math.min(pageHeightPx, remaining);
            const slice = document.createElement('canvas');
            slice.width  = canvas.width;
            slice.height = sliceH;
            const sctx = slice.getContext('2d');
            sctx.fillStyle = '#ffffff';
            sctx.fillRect(0, 0, slice.width, slice.height);
            sctx.drawImage(canvas, 0, -cursor);
            const sliceMm = sliceH / pxPerMm;
            if (!firstPage) pdf.addPage();
            pdf.addImage(slice.toDataURL('image/jpeg', 0.95), 'JPEG', margin, margin, imgW, sliceMm);
            firstPage = false;
            cursor += sliceH;
          }
        }
      }
    } else if (imgH <= pageContentH) {
      // ブロックなし & 1ページに収まる（成績表）
      pdf.addImage(canvas.toDataURL('image/jpeg', 0.95), 'JPEG', margin, margin, imgW, imgH);
    } else {
      // ブロックなし & 複数ページ（成績表で長い場合）：単純スライス
      let cursor = 0;
      let firstPage = true;
      while (cursor < canvas.height) {
        const remaining = canvas.height - cursor;
        const sliceH = Math.min(pageHeightPx, remaining);
        const slice = document.createElement('canvas');
        slice.width  = canvas.width;
        slice.height = sliceH;
        const sctx = slice.getContext('2d');
        sctx.fillStyle = '#ffffff';
        sctx.fillRect(0, 0, slice.width, slice.height);
        sctx.drawImage(canvas, 0, -cursor);
        const sliceMm = sliceH / pxPerMm;
        if (!firstPage) pdf.addPage();
        pdf.addImage(slice.toDataURL('image/jpeg', 0.95), 'JPEG', margin, margin, imgW, sliceMm);
        firstPage = false;
        cursor += sliceH;
      }
    }

    const blob = pdf.output('blob');
    send({ ok: true, blob });
  } catch (e) {
    send({ ok: false, error: e.message || String(e) });
  }
})();
</scr` + `ipt></body>
</html>`);
      idoc.close();
    });
  },

  /**
   * 対戦表HTML生成
   */
  buildMatchTableHTML(rounds, players, opts = { showGrade: true, showRank: true, assignSenteGote: true }) {
    const { showGrade, showRank, assignSenteGote, ratingMode } = opts;
    const playerMap = {};
    players.forEach(p => { playerMap[p.id] = p; });

    const playerLabel = (name, grade, rank, id) => {
      let s = this._esc(name);
      if (showGrade && grade != null) s += ` <span style="color:#666;font-size:11px;">${this._esc(grade)}年</span>`;
      if (showRank && ratingMode) {
        // レーティングモード：選手の現在のレーティング
        const rating = playerMap[id]?.rating;
        if (!Matching.hasNoRating({ rating })) {
          s += ` <span style="color:#333;font-size:11px;font-weight:bold;">${this._esc(Math.round(Number(rating) * 10) / 10)}</span>`;
        }
      } else if (showRank && rank != null) {
        // rank は S/A/B/C のみ許可
        const safeRank = /^[SABC]$/.test(rank) ? rank : '';
        if (safeRank) s += ` <span class="rank-${safeRank}">${safeRank}</span>`;
      }
      return s;
    };

    const col1 = assignSenteGote ? '先手' : '選手①';
    const col2 = assignSenteGote ? '後手' : '選手②';

    let html = `
      <h1>将棋部内戦 対戦表</h1>
      <p class="subtitle">生成日: ${new Date().toLocaleDateString('ja-JP')}</p>`;

    rounds.forEach(round => {
      // 各回戦を section でラップ。PDF生成時に section 境界でページ分割し、
      // 一つの回戦が複数ページに跨ぐのを防ぐ。
      html += `<section class="pdf-round">
        <h2>第${round.roundNumber}回戦</h2>
        <table>
          <thead>
            <tr>
              <th style="width:5%">No.</th>
              <th style="width:36%">${col1}</th>
              <th style="width:18%">結果</th>
              <th style="width:36%">${col2}</th>
            </tr>
          </thead>
          <tbody>`;

      round.matches.forEach((match, i) => {
        const resultStr = match.result === 'player1' ? '○ — ●'
          : match.result === 'player2'               ? '● — ○'
          : match.result === 'draw'                  ? '△ — △'
          :                                            '— vs —';
        html += `
            <tr>
              <td>${i + 1}</td>
              <td class="name-td">${playerLabel(match.player1Name, match.player1Grade, match.player1Rank, match.player1Id)}</td>
              <td><strong>${resultStr}</strong></td>
              <td class="name-td">${playerLabel(match.player2Name, match.player2Grade, match.player2Rank, match.player2Id)}</td>
            </tr>`;
      });

      html += `</tbody></table>`;

      if (round.byePlayerId && playerMap[round.byePlayerId]) {
        const p = playerMap[round.byePlayerId];
        const meta = showGrade ? `（${this._esc(p.grade)}年）` : '';
        html += `<p class="bye-note">不戦勝: ${this._esc(p.name)}${meta}</p>`;
      }

      html += `</section>`;
    });

    return html;
  },

  /**
   * 成績表HTML生成
   */
  // ============================================
  // リーグ戦
  // ============================================

  _header(title, subtitle) {
    return `<h1>${this._esc(title)}</h1><p class="subtitle">${this._esc(subtitle)}　生成日: ${new Date().toLocaleDateString('ja-JP')}</p>`;
  },

  /**
   * リーグ戦の順位表。data: { title, termLabel, classes: [{ name, rows: [{ pos, name, w, l, d, pts, mark }] }], onePerPage }
   * mark: 'promote' | 'demote' | 'tie' | null（昇級・降級・同点で要プレーオフ）
   */
  exportLeagueStandings(data, opts = {}) {
    const markText = { promote: '▲ 昇級', demote: '▼ 降級', tie: '同点（プレーオフ）' };
    const block = c => `
      <h2>${this._esc(c.name)}</h2>
      <table>
        <thead><tr><th>順位</th><th>選手</th><th>勝</th><th>敗</th><th>分</th><th>Pt</th><th></th></tr></thead>
        <tbody>${c.rows.map(r => `
          <tr><td><strong>${this._esc(r.pos)}</strong></td><td class="name-td">${this._esc(r.name)}</td>
            <td class="win-td">${this._esc(r.w)}</td><td class="loss-td">${this._esc(r.l)}</td><td>${this._esc(r.d)}</td>
            <td class="pt-td">${this._esc(r.pts)}</td>
            <td>${r.mark ? `<span class="${r.mark}">${markText[r.mark]}</span>` : ''}</td></tr>`).join('')}
        </tbody>
      </table>`;
    const html = this._header(data.title, data.termLabel)
      + data.classes.map(c => data.onePerPage ? `<div class="pdf-round">${block(c)}</div>` : block(c)).join('')
      + `<p class="note">勝利2Pt・引き分け1Pt。昇級・降級の印は、順位表タブの昇降級の設定（入替人数・プレーオフの選択）に基づく予定です。</p>`;
    return this._downloadPDF(html, `リーグ順位表_${this._today()}.pdf`, opts);
  },

  /**
   * リーグ戦の対戦表（星取り表）。1階級1ページ。未入力の対局は空欄（手書きで記入できる）。
   * data: { title, termLabel, classes: [{ name, players: [name], cells: [[ 'win'|'loss'|'draw'|null|'self' ]], sums: [{ w, l, d }] }] }
   */
  exportLeagueCrossTables(data, opts = {}) {
    const sym = { win: '○', loss: '●', draw: '△' };
    const html = this._header(data.title, data.termLabel) + data.classes.map(c => `
      <div class="pdf-round">
        <h2>${this._esc(c.name)}（${c.players.length}名）</h2>
        <table class="lx">
          <thead><tr><th class="lx-no"></th><th class="lx-name">選手</th>${c.players.map((_, j) => `<th>${j + 1}</th>`).join('')}<th>勝</th><th>敗</th><th>分</th></tr></thead>
          <tbody>${c.players.map((name, i) => `
            <tr><td class="lx-no">${i + 1}</td><td class="lx-name">${this._esc(name)}</td>
              ${c.cells[i].map(v => v === 'self'
                ? '<td class="lx-diag"></td>'
                : `<td class="lx-cell ${v ? `lx-${v}` : ''}">${v ? sym[v] : ''}</td>`).join('')}
              <td class="lx-sum">${this._esc(c.sums[i].w)}</td><td class="lx-sum">${this._esc(c.sums[i].l)}</td><td class="lx-sum">${this._esc(c.sums[i].d)}</td></tr>`).join('')}
          </tbody>
        </table>
        <p class="note">行の選手から見た結果（○勝ち・●負け・△引き分け）。空欄は未対局です。</p>
      </div>`).join('');
    return this._downloadPDF(html, `リーグ対戦表_${this._today()}.pdf`, opts);
  },

  /**
   * リーグ戦の日程表（節ごと）。1階級1ページ。結果欄は入力済みなら記号、未入力は空欄。
   * data: { title, termLabel, classes: [{ name, rounds: [{ round, games: [{ sente, gote, result }] }] }] }
   */
  exportLeagueSchedule(data, opts = {}) {
    const sym = { p1: '先手勝ち', p2: '後手勝ち', draw: '引き分け' };
    const html = this._header(data.title, data.termLabel) + data.classes.map(c => `
      <div class="pdf-round">
        <h2>${this._esc(c.name)}</h2>
        <table>
          <thead><tr><th style="width:70px">節</th><th>先手</th><th style="width:40px"></th><th>後手</th><th style="width:110px">結果</th></tr></thead>
          <tbody>${c.rounds.map(r => r.games.map((g, gi) => `
            <tr>${gi === 0 ? `<td rowspan="${r.games.length}"><strong>${r.round ? `第${this._esc(r.round)}節` : '追加'}</strong></td>` : ''}
              <td class="name-td">${this._esc(g.sente)}</td><td>vs</td><td class="name-td">${this._esc(g.gote)}</td>
              <td>${g.result ? this._esc(sym[g.result]) : ''}</td></tr>`).join('')).join('')}
          </tbody>
        </table>
        <p class="note">各節で全員が1局ずつ指す組み合わせです（奇数人数の階級は各節1人が休み）。</p>
      </div>`).join('');
    return this._downloadPDF(html, `リーグ日程表_${this._today()}.pdf`, opts);
  },

  /**
   * 個人成績書（1人1ページ）。
   * reports: [{ name, meta: [文字列], summary: [{ label, value }], sections: [{ title, head: [..], rows: [[..]] }] }]
   */
  exportPlayerReports(reports, opts = {}) {
    const html = reports.map((r, i) => `
      <div class="pdf-round">
        <h1>${this._esc(r.name)} 個人成績書</h1>
        <p class="report-meta">${r.meta.map(m => `<span>${this._esc(m)}</span>`).join('')}<span>生成日: ${new Date().toLocaleDateString('ja-JP')}</span></p>
        ${r.summary.length ? `
        <table class="report-summary">
          <thead><tr>${r.summary.map(s => `<th>${this._esc(s.label)}</th>`).join('')}</tr></thead>
          <tbody><tr>${r.summary.map(s => `<td><strong>${this._esc(s.value)}</strong></td>`).join('')}</tr></tbody>
        </table>` : ''}
        ${r.sections.map(sec => `
          <h2>${this._esc(sec.title)}</h2>
          ${sec.rows.length === 0 ? '<p class="note">対局はありません。</p>' : `
          <table>
            <thead><tr>${sec.head.map(h => `<th>${this._esc(h)}</th>`).join('')}</tr></thead>
            <tbody>${sec.rows.map(row => `<tr>${row.map((v, ci) => `<td class="${ci === 1 ? 'name-td' : ''}">${this._esc(v)}</td>`).join('')}</tr>`).join('')}</tbody>
          </table>`}`).join('')}
      </div>`).join('');
    const filename = reports.length === 1 ? `個人成績書_${reports[0].name}_${this._today()}.pdf` : `個人成績書_${this._today()}.pdf`;
    return this._downloadPDF(html, filename, opts);
  },

  buildStandingsHTML(standings, opts = { showPoints: true }) {
    const showPt = opts.showPoints !== false;
    let html = `
      <h1>将棋部内戦 成績表</h1>
      <p class="subtitle">生成日: ${new Date().toLocaleDateString('ja-JP')}</p>
      <table>
        <thead>
          <tr>
            <th>順位</th>
            <th>名前</th>
            <th>学年</th>
            <th>勝</th>
            <th>敗</th>
            <th>分</th>
            <th>不戦勝</th>
            <th>勝率</th>
            ${showPt ? '<th>Pt</th>' : ''}
            <th>ソルコフ</th>
            <th>順位</th>
            <th>ソルコフ−敗数</th>
            <th>順位</th>
          </tr>
        </thead>
        <tbody>`;

    const rankCell = r => (r == null ? '—' : `${this._esc(r)}位`);
    const valueCell = (v, r) => (r == null ? '—' : this._esc(v));
    standings.forEach(s => {
      html += `
          <tr>
            <td><strong>${this._esc(s.position)}</strong></td>
            <td class="name-td"><strong>${this._esc(s.name)}</strong>${s.withdrawn ? '（棄権）' : ''}</td>
            <td>${this._esc(s.grade)}年</td>
            <td class="win-td">${this._esc(s.wins)}</td>
            <td class="loss-td">${this._esc(s.losses)}</td>
            <td>${this._esc(s.draws)}</td>
            <td>${this._esc(s.byes)}</td>
            <td>${this._esc(s.winRate.toFixed(1))}%</td>
            ${showPt ? `<td class="pt-td">${this._esc(s.points)}</td>` : ''}
            <td>${valueCell(s.solkoff, s.solkoffRank)}</td>
            <td>${rankCell(s.solkoffRank)}</td>
            <td>${valueCell(s.solkoffMinusLosses, s.solkoffMinusLossesRank)}</td>
            <td>${rankCell(s.solkoffMinusLossesRank)}</td>
          </tr>`;
    });

    const sum = opts.indexSummary;
    if (sum) {
      const f = v => (v == null ? '—' : this._esc((Math.round(v * 10) / 10).toFixed(1)));
      html += `
          <tr>
            <td colspan="${showPt ? 9 : 8}" style="text-align:right;">平均 ／ 標準偏差</td>
            <td colspan="2">${f(sum.solkoff.mean)} ／ ${f(sum.solkoff.sd)}</td>
            <td colspan="2">${f(sum.solkoffMinusLosses.mean)} ／ ${f(sum.solkoffMinusLosses.sd)}</td>
          </tr>`;
    }
    html += `</tbody></table>
      <p class="subtitle">ソルコフ＝結果が入力された対局の相手の Pt の合計（不戦勝の回戦は含めない）。ソルコフ−敗数＝ソルコフから自分の敗数を引いた値。順位は1局以上対局した選手での順位（同じ値は同順位）、標準偏差は母標準偏差。</p>`;
    return html;
  },

};
