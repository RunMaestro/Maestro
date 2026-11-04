import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { EventEmitter } from 'events';
import fixture from '../../fixtures/harness-control/interactions.json';
import type {
	HarnessInteractionOpenRequest,
	HarnessInteractionResolution,
} from '../../../shared/harness-control/types';
import type { InteractionBroker } from '../../../main/harness-control/InteractionBroker';

vi.mock('fs/promises', () => ({ default: { realpath: vi.fn() } }));
vi.mock('../../../main/web-server/handlers/bridgeHandlers', () => ({
	broadcastBridgeEventToSessionSubscribers: vi.fn(() => true),
	isBridgeSessionOwner: vi.fn(() => false),
}));

describe('outer native interaction activity', () => {
	const target = path.resolve('interaction-integration-target');
	const permission = fixture.permission as HarnessInteractionOpenRequest;
	const context = { sessionId: permission.sessionId, spawnGeneration: 1, provider: 'fixture' };
	const record = { type: 'extension_ui_request', method: 'select', options: ['Native'] };
	let gate: typeof import('../../../main/git/worktreeActivity');
	let integration: typeof import('../../../main/harness-control/integration');
	let rpc: typeof import('../../../main/harness-control/rpc-interactions');
	let releases: Array<() => void>;
	let active: number;
	async function reserve(root = target) {
		const hold = await gate.reserveWorktreeCleanup(root);
		if (hold.status === 'reserved-partially') releases.push(hold.release);
		return hold;
	}
	async function idle() {
		const hold = await reserve();
		expect(hold.status).toBe('reserved-partially');
		if (hold.status !== 'reserved-partially') throw new Error('Expected partial reservation');
		expect(hold.blockers.map((b) => b.message).join(' ')).toMatch(/native.*registration.*OS/);
		hold.release();
	}
	beforeEach(async () => {
		vi.resetModules();
		vi.clearAllMocks();
		releases = [];
		active = 0;
		vi.mocked(fs.realpath).mockImplementation(async (p) => String(p));
		gate = await import('../../../main/git/worktreeActivity');
		const admit = gate.beginGlobalWorktreeActivity;
		vi.spyOn(gate, 'beginGlobalWorktreeActivity').mockImplementation(() => {
			const release = admit();
			active++;
			let released = false;
			return () => {
				if (!released) active--;
				released = true;
				release();
			};
		});
		integration = await import('../../../main/harness-control/integration');
		rpc = await import('../../../main/harness-control/rpc-interactions');
	});
	afterEach(() => {
		for (const release of releases) release();
		integration.harnessInteractionBroker.closeAll();
		expect(active).toBe(0);
		vi.restoreAllMocks();
	});

	it.each([target, path.join(target, 'child'), path.resolve('other-repository')])(
		'refuses initialization before dependency replacement or listener setup under %s',
		async (root) => {
			const original = vi.fn(() => null);
			integration.initHarnessControl({ getMainWindow: original }, null);
			const manager = new EventEmitter();
			const subscribe = vi.spyOn(manager, 'on');
			const replacement = vi.fn(() => null);
			const hold = await reserve(root);
			expect(() => integration.initHarnessControl({ getMainWindow: replacement }, manager)).toThrow(
				/reserved/
			);
			expect(subscribe).not.toHaveBeenCalled();
			hold.status === 'reserved-partially' && hold.release();
			integration.harnessInteractionBroker.open(permission);
			expect(original).toHaveBeenCalled();
			expect(replacement).not.toHaveBeenCalled();
		}
	);

	it('admits initialization before listener inspection and permits retry after refusal', async () => {
		const manager = new EventEmitter();
		const subscribe = vi.spyOn(manager, 'on');
		const hold = await reserve();
		expect(() => integration.initHarnessControl({ getMainWindow: () => null }, manager)).toThrow(
			/reserved/
		);
		expect(subscribe).not.toHaveBeenCalled();
		hold.status === 'reserved-partially' && hold.release();
		const levels: number[] = [];
		subscribe.mockImplementation(function (this: EventEmitter, event, listener) {
			levels.push(active);
			return EventEmitter.prototype.on.call(this, event, listener);
		});
		integration.initHarnessControl({ getMainWindow: () => null }, manager);
		expect(levels).toEqual([1]);
		expect(manager.listenerCount('exit')).toBe(1);
		await idle();
		expect(() => manager.emit('exit', permission.sessionId)).not.toThrow();
		const reserved = await reserve();
		expect(() => manager.emit('exit', permission.sessionId)).toThrow(/reserved/);
		reserved.status === 'reserved-partially' && reserved.release();
	});

	it('releases initialization activity on registration failure', async () => {
		const manager = new EventEmitter();
		const failure = new Error('listener failed');
		vi.spyOn(manager, 'on').mockImplementation(() => {
			throw failure;
		});
		expect(() => integration.initHarnessControl({ getMainWindow: () => null }, manager)).toThrow(
			failure
		);
		await idle();
	});

	it.each([undefined, {}, { webContentsId: 7 }, { bridgeClientId: 'browser' }])(
		'refuses response before request or owner inspection for %j',
		async (owner) => {
			const inspect = vi.fn(() => 'missing');
			const raw = Object.defineProperty({}, 'requestId', { get: inspect });
			await reserve();
			expect(() => integration.resolveHarnessInteractionResponse(raw, owner)).toThrow(/reserved/);
			expect(inspect).not.toHaveBeenCalled();
		}
	);

	it('keeps response ownership validation admitted after reentrant broker settlement', async () => {
		integration.initHarnessControl({ getMainWindow: () => null }, null);
		const opened = integration.harnessInteractionBroker.open(permission);
		const levels: number[] = [];
		const owner = Object.defineProperty({}, 'bridgeClientId', {
			get: () => {
				integration.harnessInteractionBroker.withdraw(opened.request.requestId);
				levels.push(active);
				return 'not-owner';
			},
		});
		expect(
			integration.resolveHarnessInteractionResponse({ requestId: opened.request.requestId }, owner)
		).toBe('not-found');
		expect(levels.length).toBeGreaterThan(0);
		expect(levels.every((level) => level > 0)).toBe(true);
		await expect(opened.completion).resolves.toEqual({ outcome: 'cancelled', reason: 'withdrawn' });
		await idle();
	});

	it('preserves validation errors and releases the outer response scope', async () => {
		const failure = new Error('request getter failed');
		const raw = Object.defineProperty({}, 'requestId', {
			get: () => {
				throw failure;
			},
		});
		expect(() => integration.resolveHarnessInteractionResponse(raw, {})).toThrow(failure);
		await idle();
	});

	it.each(['singleton', 'injected'] as const)(
		'refuses %s translation before record inspection or broker setup',
		async (mode) => {
			const inspect = vi.fn(() => 'extension_ui_request');
			const input = Object.defineProperty({}, 'type', { get: inspect });
			const open = vi.spyOn(integration.harnessInteractionBroker, 'open');
			await reserve();
			const result =
				mode === 'singleton'
					? rpc.answerRpcExtensionRequest(input, context)
					: rpc.answerRpcExtensionRequestWithBroker(
							input,
							context,
							integration.harnessInteractionBroker
						);
			await expect(result).rejects.toThrow(/reserved/);
			expect(inspect).not.toHaveBeenCalled();
			expect(open).not.toHaveBeenCalled();
		}
	);

	it.each(['cancelled', 'selected', 'answers', 'rejected'] as const)(
		'holds standalone translation through pending %s completion',
		async (outcome) => {
			const decision = Promise.withResolvers<HarnessInteractionResolution>();
			const broker = {
				open: vi.fn(() => ({ completion: decision.promise })),
			} as unknown as InteractionBroker;
			const result = rpc.answerRpcExtensionRequestWithBroker(record, context, broker);
			expect(await reserve()).toMatchObject({
				status: 'blocked',
				blockers: [{ code: 'mutation-busy' }],
			});
			if (outcome === 'rejected') {
				const failure = new Error('decision failed');
				decision.reject(failure);
				await expect(result).rejects.toThrow(failure);
			} else {
				const resolution: HarnessInteractionResolution =
					outcome === 'cancelled'
						? { outcome, reason: 'withdrawn' }
						: outcome === 'selected'
							? { outcome, optionId: 'option-0' }
							: { outcome, answers: { answer: 'Text' } };
				decision.resolve(resolution);
				await expect(result).resolves.toEqual({
					kind: 'extension',
					value:
						outcome === 'cancelled'
							? { cancelled: true }
							: { value: outcome === 'selected' ? 'Native' : 'Text' },
				});
			}
			await idle();
		}
	);

	it('retains real broker translation after settlement through response construction', async () => {
		integration.initHarnessControl({ getMainWindow: () => null }, null);
		const levels: number[] = [];
		let decisionSettled = false;
		const options = Object.defineProperty(['Native'], 0, {
			get: () => {
				if (decisionSettled) levels.push(active);
				return 'Native';
			},
		});
		const result = rpc.answerRpcExtensionRequest({ ...record, options }, context);
		const [pending] = integration.harnessInteractionBroker.pendingRequests();
		integration.resolveHarnessInteractionResponse({
			requestId: pending.requestId,
			outcome: 'selected',
			optionId: 'option-0',
		});
		decisionSettled = true;
		expect(integration.harnessInteractionBroker.pendingRequests()).toEqual([]);
		await expect(result).resolves.toEqual({ kind: 'extension', value: { value: 'Native' } });
		expect(levels.length).toBeGreaterThan(0);
		expect(levels.every((level) => level > 0)).toBe(true);
		await idle();
	});

	it('keeps an overlapping request busy when another translation rejects', async () => {
		const first = Promise.withResolvers<HarnessInteractionResolution>();
		const second = Promise.withResolvers<HarnessInteractionResolution>();
		const broker = {
			open: vi
				.fn()
				.mockReturnValueOnce({ completion: first.promise })
				.mockReturnValueOnce({ completion: second.promise }),
		} as unknown as InteractionBroker;
		const a = rpc.answerRpcExtensionRequestWithBroker(record, context, broker);
		const b = rpc.answerRpcExtensionRequestWithBroker(record, context, broker);
		first.reject(new Error('first failed'));
		await expect(a).rejects.toThrow('first failed');
		expect(await reserve()).toMatchObject({
			status: 'blocked',
			blockers: [{ code: 'mutation-busy' }],
		});
		second.resolve({ outcome: 'cancelled', reason: 'process-exited' });
		await expect(b).resolves.toEqual({ kind: 'extension', value: { cancelled: true } });
		await idle();
	});

	it('blocks a pending reservation when translation starts during canonicalization', async () => {
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockImplementationOnce(() => canonical.promise);
		const hold = reserve();
		const decision = Promise.withResolvers<HarnessInteractionResolution>();
		const broker = {
			open: vi.fn(() => ({ completion: decision.promise })),
		} as unknown as InteractionBroker;
		const result = rpc.answerRpcExtensionRequestWithBroker(record, context, broker);
		canonical.resolve(target);
		expect(await hold).toMatchObject({ status: 'blocked', blockers: [{ code: 'mutation-busy' }] });
		decision.resolve({ outcome: 'cancelled', reason: 'cancelled' });
		await result;
		await idle();
	});

	it.each(['unsupported', 'ignored', 'getter-error', 'broker-error', 'response-error'] as const)(
		'releases standalone translation after %s',
		async (mode) => {
			const failure = new Error('translation failed');
			const broker = {
				open: vi.fn(() => {
					if (mode === 'broker-error') throw failure;
					return {
						completion: Promise.resolve(
							Object.defineProperty({}, 'outcome', {
								get: () => {
									throw failure;
								},
							})
						),
					};
				}),
			} as unknown as InteractionBroker;
			const input =
				mode === 'unsupported'
					? { type: 'unknown' }
					: mode === 'ignored'
						? { ...record, method: 'notify' }
						: mode === 'getter-error'
							? Object.defineProperty({}, 'type', {
									get: () => {
										throw failure;
									},
								})
							: record;
			const result = rpc.answerRpcExtensionRequestWithBroker(input, context, broker);
			if (mode.endsWith('error')) await expect(result).rejects.toThrow(failure);
			else
				await expect(result).resolves.toMatchObject({
					kind: mode === 'ignored' ? 'ignore' : 'error',
				});
			await idle();
		}
	);
});
