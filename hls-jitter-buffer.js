// Disney 8 RTMP input cushion. A single FFmpeg reading HLS with -re stalls its
// RTMP output while each segment downloads or the CDN publishes late; remote
// RTMP receivers drop such idle publishers. A copy-only reader fetches HLS
// ahead into a bounded memory queue and the encoder keeps -re on its own input.
import { spawn as nodeSpawn } from 'child_process';

const NO_VALUE = new Set(['-re', '-hide_banner', '-nostdin', '-nostats', '-stats', '-y', '-n']);
const GLOBAL = new Set(['-hide_banner', '-loglevel', '-v', '-nostdin', '-y', '-n']);
const ENCODER_ONLY = new Set(['-re', '-progress', '-stats_period', '-stats', '-nostats']);
const SHARED_DEMUX = new Set(['-fflags', '-analyzeduration', '-probesize']);
export const MAX_BUFFER_BYTES = 96 * 1024 * 1024;

export function splitJitterBufferArgs(args) {
  const inputAt = args.indexOf('-i');
  const source = args[inputAt + 1];
  if (inputAt < 0 || !/^https?:\/\//i.test(source || '') || args.indexOf('-i', inputAt + 2) >= 0) return null;
  const reader = [], encoder = [];
  for (let i = 0; i < inputAt; i++) {
    const flag = args[i];
    const opt = NO_VALUE.has(flag) ? [flag] : [flag, args[++i]];
    if (GLOBAL.has(flag)) { reader.push(...opt); encoder.push(...opt); }
    else if (ENCODER_ONLY.has(flag)) encoder.push(...opt);
    else { reader.push(...opt); if (SHARED_DEMUX.has(flag)) encoder.push(...opt); }
  }
  if (!encoder.includes('-re')) return null; // realtime pacing must stay on the encoder input
  let at = inputAt + 2;
  const maps = [];
  while (args[at] === '-map' || args[at] === '-sn') {
    if (args[at] === '-sn') { maps.push('-sn'); at++; } else { maps.push('-map', args[at + 1]); at += 2; }
  }
  if (!maps.includes('-map')) maps.push('-map', '0:v:0?', '-map', '0:a:0?');
  return {
    readerArgs: [...reader, '-i', source, ...maps, '-nostats', '-c', 'copy', '-f', 'mpegts', 'pipe:1'],
    encoderArgs: [...encoder, '-f', 'mpegts', '-i', 'pipe:0', '-map', '0:v:0?', '-map', '0:a:0?', ...args.slice(at)],
  };
}

const HEADER_LINE = /^\s*(Input #|Output #|Stream #|Stream mapping|Metadata:|Duration:|Program \d|encoder\s*:|variant_bitrate|Press \[q\]|frame=|size=)/;

// Returns the encoder child (the emission process). The reader is attached to
// it: encoder exit stops the reader; reader exit flushes the queue then ends
// encoder stdin so normal FFmpeg exit/recovery handling applies.
export function startJitterBufferedEncoder(split, { spawn = nodeSpawn, onLog = () => {}, maxBytes = MAX_BUFFER_BYTES } = {}) {
  const encoder = spawn('ffmpeg', split.encoderArgs);
  const reader = spawn('ffmpeg', split.readerArgs);
  const queue = [];
  let queued = 0, waiting = false, readerDone = false, everFilled = false, lastEmptyLog = 0, peak = 0;
  encoder.jitterBuffer = { reader, bytes: () => queued, peak: () => peak };
  const stdin = encoder.stdin;
  stdin.on('error', () => {});
  const pump = () => {
    while (queue.length && !waiting) {
      const chunk = queue.shift();
      queued -= chunk.length;
      if (!stdin.writable) return;
      if (!stdin.write(chunk)) { waiting = true; stdin.once('drain', () => { waiting = false; pump(); }); }
    }
    if (queued < maxBytes / 2 && reader.stdout.isPaused()) reader.stdout.resume();
    if (!queue.length && readerDone && !waiting) stdin.end();
    else if (!queue.length && everFilled && !readerDone && Date.now() - lastEmptyLog > 30000) {
      lastEmptyLog = Date.now();
      onLog('warn', '🧰 Colchón de entrada vacío: la fuente HLS no entregó a tiempo; la salida RTMP puede pausarse.');
    }
  };
  reader.stdout.on('data', (chunk) => {
    queue.push(chunk); queued += chunk.length; peak = Math.max(peak, queued);
    if (queued > 4 * 1024 * 1024) everFilled = true;
    if (queued >= maxBytes) reader.stdout.pause();
    pump();
  });
  let pending = '';
  reader.stderr.on('data', (data) => {
    const lines = (pending + data.toString()).split(/\r?\n|\r/);
    pending = lines.pop();
    const useful = lines.filter(l => l.trim() && !HEADER_LINE.test(l));
    if (useful.length && encoder.stderr) encoder.stderr.emit('data', Buffer.from(useful.join('\n') + '\n'));
  });
  const finishReader = (code) => {
    if (readerDone) return;
    readerDone = true;
    onLog('warn', `📥 Lector HLS terminó (código ${code ?? 'señal'}); se envía lo almacenado y luego se reinicia la emisión.`);
    pump();
  };
  reader.on('close', finishReader);
  reader.on('error', (e) => { onLog('error', `Lector HLS no pudo iniciar: ${e.message}`); finishReader(null); });
  encoder.on('close', () => {
    queue.length = 0; queued = 0;
    if (reader.exitCode == null && reader.signalCode == null) {
      reader.kill('SIGTERM');
      setTimeout(() => { if (reader.exitCode == null && reader.signalCode == null) reader.kill('SIGKILL'); }, 2000).unref?.();
    }
  });
  return encoder;
}
