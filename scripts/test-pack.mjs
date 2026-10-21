import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { artifactsPath } from './paths.mjs';
import { hostPackageSpecs, hostSelector } from './host-release.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = artifactsPath('release');
await mkdir(artifacts, { recursive: true });
const { values } = parseArgs({ options: { dsh: { type: 'string', multiple: true } } });
const pkg = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
const npm = process.env.npm_execpath ? process.execPath : 'npm';
const npmArgs = process.env.npm_execpath ? [process.env.npm_execpath] : [];
const run = (args, cwd, env = process.env) =>
  execFileSync(npm, [...npmArgs, ...args], {
    cwd,
    env,
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
const lockedPackages = Object.entries(lock.packages)
  .filter(
    ([path, value]) => /^node_modules\/@deepseek-ai\/[^/]+$/.test(path) && !value.os && !value.cpu,
  )
  .map(([path, value]) => `${path.slice('node_modules/'.length)}@${value.version}`);
const hash = createHash('sha256')
  .update(await readFile(archive))
  .digest('hex');
await writeFile(`${archive}.sha256`, `${hash}  ${pack.filename}\n`);
const results = [];
const report = join(artifacts, 'compatibility.json');
await writeFile(report, '[]\n');
for (const selector of values.dsh ?? [undefined]) {
  const host = selector
    ? JSON.parse(
        run(['view', `@deepseek-ai/dsh@${hostSelector(selector, pkg)}`, '--json'], project),
      )
    : undefined;
  const hostPackages = host ? hostPackageSpecs(pkg, host) : lockedPackages;
  const label = host?.version ?? lock.packages['node_modules/@deepseek-ai/dsh-tools'].version;
  const directory = await mkdtemp(join(artifacts, `install-${label}-`));
  const env = { ...process.env, DSH_HOME: join(directory, 'home'), NODE_PATH: '' };
  const result = { selector: selector ?? 'locked', version: label, sha256: hash, passed: false };
  results.push(result);
  try {
    console.log(
      `Verifying ${pack.filename} with DSH ${label} (${selector ?? 'development lockfile'})`,
    );
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
      env,
    );
    if (host) {
      const cliPackage = join(directory, 'node_modules/@deepseek-ai/dsh');
      const cli = join(cliPackage, host.bin.dsh);
      const installed = spawnSync(
        process.execPath,
        [cli, 'plugin', '--profile', 'web', 'add', archive, '--ignore-scripts'],
        { cwd: directory, env, encoding: 'utf8', timeout: 300000, maxBuffer: 8 * 1024 * 1024 },
      );
      const output = (installed.stdout ?? '') + (installed.stderr ?? '');
      await writeFile(join(artifacts, `install-${host.version}.log`), output);
      if (installed.error) throw installed.error;
      if (installed.status !== 0) throw new Error(`Official DSH installer failed:\n${output}`);
      const profile = JSON.parse(
        await readFile(join(env.DSH_HOME, 'profiles/web/package.json'), 'utf8'),
      );
      if (!profile.dependencies?.[pkg.name])
        throw new Error('Official installer did not save the plugin');
      const installedPlugin = JSON.parse(
        await readFile(
          join(env.DSH_HOME, 'profiles/web/node_modules', pkg.name, 'package.json'),
          'utf8',
        ),
      );
      if (installedPlugin.version !== pkg.version)
        throw new Error('Official installer did not install the tested plugin version');
      await copyFile(
        join(project, 'test/compatibility-smoke.mjs'),
        join(directory, 'compatibility.mjs'),
      );
      execFileSync(process.execPath, ['compatibility.mjs'], {
        cwd: directory,
        env,
        stdio: 'inherit',
        timeout: 60000,
      });
    }
    await copyFile(join(project, 'test/pack-smoke.mjs'), join(directory, 'smoke.mjs'));
    execFileSync(process.execPath, ['smoke.mjs'], {
      cwd: directory,
      stdio: 'inherit',
      timeout: 60000,
      env,
    });
    result.passed = true;
  } finally {
    await writeFile(report, JSON.stringify(results, null, 2) + '\n');
    await rm(directory, { recursive: true, force: true });
  }
}
console.log(`Installed package verified: ${pack.filename}\nSHA-256: ${hash}`);
