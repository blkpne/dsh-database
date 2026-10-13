/** Exercise the actual pg adapter up to password authentication, without a PostgreSQL engine. */
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { createSecureContext, TLSSocket } from 'node:tls';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { projectPath } from '../../scripts/paths.mjs';
import { build } from 'esbuild';
import { connectionInput } from '../../src/schema.js';
import { afterPlaintextFrame } from './tls-upgrade.js';
import { handshakeTransport } from './tls-transport.js';
import { command } from '../docker/process.js';

export async function pgProtocolMatrix(directory: string, output: string) {
  const source = await readFile(projectPath('src/adapters/postgresql.ts'), 'utf8');
  const needle = 'checkServerIdentity(identity, cert)';
  assert.equal(source.split(needle).length, 2);
  const results: unknown[] = [];
  for (const variant of ['full', 'without-bound-identity']) {
    const adapter = `${directory}/pg-${variant}.mjs`;
    await build({
      stdin: {
        contents:
          variant === 'full' ? source : source.replace(needle, 'checkServerIdentity(_host, cert)'),
        loader: 'ts',
        resolveDir: projectPath('src/adapters'),
      },
      bundle: true,
      packages: 'external',
      platform: 'node',
      format: 'esm',
      outfile: adapter,
    });
    const cases =
      variant === 'full'
        ? ([
            ['matching', '127.0.0.1', true, true, 'fragmented'],
            ['dns', '127.0.0.1', true, false, 'fragmented'],
            ['matching', '127.0.0.1', true, true],
            ['matching', 'localhost', true, true],
            ['matching', '::1', true, true],
            ['ip', '127.0.0.1', true, true],
            ['dns', 'localhost', true, true],
            ['dns', '127.0.0.1', true, false],
            ['wrong', 'localhost', true, false],
            ['expired', '127.0.0.1', true, false],
            ['matching', '127.0.0.1', false, false],
          ] as const)
        : ([
            ['ip', '127.0.0.1', true, false],
            ['dns', '127.0.0.1', true, true],
          ] as const);
    for (const [certificate, host, trusted, expectedAuthentication, transport] of cases) {
      const secureContext = createSecureContext({
        key: await readFile(`${directory}/server.key`),
        cert: await readFile(`${directory}/${certificate}.pem`),
      });
      const sockets = new Set<Socket>();
      let authentications = 0;
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => {});
        afterPlaintextFrame(socket, 8, () => {
          socket.write('S');
          const secure = new TLSSocket(socket, { isServer: true, secureContext });
          sockets.add(secure);
          secure.on('close', () => sockets.delete(secure));
          secure.on('error', () => {});
          const send = (kind: string, payload: Buffer) => {
            const header = Buffer.alloc(5);
            header[0] = kind.charCodeAt(0);
            header.writeInt32BE(payload.length + 4, 1);
            secure.write(Buffer.concat([header, payload]));
          };
          let buffer = Buffer.alloc(0),
            startup = true;
          secure.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            if (startup) {
              if (buffer.length < 4 || buffer.length < buffer.readInt32BE(0)) return;
              buffer = buffer.subarray(buffer.readInt32BE(0));
              startup = false;
              send('R', Buffer.from([0, 0, 0, 3])); // Password challenge, sent only inside TLS.
            }
            if (buffer.length < 5 || buffer.length < 1 + buffer.readInt32BE(1)) return;
            if (buffer[0] !== 'p'.charCodeAt(0)) {
              secure.destroy();
              return;
            }
            authentications++;
            buffer = Buffer.alloc(0);
            // Stop before any SQL. This fixture validates identity-before-credentials only.
            send('E', Buffer.from('SFATAL\0VFATAL\0C28P01\0Mfixture authentication boundary\0\0'));
          });
        });
      });
      await new Promise<void>((resolve) =>
        server.listen(0, host === '::1' ? '::1' : '127.0.0.1', resolve),
      );
      const port = (server.address() as { port: number }).port;
      const proxy = transport ? await handshakeTransport(port, transport, 'postgresql') : undefined;
      try {
        const result = JSON.parse(
          await command(
            process.execPath,
            ['--import', 'tsx', projectPath('test/docker/tls-worker.ts')],
            {
              input: JSON.stringify({
                config: connectionInput.parse({
                  name: 'TLS fixture',
                  engine: 'postgresql',
                  database: 'fixture',
                  host,
                  port: proxy?.port ?? port,
                  user: 'fixture',
                  tls: true,
                  timeoutMs: 4000,
                }),
                password: randomBytes(16).toString('hex'),
                adapter,
              }),
              env: { ...process.env, NODE_EXTRA_CA_CERTS: trusted ? `${directory}/ca.pem` : '' },
              timeoutMs: 10000,
            },
          ),
        );
        const row = {
          variant,
          certificate,
          host,
          trusted,
          expectedAuthentication,
          transport,
          writes: proxy?.writes,
          authentications,
          result,
        };
        results.push(row);
        console.log(JSON.stringify({ engine: 'postgresql-protocol', ...row }));
        await writeFile(
          `${output}/pg-tls-protocol-${process.versions.node}.json`,
          JSON.stringify(
            {
              node: process.version,
              fixture: 'PostgreSQL SSLRequest + TLS + password challenge; no SQL execution',
              results,
            },
            null,
            2,
          ),
        );
        assert.equal(authentications, expectedAuthentication ? 1 : 0);
        if (expectedAuthentication) assert.equal(result.code, '28P01');
        else
          assert.match(
            result.code,
            /^(ERR_TLS_CERT_ALTNAME_INVALID|CERT_HAS_EXPIRED|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|DEPTH_ZERO_SELF_SIGNED_CERT)$/,
            'Failure must come from TLS validation, not a timeout or connectivity error',
          );
      } finally {
        await proxy?.close();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  }
}
