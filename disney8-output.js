// Compatibility boundary for Disney 8's manual RTMP output only.
// Keep source authentication, input pacing, selected bitrate and IPTV unchanged.
export function disney8EncodingArgs(args, profile, fps = '29.97') {
  if (profile.passthrough) return args;
  const inputEnd = args.indexOf('-i') + 2;
  if (inputEnd < 2) throw new Error('Falta la entrada de video');
  const replaced = new Set(['-r', '-vsync', '-g', '-keyint_min', '-sc_threshold',
    '-bf', '-pix_fmt', '-x264-params', '-vf', '-af', '-async',
    '-avoid_negative_ts', '-reset_timestamps', '-profile:a', '-ac']);
  const result = args.slice(0, inputEnd);
  let videoFilter = '';
  for (let i = inputEnd; i < args.length; i++) {
    if (args[i] === '-vf') videoFilter = args[i + 1];
    if (replaced.has(args[i])) { i++; continue; }
    result.push(args[i]);
  }
  const rate = Number(fps);
  const safeFps = Number.isFinite(rate) && rate > 0 && rate <= 60 ? rate : 29.97;
  const gop = String(Math.round(safeFps * 2));
  const params = (profile.x264Params || '').split(':').filter(Boolean)
    .filter(p => !/^(bframes|open-gop|force-cfr)=/.test(p));
  params.push('bframes=0', 'open-gop=0', 'force-cfr=1');
  return [...result,
    '-pix_fmt', 'yuv420p', '-bf', '0', '-x264-params', params.join(':'),
    '-vf', `${videoFilter || `scale=-2:${profile.width}`},setsar=1`,
    '-r', String(safeFps), '-vsync', 'cfr', '-g', gop, '-keyint_min', gop,
    '-sc_threshold', '0', '-profile:a', 'aac_low', '-ac', '2',
    '-af', 'aresample=async=1:first_pts=0', '-avoid_negative_ts', 'make_zero'];
}