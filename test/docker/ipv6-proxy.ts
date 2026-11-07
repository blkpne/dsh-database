import { createServer, connect, type Socket } from 'node:net';

/** Byte-for-byte loopback forwarding only: the client still verifies ::1, without SNI. */
export async function withIpv6Proxy<T>(port: number, action: (port: number) => Promise<T>) {
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = connect(port, '127.0.0.1');
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('error', () => {
        client.destroy();
        upstream.destroy();
      });
      socket.on('close', () => sockets.delete(socket));
    }
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '::1', resolve);
  });
  try {
    return await action((server.address() as { port: number }).port);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
