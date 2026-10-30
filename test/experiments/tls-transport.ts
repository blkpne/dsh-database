import { createServer, connect, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

/** Force TCP segmentation at the plaintext/TLS boundary, without changing protocol bytes. */
export async function handshakeTransport(
  port: number,
  mode: 'coalesced' | 'fragmented',
  protocol: 'mysql' | 'postgresql' = 'mysql',
) {
  const sockets = new Set<Socket>();
  const writes: number[] = [];
  const server = createServer((client) => {
    const upstream = connect({ host: '127.0.0.1', port });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('error', () => {
        client.destroy();
        upstream.destroy();
      });
      socket.on('close', () => {
        sockets.delete(socket);
        client.destroy();
        upstream.destroy();
      });
    }
    upstream.pipe(client);
    let buffered = Buffer.alloc(0);
    const collect = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 4) return;
      const requestSize = protocol === 'postgresql' ? 8 : 4 + buffered.readUIntLE(0, 3);
      if (buffered.length < requestSize) return;
      if (
        mode === 'coalesced' &&
        (buffered.length < requestSize + 5 ||
          buffered.length < requestSize + 5 + buffered.readUInt16BE(requestSize + 3))
      )
        return;
      client.pause();
      client.off('data', collect);
      void (async () => {
        if (mode === 'fragmented') {
          writes.push(2);
          upstream.write(buffered.subarray(0, 2));
          await delay(50);
          buffered = buffered.subarray(2);
        }
        writes.push(buffered.length);
        upstream.write(buffered);
        client.pipe(upstream);
        client.resume();
      })();
    };
    client.on('data', collect);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: (server.address() as { port: number }).port,
    writes,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
