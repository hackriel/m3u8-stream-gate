import test from 'node:test';
import assert from 'node:assert/strict';
import { isYouTubeDestination, validateYouTubeOutput, youtubeEncodingArgs, redactRtmpSecrets } from '../youtube-output.js';

const hd = { width: '720', videoBitrate: '3000k', bufsize: '6000k' };
const target = 'rtmps://a.rtmps.youtube.com:443/live2/test-only-key';
const args = ['-re', '-i', 'sample.ts', '-map', '0:v:0?', '-map', '0:a:0?', '-c:v', 'copy', '-bsf:v', 'h264_mp4toannexb', '-reset_timestamps', '1'];
const option = (list, key) => list[list.indexOf(key) + 1];
test('Detect only YouTube ingest hosts, including RTMPS', () => {
  assert.equal(isYouTubeDestination(target), true);
  assert.equal(isYouTubeDestination('rtmp://a.rtmp.youtube.com/live2/test'), true);
  assert.equal(isYouTubeDestination('rtmp://a.rtmp.youtube.com.evil.test/live2/test'), false);
  assert.equal(isYouTubeDestination('rtmp://fluestabiliz.giize.com/test'), false);
});
test('720p requires the documented 3000k minimum without changing selected bitrate', () => {
  assert.match(validateYouTubeOutput(target, { ...hd, videoBitrate: '2000k' }), /3000/);
  assert.equal(validateYouTubeOutput(target, hd), null);
  assert.equal(validateYouTubeOutput(target, { ...hd, videoBitrate: '4000k' }), null);
});
test('Require full destination key and processed video/audio', () => {
  assert.match(validateYouTubeOutput('rtmps://a.rtmps.youtube.com/live2', hd), /clave/);
  assert.match(validateYouTubeOutput(target, { passthrough: true }), /Passthrough/);
  assert.match(validateYouTubeOutput(target, hd, true), /Passthrough/);
});
test('YouTube uses 30fps, closed 2-second GOP, CBR and stereo AAC 128k at 44100', () => {
  const out = youtubeEncodingArgs(args, hd);
  assert.deepEqual(out.slice(0, 3), ['-re', '-i', 'sample.ts']);
  for (const [key, value] of Object.entries({ '-c:v': 'libx264', '-c:a': 'aac', '-r': '30', '-g': '60', '-keyint_min': '60', '-vsync': 'cfr', '-b:v': '3000k', '-minrate': '3000k', '-maxrate': '3000k', '-ar': '44100', '-b:a': '128k', '-ac': '2', '-pix_fmt': 'yuv420p' })) assert.equal(option(out, key), value);
  assert.match(option(out, '-x264-params'), /open-gop=0/);
  assert.match(option(out, '-x264-params'), /bframes=2:ref=1/);
  assert.equal(out.includes('-bsf:v'), false);
  assert.equal(out.includes('0:v:0?'), false);
  assert.match(option(out, '-vf'), /scale=1280:720/);
});
test('Experimental x264 parameters cannot override YouTube GOP and references', () => {
  const out = youtubeEncodingArgs(args, { ...hd, x264Params: 'ref=4:bframes=3:open-gop=1:aq-mode=2' });
  assert.equal(option(out, '-x264-params'), 'aq-mode=2:bframes=2:ref=1:open-gop=0:nal-hrd=cbr:force-cfr=1');
});
test('RTMP keys never appear in nested log details', () => {
  const result = redactRtmpSecrets({ target, info: `Failed ${target}`, list: [target] });
  assert.equal(JSON.stringify(result).includes('test-only-key'), false);
  assert.equal(result.target, '[destino RTMP ocultado]');
});