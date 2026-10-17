/**
 * app.js — メインコントローラ
 */

document.addEventListener('DOMContentLoaded', () => {
  // 1. ログインチェック
  const session = AppStorage.getSession();
  if (!session) {
    UI.showLoginScreen();
    return;
  }

  // サーバー側でセッションが無効（期限切れ・他端末でパスワード変更など）ならログイン画面へ
  const backToLogin = () => {
    AppStorage.clearSession();
    window.location.href = window.location.pathname;
  };
  AppStorage.onSessionInvalid = backToLogin;
  AppStorage.validateSession().then(valid => {
    if (valid === false) backToLogin();
  });

  // 2. 部屋チェック
  const params    = new URLSearchParams(window.location.search);
  const roomParam = params.get('room');

  if (!roomParam) {
    UI.showRoomSelector();
    return;
  }

  // 3. メインアプリ起動
  AppStorage.setRoom(roomParam);
  UI.init();

  const rounds = AppStorage.getRounds();
  if (rounds.length > 0) {
    UI.renderMatchingResult();
  }
});
