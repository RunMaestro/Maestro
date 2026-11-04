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

describe('permission relay server public request activity', () => {
	const target = path.resolve('relay-server-target');
	let gate: typeof import('../../../main/git/worktreeActivity');
	let server: import('../../../main/permission-relay/PermissionRelayServer').PermissionRelayServer;
	let endpoint: EventEmitter & {
		listen: ReturnType<typeof vi.fn>;
		close: ReturnType<typeof vi.fn>;
	};
	let listening: () => void;
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
	beforeEach(async () => {
		vi.resetModules();
		vi.clearAllMocks();
		releases = [];
		active = 0;
		vi.mocked(fs.realpath).mockImplementation(async (p) => String(p));
		vi.spyOn(process, 'umask').mockReturnValue(0o022);
		endpoint = Object.assign(new EventEmitter(), { listen: vi.fn(), close: vi.fn() });
		endpoint.listen.mockImplementation((_socketPath: string, callback: () => void) => {
			listening = callback;
			return endpoint;
		});
		vi.mocked(net.createServer).mockReturnValue(endpoint as unknown as net.Server);
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
		server.stop();
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
		expect(active).toBe(2);
		await busy();
		expect(net.createServer).toHaveBeenCalledOnce();
		expect(endpoint.listen).toHaveBeenCalledOnce();
		vi.mocked(syncFs.chmodSync).mockImplementationOnce(() => expect(active).toBe(2));
		vi.mocked(logger.info).mockImplementationOnce(() => expect(active).toBe(2));
		listening();
		expect(await first).toBe(await second);
		expect(server.isRunning()).toBe(true);
		await idle();
	});

	it('refuses even an already-running start before reading cached state', async () => {
		const expected = await start();
		const hold = await idle();
		await expect(server.ensureStarted(target)).rejects.toThrow(/reserved/);
		expect(net.createServer).toHaveBeenCalledOnce();
		hold.release();
		expect(await server.ensureStarted(target)).toBe(expected);
		await idle();
	});

	it.each(['create', 'listen', 'error event', 'report'])(
		'releases failed %s setup, preserves the error and allows retry',
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
			expect(active).toBe(0);
			const hold = await idle();
			hold.release();
			if (stage === 'report') server.stop();
			await start();
		}
	);

	it('holds reentrant stop and restart reporting within the original start request', async () => {
		vi.mocked(logger.info).mockImplementationOnce(() => {
			expect(active).toBe(1);
			endpoint.close.mockImplementationOnce(() => expect(active).toBe(2));
			server.stop();
			expect(active).toBe(1);
		});
		await start();
		expect(server.isRunning()).toBe(false);
		await start();
		await idle();
	});

	it.each([target, path.join(target, 'child'), path.resolve('unrelated-repository')])(
		'refuses callback replacement and stop under %s without touching live state',
		async (root) => {
			const callback = vi.fn();
			server.setOnRequest(callback);
			await start();
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
			expect(active).toBe(1);
			server.setOnRequest(vi.fn());
			expect(active).toBe(1);
		});
		vi.mocked(syncFs.unlinkSync).mockImplementationOnce(() => expect(active).toBe(1));
		server.stop();
		expect(active).toBe(0);
		await idle();
	});

	it('preserves close failure and live state for an admitted retry', async () => {
		await start();
		const error = new Error('close failed');
		endpoint.close.mockImplementationOnce(() => {
			expect(active).toBe(1);
			throw error;
		});
		expect(() => server.stop()).toThrow(error);
		expect(server.isRunning()).toBe(true);
		const hold = await idle();
		hold.release();
		server.stop();
		expect(server.isRunning()).toBe(false);
	});

	it('retains swallowed unlink/chmod failures and guards empty stop', async () => {
		vi.mocked(syncFs.chmodSync).mockImplementationOnce(() => {
			expect(active).toBe(1);
			throw new Error('chmod failed');
		});
		await start();
		expect(logger.warn).toHaveBeenCalledOnce();
		vi.mocked(syncFs.unlinkSync).mockImplementationOnce(() => {
			expect(active).toBe(1);
			throw new Error('already gone');
		});
		expect(server.stop()).toBeUndefined();
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
		await idle();
	});

	it('does not claim native server close or listening/transport coverage', async () => {
		await start();
		const listeningHold = await idle();
		listeningHold.release();
		server.stop();
		const closeHold = await idle();
		expect(closeHold.blockers.length).toBeGreaterThan(0);
		// close was only requested; no native close event has been observed.
		expect(endpoint.close).toHaveBeenCalledOnce();
	});
});
