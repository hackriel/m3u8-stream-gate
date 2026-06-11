const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const RESELLER_ID = '61316705e4b0295f87dae396';
const BASE_URL = 'https://cf.streann.tech';

const CHANNEL_MAP: Record<string, string> = {
  '641cba02e4b068d89b2344e3': 'FUTV',
  '664237788f085ac1f2a15f81': 'FOX',
  '66608d188f0839b8a740cfe9': 'TDmas 1',
  '617c2f66e4b045a692106126': 'Teletica',
  '65d7aca4e4b0140cbf380bd0': 'Canal 6',
  '664e5de58f089fa849a58697': 'Multimedios',
  '61a8c0e8e4b010fa97ffde55': 'Evento Alterno',
  '6a10a6a2350cb5151ab6ca8c': 'FOX+',
};

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'es-419,es;q=0.9,en;q=0.8',
  'Origin': 'https://www.app.tdmax.com',
  'Referer': 'https://www.app.tdmax.com/',
  // Required by TDMax loadbalancer since May 2026. Without these the
  // service responds code 628 "redirect url is null or empty 1".
  'x-app-name': 'TDMAX',
  'x-app-platform': 'web',
  'x-app-version': '3.1.1',
};

// Deterministic device-id derived from process_id. Must match server.js
// getDeviceIdForProcess() so the same channel always uses the same TDMax device,
// avoiding cross-invalidation between channels that share an account.
async function deviceIdForProcess(processId: string | null | undefined): Promise<string> {
  if (!processId) return 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
  const data = new TextEncoder().encode(`tdmax-device-v1-${processId}`);
  const buf = await crypto.subtle.digest('SHA-1', data);
  const hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20,32)}`;
}

// Login and return accessToken
async function loginAndGetToken(email: string, password: string): Promise<{ accessToken: string }> {
  const loginResp = await fetch(
    `${BASE_URL}/web/services/v3/external/login?r=${RESELLER_ID}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...BROWSER_HEADERS,
      },
      body: JSON.stringify({
        username: email.toLowerCase(),
        password: password,
      }),
    }
  );

  const loginData = await loginResp.json();

  if (loginData.errorMessage) {
    throw new Error(`Login error: ${loginData.errorMessage}`);
  }

  const accessToken = loginData.accessToken || loginData.access_token;
  if (!accessToken) {
    throw new Error('No se obtuvo token de acceso');
  }
  return { accessToken };
}

// Use an existing token to get stream URL for a channel
async function getStreamUrl(channelId: string, accessToken: string, deviceId: string, deviceName: string): Promise<string> {
  // TDMax web app now uses dashed/snake_case query params. The old camelCase
  // names can return code 628: "redirect url is null or empty".
  const lbParams = new URLSearchParams({
    r: RESELLER_ID,
    'device-id': deviceId,
    access_token: accessToken,
    country_code: 'CR',
    doNotUseRedirect: 'true',
    'device-name': deviceName,
    'device-type': 'web',
  });
  const lbUrl = `${BASE_URL}/loadbalancer/services/v1/channels-secure/${channelId}/playlist.m3u8?${lbParams.toString()}`;

  const lbResp = await fetch(lbUrl, {
    headers: {
      ...BROWSER_HEADERS,
      'Authorization': `Bearer ${accessToken}`,
    },
  });

  if (!lbResp.ok) {
    const errorText = await lbResp.text();
    throw new Error(`Error obteniendo stream: ${lbResp.status} - ${errorText.substring(0, 200)}`);
  }

  const lbData = await lbResp.json();
  const streamUrl = lbData.url;

  if (!streamUrl) {
    throw new Error('No se encontró URL de stream');
  }

  // Rechazar placeholder/VOD ("canal no disponible")
  if (/(cfvod\.streann\.tech|isVodPlaylist=true|not[_-]?available|unavailable|offline|placeholder|slate|barker)/i.test(streamUrl)) {
    throw new Error(`TDMax devolvió placeholder/VOD en lugar de señal live: ${streamUrl.substring(0, 140)}`);
  }

  // Verificación tolerante (v2): el CDN de Teletica (cdn02/cdn12) bloquea
  // al edge runtime por IP/geo (Deno Deploy fuera de CR) devolviendo 403
  // aunque la URL sea válida — el VPS sí puede abrirla con FFmpeg + headers
  // spoofed. Solo tratamos como fatal: 404/410 (URL muerta) o VOD/ended.
  try {
    const verifyResp = await fetch(streamUrl, { headers: { ...BROWSER_HEADERS } });
    if (verifyResp.status === 404 || verifyResp.status === 410) {
      throw new Error(`TDMax devolvió URL muerta: HTTP ${verifyResp.status}`);
    }
    if (verifyResp.ok) {
      const verifyText = await verifyResp.text();
      if (!verifyText.trimStart().startsWith('#EXTM3U') || /#EXT-X-ENDLIST/i.test(verifyText)) {
        throw new Error(`TDMax devolvió URL no-live (VOD/ended)`);
      }
    } else {
      // 403/401/5xx desde edge: probablemente geo-block del CDN. Confiamos
      // en que FFmpeg desde el VPS sí podrá leerla. Solo loggeamos.
      console.log(`[scrape-channel] verify devolvió HTTP ${verifyResp.status} — asumiendo geo-block del edge, devolviendo URL al VPS.`);
    }
  } catch (e) {
    if (e instanceof Error && /URL muerta|URL no-live/.test(e.message)) {
      throw e;
    }
    console.log(`[scrape-channel] verify falló (${e instanceof Error ? e.message : e}), devolviendo URL igual.`);
  }

  return streamUrl;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const channelId = body.channel_id;
    const account = body.account === 'pi' ? 'pi' : 'default';
    const processId = body.process_id !== undefined && body.process_id !== null
      ? String(body.process_id)
      : null;

    const email = account === 'pi'
      ? Deno.env.get('TDMAX_EMAIL_PI')
      : Deno.env.get('TDMAX_EMAIL');
    const password = account === 'pi'
      ? Deno.env.get('TDMAX_PASSWORD_PI')
      : Deno.env.get('TDMAX_PASSWORD');

    if (!email || !password) {
      const envVars = account === 'pi' ? 'TDMAX_EMAIL_PI / TDMAX_PASSWORD_PI' : 'TDMAX_EMAIL / TDMAX_PASSWORD';
      return new Response(
        JSON.stringify({ success: false, error: `Credenciales TDMAX no configuradas (${envVars})` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!channelId) {
      return new Response(
        JSON.stringify({ success: false, error: 'Falta channel_id' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const channelName = CHANNEL_MAP[channelId] || channelId;
    const { accessToken } = await loginAndGetToken(email, password);
    const deviceId = await deviceIdForProcess(processId);
    const deviceName = processId ? `web-p${processId}` : 'web';
    const streamUrl = await getStreamUrl(channelId, accessToken, deviceId, deviceName);

    return new Response(
      JSON.stringify({ success: true, url: streamUrl, channel: channelName }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error:', error);
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
