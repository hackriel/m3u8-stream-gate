const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const RESELLER_ID = '61316705e4b0295f87dae396';
const CHANNEL_ID = '664237788f085ac1f2a15f81';
const BASE_URL = 'https://cf.streann.tech';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const email = Deno.env.get('TDMAX_EMAIL');
    const password = Deno.env.get('TDMAX_PASSWORD');
    
    if (!email || !password) {
      return new Response(
        JSON.stringify({ success: false, error: 'Credenciales TDMAX no configuradas' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Step 1: Login
    const loginResp = await fetch(
      `${BASE_URL}/web/services/v3/external/login?r=${RESELLER_ID}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Origin': 'https://www.tdmax.com',
          'Referer': 'https://www.tdmax.com/',
        },
        body: JSON.stringify({
          username: email.toLowerCase(),
          password: password,
        }),
      }
    );

    const loginData = await loginResp.json();

    if (loginData.errorMessage) {
      return new Response(
        JSON.stringify({ success: false, error: `Login error: ${loginData.errorMessage}` }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const accessToken = loginData.accessToken || loginData.access_token;
    if (!accessToken) {
      return new Response(
        JSON.stringify({ success: false, error: 'No se obtuvo token de acceso' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Step 2: Get channel stream URL from loadbalancer
    const deviceId = crypto.randomUUID();
    const lbUrl = `${BASE_URL}/loadbalancer/services/v1/channels-secure/${CHANNEL_ID}/playlist.m3u8?r=${RESELLER_ID}&deviceId=${deviceId}&accessToken=${encodeURIComponent(accessToken)}&doNotUseRedirect=true&countryCode=CR&deviceType=web&appType=web`;

    const lbResp = await fetch(lbUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'https://www.tdmax.com',
        'Referer': 'https://www.tdmax.com/',
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!lbResp.ok) {
      const errorText = await lbResp.text();
      return new Response(
        JSON.stringify({ success: false, error: `Error obteniendo stream: ${lbResp.status}`, details: errorText.substring(0, 200) }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const lbData = await lbResp.json();
    const streamUrl = lbData.url;

    if (!streamUrl) {
      return new Response(
        JSON.stringify({ success: false, error: 'No se encontró URL de stream' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ success: true, url: streamUrl, channel: 'Tigo Sports' }),
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
