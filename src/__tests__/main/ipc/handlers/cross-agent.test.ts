/**
 * Tests for resolveCrossAgentWritable in src/main/ipc/handlers/cross-agent.ts
 *
 * A consult and a hand-off have separate write switches with opposite defaults:
 * a consult answers a question (read-only unless opted in), a hand-off passes
 * work on (may write unless opted out).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import * as activity from '../../../../main/git/worktreeActivity';
import { generateUUID } from '../../../../shared/uuid';
import { logger } from '../../../../main/utils/logger';
import {
	startCrossAgentRequest,
	cancelCrossAgentRequestsForSource,
} from '../../../../main/cross-agent/cross-agent-router';
import type {
	CrossAgentSendRequest,
	CrossAgentResponseChunk,
} from '../../../../shared/crossAgentTypes';
import type { CrossAgentHandlerDependencies } from '../../../../main/ipc/handlers/cross-agent';

vi.mock('fs/promises', () => ({ default: { realpath: vi.fn() } }));
vi.mock('../../../../shared/uuid', () => ({ generateUUID: vi.fn() }));
vi.mock('../../../../main/cross-agent/cross-agent-router', () => ({
	startCrossAgentRequest: vi.fn(),
	cancelCrossAgentRequestsForSource: vi.fn(),
}));
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
	resolveCrossAgentWritable,
	registerCrossAgentHandlers,
} from '../../../../main/ipc/handlers/cross-agent';

/** A settings store holding only `values`; anything else gets the caller's default. */
function store(values: Record<string, unknown>) {
	return {
		get: <T>(key: string, defaultValue?: T): T => (key in values ? values[key] : defaultValue) as T,
	};
}

describe('resolveCrossAgentWritable', () => {
	it('keeps a consult read-only and lets a hand-off write when nothing is set', () => {
		expect(resolveCrossAgentWritable({}, store({}))).toBe(false);
		expect(resolveCrossAgentWritable({ handoffAnswer: 'findings' }, store({}))).toBe(true);
	});

	it('reads each kind from its own switch only', () => {
		const settings = store({ crossAgentMentionsWritable: true, crossAgentHandoffsWritable: false });

		expect(resolveCrossAgentWritable({}, settings)).toBe(true);
		expect(resolveCrossAgentWritable({ handoffAnswer: 'findings' }, settings)).toBe(false);
	});

	it('treats an empty answer as a hand-off, not a consult', () => {
		// The field's presence is the marker; an agent can legitimately answer with "".
		expect(resolveCrossAgentWritable({ handoffAnswer: '' }, store({}))).toBe(true);
	});
});

describe('cross-agent IPC activity', () => {
	const target = path.resolve('cross-agent-ipc-target');
	let active: number;
	let releases: Array<() => void>;
	let dispatches: Array<
		ReturnType<typeof Promise.withResolvers<void>> & { done: Promise<unknown> }
	>;
	let deps: CrossAgentHandlerDependencies;
	let payload: CrossAgentSendRequest;
	const invoke = (channel: 'send' | 'cancel', input: unknown = payload) =>
		vi
			.mocked(ipcMain.handle)
			.mock.calls.find(([name]) => name === `cross-agent:${channel}`)![1](
				{} as IpcMainInvokeEvent,
				input
			);
	const options = () => vi.mocked(startCrossAgentRequest).mock.calls.at(-1)![1];
	async function reserve(root = target) {
		const hold = await activity.reserveWorktreeCleanup(root);
		if (hold.status === 'reserved-partially') releases.push(hold.release);
		return hold;
	}
	async function idle() {
		expect(await reserve()).toMatchObject({
			status: 'reserved-partially',
			blockers: [{ code: 'unknown' }, { code: 'unknown' }],
		});
	}
	async function busy() {
		expect(await reserve()).toMatchObject({
			status: 'blocked',
			blockers: [{ code: 'mutation-busy' }],
		});
	}
	beforeEach(() => {
		vi.resetAllMocks();
		active = 0;
		releases = [];
		dispatches = [];
		vi.mocked(fs.realpath).mockImplementation(async (p) => String(p));
		const begin = activity.beginGlobalWorktreeActivity;
		vi.spyOn(activity, 'beginGlobalWorktreeActivity').mockImplementation(() => {
			const release = begin();
			active++;
			let released = false;
			return () => {
				if (!released) {
					released = true;
					active--;
					release();
				}
			};
		});
		vi.mocked(generateUUID).mockReturnValue('request');
		vi.mocked(startCrossAgentRequest).mockImplementation(() => {
			const pending = Promise.withResolvers<void>();
			const record = { ...pending, done: pending.promise as Promise<unknown> };
			// Observe detached recovery failures without creating unhandled test rejections.
			const recover = pending.promise.catch.bind(pending.promise);
			vi.spyOn(pending.promise, 'catch').mockImplementation((handler) => {
				const recovered = recover(handler);
				record.done = recovered;
				void recovered.catch(() => {});
				const finalize = recovered.finally.bind(recovered);
				vi.spyOn(recovered, 'finally').mockImplementation((handler) => {
					record.done = finalize(handler);
					void record.done.catch(() => {});
					return record.done as typeof recovered;
				});
				return recovered;
			});
			dispatches.push(record);
			return pending.promise;
		});
		vi.mocked(cancelCrossAgentRequestsForSource).mockReturnValue(2);
		deps = {
			getProcessManager: vi.fn(() => ({})),
			getAgentDetector: vi.fn(() => ({})),
			sessionsStore: {
				get: vi.fn(() => [{ id: 'target', name: 'Target', toolType: 'codex', cwd: target }]),
			},
			agentConfigsStore: { get: vi.fn(() => ({})) },
			settingsStore: store({}),
			sshStore: null,
			safeSend: vi.fn(),
		} as unknown as CrossAgentHandlerDependencies;
		payload = {
			sourceSessionId: 'source',
			sourceTabId: 'tab',
			targetSessionId: 'target',
			userPrompt: 'question',
			transcript: [],
			strategy: { kind: 'full' },
		};
		registerCrossAgentHandlers(deps);
	});
	afterEach(async () => {
		dispatches.forEach((d) => d.resolve());
		await Promise.allSettled(dispatches.map((d) => d.done));
		releases.forEach((release) => release());
		expect(active).toBe(0);
		vi.restoreAllMocks();
	});

	it.each(['send', 'cancel'] as const)(
		'refuses %s before dependencies or payload under any reservation',
		async (channel) => {
			for (const root of [target, path.join(target, 'child'), path.resolve('other')]) {
				const hold = await reserve(root);
				expect(hold.status).toBe('reserved-partially');
				const read = vi.fn(() => {
					throw new Error('payload inspected');
				});
				await expect(invoke(channel, new Proxy({}, { get: read }))).rejects.toThrow(/reserved/);
				expect(read).not.toHaveBeenCalled();
				expect(deps.getProcessManager).not.toHaveBeenCalled();
				expect(deps.getAgentDetector).not.toHaveBeenCalled();
				expect(generateUUID).not.toHaveBeenCalled();
				expect(startCrossAgentRequest).not.toHaveBeenCalled();
				expect(cancelCrossAgentRequestsForSource).not.toHaveBeenCalled();
				if (hold.status === 'reserved-partially') hold.release();
			}
		}
	);
	it('admits before preparation and holds beyond the immediate request-id reply', async () => {
		const observed = vi.fn(() => expect(active).toBeGreaterThan(0));
		vi.mocked(deps.getProcessManager).mockImplementation(() => {
			observed();
			return {} as never;
		});
		vi.mocked(deps.getAgentDetector).mockImplementation(() => {
			observed();
			return {} as never;
		});
		vi.mocked(generateUUID).mockImplementation(() => {
			observed();
			return 'request';
		});
		vi.spyOn(deps.settingsStore, 'get').mockImplementation(() => {
			observed();
			return false;
		});
		vi.mocked(logger.info).mockImplementation(observed);
		Object.defineProperty(payload, 'transcript', {
			get: () => {
				observed();
				return [];
			},
		});
		await expect(invoke('send')).resolves.toEqual({ requestId: 'request' });
		expect(observed.mock.calls.length).toBeGreaterThan(5);
		expect(startCrossAgentRequest).toHaveBeenCalledWith(
			expect.objectContaining({ sourceTabId: 'tab' }),
			expect.objectContaining({ writable: false })
		);
		await busy();
		dispatches[0].resolve();
		await dispatches[0].done;
		await idle();
	});
	it.each(['process', 'agent', 'uuid', 'payload', 'settings', 'log', 'router'])(
		'releases and preserves %s preparation errors',
		async (site) => {
			const failure = new Error(site);
			const fail = () => {
				expect(active).toBeGreaterThan(0);
				throw failure;
			};
			if (site === 'process') vi.mocked(deps.getProcessManager).mockImplementation(fail);
			if (site === 'agent') vi.mocked(deps.getAgentDetector).mockImplementation(fail);
			if (site === 'uuid') vi.mocked(generateUUID).mockImplementation(fail);
			if (site === 'payload') Object.defineProperty(payload, 'sourceSessionId', { get: fail });
			if (site === 'settings') vi.spyOn(deps.settingsStore, 'get').mockImplementation(fail);
			if (site === 'log') vi.mocked(logger.info).mockImplementation(fail);
			if (site === 'router') vi.mocked(startCrossAgentRequest).mockImplementation(fail);
			await expect(invoke('send')).rejects.toBe(failure);
			expect(active).toBe(0);
			await idle();
		}
	);
	it.each([new Error('spawn failed'), 'spawn failed'])(
		'holds detached error reporting for %s',
		async (failure) => {
			await invoke('send');
			vi.mocked(deps.sessionsStore.get).mockImplementation(() => {
				expect(active).toBeGreaterThan(0);
				return [{ id: 'target', name: 'Target', toolType: 'codex', cwd: target }];
			});
			vi.mocked(deps.safeSend).mockImplementation(() => expect(active).toBeGreaterThan(0));
			dispatches[0].reject(failure);
			await dispatches[0].done;
			expect(deps.safeSend).toHaveBeenCalledWith(
				'cross-agent:chunk',
				expect.objectContaining({
					requestId: 'request',
					targetAgentName: 'Target',
					targetToolType: 'codex',
					done: true,
					error: 'spawn failed',
				})
			);
			await idle();
		}
	);
	it.each(['log', 'target', 'send'])(
		'releases after detached %s reporting throws',
		async (site) => {
			await invoke('send');
			const failure = new Error(site);
			const fail = () => {
				expect(active).toBeGreaterThan(0);
				throw failure;
			};
			if (site === 'log') vi.mocked(logger.error).mockImplementation(fail);
			if (site === 'target') vi.mocked(deps.sessionsStore.get).mockImplementation(fail);
			if (site === 'send') vi.mocked(deps.safeSend).mockImplementation(fail);
			dispatches[0].reject(new Error('spawn failed'));
			await expect(dispatches[0].done).rejects.toBe(failure);
			await idle();
		}
	);
	it('keeps simultaneous pending sends and independent native work after cancellation', async () => {
		await invoke('send');
		await invoke('send');
		expect(active).toBe(2);
		await expect(invoke('cancel')).resolves.toEqual({ canceled: 2 });
		dispatches[0].resolve();
		await dispatches[0].done;
		await busy();
		releases.push(activity.beginGlobalWorktreeActivity());
		dispatches[1].resolve();
		await dispatches[1].done;
		await busy();
		releases[0]();
		await idle();
	});
	it.each([undefined, 'tab', 42])(
		'holds cancellation and reports the original count with tab %s',
		async (sourceTabId) => {
			vi.mocked(cancelCrossAgentRequestsForSource).mockImplementation(() => {
				expect(active).toBe(1);
				return 3;
			});
			vi.mocked(logger.info).mockImplementation(() => expect(active).toBe(1));
			await expect(invoke('cancel', { sourceSessionId: 'source', sourceTabId })).resolves.toEqual({
				canceled: 3,
			});
			expect(cancelCrossAgentRequestsForSource).toHaveBeenCalledWith(
				'source',
				typeof sourceTabId === 'string' ? sourceTabId : undefined
			);
			await idle();
		}
	);
	it.each(['payload', 'router', 'log'])('releases cancellation after %s errors', async (site) => {
		const failure = new Error(site);
		const fail = () => {
			expect(active).toBeGreaterThan(0);
			throw failure;
		};
		if (site === 'payload') Object.defineProperty(payload, 'sourceTabId', { get: fail });
		if (site === 'router') vi.mocked(cancelCrossAgentRequestsForSource).mockImplementation(fail);
		if (site === 'log') vi.mocked(logger.info).mockImplementation(fail);
		await expect(invoke('cancel')).rejects.toBe(failure);
		await idle();
	});
	it('independently guards later chunk delivery, refusal and observer errors', async () => {
		await invoke('send');
		dispatches[0].resolve();
		await dispatches[0].done;
		const chunk = { chunk: 'answer', done: true } as CrossAgentResponseChunk;
		await idle();
		expect(() => options().onChunk(chunk)).toThrow(/reserved/);
		expect(deps.safeSend).not.toHaveBeenCalled();
		releases.at(-1)!();
		let nested: unknown;
		vi.mocked(cancelCrossAgentRequestsForSource).mockImplementation(() => {
			expect(active).toBe(2);
			return 0;
		});
		vi.mocked(deps.safeSend).mockImplementation(() => {
			nested = invoke('cancel');
		});
		options().onChunk(chunk);
		await expect(nested).resolves.toEqual({ canceled: 0 });
		const failure = new Error('observer');
		vi.mocked(deps.safeSend).mockImplementation(() => {
			expect(active).toBe(1);
			throw failure;
		});
		expect(() => options().onChunk(chunk)).toThrow(failure);
		expect(deps.safeSend).toHaveBeenCalledWith('cross-agent:chunk', chunk);
		await idle();
	});
});
