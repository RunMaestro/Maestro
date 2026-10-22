import { createServer, createConnection } from 'net';
import type { Socket } from 'net';
import { randomBytes, timingSafeEqual } from 'crypto';
import { mkdir, readFile, writeFile, rename, unlink, chmod } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
	LITE_CONTROL_DISCOVERY_FILE,
	LITE_CONTROL_PROTOCOL_VERSION,
	LITE_CONTROL_MAX_BYTES,
	isLiteControlEndpoint,
} from '../../shared/lite-control';
import type {
	LiteControlDiscovery,
	LiteControlOptions,
	LiteControlReply,
	LiteControlRequest,
} from '../../shared/lite-control';

/** OS-local IPC only: host web content cannot reach a named pipe or Unix socket. */
export async function startLiteControlServer(
	directory: string,
	control: (name: string, payload?: unknown, options?: LiteControlOptions) => Promise<unknown>
): Promise<{ close(): Promise<void> }> {
	const file = path.join(directory, LITE_CONTROL_DISCOVERY_FILE);
	await mkdir(directory, { recursive: true });
	try {
		const existing = JSON.parse(await readFile(file, 'utf8')) as LiteControlDiscovery;
		if (isLiteControlEndpoint(existing?.endpoint)) {
			// PID reuse is not ownership: only the discovered OS-local endpoint is authoritative.
			const ownership = Promise.withResolvers<boolean>();
			const probe = createConnection(existing.endpoint);
			probe.once('connect', () => {
				probe.destroy();
				ownership.resolve(true);
			});
			probe.once('error', (error: NodeJS.ErrnoException) => {
				probe.destroy();
				if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') ownership.resolve(false);
				else ownership.reject(error);
			});
			probe.setTimeout(2000, () => {
				probe.destroy();
				ownership.reject(
					new Error('Cannot determine Lite control endpoint ownership: local probe timed out.')
				);
			});
			if (await ownership.promise)
				throw new Error('A Lite control endpoint already owns this user-data directory.');
		}
	} catch (error) {
		if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') {
			// Missing or interrupted discovery is replaced after listening succeeds.
		} else throw error;
	}
	const secret = randomBytes(32).toString('hex');
	const suffix = randomBytes(16).toString('hex');
	const endpoint =
		process.platform === 'win32'
			? `\\\\.\\pipe\\maestro-lite-${suffix}`
			: path.join(os.tmpdir(), `maestro-lite-${suffix}.sock`);
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
		socket.on('error', () => socket.destroy());
		socket.setTimeout(120_000, () => socket.destroy());
		let input = '';
		let bytes = 0;
		let handled = false;
		socket.setEncoding('utf8');
		socket.on('data', (chunk: string) => {
			if (handled) return;
			bytes += Buffer.byteLength(chunk);
			if (bytes > LITE_CONTROL_MAX_BYTES) {
				handled = true;
				socket.end(
					JSON.stringify({ success: false, error: 'Lite control request is too large.' }) + '\n'
				);
				return;
			}
			input += chunk;
			if (!input.includes('\n')) return;
			handled = true;
			void (async () => {
				let afterResponse: (() => void) | undefined;
				let reply: LiteControlReply;
				let authenticated = false;
				try {
					const request = JSON.parse(input) as LiteControlRequest;
					if (
						!request ||
						typeof request.secret !== 'string' ||
						request.secret.length !== secret.length ||
						!timingSafeEqual(Buffer.from(request.secret), Buffer.from(secret))
					) {
						throw new Error('Lite control authentication failed.');
					}
					authenticated = true;
					if (request.protocolVersion !== LITE_CONTROL_PROTOCOL_VERSION)
						throw new Error(
							'Unsupported Lite control protocol. Rebuild/restart Lite and maestro-cli together.'
						);
					if (typeof request.action !== 'string')
						throw new Error('Lite control action is required.');
					const result = await control(request.action, request.payload, {
						source: 'cli',
						confirmed: request.confirmed === true,
						afterResponse: (callback) => {
							afterResponse = callback;
						},
					});
					reply = { ...(result as Omit<LiteControlReply, 'success'>), success: true };
				} catch (error) {
					reply = { success: false, error: error instanceof Error ? error.message : String(error) };
					if (authenticated) {
						try {
							Object.assign(reply, await control('status'));
						} catch {
							/* The window may already be closing. */
						}
					}
				}
				socket.end(JSON.stringify(reply) + '\n', () => afterResponse?.());
			})();
		});
	});
	const listening = Promise.withResolvers<void>();
	server.once('error', listening.reject);
	server.listen(endpoint, () => {
		server.removeListener('error', listening.reject);
		listening.resolve();
	});
	await listening.promise;
	let closed: Promise<void> | undefined;
	const close = (): Promise<void> =>
		(closed ??= (async () => {
			for (const socket of sockets) socket.destroy();
			const stopped = Promise.withResolvers<void>();
			server.close((error) => (error ? stopped.reject(error) : stopped.resolve()));
			await stopped.promise;
			try {
				const current = JSON.parse(await readFile(file, 'utf8')) as LiteControlDiscovery;
				if (current.secret === secret) await unlink(file);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			}
		})());
	try {
		if (process.platform !== 'win32') await chmod(endpoint, 0o600);
		const discovery: LiteControlDiscovery = {
			protocolVersion: LITE_CONTROL_PROTOCOL_VERSION,
			endpoint,
			secret,
			pid: process.pid,
		};
		await writeFile(file + '.tmp', JSON.stringify(discovery, null, 2), { mode: 0o600 });
		await rename(file + '.tmp', file);
	} catch (error) {
		await close();
		throw error;
	}
	return { close };
}
