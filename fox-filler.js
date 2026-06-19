// ─────────────────────────────────────────────────────────────────────────────
// FOX / FOX+ URL — Filler "Media TV · RECONECTANDO" durante re-scrape
// ─────────────────────────────────────────────────────────────────────────────
// Sólo IDs 24 y 25. Cuando el FFmpeg LIVE muere (404/EOF/token expirado),
// arrancamos INMEDIATAMENTE un FFmpeg que escribe segmentos HLS en la MISMA
// carpeta /live/<slug>/ usando -stream_loop -1 sobre assets/filler-fox.mp4.
// El playlist sigue creciendo con append_list, así los clientes (XUI/players)
// NO pierden la señal: ven la pantalla "RECONECTANDO" hasta que el nuevo
// FFmpeg LIVE empalme. La transición LIVE→FILLER y FILLER→LIVE comparte
// numeración de segmentos (epoch) y append_list para evitar wipes/cortes.
//
// Codecs del filler coinciden 1:1 con el perfil de salida:
//   720p · 29.97fps · libx264 main · CBR 2000k · AAC 128k · 44.1kHz stereo
// ─────────────────────────────────────────────────────────────────────────────

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FILLER_MP4 = path.join(__dirname, 'assets', 'filler-fox.mp4');
const HLS_OUTPUT_DIR = path.join(__dirname, 'live');
const HLS_SLUG_MAP = { '24': 'foxmas', '25': 'fox' };
const SUPPORTED_IDS = new Set(['24', '25']);

// processId(string) → { proc, startedAt, slug }
const fillerProcesses = new Map();

function isFillerSupported(processId) {
  return SUPPORTED_IDS.has(String(processId));
}

function isFillerActive(processId) {
  return fillerProcesses.has(String(processId));
}

function startFiller(processId, sendLog) {
  const pid = String(processId);
  if (!isFillerSupported(pid)) return false;
  if (fillerProcesses.has(pid)) return true;
  if (!fs.existsSync(FILLER_MP4)) {
    sendLog && sendLog(pid, 'warn', `⚠️ FILLER no disponible: falta ${FILLER_MP4}`);
    return false;
  }

  const slug = HLS_SLUG_MAP[pid];
  const hlsDir = path.join(HLS_OUTPUT_DIR, slug);
  try { fs.mkdirSync(hlsDir, { recursive: true }); } catch (_) {}
  const playlist = path.join(hlsDir, 'playlist.m3u8');
  const segPattern = path.join(hlsDir, 'seg_%05d.ts');

  // Empate exacto con el perfil LIVE (ver server.js spawn ~3905):
  //   -hls_time 10  -hls_list_size 8
  //   -hls_flags delete_segments+append_list+independent_segments+omit_endlist
  //   -hls_segment_type mpegts  -hls_start_number_source epoch
  // Diferencia: aquí -re + stream_loop infinito + -c copy (codecs ya match).
  const args = [
    '-hide_banner', '-loglevel', 'warning', '-nostats',
    '-re',
    '-stream_loop', '-1',
    '-fflags', '+genpts',
    '-i', FILLER_MP4,
    '-map', '0:v:0', '-map', '0:a:0',
    '-c', 'copy',
    '-f', 'hls',
    '-hls_time', '10',
    '-hls_list_size', '8',
    '-hls_flags', 'delete_segments+append_list+independent_segments+omit_endlist+discont_start',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', segPattern,
    '-hls_allow_cache', '0',
    '-hls_start_number_source', 'epoch',
    playlist,
  ];

  let proc;
  try {
    proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    sendLog && sendLog(pid, 'error', `❌ FILLER spawn falló: ${e.message}`);
    return false;
  }

  const info = { proc, startedAt: Date.now(), slug };
  fillerProcesses.set(pid, info);
  sendLog && sendLog(pid, 'info', `🎞️ FILLER ON · pantalla "RECONECTANDO" → /live/${slug}/playlist.m3u8 (pid ${proc.pid})`);

  // Silenciar stderr ruidoso, sólo capturar errores reales
  proc.stderr.on('data', (buf) => {
    const s = buf.toString();
    if (/error|fatal|Conversion failed/i.test(s) && !/Past duration|non-monotonous/i.test(s)) {
      sendLog && sendLog(pid, 'warn', `🎞️ FILLER stderr: ${s.trim().split('\n').pop()}`);
    }
  });

  proc.on('close', (code, signal) => {
    const cur = fillerProcesses.get(pid);
    if (cur && cur.proc === proc) {
      fillerProcesses.delete(pid);
    }
    sendLog && sendLog(pid, 'info', `🎞️ FILLER OFF (code=${code}${signal ? `, signal=${signal}` : ''})`);
  });

  proc.on('error', (err) => {
    sendLog && sendLog(pid, 'error', `❌ FILLER error: ${err.message}`);
  });

  return true;
}

// Mata el filler y espera a que muera de verdad (hasta 3s).
async function stopFillerAndWait(processId, sendLog) {
  const pid = String(processId);
  const info = fillerProcesses.get(pid);
  if (!info) return false;
  const { proc } = info;
  fillerProcesses.delete(pid);

  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(true); };
    proc.once('close', finish);
    try { proc.kill('SIGTERM'); } catch (_) {}
    setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) {}
    }, 1500);
    setTimeout(finish, 3000);
    sendLog && sendLog(pid, 'info', `🎞️ FILLER deteniendo (empalmando SEÑAL EN VIVO)…`);
  });
}

export {
  startFiller,
  stopFillerAndWait,
  isFillerActive,
  isFillerSupported,
  FILLER_MP4,
};