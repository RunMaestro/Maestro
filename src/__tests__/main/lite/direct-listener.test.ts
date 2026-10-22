import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { FastifyInstance } from 'fastify';
const fixture = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('node:http', () => ({ createServer: fixture.create }));
vi.mock('node:os', () => ({
	networkInterfaces: () => ({
		Ethernet: [
			{ address: '192.168.20.10', netmask: '255.255.255.0', family: 'IPv4', internal: false },
		],
	}),
}));
import { listenLan } from '../../../main/lite/tailnet-listener';
beforeEach(() => vi.clearAllMocks());
describe('selected LAN listener', () => {
	it.each(['0.0.0.0', '::', '192.168.20.10'])(
		'reuses an existing %s listener on the direct port without stopping it',
		async (address) => {
			const close = vi.fn();
			const backend = { server: { address: () => ({ address, port: 56036 }), close } };
			const stop = await listenLan(backend as unknown as FastifyInstance, '192.168.20.10');
			expect(fixture.create).not.toHaveBeenCalled();
			await stop();
			expect(close).not.toHaveBeenCalled();
		}
	);
	it('binds only the selected interface, exposes only Lite routes, and closes accepted sockets', async () => {
		const listener = new EventEmitter() as EventEmitter & {
			listen: ReturnType<typeof vi.fn>;
			close: ReturnType<typeof vi.fn>;
		};
		listener.listen = vi.fn((_port: number, _address: string, done: () => void) => done());
		listener.close = vi.fn((done: () => void) => done());
		fixture.create.mockReturnValue(listener);
		const backend = {
			server: { address: () => ({ address: '127.0.0.1', port: 56036 }), emit: vi.fn() },
			routing: vi.fn(),
		};
		const stop = await listenLan(backend as unknown as FastifyInstance, '192.168.20.10');
		expect(listener.listen).toHaveBeenCalledWith(56036, '192.168.20.10', expect.any(Function));
		const request = fixture.create.mock.calls[0][0];
		const response = { writeHead: vi.fn().mockReturnThis(), end: vi.fn() };
		request({ url: '/normal-desktop' }, response);
		expect(response.writeHead).toHaveBeenCalledWith(404);
		expect(backend.routing).not.toHaveBeenCalled();
		const liteRequest = { url: '/.well-known/maestro/discovery' };
		request(liteRequest, response);
		expect(backend.routing).toHaveBeenCalledWith(liteRequest, response);
		const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
		listener.emit('connection', socket);
		listener.emit('upgrade', { url: '/ws' }, socket, Buffer.alloc(0));
		expect(socket.destroy).toHaveBeenCalledOnce();
		const upgrade = { url: '/.well-known/maestro/control/bridge' };
		const head = Buffer.from('head');
		listener.emit('upgrade', upgrade, socket, head);
		expect(backend.server.emit).toHaveBeenCalledWith('upgrade', upgrade, socket, head);
		await stop();
		await stop();
		expect(socket.destroy).toHaveBeenCalledTimes(2);
		expect(listener.close).toHaveBeenCalledOnce();
	});
	it.each(['0.0.0.0', '127.0.0.1', '100.64.0.10', '192.168.20.99'])(
		'refuses to bind ineligible address %s',
		async (address) => {
			await expect(listenLan({} as FastifyInstance, address)).rejects.toThrow(
				'eligible private LAN interface'
			);
			expect(fixture.create).not.toHaveBeenCalled();
		}
	);
});
