const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const RESELLER_ID = '61316705e4b0295f87dae396';
const BASE_URL = 'https://cf.streann.tech';

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'es-419,es;q=0.9,en;q=0.8',
  'Origin': 'https://www.app.tdmax.com',
  'Referer': 'https://www.app.tdmax.com/',
  'x-app-name': 'TDMAX',
  'x-app-platform': 'web',
  'x-app-version': '3.1.1',
};

async function login(email: string, password: string) {
  const resp = await fetch(
    `${BASE_URL}/web/services/v3/external/login?r=${RESELLER_ID}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...BROWSER_HEADERS },
      body: JSON.stringify({ username: email.toLowerCase(), password }),
    },
  );
  const data = await resp.json();
  if (data.errorMessage) throw new Error(`Login: ${data.errorMessage}`);
  const accessToken = data.accessToken || data.access_token;
  if (!accessToken) throw new Error('Sin accessToken');
  return { accessToken, userId: data.id || data.userId || data._id || null, raw: data };
}

// Probamos varios endpoints conocidos/probables del cliente web TDMax.
// Devolvemos el primero que responda con HTTP 200 + cuerpo JSON parseable.
async function fetchDevices(accessToken: string, userId: string | null) {
  const authHeaders = { ...BROWSER_HEADERS, 'Authorization': `Bearer ${accessToken}` };
  const qs = (extra: Record<string, string> = {}) =>
    new URLSearchParams({ r: RESELLER_ID, access_token: accessToken, ...extra }).toString();

  const candidates: { label: string; url: string }[] = [
    { label: 'v3/external/devices', url: `${BASE_URL}/web/services/v3/external/devices?${qs()}` },
    { label: 'v3/external/user/devices', url: `${BASE_URL}/web/services/v3/external/user/devices?${qs()}` },
    { label: 'v3/external/users/me/devices', url: `${BASE_URL}/web/services/v3/external/users/me/devices?${qs()}` },
    { label: 'v3/external/sessions', url: `${BASE_URL}/web/services/v3/external/sessions?${qs()}` },
    { label: 'v1/external/devices', url: `${BASE_URL}/web/services/v1/external/devices?${qs()}` },
  ];
  if (userId) {
    candidates.unshift({
      label: 'v3/external/users/{id}/devices',
      url: `${BASE_URL}/web/services/v3/external/users/${userId}/devices?${qs()}`,
    });
  }

  const attempts: Array<{ label: string; status: number; ok: boolean; preview: string }> = [];

  for (const c of candidates) {
    try {
      const r = await fetch(c.url, { headers: authHeaders });
      const text = await r.text();
      attempts.push({ label: c.label, status: r.status, ok: r.ok, preview: text.slice(0, 300) });
      if (r.ok) {
        try {
          const json = JSON.parse(text);
          return { found: true, endpoint: c.label, devices: json, attempts };
        } catch {
          // continúa probando
        }
      }
    } catch (err) {
      attempts.push({ label: c.label, status: 0, ok: false, preview: String((err as Error).message) });
    }
  }
  return { found: false, endpoint: null, devices: null, attempts };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const accounts = [
    { key: 'default', label: 'arlopfa@gmail.com', email: Deno.env.get('TDMAX_EMAIL'), password: Deno.env.get('TDMAX_PASSWORD') },
    { key: 'pi', label: 'info@media.cr', email: Deno.env.get('TDMAX_EMAIL_PI'), password: Deno.env.get('TDMAX_PASSWORD_PI') },
  ];

  const results: any[] = [];
  for (const acc of accounts) {
    if (!acc.email || !acc.password) {
      results.push({ account: acc.key, label: acc.label, error: 'credenciales faltantes' });
      continue;
    }
    try {
      const { accessToken, userId, raw } = await login(acc.email, acc.password);
      const dev = await fetchDevices(accessToken, userId);
      results.push({
        account: acc.key,
        label: acc.label,
        login_ok: true,
        user_id: userId,
        ...dev,
        login_keys: Object.keys(raw || {}),
      });
    } catch (err) {
      results.push({ account: acc.key, label: acc.label, login_ok: false, error: (err as Error).message });
    }
  }

  return new Response(JSON.stringify({ results }, null, 2), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});