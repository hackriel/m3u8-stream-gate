import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { hasProcessExited, positiveVideoFrame, tdmaxProbeSettings, terminateForRecovery } from '../tdmax-recovery.js';

test('a sent SIGTERM must not hide a still-alive process from the watchdog', () => {
  assert.equal(hasProcessExited({ killed: true, exitCode: null, signalCode: null }), false);
  assert.equal(hasProcessExited({ killed: true, exitCode: null, signalCode: 'SIGKILL' }), true);
});

test('only a positive encoded video frame confirms startup', () => {
  assert.equal(positiveVideoFrame('frame=    0 fps=0.0'), 0);
  assert.equal(positiveVideoFrame('fps=30.0'), 0);
  assert.equal(positiveVideoFrame('frame=    1 fps=0.4'), 1);
});

test('TDMax recovery retains 3s and 2MB probing for H264 headers', () => {
  assert.deepEqual(tdmaxProbeSettings('https://cdn12.teletica.com/StreamTDMas1/chunks.m3u8', true, false), {
    analyzeDuration: '3000000', probeSize: '2000000',
  });
  assert.deepEqual(tdmaxProbeSettings('https://example.test/live.m3u8', true, false), {
    analyzeDuration: '1500000', probeSize: '500000',
  });
});

test('termination waits and escalates even when SIGTERM marked the child killed', async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"]);
  const closed = once(child, 'close');
  try {
    await once(child.stdout, 'data');
    const result = await terminateForRecovery(child, async (proc, timeout) => {
      assert.equal(timeout, 2000);
      assert.equal(proc.killed, true);
      assert.equal(hasProcessExited(proc), false);
      proc.kill('SIGKILL');
      await closed;
    });
    assert.equal(result, true);
    assert.equal(child.signalCode, 'SIGKILL');
  } finally {
    if (!hasProcessExited(child)) child.kill('SIGKILL');
  }
});