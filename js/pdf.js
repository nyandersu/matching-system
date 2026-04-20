/**
 * pdf.js — PDF出力・印刷モジュール
 */

const PDF = {
  // 共通テーブルスタイル（inline でダークテーマの干渉を防ぐ）
  _TH: 'border:1px solid #aaa;padding:8px 10px;text-align:center;background:#2d2d44;color:#fff;font-size:12px;font-weight:600;',
  _TD: 'border:1px solid #aaa;padding:7px 10px;text-align:center;font-size:12px;color:#1a1a2e;background:#fff;',
  _TD_ALT: 'border:1px solid #aaa;padding:7px 10px;text-align:center;font-size:12px;color:#1a1a2e;background:#f7f7f7;',

  /**
   * 対戦表をPDFとしてエクスポート
   */
  async exportMatchTable(rounds, players, opts = { showGrade: true, showRank: true }) {
    const html = this.buildMatchTableHTML(rounds, players, opts);
    await this._generatePDF(html, '対戦表');
  },

  /**
   * 成績表をPDFとしてエクスポート
   */
  async exportStandings(standings) {
    const html = this.buildStandingsHTML(standings);
    await this._generatePDF(html, '成績表');
  },

  /**
   * html2pdf でPDF生成。失敗時は印刷ダイアログにフォールバック
   */
  async _generatePDF(contentHtml, filename) {
    // コンテナを position:fixed; top:0; left:0 で viewport に配置
    // opacity は使わない（opacity:0 だと html2canvas が透明キャンバスを生成してしまう）
    // z-index:-9999 でページの背面に置き、ユーザーには見えないようにする
    const container = document.createElement('div');
    Object.assign(container.style, {
      position:   'fixed',
      top:        '0',
      left:       '0',
      zIndex:     '-9999',
      background: '#fff',
      color:      '#1a1a2e',
      padding:    '20px',
      width:      '740px',
      fontFamily: "'Noto Sans JP', 'Hiragino Sans', sans-serif",
      fontSize:   '13px',
      lineHeight: '1.5',
    });
    container.innerHTML = contentHtml;
    document.body.appendChild(container);

    const opt = {
      margin:      [8, 8, 8, 8],
      filename:    `${filename}.pdf`,
      image:       { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true, logging: false, backgroundColor: '#ffffff' },
      jsPDF:       { unit: 'mm', format: 'a4', orientation: 'portrait' },
    };

    try {
      if (typeof html2pdf === 'undefined') throw new Error('html2pdf未ロード');
      await html2pdf().set(opt).from(container).save();
    } catch (e) {
      console.warn('html2pdf失敗、印刷ダイアログに切り替えます:', e);
      this._printContent(contentHtml, filename);
    } finally {
      if (container.parentNode) document.body.removeChild(container);
    }
  },

  /**
   * 印刷ダイアログ（フォールバック）
   */
  _printContent(html, title = '印刷') {
    const win = window.open('', '_blank');
    if (!win) { alert('ポップアップがブロックされました。ブラウザの設定を確認してください。'); return; }
    win.document.write(`<!DOCTYPE html><html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: 'Noto Sans JP', 'Hiragino Sans', sans-serif; margin: 20px; color: #1a1a2e; background: #fff; font-size: 13px; }
    h1 { font-size: 22px; text-align: center; margin: 0 0 4px; }
    h2 { font-size: 16px; margin: 18px 0 8px; border-bottom: 2px solid #333; padding-bottom: 4px; }
    p  { margin: 4px 0; color: #666; font-size: 12px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
    th, td { border: 1px solid #aaa; padding: 7px 10px; text-align: center; font-size: 12px; }
    th { background: #2d2d44; color: #fff; font-weight: 600; }
    tr:nth-child(even) td { background: #f7f7f7; }
    .rank-S { background:#ffd700; color:#1a1a2e; padding:1px 5px; border-radius:3px; font-weight:bold; font-size:11px; }
    .rank-A { background:#e74c3c; color:#fff; padding:1px 5px; border-radius:3px; font-weight:bold; font-size:11px; }
    .rank-B { background:#3498db; color:#fff; padding:1px 5px; border-radius:3px; font-weight:bold; font-size:11px; }
    .rank-C { background:#2ecc71; color:#1a1a2e; padding:1px 5px; border-radius:3px; font-weight:bold; font-size:11px; }
    @page { margin: 15mm; size: A4 portrait; }
  </style>
</head>
<body>${html}</body>
</html>`);
    win.document.close();
    win.onload = () => { win.focus(); win.print(); };
  },

  /**
   * 対戦表HTML生成
   */
  buildMatchTableHTML(rounds, players, opts = { showGrade: true, showRank: true }) {
    const { showGrade, showRank } = opts;
    const playerMap = {};
    players.forEach(p => { playerMap[p.id] = p; });

    const rankStyle = {
      S: 'background:#ffd700;color:#1a1a2e;padding:1px 5px;border-radius:3px;font-weight:bold;font-size:11px;',
      A: 'background:#e74c3c;color:#fff;padding:1px 5px;border-radius:3px;font-weight:bold;font-size:11px;',
      B: 'background:#3498db;color:#fff;padding:1px 5px;border-radius:3px;font-weight:bold;font-size:11px;',
      C: 'background:#2ecc71;color:#1a1a2e;padding:1px 5px;border-radius:3px;font-weight:bold;font-size:11px;',
    };

    const playerLabel = (name, grade, rank) => {
      let label = `<span style="color:#1a1a2e;">${name}</span>`;
      if (showGrade && grade != null) label += ` <span style="color:#666;font-size:11px;">${grade}年</span>`;
      if (showRank  && rank  != null) label += ` <span style="${rankStyle[rank] || ''}">${rank}</span>`;
      return label;
    };

    const TH  = this._TH;
    const TD  = this._TD;
    const TDA = this._TD_ALT;

    let html = `
      <div style="text-align:center;margin-bottom:16px;">
        <h1 style="font-size:22px;margin:0;color:#1a1a2e;">将棋部内戦 対戦表</h1>
        <p style="color:#666;font-size:12px;margin-top:4px;">生成日: ${new Date().toLocaleDateString('ja-JP')}</p>
      </div>`;

    rounds.forEach(round => {
      html += `<h2 style="font-size:16px;margin:16px 0 8px;color:#1a1a2e;border-bottom:2px solid #333;padding-bottom:4px;">第${round.roundNumber}回戦</h2>`;
      html += `<table style="width:100%;border-collapse:collapse;margin-bottom:8px;">
        <thead>
          <tr>
            <th style="${TH}width:5%;">No.</th>
            <th style="${TH}width:36%;">先手</th>
            <th style="${TH}width:18%;">結果</th>
            <th style="${TH}width:36%;">後手</th>
          </tr>
        </thead>
        <tbody>`;

      round.matches.forEach((match, i) => {
        const td = i % 2 === 0 ? TD : TDA;
        const resultStr = match.result === 'player1' ? '○ — ●'
          : match.result === 'player2'               ? '● — ○'
          : match.result === 'draw'                  ? '△ — △'
          :                                            '— vs —';

        html += `
          <tr>
            <td style="${td}">${i + 1}</td>
            <td style="${td}text-align:left;">${playerLabel(match.player1Name, match.player1Grade, match.player1Rank)}</td>
            <td style="${td}font-weight:bold;">${resultStr}</td>
            <td style="${td}text-align:left;">${playerLabel(match.player2Name, match.player2Grade, match.player2Rank)}</td>
          </tr>`;
      });

      html += `</tbody></table>`;

      if (round.byePlayerId && playerMap[round.byePlayerId]) {
        const byeP = playerMap[round.byePlayerId];
        const byeMeta = showGrade ? `（${byeP.grade}年）` : '';
        html += `<p style="color:#888;font-size:12px;margin:4px 0 12px;">不戦勝: ${byeP.name}${byeMeta}</p>`;
      }
    });

    return html;
  },

  /**
   * 成績表HTML生成
   */
  buildStandingsHTML(standings) {
    const TH  = this._TH;
    const TD  = this._TD;
    const TDA = this._TD_ALT;

    let html = `
      <div style="text-align:center;margin-bottom:16px;">
        <h1 style="font-size:22px;margin:0;color:#1a1a2e;">将棋部内戦 成績表</h1>
        <p style="color:#666;font-size:12px;margin-top:4px;">生成日: ${new Date().toLocaleDateString('ja-JP')}</p>
      </div>
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr>
            <th style="${TH}">順位</th>
            <th style="${TH}">名前</th>
            <th style="${TH}">学年</th>
            <th style="${TH}">勝</th>
            <th style="${TH}">敗</th>
            <th style="${TH}">分</th>
            <th style="${TH}">不戦勝</th>
            <th style="${TH}">勝率</th>
            <th style="${TH}">Pt</th>
          </tr>
        </thead>
        <tbody>`;

    standings.forEach((s, i) => {
      const td = i % 2 === 0 ? TD : TDA;
      html += `
        <tr>
          <td style="${td}font-weight:bold;">${s.position}</td>
          <td style="${td}text-align:left;font-weight:600;">${s.name}</td>
          <td style="${td}">${s.grade}年</td>
          <td style="${td}color:#c47f17;font-weight:bold;">${s.wins}</td>
          <td style="${td}color:#c0392b;">${s.losses}</td>
          <td style="${td}">${s.draws}</td>
          <td style="${td}">${s.byes}</td>
          <td style="${td}">${s.winRate.toFixed(1)}%</td>
          <td style="${td}font-weight:bold;color:#c47f17;">${s.points}</td>
        </tr>`;
    });

    html += `</tbody></table>`;
    return html;
  },

  // 旧API互換（呼び出し元が printContent を直接使っている場合）
  printContent(html) { this._printContent(html); },
};
