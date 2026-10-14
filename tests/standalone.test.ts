import assert from 'node:assert/strict';
import test from 'node:test';
import { DirectRequestGate } from '../src/direct-request-gate';
import { sourceForUrl } from '../src/content/adapter';
import { isPackagedPracticeUrl, isSettingsUi } from '../src/shared/urls';
import { normalizeSettings } from '../src/shared/core';

test('direct mode is the default for fresh and upgraded settings, with explicit bridge/demo choices', () => {
  assert.equal(normalizeSettings({}).connectionMode, 'direct');
  assert.equal(normalizeSettings({ bridgeToken: 'existing-token', model: 'gpt-custom' }).connectionMode, 'direct');
  for (const connectionMode of ['direct', 'bridge', 'demo'] as const) assert.equal(normalizeSettings({ connectionMode }).connectionMode, connectionMode);
  assert.throws(() => normalizeSettings({ connectionMode: 'unknown' as any }), /Choose/);
});

test('direct requests enforce concurrency and a persisted rolling request limit', () => {
  let gate = new DirectRequestGate();
  const release = gate.claim(1000);
  assert.throws(() => gate.claim(1001), /still finishing/);
  release();
  for (let i = 1; i < 30; i++) gate.claim(1000 + i)();
  gate = new DirectRequestGate(gate.serialize());
  assert.throws(() => gate.claim(60000), /budget/);
  gate.claim(61000)();
  assert.equal(gate.serialize().length, 30);
  assert.equal(new DirectRequestGate([NaN, 'bad', -1, Infinity]).serialize().length, 0);
});

test('only the own packaged practice URL is recognized and only Settings/popup receive admin privileges', t => {
  const prior = (globalThis as any).chrome;
  const base = `chrome-extension://${'a'.repeat(32)}/`;
  (globalThis as any).chrome = { runtime: { getURL: (path: string) => base + path } };
  t.after(() => { (globalThis as any).chrome = prior; });
  assert.equal(isPackagedPracticeUrl(base + 'practice.html'), true);
  assert.equal(sourceForUrl(base + 'practice.html?example=1#question'), 'practice');
  assert.equal(isSettingsUi(base + 'options.html'), true);
  assert.equal(isSettingsUi(base + 'popup.html'), true);
  for (const url of [base + 'practice.html', base + 'options.html/other', 'https://example.com/options.html']) assert.equal(isSettingsUi(url), false);
  for (const url of [base + 'practice.html/other', base + 'options.html', base.replace(/a/g, 'b') + 'practice.html', 'https://example.com/practice.html']) {
    assert.equal(isPackagedPracticeUrl(url), false);
    assert.equal(sourceForUrl(url), null);
  }
});
