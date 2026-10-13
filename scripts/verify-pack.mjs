import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const zodRoot = dirname(require.resolve('zod/package.json'));
const bundledClient = readFileSync('dist/client.js', 'utf8');
assert(
  bundledClient.includes(readFileSync(join(zodRoot, 'LICENSE'), 'utf8').trim()),
  'Browser bundle must carry the full Zod copyright and license',
);
const [pack] = JSON.parse(
  execFileSync(
    process.env.npm_execpath ? process.execPath : 'npm',
    [
      ...(process.env.npm_execpath ? [process.env.npm_execpath] : []),
      'pack',
      '--dry-run',
      '--ignore-scripts',
      '--json',
    ],
    { encoding: 'utf8' },
  ),
);
const files = new Set(pack.files.map((file) => file.path));
for (const file of [
  'dist/index.js',
  'dist/index.d.ts',
  'dist/client.js',
  'dist/mcp.js',
  'dist/query.js',
  ...[
    'ports',
    'runtime',
    'bridge',
    'limits',
    'errors',
    'json-input',
    'policy',
    'inspect',
    'metadata-sql',
    'observability',
  ].map((name) => `dist/${name}.js`),
  'dist/adapters/index.js',
  'dist/engines.js',
  'dist/mongo.js',
  'dist/result.js',
  ...['mysql', 'postgresql', 'sqlserver', 'oracle', 'mongodb'].map(
    (engine) => `dist/adapters/${engine}.js`,
  ),
  'cordis.patch.yml',
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'docs/reference.md',
  'docs/examples/ecommerce/README.md',
  'docs/examples/ecommerce/seed.sql',
  'docs/examples/ecommerce/queries.sql',
  'docs/usage.md',
  'docs/compatibility.md',
  'docs/releasing.md',
  'docs/assets/connection-manager.jpg',
  'docs/assets/agent-analysis.jpg',
  'LICENSE',
  'CHANGELOG.md',
  'package.json',
])
  assert(files.has(file), `Missing package file: ${file}`);
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
function checkExport(value) {
  if (typeof value === 'string')
    assert(files.has(value.replace(/^\.\//, '')), `Missing export: ${value}`);
  else for (const nested of Object.values(value)) checkExport(nested);
}
checkExport(pkg.exports);
assert(files.has(pkg.dsh.bundle.patch.replace(/^\.\//, '')), 'Missing bundle patch');
for (const file of files)
  assert(
    /^(dist\/.*\.(js|d\.ts)|docs\/(usage|reference|compatibility|releasing)\.md|docs\/assets\/(connection-manager|agent-analysis)\.jpg|docs\/examples\/ecommerce\/(README\.md|seed\.sql|queries\.sql)|SECURITY\.md|package\.json|README\.md|CONTRIBUTING\.md|CHANGELOG\.md|LICENSE|cordis\.patch\.yml)$/.test(
      file,
    ) && !/(^|\/)(node_modules|test-results|\.env|connections|credentials)(\/|\.|$)/.test(file),
    `Private/test file packed: ${file}`,
  );
console.log(`Package verified: ${files.size} files, ${pack.size} bytes compressed.`);
