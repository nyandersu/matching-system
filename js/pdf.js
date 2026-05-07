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
   * html2pdf.js を使ってPDFを生成・ダウンロード
   * 印刷ダイアログは経由しない。
   */
  async _downloadPDF(contentHtml, filename) {
    if (typeof html2pdf === 'undefined') {
      alert('PDF生成ライブラリが読み込まれていません。ページを再読み込みしてください。');
      return;
    }
    // html2canvas はレイアウト済みの DOM を必要とするため、画面外に
    // 実寸（A4横幅相当）で描画用コンテナを生成する。
    // padding/font は元 CSS に準拠。
    const styleTag = `<style>
      .__pdf_root__ * { box-sizing: border-box; margin: 0; padding: 0; }
      .__pdf_root__ {
        font-family: 'Noto Sans JP', 'Hiragino Sans', 'Yu Gothic', sans-serif;
        font-size: 13px;
        color: #1a1a2e;
        background: #fff;
        padding: 24px 28px;
        width: 794px;
      }
      .__pdf_root__ h1 { font-size: 22px; text-align: center; margin-bottom: 4px; }
      .__pdf_root__ .subtitle { text-align: center; color: #666; font-size: 12px; margin-bottom: 20px; }
      .__pdf_root__ h2 {
        font-size: 15px;
        margin: 20px 0 8px;
        padding-bottom: 5px;
        border-bottom: 2px solid #333;
        color: #1a1a2e;
      }
      .__pdf_root__ table { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
      .__pdf_root__ th {
        background: #2d2d44;
        color: #fff;
        font-size: 12px;
        font-weight: 600;
        padding: 8px 10px;
        border: 1px solid #555;
        text-align: center;
      }
      .__pdf_root__ td {
        border: 1px solid #bbb;
        padding: 7px 10px;
        font-size: 12px;
        text-align: center;
        color: #1a1a2e;
        background: #fff;
      }
      .__pdf_root__ tr:nth-child(even) td { background: #f5f5f5; }
      .__pdf_root__ .name-td { text-align: left !important; }
      .__pdf_root__ .win-td  { color: #8a5800; font-weight: bold; }
      .__pdf_root__ .loss-td { color: #c0392b; }
      .__pdf_root__ .pt-td   { font-weight: bold; color: #8a5800; }
      .__pdf_root__ .rank-S  { background:#ffd700; color:#1a1a2e; padding:1px 5px; border-radius:3px; font-weight:bold; font-size:11px; display:inline-block; }
      .__pdf_root__ .rank-A  { background:#e74c3c; color:#fff;    padding:1px 5px; border-radius:3px; font-weight:bold; font-size:11px; display:inline-block; }
      .__pdf_root__ .rank-B  { background:#3498db; color:#fff;    padding:1px 5px; border-radius:3px; font-weight:bold; font-size:11px; display:inline-block; }
      .__pdf_root__ .rank-C  { background:#2ecc71; color:#1a1a2e; padding:1px 5px; border-radius:3px; font-weight:bold; font-size:11px; display:inline-block; }
      .__pdf_root__ .bye-note { color: #888; font-size: 12px; margin: 4px 0 14px; }
    </style>`;

    // 既存のPDFコンテナがあれば削除
    const existing = document.getElementById('__pdf_container__');
    if (existing) existing.remove();

    const container = document.createElement('div');
    container.id = '__pdf_container__';
    container.className = '__pdf_root__';
    container.style.position = 'absolute';
    container.style.left = '-99999px';
    container.style.top = '0';
    container.style.zIndex = '-1';
    container.innerHTML = styleTag + contentHtml;
    document.body.appendChild(container);

    try {
      await html2pdf().set({
        margin:      [10, 10, 10, 10],
        filename,
        image:       { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
        jsPDF:       { unit: 'mm', format: 'a4', orientation: 'portrait' },
        pagebreak:   { mode: ['avoid-all', 'css', 'legacy'] },
      }).from(container).save();
    } catch (e) {
      console.error('[PDF] generation failed:', e);
      alert('PDFの生成に失敗しました: ' + (e.message || e));
    } finally {
      if (container.parentNode) container.parentNode.removeChild(container);
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

};
