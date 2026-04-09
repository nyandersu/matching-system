/**
 * app.js — メインコントローラ
 */

document.addEventListener('DOMContentLoaded', () => {
  UI.init();

  // 初回表示時に保存済みマッチングがあれば表示
  const rounds = AppStorage.getRounds();
  if (rounds.length > 0) {
    UI.renderMatchingResult();
  }
});
