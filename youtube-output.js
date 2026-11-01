// YouTube Live encoder guidance: https://support.google.com/youtube/answer/2853702
export function isYouTubeDestination(value) {
  try { return /^[a-z0-9-]+\.rtmps?\.youtube\.com$/i.test(new URL(value).hostname); }
  catch { return false; }
}

export function validateYouTubeOutput(target, profile, copyMode = false) {
  if (!isYouTubeDestination(target)) return null;
  const url = new URL(target);
  if (!['rtmp:', 'rtmps:'].includes(url.protocol) || !/^\/live2\/[^/\s]+\/?$/.test(url.pathname)
      || url.username || url.password || url.search || url.hash) {
    return 'YouTube: pega la URL RTMP/RTMPS del servidor seguida de / y la clave de emisión, sin espacios.';
  }
  if (profile.passthrough || copyMode) {
    return 'YouTube: elige una salida procesada; Passthrough no permite asegurar audio, cuadros clave y formato compatibles.';
  }
  if (Number(profile.width) >= 720 && parseInt(profile.videoBitrate, 10) < 3000) {
    return 'YouTube indica un mínimo de 3000 kbps para H.264 en 720p. Elige HD720 (3000) o Alta Calidad (4000); no cambiamos tu bitrate automáticamente.';
  }
  return null;
}

// Applied after all legacy codec branches, before the FLV destination is appended.
// Never changes input pacing, source sessions, or non-YouTube output.
export function youtubeEncodingArgs(args, profile) {
  const inputEnd = args.indexOf('-i') + 2;
  if (inputEnd < 2) throw new Error('Falta la entrada de video');
  const replace = new Set(['-c:v', '-c:a', '-c', '-preset', '-profile:v', '-pix_fmt', '-threads',
    '-b:v', '-minrate', '-maxrate', '-bufsize', '-x264-params', '-vf', '-r', '-vsync',
    '-g', '-keyint_min', '-sc_threshold', '-bf', '-refs', '-b:a', '-ar', '-ac',
    '-af', '-async', '-bsf:v', '-bsf:a', '-reset_timestamps', '-avoid_negative_ts']);
  const result = args.slice(0, inputEnd);
  for (let i = inputEnd; i < args.length; i++) {
    if (replace.has(args[i])) { i++; continue; }
    if (args[i] === '-map') {
      result.push('-map', args[++i].replace(/\?$/, ''));
      continue;
    }
    result.push(args[i]);
  }
  const height = Number(profile.width);
  const width = height === 480 ? 854 : 1280;
  const params = (profile.x264Params || '').split(':').filter(Boolean)
    .filter(p => !/^(bframes|ref|open-gop|nal-hrd|force-cfr)=/.test(p));
  params.push('bframes=2', 'ref=1', 'open-gop=0', 'nal-hrd=cbr', 'force-cfr=1');
  return [...result,
    '-c:v', 'libx264', '-preset', profile.preset || 'veryfast', '-profile:v', 'main',
    '-pix_fmt', 'yuv420p', '-threads', String(profile.threads || 4),
    '-b:v', profile.videoBitrate, '-minrate', profile.videoBitrate,
    '-maxrate', profile.videoBitrate, '-bufsize', profile.bufsize,
    '-x264-params', params.join(':'),
    '-vf', `bwdif=mode=send_frame:parity=auto:deint=interlaced,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1${profile.denoise ? ',' + profile.denoise : ''}`,
    '-r', '30', '-vsync', 'cfr', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
    '-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '128k', '-ar', '44100', '-ac', '2',
    '-af', 'aresample=async=1:first_pts=0', '-avoid_negative_ts', 'make_zero'];
}

export function redactRtmpSecrets(value) {
  if (typeof value === 'string') return value.replace(/rtmps?:\/\/[^\s'"<>]+/gi, '[destino RTMP ocultado]');
  if (Array.isArray(value)) return value.map(redactRtmpSecrets);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactRtmpSecrets(v)]));
  return value;
}