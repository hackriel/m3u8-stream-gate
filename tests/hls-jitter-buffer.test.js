import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { splitJitterBufferArgs, startJitterBufferedEncoder } from '../hls-jitter-buffer.js';

const prod = ['-rw_timeout', '15000000', '-reconnect', '1', '-user_agent', 'UA', '-re', '-fflags', '+genpts',
  '-analyzeduration', '3000000', '-probesize', '2000000', '-i', 'https://cdn/x.m3u8',
  '-map', '0:p:2:v?', '-map', '0:p:2:a?', '-c:v', 'libx264', '-b:v', '2000k', '-f', 'flv', 'rtmp://dest/app/key'];
const value = (a, f) => a[a.indexOf(f) + 1];

test('Network options go to the reader and -re stays on the encoder input', () => {
  const { readerArgs, encoderArgs } = splitJitterBufferArgs(prod);
  assert.equal(readerArgs.includes('-re'), false);
  assert.equal(value(readerArgs, '-reconnect'), '1');
  assert.equal(value(readerArgs, '-i'), 'https://cdn/x.m3u8');
  assert.ok(encoderArgs.indexOf('-re') < encoderArgs.indexOf('-i'));
  assert.equal(value(encoderArgs, '-i'), 'pipe:0');
  assert.equal(encoderArgs.includes('-reconnect'), false);
  assert.equal(encoderArgs.includes('https://cdn/x.m3u8'), false);
});
test('Program mapping is applied by the reader; encoder keeps the selected bitrate and destination', () => {
  const { readerArgs, encoderArgs } = splitJitterBufferArgs(prod);
  assert.equal(value(readerArgs, '-map'), '0:p:2:v?');
  assert.equal(value(readerArgs, '-c'), 'copy');
  assert.equal(value(encoderArgs, '-map'), '0:v:0?');
  assert.equal(value(encoderArgs, '-b:v'), '2000k');
  assert.equal(encoderArgs.at(-1), 'rtmp://dest/app/key');
});
test('Non-HTTP inputs or inputs without realtime pacing are not split', () => {
  assert.equal(splitJitterBufferArgs(['-re', '-i', 'srt://0.0.0.0:9000', '-f', 'flv', 'x']), null);
  assert.equal(splitJitterBufferArgs(['-i', 'https://cdn/x.m3u8', '-f', 'flv', 'x']), null);
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
test('A 4 s late segment does not pause realtime encoder output', { skip: !hasFfmpeg, timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jb-'));
  spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=sample_rate=48000',
    '-t', '12', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-c:a', 'aac', '-f', 'hls', '-hls_time', '2',
    '-hls_list_size', '0', '-hls_playlist_type', 'vod', path.join(dir, 'live.m3u8')]);
  const server = http.createServer((req, res) => {
    const file = path.join(dir, path.basename(req.url));
    setTimeout(() => res.end(fs.readFileSync(file)), req.url.includes('live3.ts') ? 4000 : 0);
  });
  await new Promise(r => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}/live.m3u8`;
  const args = ['-re', '-i', url, '-map', '0:v:0?', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'ultrafast', '-f', 'null', '-'];
  const encoder = startJitterBufferedEncoder(splitJitterBufferArgs(args));
  let last = 0, lastAt = Date.now(), maxGap = 0;
  encoder.stderr.on('data', d => {
    const frames = [...d.toString().matchAll(/frame=\s*(\d+)/g)].map(m => +m[1]);
    const f = frames.length ? Math.max(...frames) : 0;
    if (f > last) { if (last > 30) maxGap = Math.max(maxGap, Date.now() - lastAt); last = f; lastAt = Date.now(); }
  });
  const code = await new Promise(r => encoder.on('close', r));
  server.close();
  assert.equal(code, 0);
  assert.ok(last >= 350, `frames ${last}`);
  assert.ok(maxGap < 2000, `output paused ${maxGap} ms`);
});
