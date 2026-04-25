/**
 * pdf.js — PDF出力モジュール
 * ブラウザネイティブの印刷ダイアログを使用（html2canvas 依存を廃止）
 * Chrome/Edge: 「送信先」→「PDF に保存」
 * Safari: 「PDF」→「PDF として保存」
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

  /**
   * 対戦表をPDFとしてエクスポート
   */
  exportMatchTable(rounds, players, opts = { showGrade: true, showRank: true }) {
    const html = this.buildMatchTableHTML(rounds, players, opts);
    this._openPrintWindow(html, '対戦表');
  },

  /**
   * 成績表をPDFとしてエクスポート
   */
  exportStandings(standings, opts = { showPoints: true }) {
    const html = this.buildStandingsHTML(standings, opts);
    this._openPrintWindow(html, '成績表');
  },

  /**
   * 印刷ダイアログを開く
   * 非表示iframeを使うことで、ポップアップブロッカー / CSP / window.open=null
   * といったブラウザ依存の不具合を完全に回避する。
   * 印刷後はiframeを自動削除。
   */
  _openPrintWindow(contentHtml, title) {
    const css = `
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        font-family: 'Noto Sans JP', 'Hiragino Sans', 'Yu Gothic', sans-serif;
        font-size: 13px;
        color: #1a1a2e;
        background: #fff;
        padding: 24px 28px;
      }
      h1 { font-size: 22px; text-align: center; margin-bottom: 4px; }
      .subtitle { text-align: center; color: #666; font-size: 12px; margin-bottom: 20px; }
      h2 {
        font-size: 15px;
        margin: 20px 0 8px;
        padding-bottom: 5px;
        border-bottom: 2px solid #333;
        color: #1a1a2e;
      }
      table { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
      th {
        background: #2d2d44;
        color: #fff;
        font-size: 12px;
        font-weight: 600;
        padding: 8px 10px;
        border: 1px solid #555;
        text-align: center;
      }
      td {
        border: 1px solid #bbb;
        padding: 7px 10px;
        font-size: 12px;
        text-align: center;
        color: #1a1a2e;
        background: #fff;
      }
      tr:nth-child(even) td { background: #f5f5f5; }
      .name-td { text-align: left !important; }
      .win-td  { color: #8a5800; font-weight: bold; }
      .loss-td { color: #c0392b; }
      .pt-td   { font-weight: bold; color: #8a5800; }
      .rank-S  { background:#ffd700; color:#1a1a2e; padding:1px 5px; border-radius:3px; font-weight:bold; font-size:11px; display:inline-block; }
      .rank-A  { background:#e74c3c; color:#fff;    padding:1px 5px; border-radius:3px; font-weight:bold; font-size:11px; display:inline-block; }
      .rank-B  { background:#3498db; color:#fff;    padding:1px 5px; border-radius:3px; font-weight:bold; font-size:11px; display:inline-block; }
      .rank-C  { background:#2ecc71; color:#1a1a2e; padding:1px 5px; border-radius:3px; font-weight:bold; font-size:11px; display:inline-block; }
      .bye-note { color: #888; font-size: 12px; margin: 4px 0 14px; }
      @page { margin: 12mm; size: A4 portrait; }
    `;

    const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <style>${css}</style>
</head>
<body>${contentHtml}</body>
</html>`;

    // 既存の印刷用iframeがあれば削除
    const existing = document.getElementById('__print_frame__');
    if (existing) existing.remove();

    // 非表示iframeを作成
    const iframe = document.createElement('iframe');
    iframe.id = '__print_frame__';
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    iframe.setAttribute('aria-hidden', 'true');
    document.body.appendChild(iframe);

    const doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open();
    doc.write(html);
    doc.close();

    let printed = false;
    const triggerPrint = () => {
      if (printed) return;
      printed = true;
      try {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
      } catch (e) {
        console.error('[PDF] print failed:', e);
        alert('印刷ダイアログを開けませんでした: ' + (e.message || e));
      }
      // 印刷ダイアログが閉じた後にiframeを削除（少し待つ）
      setTimeout(() => {
        if (iframe && iframe.parentNode) iframe.parentNode.removeChild(iframe);
      }, 1500);
    };

    // iframeのload完了を待ってから印刷を発火
    if (doc.readyState === 'complete') {
      setTimeout(triggerPrint, 50);
    } else {
      iframe.addEventListener('load', () => setTimeout(triggerPrint, 50), { once: true });
      // 念のためフォールバック（古いブラウザでloadが発火しない場合）
      setTimeout(triggerPrint, 800);
    }
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

  // 旧API互換
  printContent(html) { this._openPrintWindow(html, '印刷'); },
};
