import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { artifactsPath } from '../scripts/paths.mjs';
import { prepareTlsFiles } from './docker/tls-files.js';

test('restrictive TLS fixtures expose public certificates while keeping private keys private', async () => {
  const parent = artifactsPath();
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'tls-permissions-'));
  const publicFiles = ['ca.pem', 'matching.pem', 'dns.pem', 'ip.pem', 'wrong.pem', 'expired.pem'];
  const keys = ['ca.key', 'server.key'];
  const originalUmask = process.umask();
  try {
    // Reproduce files created under umask 0077 without changing the test process's umask.
    for (const name of [...publicFiles, ...keys])
      await writeFile(join(directory, name), 'disposable synthetic fixture', { mode: 0o600 });
    await prepareTlsFiles(directory);
    assert.equal(process.umask(), originalUmask);
    if (process.platform !== 'win32') {
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      for (const name of publicFiles)
        assert.equal((await stat(join(directory, name))).mode & 0o777, 0o644);
      for (const name of keys)
        assert.equal((await stat(join(directory, name))).mode & 0o777, 0o600);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
