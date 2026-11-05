import {
	configureImageStore,
	__resetImageStoreCacheForTests,
} from '../../../main/storage/session-image-store';
/** Production handler + admission journal + native transport composition. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { handleSendCommand } from '../../../main/web-server/handlers/messageHandlers/commands';
import { handleEnqueueCommand } from '../../../main/web-server/handlers/messageHandlers/queue';
import { handleNewAITabWithPrompt } from '../../../main/web-server/handlers/messageHandlers/tabs';
import { hostCallerRuns } from '../../../main/agent-run/caller-identity';
import { pianolaNewTabSpawns } from '../../../main/pianola/pianola-new-tab-dispatch';
import * as store from '../../../main/pianola/pianola-store-main';
import { generateUUID } from '../../../shared/uuid';
import type {
	MessageHandlerContext,
	WebClient,
} from '../../../main/web-server/handlers/messageHandlers/types';
import type { NewAITabWithPromptCallback } from '../../../shared/pianola/pianola-dispatch';

vi.mock('electron', () => ({ app: { getPath: () => process.cwd() } }));
const flags = vi.hoisted(() => ({ pianola: true, sessions: [] as unknown[] }));
vi.mock('../../../main/stores/getters', () => ({
	getSettingsStore: () => ({ get: () => flags }),
	getSessionsStore: () => ({ get: () => flags.sessions }),
	getLiveSessions: () => flags.sessions,
	getGroupsStore: () => ({ get: () => [] }),
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
const directories: string[] = [];
let previousDataDir: string | undefined;
afterEach(() => {
	vi.restoreAllMocks();
	__resetImageStoreCacheForTests();
	flags.pianola = true;
	if (previousDataDir === undefined) delete process.env.MAESTRO_USER_DATA;
	else process.env.MAESTRO_USER_DATA = previousDataDir;
	for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	previousDataDir = process.env.MAESTRO_USER_DATA;
	const root = path.resolve('.maestro/pianola-agent-supervision-20261104/Working');
	fs.mkdirSync(root, { recursive: true });
	const dir = fs.mkdtempSync(path.join(root, 'handler-'));
	directories.push(dir);
	process.env.MAESTRO_USER_DATA = dir;
	const scopeId = generateUUID();
	store.writeSupervisorTargets([
		{
			id: scopeId,
			kind: 'watch-scope',
			enabled: true,
			createdAt: 1,
			managerAgentId: 'manager',
			selection: {
				label: 'Workers',
				mode: 'agents-and-groups',
				agentIds: ['worker'],
				groupIds: [],
				excludedAgentIds: [],
			},
		},
	]);
	const owner = {
		id: 'worker',
		cwd: process.cwd(),
		parentSessionId: null,
		groupId: null,
		isPianola: false,
		remote: false,
	};
	const snapshot = {
		supervisionVersion: 1,
		complete: true,
		capturedAt: 100,
		owners: [owner],
		sessions: [] as object[],
	};
	const client = {} as WebClient;
	const controller = new AbortController();
	vi.spyOn(hostCallerRuns, 'resolve').mockImplementation((c) =>
		c === client
			? {
					run: { agentId: 'manager', tabId: 'caller-tab', spawnGeneration: 'caller-run' },
					signal: controller.signal,
					unattended: true,
					assertActive() {
						if (controller.signal.aborted) throw new Error('CallerRunUnavailable');
					},
				}
			: undefined
	);
	const newTab = vi.fn<NewAITabWithPromptCallback>(
		async (_agent, _prompt, _background, _hidden, _routing, control) => {
			if (!control) return { success: true, tabId: 'ordinary-tab' };
			if (control.phase === 'prepare') {
				snapshot.sessions = [
					{
						agentId: 'worker',
						tabId: control.tabId,
						createdAt: 99,
						supervision: {
							...owner,
							ancestors: [],
							lineageComplete: true,
							paused: false,
							busy: false,
							consult: false,
							ephemeral: false,
							cursorAvailable: true,
							cursor: null,
						},
					},
				];
			} else {
				expect(store.readScopeCheckpoint(scopeId)?.tabs[0].tabId).toBe(control.tabId);
				pianolaNewTabSpawns.claim(`worker-ai-${control.tabId}`, control.dispatchId)();
				pianolaNewTabSpawns.started(`worker-ai-${control.tabId}`, 'native-run', control.dispatchId);
			}
			return { success: true, tabId: control.tabId };
		}
	);
	const send = vi.fn();
	const executeCommand = vi.fn(async (..._args: unknown[]) => true);
	const enqueueCommand = vi.fn(async (..._args: unknown[]) => ({
		success: true,
		tabId: 'tab',
		queued: true,
		itemId: 'item',
	}));
	const ctx = {
		callbacks: {
			getSessions: () => [{ id: 'worker' }],
			getSessionDetail: () => ({
				id: 'worker',
				state: 'idle',
				inputMode: 'ai',
				activeTabId: 'tab',
			}),
			executeCommand,
			enqueueCommand,
			listDesktopSessions: () => snapshot,
			newAITabWithPrompt: newTab,
		},
		send,
		sendError: vi.fn(),
	} as unknown as MessageHandlerContext;
	return {
		ctx,
		client,
		newTab,
		send,
		snapshot,
		scopeId,
		executeCommand,
		enqueueCommand,
		controller,
	};
}
describe('production new-tab handler supervision wiring', () => {
	it.each(['ack', 'readback', 'no-proof', 'outcome-write', 'fallback-read'])(
		'returns truthful WS/CLI queue semantics after caller ends at %s',
		async (boundary) => {
			const f = fixture();
			await f.newTab('worker', '', true, false, undefined, {
				phase: 'prepare',
				dispatchId: generateUUID(),
				tabId: 'tab',
			});
			flags.sessions = [{ id: 'worker', toolType: 'codex', aiTabs: [{ id: 'tab' }] }];
			const enqueue = f.enqueueCommand.getMockImplementation()!;
			f.enqueueCommand.mockImplementation(async (...args) => {
				if (boundary === 'ack') f.controller.abort();
				return enqueue(...args);
			});
			Object.assign(f.ctx.callbacks, {
				confirmQueueItem: async (request: unknown) => {
					f.controller.abort();
					if (boundary === 'fallback-read') {
						vi.spyOn(store, 'readDispatchAdmission').mockImplementation(() => {
							throw new Error('Read failed');
						});
						throw new Error('Readback failed');
					}
					return { durable: boundary !== 'no-proof', request };
				},
			});
			const write = store.writeDispatchAdmission;
			vi.spyOn(store, 'writeDispatchAdmission').mockImplementation((record) => {
				if (boundary === 'outcome-write' && record.outcome === 'queued')
					throw new Error('Write failed');
				write(record);
			});
			const message = {
				type: 'enqueue_command',
				sessionId: 'worker',
				tabId: 'tab',
				command: 'work',
				dispatchId: generateUUID(),
			};
			handleEnqueueCommand(f.ctx, f.client, message);
			await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
			const durable = boundary === 'ack' || boundary === 'readback';
			expect(f.send.mock.calls[0][1]).toMatchObject({
				success: durable,
				durable,
				queued: durable,
				queuedAccepted: durable,
				unknown: !durable,
				admission: { outcome: durable ? 'queued' : 'unknown' },
			});
			if (!durable) expect(f.send.mock.calls[0][1].error).toMatch(/Do not resend/);
			expect(f.enqueueCommand).toHaveBeenCalledOnce();
		}
	);

	it.each([false, true])(
		'consumes production queue admission with busy=%s and pins host intent rather than renderer ack',
		async (busy) => {
			const f = fixture();
			await f.newTab('worker', '', true, false, undefined, {
				phase: 'prepare',
				dispatchId: generateUUID(),
				tabId: 'tab',
			});
			(
				f.snapshot.sessions[0] as { supervision: { busy: boolean; cursorAvailable: boolean } }
			).supervision.busy = busy;
			(
				f.snapshot.sessions[0] as { supervision: { cursorAvailable: boolean } }
			).supervision.cursorAvailable = false;
			configureImageStore(process.env.MAESTRO_USER_DATA!);
			flags.sessions = [
				{
					id: 'worker',
					name: 'Worker',
					toolType: 'codex',
					customModel: 'host-model',
					aiTabs: [{ id: 'tab', name: 'Work', customEffort: 'medium' }],
				},
			];
			const proof = vi.fn(async (request: { item: unknown }) => ({ durable: true, request }));
			Object.assign(f.ctx.callbacks, { confirmQueueItem: proof });
			const message = {
				type: 'enqueue_command',
				sessionId: 'worker',
				tabId: 'tab',
				command: 'queue task',
				images: ['data:image/png;base64,aA=='],
				background: true,
				dispatchId: generateUUID(),
			};
			handleEnqueueCommand(f.ctx, f.client, message);
			await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
			expect(f.send.mock.calls[0][1]).toMatchObject({
				success: true,
				queuedAccepted: true,
				durable: true,
				queued: true,
				itemId: message.dispatchId,
				admission: { outcome: 'queued', supervision: 'unavailable' },
			});
			const expectedItem = (f.enqueueCommand.mock.calls[0][9] as { item: object }).item;
			expect((expectedItem as { images: string[] }).images).toEqual([
				expect.stringMatching(/^maestro-image:\/\/store\/[a-f0-9]{64}\.png$/),
			]);
			expect(expectedItem).toMatchObject({
				id: message.dispatchId,
				text: 'queue task',
				tabId: 'tab',
				pendingAdmissionId: message.dispatchId,
				turnSettings: { model: 'host-model', effort: 'medium' },
			});
			expect(proof).toHaveBeenCalledWith(expect.objectContaining({ item: expectedItem }));
			expect(store.readScopeCheckpoint(f.scopeId)).toBeNull();
			handleEnqueueCommand(f.ctx, f.client, message);
			await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
			expect(f.enqueueCommand).toHaveBeenCalledOnce();
			handleEnqueueCommand(f.ctx, f.client, { ...message, command: 'changed intent' });
			await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(3));
			expect(f.send.mock.calls[2][1]).toMatchObject({
				success: false,
				error: 'DispatchIntentMismatch',
			});
			expect(f.enqueueCommand).toHaveBeenCalledOnce();
		}
	);

	it.each([
		['new', handleNewAITabWithPrompt],
		['send', handleSendCommand],
		['queue', handleEnqueueCommand],
	] as const)(
		'%s preserves ordinary feature-off/unmanaged delegation and refuses managed pause/exclusion',
		async (kind, handle) => {
			const f = fixture();
			// Prepare native metadata for an existing tab using the same real adapter fixture.
			await f.newTab('worker', '', true, false, undefined, {
				phase: 'prepare',
				tabId: 'tab',
				dispatchId: generateUUID(),
			});
			f.newTab.mockClear();
			const invoke = async () => {
				f.send.mockClear();
				handle(f.ctx, f.client, {
					type: kind,
					sessionId: 'worker',
					command: 'Hello',
					prompt: 'Hello',
					inputMode: 'ai',
					dispatchId: generateUUID(),
					tabId: 'tab',
				});
				await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
				return f.send.mock.calls[0][1];
			};
			flags.pianola = false;
			expect(await invoke()).toMatchObject({
				success: true,
				admission: {
					supervision: 'feature-off',
					outcome: kind === 'queue' ? 'queued' : 'accepted',
				},
			});
			flags.pianola = true;
			const targets = store.readSupervisorTargets();
			store.writeSupervisorTargets([]);
			expect(await invoke()).toMatchObject({
				success: true,
				admission: { supervision: 'unmanaged' },
			});
			// A different scope manager is ordinary delegation, not caller authority.
			store.writeSupervisorTargets(
				targets.map((t) => ({ ...t, managerAgentId: 'another-manager' }))
			);
			expect(await invoke()).toMatchObject({
				success: true,
				admission: { supervision: 'unmanaged' },
			});
			if (kind !== 'new') {
				store.writeSupervisorTargets(targets);
				const tab = f.snapshot.sessions[0] as { supervision: { paused: boolean } };
				tab.supervision.paused = true;
				expect(await invoke()).toMatchObject({
					success: false,
					admission: { supervision: 'paused' },
				});
				tab.supervision.paused = false;
			}
			store.writeSupervisorTargets(targets.map((t) => ({ ...t, enabled: false })));
			const calls = [
				f.newTab.mock.calls.length,
				f.executeCommand.mock.calls.length,
				f.enqueueCommand.mock.calls.length,
			];
			expect(await invoke()).toMatchObject({
				success: false,
				admission: { supervision: 'excluded', outcome: 'rejected' },
			});
			store.writeSupervisorTargets(
				targets.map((t) => ({ ...t, selection: { ...t.selection!, excludedAgentIds: ['worker'] } }))
			);
			expect(await invoke()).toMatchObject({
				success: false,
				admission: { supervision: 'excluded' },
			});
			store.writeSupervisorTargets(
				targets.map((t) => ({
					...t,
					delegationPolicy: {
						version: 1,
						revision: 1,
						enabled: false,
						managerAgentId: 'manager',
						coverage: 'selected-agents',
						ruleSetRevision: 'paused',
					},
				}))
			);
			expect(await invoke()).toMatchObject({
				success: false,
				admission: { supervision: 'paused' },
				error: 'PianolaPolicyPaused',
			});
			expect([
				f.newTab.mock.calls.length,
				f.executeCommand.mock.calls.length,
				f.enqueueCommand.mock.calls.length,
			]).toEqual(calls);
		}
	);

	it('does not resend a journaled unknown dispatch through feature-off fallback', async () => {
		const f = fixture();
		const native = f.newTab.getMockImplementation()!;
		f.newTab.mockImplementation(async (...args) =>
			args[5]?.phase === 'release'
				? { success: false, unknown: true, tabId: args[5].tabId }
				: native(...args)
		);
		const message = {
			type: 'new_ai_tab_with_prompt',
			sessionId: 'worker',
			prompt: 'Hello',
			dispatchId: generateUUID(),
		};
		handleNewAITabWithPrompt(f.ctx, f.client, message);
		await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
		expect(f.send.mock.calls[0][1]).toMatchObject({
			unknown: true,
			admission: { outcome: 'unknown' },
		});
		flags.pianola = false;
		handleNewAITabWithPrompt(f.ctx, f.client, message);
		await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
		expect(f.send.mock.calls[1][1]).toMatchObject({
			unknown: true,
			admission: { outcome: 'unknown' },
		});
		expect(f.newTab).toHaveBeenCalledTimes(2);
	});

	it('refuses a revoked previously bound caller instead of falling back to a human send', async () => {
		const f = fixture();
		vi.mocked(hostCallerRuns.resolve).mockReturnValue(undefined);
		vi.spyOn(hostCallerRuns, 'isRunClient').mockReturnValue(true);
		handleNewAITabWithPrompt(f.ctx, f.client, {
			type: 'new_ai_tab_with_prompt',
			sessionId: 'worker',
			prompt: 'Hello',
			dispatchId: generateUUID(),
		});
		await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
		expect(f.send.mock.calls[0][1]).toMatchObject({
			success: false,
			error: 'CallerRunUnavailable',
		});
		expect(f.newTab).not.toHaveBeenCalled();
	});

	it('consumes verified caller authority and returns the exact durable receipt, then only reads it on repeat', async () => {
		const f = fixture();
		const message = {
			type: 'new_ai_tab_with_prompt',
			sessionId: 'worker',
			prompt: 'Implement it',
			background: true,
			dispatchId: generateUUID(),
		};
		handleNewAITabWithPrompt(f.ctx, f.client, message);
		await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
		expect(f.send.mock.calls[0][1]).toMatchObject({
			success: true,
			dispatchId: message.dispatchId,
			admission: {
				outcome: 'accepted',
				supervision: 'enrolled',
				targetTabId: message.dispatchId,
				runId: 'native-run',
			},
		});
		handleNewAITabWithPrompt(f.ctx, f.client, message);
		await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
		expect(f.newTab).toHaveBeenCalledTimes(2);
	});
	it('does not grant supervision from forged public caller or callback fields', async () => {
		const f = fixture();
		handleNewAITabWithPrompt(f.ctx, {} as WebClient, {
			type: 'new_ai_tab_with_prompt',
			sessionId: 'worker',
			prompt: 'Hello',
			fromSessionId: 'manager',
			fromTabId: 'caller-tab',
			dispatchId: generateUUID(),
		});
		await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
		expect(f.newTab.mock.calls[0]).toHaveLength(5);
		expect(f.send.mock.calls[0][1].admission).toBeUndefined();
	});
});

describe('existing-tab production dispatch admission', () => {
	async function existingFixture() {
		const f = fixture();
		await f.newTab('worker', '', true, false, undefined, {
			phase: 'prepare',
			dispatchId: generateUUID(),
			tabId: 'tab',
		});
		f.newTab.mockClear();
		f.executeCommand.mockImplementation(async (...args: unknown[]) => {
			expect(args[2]).toBe('ai');
			expect(args[3]).toBe('tab');
			expect(args[4]).toBe(false);
			expect(args[8]).toBe(true);
			expect(store.readScopeCheckpoint(f.scopeId)?.tabs[0].tabId).toBe('tab');
			const id = args[9] as string;
			expect(store.readDispatchAdmission(id)?.outcome).toBe('unknown');
			const key = 'worker-ai-tab';
			pianolaNewTabSpawns.claim(key, id)();
			pianolaNewTabSpawns.captured(key, 'run:actual-existing', id);
			pianolaNewTabSpawns.started(key, undefined, id);
			return true;
		});
		return f;
	}
	async function send(f: Awaited<ReturnType<typeof existingFixture>>, id: string, tabId?: string) {
		f.send.mockClear();
		handleSendCommand(f.ctx, f.client, {
			type: 'send_command',
			sessionId: 'worker',
			command: 'work',
			inputMode: 'ai',
			dispatchId: id,
			...(tabId ? { tabId } : {}),
			background: true,
		});
		await vi.waitFor(() => expect(f.send).toHaveBeenCalled());
		return f.send.mock.calls[0][1];
	}
	it.each([undefined, 'tab'])(
		'binds %s once and captures fast starts after enrollment',
		async (tab) => {
			const f = await existingFixture();
			const id = generateUUID();
			expect(await send(f, id, tab)).toMatchObject({
				success: true,
				tabId: 'tab',
				admission: { outcome: 'accepted', runId: 'run:actual-existing' },
			});
			expect(await send(f, id, tab)).toMatchObject({ success: true, tabId: 'tab' });
			expect(f.executeCommand).toHaveBeenCalledTimes(1);
			expect(f.newTab).not.toHaveBeenCalled();
		}
	);
	it('keeps an implicit target pinned across active-tab changes and same-key reconciliation', async () => {
		const f = await existingFixture();
		const original = f.executeCommand.getMockImplementation()!;
		const detail = f.ctx.callbacks.getSessionDetail!('worker')!;
		f.executeCommand.mockImplementation(async (...args: unknown[]) => {
			vi.spyOn(f.ctx.callbacks, 'getSessionDetail').mockReturnValue({
				...detail,
				activeTabId: 'another-tab',
			});
			return original(...args);
		});
		const id = generateUUID();
		expect(await send(f, id)).toMatchObject({ success: true, tabId: 'tab' });
		expect(await send(f, id)).toMatchObject({ success: true, tabId: 'tab' });
		expect(f.executeCommand).toHaveBeenCalledTimes(1);
	});
	it('retains the ordinary busy refusal without creating enrollment or dispatching', async () => {
		const f = await existingFixture();
		const detail = f.ctx.callbacks.getSessionDetail!('worker')!;
		vi.spyOn(f.ctx.callbacks, 'getSessionDetail').mockReturnValue({ ...detail, state: 'busy' });
		handleSendCommand(f.ctx, f.client, {
			type: 'send_command',
			sessionId: 'worker',
			command: 'work',
			inputMode: 'ai',
			tabId: 'tab',
		});
		expect(f.ctx.sendError).toHaveBeenCalledWith(
			f.client,
			expect.stringContaining('busy'),
			expect.anything()
		);
		expect(f.executeCommand).not.toHaveBeenCalled();
		expect(f.newTab).not.toHaveBeenCalled();
		expect(store.readScopeCheckpoint(f.scopeId)).toBeFalsy();
	});

	it('refuses a conversation replacement between enrollment and native spawn', async () => {
		const f = await existingFixture();
		f.executeCommand.mockImplementation(async (...args: unknown[]) => {
			(f.snapshot.sessions[0] as { agentSessionId: string }).agentSessionId = 'replacement';
			expect(() => pianolaNewTabSpawns.claim('worker-ai-tab', args[9] as string)).toThrow(
				'DispatchTargetIdentityChanged'
			);
			return false;
		});
		expect(await send(f, generateUUID(), 'tab')).toMatchObject({
			success: false,
			admission: { outcome: 'rejected' },
		});
	});

	it('retains unknown after lost renderer acknowledgment and never releases again', async () => {
		const f = await existingFixture();
		f.executeCommand.mockRejectedValue(new Error('lost ack'));
		const id = generateUUID();
		expect(await send(f, id, 'tab')).toMatchObject({
			success: false,
			unknown: true,
			admission: { outcome: 'unknown' },
		});
		expect(await send(f, id, 'tab')).toMatchObject({ unknown: true });
		expect(f.executeCommand).toHaveBeenCalledTimes(1);
		pianolaNewTabSpawns.cancelHold('worker', 'tab');
	});
	it('rechecks pause at native start and refuses an unrelated spawn marker', async () => {
		const f = await existingFixture();
		f.executeCommand.mockImplementation(async (...args: unknown[]) => {
			expect(() => pianolaNewTabSpawns.claim('worker-ai-tab')).toThrow('DispatchIdentityMismatch');
			(f.snapshot.sessions[0] as { supervision: { paused: boolean } }).supervision.paused = true;
			expect(() => pianolaNewTabSpawns.claim('worker-ai-tab', args[9] as string)).toThrow();
			return false;
		});
		expect(await send(f, generateUUID(), 'tab')).toMatchObject({
			success: false,
			admission: { outcome: 'rejected' },
		});
	});
});
