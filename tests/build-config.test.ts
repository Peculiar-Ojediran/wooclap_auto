import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

test('connected builds embed only the service origin and public identity, with narrowly scoped permissions', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'wooclap-build-test-'));
  const syntheticSecret = 'test-do-not-bundle-operator-key';
  try {
    await Promise.all([cp('src', join(temporary, 'src'), { recursive: true }), cp('extension', join(temporary, 'extension'), { recursive: true }), mkdir(join(temporary, 'server'))]);
    await cp('server/practice.html', join(temporary, 'server/practice.html'));
    await symlink(resolve('node_modules'), join(temporary, 'node_modules'), 'junction');
    // Module resolution for the copied source stays inside the installed repo.
    const env = { ...process.env, HOSTED_FALLBACK_URL: 'https://fallback.example/', NVIDIA_API_KEY: syntheticSecret };
    execFileSync(process.execPath, [resolve('scripts/build.mjs')], { cwd: temporary, env, stdio: 'pipe' });
    const manifest = JSON.parse(await readFile(join(temporary, 'dist/edge/manifest.json'), 'utf8'));
    assert.ok(manifest.host_permissions.includes('https://fallback.example/*'));
    assert.ok(!manifest.host_permissions.includes('https://*/*'));
    assert.match(manifest.content_security_policy.extension_pages, /connect-src https:\/\/fallback\.example /);
    const publicKey = (await readFile('extension/hosted-public-key.txt', 'utf8')).trim();
    assert.equal(manifest.key, publicKey);
    const id = [...createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex').slice(0, 32)].map(hex => String.fromCharCode(97 + parseInt(hex, 16))).join('');
    const config = JSON.parse(await readFile('hosted/wrangler.jsonc', 'utf8'));
    assert.equal(config.vars.ALLOWED_EXTENSION_IDS, id);
    for (const file of await readdir(join(temporary, 'dist/edge'))) {
      assert.ok(!(await readFile(join(temporary, 'dist/edge', file), 'utf8')).includes(syntheticSecret));
    }
    assert.throws(() => execFileSync(process.execPath, [resolve('scripts/build.mjs')], { cwd: temporary,
      env: { ...env, HOSTED_FALLBACK_URL: 'https://user:password@fallback.example' }, stdio: 'pipe' }));
  } finally {
    const absolute = resolve(temporary);
    if (absolute.startsWith(resolve(tmpdir()) + sep) && absolute.includes('wooclap-build-test-')) {
      await unlink(join(absolute, 'node_modules')).catch(() => undefined);
      await rm(absolute, { recursive: true, force: true });
    }
  }
});
