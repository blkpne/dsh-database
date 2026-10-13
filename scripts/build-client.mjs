import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const zodRoot = dirname(require.resolve('zod/package.json'));
const zod = JSON.parse(await readFile(join(zodRoot, 'package.json'), 'utf8'));
const license = await readFile(join(zodRoot, 'LICENSE'), 'utf8');
const result = await build({
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  loader: { '.css': 'text' },
  minify: true,
  legalComments: 'eof',
  metafile: true,
});
// Fail closed if a new browser dependency is bundled without a license entry.
for (const input of Object.keys(result.metafile.inputs)) {
  if (input.includes('node_modules/') && !input.includes('node_modules/zod/'))
    throw new Error(`Missing browser dependency license: ${input}`);
}
await writeFile(
  'dist/client.js',
  `/*! Bundled dependency: zod ${zod.version}\n${license.replaceAll('*/', '* /')}\n*/\nwindow.__ModuleLoader__.load({id:"dsh-database",factory:(require)=>{const module={exports:{}};const exports=module.exports;\n${result.outputFiles[0].text}\nreturn module.exports;}});\n`,
);
