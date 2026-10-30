import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import type { Socket, AddressInfo } from 'node:net';
import { QueryRunner, loadAdapter } from '../src/query.js';
import { connectionInput } from '../src/schema.js';
import { engines } from '../src/engines.js';
import type { Engine } from '../src/engines.js';

// Actual installed drivers talk only to our disposable TCP sink; this proves neither SQL
// correctness nor server compatibility. It exposes handshake cancellation/socket leaks.
for (const engine of Object.keys(engines) as Engine[])
  for (const mode of ['timeout', 'cancel']) {
    test(
      `${engine}: real driver ${mode} closes a stalled local handshake`,
      { timeout: 7000 },
      async () => {
        await loadAdapter(engine);
        const sockets = new Set<Socket>();
        let accepted = false;
        let onAccepted = () => {};
        let onSocketClosed = () => {};
        const server = createServer((socket) => {
          accepted = true;
          onAccepted();
          sockets.add(socket);
          socket.on('error', () => {});
          socket.on('close', () => {
            sockets.delete(socket);
            onSocketClosed();
          });
          socket.resume();
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const runner = new QueryRunner(
          connectionInput.parse({
            name: 'TCP test',
            engine,
            host: '127.0.0.1',
            port: (server.address() as AddressInfo).port,
            user: 'unused',
            database: 'example',
            timeoutMs: 500,
          }),
          async () => 'nonproduction-placeholder',
        );
        if (mode === 'cancel')
          onAccepted = () => {
            void runner.close();
          };
        try {
          const query =
            engine === 'mongodb'
              ? runner.mongo({ operation: 'find', collection: 'x' })
              : runner.query('SELECT 1');
          await assert.rejects(query);
          await runner.close();
          // The MongoDB driver's monitor closes asynchronously after close() resolves.
          // Observe actual socket close events with a bound, rather than an arbitrary 50ms sleep.
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error('driver socket cleanup exceeded 2s')),
              2000,
            );
            onSocketClosed = () => {
              if (!sockets.size) {
                clearTimeout(timer);
                resolve();
              }
            };
            onSocketClosed();
          });
          assert(accepted, 'test must reach the actual socket');
          assert.equal(sockets.size, 0, 'driver socket remains open after timeout');
        } finally {
          for (const socket of sockets) socket.destroy();
          await runner.close();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      },
    );
  }
