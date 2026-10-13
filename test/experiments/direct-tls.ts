/** Actual MongoDB/Oracle drivers up to TLS-protected protocol bytes; no database emulation. */
import assert from 'node:assert/strict';
import { createServer } from 'node:tls';
import type { Socket } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import { projectPath } from '../../scripts/paths.mjs';
import { connectionInput } from '../../src/schema.js';
import { command } from '../docker/process.js';

export async function directTlsMatrix(directory: string, output: string) {
  const results: unknown[] = [];
  for (const engine of ['mongodb', 'oracle'] as const) {
    for (const [certificate, host, trusted, expectedPayload] of [
      ['dns', 'localhost', true, true],
      ['ip', 'localhost', true, false],
      ['ip', '127.0.0.1', true, true],
      ['dns', '127.0.0.1', true, false],
      ['wrong', 'localhost', true, false],
      ['expired', '127.0.0.1', true, false],
      ['dns', 'localhost', false, false],
    ] as const) {
      const sockets = new Set<Socket>();
      let connections = 0;
      let payloads = 0;
      const server = createServer(
        {
          key: await readFile(`${directory}/server.key`),
          cert: await readFile(`${directory}/${certificate}.pem`),
        },
        (socket) => {
          sockets.add(socket);
          socket.on('error', () => {});
          socket.on('close', () => sockets.delete(socket));
          socket.once('data', () => {
            payloads++;
            // Stop at the first protected protocol message, before any database response.
            socket.destroy();
          });
        },
      );
      server.on('connection', (socket) => {
        connections++;
        sockets.add(socket);
        socket.on('error', () => {});
        socket.on('close', () => sockets.delete(socket));
      });
      server.on('tlsClientError', () => {});
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, host, resolve);
      });
      try {
        const result = JSON.parse(
          await command(
            process.execPath,
            ['--import', 'tsx', projectPath('test/docker/tls-worker.ts')],
            {
              input: JSON.stringify({
                config: connectionInput.parse({
                  name: 'Direct TLS fixture',
                  engine,
                  host,
                  port: (server.address() as { port: number }).port,
                  user: 'unused',
                  database: 'fixture',
                  tls: true,
                  timeoutMs: 2000,
                }),
                password: 'isolated-protocol-fixture',
                probe: true,
              }),
              env: { ...process.env, NODE_EXTRA_CA_CERTS: trusted ? `${directory}/ca.pem` : '' },
              timeoutMs: 10000,
            },
          ),
        );
        assert(connections > 0, 'The actual driver must reach the local TLS listener');
        assert.equal(
          payloads > 0,
          expectedPayload,
          `${engine} ${certificate} ${host} trusted=${trusted}`,
        );
        assert.equal(result.ok, false, 'No database response was supplied');
        results.push({ engine, certificate, host, trusted, expectedPayload, payloads, result });
        console.log(
          `Direct TLS ${engine}: ${certificate}, ${host}, trusted=${trusted}, payload=${payloads > 0}`,
        );
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  }
  await writeFile(
    `${output}/direct-tls-${process.versions.node}.json`,
    JSON.stringify(
      {
        node: process.version,
        fixture:
          'TLS identity before protocol payload; no server authentication or query compatibility claimed',
        results,
      },
      null,
      2,
    ),
  );
}
