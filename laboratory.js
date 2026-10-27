import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export const LAB_LIMITS = { seconds: 30, bytes: 64 * 1024 * 1024, retentionMs: 48 * 3600000, threads: 2 };
export const LAB_CHANNELS = { futv: 'FUTV', fox: 'FOX' };
export const LAB_PROFILES = {
  normal: { label: 'Normal', preset: 'veryfast', params: '', purpose: 'Referencia actual', experimental: false },
  normalpro: { label: 'Normal Mejorado Pro', preset: 'fast', params: 'rc-lookahead=40:ref=4:bframes=3:aq-mode=3:aq-strength=1.1:me=umh:subme=8', denoise: 'hqdn3d=1.5:1.5:6:6', purpose: 'Referencia de compresión mejorada', experimental: false },
  sportsdetail: { label: 'Deportes Detalle 2000', preset: 'faster', params: 'rc-lookahead=25:ref=3:bframes=2:aq-mode=2:aq-strength=1.0:me=hex:subme=6', purpose: 'Sin filtro de ruido; prueba de detalle y menor esfuerzo', experimental: true },
  sportsclean: { label: 'Deportes Limpio 2000', preset: 'fast', params: 'rc-lookahead=30:ref=3:bframes=2:aq-mode=2:aq-strength=1.0:me=hex:subme=7', denoise: 'hqdn3d=0.7:0.7:0:0', purpose: 'Filtro espacial leve, sin suavizado temporal; prueba para fuentes con ruido', experimental: true },
};
export const laboratoryProfiles = () => Object.entries(LAB_PROFILES).map(([id, p]) => ({ id, label: p.label, purpose: p.purpose, experimental: p.experimental, videoKbps: 2000, audioKbps: 128, height: 720 }));
export function laboratoryArgs(input, output, profile) {
  const config = Object.hasOwn(LAB_PROFILES, profile) ? LAB_PROFILES[profile] : null;
  if (!config) throw new Error('Salida de laboratorio no permitida.');
  return ['-hide_banner', '-nostdin', '-y', '-threads', '2', '-i', input, '-t', '30', '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', `scale=-2:720${config.denoise ? `,${config.denoise}` : ''}`, '-c:v', 'libx264', '-preset', config.preset,
    '-threads', '2', '-b:v', '2000k', '-minrate', '2000k', '-maxrate', '2000k', '-bufsize', '4000k',
    '-pix_fmt', 'yuv420p', '-force_key_frames', 'expr:gte(t,n_forced*2)',
    '-x264-params', `nal-hrd=cbr:force-cfr=0:scenecut=0${config.params ? `:${config.params}` : ''}`,
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-af', 'aresample=async=1:min_hard_comp=0.100:first_pts=0',
    '-fs', String(LAB_LIMITS.bytes), '-movflags', '+faststart', output];
}
export async function snapshotPlaylist(source, destination) {
  const playlist = path.join(source, 'playlist.m3u8');
  const stat = await fs.lstat(playlist);
  if (stat.isSymbolicLink() || Date.now() - stat.mtimeMs > 90000) throw new Error('La señal no tiene segmentos recientes.');
  const text = await fs.readFile(playlist, 'utf8');
  if (text.includes('#EXT-X-KEY') || text.includes('#EXT-X-MAP')) throw new Error('Esta prueba admite únicamente segmentos TS locales sin cifrado.');
  const segments = [];
  let duration = 0;
  let discontinuity = false;
  for (const line of text.split(/\r?\n/).map(s => s.trim())) {
    if (line.startsWith('#EXTINF:')) duration = Number(line.slice(8).split(',')[0]);
    else if (line === '#EXT-X-DISCONTINUITY') discontinuity = true;
    else if (line && !line.startsWith('#')) {
      if (!/^[a-zA-Z0-9_.-]+\.ts$/.test(line) || !Number.isFinite(duration) || duration <= 0) throw new Error('La lista contiene segmentos no compatibles.');
      segments.push({ name: line, duration, discontinuity });
      discontinuity = false;
    }
  }
  const selected = [];
  let seconds = 0;
  for (const segment of segments.reverse()) {
    if (seconds + segment.duration > LAB_LIMITS.seconds) break;
    selected.unshift(segment);
    seconds += segment.duration;
  }
  if (!selected.length) throw new Error('Todavía no hay fragmentos completos para probar.');
  await fs.mkdir(destination, { recursive: true });
  let bytes = 0;
  for (const segment of selected) {
    const file = path.join(source, segment.name);
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Fragmento no permitido.');
    bytes += info.size;
    if (bytes > LAB_LIMITS.bytes) throw new Error('La muestra excede el límite de tamaño.');
    await fs.copyFile(file, path.join(destination, segment.name));
    await fs.appendFile(path.join(destination, 'sample.ts'), await fs.readFile(path.join(destination, segment.name)));
  }
  await fs.writeFile(path.join(destination, 'sample.m3u8'), '#EXTM3U\n#EXT-X-TARGETDURATION:30\n' + selected.map(s => `${s.discontinuity ? '#EXT-X-DISCONTINUITY\n' : ''}#EXTINF:${s.duration},\n${s.name}\n`).join('') + '#EXT-X-ENDLIST\n');
  return { seconds, bytes, segments: selected.length };
}

export function createLaboratory({ liveDir, dataDir, getSource, canRun = () => os.loadavg()[0] / os.cpus().length < 0.7 }) {
  const router = Router();
  const historyFile = path.join(dataDir, 'laboratory-results.json');
  let active = null;
  let child = null;
  let history = [];
  const ready = fs.readFile(historyFile, 'utf8').then(text => { const saved = JSON.parse(text); history = Array.isArray(saved) ? saved : []; }).catch(() => {});
  const prune = () => { history = history.filter(j => Date.now() - Date.parse(j.startedAt) < LAB_LIMITS.retentionMs).slice(0, 30); };
  const persist = async () => { prune(); await fs.mkdir(dataDir, { recursive: true }); await fs.writeFile(`${historyFile}.tmp`, JSON.stringify(history)); await fs.rename(`${historyFile}.tmp`, historyFile); };
  const run = (command, args, job, timeout = 120000) => new Promise((resolve, reject) => {
    if (job.cancelled) return reject(new Error('Prueba cancelada.'));
    const started = Date.now();
    child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const current = child;
    let stdout = '';
    current.stdout.on('data', data => { stdout = (stdout + data.toString()).slice(-16384); });
    current.stderr.on('data', () => {}); // Never expose source details/credentials.
    let overloaded = false;
    const monitor = setInterval(() => { if (!canRun()) { overloaded = true; current.kill('SIGKILL'); } }, 5000);
    const timer = setTimeout(() => { current.kill('SIGKILL'); }, timeout);
    current.once('error', () => { clearInterval(monitor); clearTimeout(timer); if (child === current) child = null; reject(new Error('No se pudo iniciar FFmpeg/FFprobe.')); });
    current.once('close', code => {
      clearInterval(monitor); clearTimeout(timer); if (child === current) child = null;
      if (code !== 0 || job.cancelled) reject(new Error(job.cancelled ? 'Prueba cancelada.' : overloaded ? 'Prueba detenida para priorizar las emisiones: aumentó la carga del servidor.' : 'La prueba no pudo completarse dentro del límite.'));
      else resolve({ stdout, elapsed: (Date.now() - started) / 1000 });
    });
  });
  const stop = async () => {
    if (!active) return;
    active.cancelled = true;
    const current = child;
    if (!current) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => current.kill('SIGKILL'), 2000);
      current.once('close', () => { clearTimeout(timer); resolve(); });
      current.kill('SIGTERM');
    });
  };
  const execute = async job => {
    let temp;
    try {
      temp = await fs.mkdtemp(path.join(os.tmpdir(), 'stream-lab-'));
      job.sample = await snapshotPlaylist(path.join(liveDir, job.channel), temp);
      // Completed local TS file, not a live HLS input; no -re pacing needed.
      const input = path.join(temp, 'sample.ts');
      const probe = await run('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,crypto,data', '-show_streams', '-of', 'json', input], job, 15000);
      const video = JSON.parse(probe.stdout).streams.find(s => s.codec_type === 'video');
      job.reference = video ? { width: video.width, height: video.height, codec: video.codec_name } : null;
      job.results = [];
      for (const profile of job.profiles.map(p => p.id)) {
        if (!canRun()) throw new Error('Prueba detenida: el servidor necesita margen para las emisiones.');
        job.stage = profile;
        const output = path.join(temp, `${profile}.mp4`);
        // Low scheduler priority; only two encoding threads, sequential, local files only.
        const encoded = await run('nice', ['-n', '19', 'ffmpeg', ...laboratoryArgs(input, output, profile)], job);
        const measured = await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output], job, 15000);
        const data = JSON.parse(measured.stdout);
        const stream = data.streams.find(s => s.codec_type === 'video');
        const seconds = Number(data.format.duration);
        job.results.push({ profile, seconds, elapsed: encoded.elapsed, speed: seconds / encoded.elapsed, sizeMB: Number(data.format.size) / 1048576, videoKbps: Number(stream?.bit_rate || 0) / 1000 });
        await fs.unlink(output);
      }
      job.status = 'completed';
      const withMargin = job.results.filter(r => r.speed >= 1.2).map(r => LAB_PROFILES[r.profile].label);
      job.conclusion = `${withMargin.length ? `Terminaron con margen de procesamiento en esta muestra: ${withMargin.join(', ')}.` : 'Ninguna salida alcanzó margen suficiente en esta muestra.'} La velocidad no elige un ganador de imagen ni demuestra ausencia de cortes en XUI. Las salidas deportivas son experimentales: conserva la emisión actual hasta validarlas visualmente y con la carga real.`;
    } catch (error) {
      job.status = job.cancelled ? 'cancelled' : 'failed';
      job.error = error.code ? 'No se pudo copiar la muestra. La señal pudo cambiar o detenerse; vuelve a intentarlo.' : error.message;
    } finally {
      job.finishedAt = new Date().toISOString();
      if (temp) await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
      history.unshift(job);
      await persist().catch(() => {});
      active = null;
    }
  };
  const retentionTimer = setInterval(() => { if (!active) void ready.then(persist).catch(() => {}); }, 3600000);
  retentionTimer.unref();
  router.use((req, res, next) => {
    // Same simple dashboard gate, no separate account or JWT.
    if (req.get('X-Dashboard-Auth') !== 'Qm9hbmVyZ2VzMTIq') return res.status(403).json({ error: 'Abre el panel con tu contraseña para consultar Laboratorio.' });
    res.set('Cache-Control', 'no-store'); next();
  });
  router.get('/', async (_req, res) => {
    await ready; prune();
    const channels = Object.entries(LAB_CHANNELS).map(([id, name]) => ({ id, name, ...getSource(id) }));
    res.json({ channels, active, history, limits: LAB_LIMITS, profiles: laboratoryProfiles() });
  });
  router.post('/start', async (req, res) => {
    await ready;
    const channel = req.body?.channel;
    if (!Object.hasOwn(LAB_CHANNELS, channel)) return res.status(400).json({ error: 'Elige FUTV o FOX.' });
    if (active) return res.status(409).json({ error: 'Ya hay una prueba en curso.' });
    if (!getSource(channel).running) return res.status(409).json({ error: 'Este canal debe estar emitiendo antes de probarlo.' });
    if (!canRun()) return res.status(409).json({ error: 'El servidor tiene mucha carga. Prueba cuando baje la audiencia.' });
    active = { id: crypto.randomUUID(), channel, source: getSource(channel), profiles: laboratoryProfiles(), status: 'running', stage: 'capture', startedAt: new Date().toISOString() };
    const job = active;
    res.status(202).json(job);
    void execute(job);
  });
  router.post('/cancel', async (_req, res) => { await stop(); res.json({ success: true }); });
  return { router, stop };
}
