import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import * as syncFs from 'fs';
import * as net from 'net';
import path from 'path';
import { logger } from '../../../main/utils/logger';

vi.mock('fs/promises', () => ({ default: { realpath: vi.fn() } }));
vi.mock('fs', () => ({ unlinkSync: vi.fn(), chmodSync: vi.fn() }));
vi.mock('net', () => ({ createServer: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

describe('permission relay server request and native lifetime activity', () => {
	const target = path.resolve('relay-server-target');
	let gate: typeof import('../../../main/git/worktreeActivity');
	let server: import('../../../main/permission-relay/PermissionRelayServer').PermissionRelayServer;
	let endpoint: EventEmitter & {
		listen: ReturnType<typeof vi.fn>;
		close: ReturnType<typeof vi.fn>;
	};
	let listening: () => void;
	let accept: (socket: net.Socket) => void;
	let sockets: EventEmitter[];
	let releases: Array<() => void>;
	let active: number;
	async function reserve(root = target) {
		const hold = await gate.reserveWorktreeCleanup(root);
		if (hold.status === 'reserved-partially') releases.push(hold.release);
		return hold;
	}
	async function idle(root = target) {
		const hold = await reserve(root);
		expect(hold.status).toBe('reserved-partially');
		if (hold.status !== 'reserved-partially') throw new Error('Expected partial reservation');
		expect(hold.blockers.map((b) => b.message).join(' ')).toMatch(/native.*registration.*OS/);
		return hold;
	}
	const busy = async () =>
		expect(await reserve()).toMatchObject({
			status: 'blocked',
			blockers: [{ code: 'mutation-busy' }],
		});
	async function start() {
		const request = server.ensureStarted(target);
		listening();
		return request;
	}
	function connect(configure?: (socket: net.Socket) => void) {
		const socket = Object.assign(new EventEmitter(), {
			setEncoding: vi.fn(),
			write: vi.fn(),
		});
		sockets.push(socket);
		configure?.(socket as unknown as net.Socket);
		accept(socket as unknown as net.Socket);
		return socket;
	}
	beforeEach(async () => {
		vi.resetModules();
		vi.clearAllMocks();
		releases = [];
		active = 0;
		sockets = [];
		vi.mocked(fs.realpath).mockImplementation(async (p) => String(p));
		vi.spyOn(process, 'umask').mockReturnValue(0o022);
		endpoint = Object.assign(new EventEmitter(), { listen: vi.fn(), close: vi.fn() });
		endpoint.listen.mockImplementation((_socketPath: string, callback: () => void) => {
			listening = callback;
			return endpoint;
		});
		vi.mocked(net.createServer).mockImplementation((...args: unknown[]) => {
			accept = args[0] as (socket: net.Socket) => void;
			return endpoint as unknown as net.Server;
		});
		gate = await import('../../../main/git/worktreeActivity');
		const admit = gate.beginGlobalWorktreeActivity;
		vi.spyOn(gate, 'beginGlobalWorktreeActivity').mockImplementation(() => {
			const release = admit();
			active++;
			return () => {
				active--;
				release();
			};
		});
		const { PermissionRelayServer } =
			await import('../../../main/permission-relay/PermissionRelayServer');
		server = new PermissionRelayServer();
	});
	afterEach(() => {
		for (const release of releases) release();
		for (const socket of sockets) socket.emit('close');
		server.stop();
		endpoint.emit('close');
		expect(active).toBe(0);
		vi.restoreAllMocks();
	});

	it.each([target, path.join(target, 'child'), path.resolve('unrelated-repository')])(
		'refuses start before native, filesystem or platform setup under %s',
		async (root) => {
			const hold = await idle(root);
			await expect(server.ensureStarted(target)).rejects.toThrow(/reserved/);
			expect(net.createServer).not.toHaveBeenCalled();
			expect(syncFs.unlinkSync).not.toHaveBeenCalled();
			expect(process.umask).not.toHaveBeenCalled();
			expect(server.isRunning()).toBe(false);
			hold.release();
			expect(await start()).toBe(endpoint.listen.mock.calls[0][0]);
		}
	);

	it('holds every concurrent start through shared listening, permissions and reporting', async () => {
		const first = server.ensureStarted(target);
		const second = server.ensureStarted(path.resolve('other-user-data'));
		expect(active).toBe(3);
		await busy();
		expect(net.createServer).toHaveBeenCalledOnce();
		expect(endpoint.listen).toHaveBeenCalledOnce();
		vi.mocked(syncFs.chmodSync).mockImplementationOnce(() => expect(active).toBe(3));
		vi.mocked(logger.info).mockImplementationOnce(() => expect(active).toBe(3));
		listening();
		expect(await first).toBe(await second);
		expect(server.isRunning()).toBe(true);
		expect(active).toBe(1);
		await busy();
	});

	it('refuses a cached start after unexpected native closure before reading state', async () => {
		const expected = await start();
		endpoint.emit('close');
		const hold = await idle();
		await expect(server.ensureStarted(target)).rejects.toThrow(/reserved/);
		expect(net.createServer).toHaveBeenCalledOnce();
		hold.release();
		expect(await server.ensureStarted(target)).toBe(expected);
		await idle();
	});

	it.each(['create', 'listen', 'error event', 'report'])(
		'preserves failed %s setup and holds created native state until observed close',
		async (stage) => {
			const error = new Error(stage);
			const fail = () => {
				expect(active).toBeGreaterThan(0);
				throw error;
			};
			if (stage === 'create') vi.mocked(net.createServer).mockImplementationOnce(fail);
			if (stage === 'listen') endpoint.listen.mockImplementationOnce(fail);
			if (stage === 'report') vi.mocked(logger.info).mockImplementationOnce(fail);
			const first = server.ensureStarted(target);
			const second = server.ensureStarted(target);
			const results = Promise.allSettled([first, second]);
			if (stage === 'error event' || stage === 'report') await busy();
			if (stage === 'error event') endpoint.emit('error', error);
			if (stage === 'report') listening();
			for (const result of await results)
				expect(result).toEqual({ status: 'rejected', reason: error });
			if (stage !== 'create') {
				expect(active).toBe(1);
				await busy();
				endpoint.emit('close');
			}
			expect(active).toBe(0);
			const hold = await idle();
			hold.release();
			if (stage === 'report') server.stop();
			await start();
		}
	);

	it('holds reentrant stop and restart reporting within the original start request', async () => {
		vi.mocked(logger.info).mockImplementationOnce(() => {
			expect(active).toBe(2);
			endpoint.close.mockImplementationOnce(() => expect(active).toBe(3));
			server.stop();
			expect(active).toBe(2);
		});
		await start();
		expect(server.isRunning()).toBe(false);
		await busy();
		endpoint.emit('close');
		await start();
		await busy();
	});

	it.each([target, path.join(target, 'child'), path.resolve('unrelated-repository')])(
		'refuses callback replacement and stop under %s without touching cached state',
		async (root) => {
			const callback = vi.fn();
			server.setOnRequest(callback);
			await start();
			endpoint.emit('close');
			const unlinks = vi.mocked(syncFs.unlinkSync).mock.calls.length;
			const hold = await idle(root);
			expect(() => server.setOnRequest(vi.fn())).toThrow(/reserved/);
			expect(() => server.stop()).toThrow(/reserved/);
			expect(Reflect.get(server, 'onRequest')).toBe(callback);
			expect(server.isRunning()).toBe(true);
			expect(endpoint.close).not.toHaveBeenCalled();
			expect(syncFs.unlinkSync).toHaveBeenCalledTimes(unlinks);
			hold.release();
			const replacement = vi.fn();
			expect(server.setOnRequest(replacement)).toBeUndefined();
			expect(Reflect.get(server, 'onRequest')).toBe(replacement);
			expect(server.stop()).toBeUndefined();
			expect(server.isRunning()).toBe(false);
			await idle();
		}
	);

	it('holds close request, unlink and nested callback configuration synchronously', async () => {
		await start();
		endpoint.close.mockImplementationOnce(() => {
			expect(active).toBe(2);
			server.setOnRequest(vi.fn());
			expect(active).toBe(2);
		});
		vi.mocked(syncFs.unlinkSync).mockImplementationOnce(() => expect(active).toBe(2));
		server.stop();
		expect(active).toBe(1);
		await busy();
		endpoint.emit('close');
		expect(active).toBe(0);
		await idle();
	});

	it('preserves close failure and live state for an admitted retry', async () => {
		await start();
		const error = new Error('close failed');
		endpoint.close.mockImplementationOnce(() => {
			expect(active).toBe(2);
			throw error;
		});
		expect(() => server.stop()).toThrow(error);
		expect(server.isRunning()).toBe(true);
		await busy();
		server.stop();
		expect(server.isRunning()).toBe(false);
		await busy();
		endpoint.emit('close');
		await idle();
	});

	it('retains swallowed unlink/chmod failures and guards empty stop', async () => {
		vi.mocked(syncFs.chmodSync).mockImplementationOnce(() => {
			expect(active).toBe(2);
			throw new Error('chmod failed');
		});
		await start();
		expect(logger.warn).toHaveBeenCalledOnce();
		vi.mocked(syncFs.unlinkSync).mockImplementationOnce(() => {
			expect(active).toBe(2);
			throw new Error('already gone');
		});
		expect(server.stop()).toBeUndefined();
		await busy();
		endpoint.emit('close');
		const hold = await idle();
		expect(() => server.stop()).toThrow(/reserved/);
		hold.release();
		expect(server.stop()).toBeUndefined();
	});

	it('keeps caller scope if stop runs while shared startup is still pending', async () => {
		const request = server.ensureStarted(target);
		server.stop();
		await busy();
		listening();
		await request;
		expect(server.isRunning()).toBe(true);
		// Existing stop-during-start semantics are preserved, not cancellation proof.
		await busy();
		server.stop();
		endpoint.emit('close');
		await idle();
	});

	it('holds listening and requested-close lifetimes without claiming complete transport coverage', async () => {
		await start();
		await busy();
		server.stop();
		expect(endpoint.close).toHaveBeenCalledOnce();
		await busy();
		endpoint.emit('close');
		const hold = await idle();
		expect(hold.blockers.length).toBeGreaterThan(0);
	});

	it.each([target, path.join(target, 'child'), path.resolve('unrelated-repository')])(
		'blocks global reservations under %s until native close',
		async (root) => {
			await start();
			expect(await reserve(root)).toMatchObject({ status: 'blocked' });
			server.stop();
			expect(await reserve(root)).toMatchObject({ status: 'blocked' });
			endpoint.emit('close');
			await idle(root);
		}
	);

	it('retains startup after an early close until listening and reporting settle', async () => {
		const request = server.ensureStarted(target);
		endpoint.emit('close');
		expect(active).toBe(2);
		await busy();
		vi.mocked(logger.info).mockImplementationOnce(() => expect(active).toBe(2));
		listening();
		expect(active).toBe(2);
		await request;
		expect(active).toBe(0);
		await idle();
	});

	it('retains both shared callers after close until rejected startup settles', async () => {
		const first = server.ensureStarted(target);
		const second = server.ensureStarted(target);
		const results = Promise.allSettled([first, second]);
		const error = new Error('listen error');
		endpoint.emit('error', error);
		endpoint.emit('close');
		expect(active).toBe(3);
		for (const result of await results)
			expect(result).toEqual({ status: 'rejected', reason: error });
		expect(active).toBe(0);
		await idle();
	});

	it('does not release startup from a reentrant reporting close followed by failure', async () => {
		const error = new Error('report failed');
		vi.mocked(logger.info).mockImplementationOnce(() => {
			server.stop();
			endpoint.emit('close');
			expect(active).toBe(2);
			throw error;
		});
		await expect(start()).rejects.toBe(error);
		expect(active).toBe(0);
		await idle();
	});

	it.each([target, path.join(target, 'child'), path.resolve('unrelated-repository')])(
		'refuses accepted sockets before encoding/listener setup under %s',
		async (root) => {
			await start();
			endpoint.emit('close');
			const hold = await idle(root);
			const setup = vi.fn();
			expect(() => connect((socket) => (socket.setEncoding = setup))).toThrow(/reserved/);
			expect(setup).not.toHaveBeenCalled();
			expect(sockets[0].eventNames()).toEqual([]);
			hold.release();
			const socket = connect();
			expect(socket.setEncoding).toHaveBeenCalledWith('utf8');
			await busy();
			socket.emit('close');
			await idle();
		}
	);

	it('blocks a pending reservation admitted before socket setup', async () => {
		await start();
		endpoint.emit('close');
		let canonicalized!: (value: string) => void;
		vi.mocked(fs.realpath).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					canonicalized = resolve;
				})
		);
		const reservation = reserve();
		const socket = connect();
		canonicalized(target);
		expect(await reservation).toMatchObject({ status: 'blocked' });
		socket.emit('close');
		await idle();
	});

	it('owns every accepted socket independently of server shutdown, end and error', async () => {
		await start();
		const first = connect();
		const second = connect();
		expect(active).toBe(3);
		server.stop();
		endpoint.emit('close');
		expect(active).toBe(2);
		first.emit('end');
		first.emit('error', new Error('connection failed'));
		expect(active).toBe(2);
		await busy();
		first.emit('close');
		first.emit('close');
		expect(active).toBe(1);
		await busy();
		second.emit('close');
		expect(active).toBe(0);
		await idle();
	});

	it.each(['encoding', 'data listener', 'error listener'])(
		'preserves %s setup failure and holds the socket until observed close',
		async (stage) => {
			await start();
			endpoint.emit('close');
			const error = new Error(stage);
			expect(() =>
				connect((socket) => {
					if (stage === 'encoding')
						vi.mocked(socket.setEncoding).mockImplementationOnce(() => {
							expect(active).toBe(1);
							throw error;
						});
					else {
						const emitter: EventEmitter = socket;
						const on = emitter.on.bind(emitter);
						vi.spyOn(emitter, 'on').mockImplementation((event, listener) => {
							if (event === (stage === 'data listener' ? 'data' : 'error')) throw error;
							return on(event, listener);
						});
					}
				})
			).toThrow(error);
			await busy();
			sockets[0].emit('close');
			await idle();
		}
	);

	it.each([false, true])('holds setup after reentrant socket close, throwing=%s', async (fail) => {
		await start();
		endpoint.emit('close');
		const error = new Error('encoding failed after close');
		const setup = () =>
			connect((socket) => {
				vi.mocked(socket.setEncoding).mockImplementationOnce(() => {
					socket.emit('close');
					expect(active).toBe(1);
					if (fail) throw error;
					return socket;
				});
			});
		if (fail) expect(setup).toThrow(error);
		else setup();
		expect(active).toBe(0);
		await idle();
	});

	it.each([target, path.join(target, 'child'), path.resolve('unrelated-repository')])(
		'refuses retained data before chunk inspection or buffer changes under %s',
		async (root) => {
			await start();
			const socket = connect();
			socket.emit('data', '  \n {"type":"hello",');
			endpoint.emit('close');
			socket.emit('close');
			const hold = await idle(root);
			const inspect = vi.fn(() => '"token":"missing"}\n');
			expect(() => socket.emit('data', { [Symbol.toPrimitive]: inspect })).toThrow(/reserved/);
			expect(inspect).not.toHaveBeenCalled();
			expect(socket.write).not.toHaveBeenCalled();
			hold.release();
			socket.emit('data', '"token":"missing"}\n\n{"type":"hello","token":"other"}\n');
			expect(socket.write).toHaveBeenCalledTimes(2);
			for (const [line] of socket.write.mock.calls)
				expect(JSON.parse(line)).toEqual({ type: 'hello-ack', ok: false, error: 'unknown token' });
			await idle();
		}
	);

	it('refuses retained errors before reading payloads or reporting and permits retry', async () => {
		await start();
		const socket = connect();
		endpoint.emit('close');
		socket.emit('close');
		const hold = await idle();
		const inspect = vi.fn(() => 'original error');
		const error = {
			get message() {
				return inspect();
			},
		};
		expect(() => socket.emit('error', error)).toThrow(/reserved/);
		expect(inspect).not.toHaveBeenCalled();
		expect(logger.debug).not.toHaveBeenCalled();
		hold.release();
		vi.mocked(logger.debug).mockImplementationOnce(() => expect(active).toBe(1));
		socket.emit('error', error);
		expect(logger.debug).toHaveBeenCalledWith(
			'Relay socket connection error',
			'[PermissionRelay]',
			{
				error: 'original error',
			}
		);
		await idle();
	});

	it.each(['data', 'error'])(
		'holds retained %s through reentrant native close and reporting failure',
		async (event) => {
			await start();
			const socket = connect();
			endpoint.emit('close');
			const error = new Error('reporting failed');
			const report = event === 'data' ? logger.warn : logger.debug;
			vi.mocked(report).mockImplementationOnce(() => {
				expect(active).toBe(2);
				socket.emit('close');
				expect(active).toBe(1);
				throw error;
			});
			expect(() => socket.emit(event, event === 'data' ? 'invalid\n' : error)).toThrow(error);
			expect(active).toBe(0);
			await idle();
		}
	);

	it('holds nested data and error dispatch until both callbacks settle', async () => {
		await start();
		const socket = connect();
		endpoint.emit('close');
		socket.emit('close');
		vi.mocked(logger.warn).mockImplementationOnce(() => {
			expect(active).toBe(1);
			vi.mocked(logger.debug).mockImplementationOnce(() => expect(active).toBe(2));
			socket.emit('error', new Error('nested'));
			expect(active).toBe(1);
		});
		socket.emit('data', 'invalid\n');
		expect(active).toBe(0);
		await idle();
	});

	it('releases a failed retained chunk conversion without losing a live socket hold', async () => {
		await start();
		const socket = connect();
		endpoint.emit('close');
		const error = new Error('conversion failed');
		expect(() =>
			socket.emit('data', {
				[Symbol.toPrimitive]() {
					throw error;
				},
			})
		).toThrow(error);
		expect(active).toBe(1);
		await busy();
		socket.emit('close');
		await idle();
	});

	it('keeps independently closing endpoints held across a restart', async () => {
		await start();
		const prior = endpoint;
		server.stop();
		const next = new EventEmitter();
		const nextListen = vi.fn((_path, ready: () => void) => {
			listening = ready;
			return next;
		});
		Object.assign(next, { listen: nextListen, close: vi.fn() });
		vi.mocked(net.createServer).mockReturnValueOnce(next as net.Server);
		await start();
		expect(active).toBe(2);
		prior.emit('close');
		expect(active).toBe(1);
		await busy();
		server.stop();
		await busy();
		next.emit('close');
		expect(active).toBe(0);
		// The old emitter cannot release a later endpoint or release twice.
		prior.emit('close');
		expect(active).toBe(0);
		await idle();
	});
});
