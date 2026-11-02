// Only completed local playlist segments describe delivered media bitrate.
// Use media duration, never the polling interval or an unfinished segment.
export function playlistOutputKbps(playlist, segmentSize) {
  let duration = null;
  let seconds = 0;
  let bytes = 0;
  for (const raw of playlist.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF:')) {
      duration = Number(line.slice(8).split(',')[0]);
      continue;
    }
    if (!line || line.startsWith('#')) continue;
    const segmentSeconds = duration;
    duration = null;
    if (!Number.isFinite(segmentSeconds) || segmentSeconds <= 0) continue;
    if (!/^[a-zA-Z0-9_.-]+\.(ts|m4s)$/.test(line)) continue;
    let size;
    try { size = segmentSize(line); } catch { continue; }
    if (!Number.isFinite(size) || size <= 0) continue;
    seconds += segmentSeconds;
    bytes += size;
  }
  return seconds > 0 ? Math.round(bytes * 8 / seconds / 1000) : null;
}