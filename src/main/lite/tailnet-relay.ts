import { createServer, request, type IncomingMessage, type IncomingHttpHeaders } from 'node:http';
import type { Socket } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { tailnetDestination } from './tailnet';
import { directTailnetOrigin } from './tailnet-origin';
import { CONNECT_PATH, ADMISSION_HEADER } from './pairing/protocol';

/** Private browser adapter: localhost remains a secure browser context, upstream binds the verified tailnet interface.
 * Never a general proxy. Only the selected paired host's application subtree and credential are accepted.
 */
export async function openTailnetRelay(
	endpoint: URL,
	credential: string,
	signal: AbortSignal,
	peerId: string
): Promise<{ url: URL; tunnel: { stop(): Promise<void> } }> {
	const origin = directTailnetOrigin(endpoint.origin);
	if (
		endpoint.pathname !== CONNECT_PATH ||
		!/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(credential)
	)
		throw new Error('Invalid paired Tailscale connection.');
	const initial = await tailnetDestination(origin, signal);
	if (initial.peerId !== peerId)
		throw new Error('The Tailscale node identity changed. Verify and pair again.');
	let bound = initial,
		checkedAt = Date.now(),
		checking: Promise<typeof initial> | undefined;
	const destination = async () => {
		if (signal.aborted) throw new Error('Connection canceled.');
		if (Date.now() - checkedAt < 2000) return bound;
		checking ??= tailnetDestination(origin, signal)
			.then((next) => {
				if (
					next.peerId !== peerId ||
					next.device !== initial.device ||
					next.tailnet !== initial.tailnet ||
					next.localAddress !== initial.localAddress
				)
					throw new Error('Tailscale network changed. Reconnect explicitly.');
				bound = next;
				checkedAt = Date.now();
				return next;
			})
			.finally(() => {
				checking = undefined;
			});
		return checking;
	};
	const sockets = new Set<Socket>();

	let stopped: Promise<void> | undefined;
	const track = (socket: Socket) => {
		sockets.add(socket);
		socket.once('close', () => sockets.delete(socket));
	};
	const accepted = (req: IncomingMessage) => {
		const auth = req.headers[ADMISSION_HEADER];
		if (
			typeof auth !== 'string' ||
			Buffer.byteLength(auth) !== Buffer.byteLength(credential) ||
			!timingSafeEqual(Buffer.from(auth), Buffer.from(credential))
		)
			return false;
		if (
			req.headers.host !== local.host ||
			(req.headers.origin && req.headers.origin !== local.origin) ||
			!req.url?.startsWith('/')
		)
			return false;
		const url = new URL(req.url, local);
		return (
			url.origin === local.origin &&
			(url.pathname === CONNECT_PATH || url.pathname.startsWith(CONNECT_PATH + '/'))
		);
	};
	const headers = (req: IncomingMessage, websocket = false) => {
		const result: IncomingHttpHeaders = { ...req.headers, host: endpoint.host };
		for (const key of Object.keys(result))
			if (
				key.startsWith('x-forwarded-') ||
				[
					'forwarded',
					'proxy-authorization',
					'proxy-connection',
					'cookie',
					'authorization',
				].includes(key)
			)
				delete result[key];
		if (result.origin) result.origin = origin;
		if (!websocket) delete result.connection;
		return result;
	};
	const server = createServer(async (req, res) => {
		if (!accepted(req)) {
			res.writeHead(403).end();
			return;
		}
		try {
			const binding = await destination();
			if (signal.aborted || req.destroyed) {
				res.destroy();
				return;
			}
			const upstream = request(
				origin + req.url,
				{ ...binding, agent: false, method: req.method, headers: headers(req), signal },
				(response) => {
					const output = { ...response.headers };
					delete output['set-cookie'];
					if (output.location) {
						const target = new URL(output.location, origin);
						if (
							target.origin !== origin ||
							!(target.pathname === CONNECT_PATH || target.pathname.startsWith(CONNECT_PATH + '/'))
						) {
							response.destroy();
							res.writeHead(502).end();
							return;
						}
						output.location = local.origin + target.pathname + target.search + target.hash;
					}
					res.writeHead(response.statusCode ?? 502, output);
					response.on('error', () => res.destroy());
					response.pipe(res);
				}
			);
			upstream.on('socket', track);
			upstream.on('error', () => {
				if (!res.headersSent) res.writeHead(502);
				res.end();
			});
			req.on('aborted', () => upstream.destroy());
			req.pipe(upstream);
		} catch {
			res.writeHead(502).end();
		}
	});
	server.on('connection', track);
	server.on('upgrade', async (req, socket, head) => {
		if (!accepted(req) || new URL(req.url!, local).pathname !== CONNECT_PATH + '/ws') {
			socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
			return;
		}
		try {
			const binding = await destination();
			if (signal.aborted || socket.destroyed) {
				socket.destroy();
				return;
			}
			const upstream = request(origin + req.url, {
				...binding,
				agent: false,
				headers: headers(req, true),
				signal,
			});
			upstream.on('socket', track);
			upstream.on('upgrade', (response, remote, remoteHead) => {
				track(remote);
				socket.write(
					'HTTP/1.1 101 Switching Protocols\r\n' +
						response.rawHeaders.reduce(
							(s, _v, i, a) => (i % 2 ? s : s + a[i] + ': ' + a[i + 1] + '\r\n'),
							''
						) +
						'\r\n'
				);
				if (remoteHead.length) socket.write(remoteHead);
				if (head.length) remote.write(head);
				remote.on('error', () => socket.destroy());
				socket.on('error', () => remote.destroy());
				remote.on('close', () => socket.destroy());
				socket.on('close', () => remote.destroy());
				socket.pipe(remote).pipe(socket);
			});
			upstream.on('response', (response) => {
				socket.end(
					'HTTP/1.1 ' + (response.statusCode ?? 502) + ' Rejected\r\nConnection: close\r\n\r\n'
				);
				response.destroy();
			});
			upstream.on('error', () => socket.destroy());
			upstream.end();
		} catch {
			socket.destroy();
		}
	});
	const stop = (): Promise<void> =>
		(stopped ??= new Promise((resolve) => {
			signal.removeEventListener('abort', onAbort);
			for (const socket of sockets) socket.destroy();
			server.close(() => resolve());
		}));
	const onAbort = () => {
		void stop();
	};
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			server.removeListener('error', reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === 'string') {
		await stop();
		throw new Error('Private browser transport unavailable.');
	}
	const local = new URL('http://127.0.0.1:' + address.port + CONNECT_PATH);
	signal.addEventListener('abort', onAbort, { once: true });
	if (signal.aborted) {
		await stop();
		throw new Error('Connection canceled.');
	}
	return { url: local, tunnel: { stop } };
}
