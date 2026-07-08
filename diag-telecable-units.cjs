#!/usr/bin/env node
// Diagnóstico Telecable: prueba varios `unit` de login y mide el throughput
// real de FFmpeg leyendo el HLS firmado, para decidir cuál da mejor camino.
//
// USO (en el VPS):
//   cd /opt/m3u8-emitter
//   node diag-telecable-units.js
//
// Duración total: ~6-8 minutos (con cooldowns anti-rate-limit).
// NO corre en bucle. NO reinicia procesos productivos. Solo lee.

const { spawn } = require('child_process');

const API_BASE = 'https://api.srv.teleplus.c.mtvreg.com';
const CAPS_LOGIN = 'vast,normalize_id,category,deeplink,carousel,people,lowlatency';
const CAPS_PL = 'adaptive,webvtt,fmp4,vast,clientvast,alerts,carousel,lowlatency';
const CONTENT_ID = 'FOXPLUS';     // canal a probar
const QUALITY = 40;               // misma que producción
const TEST_SECONDS = 30;          // duración de cada muestra FFmpeg
const COOLDOWN_MS = 60_000;       // pausa entre pruebas (evita rate-limit)

// Unit candidates. Cada entry: { unit, version, ua } — el UA debe ser coherente
// con la plataforma para no gatillar antifraude.
const CANDIDATES = [
  {
    unit: 'mastele',
    version: '4.1.0',
    ua: 'TPlay_iOS/20260122134025 CFNetwork/3860.600.12 Darwin/25.5.0',
    label: 'iOS (baseline actual)',
  },
  {
    unit: 'masandroid',
    version: '4.1.0',
    ua: 'TPlay_Android/4.1.0 (Linux; Android 14; Pixel 8)',
    label: 'Android',
  },
  {
    unit: 'masweb',
    version: '4.1.0',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    label: 'Web player',
  },
  {
    unit: 'mastvbox',
    version: '4.1.0',
    ua: 'TPlay_STB/4.1.0 (Linux; Tizen 7.0)',
    label: 'Set-top box / Smart TV',
  },
];

const DEVICE_ID = process.env.TELECABLE_DEVICE_ID;
const DEVICE_PW = process.env.TELECABLE_DEVICE_PASSWORD;
if (!DEVICE_ID || !DEVICE_PW) {
  console.error('❌ Falta TELECABLE_DEVICE_ID / TELECABLE_DEVICE_PASSWORD en env');
  process.exit(1);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function tryUnit({ unit, version, ua, label }) {
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🧪 Probando unit="${unit}" (${label})`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  const result = {
    unit, label,
    login_ok: false, login_error: null,
    resolved_url: null, device_type_in_url: null,
    fps_avg: null, fps_min: null, fps_max: null, samples: 0,
    bytes_read: 0, ffmpeg_error: null,
  };

  // 1) login
  const loginUrl =
    `${API_BASE}/api/device-login?capabilities=${encodeURIComponent(CAPS_LOGIN)}` +
    `&deviceId=${encodeURIComponent(DEVICE_ID)}&lang=es&password=${encodeURIComponent(DEVICE_PW)}` +
    `&unit=${encodeURIComponent(unit)}&version=${encodeURIComponent(version)}`;
  let phpsessid;
  try {
    const r = await fetch(loginUrl, { headers: { 'User-Agent': ua, 'Accept': 'application/json' } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j?.status !== 1 || !j?.PHPSESSID) {
      result.login_error = `status=${j?.status} error=${j?.error || r.status}`;
      console.log(`   ❌ Login falló: ${result.login_error}`);
      return result;
    }
    phpsessid = j.PHPSESSID;
    result.login_ok = true;
    console.log(`   ✅ Login OK (PHPSESSID=${phpsessid.slice(0, 8)}...)`);
  } catch (e) {
    result.login_error = `network: ${e.message}`;
    console.log(`   ❌ Login network error: ${e.message}`);
    return result;
  }

  // 2) playlist → busca FOX+
  const plUrl =
    `${API_BASE}/api/playlist?logosize=512&format=m3u8` +
    `&capabilities=${encodeURIComponent(CAPS_PL)}` +
    `&quality=${QUALITY}&radioFormat=m3u8&PHPSESSID=${encodeURIComponent(phpsessid)}`;
  let channel;
  try {
    const r = await fetch(plUrl, {
      headers: { 'User-Agent': ua, 'Accept': 'application/json', 'Cookie': `PHPSESSID=${phpsessid}; _nss=1` },
    });
    const j = await r.json();
    channel = j?.channels?.find(c => c.id === CONTENT_ID);
    if (!channel?.url) {
      console.log(`   ❌ Canal ${CONTENT_ID} no encontrado en playlist (canales=${j?.channels?.length || 0})`);
      return result;
    }
    result.resolved_url = channel.url;
    try {
      const u = new URL(channel.url);
      result.device_type_in_url = u.searchParams.get('device-type') || '(no presente)';
    } catch (_) { /* noop */ }
    console.log(`   ✅ URL obtenida — device-type en URL = "${result.device_type_in_url}"`);
  } catch (e) {
    console.log(`   ❌ Playlist error: ${e.message}`);
    return result;
  }

  // 3) FFmpeg dry-run: leer TEST_SECONDS y descartar al /dev/null, midiendo fps
  console.log(`   ⏱️  Midiendo ${TEST_SECONDS}s de lectura real con FFmpeg...`);
  await new Promise(resolve => {
    const args = [
      '-hide_banner', '-nostats', '-loglevel', 'info',
      '-rw_timeout', '10000000',
      '-user_agent', ua,
      '-headers', 'Accept: */*\r\nAccept-Language: es-419,es;q=0.9\r\n',
      '-i', channel.url,
      '-t', String(TEST_SECONDS),
      '-c', 'copy',
      '-f', 'null', '/dev/null',
      '-progress', 'pipe:1',
    ];
    const proc = spawn('ffmpeg', args);
    const fpsSamples = [];
    let bytes = 0;
    let killTimer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, (TEST_SECONDS + 15) * 1000);

    proc.stdout.on('data', chunk => {
      const s = chunk.toString();
      // -progress emite key=value por linea. Nos interesa fps= y total_size=
      s.split('\n').forEach(line => {
        const m = line.match(/^fps=([0-9.]+)/);
        if (m) {
          const v = parseFloat(m[1]);
          if (!isNaN(v)) fpsSamples.push(v);
        }
        const b = line.match(/^total_size=(\d+)/);
        if (b) bytes = parseInt(b[1], 10);
      });
    });
    let stderrBuf = '';
    proc.stderr.on('data', chunk => { stderrBuf += chunk.toString(); });
    proc.on('close', code => {
      clearTimeout(killTimer);
      // fps=N/A o samples vacios → probablemente error
      const validSamples = fpsSamples.filter(v => v > 0);
      if (validSamples.length > 0) {
        result.samples = validSamples.length;
        result.fps_avg = +(validSamples.reduce((a, b) => a + b, 0) / validSamples.length).toFixed(1);
        result.fps_min = +Math.min(...validSamples).toFixed(1);
        result.fps_max = +Math.max(...validSamples).toFixed(1);
      }
      result.bytes_read = bytes;
      // Extraer últimos 2 errores relevantes del stderr
      const errLines = stderrBuf.split('\n')
        .filter(l => /error|failed|forbidden|refused|timeout|invalid/i.test(l))
        .slice(-3);
      if (errLines.length) result.ffmpeg_error = errLines.join(' | ').slice(0, 200);
      console.log(`   📊 fps avg=${result.fps_avg ?? 'n/a'} min=${result.fps_min ?? 'n/a'} max=${result.fps_max ?? 'n/a'} bytes=${(bytes/1024/1024).toFixed(2)}MB code=${code}`);
      if (result.ffmpeg_error) console.log(`   ⚠️  ${result.ffmpeg_error}`);
      resolve();
    });
  });

  return result;
}

(async () => {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║  DIAGNÓSTICO TELECABLE — comparativa por unit de login    ║');
  console.log(`║  Canal: ${CONTENT_ID.padEnd(10)}  Quality: ${String(QUALITY).padEnd(4)}  Duración/prueba: ${TEST_SECONDS}s  ║`);
  console.log('╚═══════════════════════════════════════════════════════════╝');

  const results = [];
  for (let i = 0; i < CANDIDATES.length; i++) {
    const r = await tryUnit(CANDIDATES[i]);
    results.push(r);
    if (i < CANDIDATES.length - 1) {
      console.log(`\n   💤 Cooldown ${COOLDOWN_MS/1000}s antes de la próxima prueba...`);
      await sleep(COOLDOWN_MS);
    }
  }

  console.log('\n\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║                    RESUMEN COMPARATIVO                    ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');
  console.log('unit          | login | device-type | fps avg | fps min | MB leídos | notas');
  console.log('--------------|-------|-------------|---------|---------|-----------|------');
  for (const r of results) {
    const login = r.login_ok ? '✅' : '❌';
    const dt = (r.device_type_in_url || '-').padEnd(11);
    const fpsA = String(r.fps_avg ?? '-').padStart(7);
    const fpsM = String(r.fps_min ?? '-').padStart(7);
    const mb = r.bytes_read ? (r.bytes_read/1024/1024).toFixed(1).padStart(9) : '        -';
    const notes = r.login_error || r.ffmpeg_error || (r.fps_avg >= 28 ? 'sano' : r.fps_avg ? 'degradado' : 'sin data');
    console.log(`${r.unit.padEnd(13)} | ${login}    | ${dt} | ${fpsA} | ${fpsM} | ${mb} | ${notes}`);
  }
  console.log('\n💡 Interpretación:');
  console.log('   • fps avg ≥ 28  = camino sano, el CDN nos sirve full-rate');
  console.log('   • fps avg 15-27 = throttling parcial');
  console.log('   • fps avg < 15  = throttling agresivo o error');
  console.log('   • login ❌      = ese unit NO acepta nuestro deviceId (no usar)');
  console.log('\n⚠️  Si algún login falla con "invalid device" no reintentes: el');
  console.log('   pairing sigue intacto, simplemente ese unit no aplica para tu cuenta.\n');
  process.exit(0);
})();