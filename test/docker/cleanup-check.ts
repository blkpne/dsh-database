import { fork } from 'node:child_process';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { Engine } from '../../src/engines.js';
import { docker } from './process.js';

export async function verifyCleanup(engine: Engine, signal: AbortSignal): Promise<void> {
  for (const terminate of ['SIGTERM', 'SIGKILL'] as const) {
    signal.throwIfAborted();
    const worker = fork(new URL('./cleanup-worker.ts', import.meta.url), [engine], {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    const abort = () => worker.kill('SIGTERM');
    signal.addEventListener('abort', abort, { once: true });
    const exited = new Promise<void>((resolve) => worker.once('close', () => resolve()));
    try {
      const name = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Cleanup verification worker timed out')),
          30000,
        );
        worker.once('message', (message: { name: string }) => {
          clearTimeout(timer);
          resolve(message.name);
        });
        worker.once('exit', () => {
          clearTimeout(timer);
          reject(new Error('Cleanup verification worker exited early'));
        });
        worker.once('error', () => {
          clearTimeout(timer);
          reject(new Error('Cleanup verification worker failed'));
        });
      });
      const mounts = JSON.parse(
        await docker(['inspect', '--format', '{{json .Mounts}}', name], { signal }),
      );
      worker.kill(terminate);
      await exited;
      let remaining = 'pending';
      for (let attempt = 0; attempt < 40; attempt++) {
        remaining = await docker(['ps', '-aq', '--filter', `name=^/${name}$`], { signal });
        if (!remaining) break;
        await delay(500, undefined, { signal });
      }
      assert.equal(remaining, '', `${terminate} left a test container`);
      for (const mount of mounts.filter((entry: { Type: string }) => entry.Type === 'volume'))
        assert.equal(
          await docker(['volume', 'ls', '-q', '--filter', `name=^${mount.Name}$`], { signal }),
          '',
        );
      console.log(`[cleanup] PASS ${terminate}: container and anonymous volumes removed`);
    } finally {
      signal.removeEventListener('abort', abort);
      if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
      await exited;
    }
  }
}
