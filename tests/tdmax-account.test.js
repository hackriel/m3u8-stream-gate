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