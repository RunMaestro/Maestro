/**
 * Choosing and checking a TCP port for a server Maestro runs on this machine.
 *
 * Maestro's local servers (the token proxy, the model server) keep their port
 * across launches: something the user configured names it, so a port that moved
 * would leave that pointing at nothing, or at whatever took the old one. The
 * port is chosen once by asking the OS for a free one (`pickFreePort`) and then
 * persisted by the caller. At each start the caller can check it first
 * (`probePort`), so a port another program holds fails by name before anything
 * is spawned or bound.
 */

import * as net from 'net';

/** True for an integer that can name a TCP port. Port 0 ("any port") is not one. */
export function isTcpPort(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65536;
}

/** Ask the OS for a port nothing is listening on at `host`. */
export function pickFreePort(host: string): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		const probe = net.createServer();
		probe.once('error', reject);
		probe.listen(0, host, () => {
			const address = probe.address();
			const port = address && typeof address === 'object' ? address.port : 0;
			probe.close(() => (isTcpPort(port) ? resolve(port) : reject(new Error('no port assigned'))));
		});
	});
}

export type PortProbe =
	| { free: true }
	| {
			free: false;
			/** The bind error's code, for example `EADDRINUSE` or `EACCES`; null when it had none. */
			code: string | null;
			message: string;
	  };

/**
 * Whether `port` can be bound at `host` right now. The probe releases the port
 * before it resolves, so the answer can go stale and the caller still has to
 * handle its own bind failing. What the probe buys is the reason, by name,
 * before a process is started that would only exit with it in a log.
 */
export function probePort(port: number, host: string): Promise<PortProbe> {
	return new Promise<PortProbe>((resolve) => {
		const probe = net.createServer();
		probe.once('error', (error: NodeJS.ErrnoException) => {
			resolve({ free: false, code: error.code ?? null, message: error.message });
		});
		probe.listen(port, host, () => {
			probe.close(() => resolve({ free: true }));
		});
	});
}
