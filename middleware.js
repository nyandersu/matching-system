export default function middleware(request) {
  // すでに認証ヘッダーがあるかチェック
  const authorization = request.headers.get('authorization');

  if (authorization) {
    // Basic認証のヘッダーを解析 (Basic <base64>)
    const basicAuth = authorization.split(' ')[1];
    const [user, password] = atob(basicAuth).split(':');

    // === ここでIDとパスワードを設定 ===
    // ※Vercelの環境変数を使うこともできますが、今回はシンプルに直書きしています
    const VALID_USER = 'shogi';
    const VALID_PASSWORD = 'password';

    // IDとパスワードが一致すればアクセスを許可
    if (user === VALID_USER && password === VALID_PASSWORD) {
      return; // そのまま本来のページ(index.html)を表示
    }
  }

  // 認証がない・または間違っている場合は401を返し、入力プロンプトを出す
  return new Response('Auth required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Secure Area"',
    },
  });
}
