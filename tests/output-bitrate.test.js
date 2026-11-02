import test from 'node:test';
import assert from 'node:assert/strict';
import { playlistOutputKbps } from '../output-bitrate.js';

test('A ten-second 2000 kbps completed segment stays 2000, not 4000 at a five-second poll', () => {
  assert.equal(playlistOutputKbps('#EXTM3U\n#EXTINF:10,\nseg.ts\n', () => 2500000), 2000);
});
test('Delivered video plus audio and transport is measured, not the selected target or input', () => {
  assert.equal(playlistOutputKbps('#EXTINF:4,\na.ts\n#EXTINF:6,\nb.ts', name => name === 'a.ts' ? 1100000 : 1650000), 2200);
});
test('Incomplete, missing and remote segments do not inflate output measurement', () => {
  const playlist = '#EXTINF:10,\na.ts\n#EXTINF:10,\nmissing.ts\n#EXTINF:10,\nhttps://source/input.ts\nunfinished.ts';
  assert.equal(playlistOutputKbps(playlist, name => { if (name === 'missing.ts') throw new Error('gone'); return 2500000; }), 2000);
  assert.equal(playlistOutputKbps('#EXTM3U\nunfinished.ts', () => 2500000), null);
});