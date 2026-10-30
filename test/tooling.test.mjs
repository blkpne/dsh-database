import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { artifactsPath, projectPath, temporaryDirectory } from '../scripts/paths.mjs';

test('artifact defaults stay inside the checkout when launched from a different directory', async () => {
  const cwd = process.cwd();
  const override = process.env.DSH_DATABASE_TEST_ROOT;
  try {
    delete process.env.DSH_DATABASE_TEST_ROOT;
    process.chdir(tmpdir());
    assert.equal(
      relative(projectPath(), artifactsPath('release')),
      join('test-results', 'release'),
    );
    process.env.DSH_DATABASE_TEST_ROOT = 'test-results/custom';
    assert.equal(artifactsPath('release'), projectPath('test-results/custom/release'));
  } finally {
    process.chdir(cwd);
    if (override === undefined) delete process.env.DSH_DATABASE_TEST_ROOT;
    else process.env.DSH_DATABASE_TEST_ROOT = override;
  }
});

test('parallel experiment directories own separate files and resolve this checkout dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh tooling with spaces-'));
  const override = process.env.DSH_DATABASE_TEST_ROOT;
  try {
    process.env.DSH_DATABASE_TEST_ROOT = root;
    const [first, second] = await Promise.all([
      temporaryDirectory('experiment-', true),
      temporaryDirectory('experiment-', true),
    ]);
    assert.notEqual(first, second);
    for (const directory of [first, second]) {
      assert.equal(
        await realpath(join(directory, 'node_modules')),
        await realpath(projectPath('node_modules')),
      );
      assert.equal(
        JSON.parse(await readFile(join(directory, 'node_modules/pg/package.json'))).name,
        'pg',
      );
    }
    await rm(first, { recursive: true });
    assert.equal(
      JSON.parse(await readFile(join(second, 'node_modules/pg/package.json'))).name,
      'pg',
    );
    assert.equal(
      JSON.parse(await readFile(projectPath('node_modules/pg/package.json'))).name,
      'pg',
    );
  } finally {
    if (override === undefined) delete process.env.DSH_DATABASE_TEST_ROOT;
    else process.env.DSH_DATABASE_TEST_ROOT = override;
    await rm(root, { recursive: true, force: true });
  }
});
