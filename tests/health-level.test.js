import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyHealth } from '../health-level.js';

const ok = { status: 'running', fps: 30, speed: 1.0 };

test('High compression (Q 41) with 30 FPS and 1.00x stays SANO, only noted', () => {
  const r = classifyHealth({ ...ok, q: 41 });
  assert.equal(r.level, 'stable');
  assert.deepEqual(r.notes, ['q']);
});
test('Sustained FPS below 15 is still INESTABLE', () => {
  assert.equal(classifyHealth({ ...ok, fps: 12, q: 20 }).level, 'critical');
});
test('Speed outside 0.85-1.25 is still INESTABLE', () => {
  assert.equal(classifyHealth({ ...ok, speed: 0.8 }).level, 'critical');
});
test('Three recoveries in the window are INESTABLE, one is ATENCION', () => {
  assert.equal(classifyHealth({ ...ok, recentRecoveries: 3 }).level, 'critical');
  assert.equal(classifyHealth({ ...ok, recentRecoveries: 1 }).level, 'warning');
});
