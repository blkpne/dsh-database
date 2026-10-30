import { randomBytes } from 'node:crypto';
import { fork } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { docker } from './process.js';
import type { DockerCommand } from './process.js';
import { definitions } from './definitions.js';
import type { Engine } from '../../src/engines.js';

export const ownerLabel = 'io.dsh-database.test';
export const expiryLabel = 'io.dsh-database.expires';
export interface Instance {
  engine: Engine;
  name: string;
  port: number;
  adminPassword: string;
  password: string;
  signal: AbortSignal;
}

export async function removeContainer(name: string, run: DockerCommand = docker): Promise<void> {
  if (!/^dsh-database-test-[a-z]+-[a-f0-9]{16}$/.test(name))
    throw new Error('Invalid test container name');
  // No global prune, no deletion by image or port. --volumes removes only its anonymous data.
  for (let attempt = 0; attempt < 3; attempt++) {
    await run(['rm', '--force', '--volumes', name]).catch(() => {});
    const remaining = await run(['ps', '-aq', '--filter', `name=^/${name}$`]);
    if (!remaining) return;
    await delay(200);
  }
  throw new Error(
    `Cleanup failed for ${name}; run npm run test:docker:cleanup after its lease expires`,
  );
}

async function guard(name: string, timeoutMs: number): Promise<(clean: boolean) => void> {
  const child = fork(new URL('./watchdog.ts', import.meta.url), [name, String(timeoutMs)], {
    execArgv: ['--import', 'tsx'],
    detached: true,
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Cleanup watchdog did not start'));
    }, 10000);
    child.once('message', () => {
      clearTimeout(timer);
      resolve();
    });
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('Cleanup watchdog failed'));
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Cleanup watchdog exited'));
    });
  });
  child.unref();
  child.channel?.unref();
  return (clean) => {
    if (!child.connected) return;
    if (clean) child.send('clean');
    else child.disconnect();
  };
}

export async function withContainer<T>(
  engine: Engine,
  action: (instance: Instance) => Promise<T>,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    run?: DockerCommand;
    watch?: typeof guard;
  } = {},
): Promise<T> {
  const run = options.run ?? docker;
  const definition = definitions[engine];
  const timeoutMs = options.timeoutMs ?? 600000;
  const signal = AbortSignal.any([
    AbortSignal.timeout(timeoutMs),
    ...(options.signal ? [options.signal] : []),
  ]);
  const name = `dsh-database-test-${engine}-${randomBytes(8).toString('hex')}`;
  const adminPassword = `Aa9_${randomBytes(18).toString('hex')}`;
  const password = `Bb8_${randomBytes(18).toString('hex')}`;
  const environment = definition.env(adminPassword);
  const stopGuard = await (options.watch ?? guard)(name, timeoutMs + 30000);
  let volumes: string[] = [];
  let createAttempted = false;
  let createAcknowledged = false;
  try {
    signal.throwIfAborted();
    createAttempted = true;
    await run(
      [
        'create',
        '--name',
        name,
        '--restart=no',
        '--label',
        `${ownerLabel}=true`,
        '--label',
        `${expiryLabel}=${Date.now() + timeoutMs + 30000}`,
        '--memory',
        definition.memory,
        '--memory-swap',
        definition.memory,
        '--cpus',
        '2',
        '--log-opt',
        'max-size=5m',
        '--log-opt',
        'max-file=1',
        '--publish',
        `127.0.0.1::${definition.port}`,
        ...Object.keys(environment).flatMap((key) => ['--env', key]),
        definition.image,
        ...(definition.args ?? []),
      ],
      { env: { ...process.env, ...environment }, signal, timeoutMs: 60000 },
    );
    createAcknowledged = true;
    const mounts = JSON.parse(
      await run(['inspect', '--format', '{{json .Mounts}}', name], { signal }),
    );
    volumes = mounts
      .filter((mount: { Type: string }) => mount.Type === 'volume')
      .map((mount: { Name: string }) => mount.Name);
    await run(['start', name], { signal });
    const published = await run(['port', name, `${definition.port}/tcp`], { signal });
    const match = /^127\.0\.0\.1:(\d+)$/.exec(published);
    if (!match) throw new Error('Container did not bind exclusively to loopback');
    return await action({ engine, name, port: Number(match[1]), adminPassword, password, signal });
  } finally {
    // Cleanup gets its own timeout: an already-aborted test must not cancel resource removal.
    try {
      await removeContainer(name, run);
      for (const volume of volumes) {
        const remaining = await run(['volume', 'ls', '-q', '--filter', `name=^${volume}$`]);
        if (remaining) throw new Error(`Anonymous test volume was not removed for ${name}`);
      }
      // A killed CLI can leave a daemon request completing after the first removal.
      stopGuard(!createAttempted || createAcknowledged);
    } catch (error) {
      stopGuard(false);
      throw error;
    }
  }
}

export async function cleanupExpired(run: DockerCommand = docker): Promise<number> {
  const ids = (await run(['ps', '-aq', '--filter', `label=${ownerLabel}=true`]))
    .split(/\s+/)
    .filter(Boolean);
  let count = 0;
  for (const id of ids) {
    const [info] = JSON.parse(await run(['inspect', id]));
    const expires = Number(info.Config.Labels[expiryLabel]);
    if (Number.isFinite(expires) && expires > 0 && expires <= Date.now()) {
      await removeContainer(info.Name.replace(/^\//, ''), run);
      count++;
    }
  }
  return count;
}
