import test from 'node:test';
import assert from 'node:assert/strict';
import { OUTPUT_PROFILES, profileScaleFilter, profileLevelArgs, srtMaxrate, NATURAL_CADENCE_PROFILES } from '../encoding-profiles.js';
import { laboratoryArgs } from '../laboratory.js';
import { disney8EncodingArgs } from '../disney8-output.js';

// Mirrors server.js main HLS re-encode path (input args + codec args).
function mainArgs(p, fps = 30) {
  const gop = String(fps * 2);
  return ['-re', '-i', 'https://src/playlist.m3u8', '-map', '0:v:0?', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', p.preset, '-profile:v', 'main', ...profileLevelArgs(p),
    '-threads', String(p.threads || 4), '-b:v', p.videoBitrate, '-maxrate', p.maxrate || p.videoBitrate, '-bufsize', p.bufsize,
    ...(p.x264Params ? ['-x264-params', p.x264Params] : []),
    '-vf', profileScaleFilter(p) + (p.denoise ? ',' + p.denoise : ''), '-vsync', 'passthrough',
    '-g', gop, '-keyint_min', gop, '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', p.audioBitrate, '-ar', p.audioRate || '44100', ...(p.audioRate ? ['-ac', '2'] : [])];
}
const val = (a, f) => a[a.indexOf(f) + 1];

test('deportes1200 generates the exact requested FFmpeg arguments', () => {
  const a = mainArgs(OUTPUT_PROFILES.deportes1200, 30);
  const s = a.join(' ');
  assert.ok(a.indexOf('-re') < a.indexOf('-i'));
  assert.equal(val(a, '-vf'), 'scale=-2:540:flags=lanczos,format=yuv420p');
  assert.equal(val(a, '-b:v'), '1100k'); assert.equal(val(a, '-maxrate'), '1400k'); assert.equal(val(a, '-bufsize'), '2100k');
  assert.equal(val(a, '-g'), '60'); assert.equal(val(a, '-keyint_min'), '60'); assert.equal(val(a, '-sc_threshold'), '0');
  assert.equal(val(a, '-preset'), 'medium'); assert.equal(val(a, '-level:v'), '3.1'); assert.equal(val(a, '-threads'), '4');
  assert.equal(val(a, '-x264-params'), 'rc-lookahead=30:bframes=3:b-adapt=2:ref=3:aq-mode=3:aq-strength=0.9:qcomp=0.7:ipratio=1.3:psy-rd=0.8,0:deblock=1,1');
  assert.ok(!s.includes('hqdn3d')); assert.ok(!s.includes('zerolatency')); assert.ok(!s.includes('-qmax'));
  assert.equal(val(a, '-b:a'), '96k'); assert.equal(val(a, '-ar'), '48000'); assert.equal(val(a, '-ac'), '2');
  assert.ok(NATURAL_CADENCE_PROFILES.has('deportes1200'));
  assert.equal(srtMaxrate(OUTPUT_PROFILES.deportes1200), '1400k');
});

test('Existing profiles are unchanged', () => {
  const expected = {
    passthrough: { key: 'passthrough', label: 'Passthrough (sin re-encode)', width: '', videoBitrate: '', bufsize: '', audioBitrate: '', preset: '', x264Params: '', passthrough: true },
    highquality: { key: 'highquality', label: 'Alta Calidad', width: '720', videoBitrate: '4000k', bufsize: '8000k', audioBitrate: '192k', preset: 'faster', x264Params: 'rc-lookahead=30:ref=3:bframes=2', threads: 6 },
    normal: { key: 'normal', label: 'Normal', width: '720', videoBitrate: '2000k', bufsize: '4000k', audioBitrate: '128k', preset: 'veryfast', x264Params: '' },
    normalpro: { key: 'normalpro', label: 'Normal Mejorado Pro', width: '720', videoBitrate: '2000k', bufsize: '4000k', audioBitrate: '128k', audioRate: '48000', preset: 'fast', x264Params: 'rc-lookahead=40:ref=4:bframes=3:aq-mode=3:aq-strength=1.1:me=umh:subme=8:scenecut=0', denoise: 'hqdn3d=1.5:1.5:6:6', threads: 6 },
    classic1000: { key: 'classic1000', label: 'Clásico 480p · 1000', width: '480', videoBitrate: '1000k', bufsize: '2000k', audioBitrate: '128k', audioRate: '48000', preset: 'fast', x264Params: 'rc-lookahead=30:ref=3:bframes=2:aq-mode=2:aq-strength=1.0:me=hex:subme=7:scenecut=0', denoise: 'hqdn3d=1.0:1.0:0:0', threads: 4 },
    classic1000plus: { key: 'classic1000plus', label: 'Clásico 480p · 1000 Plus', width: '480', videoBitrate: '1000k', bufsize: '2000k', audioBitrate: '128k', audioRate: '48000', preset: 'medium', x264Params: 'rc-lookahead=40:ref=4:bframes=3:aq-mode=2:aq-strength=1.0:me=umh:subme=8:scenecut=0', denoise: 'hqdn3d=1.0:1.0:0:0', threads: 6 },
    hd720: { key: 'hd720', label: 'HD 720p (3000k)', width: '720', videoBitrate: '3000k', maxrate: '3600k', bufsize: '6000k', audioBitrate: '128k', preset: 'faster', x264Params: 'rc-lookahead=25:ref=3:bframes=2:aq-mode=2:aq-strength=1.0', threads: 6 },
  };
  for (const [k, v] of Object.entries(expected)) {
    assert.deepEqual(OUTPUT_PROFILES[k], v, k);
    assert.equal(profileScaleFilter(v), `scale=-2:${v.width}`);
    assert.deepEqual(profileLevelArgs(v), []);
    assert.equal(srtMaxrate(v), v.videoBitrate);
  }
});

test('Laboratory deportes1200 is VBR 1100k/1400k at 540p with 96k audio', () => {
  const a = laboratoryArgs('in', 'out', 'deportes1200');
  assert.equal(val(a, '-b:v'), '1100k'); assert.equal(val(a, '-maxrate'), '1400k'); assert.equal(val(a, '-bufsize'), '2100k');
  assert.equal(a.includes('-minrate'), false); assert.equal(val(a, '-b:a'), '96k');
  assert.equal(val(a, '-vf'), 'scale=-2:540:flags=lanczos,format=yuv420p');
});

test('Disney 8 RTMP keeps deportes1200 bitrate, cap and 540p scale', () => {
  const out = disney8EncodingArgs(mainArgs(OUTPUT_PROFILES.deportes1200), OUTPUT_PROFILES.deportes1200, '29.97');
  assert.equal(val(out, '-b:v'), '1100k'); assert.equal(val(out, '-maxrate'), '1400k');
  assert.ok(val(out, '-vf').startsWith('scale=-2:540:flags=lanczos'));
});
