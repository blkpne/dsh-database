import assert from 'node:assert/strict';
import { readFileSync, appendFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
assert.equal(pkg.name, 'dsh-database');
assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
assert.equal(lock.version, pkg.version, 'Lockfile version must match');
assert.equal(lock.packages[''].version, pkg.version, 'Lockfile root version must match');
assert.equal(pkg.license, 'MIT', 'Release license must match LICENSE');
assert.equal(lock.packages[''].license, pkg.license);
assert.match(readFileSync('LICENSE', 'utf8'), /^MIT License\n/);
const changelog = readFileSync('CHANGELOG.md', 'utf8');
const heading = changelog.split('\n').find((line) => line.startsWith(`## ${pkg.version} — `));
assert(heading, 'Missing changelog heading for this exact version');
assert.equal(pkg.publishConfig.registry, 'https://registry.npmjs.org/');
if (process.env.RELEASE_TAG || process.argv.includes('--ready')) {
  const date = heading.match(/ — (\d{4}-\d{2}-\d{2})$/)?.[1];
  assert(
    date && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date,
    'Finalize the changelog heading as: ## <version> — YYYY-MM-DD',
  );
  assert(
    !/release-status:\s*pending|正式包尚未发布|无功能的占位包/.test(
      readFileSync('README.md', 'utf8'),
    ),
    'Finalize README before building the release artifact; remove the pending marker and notice',
  );
  assert(
    !readFileSync('docs/compatibility.md', 'utf8').includes('待发布源码'),
    'Describe the release candidate in compatibility.md; leave unverified registry/platform checks explicit',
  );
}
if (process.env.RELEASE_TAG) {
  assert.equal(process.env.RELEASE_TAG, `v${pkg.version}`, 'Tag must match package.json version');
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `dist_tag=${pkg.version.includes('-') ? 'next' : 'latest'}\n`,
    );
}
console.log(`Release metadata verified: ${pkg.name}@${pkg.version}, ${pkg.license}.`);
