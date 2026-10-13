import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fullChecksForEvent, requiresFullChecks } from '../scripts/ci-scope.mjs';
import { projectPath } from '../scripts/paths.mjs';

const base = 'a'.repeat(40),
  head = 'b'.repeat(40);
test('CI skips runtime work only for known documentation changes', () => {
  assert.equal(
    requiresFullChecks(['README.md', 'docs/usage.md', 'docs/assets/example.jpg']),
    false,
  );
  for (const path of [
    'src/client/index.tsx',
    'src/adapters/mysql.ts',
    'test/integration/mysql.ts',
    'package-lock.json',
    'cordis.patch.yml',
    '.github/workflows/check.yml',
    'docs/check.mjs',
    'new-file',
  ])
    assert.equal(requiresFullChecks(['README.md', path]), true, path);
  assert.equal(requiresFullChecks([]), true);
});

test('tags, forced releases, new branches and missing history retain the full CI matrix', () => {
  const event = {
    before: base,
    after: head,
    pull_request: { base: { sha: base }, head: { sha: head } },
  };
  const env = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main' };
  const docsDiff = () => 'docs/usage.md\0';
  assert.equal(fullChecksForEvent(event, env, docsDiff), false);
  assert.equal(fullChecksForEvent(event, { ...env, CI_FULL_CHECK: 'true' }, docsDiff), true);
  assert.equal(
    fullChecksForEvent(event, { ...env, GITHUB_REF: 'refs/tags/v0.1.0' }, docsDiff),
    true,
  );
  assert.equal(fullChecksForEvent({ ...event, before: '0'.repeat(40) }, env, docsDiff), true);
  assert.equal(fullChecksForEvent({}, env, docsDiff), true);
  assert.equal(
    fullChecksForEvent(event, env, () => {
      throw new Error('missing object');
    }),
    true,
  );
  assert.equal(
    fullChecksForEvent(event, { ...env, GITHUB_EVENT_NAME: 'workflow_dispatch' }, docsDiff),
    true,
  );
  assert.equal(
    fullChecksForEvent(event, { ...env, GITHUB_EVENT_NAME: 'pull_request' }, (args) => {
      assert(args.includes(`${base}...${head}`));
      assert(args.includes('--no-renames'));
      // A source file moved into docs remains a runtime change.
      return 'src/old.ts\0docs/old.md\0';
    }),
    true,
  );
});

test('release validation allows draft development but rejects unfinished release artifacts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-release-metadata-'));
  const write = (path, text) => writeFile(join(directory, path), text);
  const run = (args = [], tag = '') =>
    spawnSync(process.execPath, [projectPath('scripts/verify-release.mjs'), ...args], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, RELEASE_TAG: tag, GITHUB_OUTPUT: '' },
    });
  try {
    const pkg = {
      name: 'dsh-database',
      version: '0.1.0',
      license: 'MIT',
      publishConfig: { registry: 'https://registry.npmjs.org/' },
    };
    await mkdir(join(directory, 'docs'));
    await write('package.json', JSON.stringify(pkg));
    await write(
      'package-lock.json',
      JSON.stringify({ version: pkg.version, packages: { '': pkg } }),
    );
    await write('LICENSE', 'MIT License\n');
    await write('CHANGELOG.md', '# Changelog\n\n## 0.1.0 — 首版（待发布）\n');
    await write('README.md', '<!-- release-status: pending -->\n正式包尚未发布\n');
    await write('docs/compatibility.md', '0.1.0 待发布源码\n');
    assert.equal(run().status, 0);
    assert.notEqual(run(['--ready']).status, 0);
    assert.notEqual(run([], 'v0.1.0').status, 0);

    await write('CHANGELOG.md', '## 0.1.0 — 2026-10-17\n');
    assert.match(run([], 'v0.1.0').stderr, /Finalize README/);
    await write('README.md', '# Package\nInstall the latest release.\n');
    assert.match(run(['--ready']).stderr, /Describe the release candidate/);
    await write('docs/compatibility.md', '发布候选；registry 安装尚未验证。\n');
    assert.equal(run(['--ready']).status, 0);
    assert.equal(run([], 'v0.1.0').status, 0);
    assert.notEqual(run([], 'v0.1.1').status, 0);
    for (const heading of [
      '## 0.1.01 — 2026-10-17',
      '## 0.1.0 — 2026-02-30',
      '## 0.1.0 — 2026-13-01',
    ]) {
      await write('CHANGELOG.md', heading + '\n');
      assert.notEqual(run(['--ready']).status, 0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('documentation gate detects a removed public page and a renamed heading', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-doc-links-'));
  const run = () =>
    spawnSync(process.execPath, [projectPath('scripts/verify-docs.mjs')], {
      cwd: directory,
      encoding: 'utf8',
    });
  try {
    await mkdir(join(directory, 'docs'));
    await writeFile(join(directory, 'README.md'), '[备份](docs/usage.md#备份与恢复)\n');
    assert.match(run().stderr, /missing link target/);
    await writeFile(join(directory, 'docs/usage.md'), '## 配置\n');
    assert.match(run().stderr, /missing heading/);
    await writeFile(join(directory, 'docs/usage.md'), '## 备份与恢复\n');
    assert.equal(run().status, 0);

    // Community templates are optional, but their links must be checked when present.
    await mkdir(join(directory, '.github/templates'), { recursive: true });
    const template = join(directory, '.github/templates/contribution.md');
    await writeFile(template, '[贡献](../../CONTRIBUTING.md#提交修改)\n');
    assert.match(run().stderr, /missing link target/);
    await writeFile(join(directory, 'CONTRIBUTING.md'), '## 开始开发\n');
    assert.match(run().stderr, /missing heading/);
    await writeFile(join(directory, 'CONTRIBUTING.md'), '## 提交修改\n');
    assert.equal(run().status, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
