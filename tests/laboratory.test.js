import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { spawnSync } from 'node:child_process';
import { LAB_LIMITS, LAB_PROFILES, laboratoryArgs, snapshotPlaylist, createLaboratory } from '../laboratory.js';

test('All laboratory outputs keep video at 2000k with a 2000k ceiling and 128k audio', () => {
  for (const profile of ['normal','normalpro','sportsdetail','sportsclean']) {
    const args = laboratoryArgs('input', 'output', profile);
    for (const flag of ['-b:v', '-minrate', '-maxrate']) assert.equal(args[args.indexOf(flag) + 1], '2000k');
    assert.equal(args[args.indexOf('-b:a') + 1], '128k');
  }
});
test('Classic uses 1000k video with a 1000k ceiling, 2000k buffer and unchanged 128k audio', () => {
  const args = laboratoryArgs('input', 'output', 'classic1000');
  for (const flag of ['-b:v','-minrate','-maxrate']) assert.equal(args[args.indexOf(flag)+1], '1000k');
  assert.equal(args[args.indexOf('-bufsize')+1], '2000k');
  assert.equal(args[args.indexOf('-b:a')+1], '128k');
});
test('Classic is non-HD 480p H264 without color reduction, temporal denoising or FPS conversion', () => {
  const args = laboratoryArgs('input', 'output', 'classic1000');
  assert.equal(args[args.indexOf('-vf')+1], 'scale=-2:480,hqdn3d=1.0:1.0:0:0');
  assert.equal(args[args.indexOf('-c:v')+1], 'libx264');
  assert.equal(args.includes('-r'), false);
  assert.equal(LAB_PROFILES.classic1000.experimental, true);
});
test('Sports candidates remain experimental H264 720p with no FPS conversion or slow preset', () => {
  for (const profile of ['sportsdetail', 'sportsclean']) {
    assert.equal(LAB_PROFILES[profile].experimental, true);
    const args = laboratoryArgs('input', 'output', profile);
    assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
    assert.ok(args[args.indexOf('-vf') + 1].startsWith('scale=-2:720'));
    assert.ok(['fast', 'faster'].includes(args[args.indexOf('-preset') + 1]));
    assert.equal(args.includes('-r'), false);
  }
  assert.throws(() => laboratoryArgs('input', 'output', 'sd480'));
});
test('History retention is 48 hours', () => assert.equal(LAB_LIMITS.retentionMs, 48 * 3600000));
test('Snapshot retains at most 30 seconds and never modifies live segments', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lab-test-'));
  try {
    const live = path.join(root, 'live'); await fs.mkdir(live);
    await fs.writeFile(path.join(live, 'playlist.m3u8'), '#EXTM3U\n' + [1,2,3,4].map(i => `#EXTINF:10,\ns${i}.ts\n`).join(''));
    for (const i of [1,2,3,4]) await fs.writeFile(path.join(live, `s${i}.ts`), `segment${i}`);
    const snapshot = await snapshotPlaylist(live, path.join(root, 'sample'));
    assert.equal(snapshot.seconds, 30); assert.equal(snapshot.segments, 3);
    assert.equal(await fs.readFile(path.join(live, 's4.ts'), 'utf8'), 'segment4');
    await fs.writeFile(path.join(live, 'playlist.m3u8'), '#EXTM3U\n#EXTINF:10,\nhttps://example.com/token.ts\n');
    await assert.rejects(snapshotPlaylist(live, path.join(root, 'unsafe')));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('Real local capture, five encodes and persisted results complete without scraping', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lab-flow-'));
  const live = path.join(root, 'live', 'futv'); await fs.mkdir(live, { recursive: true });
  const generated = spawnSync('ffmpeg', ['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=30','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','2','-c:v','libx264','-preset','ultrafast','-g','30','-c:a','aac','-f','hls','-hls_time','1','-hls_list_size','0',path.join(live,'playlist.m3u8')]);
  assert.equal(generated.status, 0);
  const lab = createLaboratory({ liveDir: path.join(root,'live'), dataDir: path.join(root,'data'), getSource: () => ({ running: true, provider: 'TDMax' }), canRun: () => true });
  const app = express(); app.use(express.json()); app.use('/api/laboratory',lab.router);
  const server = app.listen(0); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/laboratory`;
  const headers = { 'Content-Type': 'application/json', 'X-Dashboard-Auth': 'Qm9hbmVyZ2VzMTIq' };
  try {
    assert.equal((await fetch(base)).status,403);
    assert.equal((await fetch(base+'/start',{method:'POST',headers,body:JSON.stringify({channel:'futv'})})).status,202);
    assert.equal((await fetch(base+'/start',{method:'POST',headers,body:JSON.stringify({channel:'fox'})})).status,409);
    let state;
    for(let i=0;i<150;i++) { state=await (await fetch(base,{headers})).json(); if(!state.active) break; await new Promise(r=>setTimeout(r,200)); }
    assert.equal(state.history[0]?.status,'completed',JSON.stringify(state.history[0]));
    assert.deepEqual(state.history[0].results.map(r => r.profile), ['normal','normalpro','sportsdetail','sportsclean','classic1000']);
    assert.equal(state.history[0].profiles.filter(p => p.experimental).length,3);
    assert.ok(state.history[0].results.every(r=>r.videoKbps>0 && r.speed>0));
    assert.equal(JSON.parse(await fs.readFile(path.join(root,'data','laboratory-results.json'),'utf8'))[0].channel,'futv');
    assert.ok((await fs.readdir(live)).includes('playlist.m3u8'));
  } finally { await lab.stop(); await new Promise(r=>server.close(r)); await fs.rm(root,{recursive:true,force:true}); }
});
