/**
 * app.js — メインコントローラ
 */

document.addEventListener('DOMContentLoaded', () => {
  const params    = new URLSearchParams(window.location.search);
  const roomParam = params.get('room');

  if (!roomParam) {
    // 部屋が指定されていなければ部屋選択画面を表示
    UI.showRoomSelector();
  } else {
    AppStorage.setRoom(roomParam);
    UI.init();

    // 初回表示時に保存済みマッチングがあれば表示
    const rounds = AppStorage.getRounds();
    if (rounds.length > 0) {
      UI.renderMatchingResult();
    }
  }
});
