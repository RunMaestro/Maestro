import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import * as syncFs from 'fs';
import path from 'path';

vi.mock('fs/promises', async (original) => {
	const actual = await original<typeof import('fs/promises')>();
	return { ...actual, default: { ...actual, realpath: vi.fn() } };
});
vi.mock('fs', async (original) => ({
	...(await original<typeof import('fs')>()),
	unlinkSync: vi.fn(),
}));
vi.mock('child_process', async (original) => ({
	...(await original<typeof import('child_process')>()),
	spawn: vi.fn(),
}));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: vi.fn(() => []) } }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), warn: vi.fn() },
}));
vi.mock('../../../main/utils/safe-send', () => ({ createSafeSend: vi.fn(() => vi.fn()) }));
vi.mock('../../../main/permission-relay/PermissionRelayServer', () => ({
	permissionRelayServer: { ensureStarted: vi.fn(), setOnRequest: vi.fn() },
}));
vi.mock('../../../main/permission-relay/registry', () => ({
	registerSpawn: vi.fn(),
	resolvePending: vi.fn(),
	subscribePendingPermissions: vi.fn(),
}));
vi.mock('../../../main/permission-relay/spawn-args', () => ({
	resolveBridgeScriptPath: vi.fn(),
	buildRelayArgs: vi.fn(),
}));
import { spawn } from 'child_process';
import { logger } from '../../../main/utils/logger';
import { permissionRelayServer as server } from '../../../main/permission-relay/PermissionRelayServer';
import { registerSpawn } from '../../../main/permission-relay/registry';
import { resolveBridgeScriptPath, buildRelayArgs } from '../../../main/permission-relay/spawn-args';

describe('standalone permission relay setup and cleanup activity', () => {
	const target = path.resolve('relay-target');
	const params = { sessionId: 'agent-ai', tabId: 'tab', userDataDir: target, execPath: '/node' };
	const args = ['--mcp-config', 'owned-config'];
	let gate: typeof import('../../../main/git/worktreeActivity');
	let relay: typeof import('../../../main/permission-relay/integration');
	let releases: Array<() => void>;
	let cleanups: ReturnType<typeof vi.fn>[];
	let synchronousHolds: number;
	const drain = () => new Promise(setImmediate);
	async function reserve(root = target) {
		const result = await gate.reserveWorktreeCleanup(root);
		if (result.status === 'reserved-partially') releases.push(result.release);
		expect(result.status).toBe('reserved-partially');
		if (result.status !== 'reserved-partially') throw new Error('Expected partial reservation');
		expect(result.blockers.map((b) => b.message).join(' ')).toMatch(/native.*registration.*OS/);
		return result;
	}
	async function blocked() {
		const result = await gate.reserveWorktreeCleanup(target);
		if (result.status === 'reserved-partially') releases.push(result.release);
		expect(result).toMatchObject({ status: 'blocked', blockers: [{ code: 'mutation-busy' }] });
	}
	beforeEach(async () => {
		vi.resetModules();
		vi.clearAllMocks();
		releases = [];
		cleanups = [];
		vi.mocked(fs.realpath)
			.mockReset()
			.mockImplementation(async (p) => String(p));
		vi.mocked(syncFs.unlinkSync).mockReset();
		vi.mocked(resolveBridgeScriptPath).mockReset().mockReturnValue('/bridge.js');
		vi.mocked(server.ensureStarted).mockReset().mockResolvedValue('/relay.sock');
		vi.mocked(buildRelayArgs).mockReset().mockReturnValue({ args, configPath: 'owned-config' });
		vi.mocked(logger.debug).mockReset();
		vi.mocked(registerSpawn)
			.mockReset()
			.mockImplementation(() => {
				const cleanup = vi.fn();
				cleanups.push(cleanup);
				return { token: `token-${cleanups.length}`, cleanup };
			});
		gate = await import('../../../main/git/worktreeActivity');
		synchronousHolds = 0;
		const admit = gate.beginGlobalWorktreeActivity;
		vi.spyOn(gate, 'beginGlobalWorktreeActivity').mockImplementation(() => {
			const release = admit();
			synchronousHolds++;
			let released = false;
			return () => {
				if (!released) {
					released = true;
					synchronousHolds--;
				}
				release();
			};
		});
		relay = await import('../../../main/permission-relay/integration');
	});
	afterEach(() => {
		for (const release of releases) release();
		relay.cleanupSessionRelay(params.sessionId);
		expect(synchronousHolds).toBe(0);
		vi.restoreAllMocks();
	});

	it.each([target, path.join(target, 'descendant'), path.resolve('other-repository')])(
		'refuses setup before parameter/path/native inspection under %s',
		async (root) => {
			await reserve(root);
			const input = {
				get sessionId(): string {
					throw new Error('parameter read');
				},
			};
			await expect(relay.preparePermissionRelayArgs(input as typeof params)).rejects.toThrow(
				/reserved/
			);
			for (const work of [
				resolveBridgeScriptPath,
				server.ensureStarted,
				registerSpawn,
				buildRelayArgs,
				logger.debug,
			])
				expect(work).not.toHaveBeenCalled();
		}
	);

	it('admits synchronously before pending reservation canonicalization', async () => {
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const reservation = gate.reserveWorktreeCleanup(target);
		const startup = Promise.withResolvers<string>();
		vi.mocked(server.ensureStarted).mockReturnValueOnce(startup.promise);
		const request = relay.preparePermissionRelayArgs(params);
		canonical.resolve(target);
		await expect(reservation).resolves.toMatchObject({ status: 'blocked' });
		startup.resolve('/relay.sock');
		await expect(request).resolves.toBe(args);
		await reserve();
	});

	it('holds through pending startup and preserves the exact spawn payload', async () => {
		const startup = Promise.withResolvers<string>();
		vi.mocked(server.ensureStarted).mockReturnValueOnce(startup.promise);
		const request = relay.preparePermissionRelayArgs(params);
		await blocked();
		expect(registerSpawn).not.toHaveBeenCalled();
		startup.resolve('/relay.sock');
		await expect(request).resolves.toBe(args);
		expect(registerSpawn).toHaveBeenCalledExactlyOnceWith({
			sessionId: params.sessionId,
			tabId: 'tab',
		});
		expect(buildRelayArgs).toHaveBeenCalledExactlyOnceWith(
			'/node',
			'/bridge.js',
			'/relay.sock',
			'token-1',
			target
		);
		await reserve();
	});

	it('retains replacement callbacks, config persistence and reporting under admission', async () => {
		await relay.preparePermissionRelayArgs(params);
		let observations = 0;
		for (const callback of [cleanups[0], vi.mocked(syncFs.unlinkSync), vi.mocked(logger.debug)]) {
			callback.mockImplementationOnce(() => {
				expect(synchronousHolds).toBeGreaterThan(0);
				observations++;
			});
		}
		vi.mocked(buildRelayArgs).mockImplementationOnce(() => {
			expect(synchronousHolds).toBeGreaterThan(0);
			observations++;
			return { args, configPath: 'owned-config' };
		});
		await expect(relay.preparePermissionRelayArgs(params)).resolves.toBe(args);
		expect(observations).toBe(4);
		expect(cleanups[0]).toHaveBeenCalledOnce();
		await reserve();
	});

	it.each(['path', 'startup', 'binding', 'config', 'reporting'] as const)(
		'releases setup on %s failure without changing the original error',
		async (step) => {
			const error = new Error(`${step} failed`);
			if (step === 'path')
				vi.mocked(resolveBridgeScriptPath).mockImplementationOnce(() => {
					throw error;
				});
			if (step === 'startup') vi.mocked(server.ensureStarted).mockRejectedValueOnce(error);
			if (step === 'binding')
				vi.mocked(registerSpawn).mockImplementationOnce(() => {
					throw error;
				});
			if (step === 'config')
				vi.mocked(buildRelayArgs).mockImplementationOnce(() => {
					throw error;
				});
			if (step === 'reporting')
				vi.mocked(logger.debug).mockImplementationOnce(() => {
					throw error;
				});
			await expect(relay.preparePermissionRelayArgs(params)).rejects.toBe(error);
			await reserve();
		}
	);

	it('preserves missing bridge failure before startup and releases for retry', async () => {
		vi.mocked(resolveBridgeScriptPath).mockReturnValueOnce(null);
		await expect(relay.preparePermissionRelayArgs(params)).rejects.toThrow(
			'bridge script not found'
		);
		expect(server.ensureStarted).not.toHaveBeenCalled();
		const hold = await reserve();
		hold.release();
		await expect(relay.preparePermissionRelayArgs(params)).resolves.toBe(args);
	});

	it('does not replace a previous binding when new startup fails', async () => {
		await relay.preparePermissionRelayArgs(params);
		vi.mocked(server.ensureStarted).mockRejectedValueOnce(new Error('start failed'));
		await expect(relay.preparePermissionRelayArgs(params)).rejects.toThrow('start failed');
		expect(cleanups[0]).not.toHaveBeenCalled();
		relay.cleanupSessionRelay(params.sessionId);
		expect(cleanups[0]).toHaveBeenCalledOnce();
		await reserve();
	});

	it.each([target, path.join(target, 'descendant'), path.resolve('other-repository')])(
		'refuses cleanup before binding removal under %s, allowing later retry',
		async (root) => {
			await relay.preparePermissionRelayArgs(params);
			const hold = await reserve(root);
			expect(() => relay.cleanupSessionRelay(params.sessionId)).toThrow(/reserved/);
			expect(cleanups[0]).not.toHaveBeenCalled();
			expect(syncFs.unlinkSync).not.toHaveBeenCalled();
			hold.release();
			expect(relay.cleanupSessionRelay(params.sessionId)).toBeUndefined();
			expect(cleanups[0]).toHaveBeenCalledOnce();
			expect(syncFs.unlinkSync).toHaveBeenCalledExactlyOnceWith('owned-config');
		}
	);

	it('refuses even absent-session cleanup without inspecting state', async () => {
		await reserve();
		expect(() => relay.cleanupSessionRelay('missing')).toThrow(/reserved/);
	});

	it('holds cleanup through registry and unlink callbacks including reentrant cleanup', async () => {
		await relay.preparePermissionRelayArgs(params);
		let observations = 0;
		cleanups[0].mockImplementation(() => {
			expect(synchronousHolds).toBeGreaterThan(0);
			observations++;
			relay.cleanupSessionRelay(params.sessionId);
		});
		vi.mocked(syncFs.unlinkSync).mockImplementationOnce(() => {
			expect(synchronousHolds).toBeGreaterThan(0);
			observations++;
		});
		expect(relay.cleanupSessionRelay(params.sessionId)).toBeUndefined();
		expect(observations).toBe(2);
		expect(cleanups[0]).toHaveBeenCalledOnce();
		await reserve();
	});

	it.each(['registry', 'unlink'] as const)(
		'preserves %s cleanup failure behavior and releases',
		async (step) => {
			await relay.preparePermissionRelayArgs(params);
			const error = new Error('cleanup failed');
			if (step === 'registry') {
				cleanups[0].mockImplementationOnce(() => {
					throw error;
				});
				expect(() => relay.cleanupSessionRelay(params.sessionId)).toThrow(error);
				expect(syncFs.unlinkSync).not.toHaveBeenCalled();
			} else {
				vi.mocked(syncFs.unlinkSync).mockImplementationOnce(() => {
					throw error;
				});
				expect(relay.cleanupSessionRelay(params.sessionId)).toBeUndefined();
			}
			relay.cleanupSessionRelay(params.sessionId);
			expect(cleanups[0]).toHaveBeenCalledOnce();
			await reserve();
		}
	);

	it('keeps concurrent starts independently busy until both settle', async () => {
		const one = Promise.withResolvers<string>();
		const two = Promise.withResolvers<string>();
		vi.mocked(server.ensureStarted)
			.mockReturnValueOnce(one.promise)
			.mockReturnValueOnce(two.promise);
		const first = relay.preparePermissionRelayArgs(params);
		const second = relay.preparePermissionRelayArgs(params);
		one.resolve('/relay.sock');
		await first;
		await blocked();
		two.resolve('/relay.sock');
		await second;
		expect(cleanups[0]).toHaveBeenCalledOnce();
		await reserve();
	});

	it('guards the independently registered native exit cleanup callback', async () => {
		const manager = new EventEmitter();
		relay.initPermissionRelay(() => null, manager);
		await relay.preparePermissionRelayArgs(params);
		const hold = await reserve();
		expect(() => manager.emit('exit', params.sessionId)).toThrow(/reserved/);
		expect(cleanups[0]).not.toHaveBeenCalled();
		hold.release();
		manager.emit('exit', params.sessionId);
		expect(cleanups[0]).toHaveBeenCalledOnce();
		await reserve();
	});

	it.each([true, false])(
		'keeps outer setup and native close independent, closeFirst=%s',
		async (closeFirst) => {
			const child = new EventEmitter();
			vi.mocked(spawn).mockReturnValueOnce(child as ReturnType<typeof spawn>);
			const { withWorktreeTurnActivity } = await import('../../../main/git/worktreeTurnActivity');
			const startup = Promise.withResolvers<string>();
			vi.mocked(server.ensureStarted).mockImplementationOnce(() => {
				withWorktreeTurnActivity(
					(_start, _observe, spawnChild) => spawnChild('agent', [], {}),
					() => {}
				);
				return startup.promise;
			});
			const request = relay.preparePermissionRelayArgs(params);
			child.emit('exit', 0);
			if (closeFirst) child.emit('close', 0);
			await blocked();
			startup.resolve('/relay.sock');
			await request;
			if (!closeFirst) {
				await blocked();
				child.emit('close', 0);
			}
			await drain();
			await reserve();
		}
	);
});
