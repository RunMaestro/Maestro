import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { ipcMain } from 'electron';
import type { ProcessHandlerDependencies } from '../../../main/ipc/handlers/process';
import type { HarnessInteractionOpenRequest } from '../../../shared/harness-control/types';
import interactionFixture from '../../fixtures/harness-control/interactions.json';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));
vi.mock('fs/promises', () => ({ default: { realpath: vi.fn() } }));
vi.mock('child_process', async (importOriginal) => ({
	...(await importOriginal<typeof import('child_process')>()),
	spawn: vi.fn(),
}));
vi.mock('../../../main/plugins/relay-conversations', () => ({
	cancelRelayConversationTurn: vi.fn(),
}));
vi.mock('../../../main/permission-relay/registry', () => ({}));
vi.mock('../../../main/utils/headless-agent-activity', () => ({}));
vi.mock('../../../main/utils/sentry', () => ({ addBreadcrumb: vi.fn() }));
vi.mock('../../../main/utils/safe-send', () => ({}));
vi.mock('../../../main/process-manager/utils/childProcessInfo', () => ({}));
vi.mock('../../../main/concerto-html', () => ({}));
vi.mock('../../../main/ipc/handlers/process/handle-spawn', () => ({
	cancelPendingDesktopSpawns: vi.fn(),
}));
vi.mock('../../../main/permission-relay', () => ({
	initPermissionRelay: vi.fn(),
	resolvePermissionResponse: vi.fn(),
}));
vi.mock('../../../main/harness-control/integration', () => ({
	initHarnessControl: vi.fn(),
	resolveHarnessInteractionResponse: vi.fn(),
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../main/utils/cliDetection', () => ({
	resolveSshPath: vi.fn(async () => 'ssh'),
	getExpandedEnv: vi.fn(() => ({})),
}));
vi.mock('../../../main/process-manager/utils/commandKill', () => ({
	killProcessTreeNow: vi.fn(),
}));

import { logger } from '../../../main/utils/logger';
import { addBreadcrumb } from '../../../main/utils/sentry';
import { cancelRelayConversationTurn } from '../../../main/plugins/relay-conversations';
import { cancelPendingDesktopSpawns } from '../../../main/ipc/handlers/process/handle-spawn';
import { resolvePermissionResponse } from '../../../main/permission-relay';
import { resolveHarnessInteractionResponse } from '../../../main/harness-control/integration';

describe('process cancellation and control IPC activity', () => {
	const target = path.resolve('process-cancellation-target');
	const operations = ['interrupt', 'kill', 'cancelCommand'] as const;
	const responses = ['permission:respond', 'harnessControl:respond'] as const;
	type Response = (typeof responses)[number];
	type Operation = (typeof operations)[number];
	const inputOperations = ['write', 'steer', 'resize'] as const;
	type InputOperation = (typeof inputOperations)[number];
	type ControlOperation = InputOperation | 'closeAgent';
	type Handler = (event: unknown, ...args: unknown[]) => unknown;
	let gate: typeof import('../../../main/git/worktreeActivity');
	let releases: Array<() => void>;
	let active: number;
	let manager: Record<'get' | Operation | ControlOperation, ReturnType<typeof vi.fn>>;
	let deps: ProcessHandlerDependencies;
	const handler = (operation: Operation | ControlOperation | Response) =>
		vi
			.mocked(ipcMain.handle)
			.mock.calls.find(
				([name]) => name === (operation.includes(':') ? operation : `process:${operation}`)
			)![1] as Handler;
	const decision = { behavior: 'allow' as const };
	const response = { requestId: 'request', kind: 'permission', decision: 'allow' };
	const respond = (channel: Response, event: unknown = {}) =>
		handler(channel)(
			event,
			...(channel === 'permission:respond' ? ['request', decision] : [response])
		);
	const resolver = (channel: Response) =>
		channel === 'permission:respond'
			? vi.mocked(resolvePermissionResponse)
			: vi.mocked(resolveHarnessInteractionResponse);
	const run = (operation: Operation, event: unknown = {}) =>
		handler(operation)(event, operation === 'cancelCommand' ? { sessionId: 'session' } : 'session');
	const inputArgs = (op: ControlOperation): unknown[] =>
		op === 'closeAgent'
			? ['agent']
			: op === 'resize'
				? ['session', 120, 40]
				: ['session', 'input\n'];
	const control = (op: ControlOperation) => handler(op)({ clientId: 'bridge' }, ...inputArgs(op));
	async function reservation(root = target) {
		const hold = await gate.reserveWorktreeCleanup(root);
		if (hold.status === 'reserved-partially') releases.push(hold.release);
		return hold;
	}
	async function idle(root = target) {
		const hold = await reservation(root);
		expect(hold.status).toBe('reserved-partially');
		if (hold.status !== 'reserved-partially') throw new Error('Expected partial reservation');
		expect(hold.blockers.map((b) => b.message).join(' ')).toMatch(/native.*registration.*OS/);
		return hold;
	}
	const busy = async () =>
		expect(await reservation()).toMatchObject({
			status: 'blocked',
			blockers: [{ code: 'mutation-busy' }],
		});

	beforeEach(async () => {
		vi.resetModules();
		vi.resetAllMocks();
		releases = [];
		active = 0;
		vi.mocked(fs.realpath).mockImplementation(async (p) => String(p));
		manager = {
			get: vi.fn(() => ({})),
			interrupt: vi.fn(() => true),
			kill: vi.fn(() => true),
			cancelCommand: vi.fn(() => false),
			write: vi.fn(() => true),
			steer: vi.fn(async () => ({ verdict: 'sent' })),
			resize: vi.fn(() => false),
			closeAgent: vi.fn(),
		};
		deps = {
			getProcessManager: vi.fn(() => manager),
			getAgentDetector: () => null,
			getMainWindow: () => null,
			settingsStore: {},
			agentConfigsStore: {},
			sessionsStore: {},
			interactiveReplayController: { clearInteractiveReplay: vi.fn() },
		} as unknown as ProcessHandlerDependencies;
		gate = await import('../../../main/git/worktreeActivity');
		const admit = gate.beginGlobalWorktreeActivity;
		vi.spyOn(gate, 'beginGlobalWorktreeActivity').mockImplementation(() => {
			const release = admit();
			active++;
			let released = false;
			return () => {
				if (released) return;
				released = true;
				active--;
				release();
			};
		});
		const { registerProcessHandlers } = await import('../../../main/ipc/handlers/process');
		registerProcessHandlers(deps);
		vi.mocked(deps.getProcessManager).mockClear();
	});
	afterEach(() => {
		releases.forEach((release) => release());
		vi.restoreAllMocks();
	});

	describe('permission and harness responses', () => {
		it('keeps a real pending permission busy and admits its settlement subscribers', async () => {
			const registry = await vi.importActual<
				typeof import('../../../main/permission-relay/registry')
			>('../../../main/permission-relay/registry');
			const completion = registry.createPending('request', 'token');
			const notify = vi.fn(() => expect(active).toBeGreaterThan(0));
			const unsubscribe = registry.subscribePendingPermissions(notify);
			vi.mocked(resolvePermissionResponse).mockImplementation(registry.resolvePending);
			try {
				// A real pending decision now owns activity beyond setup, so a
				// cleanup reservation cannot be acquired before its response.
				await busy();
				expect(registry.relayRegistryStats().pending).toBe(1);
				expect(notify).not.toHaveBeenCalled();
				expect(respond('permission:respond')).toBe(true);
				await expect(completion).resolves.toBe(decision);
				expect(notify).toHaveBeenCalledTimes(1);
				expect(registry.relayRegistryStats().pending).toBe(0);
				await busy();
				unsubscribe();
				await idle();
			} finally {
				for (const release of releases) release();
				unsubscribe();
				registry.resolvePending('request', { behavior: 'deny', message: 'test cleanup' });
			}
		});
		it('keeps a real harness request busy until its admitted settlement broadcast completes', async () => {
			const { InteractionBroker } = await import('../../../main/harness-control/InteractionBroker');
			let duringBroadcast = 0;
			const broadcast = vi.fn(() => {
				duringBroadcast = active;
			});
			const broker = new InteractionBroker({ onRequest: () => true, onSettled: broadcast });
			const opened = broker.open(interactionFixture.permission as HarnessInteractionOpenRequest);
			const raw = { requestId: opened.request.requestId, outcome: 'selected', optionId: 'allow' };
			vi.mocked(resolveHarnessInteractionResponse).mockImplementation((value) =>
				broker.resolve(value)
			);
			try {
				// The broker owns pending work independently of the response IPC scope.
				await busy();
				expect(broker.pendingRequests()).toHaveLength(1);
				expect(broadcast).not.toHaveBeenCalled();
				expect(handler('harnessControl:respond')({}, raw)).toBe('resolved');
				await expect(opened.completion).resolves.toEqual({
					outcome: 'selected',
					optionId: 'allow',
				});
				expect(broadcast).toHaveBeenCalledTimes(1);
				expect(duringBroadcast).toBeGreaterThan(0);
				expect(broker.pendingRequests()).toHaveLength(0);
				await idle();
			} finally {
				for (const release of releases) release();
				broker.closeAll();
			}
		});
		it.each([target, path.join(target, 'child'), path.resolve('other-repository')])(
			'refuses responses before owner inspection, resolution or reporting under %s',
			async (root) => {
				await idle(root);
				const read = vi.fn();
				const event = new Proxy({}, { get: read });
				for (const channel of responses) expect(() => respond(channel, event)).toThrow(/reserved/);
				expect(read).not.toHaveBeenCalled();
				for (const work of [
					resolvePermissionResponse,
					resolveHarnessInteractionResponse,
					logger.error,
				])
					expect(work).not.toHaveBeenCalled();
			}
		);
		it.each(responses)(
			'holds %s callbacks and preserves synchronous result identity',
			async (channel) => {
				const result = channel === 'permission:respond' ? false : 'not-found';
				resolver(channel).mockImplementationOnce(() => {
					expect(active).toBe(1);
					return result as never;
				});
				expect(respond(channel)).toBe(result);
				expect(active).toBe(0);
				expect(logger.error).not.toHaveBeenCalled();
				await idle();
			}
		);
		it('preserves the permission request and decision arguments', () => {
			vi.mocked(resolvePermissionResponse).mockReturnValueOnce(true);
			expect(respond('permission:respond', { clientId: 'bridge' })).toBe(true);
			expect(resolvePermissionResponse).toHaveBeenCalledExactlyOnceWith('request', decision);
		});
		it.each([
			[{ sender: { id: 7 } }, { webContentsId: 7 }],
			[{ clientId: 'bridge', sender: { id: 7 } }, { bridgeClientId: 'bridge' }],
			[{ clientId: 42, sender: { id: 7 } }, { webContentsId: 7 }],
			[{}, { webContentsId: undefined }],
		])('preserves harness ownership for %j', (event, owner) => {
			vi.mocked(resolveHarnessInteractionResponse).mockReturnValueOnce('resolved');
			expect(respond('harnessControl:respond', event)).toBe('resolved');
			expect(resolveHarnessInteractionResponse).toHaveBeenCalledExactlyOnceWith(response, owner);
		});
		it('admits before owner getters and holds response inspection and settlement reporting', () => {
			const inspect = vi.fn(() => expect(active).toBe(1));
			const raw = {
				get requestId() {
					inspect();
					return 'request';
				},
			};
			vi.mocked(resolveHarnessInteractionResponse).mockImplementationOnce((value) => {
				expect((value as typeof raw).requestId).toBe('request');
				logger.debug('settled');
				return 'resolved';
			});
			vi.mocked(logger.debug).mockImplementationOnce(inspect);
			expect(
				handler('harnessControl:respond')(
					{
						get clientId() {
							inspect();
							return undefined;
						},
						get sender() {
							inspect();
							return { id: 7 };
						},
					},
					raw
				)
			).toBe('resolved');
			expect(inspect).toHaveBeenCalledTimes(4);
			expect(active).toBe(0);
		});
		it.each(responses)(
			'releases %s on synchronous callback/report failure without recovery',
			async (channel) => {
				const failure = Error('settlement failed');
				resolver(channel).mockImplementationOnce(() => {
					expect(active).toBe(1);
					throw failure;
				});
				expect(() => respond(channel)).toThrow(failure);
				expect(logger.error).not.toHaveBeenCalled();
				await idle();
			}
		);
		it('releases after owner lookup throws before invoking the broker', async () => {
			const failure = Error('owner failed');
			expect(() =>
				respond('harnessControl:respond', {
					get clientId() {
						expect(active).toBe(1);
						throw failure;
					},
				})
			).toThrow(failure);
			expect(resolveHarnessInteractionResponse).not.toHaveBeenCalled();
			await idle();
		});
		it('retains reentrant responses independently and releases the inner failure', async () => {
			const failure = Error('inner failed');
			vi.mocked(resolveHarnessInteractionResponse).mockImplementationOnce(() => {
				expect(active).toBe(2);
				throw failure;
			});
			vi.mocked(resolvePermissionResponse).mockImplementationOnce(() => {
				expect(() => respond('harnessControl:respond')).toThrow(failure);
				expect(active).toBe(1);
				return true;
			});
			expect(respond('permission:respond')).toBe(true);
			await idle();
		});
		it.each(responses)(
			'composes %s with pending reservation and independent resumed native work',
			async (channel) => {
				const canonical = Promise.withResolvers<string>();
				vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
				const hold = reservation();
				const native = new EventEmitter();
				vi.mocked(spawn).mockReturnValueOnce(native as unknown as ReturnType<typeof spawn>);
				const { withWorktreeTurnActivity } = await import('../../../main/git/worktreeTurnActivity');
				const settlement = Promise.withResolvers<void>();
				resolver(channel).mockImplementationOnce(() => {
					expect(active).toBe(1);
					withWorktreeTurnActivity((_start, observe, launch) => {
						observe(settlement.promise);
						launch('agent', [], {});
					}, vi.fn());
					canonical.resolve(target);
					return (channel === 'permission:respond' ? true : 'resolved') as never;
				});
				respond(channel);
				await expect(hold).resolves.toMatchObject({ status: 'blocked' });
				native.emit('exit', 0);
				await busy();
				native.emit('close', 0);
				await busy();
				settlement.resolve();
				await vi.waitFor(() => expect(active).toBe(0));
				await idle();
			}
		);
	});

	describe('input and control requests', () => {
		it.each([target, path.join(target, 'child'), path.resolve('other-repository')])(
			'refuses input and control before setup or reporting under %s',
			async (root) => {
				await idle(root);
				for (const op of inputOperations) await expect(control(op)).rejects.toThrow(/reserved/);
				expect(() => control('closeAgent')).toThrow(/reserved/);
				for (const work of [
					deps.getProcessManager,
					...Object.values(manager),
					logger.debug,
					logger.error,
				])
					expect(work).not.toHaveBeenCalled();
			}
		);
		it.each(['write', 'steer'] as const)('refuses %s before inspecting input', async (op) => {
			await idle();
			const read = vi.fn();
			await expect(handler(op)({}, 'session', new Proxy({}, { get: read }))).rejects.toThrow(
				/reserved/
			);
			expect(read).not.toHaveBeenCalled();
		});
		it.each(inputOperations)('preserves %s arguments and results while admitted', async (op) => {
			const value = op === 'steer' ? { verdict: 'refused', detail: 'finished' } : false;
			vi.mocked(deps.getProcessManager).mockImplementationOnce(() => {
				expect(active).toBe(1);
				return manager as unknown as ReturnType<ProcessHandlerDependencies['getProcessManager']>;
			});
			vi.mocked(logger.debug).mockImplementationOnce(() => expect(active).toBe(1));
			manager[op].mockImplementationOnce(() => {
				expect(active).toBe(1);
				return value;
			});
			await expect(control(op)).resolves.toBe(value);
			expect(manager[op]).toHaveBeenCalledExactlyOnceWith(...inputArgs(op));
			await idle();
		});
		it.each(inputOperations)(
			'holds %s manager failures through transparent reporting',
			async (op) => {
				const failure = Error('manager lookup failed');
				vi.mocked(deps.getProcessManager).mockImplementationOnce(() => {
					expect(active).toBe(1);
					throw failure;
				});
				vi.mocked(logger.error).mockImplementationOnce(() => expect(active).toBe(1));
				await expect(control(op)).rejects.toBe(failure);
				expect(manager[op]).not.toHaveBeenCalled();
				expect(logger.error).toHaveBeenCalledExactlyOnceWith(
					`${op} error`,
					expect.any(String),
					expect.any(Object)
				);
				await idle();
			}
		);
		it.each(['write', 'steer'] as const)(
			'holds %s input getters and releases after reporting failure',
			async (op) => {
				const input = {
					get length() {
						expect(active).toBe(1);
						return 6;
					},
				};
				await handler(op)({}, 'session', input);
				vi.mocked(logger.debug).mockImplementationOnce(() => {
					expect(active).toBe(1);
					throw Error('debug failed');
				});
				vi.mocked(logger.error).mockImplementationOnce(() => {
					expect(active).toBe(1);
					throw Error('report failed');
				});
				await expect(control(op)).rejects.toThrow('report failed');
				expect(manager[op]).toHaveBeenCalledTimes(1);
				await idle();
			}
		);
		it('admits steering before pending canonicalization and retains concurrent verdicts independently', async () => {
			const canonical = Promise.withResolvers<string>();
			vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
			const hold = reservation();
			const first = Promise.withResolvers<unknown>();
			const second = Promise.withResolvers<unknown>();
			manager.steer.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
			const one = control('steer');
			const two = control('steer');
			canonical.resolve(target);
			await expect(hold).resolves.toMatchObject({ status: 'blocked' });
			first.resolve({ verdict: 'sent' });
			await expect(one).resolves.toEqual({ verdict: 'sent' });
			await busy();
			vi.mocked(logger.error).mockImplementationOnce(() => expect(active).toBe(1));
			const failure = Error('steering rejected');
			second.reject(failure);
			await expect(two).rejects.toBe(failure);
			await idle();
		});
		it.each(inputOperations)(
			'releases %s after missing manager or nested callback failure',
			async (op) => {
				vi.mocked(deps.getProcessManager).mockReturnValueOnce(null);
				await expect(control(op)).rejects.toThrow('Process manager not initialized');
				expect(manager[op]).not.toHaveBeenCalled();
				(await idle()).release();
				const failure = Error('control failed');
				manager[op].mockImplementationOnce(() => {
					expect(active).toBe(1);
					throw failure;
				});
				await expect(control(op)).rejects.toBe(failure);
				await idle();
			}
		);
		it('preserves synchronous closeAgent success and holds manager access and callbacks', async () => {
			vi.mocked(deps.getProcessManager).mockImplementationOnce(() => {
				expect(active).toBe(1);
				return manager as unknown as ReturnType<ProcessHandlerDependencies['getProcessManager']>;
			});
			manager.closeAgent.mockImplementationOnce(() => expect(active).toBe(1));
			expect(control('closeAgent')).toBe(true);
			expect(manager.closeAgent).toHaveBeenCalledExactlyOnceWith('agent');
			expect(logger.error).not.toHaveBeenCalled();
			await idle();
		});
		it.each(['manager', 'callback'] as const)(
			'preserves synchronous closeAgent %s failure without logging',
			async (stage) => {
				const failure = Error(stage);
				const fail = () => {
					expect(active).toBe(1);
					throw failure;
				};
				if (stage === 'manager') vi.mocked(deps.getProcessManager).mockImplementationOnce(fail);
				else manager.closeAgent.mockImplementationOnce(fail);
				expect(() => control('closeAgent')).toThrow(failure);
				expect(logger.error).not.toHaveBeenCalled();
				await idle();
			}
		);
		it('retains steering result assimilation and error serialization after nested settlement', async () => {
			manager.steer.mockReturnValueOnce({
				then(resolve: (value: unknown) => void) {
					expect(active).toBe(1);
					resolve({ verdict: 'sent' });
				},
			});
			await control('steer');
			const failure = Object.defineProperty(Error('steer failed'), 'stack', {
				get() {
					expect(active).toBe(1);
					return 'stack';
				},
			});
			manager.steer.mockRejectedValueOnce(failure);
			vi.mocked(logger.error).mockImplementationOnce(() => expect(active).toBe(1));
			await expect(control('steer')).rejects.toBe(failure);
			await idle();
		});
		it('composes IPC completion with independent native close and buffered-write acknowledgement', async () => {
			const native = Object.assign(new EventEmitter(), {
				stdout: new EventEmitter(),
				stderr: new EventEmitter(),
			});
			vi.mocked(spawn).mockReturnValue(native as unknown as ReturnType<typeof spawn>);
			const { withWorktreeTurnActivity } = await import('../../../main/git/worktreeTurnActivity');
			const buffered = Promise.withResolvers<void>();
			manager.write.mockImplementationOnce(() =>
				withWorktreeTurnActivity((_start, observe, launch) => {
					launch('agent', [], {});
					observe(buffered.promise);
					return true;
				}, vi.fn())
			);
			await expect(control('write')).resolves.toBe(true);
			native.emit('exit', 0);
			await busy();
			native.emit('close', 0);
			await busy();
			buffered.resolve();
			await vi.waitFor(() => expect(active).toBe(0));
			await idle();
		});
		it('does not release pending steering when an independent native scope closes first', async () => {
			const native = new EventEmitter();
			const { withWorktreeTurnActivity } = await import('../../../main/git/worktreeTurnActivity');
			vi.mocked(spawn).mockReturnValue(native as unknown as ReturnType<typeof spawn>);
			withWorktreeTurnActivity((_start, _observe, launch) => launch('agent', [], {}), vi.fn());
			const verdict = Promise.withResolvers<unknown>();
			manager.steer.mockReturnValueOnce(verdict.promise);
			const pending = control('steer');
			native.emit('close', 0);
			await busy();
			verdict.resolve({ verdict: 'sent' });
			await pending;
			await idle();
		});
	});

	it.each([target, path.join(target, 'child'), path.resolve('other-repository')])(
		'refuses cancellation before setup or recovery under %s',
		async (root) => {
			await idle(root);
			for (const operation of operations) await expect(run(operation)).rejects.toThrow(/reserved/);
			for (const work of [
				deps.getProcessManager,
				manager.get,
				...operations.map((op) => manager[op]),
				cancelPendingDesktopSpawns,
				cancelRelayConversationTurn,
				deps.interactiveReplayController!.clearInteractiveReplay,
				addBreadcrumb,
				logger.info,
				logger.debug,
				logger.error,
			])
				expect(work).not.toHaveBeenCalled();
		}
	);
	it('refuses before cancelCommand configuration access', async () => {
		await idle();
		const read = vi.fn();
		await expect(handler('cancelCommand')({}, new Proxy({}, { get: read }))).rejects.toThrow(
			/reserved/
		);
		expect(read).not.toHaveBeenCalled();
	});
	it('admits before pending reservation canonicalization and holds across diagnostics', async () => {
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const hold = reservation();
		const diagnostic = Promise.withResolvers<void>();
		vi.mocked(addBreadcrumb).mockReturnValueOnce(diagnostic.promise);
		const pending = run('kill');
		canonical.resolve(target);
		await expect(hold).resolves.toMatchObject({ status: 'blocked' });
		await busy();
		expect(manager.kill).not.toHaveBeenCalled();
		diagnostic.resolve();
		await expect(pending).resolves.toBe(true);
		await idle();
	});
	it('retains concurrent kill requests independently through diagnostic settlement', async () => {
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		vi.mocked(addBreadcrumb).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const one = run('kill');
		const two = run('kill');
		first.resolve();
		await one;
		await busy();
		second.resolve();
		await two;
		await idle();
	});
	it.each(operations)(
		'admits %s before manager access, result inspection and error reporting',
		async (op) => {
			const failure = Error('manager unavailable');
			vi.mocked(deps.getProcessManager).mockImplementationOnce(() => {
				expect(active).toBe(1);
				throw failure;
			});
			vi.mocked(logger.error).mockImplementationOnce(() => expect(active).toBe(1));
			await expect(run(op)).rejects.toBe(failure);
			expect(logger.error).toHaveBeenCalledWith(
				`${op} error`,
				expect.any(String),
				expect.any(Object)
			);
			await idle();
		}
	);
	it.each(['interrupt', 'kill'] as const)(
		'preserves %s pending-start and Relay short-circuit cancellation',
		async (op) => {
			manager.get.mockReturnValue(undefined);
			vi.mocked(cancelPendingDesktopSpawns).mockImplementationOnce(() => {
				expect(active).toBe(1);
				return true;
			});
			await expect(run(op)).resolves.toBe(true);
			expect(cancelRelayConversationTurn).not.toHaveBeenCalled();
			vi.mocked(cancelRelayConversationTurn).mockImplementationOnce(() => {
				expect(active).toBe(1);
				return true;
			});
			await expect(run(op)).resolves.toBe(true);
			expect(manager[op]).not.toHaveBeenCalled();
			expect(addBreadcrumb).not.toHaveBeenCalled();
			expect(deps.interactiveReplayController!.clearInteractiveReplay).not.toHaveBeenCalled();
			await idle();
		}
	);
	it.each(['pending', 'relay', 'replay', 'breadcrumb', 'kill'])(
		'holds kill through %s failure and skips later recovery',
		async (stage) => {
			const fail = () => {
				expect(active).toBe(1);
				throw Error(stage);
			};
			if (stage === 'pending' || stage === 'relay') manager.get.mockReturnValue(undefined);
			if (stage === 'pending') vi.mocked(cancelPendingDesktopSpawns).mockImplementationOnce(fail);
			if (stage === 'relay') vi.mocked(cancelRelayConversationTurn).mockImplementationOnce(fail);
			if (stage === 'replay')
				vi.mocked(deps.interactiveReplayController!.clearInteractiveReplay).mockImplementationOnce(
					fail
				);
			if (stage === 'breadcrumb')
				vi.mocked(addBreadcrumb).mockImplementationOnce(async () => fail());
			if (stage === 'kill') manager.kill.mockImplementationOnce(fail);
			vi.mocked(logger.error).mockImplementationOnce(() => expect(active).toBe(1));
			await expect(run('kill')).rejects.toThrow(stage);
			if (stage !== 'kill') expect(manager.kill).not.toHaveBeenCalled();
			await idle();
		}
	);
	it.each(operations)('preserves %s false result and bridge arguments', async (op) => {
		manager[op].mockReturnValueOnce(false);
		await expect(run(op, { clientId: 'bridge' })).resolves.toBe(false);
		expect(manager[op]).toHaveBeenCalledWith('session');
		await idle();
	});
	it('holds cancelCommand result getters and reporting, releasing after reporting throws', async () => {
		await expect(
			handler('cancelCommand')(
				{},
				{
					get sessionId() {
						expect(active).toBe(1);
						return 'session';
					},
				}
			)
		).resolves.toBe(false);
		vi.mocked(logger.debug).mockImplementationOnce(() => {
			expect(active).toBe(1);
			throw Error('report failed');
		});
		vi.mocked(logger.error).mockImplementationOnce(() => expect(active).toBe(1));
		await expect(run('cancelCommand')).rejects.toThrow('report failed');
		await idle();
	});
	it('releases after diagnostic rejection and preserves the original error', async () => {
		const diagnostic = Promise.withResolvers<void>();
		vi.mocked(addBreadcrumb).mockReturnValueOnce(diagnostic.promise);
		const pending = run('kill');
		await busy();
		const failure = Error('diagnostic rejected');
		diagnostic.reject(failure);
		await expect(pending).rejects.toBe(failure);
		expect(manager.kill).not.toHaveBeenCalled();
		await idle();
	});
	it('composes with the real SSH runner: cancellation and exit require independent native close', async () => {
		const native = Object.assign(new EventEmitter(), {
			pid: 123,
			stdout: new EventEmitter(),
			stderr: new EventEmitter(),
			kill: vi.fn(),
		});
		vi.mocked(spawn).mockReturnValue(native as unknown as ReturnType<typeof spawn>);
		const { SshCommandRunner } =
			await import('../../../main/process-manager/runners/SshCommandRunner');
		const runner = new SshCommandRunner(new EventEmitter());
		manager.cancelCommand.mockImplementation((id) => runner.cancel(id));
		const pending = runner.run('session', 'command', '~/remote-only', {
			id: 'remote',
			name: 'Remote',
			enabled: true,
			host: 'host',
			username: 'user',
			port: 22,
			privateKeyPath: '',
		});
		await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
		await expect(run('cancelCommand')).resolves.toBe(true);
		await pending;
		native.emit('exit', 0);
		await busy();
		native.emit('close', 0);
		await idle();
	});
});
