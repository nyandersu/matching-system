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
  async _downloadPDF(contentHtml, filename) {
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
        width: 794px;
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
      width: 800px; height: 1px; border: 0;
      position: fixed; right: 0; bottom: 0;
      overflow: hidden;
      pointer-events: none;
    `;
    document.body.appendChild(iframe);

    try {
      const blob = await this._renderPdfInIframe(iframe, contentHtml, styleCss);
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
  _renderPdfInIframe(iframe, contentHtml, styleCss) {
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

    const canvas = await html2canvas(document.body, {
      scale: 2,
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
    const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const margin = 10;
    const imgW = pageW - margin * 2;
    const imgH = canvas.height * imgW / canvas.width;

    if (imgH <= pageH - margin * 2) {
      pdf.addImage(canvas.toDataURL('image/jpeg', 0.95), 'JPEG', margin, margin, imgW, imgH);
    } else {
      const pageContentH = pageH - margin * 2;
      const pxPerMm = canvas.width / imgW;
      const sliceHeightPx = Math.floor(pageContentH * pxPerMm);
      let cursor = 0;
      let first = true;
      while (cursor < canvas.height) {
        const remaining = canvas.height - cursor;
        const sliceH = Math.min(sliceHeightPx, remaining);
        const slice = document.createElement('canvas');
        slice.width = canvas.width;
        slice.height = sliceH;
        const sctx = slice.getContext('2d');
        sctx.fillStyle = '#ffffff';
        sctx.fillRect(0, 0, slice.width, slice.height);
        sctx.drawImage(canvas, 0, -cursor);
        const sliceMm = sliceH / pxPerMm;
        if (!first) pdf.addPage();
        pdf.addImage(slice.toDataURL('image/jpeg', 0.95), 'JPEG', margin, margin, imgW, sliceMm);
        first = false;
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
    const { showGrade, showRank, assignSenteGote } = opts;
    const playerMap = {};
    players.forEach(p => { playerMap[p.id] = p; });

    const playerLabel = (name, grade, rank) => {
      let s = this._esc(name);
      if (showGrade && grade != null) s += ` <span style="color:#666;font-size:11px;">${this._esc(grade)}年</span>`;
      if (showRank  && rank  != null) {
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
      html += `<h2>第${round.roundNumber}回戦</h2>
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
              <td class="name-td">${playerLabel(match.player1Name, match.player1Grade, match.player1Rank)}</td>
              <td><strong>${resultStr}</strong></td>
              <td class="name-td">${playerLabel(match.player2Name, match.player2Grade, match.player2Rank)}</td>
            </tr>`;
      });

      html += `</tbody></table>`;

      if (round.byePlayerId && playerMap[round.byePlayerId]) {
        const p = playerMap[round.byePlayerId];
        const meta = showGrade ? `（${this._esc(p.grade)}年）` : '';
        html += `<p class="bye-note">不戦勝: ${this._esc(p.name)}${meta}</p>`;
      }
    });

    return html;
  },

  /**
   * 成績表HTML生成
   */
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
          </tr>
        </thead>
        <tbody>`;

    standings.forEach(s => {
      html += `
          <tr>
            <td><strong>${this._esc(s.position)}</strong></td>
            <td class="name-td"><strong>${this._esc(s.name)}</strong></td>
            <td>${this._esc(s.grade)}年</td>
            <td class="win-td">${this._esc(s.wins)}</td>
            <td class="loss-td">${this._esc(s.losses)}</td>
            <td>${this._esc(s.draws)}</td>
            <td>${this._esc(s.byes)}</td>
            <td>${this._esc(s.winRate.toFixed(1))}%</td>
            ${showPt ? `<td class="pt-td">${this._esc(s.points)}</td>` : ''}
          </tr>`;
    });

    html += `</tbody></table>`;
    return html;
  },

};
