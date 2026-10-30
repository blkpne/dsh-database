import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { withContainer, cleanupExpired, expiryLabel } from './docker/lifecycle.js';
import { command, commandFailure } from './docker/process.js';
import type { DockerCommand, CommandOptions } from './docker/process.js';
import { selectEngines } from './docker/definitions.js';
import { waitReady } from './docker/fixtures.js';

function fakeDocker() {
  const calls: { args: string[]; options?: CommandOptions }[] = [];
  let exists = false;
  let volume = false;
  let createFailure = false;
  let removalFailure = false;
  let autoRemove = false;
  let exited = false;
  const run: DockerCommand = async (args, options) => {
    calls.push({ args, options });
    if (args[0] === 'create') {
      exists = volume = true;
      autoRemove = args.includes('--rm');
      if (createFailure) throw new Error('Daemon created resource but response was lost');
    }
    if (args[0] === 'inspect') {
      if (!exists) throw new Error('Container already removed');
      if (args.includes('{{json .State}}'))
        return JSON.stringify({ Running: !exited, OOMKilled: exited, ExitCode: exited ? 137 : 0 });
      return JSON.stringify([{ Type: 'volume', Name: 'owned-volume' }]);
    }
    if (args[0] === 'port') return '127.0.0.1:45678';
    if (args[0] === 'rm') {
      if (removalFailure) throw new Error('Removal temporarily unavailable');
      exists = volume = false;
    }
    if (args[0] === 'ps') return exists ? 'owned-container' : '';
    if (args[0] === 'volume') return volume ? 'owned-volume' : '';
    return '';
  };
  const guards: boolean[] = [];
  return {
    run,
    calls,
    guards,
    watch: async () => (clean: boolean) => {
      guards.push(clean);
    },
    failCreate() {
      createFailure = true;
    },
    failRemoval() {
      removalFailure = true;
    },
    exit() {
      exited = true;
      if (autoRemove) exists = volume = false;
    },
  };
}

test('Docker success uses isolated loopback instance, random env-only secrets and verified volume cleanup', async () => {
  const fake = fakeDocker();
  const value = await withContainer(
    'mysql',
    async (instance) => {
      assert.equal(instance.port, 45678);
      const create = fake.calls.find((call) => call.args[0] === 'create')!;
      assert(!create.args.join(' ').includes(instance.password));
      assert(!create.args.join(' ').includes(instance.adminPassword));
      assert.equal(create.options!.env!.MYSQL_ROOT_PASSWORD, instance.adminPassword);
      assert(create.args.includes('127.0.0.1::3306'));
      assert(create.args.includes('--memory'));
      return 42;
    },
    fake,
  );
  assert.equal(value, 42);
  assert.deepEqual(fake.guards, [true]);
  assert(fake.calls.some(({ args }) => args[0] === 'volume'));
});

test('Docker startup failure retains safe exit diagnostics until owned cleanup removes its resources', async () => {
  const fake = fakeDocker();
  await withContainer(
    'mongodb',
    async (instance) => {
      fake.exit();
      await assert.rejects(waitReady(instance, fake.run), { code: 'DOCKER_OOM' });
    },
    fake,
  );
  assert(fake.calls.some(({ args }) => args[0] === 'rm' && args.includes('--volumes')));
  assert.deepEqual(fake.guards, [true]);
});

test('Docker startup exit codes stay actionable without exposing raw container state', async () => {
  const secret = randomBytes(24).toString('hex');
  const fake = fakeDocker();
  await withContainer(
    'mongodb',
    async (instance) => {
      const run: DockerCommand = async () =>
        JSON.stringify({ Running: false, OOMKilled: false, ExitCode: 132, Error: secret });
      await assert.rejects(waitReady(instance, run), (error: any) => {
        assert.equal(error.code, 'DOCKER_CONTAINER_EXITED');
        assert.match(error.message, /132/);
        assert(!error.message.includes(secret));
        return true;
      });
    },
    fake,
  );
});

test('Docker partial create failure still removes its preassigned container name', async () => {
  const fake = fakeDocker();
  fake.failCreate();
  await assert.rejects(withContainer('postgresql', async () => assert.fail('must not run'), fake));
  assert(fake.calls.some(({ args }) => args[0] === 'rm' && args.includes('--volumes')));
  assert.deepEqual(fake.guards, [false]);
});

test('Docker test failure and cancellation cannot cancel independent cleanup', async () => {
  for (const cancel of [false, true]) {
    const fake = fakeDocker();
    const controller = new AbortController();
    await assert.rejects(
      withContainer(
        'mariadb',
        async () => {
          if (cancel) controller.abort();
          throw new Error('Fixture/test failed');
        },
        { ...fake, signal: controller.signal },
      ),
    );
    const removals = fake.calls.filter(({ args }) => args[0] === 'rm');
    assert.equal(removals.length, 1);
    assert.equal(removals[0]!.options?.signal, undefined);
    assert.deepEqual(fake.guards, [true]);
  }
});

test('Docker cleanup failure remains a failure and transfers cleanup to watchdog', async () => {
  const fake = fakeDocker();
  fake.failRemoval();
  await assert.rejects(
    withContainer('mysql', async () => {}, fake),
    /Cleanup failed/,
  );
  assert.equal(fake.calls.filter(({ args }) => args[0] === 'rm').length, 3);
  assert.deepEqual(fake.guards, [false]);
});

test('Docker expired cleanup leaves live leases and unrelated resources untouched', async () => {
  const removed: string[] = [];
  const names = [
    'dsh-database-test-mysql-0123456789abcdef',
    'dsh-database-test-postgresql-fedcba9876543210',
  ];
  const run: DockerCommand = async (args) => {
    if (args[0] === 'ps')
      return args.some((arg) => arg.startsWith('label=')) ? 'expired active invalid' : '';
    if (args[0] === 'inspect')
      return JSON.stringify([
        {
          Name: `/${args[1] === 'expired' ? names[0] : names[1]}`,
          Config: {
            Labels: {
              [expiryLabel]:
                args[1] === 'expired'
                  ? String(Date.now() - 1000)
                  : args[1] === 'active'
                    ? String(Date.now() + 60000)
                    : 'invalid',
            },
          },
        },
      ]);
    if (args[0] === 'rm') removed.push(args.at(-1)!);
    return '';
  };
  assert.equal(await cleanupExpired(run), 1);
  assert.deepEqual(removed, [names[0]]);
});

test('Docker selection rejects typos instead of silently skipping a requested database', () => {
  assert.throws(() => selectEngines(''));
  assert.throws(() => selectEngines('mysql,postgress'));
  assert.throws(() => selectEngines('mysql,'));
  assert.deepEqual(selectEngines('postgresql,mysql,postgresql'), ['postgresql', 'mysql']);
});

test('subprocess timeout/abort are bounded and never include argv or stderr credentials', async () => {
  const secret = randomBytes(24).toString('hex');
  await assert.rejects(
    command(
      process.execPath,
      ['-e', `console.error(${JSON.stringify(secret)});setTimeout(()=>{},30000)`],
      { timeoutMs: 100 },
    ),
    (error: Error) => {
      assert.match(error.message, /timed out/);
      assert(!error.message.includes(secret));
      return true;
    },
  );
  await assert.rejects(
    command(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], {
      signal: AbortSignal.timeout(100),
    }),
    /canceled/,
  );
});

test('Docker setup failures provide actionable categories without leaking stderr credentials', () => {
  const secret = randomBytes(24).toString('hex');
  for (const [message, code] of [
    ['Cannot connect to the Docker daemon', 'DOCKER_UNAVAILABLE'],
    ['No such image', 'DOCKER_IMAGE_UNAVAILABLE'],
    ['no matching manifest for linux/arm64', 'DOCKER_PLATFORM'],
    ['no space left on device', 'DOCKER_RESOURCES'],
    ['permission denied', 'DOCKER_PERMISSION'],
    ['unrecognized failure', 'DOCKER_COMMAND_FAILED'],
  ]) {
    const error = commandFailure('docker', 1, `${message}: password=${secret}`);
    assert.equal(error.code, code);
    assert(!error.message.includes(secret));
    assert(!error.stack?.includes(secret));
  }
});
