import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import semver from 'semver';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));

test('host peers retain the minimum minor and accept the latest compatible minor', () => {
  for (const [name, accepted, rejected] of [
    ['@deepseek-ai/cordis', ['4.0.4', '4.0.5', '4.1.0'], ['4.0.3', '4.2.0', '5.0.0']],
    ['@deepseek-ai/schemastery', ['3.18.4', '3.18.5', '3.19.0'], ['3.18.3', '3.20.0', '4.0.0']],
  ]) {
    const range = pkg.peerDependencies[name];
    assert.equal(lock.packages[''].peerDependencies[name], range);
    for (const version of accepted) assert(semver.satisfies(version, range), `${name} ${version}`);
    for (const version of rejected)
      assert.equal(semver.satisfies(version, range), false, `${name} ${version}`);
  }
});
