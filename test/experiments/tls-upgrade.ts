import type { Socket } from 'node:net';

/** TCP chunks are not protocol frames. Keep any already-received TLS bytes for TLSSocket. */
export function afterPlaintextFrame(socket: Socket, size: number, upgrade: () => void) {
  let buffered = Buffer.alloc(0);
  const receive = (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.length < size) return;
    socket.pause();
    socket.off('data', receive);
    if (buffered.length > size) socket.unshift(buffered.subarray(size));
    upgrade();
    // TLSSocket takes over reads on the next tick. Resuming the old socket here would
    // discard the unshifted ClientHello before TLS has consumed its readable buffer.
  };
  socket.on('data', receive);
}
