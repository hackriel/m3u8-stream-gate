const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const RESELLER_ID = '61316705e4b0295f87dae396';
const BASE_URL = 'https://cf.streann.tech';

const CHANNEL_MAP: Record<string, string> = {
  '641cba02e4b068d89b2344e3': 'FUTV',
  '664237788f085ac1f2a15f81': 'Tigo Sports',
  '66608d188f0839b8a740cfe9': 'TDmas 1',
  '617c2f66e4b045a692106126': 'Teletica',
  '65d7aca4e4b0140cbf380bd0': 'Canal 6',
  '664e5de58f089fa849a58697': 'Multimedios',
  '61a8c0e8e4b010fa97ffde55': 'Evento Alterno',
};

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Origin': 'https://www.tdmax.com',
  'Referer': 'https://www.tdmax.com/',
};

// Login and return accessToken + deviceId
async function loginAndGetToken(email: string, password: string): Promise<{ accessToken: string; deviceId: string }> {
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

  const deviceId = crypto.randomUUID();
  return { accessToken, deviceId };
}

// Use an existing token to get stream URL for a channel
async function getStreamUrl(channelId: string, accessToken: string, deviceId: string): Promise<string> {
  const lbUrl = `${BASE_URL}/loadbalancer/services/v1/channels-secure/${channelId}/playlist.m3u8?r=${RESELLER_ID}&deviceId=${deviceId}&accessToken=${encodeURIComponent(accessToken)}&doNotUseRedirect=true&countryCode=CR&deviceType=web&appType=web`;

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

  return streamUrl;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const mode = body.mode || 'full'; // 'full' (default), 'token_only', 'stream_only'
    const channelId = body.channel_id;

    const email = Deno.env.get('TDMAX_EMAIL');
    const password = Deno.env.get('TDMAX_PASSWORD');

    if (!email || !password) {
      return new Response(
        JSON.stringify({ success: false, error: 'Credenciales TDMAX no configuradas' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // MODE: token_only — just login and return token+deviceId
    if (mode === 'token_only') {
      const { accessToken, deviceId } = await loginAndGetToken(email, password);
      return new Response(
        JSON.stringify({ success: true, accessToken, deviceId }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // MODE: stream_only — use provided token to get stream URL
    if (mode === 'stream_only') {
      if (!channelId) {
        return new Response(
          JSON.stringify({ success: false, error: 'Falta channel_id' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      const accessToken = body.access_token;
      const deviceId = body.device_id;
      if (!accessToken || !deviceId) {
        return new Response(
          JSON.stringify({ success: false, error: 'Falta access_token o device_id' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const channelName = CHANNEL_MAP[channelId] || channelId;
      try {
        const streamUrl = await getStreamUrl(channelId, accessToken, deviceId);
        return new Response(
          JSON.stringify({ success: true, url: streamUrl, channel: channelName }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      } catch (streamError) {
        return new Response(
          JSON.stringify({ success: false, error: streamError.message, token_expired: true }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // MODE: full (default) — login + get stream URL (original behavior)
    if (!channelId) {
      return new Response(
        JSON.stringify({ success: false, error: 'Falta channel_id' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const channelName = CHANNEL_MAP[channelId] || channelId;
    const { accessToken, deviceId } = await loginAndGetToken(email, password);
    const streamUrl = await getStreamUrl(channelId, accessToken, deviceId);

    return new Response(
      JSON.stringify({ success: true, url: streamUrl, channel: channelName, accessToken, deviceId }),
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
