import fs from 'fs/promises';
import path from 'path';
import net from 'net';
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs/promises', () => ({ default: { realpath: vi.fn() } }));
vi.mock('net', async (original) => {
	const actual = await original<typeof import('net')>();
	const createConnection = vi.fn();
	return { ...actual, createConnection, default: { ...actual, createConnection } };
});
vi.mock('../../../main/utils/logger', () => ({ logger: { warn: vi.fn() } }));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

import { sendSteeringRequest } from '../../../main/process-manager/steering-client';
import { logger } from '../../../main/utils/logger';
import { captureException } from '../../../main/utils/sentry';
import { reserveWorktreeCleanup } from '../../../main/git/worktreeActivity';

const target = path.resolve('steering-socket-target');
const options = { processKey: 'steering-ai-tab', id: 'steer', text: 'continue', timeoutMs: 50 };
let sockets: ReturnType<typeof makeSocket>[];
let releases: Array<() => void>;

function makeSocket() {
	return Object.assign(new EventEmitter(), {
		setEncoding: vi.fn(),
		write: vi.fn(),
		destroy: vi.fn(),
	});
}

async function drain() {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

async function reserve(root = target) {
	const hold = await reserveWorktreeCleanup(root);
	expect(hold.status).toBe('reserved-partially');
	if (hold.status !== 'reserved-partially') throw new Error('Expected partial reservation');
	expect(hold.blockers.map((b) => b.message).join(' ')).toMatch(/native.*registration.*OS/);
	releases.push(hold.release);
	return hold;
}

async function blocked() {
	const hold = await reserveWorktreeCleanup(target);
	if (hold.status === 'reserved-partially') releases.push(hold.release);
	expect(hold).toMatchObject({ status: 'blocked', blockers: [{ code: 'mutation-busy' }] });
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	vi.clearAllMocks();
	sockets = [];
	releases = [];
	vi.mocked(fs.realpath).mockImplementation(async (p) => String(p));
	vi.mocked(net.createConnection).mockImplementation(() => {
		const socket = makeSocket();
		sockets.push(socket);
		return socket as unknown as net.Socket;
	});
});

afterEach(async () => {
	for (const release of releases) release();
	vi.mocked(logger.warn).mockReset();
	vi.mocked(captureException).mockReset();
	for (const socket of sockets) socket.emit('close');
	vi.runAllTimers();
	await drain();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('maestro-p steering socket activity', () => {
	it.each([target, path.join(target, 'descendant'), path.resolve('unrelated-socket-target')])(
		'refuses before option lookup or native setup during reservation of %s',
		async (root) => {
			await reserve(root);
			const text = vi.fn(() => options.text);
			await expect(
				sendSteeringRequest({
					...options,
					get text() {
						return text();
					},
				})
			).rejects.toThrow(/reserved/);
			expect(text).not.toHaveBeenCalled();
			expect(net.createConnection).not.toHaveBeenCalled();
			expect(captureException).not.toHaveBeenCalled();
		}
	);

	it('keeps concurrent verdicts and native close independent after the caller settles', async () => {
		const first = sendSteeringRequest(options);
		const second = sendSteeringRequest({ ...options, id: 'second' });
		for (const socket of sockets) socket.emit('connect');
		expect(sockets[0].write).toHaveBeenCalledWith(expect.stringContaining('"text":"continue"'));
		sockets[0].emit('data', '{"type":"steering","id":"steer","verdict":"delivered"}\n');
		await expect(first).resolves.toMatchObject({ verdict: 'delivered' });
		await blocked();
		sockets[0].emit('close');
		await drain();
		await blocked();
		sockets[1].emit('data', '{"type":"steering","id":"second","verdict":"absorbed"}\n');
		await expect(second).resolves.toMatchObject({ verdict: 'absorbed' });
		await blocked();
		sockets[1].emit('close');
		await drain();
		await reserve();
	});

	it('retains timed-out sockets and prevents a late connect from typing settled text', async () => {
		const result = sendSteeringRequest(options);
		vi.advanceTimersByTime(50);
		await expect(result).resolves.toMatchObject({
			verdict: 'unknown',
			detail: expect.stringContaining('in time'),
		});
		expect(sockets[0].destroy).toHaveBeenCalledOnce();
		await blocked();
		sockets[0].emit('connect');
		sockets[0].emit('error', new Error('late error'));
		expect(sockets[0].write).not.toHaveBeenCalled();
		expect(logger.warn).not.toHaveBeenCalled();
		sockets[0].emit('close');
		await drain();
		await reserve();
	});

	it.each(['connect', 'data', 'error', 'close', 'timeout'])(
		'refuses a retained %s callback before state, option, output or recovery access',
		async (event) => {
			const timer = vi.spyOn(globalThis, 'setTimeout');
			const result = sendSteeringRequest(options);
			const callback =
				event === 'timeout'
					? (timer.mock.calls[0][0] as () => void)
					: sockets[0].listeners(event).at(-1)!;
			sockets[0].emit('close');
			await result;
			await drain();
			await reserve();
			expect(() => callback(event === 'data' ? 'bad' : new Error('late'))).toThrow(/reserved/);
			expect(sockets[0].write).not.toHaveBeenCalled();
			expect(logger.warn).not.toHaveBeenCalled();
			expect(captureException).not.toHaveBeenCalled();
		}
	);

	it('wins admission against a reservation still resolving its canonical path', async () => {
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const reservation = reserveWorktreeCleanup(target);
		const result = sendSteeringRequest(options);
		canonical.resolve(target);
		expect(await reservation).toMatchObject({ status: 'blocked' });
		sockets[0].emit('close');
		await result;
		await drain();
		await reserve();
	});

	it('releases synchronous connection failure without leaving timers or native work', async () => {
		vi.mocked(net.createConnection).mockImplementationOnce(() => {
			throw new Error('connect setup');
		});
		await expect(sendSteeringRequest(options)).rejects.toThrow('connect setup');
		expect(vi.getTimerCount()).toBe(0);
		await drain();
		await reserve();
	});

	it('retains actual close after setup fails with an already returned native socket', async () => {
		const socket = makeSocket();
		socket.setEncoding.mockImplementationOnce(() => {
			throw new Error('encoding setup');
		});
		vi.mocked(net.createConnection).mockImplementationOnce(() => {
			sockets.push(socket);
			return socket as unknown as net.Socket;
		});
		await expect(sendSteeringRequest(options)).rejects.toThrow('encoding setup');
		expect(socket.destroy).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
		await blocked();
		socket.emit('close');
		await drain();
		await reserve();
	});

	it('prevents late writes after timer setup fails while retaining native close', async () => {
		vi.spyOn(globalThis, 'setTimeout').mockImplementationOnce(() => {
			throw new Error('timer setup');
		});
		await expect(sendSteeringRequest(options)).rejects.toThrow('timer setup');
		sockets[0].emit('connect');
		sockets[0].emit('error', new Error('late setup error'));
		expect(sockets[0].write).not.toHaveBeenCalled();
		expect(logger.warn).not.toHaveBeenCalled();
		await blocked();
		sockets[0].emit('close');
		await drain();
		await reserve();
	});

	it('preserves write failure verdict and retains close even when destroy throws', async () => {
		const result = sendSteeringRequest(options);
		sockets[0].write.mockImplementationOnce(() => {
			throw new Error('write failed');
		});
		sockets[0].destroy.mockImplementationOnce(() => {
			throw new Error('destroy failed');
		});
		sockets[0].emit('connect');
		await expect(result).resolves.toMatchObject({ verdict: 'refused', refusal: 'tui-exited' });
		await blocked();
		sockets[0].emit('close');
		await drain();
		await reserve();
	});

	it('retains a pending verdict after failed diagnostics and preserves timeout recovery', async () => {
		const result = sendSteeringRequest(options);
		vi.mocked(logger.warn).mockImplementationOnce(() => {
			throw new Error('logging failed');
		});
		vi.mocked(captureException).mockImplementation(() => {
			throw new Error('report failed');
		});
		expect(() => sockets[0].emit('error', new Error('unexpected'))).toThrow('logging failed');
		await blocked();
		vi.advanceTimersByTime(50);
		await expect(result).resolves.toMatchObject({ verdict: 'unknown' });
		await blocked();
		sockets[0].emit('close');
		await drain();
		await reserve();
	});
});

describe('steering asynchronous diagnostic activity', () => {
	it.each(['resolve', 'reject', 'throw'])(
		'preserves setup rejection while diagnostics %s independently',
		async (settlement) => {
			const failure = new Error('connection setup failed');
			const reporting = Promise.withResolvers<void>();
			vi.mocked(net.createConnection).mockImplementationOnce(() => {
				throw failure;
			});
			vi.mocked(captureException).mockImplementationOnce(() => {
				if (settlement === 'throw') throw new Error('synchronous diagnostic failure');
				return reporting.promise;
			});
			await expect(sendSteeringRequest(options)).rejects.toBe(failure);
			await drain();
			expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
			expect(sockets).toHaveLength(0);
			expect(vi.getTimerCount()).toBe(0);
			if (settlement !== 'throw') {
				await blocked();
				if (settlement === 'reject') reporting.reject(new Error('diagnostic rejection'));
				else reporting.resolve();
				await drain();
			}
			expect(captureException).toHaveBeenCalledTimes(1);
			await reserve();
		}
	);

	it.each(['report-first', 'close-first'])(
		'keeps failed native setup and diagnostics independently held: %s',
		async (order) => {
			const reporting = Promise.withResolvers<void>();
			const failure = new Error('encoding setup failed');
			const socket = makeSocket();
			socket.setEncoding.mockImplementationOnce(() => {
				throw failure;
			});
			vi.mocked(net.createConnection).mockImplementationOnce(() => {
				sockets.push(socket);
				return socket as unknown as net.Socket;
			});
			vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
			await expect(sendSteeringRequest(options)).rejects.toBe(failure);
			await drain();
			expect(socket.destroy).toHaveBeenCalledOnce();
			if (order === 'report-first') reporting.resolve();
			else socket.emit('close');
			await drain();
			await blocked();
			if (order === 'report-first') socket.emit('close');
			else reporting.resolve();
			await drain();
			expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
			await reserve();
		}
	);

	it.each(
		['connect', 'data', 'error', 'close', 'timeout'].flatMap((event) =>
			['resolve', 'reject'].map((settlement) => ({ event, settlement }))
		)
	)(
		'retains $event callback diagnostics after verdict/native close until $settlement',
		async ({ event, settlement }) => {
			const reporting = Promise.withResolvers<void>();
			const failure = new Error(`${event} callback failed`);
			const readId = vi.fn(() => options.id);
			const timer = vi.spyOn(globalThis, 'setTimeout');
			const result = sendSteeringRequest({
				...options,
				get id() {
					return readId();
				},
			});
			const timeout = timer.mock.calls[0][0] as () => void;
			vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
			readId.mockImplementationOnce(() => {
				throw failure;
			});
			if (event === 'connect') {
				sockets[0].write.mockImplementationOnce(() => {
					throw new Error('write failed');
				});
			}
			const dispatch = () => {
				if (event === 'timeout') timeout();
				else if (event === 'data')
					sockets[0].emit('data', '{"type":"steering","id":"steer","verdict":"delivered"}\n');
				else sockets[0].emit(event, new Error('channel failed'));
			};
			expect(dispatch).toThrow(failure);
			expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
			// A fresh close callback recovers the unchanged pending verdict. Neither
			// that verdict nor native close owns the earlier callback's diagnostics.
			sockets[0].emit('close');
			await expect(result).resolves.toMatchObject({ verdict: 'unknown', id: options.id });
			await drain();
			expect(vi.getTimerCount()).toBe(0);
			await blocked();
			if (settlement === 'reject') reporting.reject(new Error('diagnostic rejection'));
			else reporting.resolve();
			await drain();
			expect(captureException).toHaveBeenCalledTimes(1);
			await reserve();
		}
	);

	it('keeps concurrent diagnostics and a successor socket independently owned', async () => {
		const firstReport = Promise.withResolvers<void>();
		const secondReport = Promise.withResolvers<void>();
		const failure = new Error('setup failure');
		vi.mocked(net.createConnection)
			.mockImplementationOnce(() => {
				throw failure;
			})
			.mockImplementationOnce(() => {
				throw failure;
			});
		vi.mocked(captureException)
			.mockReturnValueOnce(firstReport.promise)
			.mockReturnValueOnce(secondReport.promise);
		await expect(sendSteeringRequest(options)).rejects.toBe(failure);
		await expect(sendSteeringRequest(options)).rejects.toBe(failure);
		await drain();
		firstReport.resolve();
		await drain();
		await blocked();
		const successor = sendSteeringRequest(options);
		secondReport.reject(new Error('second report failed'));
		await drain();
		await blocked();
		sockets[0].emit('close');
		await expect(successor).resolves.toMatchObject({ verdict: 'unknown' });
		await drain();
		expect(captureException).toHaveBeenCalledTimes(2);
		await reserve();
	});

	it('wins a pending canonical reservation while setup diagnostics remain in flight', async () => {
		const canonical = Promise.withResolvers<string>();
		const reporting = Promise.withResolvers<void>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const reservation = reserveWorktreeCleanup(target);
		const failure = new Error('setup failure');
		vi.mocked(net.createConnection).mockImplementationOnce(() => {
			throw failure;
		});
		vi.mocked(captureException).mockReturnValueOnce(reporting.promise);
		await expect(sendSteeringRequest(options)).rejects.toBe(failure);
		await drain();
		canonical.resolve(target);
		const held = await reservation;
		if (held.status === 'reserved-partially') releases.push(held.release);
		expect(held).toMatchObject({ status: 'blocked' });
		reporting.resolve();
		await drain();
		await reserve();
	});
});
