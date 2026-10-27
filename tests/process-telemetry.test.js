import test from 'node:test';
import assert from 'node:assert/strict';
import { trackedProcessIds } from '../process-telemetry.js';

test('Bulk status includes Canal8 27, Canal2 28 and Canal13 29', () => {
  const ids = trackedProcessIds({ '27': 'Canal8', '28': 'Canal2', '29': 'canal13sinart' });
  for (const id of ['27', '28', '29']) assert.ok(ids.includes(id));
  assert.equal(ids.length, 30);
});
test('Future channels are included without a manual status endpoint limit', () => {
  assert.ok(trackedProcessIds({ '31': 'future' }).includes('31'));
});