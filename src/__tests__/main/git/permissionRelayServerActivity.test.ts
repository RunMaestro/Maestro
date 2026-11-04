import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import * as syncFs from 'fs';
import * as net from 'net';
import path from 'path';
import { logger } from '../../../main/utils/logger';
import { RELAY_DECISION_TIMEOUT_MS } from '../../../main/permission-relay/types';
import type {
	BridgeToServerMessage,
	PermissionRequest,
} from '../../../main/permission-relay/types';

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
	let registry: typeof import('../../../main/permission-relay/registry');
	let cleanups: Array<() => void>;
	let requests: Promise<void>[];
	const decision = { behavior: 'allow' as const, updatedInput: { command: 'example' } };
	function decisionRequest(
		token = 'unknown',
		msg: Extract<BridgeToServerMessage, { type: 'permission-request' }> = {
			type: 'permission-request',
			token,
			requestId: 'bridge-id',
			toolName: 'Bash',
			input: { command: 'example' },
		}
	) {
		const socket = { destroyed: false, write: vi.fn() };
		const result = Reflect.get(server, 'handlePermissionRequest').call(
			server,
			socket,
			msg
		) as Promise<void>;
		requests.push(result);
		void result.catch(() => {});
		return { socket, result };
	}
	function binding() {
		const spawn = registry.registerSpawn({ sessionId: 'agent-ai', tabId: 'tab' });
		cleanups.push(spawn.cleanup);
		return spawn;
	}
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
	async function closeBindingsAndReserve() {
		if (registry.relayRegistryStats().bindings) await busy();
		for (const cleanup of cleanups) cleanup();
		return idle();
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
		cleanups = [];
		requests = [];
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
		registry = await import('../../../main/permission-relay/registry');
	});
	afterEach(async () => {
		for (const release of releases) release();
		for (const cleanup of cleanups) cleanup();
		await Promise.allSettled(requests);
		for (const socket of sockets) socket.emit('close');
		server.stop();
		endpoint.emit('close');
		expect(active).toBe(0);
		expect(registry.relayRegistryStats()).toEqual({ bindings: 0, pending: 0 });
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

	it.each([target, path.join(target, 'child'), path.resolve('unrelated-repository')])(
		'refuses async decisions before binding or payload inspection under %s',
		async (root) => {
			const lookup = vi.spyOn(registry, 'lookupBinding');
			const inspect = vi.fn(() => 'unknown');
			const hold = await idle(root);
			const msg = {
				type: 'permission-request' as const,
				requestId: 'bridge-id',
				toolName: 'Bash',
				input: {},
				get token() {
					return inspect();
				},
			};
			const refused = decisionRequest('unknown', msg);
			await expect(refused.result).rejects.toThrow(/reserved/);
			expect(inspect).not.toHaveBeenCalled();
			expect(lookup).not.toHaveBeenCalled();
			expect(refused.socket.write).not.toHaveBeenCalled();
			hold.release();
			await decisionRequest().result;
			await idle();
		}
	);

	it('blocks a pending reservation before asynchronous decision setup can yield', async () => {
		const spawn = binding();
		let requestId = '';
		server.setOnRequest((request) => {
			requestId = request.requestId;
		});
		const reserving = reserve();
		const pending = decisionRequest(spawn.token);
		expect(await reserving).toMatchObject({
			status: 'blocked',
			blockers: [{ code: 'mutation-busy' }],
		});
		registry.resolvePending(requestId, decision);
		await pending.result;
		await closeBindingsAndReserve();
	});

	it.each(['unknown token', 'missing UI'])(
		'holds immediate %s denial through delivery',
		async (mode) => {
			const token = mode === 'missing UI' ? binding().token : 'unknown';
			const writes: string[] = [];
			let deliveryActive = -1;
			const socket = {
				destroyed: false,
				write: (line: string) => {
					deliveryActive = active;
					writes.push(line);
				},
			};
			await Reflect.get(server, 'handlePermissionRequest').call(server, socket, {
				type: 'permission-request',
				token,
				requestId: 'original-id',
				toolName: 'Bash',
				input: {},
			});
			expect(deliveryActive).toBe(1 + registry.relayRegistryStats().bindings);
			expect(JSON.parse(writes[0])).toEqual({
				type: 'permission-response',
				requestId: 'original-id',
				decision: {
					behavior: 'deny',
					message:
						mode === 'missing UI'
							? 'Permission UI unavailable.'
							: 'Unrecognized permission relay token.',
				},
			});
			await closeBindingsAndReserve();
		}
	);

	it('keeps concurrent decisions independently busy through forwarding and response settlement', async () => {
		const spawn = binding();
		const forwarded: PermissionRequest[] = [];
		server.setOnRequest((request) => {
			expect(active).toBeGreaterThan(0);
			forwarded.push(request);
		});
		const first = decisionRequest(spawn.token);
		const second = decisionRequest(spawn.token);
		expect(forwarded[0]).toMatchObject({
			token: spawn.token,
			sessionId: 'agent-ai',
			tabId: 'tab',
			toolName: 'Bash',
			input: { command: 'example' },
			createdAt: expect.any(Number),
		});
		expect(forwarded[0].requestId).not.toBe(forwarded[1].requestId);
		await busy();
		registry.resolvePending(forwarded[0].requestId, decision);
		expect(active).toBe(3 + registry.relayRegistryStats().bindings);
		await first.result;
		expect(active).toBe(2 + registry.relayRegistryStats().bindings);
		await busy();
		registry.resolvePending(forwarded[1].requestId, decision);
		let deliveryActive = -1;
		second.socket.write.mockImplementationOnce(() => {
			deliveryActive = active;
		});
		await second.result;
		expect(deliveryActive).toBe(1 + registry.relayRegistryStats().bindings);
		for (const item of [first, second])
			expect(JSON.parse(item.socket.write.mock.calls[0][0])).toEqual({
				type: 'permission-response',
				requestId: 'bridge-id',
				decision,
			});
		await closeBindingsAndReserve();
	});

	it('holds socket-dispatched decisions after native close through resumed writes', async () => {
		const spawn = binding();
		let requestId = '';
		server.setOnRequest((request) => {
			requestId = request.requestId;
		});
		await start();
		const socket = connect();
		socket.emit(
			'data',
			JSON.stringify({
				type: 'permission-request',
				token: spawn.token,
				requestId: 'wire-id',
				toolName: 'Bash',
				input: {},
			}) + '\n'
		);
		expect(active).toBe(4 + registry.relayRegistryStats().bindings);
		server.stop();
		endpoint.emit('close');
		socket.emit('close');
		expect(active).toBe(2 + registry.relayRegistryStats().bindings);
		await busy();
		let deliveryActive = -1;
		socket.write.mockImplementationOnce(() => {
			deliveryActive = active;
		});
		registry.resolvePending(requestId, decision);
		expect(active).toBe(1 + registry.relayRegistryStats().bindings);
		await Promise.resolve();
		expect(deliveryActive).toBe(1 + registry.relayRegistryStats().bindings);
		expect(JSON.parse(socket.write.mock.calls[0][0])).toEqual({
			type: 'permission-response',
			requestId: 'wire-id',
			decision,
		});
		await closeBindingsAndReserve();
	});

	it.each(['lookup', 'payload', 'pending creation', 'forwarding', 'decision rejection'])(
		'preserves async %s failure and releases only the failed request scope',
		async (stage) => {
			const spawn = binding();
			const error = new Error(stage);
			const fail = () => {
				expect(active).toBe(
					(stage === 'forwarding' ? 2 : 1) + registry.relayRegistryStats().bindings
				);
				throw error;
			};
			server.setOnRequest(stage === 'forwarding' ? fail : vi.fn());
			if (stage === 'lookup') vi.spyOn(registry, 'lookupBinding').mockImplementationOnce(fail);
			if (stage === 'pending creation')
				vi.spyOn(registry, 'createPending').mockImplementationOnce(fail);
			if (stage === 'decision rejection')
				vi.spyOn(registry, 'createPending').mockRejectedValueOnce(error);
			const msg = {
				type: 'permission-request' as const,
				token: spawn.token,
				requestId: 'bridge-id',
				toolName: 'Bash',
				get input() {
					if (stage === 'payload') return fail();
					return {};
				},
			};
			const failed = decisionRequest(spawn.token, msg);
			await expect(failed.result).rejects.toBe(error);
			expect(failed.socket.write).not.toHaveBeenCalled();
			// A forwarding throw historically leaves a pending registry entry; this
			// request scope must not pretend to own that independent registry lifetime.
			expect(registry.relayRegistryStats().pending).toBe(stage === 'forwarding' ? 1 : 0);
			if (stage === 'forwarding') await busy();
			spawn.cleanup();
			await closeBindingsAndReserve();
		}
	);

	it.each(['destroyed socket', 'destroyed getter', 'write failure', 'report failure'])(
		'holds resumed %s handling and preserves its outcome',
		async (stage) => {
			const spawn = binding();
			let requestId = '';
			server.setOnRequest((request) => {
				requestId = request.requestId;
			});
			const pending = decisionRequest(spawn.token);
			const error = new Error(stage);
			const fail = () => {
				expect(active).toBe(1 + registry.relayRegistryStats().bindings);
				throw error;
			};
			if (stage === 'destroyed socket') pending.socket.destroyed = true;
			if (stage === 'destroyed getter')
				Object.defineProperty(pending.socket, 'destroyed', { get: fail });
			if (stage === 'write failure' || stage === 'report failure')
				pending.socket.write.mockImplementationOnce(fail);
			if (stage === 'write failure' || stage === 'report failure')
				vi.mocked(logger.debug).mockImplementationOnce(() => {
					expect(active).toBe(1 + registry.relayRegistryStats().bindings);
					if (stage === 'report failure') throw error;
				});
			registry.resolvePending(requestId, decision);
			expect(active).toBe(1 + registry.relayRegistryStats().bindings);
			if (stage === 'destroyed getter' || stage === 'report failure')
				await expect(pending.result).rejects.toBe(error);
			else await expect(pending.result).resolves.toBeUndefined();
			if (stage === 'destroyed socket' || stage === 'destroyed getter')
				expect(pending.socket.write).not.toHaveBeenCalled();
			if (stage === 'write failure' || stage === 'report failure')
				expect(logger.debug).toHaveBeenCalledWith(
					'Failed to write to relay socket',
					'[PermissionRelay]',
					{ error: stage }
				);
			await closeBindingsAndReserve();
		}
	);

	it.each(['timeout', 'spawn exit'])(
		'holds %s denial through asynchronous response delivery',
		async (mode) => {
			vi.useFakeTimers();
			try {
				const spawn = binding();
				server.setOnRequest(vi.fn());
				const pending = decisionRequest(spawn.token);
				let deliveryActive = -1;
				pending.socket.write.mockImplementationOnce(() => {
					deliveryActive = active;
				});
				if (mode === 'timeout') await vi.advanceTimersByTimeAsync(RELAY_DECISION_TIMEOUT_MS);
				else {
					spawn.cleanup();
					expect(active).toBe(1 + registry.relayRegistryStats().bindings);
				}
				await pending.result;
				expect(deliveryActive).toBe(1 + registry.relayRegistryStats().bindings);
				expect(JSON.parse(pending.socket.write.mock.calls[0][0]).decision).toEqual({
					behavior: 'deny',
					message:
						mode === 'timeout'
							? 'Permission request timed out with no response.'
							: 'Agent process exited.',
				});
				await closeBindingsAndReserve();
			} finally {
				vi.useRealTimers();
			}
		}
	);

	it('retains native socket and server ownership after a decision completes', async () => {
		const spawn = binding();
		let requestId = '';
		server.setOnRequest((request) => {
			requestId = request.requestId;
		});
		await start();
		const socket = connect();
		socket.emit(
			'data',
			JSON.stringify({
				type: 'permission-request',
				token: spawn.token,
				requestId: 'wire-id',
				toolName: 'Bash',
				input: {},
			}) + '\n'
		);
		registry.resolvePending(requestId, decision);
		await Promise.resolve();
		expect(active).toBe(2 + registry.relayRegistryStats().bindings);
		await busy();
		socket.emit('close');
		expect(active).toBe(1 + registry.relayRegistryStats().bindings);
		await busy();
		endpoint.emit('close');
		await closeBindingsAndReserve();
	});

	it('holds reentrant permission forwarding as independent decision scopes', async () => {
		const spawn = binding();
		const forwarded: PermissionRequest[] = [];
		server.setOnRequest((request) => {
			forwarded.push(request);
			if (forwarded.length === 1) {
				decisionRequest(spawn.token);
				expect(active).toBe(4 + registry.relayRegistryStats().bindings);
			}
		});
		const first = decisionRequest(spawn.token);
		expect(active).toBe(4 + registry.relayRegistryStats().bindings);
		for (const request of forwarded) registry.resolvePending(request.requestId, decision);
		expect(active).toBe(2 + registry.relayRegistryStats().bindings);
		await first.result;
		await Promise.all(requests);
		await closeBindingsAndReserve();
	});
});
