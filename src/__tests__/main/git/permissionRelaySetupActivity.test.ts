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
import type { BrowserWindow } from 'electron';
import { logger } from '../../../main/utils/logger';
import { createSafeSend } from '../../../main/utils/safe-send';
import { permissionRelayServer as server } from '../../../main/permission-relay/PermissionRelayServer';
import {
	registerSpawn,
	resolvePending,
	subscribePendingPermissions,
} from '../../../main/permission-relay/registry';
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
		vi.mocked(logger.warn).mockReset();
		vi.mocked(createSafeSend).mockReset().mockReturnValue(vi.fn());
		vi.mocked(server.setOnRequest).mockReset();
		vi.mocked(subscribePendingPermissions).mockReset();
		vi.mocked(resolvePending).mockReset();
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
		'preserves %s cleanup failure behavior and retries registry cleanup',
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
			expect(cleanups[0]).toHaveBeenCalledTimes(step === 'registry' ? 2 : 1);
			await reserve();
		}
	);

	it.each(['explicit', 'exit', 'replacement'] as const)(
		'retries failed registry cleanup through %s without losing its owner',
		async (route) => {
			const manager = new EventEmitter();
			relay.initPermissionRelay(() => null, manager);
			await relay.preparePermissionRelayArgs(params);
			const error = new Error('registry cleanup failed');
			cleanups[0].mockImplementationOnce(() => {
				throw error;
			});
			expect(() => relay.cleanupSessionRelay(params.sessionId)).toThrow(error);
			expect(syncFs.unlinkSync).not.toHaveBeenCalled();
			if (route === 'explicit') relay.cleanupSessionRelay(params.sessionId);
			if (route === 'exit') manager.emit('exit', params.sessionId);
			if (route === 'replacement') await relay.preparePermissionRelayArgs(params);
			expect(cleanups[0]).toHaveBeenCalledTimes(2);
			expect(syncFs.unlinkSync).toHaveBeenCalledTimes(1);
			if (route === 'replacement') relay.cleanupSessionRelay(params.sessionId);
			relay.cleanupSessionRelay(params.sessionId);
			expect(cleanups[0]).toHaveBeenCalledTimes(2);
			await reserve();
		}
	);

	it('retains the outer owner when reentrant cleanup returns before an error', async () => {
		await relay.preparePermissionRelayArgs(params);
		const error = new Error('outer cleanup failed');
		cleanups[0].mockImplementationOnce(() => {
			relay.cleanupSessionRelay(params.sessionId);
			throw error;
		});
		expect(() => relay.cleanupSessionRelay(params.sessionId)).toThrow(error);
		expect(cleanups[0]).toHaveBeenCalledOnce();
		expect(syncFs.unlinkSync).not.toHaveBeenCalled();
		relay.cleanupSessionRelay(params.sessionId);
		expect(cleanups[0]).toHaveBeenCalledTimes(2);
		expect(syncFs.unlinkSync).toHaveBeenCalledOnce();
		await reserve();
	});

	it('refuses retry under reservation and preserves it until later admission', async () => {
		await relay.preparePermissionRelayArgs(params);
		cleanups[0].mockImplementationOnce(() => {
			throw new Error('retry needed');
		});
		expect(() => relay.cleanupSessionRelay(params.sessionId)).toThrow('retry needed');
		const hold = await reserve(path.resolve('other-repository'));
		expect(() => relay.cleanupSessionRelay(params.sessionId)).toThrow(/reserved/);
		expect(cleanups[0]).toHaveBeenCalledOnce();
		hold.release();
		relay.cleanupSessionRelay(params.sessionId);
		expect(cleanups[0]).toHaveBeenCalledTimes(2);
		await reserve();
	});

	it('stops replacement before new registration or config writes until prior cleanup succeeds', async () => {
		await relay.preparePermissionRelayArgs(params);
		const error = new Error('prior cleanup failed');
		cleanups[0].mockImplementationOnce(() => {
			throw error;
		});
		await expect(relay.preparePermissionRelayArgs(params)).rejects.toBe(error);
		expect(registerSpawn).toHaveBeenCalledOnce();
		expect(buildRelayArgs).toHaveBeenCalledOnce();
		await relay.preparePermissionRelayArgs(params);
		expect(cleanups[0]).toHaveBeenCalledTimes(2);
		expect(registerSpawn).toHaveBeenCalledTimes(2);
	});

	it.each(['explicit', 'exit', 'replacement'] as const)(
		'keeps known binding cleanup reachable after argument failure for %s',
		async (route) => {
			const manager = new EventEmitter();
			relay.initPermissionRelay(() => null, manager);
			const error = new Error('argument construction failed');
			vi.mocked(buildRelayArgs).mockImplementationOnce(() => {
				throw error;
			});
			await expect(relay.preparePermissionRelayArgs(params)).rejects.toBe(error);
			expect(cleanups[0]).not.toHaveBeenCalled();
			if (route === 'explicit') relay.cleanupSessionRelay(params.sessionId);
			if (route === 'exit') manager.emit('exit', params.sessionId);
			if (route === 'replacement') await relay.preparePermissionRelayArgs(params);
			expect(cleanups[0]).toHaveBeenCalledOnce();
			expect(syncFs.unlinkSync).not.toHaveBeenCalled();
		}
	);

	it('keeps concurrent replacement starts from overwriting a failed cleanup owner', async () => {
		await relay.preparePermissionRelayArgs(params);
		const pending = Promise.withResolvers<string>();
		vi.mocked(server.ensureStarted).mockReturnValueOnce(pending.promise);
		const waiting = relay.preparePermissionRelayArgs(params);
		cleanups[0].mockImplementationOnce(() => {
			throw new Error('prior cleanup failed');
		});
		await expect(relay.preparePermissionRelayArgs(params)).rejects.toThrow('prior cleanup failed');
		await blocked();
		expect(registerSpawn).toHaveBeenCalledOnce();
		pending.resolve('/relay.sock');
		await expect(waiting).resolves.toBe(args);
		expect(cleanups[0]).toHaveBeenCalledTimes(2);
		expect(registerSpawn).toHaveBeenCalledTimes(2);
	});

	it.each([false, true])(
		'keeps reentrant argument-construction cleanup reachable after setup (failure: %s)',
		async (fail) => {
			vi.mocked(buildRelayArgs).mockImplementationOnce(() => {
				relay.cleanupSessionRelay(params.sessionId);
				expect(cleanups[0]).not.toHaveBeenCalled();
				if (fail) throw new Error('argument failure');
				return { args, configPath: 'owned-config' };
			});
			const startup = relay.preparePermissionRelayArgs(params);
			if (fail) await expect(startup).rejects.toThrow('argument failure');
			else await expect(startup).resolves.toBe(args);
			relay.cleanupSessionRelay(params.sessionId);
			expect(cleanups[0]).toHaveBeenCalledOnce();
			expect(syncFs.unlinkSync).toHaveBeenCalledTimes(fail ? 0 : 1);
		}
	);

	it('keeps real registry binding busy after argument failure until known-binding cleanup', async () => {
		const registry = await vi.importActual<
			typeof import('../../../main/permission-relay/registry')
		>('../../../main/permission-relay/registry');
		vi.mocked(registerSpawn).mockImplementation(registry.registerSpawn);
		vi.mocked(buildRelayArgs).mockImplementationOnce(() => {
			throw new Error('argument failure');
		});
		await expect(relay.preparePermissionRelayArgs(params)).rejects.toThrow('argument failure');
		const token = vi.mocked(buildRelayArgs).mock.calls[0][3];
		expect(registry.lookupBinding(token)).toMatchObject({ sessionId: params.sessionId });
		await blocked();
		relay.cleanupSessionRelay(params.sessionId);
		expect(registry.lookupBinding(token)).toBeUndefined();
		expect(syncFs.unlinkSync).not.toHaveBeenCalled();
		await reserve();
	});

	it('retains real registry activity after native-exit cleanup fails and releases only on retry', async () => {
		const registry = await vi.importActual<
			typeof import('../../../main/permission-relay/registry')
		>('../../../main/permission-relay/registry');
		vi.mocked(registerSpawn).mockImplementation((binding) => {
			const result = registry.registerSpawn(binding);
			const cleanup = vi.fn(result.cleanup);
			cleanups.push(cleanup);
			return { ...result, cleanup };
		});
		const manager = new EventEmitter();
		relay.initPermissionRelay(() => null, manager);
		await relay.preparePermissionRelayArgs(params);
		const token = vi.mocked(buildRelayArgs).mock.calls[0][3];
		const decision = registry.createPending('request', token);
		const error = new Error('notification failed');
		const listener = vi.fn(() => {
			relay.cleanupSessionRelay(params.sessionId);
			throw error;
		});
		const unsubscribe = registry.subscribePendingPermissions(listener);
		expect(() => manager.emit('exit', params.sessionId)).toThrow(error);
		await expect(decision).resolves.toMatchObject({ behavior: 'deny' });
		unsubscribe();
		expect(registry.lookupBinding(token)).toBeUndefined();
		await blocked();
		expect(syncFs.unlinkSync).not.toHaveBeenCalled();
		expect(cleanups[0]).toHaveBeenCalledOnce();
		relay.cleanupSessionRelay(params.sessionId);
		expect(cleanups[0]).toHaveBeenCalledTimes(2);
		expect(syncFs.unlinkSync).toHaveBeenCalledOnce();
		await reserve();
	});

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

	describe('initialization and retained forwarding callbacks', () => {
		const snapshot = { version: 1, processIds: ['agent-ai'] };
		const request = {
			requestId: 'request',
			token: 'private-token',
			sessionId: 'agent-ai',
			toolName: 'Bash',
			input: { command: 'pwd' },
			createdAt: 1,
		};
		function initialize() {
			const send = vi.fn();
			const win = {
				isDestroyed: vi.fn(() => false),
				webContents: { isDestroyed: vi.fn(() => false), send },
			};
			const getWindow = vi.fn(() => win as unknown as BrowserWindow | null);
			relay.initPermissionRelay(getWindow, null);
			return {
				win,
				getWindow,
				send,
				forward: vi.mocked(server.setOnRequest).mock.calls[0][0],
				publish: vi.mocked(subscribePendingPermissions).mock.calls[0][0],
				broadcast: vi.mocked(createSafeSend).mock.results[0].value as ReturnType<typeof vi.fn>,
			};
		}

		it.each([target, path.join(target, 'child'), path.resolve('other-repository')])(
			'refuses initialization before state or registration changes under %s and permits retry',
			async (root) => {
				const hold = await reserve(root);
				expect(() => relay.initPermissionRelay(() => null, null)).toThrow(/reserved/);
				for (const effect of [createSafeSend, subscribePendingPermissions, server.setOnRequest])
					expect(effect).not.toHaveBeenCalled();
				hold.release();
				initialize();
				expect(server.setOnRequest).toHaveBeenCalledOnce();
				await reserve();
			}
		);

		it('admits while canonicalization is pending and holds through reentrant registration setup', async () => {
			const canonical = Promise.withResolvers<string>();
			vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
			const reservation = gate.reserveWorktreeCleanup(target);
			const manager = new EventEmitter();
			const on = vi.spyOn(manager, 'on');
			for (const setup of [
				vi.mocked(createSafeSend),
				vi.mocked(subscribePendingPermissions),
				vi.mocked(server.setOnRequest),
				on,
			]) {
				setup.mockImplementationOnce((..._args: unknown[]) => {
					expect(synchronousHolds).toBe(1);
					relay.initPermissionRelay(() => null, null);
					expect(synchronousHolds).toBe(1);
					return vi.fn() as never;
				});
			}
			relay.initPermissionRelay(() => null, manager);
			canonical.resolve(target);
			const hold = await reservation;
			if (hold.status === 'reserved-partially') releases.push(hold.release);
			// Synchronous initialization has completed before the reservation resumes.
			expect(hold.status).toBe('reserved-partially');
			expect(on).toHaveBeenCalledExactlyOnceWith('exit', expect.any(Function));
		});

		it('requires admission even for initialized no-ops without replacing callbacks', async () => {
			initialize();
			const hold = await reserve();
			expect(() => relay.initPermissionRelay(() => null, null)).toThrow(/reserved/);
			hold.release();
			relay.initPermissionRelay(() => null, null);
			expect(createSafeSend).toHaveBeenCalledOnce();
			expect(server.setOnRequest).toHaveBeenCalledOnce();
		});

		it.each(['safe-send', 'subscription', 'server', 'emitter'])(
			'preserves the original %s setup error and failure latch, releasing admission',
			async (step) => {
				const error = new Error(step);
				const manager = new EventEmitter();
				const effect =
					step === 'safe-send'
						? vi.mocked(createSafeSend)
						: step === 'subscription'
							? vi.mocked(subscribePendingPermissions)
							: step === 'server'
								? vi.mocked(server.setOnRequest)
								: vi.spyOn(manager, 'on');
				effect.mockImplementationOnce(() => {
					expect(synchronousHolds).toBe(1);
					throw error;
				});
				expect(() => relay.initPermissionRelay(() => null, manager)).toThrow(error);
				const hold = await reserve();
				hold.release();
				relay.initPermissionRelay(() => null, manager);
				expect(createSafeSend).toHaveBeenCalledOnce();
			}
		);

		it.each(['status', 'request'] as const)(
			'refuses retained %s callbacks before delivery/inspection and permits retry',
			async (kind) => {
				const fixture = initialize();
				const hold = await reserve();
				expect(() =>
					kind === 'status' ? fixture.publish(snapshot) : fixture.forward(request)
				).toThrow(/reserved/);
				expect(fixture.getWindow).not.toHaveBeenCalled();
				expect(fixture.broadcast).not.toHaveBeenCalled();
				expect(resolvePending).not.toHaveBeenCalled();
				hold.release();
				if (kind === 'status') {
					fixture.publish(snapshot);
					expect(fixture.broadcast).toHaveBeenCalledExactlyOnceWith(
						'process:pending-permissions',
						snapshot
					);
				} else {
					fixture.forward(request);
					expect(fixture.send).toHaveBeenCalledExactlyOnceWith(
						relay.PERMISSION_REQUEST_CHANNEL,
						request
					);
				}
				await reserve();
			}
		);

		it('holds each nested forwarding callback through lookup, delivery and broadcast', async () => {
			const fixture = initialize();
			fixture.getWindow.mockImplementationOnce(() => {
				expect(synchronousHolds).toBe(1);
				return fixture.win as unknown as BrowserWindow;
			});
			fixture.broadcast.mockImplementationOnce(() => {
				expect(synchronousHolds).toBe(2);
			});
			fixture.send.mockImplementationOnce(() => {
				expect(synchronousHolds).toBe(1);
				fixture.publish(snapshot);
				expect(synchronousHolds).toBe(1);
			});
			fixture.forward(request);
			await reserve();
		});

		it.each(['absent', 'window-destroyed', 'contents-destroyed', 'send-failed'])(
			'holds %s denial and reporting with unchanged decisions',
			async (state) => {
				const fixture = initialize();
				if (state === 'absent') fixture.getWindow.mockReturnValueOnce(null);
				if (state === 'window-destroyed') fixture.win.isDestroyed.mockReturnValueOnce(true);
				if (state === 'contents-destroyed')
					fixture.win.webContents.isDestroyed.mockReturnValueOnce(true);
				if (state === 'send-failed')
					fixture.send.mockImplementationOnce(() => {
						throw new Error('delivery');
					});
				vi.mocked(logger.warn).mockImplementationOnce(() => {
					expect(synchronousHolds).toBe(1);
				});
				vi.mocked(resolvePending).mockImplementationOnce(() => {
					expect(synchronousHolds).toBe(1);
					return true;
				});
				fixture.forward(request);
				expect(resolvePending).toHaveBeenCalledExactlyOnceWith('request', {
					behavior: 'deny',
					message:
						state === 'send-failed'
							? 'Failed to deliver permission request to the Maestro window.'
							: 'Maestro window unavailable to prompt for permission.',
				});
				await reserve();
			}
		);

		it.each(['lookup', 'broadcast', 'reporting', 'denial'])(
			'releases forwarding on %s failure without replacing the original error',
			async (step) => {
				const fixture = initialize();
				const error = new Error(step);
				const fail = () => {
					expect(synchronousHolds).toBeGreaterThan(0);
					throw error;
				};
				if (step === 'lookup') fixture.getWindow.mockImplementationOnce(fail);
				if (step === 'broadcast') fixture.broadcast.mockImplementationOnce(fail);
				if (step === 'reporting') {
					fixture.send.mockImplementationOnce(fail);
					vi.mocked(logger.warn).mockImplementationOnce(fail);
				}
				if (step === 'denial') {
					fixture.getWindow.mockReturnValueOnce(null);
					vi.mocked(resolvePending).mockImplementationOnce(fail);
				}
				expect(() =>
					step === 'broadcast' ? fixture.publish(snapshot) : fixture.forward(request)
				).toThrow(error);
				await reserve();
			}
		);

		it('keeps a native child busy after synchronous forwarding has returned', async () => {
			const fixture = initialize();
			const child = new EventEmitter();
			vi.mocked(spawn).mockReturnValueOnce(child as ReturnType<typeof spawn>);
			const { withWorktreeTurnActivity } = await import('../../../main/git/worktreeTurnActivity');
			fixture.send.mockImplementationOnce(() => {
				withWorktreeTurnActivity(
					(_start, _observe, spawnChild) => spawnChild('agent', [], {}),
					() => {}
				);
			});
			fixture.forward(request);
			child.emit('exit', 0);
			await blocked();
			child.emit('close', 0);
			await drain();
			await reserve();
		});
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
