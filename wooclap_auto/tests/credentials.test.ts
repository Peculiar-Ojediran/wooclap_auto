import assert from 'node:assert/strict';
import test from 'node:test';
import { CredentialVault } from '../src/credentials';

function storage() {
  const data: Record<string, unknown> = {};
  const area = {
    get: async (key: string) => ({ [key]: data[key] }),
    set: async (values: object) => { Object.assign(data, structuredClone(values)); },
    remove: async (key: string) => { delete data[key]; }
  } as Pick<chrome.storage.StorageArea, 'get' | 'set' | 'remove'>;
  return { data, area };
}

test('API keys default to session storage, survive worker recreation, and are absent from public status', async () => {
  const session = storage(), local = storage();
  const vault = new CredentialVault(session.area, local.area);
  await vault.save('openai', 'test-session-key', undefined, undefined);
  assert.deepEqual(local.data, {});
  assert.equal(await vault.read('openai'), 'test-session-key');
  assert.deepEqual((await vault.status()).openai, { configured: true, storage: 'session' });
  assert.ok(!JSON.stringify(await vault.status()).includes('test-session-key'));
  assert.equal(await new CredentialVault(session.area, local.area).read('openai'), 'test-session-key');
  assert.equal(await new CredentialVault(storage().area, local.area).read('openai'), undefined);
});

test('persistent keys require explicit consent and can be downgraded or forgotten independently', async () => {
  const session = storage(), local = storage();
  const vault = new CredentialVault(session.area, local.area);
  for (const consent of [false, undefined, 'true', 1]) {
    assert.throws(() => vault.save('anthropic', 'test-claude-key', true, consent), /Permission/);
    assert.deepEqual(local.data, {});
    assert.deepEqual(session.data, {});
  }
  await vault.save('anthropic', 'test-claude-key', true, true);
  await vault.save('openai', 'test-openai-key', false, false);
  assert.equal(local.data['apiKey.anthropic'], 'test-claude-key');
  assert.equal(session.data['apiKey.anthropic'], undefined);
  assert.equal(await new CredentialVault(storage().area, local.area).read('anthropic'), 'test-claude-key');
  await vault.save('anthropic', 'test-new-claude-key', false, false);
  assert.equal(local.data['apiKey.anthropic'], undefined);
  assert.equal((await vault.status()).anthropic.storage, 'session');
  await vault.clear('anthropic');
  assert.equal(await vault.read('anthropic'), undefined);
  assert.equal(await vault.read('openai'), 'test-openai-key');
  await vault.save('openai', 'test-remembered-key', true, true);
  await vault.clear('openai');
  assert.deepEqual(local.data, {});
  assert.deepEqual(session.data, {});
});

test('key changes serialize so a forget cannot be undone by an earlier pending save', async () => {
  const session = storage(), local = storage();
  const vault = new CredentialVault(session.area, local.area);
  await Promise.all([vault.save('anthropic', 'test-key', true, true), vault.clear('anthropic')]);
  assert.equal(await vault.read('anthropic'), undefined);
});

test('malformed credentials are rejected without echoing their contents or poisoning later writes', async () => {
  const session = storage(), local = storage();
  const vault = new CredentialVault(session.area, local.area);
  for (const key of ['', 'key with space', 'key\nnew-line', 'x'.repeat(513), 42]) {
    assert.throws(() => vault.save('openai', key, false, false), /valid API key/);
  }
  assert.throws(() => vault.save('unknown', 'test-key', false, false), /Choose/);
  assert.throws(() => vault.clear('unknown'), /Choose/);
  const failing = { ...local.area, set: async () => { throw new Error('test-sensitive-key'); } };
  const broken = new CredentialVault(session.area, failing);
  await assert.rejects(broken.save('openai', 'test-sensitive-key', true, true), error => {
    assert.ok(error instanceof Error && !error.message.includes('test-sensitive-key'));
    return true;
  });
  await broken.save('openai', 'test-recovered-key', false, false);
  assert.equal(await broken.read('openai'), 'test-recovered-key');
});
