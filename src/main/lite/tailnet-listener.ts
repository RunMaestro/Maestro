import { createServer, type IncomingMessage } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { Socket } from 'node:net';
import { TAILNET_PORT, tailnetIPv4 } from './tailnet-origin';
/** Reuses production Fastify routes on a private interface when the normal server uses another port. */
export async function listenTailnet(
	server: FastifyInstance,
	address: string
): Promise<() => Promise<void>> {
	if (!tailnetIPv4(address)) throw new Error('A current Tailscale interface is required.');
	const scoped = (req: IncomingMessage) => !!req.url && req.url.startsWith('/.well-known/maestro/');
	const listener = createServer((req, res) => {
		if (!scoped(req)) {
			res.writeHead(404).end();
			return;
		}
		server.routing(req, res);
	});
	listener.on('upgrade', (req, socket, head) => {
		if (!scoped(req)) {
			socket.destroy();
			return;
		}
		server.server.emit('upgrade', req, socket, head);
	});
	const sockets = new Set<Socket>();
	listener.on('connection', (socket) => {
		sockets.add(socket);
		socket.once('close', () => sockets.delete(socket));
	});
	await new Promise<void>((resolve, reject) => {
		listener.once('error', reject);
		listener.listen(TAILNET_PORT, address, () => {
			listener.removeListener('error', reject);
			resolve();
		});
	});
	let stopped: Promise<void> | undefined;
	return () =>
		(stopped ??= new Promise((resolve) => {
			for (const socket of sockets) socket.destroy();
			listener.close(() => resolve());
		}));
}
