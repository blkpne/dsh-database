import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { options, releasePort } from '../scripts/dev-web.mjs';
import { processBackend, runCommand } from '../scripts/dev-platform.mjs';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';

test('Web launcher reuses the standard home/profile and validates overrides before mutations', () => {
  const defaults = options([], {});
  assert.equal(defaults.dshHome, join(homedir(), '.dsh'));
  assert.equal(defaults.profile, 'web');
  assert.equal(defaults.port, 3080);
  const custom = options(['mount', '--no-open'], {
    DSH_HOME: join(tmpdir(), 'dsh-test'),
    DSH_DATABASE_WEB_PROFILE: 'repeatable',
    DSH_DATABASE_WEB_PORT: '5199',
    DSH_DATABASE_WEB_WORKSPACE: tmpdir(),
  });
  assert.equal(custom.mode, 'mount');
  assert.equal(custom.dshHome, join(tmpdir(), 'dsh-test'));
  assert.equal(custom.port, 5199);
  assert.equal(custom.workspace, tmpdir());
  assert.equal(custom.noOpen, true);
  for (const port of ['0', '65536', '3080;kill', 'NaN', '3.5'])
    assert.throws(() => options([], { DSH_DATABASE_WEB_PORT: port }));
  assert.throws(() => options([], { DSH_DATABASE_WEB_PROFILE: '../web' }));
  assert.throws(() => options([], { DSH_DATABASE_WEB_PROFILE: 'headless' }));
  assert.throws(() => options(['unexpected'], {}));
});

async function server(ignoreTerm = false) {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import http from 'node:http';
    const server = http.createServer((_req, res) => res.end('fixture'));
    ${ignoreTerm ? "process.on('SIGTERM', () => {});" : "process.on('SIGTERM', () => server.close(() => process.exit(0)));"}
    server.listen(0, '127.0.0.1', () => console.log(server.address().port));
  `,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const exited = once(child, 'exit');
  const [chunk] = await once(child.stdout, 'data');
  return { child, exited, port: Number(String(chunk).trim()) };
}

const portTestSkip =
  process.platform === 'win32'
    ? false
    : spawnSync('lsof', ['-v']).error
      ? 'Install lsof to exercise the optional Web port restart helper'
      : false;

test(
  'port replacement drains its listener and leaves other ports running',
  { timeout: 30000, skip: portTestSkip },
  async () => {
    const target = await server();
    const unrelated = await server();
    try {
      await releasePort(target.port, 1000);
      const outcome = await target.exited;
      if (process.platform !== 'win32') assert.deepEqual(outcome, [0, null]);
      else assert.equal(typeof outcome[0], 'number');
      assert.equal((await fetch(`http://127.0.0.1:${unrelated.port}`)).status, 200);
      await releasePort(target.port, 1000); // already free is harmless
    } finally {
      target.child.kill('SIGKILL');
      unrelated.child.kill('SIGKILL');
      await Promise.all([target.exited, unrelated.exited]);
    }
  },
);

test(
  'an unresponsive original listener is force-stopped after the grace period',
  { timeout: 30000, skip: portTestSkip },
  async () => {
    const target = await server(true);
    try {
      await releasePort(target.port, 200);
      const outcome = await target.exited;
      if (process.platform !== 'win32') assert.deepEqual(outcome, [null, 'SIGKILL']);
      else assert.equal(typeof outcome[0], 'number');
    } finally {
      target.child.kill('SIGKILL');
      await target.exited;
    }
  },
);

test('port replacement never kills a PID reused by a different process', async () => {
  const signals = [];
  let reads = 0;
  await releasePort(3080, 0, {
    listeners: async () => (reads === 0 ? [901] : []),
    identity: async () => (++reads === 1 ? 'original' : 'replacement'),
    terminate: async (...args) => signals.push(args),
  });
  assert.deepEqual(signals, []);
  let replaced = false;
  await releasePort(3080, 0, {
    listeners: async () => (replaced ? [] : [903]),
    identity: async () => (replaced ? 'replacement' : 'original'),
    terminate: async (...args) => {
      signals.push(args);
      replaced = true;
    },
  });
  assert.deepEqual(signals, [[903, false]], 'No force termination after PID reuse');
  let exited = false;
  await releasePort(3080, 0, {
    listeners: async () => (exited ? [] : [904]),
    identity: async () => (exited ? '' : 'original'),
    terminate: async (_pid, force) => {
      if (force) {
        exited = true;
        throw new Error('taskkill: already exited');
      }
    },
  });
});

test('an intervening listener blocks startup and is never terminated', async () => {
  const signals = [];
  let replaced = false;
  await assert.rejects(
    releasePort(3080, 0, {
      listeners: async () => (replaced ? [902] : [901]),
      identity: async () => (replaced ? '' : 'original'),
      terminate: async (...args) => {
        signals.push(args);
        replaced = true;
      },
    }),
    /被新进程占用/,
  );
  assert.deepEqual(signals, [[901, false]]);
});

test('Windows port discovery uses structured data and fails closed on permission errors', async () => {
  const calls = [];
  const backend = processBackend('win32', async (program, args) => {
    calls.push([program, args]);
    if (program === 'powershell.exe') {
      const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
      assert(!args.includes('-ExecutionPolicy'));
      if (script.includes('Get-NetTCPConnection')) return { stdout: '[901,902,901]\r\n' };
      assert(script.includes('Get-Process -Id 901'));
      return { stdout: '638958123456789000\r\n' };
    }
    throw Object.assign(new Error('localized taskkill message'), { code: 1 });
  });
  assert.deepEqual(await backend.listeners(3080), [901, 902]);
  assert.equal(await backend.identity(901), '638958123456789000');
  await backend.terminate(901, false);
  await assert.rejects(backend.terminate(901, true), /进程权限/);
  assert.deepEqual(calls.slice(-2), [
    ['taskkill.exe', ['/PID', '901']],
    ['taskkill.exe', ['/PID', '901', '/F']],
  ]);
  const denied = processBackend('win32', async () => {
    throw new Error('access denied');
  });
  await assert.rejects(denied.listeners(3080), /访问权限/);
  await assert.rejects(denied.identity(901), /启动时间/);
  await assert.rejects(backend.listeners('3080; command'), /无效/);
});

test('commands preserve spaced paths and literal arguments; missing commands fail', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh command (spaces) &-'));
  try {
    const script = join(directory, 'print arguments.cjs');
    await writeFile(script, 'console.log(JSON.stringify(process.argv.slice(2)))');
    const args = ['path with spaces', 'a&b', 'literal$#', 'a"b', 'c\\trailing\\'];
    const result = await runCommand(process.execPath, [script, ...args], { cwd: directory });
    assert.deepEqual(JSON.parse(result.stdout), args);
    await assert.rejects(runCommand('dsh-missing-command-for-test', []), /ENOENT/);
    if (process.platform === 'win32') {
      const bin = join(directory, 'node_modules', '.bin');
      await mkdir(bin, { recursive: true });
      for (const shim of [join(bin, 'fixture.cmd'), join(directory, 'global-fixture.cmd')]) {
        await writeFile(shim, `@ECHO OFF\r\n"${process.execPath}" "${script}" %*\r\n`);
        const cmdResult = await runCommand(shim, args, { cwd: directory });
        assert.deepEqual(JSON.parse(cmdResult.stdout), args);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('aborting a launched command waits for its process to end', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh abort-'));
  const pidFile = join(directory, 'pid');
  const controller = new AbortController();
  const run = runCommand(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {writeFileSync} from 'node:fs'; writeFileSync(process.argv[1], ''); setTimeout(() => writeFileSync(process.argv[1], String(process.pid)), 100); setInterval(() => {}, 1000);`,
      pidFile,
    ],
    { signal: controller.signal },
  );
  const failure = assert.rejects(run, /abort|无法确认/i);
  try {
    const { readFile } = await import('node:fs/promises');
    let childPid;
    for (let i = 0; i < 100; i++) {
      try {
        const candidate = Number(await readFile(pidFile, 'utf8'));
        // The file may be visible before its PID contents have been written.
        if (Number.isSafeInteger(candidate) && candidate > 0) {
          childPid = candidate;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert(childPid);
    controller.abort();
    await failure;
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
  } finally {
    controller.abort();
    await failure;
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  'POSIX cancellation drains npm/shell descendants, including a worker ignoring SIGTERM',
  { skip: process.platform === 'win32' ? 'POSIX process-group behavior' : false, timeout: 45000 },
  async () => {
    const { readFile } = await import('node:fs/promises');
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    const unrelatedExit = once(unrelated, 'exit');
    try {
      for (const { ignoreTerm, inspection } of [
        { ignoreTerm: false },
        { ignoreTerm: true },
        { ignoreTerm: true, inspection: 'missing' },
        { ignoreTerm: true, inspection: 'timeout' },
      ]) {
        const originalPath = process.env.PATH;
        const directory = await mkdtemp(join(tmpdir(), 'dsh descendants-'));
        const controller = new AbortController();
        let pid;
        let failure;
        try {
          await writeFile(
            join(directory, 'package.json'),
            JSON.stringify({ scripts: { build: 'node worker.cjs && node -e "process.exit(0)"' } }),
          );
          await writeFile(
            join(directory, 'worker.cjs'),
            `
          const fs = require('node:fs');
          ${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''}
          fs.writeFileSync('pid', String(process.pid));
          setInterval(() => fs.writeFileSync('heartbeat', String(Date.now())), 20);
        `,
          );
          const run = runCommand(
            process.env.npm_execpath ? process.execPath : 'npm',
            [...(process.env.npm_execpath ? [process.env.npm_execpath] : []), 'run', 'build'],
            { cwd: directory, signal: controller.signal, quiet: true },
          );
          failure = assert.rejects(run, /abort|无法确认/i);
          for (let i = 0; i < 200; i++) {
            try {
              pid = Number(await readFile(join(directory, 'pid'), 'utf8'));
              break;
            } catch {
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
          }
          assert(pid, 'npm must start the descendant before cancellation');
          if (inspection) {
            if (inspection === 'timeout')
              await writeFile(
                join(directory, 'ps'),
                `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`,
                { mode: 0o755 },
              );
            process.env.PATH = directory;
          }
          controller.abort();
          await failure;
          process.env.PATH = originalPath;
          const state = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], {
            encoding: 'utf8',
          }).stdout.trim();
          assert(!state || state.startsWith('Z'), `worker still executing: ${state}`);
          const before = await readFile(join(directory, 'heartbeat'), 'utf8').catch(() => '');
          await new Promise((resolve) => setTimeout(resolve, 100));
          assert.equal(
            await readFile(join(directory, 'heartbeat'), 'utf8').catch(() => ''),
            before,
          );
          process.kill(unrelated.pid, 0);
        } finally {
          process.env.PATH = originalPath;
          controller.abort();
          await failure;
          if (pid) {
            try {
              process.kill(pid, 'SIGKILL');
            } catch (error) {
              if (error.code !== 'ESRCH') throw error;
            }
          }
          await rm(directory, { recursive: true, force: true });
        }
      }
    } finally {
      unrelated.kill('SIGKILL');
      await unrelatedExit;
    }
  },
);
