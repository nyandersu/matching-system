const SUPABASE_URL = 'https://nwxpgvefyjzabuwdtrii.supabase.co';
const SUPABASE_KEY = 'sb_publishable_jI0RZ1qkuXdOeacCNX928A_m8dRQGwV';
const VALID_USER = 'shogi';

async function sha256hex(text) {
  const encoded = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export default async function middleware(request) {
  const authorization = request.headers.get('authorization');

  if (authorization) {
    const basicAuth = authorization.split(' ')[1];
    const [user, password] = atob(basicAuth).split(':');

    if (user === VALID_USER) {
      try {
        const res = await fetch(
          `${SUPABASE_URL}/rest/v1/settings?id=eq.global&select=admin_password_hash`,
          {
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${SUPABASE_KEY}`,
            },
          }
        );
        const rows = await res.json();
        if (rows.length > 0 && rows[0].admin_password_hash) {
          const inputHash = await sha256hex(password);
          if (inputHash === rows[0].admin_password_hash) {
            return; // 認証成功
          }
        }
      } catch (e) {
        console.error('Auth check failed:', e);
      }
    }
  }

  return new Response('Auth required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Shogi Admin"',
    },
  });
}
