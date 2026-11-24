// Catálogo de perfiles de salida de producción (importado por server.js).
// Campos opcionales: maxrate (tope VBR), scaleFilter (reemplaza scale=-2:<width>),
// level (nivel H.264), denoise, audioRate (+ -ac 2), threads, forceCfr.
export const OUTPUT_PROFILES = {
  passthrough:{ key: 'passthrough',label: 'Passthrough (sin re-encode)', width: '', videoBitrate: '', bufsize: '', audioBitrate: '', preset: '', x264Params: '', passthrough: true },
  highquality:{ key: 'highquality',label: 'Alta Calidad', width: '720', videoBitrate: '4000k', bufsize: '8000k', audioBitrate: '192k', preset: 'faster',   x264Params: 'rc-lookahead=30:ref=3:bframes=2', threads: 6 },
  normal:     { key: 'normal',     label: 'Normal',     width: '720', videoBitrate: '2000k', bufsize: '4000k', audioBitrate: '128k', preset: 'veryfast', x264Params: '' },
  // Normal Mejorado Pro — MISMO 2000k CBR fijo (sin picos: maxrate = bitrate),
  // pero exprime cada bit: preset fast (mejor estimación de movimiento que
  // veryfast), lookahead 40 (~1.3s de anticipación para reservar bits antes
  // de las panorámicas de fútbol), aq-mode 3 (más bits a zonas complejas),
  // ref=4/bframes=3/me=umh/subme=8 (predicción de movimiento fina) y denoise
  // ligero hqdn3d que quita el ruido de la re-compresión previa de la fuente
  // y libera bits para la imagen real. GOP fijo 2s (scenecut=0) para XUI.
  normalpro:  { key: 'normalpro',  label: 'Normal Mejorado Pro', width: '720', videoBitrate: '2000k', bufsize: '4000k', audioBitrate: '128k', audioRate: '48000', preset: 'fast', x264Params: 'rc-lookahead=40:ref=4:bframes=3:aq-mode=3:aq-strength=1.1:me=umh:subme=8:scenecut=0', denoise: 'hqdn3d=1.5:1.5:6:6', threads: 6 },
  // HD 720p — equivalente al 720p30 de YouTube live (3000k) y al escalón
  // 720p de la escalera Netflix. VBV 2x para picos de movimiento.
  // Clásico 480p · 1000 — validado en Laboratorio (FUTV, 120s: 1.65x, 0 descartados).
  // CBR fijo 1000k sin picos, filtro espacial leve, sin reducir color.
  classic1000:{ key: 'classic1000',label: 'Clásico 480p · 1000', width: '480', videoBitrate: '1000k', bufsize: '2000k', audioBitrate: '128k', audioRate: '48000', preset: 'fast', x264Params: 'rc-lookahead=30:ref=3:bframes=2:aq-mode=2:aq-strength=1.0:me=hex:subme=7:scenecut=0', denoise: 'hqdn3d=1.0:1.0:0:0', threads: 4 },
  // Clásico Plus — mismo 1000k/480p, preset medium (más CPU, más detalle, misma red).
  classic1000plus:{ key: 'classic1000plus',label: 'Clásico 480p · 1000 Plus', width: '480', videoBitrate: '1000k', bufsize: '2000k', audioBitrate: '128k', audioRate: '48000', preset: 'medium', x264Params: 'rc-lookahead=40:ref=4:bframes=3:aq-mode=2:aq-strength=1.0:me=umh:subme=8:scenecut=0', denoise: 'hqdn3d=1.0:1.0:0:0', threads: 6 },
  // Deportes · 540p (id interno deportes1200, se mantiene para no romper selecciones guardadas).
  // - inputFflags +genpts+discardcorrupt + aresample async: descarta paquetes dañados
  //   sin perder sincronía audio/video (evita bloques e imágenes fuera de lugar).
  // - bwdif deint=interlaced: desentrelaza solo fotogramas entrelazados (1080i); en progresivo no actúa.
  // - sc_threshold 40 + force_key_frames cada 2 s: keyframe en cortes/destellos (evita el
  //   "arrugado") y un IDR exacto cada 2 s para XUI/HLS. Sin -keyint_min (x264 lo limita).
  // - open-gop=0: GOP cerrado, cada segmento HLS se decodifica solo.
  // - VBR 1250k / tope 1600k / VBV 3200k: menos red que 2000k, reserva para paneos (~1,7 Mbps máx total).
  // - lookahead 40, qcomp 0.7, aq-mode 3: más bits al movimiento y al césped.
  // - psy-rd 0.8,0 y deblock 1,1: cuando faltan bits, suavizado en vez de bloques.
  deportes1200:{ key: 'deportes1200', label: 'Deportes · 540p', width: '540', scaleFilter: 'bwdif=mode=send_frame:parity=auto:deint=interlaced,scale=-2:540:flags=lanczos,format=yuv420p', level: '3.1', videoBitrate: '1250k', maxrate: '1600k', bufsize: '3200k', audioBitrate: '96k', audioRate: '48000', preset: 'medium', x264Params: 'rc-lookahead=40:bframes=3:b-adapt=2:ref=3:open-gop=0:aq-mode=3:aq-strength=0.9:qcomp=0.7:psy-rd=0.8,0:deblock=1,1', threads: 4, scThreshold: '40', forceKeyFrames: 'expr:gte(t,n_forced*2)', inputFflags: '+genpts+discardcorrupt', audioFilter: 'aresample=async=1:first_pts=0' },
  hd720:      { key: 'hd720',      label: 'HD 720p (3000k)', width: '720', videoBitrate: '3000k', maxrate: '3600k', bufsize: '6000k', audioBitrate: '128k', preset: 'faster', x264Params: 'rc-lookahead=25:ref=3:bframes=2:aq-mode=2:aq-strength=1.0', threads: 6 },
};
export const profileScaleFilter = (profile, height = profile.width) => profile.scaleFilter || `scale=-2:${height}`;
export const profileLevelArgs = (profile) => (profile.level ? ['-level:v', profile.level] : []);
// Rutas SRT históricas usan CBR (maxrate = bitrate); solo perfiles VBR declarados
// explícitamente (deportes1200) aplican su tope ahí, para no alterar hd720.
export const srtMaxrate = (profile) => (profile.key === 'deportes1200' ? profile.maxrate : profile.videoBitrate);
export const NATURAL_CADENCE_PROFILES = new Set(['highquality', 'normal', 'normalpro', 'classic1000', 'classic1000plus', 'hd720', 'deportes1200']);
// GOP: perfiles clásicos fijan keyint_min = g y sc_threshold 0; los que declaran
// scThreshold permiten keyframes por corte y fuerzan un IDR cada 2 s.
export const profileGopArgs = (profile, gop) => (profile.scThreshold
  ? ['-g', String(gop), '-sc_threshold', profile.scThreshold, '-force_key_frames', profile.forceKeyFrames]
  : ['-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0']);
// Une los -fflags de la ingesta con los del perfil sin duplicar banderas.
export const mergeFflags = (base, profile) => {
  const flags = [...new Set([...(base || '').split('+'), ...((profile && profile.inputFflags) || '').split('+')].filter(Boolean))];
  return flags.length ? '+' + flags.join('+') : '';
};
export const profileAudioFilterArgs = (profile) => (profile.audioFilter ? ['-af', profile.audioFilter] : []);
