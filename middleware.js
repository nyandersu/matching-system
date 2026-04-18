/**
 * middleware.js
 * 認証はアプリ側（ログイン画面）で管理するため、ミドルウェアはパススルー
 */

// 静的ファイルはそのまま通す
export default function middleware(_request) {
  return; // 全リクエストを通過させる
}
