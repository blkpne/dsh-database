/** Actual Oracle driver + TLS listener; observes protected protocol bytes, never claims DB auth. */
import assert from 'node:assert/strict';
import { createServer } from 'node:tls';
import type { Socket } from 'node:net';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { temporaryDirectory, projectPath } from '../../scripts/paths.mjs';
import { command } from '../docker/process.js';
import { createTlsCertificates } from '../docker/tls-certificates.js';

if (process.argv.includes('--worker')) {
  let body = '';
  for await (const chunk of process.stdin) body += chunk;
  const input = JSON.parse(body);
  const driver = input.module
    ? (await import(pathToFileURL(input.module).href)).default
    : (await import('oracledb')).default;
  try {
    const client = await driver.getConnection({
      user: 'unused',
      password: 'isolated-protocol-fixture',
      connectString: `tcps://${input.host.includes(':') ? `[${input.host}]` : input.host}:${input.port}/fixture`,
      sslServerDNMatch: true,
      connectTimeout: 2,
      transportConnectTimeout: 2,
      retryCount: 0,
    });
    await client.close();
    console.log(
      JSON.stringify({
        node: process.version,
        driver: driver.versionString,
        unexpectedAuthenticated: true,
      }),
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        node: process.version,
        driver: driver.versionString,
        code: (error as { code?: string }).code,
      }),
    );
  }
} else {
  const root = await temporaryDirectory('oracle-runtime-');
  const directory = join(root, 'private');
  await mkdir(directory, { mode: 0o700 });
  const results: unknown[] = [];
  try {
    await createTlsCertificates(directory);
    for (const node of [
      process.execPath,
      ...(process.env.DSH_TEST_NODE_CONTROLS?.split(',') ?? []),
    ]) {
      for (const module of [
        undefined,
        ...(process.env.DSH_TEST_ORACLE_DRIVER_MODULE
          ? [process.env.DSH_TEST_ORACLE_DRIVER_MODULE]
          : []),
      ]) {
        for (const host of ['127.0.0.1', '::1']) {
          const sockets = new Set<Socket>();
          let payloads = 0;
          const server = createServer(
            {
              key: await readFile(join(directory, 'server.key')),
              cert: await readFile(join(directory, 'matching.pem')),
            },
            (socket) => {
              socket.once('data', () => {
                payloads++;
                socket.destroy();
              });
            },
          );
          server.on('connection', (socket) => {
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
                node,
                ['--import', 'tsx', projectPath('test/experiments/oracle-runtime.ts'), '--worker'],
                {
                  input: JSON.stringify({
                    module,
                    host,
                    port: (server.address() as { port: number }).port,
                  }),
                  env: { ...process.env, NODE_EXTRA_CA_CERTS: join(directory, 'ca.pem') },
                  timeoutMs: 10000,
                },
              ),
            );
            const knownBad = /v24\.(18|19)\./.test(result.node) && host === '::1';
            results.push({ host, payloads, knownBad, result });
            await writeFile(
              join(root, 'result.json'),
              JSON.stringify(
                { scope: 'TLS protocol payload only; no database authentication/query', results },
                null,
                2,
              ),
            );
            assert.equal(payloads > 0, !knownBad, JSON.stringify(result));
            if (knownBad) assert.equal(result.code, 'NJS-506');
            console.log(
              `Oracle runtime ${result.node}, driver ${result.driver}, ${host}, protected payload=${payloads > 0}`,
            );
          } finally {
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
          }
        }
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
    console.log(`Oracle runtime evidence: ${root}`);
  }
}
