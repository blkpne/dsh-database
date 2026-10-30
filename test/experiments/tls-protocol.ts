/** Real Node TLS + mysql2 handshake against a small MySQL protocol fixture, not a DB engine. */
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { TLSSocket, createSecureContext } from 'node:tls';
import { readFile, writeFile } from 'node:fs/promises';
import { projectPath } from '../../scripts/paths.mjs';
import { randomBytes } from 'node:crypto';
import { build } from 'esbuild';
import { command } from '../docker/process.js';
import { connectionInput } from '../../src/schema.js';
import { handshakeTransport } from './tls-transport.js';
import { afterPlaintextFrame } from './tls-upgrade.js';

export async function protocolMatrix(directory: string, output: string) {
  const source = await readFile(projectPath('src/adapters/mysql.ts'), 'utf8');
  const results: unknown[] = [];
  const variants = [
    ['full', source],
    ['without-identity', source.replace('verifyIdentity: true', 'verifyIdentity: false')],
    ['without-ip-context', source.replace('config.tls && isIP(host)', 'false')],
  ];
  for (const [variant, contents] of variants) {
    const adapter = `${directory}/${variant}.mjs`;
    await build({
      stdin: { contents: contents!, loader: 'ts', resolveDir: projectPath('src/adapters') },
      bundle: true,
      packages: 'external',
      platform: 'node',
      format: 'esm',
      outfile: adapter,
    });
    const cases =
      variant === 'full'
        ? ([
            ['matching', '127.0.0.1', true, true, 'coalesced'],
            ['dns', '127.0.0.1', true, false, 'coalesced'],
            ['matching', '127.0.0.1', true, true, 'fragmented'],
            ['matching', '127.0.0.1', true, true],
            ['matching', 'localhost', true, true],
            ['matching', '::1', true, true],
            ['ip', '127.0.0.1', true, true],
            ['dns', 'localhost', true, true],
            ['dns', '127.0.0.1', true, false],
            ['wrong', '127.0.0.1', true, false],
            ['wrong', 'localhost', true, false],
            ['expired', '127.0.0.1', true, false],
            ['matching', '127.0.0.1', false, false],
          ] as const)
        : variant === 'without-identity'
          ? ([['wrong', '127.0.0.1', true, true]] as const)
          : ([
              ['ip', '127.0.0.1', true, false],
              ['dns', '127.0.0.1', true, true],
            ] as const);
    for (const [certificate, host, trusted, expected, transport] of cases) {
      const context = createSecureContext({
        key: await readFile(`${directory}/server.key`),
        cert: await readFile(`${directory}/${certificate}.pem`),
      });
      const sockets = new Set<Socket>();
      let authentications = 0;
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => {});
        const send = (stream: Socket, data: Buffer, sequence: number) => {
          const header = Buffer.alloc(4);
          header.writeUIntLE(data.length, 0, 3);
          header[3] = sequence;
          stream.write(Buffer.concat([header, data]));
        };
        const word = (n: number, bytes: number) => {
          const b = Buffer.alloc(bytes);
          b.writeUIntLE(n, 0, bytes);
          return b;
        };
        const flags = 0x0008aa0d;
        send(
          socket,
          Buffer.concat([
            Buffer.from([10]),
            Buffer.from('8.4.fixture\0'),
            word(1, 4),
            Buffer.from('12345678\0'),
            word(flags & 65535, 2),
            Buffer.from([45]),
            word(2, 2),
            word(flags >>> 16, 2),
            Buffer.from([21]),
            Buffer.alloc(10),
            Buffer.from('abcdefghijkl\0mysql_native_password\0'),
          ]),
          0,
        );
        afterPlaintextFrame(socket, 36, () => {
          const secure = new TLSSocket(socket, { isServer: true, secureContext: context });
          sockets.add(secure);
          secure.on('close', () => sockets.delete(secure));
          secure.on('error', () => {});
          let buffer = Buffer.alloc(0),
            authenticated = false;
          secure.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            while (buffer.length >= 4 && buffer.length >= buffer.readUIntLE(0, 3) + 4) {
              const size = buffer.readUIntLE(0, 3),
                seq = buffer[3]!,
                data = buffer.subarray(4, size + 4);
              buffer = buffer.subarray(size + 4);
              const ok = Buffer.from([0, 0, 0, 2, 0, 0, 0]);
              if (!authenticated) {
                authentications++;
                authenticated = true;
                send(secure, ok, seq + 1);
                continue;
              }
              if (data[0] === 3 && data.subarray(1).toString().startsWith('SELECT')) {
                const str = (s: string) =>
                  Buffer.concat([Buffer.from([Buffer.byteLength(s)]), Buffer.from(s)]);
                const eof = Buffer.from([254, 0, 0, 2, 0]);
                send(secure, Buffer.from([1]), 1);
                send(
                  secure,
                  Buffer.concat([
                    str('def'),
                    str(''),
                    str(''),
                    str(''),
                    str('ok'),
                    str(''),
                    Buffer.from([12]),
                    word(45, 2),
                    word(11, 4),
                    Buffer.from([3]),
                    word(0, 2),
                    Buffer.alloc(3),
                  ]),
                  2,
                );
                send(secure, eof, 3);
                send(secure, str('1'), 4);
                send(secure, eof, 5);
              } else send(secure, ok, 1);
            }
          });
        });
      });
      await new Promise<void>((resolve) =>
        server.listen(0, host === '::1' ? '::1' : '127.0.0.1', resolve),
      );
      const port = (server.address() as { port: number }).port;
      const proxy = transport ? await handshakeTransport(port, transport) : undefined;
      try {
        const result = JSON.parse(
          await command(
            process.execPath,
            ['--import', 'tsx', projectPath('test/docker/tls-worker.ts')],
            {
              input: JSON.stringify({
                config: connectionInput.parse({
                  name: 'TLS fixture',
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
          expected,
          transport,
          writes: proxy?.writes,
          result,
          authentications,
        };
        results.push(row);
        console.log(JSON.stringify(row));
        await writeFile(
          `${output}/tls-protocol-${process.versions.node}.json`,
          JSON.stringify(
            {
              node: process.version,
              fixture: 'TLS + MySQL wire protocol; not a database engine',
              results,
            },
            null,
            2,
          ),
        );
        assert.equal(result.ok, expected);
        if (!expected) {
          assert.match(
            result.code,
            /^(HANDSHAKE_SSL_ERROR|ERR_TLS_CERT_ALTNAME_INVALID|CERT_HAS_EXPIRED|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|DEPTH_ZERO_SELF_SIGNED_CERT)$/,
            'Failure must come from TLS validation, not a timeout or connectivity error',
          );
          assert.equal(
            authentications,
            0,
            'Identity rejection must precede credential transmission',
          );
        } else assert.deepEqual(result.rows, [[1]]);
      } finally {
        await proxy?.close();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  }
}
