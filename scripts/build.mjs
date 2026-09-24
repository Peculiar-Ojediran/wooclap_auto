import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const outdir = resolve('dist/edge');
await mkdir(outdir, { recursive: true });
await build({
  entryPoints: { background: 'src/background.ts', content: 'src/content/index.ts', popup: 'src/ui/popup.ts', options: 'src/ui/options.ts' },
  bundle: true, outdir, target: 'chrome116', format: 'iife', platform: 'browser',
  sourcemap: false, minify: false, legalComments: 'none'
});
for (const file of ['manifest.json', 'popup.html', 'options.html', 'ui.css']) {
  await copyFile(resolve('extension', file), resolve(outdir, file));
}
console.log(`Edge extension built: ${outdir}`);
