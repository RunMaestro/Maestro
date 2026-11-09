/**
 * Loopback ports for an SSH local forward: picking a free one, and waiting for
 * `ssh -L` to start listening on it.
 *
 * Two forward owners use these, the desktop's Lite tunnel
 * (`src/main/lite/tunnel.ts`) and Federation's SSH forward manager
 * (`ssh-forward.ts`). Both bind to 127.0.0.1 only: a forward to a host's bridge
 * carries a credential-bearing WebSocket, so it must never listen on a
 * reachable address.
 *
 * Plain `net`, so it stays safe for the esbuild CLI bundle.
 */

import net from 'net';

/**
 * A port on 127.0.0.1 that nothing listens on right now. `port` asks for that
 * one (rejecting with `EADDRINUSE` when it is taken); 0, the default, lets the
 * OS pick. The listener is closed before this resolves, so another process can
 * still take the port before the caller binds it; `ExitOnForwardFailure=yes`
 * is what turns that race into an ssh exit instead of a silent dead forward.
 */
export async function availableLocalPort(port = 0): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const listener = net.createServer();
	listener.once('error', reject);
	listener.listen(port, '127.0.0.1', () => {
		const address = listener.address();
		listener.close((error) => (error ? reject(error) : resolve((address as net.AddressInfo).port)));
	});
	return promise;
}

export interface WaitForLocalPortOptions {
	/** Give up after this long. */
	timeoutMs: number;
	/** Pause between probes. Default 100 ms. */
	intervalMs?: number;
	/** Checked before each probe; true ends the wait at once (the forward died, the caller gave up). */
	shouldStop?: () => boolean;
}

/** One connect attempt to 127.0.0.1:`port`. True when something accepted it. */
function probe(port: number): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const socket = net.connect({ host: '127.0.0.1', port });
	socket.setTimeout(250);
	const finish = (ready: boolean) => {
		socket.destroy();
		resolve(ready);
	};
	socket.once('connect', () => finish(true));
	socket.once('error', () => finish(false));
	socket.once('timeout', () => finish(false));
	return promise;
}

/**
 * Wait until something listens on 127.0.0.1:`port`. Resolves true once a
 * connect succeeds, false on the timeout or when `shouldStop` says so. The
 * caller tells those two apart by its own state.
 *
 * A successful probe opens one channel through the forward and closes it at
 * once; the far end sees a TCP connection that sends nothing.
 */
export async function waitForLocalPort(
	port: number,
	{ timeoutMs, intervalMs = 100, shouldStop }: WaitForLocalPortOptions
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (shouldStop?.()) return false;
		if (await probe(port)) return true;
		const delay = Promise.withResolvers<void>();
		setTimeout(delay.resolve, intervalMs);
		await delay.promise;
	}
	return false;
}
