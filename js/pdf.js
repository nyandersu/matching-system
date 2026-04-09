/**
 * pdf.js — PDF出力・印刷モジュール
 */

const PDF = {
  /**
   * 対戦表をPDFとしてエクスポート
   */
  async exportMatchTable(rounds, players) {
    const container = document.createElement('div');
    container.className = 'pdf-export';
    container.innerHTML = this.buildMatchTableHTML(rounds, players);
    
    document.body.appendChild(container);

    const opt = {
      margin: 10,
      filename: '対戦表.pdf',
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
    };

    try {
      await html2pdf().set(opt).from(container).save();
    } catch (e) {
      console.error('PDF生成エラー:', e);
      // フォールバック: 印刷ダイアログ
      this.printContent(container.innerHTML);
    } finally {
      document.body.removeChild(container);
    }
  },

  /**
   * 成績表をPDFとしてエクスポート
   */
  async exportStandings(standings) {
    const container = document.createElement('div');
    container.className = 'pdf-export';
    container.innerHTML = this.buildStandingsHTML(standings);

    document.body.appendChild(container);

    const opt = {
      margin: 10,
      filename: '成績表.pdf',
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
    };

    try {
      await html2pdf().set(opt).from(container).save();
    } catch (e) {
      console.error('PDF生成エラー:', e);
      this.printContent(container.innerHTML);
    } finally {
      document.body.removeChild(container);
    }
  },

  /**
   * 印刷フォールバック
   */
  printContent(html) {
    const win = window.open('', '_blank');
    win.document.write(`
      <html>
      <head>
        <title>印刷</title>
        <style>
          body { font-family: 'Noto Sans JP', sans-serif; padding: 20px; color: #1a1a2e; }
          table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
          th, td { border: 1px solid #333; padding: 8px 12px; text-align: center; }
          th { background: #2d2d44; color: #fff; }
          tr:nth-child(even) { background: #f5f5f5; }
          h1, h2, h3 { color: #1a1a2e; }
          .rank-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-weight: bold; }
          .rank-S { background: #ffd700; color: #1a1a2e; }
          .rank-A { background: #e74c3c; color: #fff; }
          .rank-B { background: #3498db; color: #fff; }
          .rank-C { background: #2ecc71; color: #fff; }
        </style>
      </head>
      <body>${html}</body>
      </html>
    `);
    win.document.close();
    win.print();
  },

  /**
   * 対戦表HTML生成
   */
  buildMatchTableHTML(rounds, players) {
    const playerMap = {};
    players.forEach(p => playerMap[p.id] = p);

    let html = `
      <div style="text-align:center;margin-bottom:20px;">
        <h1 style="font-size:24px;margin:0;">将棋部内戦 対戦表</h1>
        <p style="color:#666;font-size:14px;">生成日: ${new Date().toLocaleDateString('ja-JP')}</p>
      </div>
    `;

    rounds.forEach(round => {
      html += `<h2 style="font-size:18px;margin:15px 0 8px;">第${round.roundNumber}回戦</h2>`;
      html += `<table>
        <thead>
          <tr>
            <th style="width:5%">No.</th>
            <th style="width:35%">先手</th>
            <th style="width:20%">結果</th>
            <th style="width:35%">後手</th>
          </tr>
        </thead>
        <tbody>`;

      round.matches.forEach((match, i) => {
        const resultStr = match.result === 'player1' ? '○ — ●'
          : match.result === 'player2' ? '● — ○'
          : match.result === 'draw' ? '△ — △'
          : '— vs —';

        html += `
          <tr>
            <td>${i + 1}</td>
            <td>${match.player1Name}（${match.player1Grade}年）</td>
            <td style="font-weight:bold;">${resultStr}</td>
            <td>${match.player2Name}（${match.player2Grade}年）</td>
          </tr>`;
      });

      html += `</tbody></table>`;

      if (round.byePlayerId && playerMap[round.byePlayerId]) {
        const byeP = playerMap[round.byePlayerId];
        html += `<p style="color:#888;font-size:13px;">不戦: ${byeP.name}（${byeP.grade}年）</p>`;
      }
    });

    return html;
  },

  /**
   * 成績表HTML生成
   */
  buildStandingsHTML(standings) {
    let html = `
      <div style="text-align:center;margin-bottom:20px;">
        <h1 style="font-size:24px;margin:0;">将棋部内戦 成績表</h1>
        <p style="color:#666;font-size:14px;">生成日: ${new Date().toLocaleDateString('ja-JP')}</p>
      </div>
      <table>
        <thead>
          <tr>
            <th>順位</th>
            <th>名前</th>
            <th>学年</th>
            <th>勝</th>
            <th>敗</th>
            <th>分</th>
            <th>不戦</th>
            <th>勝率</th>
            <th>ポイント</th>
          </tr>
        </thead>
        <tbody>`;

    standings.forEach(s => {
      html += `
        <tr>
          <td style="font-weight:bold;">${s.position}</td>
          <td>${s.name}</td>
          <td>${s.grade}年</td>
          <td>${s.wins}</td>
          <td>${s.losses}</td>
          <td>${s.draws}</td>
          <td>${s.byes}</td>
          <td>${s.winRate.toFixed(1)}%</td>
          <td style="font-weight:bold;">${s.points}</td>
        </tr>`;
    });

    html += `</tbody></table>`;
    return html;
  }
};
