import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { artifactsPath } from './paths.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = artifactsPath('release');
await mkdir(artifacts, { recursive: true });
const npm = process.env.npm_execpath ? process.execPath : 'npm';
const npmArgs = process.env.npm_execpath ? [process.env.npm_execpath] : [];
const run = (args, cwd) =>
  execFileSync(npm, [...npmArgs, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 300000,
    maxBuffer: 8 * 1024 * 1024,
  });
run(['run', 'build'], project);
const [pack] = JSON.parse(
  run(['pack', '--ignore-scripts', '--json', '--pack-destination', artifacts], project),
);
const archive = join(artifacts, pack.filename);
// Install the complete tested host baseline explicitly, never mixing release lines.
const lock = JSON.parse(await readFile(join(project, 'package-lock.json'), 'utf8'));
// Let npm choose optional native binaries for this platform instead of forcing every arch.
const hostPackages = Object.entries(lock.packages)
  .filter(
    ([path, value]) => /^node_modules\/@deepseek-ai\/[^/]+$/.test(path) && !value.os && !value.cpu,
  )
  .map(([path, value]) => `${path.slice('node_modules/'.length)}@${value.version}`);
const directory = await mkdtemp(join(artifacts, 'install-'));
try {
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ name: 'dsh-database-release-smoke', private: true, type: 'module' }),
  );
  // No source checkout symlinks or NODE_PATH: imports must resolve from the installed tarball.
  run(
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      archive,
      ...hostPackages,
      'react@18.3.1',
    ],
    directory,
  );
  await copyFile(join(project, 'test/pack-smoke.mjs'), join(directory, 'smoke.mjs'));
  execFileSync(process.execPath, ['smoke.mjs'], {
    cwd: directory,
    stdio: 'inherit',
    timeout: 60000,
    env: { ...process.env, NODE_PATH: '' },
  });
  const hash = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex');
  await writeFile(`${archive}.sha256`, `${hash}  ${pack.filename}\n`);
  console.log(`Installed package verified: ${pack.filename}\nSHA-256: ${hash}`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
