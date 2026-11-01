import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('Disney 8 selects the info account for local VPS scraping', () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const mapping = source.match(/const PI_ACCOUNT_PROCESSES = new Set\(\[([^\]]+)\]\)/);
  assert.ok(mapping);
  const accounts = runInNewContext(`new Set([${mapping[1]}])`);
  assert.equal(accounts.has('10'), true);
});

test('Disney 8 selects the info account for fallback scraping', () => {
  const source = readFileSync(new URL('../src/components/EmisorM3U8Panel.tsx', import.meta.url), 'utf8');
  const mapping = source.match(/const PI_ACCOUNT_PROCESSES = new Set<number>\(\[([^\]]+)\]\)/);
  assert.ok(mapping);
  const accounts = runInNewContext(`new Set([${mapping[1]}])`);
  assert.equal(accounts.has(10), true);
});

test('Disney 8 resolves the FUTV URL channel directly and preserves its RTMP destination', async () => {
  const source = readFileSync(new URL('../src/components/EmisorM3U8Panel.tsx', import.meta.url), 'utf8');
  const catalog = source.match(/const CHANNEL_CONFIGS: ChannelConfig\[\] = (\[[\s\S]*?\n\]);/);
  const handler = source.match(/const fetchChannelUrl = useCallback\((async \(processIndex: number\) => \{[\s\S]*?)\n  \}, \[\]\);/);
  assert.ok(catalog);
  assert.ok(handler);
  const configs = runInNewContext(catalog[1], { SRT_INTERNAL_SOURCE_URL: 'srt://obs' });
  let request;
  let updated;
  const fetchChannel = runInNewContext(`(${handler[1].replace('processIndex: number', 'processIndex').replace('error: unknown', 'error')}\n})`, {
    CHANNEL_CONFIGS: configs,
    DISNEY8_INDEX: 10,
    FUTV_URL_INDEX: 11,
    setFetchingChannel() {},
    scrapeChannelWithFallback: async (channel, process) => {
      request = { channel, process };
      return { success: true, url: 'https://example.test/futv.m3u8' };
    },
    updateProcess: (process, values) => { updated = { process, ...values }; },
    processesRef: { current: { 10: { rtmp: 'rtmp://example.test/live/destination' } } },
    toast: { success() {}, error() {} },
    console,
    getErrorMessage: error => String(error),
  });
  await fetchChannel(10);
  assert.deepEqual(request, { channel: '641cba02e4b068d89b2344e3', process: 10 });
  assert.deepEqual(updated, { process: 10, m3u8: 'https://example.test/futv.m3u8', rtmp: 'rtmp://example.test/live/destination' });
});