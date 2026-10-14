import { build } from 'esbuild';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, createPublicKey } from 'node:crypto';

const outdir = resolve('dist/edge');
const configuredFallback = process.env.HOSTED_FALLBACK_URL?.trim() || '';
let fallbackUrl = '';
if (configuredFallback) {
  const url = new URL(configuredFallback);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.port || url.search || url.hash
    || !url.hostname.includes('.') || url.hostname.endsWith('.localhost') || url.hostname.startsWith('[') || /^[\d.]+$/.test(url.hostname)) {
    throw new Error('HOSTED_FALLBACK_URL must be a public HTTPS origin without credentials, a path, or a port.');
  }
  fallbackUrl = url.origin;
}
await mkdir(outdir, { recursive: true });
await build({
  entryPoints: { background: 'src/background.ts', content: 'src/content/index.ts', popup: 'src/ui/popup.ts', options: 'src/ui/options.ts' },
  bundle: true, outdir, target: 'chrome116', format: 'iife', platform: 'browser',
  sourcemap: false, minify: false, legalComments: 'none',
  define: { __HOSTED_FALLBACK_URL__: JSON.stringify(fallbackUrl) }
});
for (const file of ['manifest.json', 'popup.html', 'options.html', 'ui.css']) {
  await copyFile(resolve('extension', file), resolve(outdir, file));
}
// Reuse the practice fixture while honoring extension CSP: no inline scripts.
const practice = await readFile(resolve('server/practice.html'), 'utf8');
const scripts = [...practice.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (scripts.length !== 1) throw new Error('Expected one practice script to package.');
await writeFile(resolve(outdir, 'practice.js'), scripts[0][1]);
await writeFile(resolve(outdir, 'practice.html'), practice.replace(scripts[0][0], '<script src="practice.js"></script>\n<script src="content.js"></script>'));
console.log(`Edge extension built: ${outdir}`);
// Grant only this build's service origin, never broad access to arbitrary hosts.
const manifestPath = resolve(outdir, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (fallbackUrl) {
  // A public manifest key gives distributed unpacked builds one stable ID.
  // This is public identity material, never a provider key or private key.
  const publicKey = (await readFile(resolve('extension/hosted-public-key.txt'), 'utf8')).trim();
  createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
  manifest.key = publicKey;
  const id = [...createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex').slice(0, 32)]
    .map(hex => String.fromCharCode(97 + parseInt(hex, 16))).join('');
  console.log(`Shared-service extension ID: ${id}`);
  manifest.host_permissions.push(`${fallbackUrl}/*`);
  manifest.content_security_policy.extension_pages = manifest.content_security_policy.extension_pages.replace('connect-src ', `connect-src ${fallbackUrl} `);
}
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
