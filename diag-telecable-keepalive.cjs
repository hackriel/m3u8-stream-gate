#!/usr/bin/env node
// Diagnóstico Telecable: compara FFmpeg leyendo el HLS firmado en 3 modos
// para decidir si activamos HTTP keep-alive (multiple_requests + reconnect_on_http_error)
// en el ETAPA 1 de canales Telecable.
//
//   A) baseline           → como hoy en prod (sin keep-alive, sin reconnect_on_http_error)
//   B) +multiple_requests → agrega -multiple_requests 1
//   C) full keep-alive    → -multiple_requests 1 + -reconnect_on_http_error 4xx,5xx
//
// USO (en el VPS):
//   cd /opt/m3u8-emitter
//   node diag-telecable-keepalive.cjs
//
// Duración total: ~5 min (3 muestras de 45s + cooldown 30s entre cada una).
// NO reinicia procesos productivos. Solo lee al /dev/null.
//
// Interpretación:
//   • fps ≥ 28 y sin errores       → seguro activar ese modo en prod
//   • fps < 28 o errores 4xx/5xx   → NO activar (rompe la firma o hay throttling)

const { spawn } = require('child_process');

const API_BASE = 'https://api.srv.teleplus.c.mtvreg.com';
const CAPS_LOGIN = 'vast,normalize_id,category,deeplink,carousel,people,lowlatency';
const CAPS_PL = 'adaptive,webvtt,fmp4,vast,clientvast,alerts,carousel,lowlatency';
const UA = 'TPlay_iOS/20260122134025 CFNetwork/3860.600.12 Darwin/25.5.0';
const UNIT = 'mastele';
const VERSION = '4.1.0';
const CONTENT_ID = process.env.DIAG_CONTENT_ID || 'FOXPLUS';
const QUALITY = parseInt(process.env.DIAG_QUALITY || '40', 10);
const TEST_SECONDS = 45;
const COOLDOWN_MS = 30_000;

const DEVICE_ID = process.env.TELECABLE_DEVICE_ID;
const DEVICE_PW = process.env.TELECABLE_DEVICE_PASSWORD;
if (!DEVICE_ID || !DEVICE_PW) {
  console.error('❌ Falta TELECABLE_DEVICE_ID / TELECABLE_DEVICE_PASSWORD en env');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function resolveSignedUrl() {
  const loginUrl =
    `${API_BASE}/api/device-login?capabilities=${encodeURIComponent(CAPS_LOGIN)}` +
    `&deviceId=${encodeURIComponent(DEVICE_ID)}&lang=es&password=${encodeURIComponent(DEVICE_PW)}` +
    `&unit=${encodeURIComponent(UNIT)}&version=${encodeURIComponent(VERSION)}`;
  const r = await fetch(loginUrl, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.status !== 1 || !j?.PHPSESSID) {
    throw new Error(`login failed status=${j?.status} err=${j?.error || r.status}`);
  }
  const phpsessid = j.PHPSESSID;
  const plUrl =
    `${API_BASE}/api/playlist?logosize=512&format=m3u8` +
    `&capabilities=${encodeURIComponent(CAPS_PL)}` +
    `&quality=${QUALITY}&radioFormat=m3u8&PHPSESSID=${encodeURIComponent(phpsessid)}`;
  const pr = await fetch(plUrl, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Cookie': `PHPSESSID=${phpsessid}; _nss=1` },
  });
  const pj = await pr.json();
  const ch = pj?.channels?.find((c) => c.id === CONTENT_ID);
  if (!ch?.url) throw new Error(`canal ${CONTENT_ID} no encontrado`);
  return ch.url;
}

function runFfmpeg(url, extraArgs, label) {
  return new Promise((resolve) => {
    const args = [
      '-hide_banner', '-nostats', '-loglevel', 'info',
      '-rw_timeout', '10000000',
      '-user_agent', UA,
      '-headers', 'Accept: */*\r\nAccept-Language: es-419,es;q=0.9\r\n',
      ...extraArgs,
      '-i', url,
      '-t', String(TEST_SECONDS),
      '-c', 'copy',
      '-f', 'null', '/dev/null',
      '-progress', 'pipe:1',
    ];
    const proc = spawn('ffmpeg', args);
    const fpsSamples = [];
    let bytes = 0;
    let httpErrors = 0;
    let firstError = null;
    const killTimer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, (TEST_SECONDS + 20) * 1000);

    proc.stdout.on('data', (chunk) => {
      chunk.toString().split('\n').forEach((line) => {
        const m = line.match(/^fps=([0-9.]+)/);
        if (m) { const v = parseFloat(m[1]); if (!isNaN(v)) fpsSamples.push(v); }
        const b = line.match(/^total_size=(\d+)/);
        if (b) bytes = parseInt(b[1], 10);
      });
    });
    let stderrBuf = '';
    proc.stderr.on('data', (c) => {
      const s = c.toString();
      stderrBuf += s;
      s.split('\n').forEach((l) => {
        const m = l.match(/HTTP error (\d{3})/);
        if (m) {
          httpErrors++;
          if (!firstError) firstError = `HTTP ${m[1]}`;
        }
        if (!firstError && /forbidden|401|403|invalid data/i.test(l)) firstError = l.trim().slice(0, 120);
      });
    });
    proc.on('close', (code) => {
      clearTimeout(killTimer);
      const valid = fpsSamples.filter((v) => v > 0);
      const avg = valid.length ? +(valid.reduce((a, b) => a + b, 0) / valid.length).toFixed(1) : null;
      const min = valid.length ? +Math.min(...valid).toFixed(1) : null;
      const max = valid.length ? +Math.max(...valid).toFixed(1) : null;
      const tailErr = stderrBuf.split('\n').filter((l) => /error|failed|forbidden|refused|timeout|invalid/i.test(l)).slice(-2).join(' | ').slice(0, 220);
      console.log(`   📊 [${label}] fps avg=${avg ?? 'n/a'} min=${min ?? 'n/a'} max=${max ?? 'n/a'} bytes=${(bytes/1024/1024).toFixed(2)}MB httpErr=${httpErrors} code=${code}`);
      if (tailErr) console.log(`   ⚠️  ${tailErr}`);
      resolve({ label, avg, min, max, bytes, httpErrors, firstError, tailErr, code });
    });
  });
}

(async () => {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║  DIAG TELECABLE — HTTP keep-alive vs baseline             ║');
  console.log(`║  Canal: ${CONTENT_ID.padEnd(10)}  Quality: ${String(QUALITY).padEnd(4)}  Muestra: ${TEST_SECONDS}s          ║`);
  console.log('╚═══════════════════════════════════════════════════════════╝');

  const url = await resolveSignedUrl();
  console.log(`\n✅ URL firmada obtenida — corriendo 3 muestras contra la MISMA sesión\n`);

  const modes = [
    { label: 'A) baseline (prod actual)', args: [] },
    { label: 'B) +multiple_requests 1',   args: ['-multiple_requests', '1'] },
    { label: 'C) full keep-alive',        args: ['-multiple_requests', '1', '-reconnect_on_http_error', '4xx,5xx'] },
  ];

  const results = [];
  for (let i = 0; i < modes.length; i++) {
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`🧪 ${modes[i].label}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    const r = await runFfmpeg(url, modes[i].args, modes[i].label);
    results.push(r);
    if (i < modes.length - 1) {
      console.log(`   💤 Cooldown ${COOLDOWN_MS/1000}s...\n`);
      await sleep(COOLDOWN_MS);
    }
  }

  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║                    RESUMEN                                 ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');
  console.log('modo                          | fps avg | fps min | httpErr | MB    | veredicto');
  console.log('------------------------------|---------|---------|---------|-------|----------');
  for (const r of results) {
    const veredicto =
      r.httpErrors > 0 ? '❌ ROMPE (4xx/5xx)' :
      (r.avg ?? 0) >= 28 ? '✅ SANO' :
      (r.avg ?? 0) >= 15 ? '⚠️ degradado' : '❌ throttling/error';
    console.log(`${r.label.padEnd(29)} | ${String(r.avg ?? '-').padStart(7)} | ${String(r.min ?? '-').padStart(7)} | ${String(r.httpErrors).padStart(7)} | ${(r.bytes/1024/1024).toFixed(1).padStart(5)} | ${veredicto}`);
  }
  console.log(`\n💡 Regla de decisión:`);
  console.log(`   • Si B o C son ✅ SANO → activar esos flags en el ETAPA 1 de Telecable`);
  console.log(`   • Si B o C dan httpErr>0 o fps<28 → NO activar (dejar como baseline)`);
  console.log(`   • Si A ya está degradado, el problema NO es keep-alive (es CDN/red)\n`);
  process.exit(0);
})().catch((e) => {
  console.error('\n❌ Fatal:', e.message);
  process.exit(1);
});