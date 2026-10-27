import test from 'node:test';
import assert from 'node:assert/strict';
import { telecableInputArgs, classifyStreamFailure } from '../streaming-transport.js';
import { compressionFinding, labSuggestion, normalizeHistoricalProfile } from '../channel-life-rules.js';
test('Telecable never reconnects segment EOF or streamed byte offsets', () => {
  const args = telecableInputArgs();
  assert.equal(args.includes('-reconnect_at_eof'), false);
  assert.equal(args.includes('-reconnect_streamed'), false);
  assert.equal(args[args.indexOf('-rw_timeout') + 1], '15000000');
  assert.equal(args[args.indexOf('-reconnect_on_http_error') + 1], '5xx');
});
test('Input EOF and output write failures are different causes', () => {
  assert.equal(classifyStreamFailure('CDN EOF'), 'input');
  assert.equal(classifyStreamFailure('av_interleaved_write_frame(): Broken pipe'), 'output');
  assert.equal(classifyStreamFailure('Conversion failed!'), 'unknown');
});
test('Retired historical output IDs map to available profiles', () => {
  assert.equal(normalizeHistoricalProfile('mid576', { normalpro: {} }, { mid576: 'normalpro' }), 'normalpro');
  assert.equal(normalizeHistoricalProfile('obsolete', { normal: {} }, {}), null);
});
test('Laboratory recommendations only target running FUTV or FOX and 120 seconds', () => {
  assert.equal(labSuggestion({ slug: 'fox', running: true, q: 33 }).seconds, 120);
  assert.equal(labSuggestion({ slug: 'Teletica', running: true, q: 33 }), null);
  assert.equal(labSuggestion({ slug: 'futv', running: false, q: 33 }), null);
  assert.equal(compressionFinding(18, 'Normal'), null);
  assert.equal(compressionFinding(33, 'Normal').level, 'warn');
});