# 将棋部内戦マッチングシステム

部内戦の対戦組み合わせ自動生成・結果入力・成績管理を行うWebアプリ。機能の詳細は `MANUAL.md`。

## 構成

- ビルド工程なしの素の HTML / CSS / JavaScript(`index.html` から `js/*.js` を読み込む)。PWA(`manifest.json`, `service-worker.js`)
- `js/`
  - `app.js` — エントリ / `ui.js` — 画面描画
  - `matching.js` — マッチング生成(ランダム・スイスドロー、先後均等化)
  - `league.js` / `leagueLogic.js` — リーグ戦・レーティング
  - `storage.js` — LocalStorage と Supabase の同期(部屋 roomId ごとにデータを分離、RLS 前提)
  - `pdf.js` — 対戦表・成績表のPDF出力
- `supabase/migrations/` — DBスキーマ変更のSQL(ファイル名の日時順に適用)
- `middleware.js` — Vercel Middleware(現在はパススルー)
- デプロイ先は Vercel。`.vercelignore` で `tests/` `supabase/` `.github/` を配信対象から外している

## コマンド

```bash
node --test 'tests/*.test.js'   # テスト(依存パッケージなし、Node 22)
```

- CI(`.github/workflows/test.yml`)が main への push と PR で上記テストを実行する
- `tests/` は1分以上かかることがある

## 注意

- DBスキーマを変えるときは `supabase/migrations/` に新しい日時のファイルを追加する(既存ファイルは書き換えない)
- `storage.js` の Supabase キーは公開用(publishable)キー。アクセス制御は RLS 側で行う
