import test from 'node:test';
import assert from 'node:assert/strict';
import { disney8EncodingArgs } from '../disney8-output.js';

const profile = { width: '480', videoBitrate: '1000k', x264Params: 'rc-lookahead=30:bframes=2:aq-mode=2' };
const args = ['-re', '-fflags', '+genpts', '-i', 'sample.ts', '-c:v', 'libx264',
  '-b:v', '1000k', '-maxrate', '1000k', '-bufsize', '2000k', '-vf', 'scale=-2:480,hqdn3d=1:1:0:0',
  '-vsync', 'passthrough', '-g', '59.94', '-keyint_min', '59.94', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000'];
const value = (out, flag) => out[out.indexOf(flag) + 1];
test('Disney 8 keeps the 1000k selection, VBV, audio bitrate and realtime input', () => {
  const out = disney8EncodingArgs(args, profile);
  assert.deepEqual(out.slice(0, 5), args.slice(0, 5));
  for (const [flag, expected] of Object.entries({ '-b:v': '1000k', '-maxrate': '1000k', '-bufsize': '2000k', '-b:a': '128k', '-ar': '48000' })) assert.equal(value(out, flag), expected);
});
test('RTMP uses native 29.97 CFR, integer closed GOP 60 and no reordered B frames', () => {
  const out = disney8EncodingArgs(args, profile);
  for (const [flag, expected] of Object.entries({ '-r': '29.97', '-vsync': 'cfr', '-g': '60', '-keyint_min': '60', '-bf': '0' })) assert.equal(value(out, flag), expected);
  assert.equal(value(out, '-x264-params'), 'rc-lookahead=30:aq-mode=2:bframes=0:open-gop=0:force-cfr=1');
  assert.equal(out.includes('59.94'), false);
});
test('RTMP keeps denoising, square pixels and a zero-based synchronized audio start', () => {
  const out = disney8EncodingArgs(args, profile);
  assert.equal(value(out, '-vf'), 'scale=-2:480,hqdn3d=1:1:0:0,setsar=1');
  assert.equal(value(out, '-af'), 'aresample=async=1:first_pts=0');
  assert.equal(value(out, '-avoid_negative_ts'), 'make_zero');
});
test('Copy mode is not silently re-encoded', () => {
  assert.equal(disney8EncodingArgs(args, { passthrough: true }), args);
});
test('Source frame rates yield integer two-second GOPs', () => {
  assert.equal(value(disney8EncodingArgs(args, profile, '25'), '-g'), '50');
  assert.equal(value(disney8EncodingArgs(args, profile, 'invalid'), '-g'), '60');
});