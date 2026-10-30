import { nodeSqliteBetterSqlite3Mock } from '../../helpers/nodeSqlite';
vi.mock('better-sqlite3', () => nodeSqliteBetterSqlite3Mock());
import { fakeAnchor } from '../../helpers/mockAnchor';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
	RelayConversations,
	cancelRelayConversationTurn,
	type RelayConversationDeps,
} from '../../../main/plugins/relay-conversations';
import { acquireProviderSessionWriter } from '../../../main/utils/provider-session-writer';
import { createMockSession } from '../../helpers/mockSession';
import type { StoredSession } from '../../../main/stores/types';

const writerGate = vi.hoisted(() => ({
	afterAcquire: undefined as ((processId: string) => void) | undefined,
}));
vi.mock('../../../main/utils/provider-session-writer', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../main/utils/provider-session-writer')>();
	return {
		...actual,
		acquireProviderSessionWriter: vi.fn(
			(...args: Parameters<typeof actual.acquireProviderSessionWriter>) => {
				const acquired = actual.acquireProviderSessionWriter(...args);
				const afterAcquire = writerGate.afterAcquire;
				if (afterAcquire) {
					// Observe fulfillment before the caller's await reaction, returning the
					// exact real promise without a wrapper await or scheduling delay.
					void acquired.then(
						() => afterAcquire(args[1]),
						() => {}
					);
				}
				return acquired;
			}
		),
	};
});

describe('durable Relay conversations', () => {
	let baseDir: string;
	let agent: StoredSession;
	let deps: RelayConversationDeps;
	let host: RelayConversations;
	const opts = { conversationId: 'discord-thread-1', messageId: 'message-1' };
	const send = (text = 'hello', overrides = {}) =>
		host.send(
			'agent',
			text,
			{ ...opts, ...overrides },
			new AbortController().signal,
			undefined,
			() => {}
		);
	beforeEach(() => {
		writerGate.afterAcquire = undefined;
		vi.mocked(acquireProviderSessionWriter).mockClear();
		const root = path.join(process.cwd(), '.maestro', 'scratch');
		fs.mkdirSync(root, { recursive: true });
		baseDir = fs.mkdtempSync(path.join(root, 'relay-continuity-'));
		agent = createMockSession({
			id: 'agent',
			activeTabId: 'desktop',
			activeFileTabId: 'file',
			aiTabs: [],
			unifiedTabOrder: [],
		});
		deps = {
			baseDir,
			receiptAnchor: fakeAnchor({ value: null }),
			getAgent: () => agent,
			updateAgent: (_id, update) => {
				agent = update(agent);
			},
			run: vi.fn(async (_agent, prompt, sessionId) => ({
				success: true,
				response: `answer:${prompt}`,
				sessionId: sessionId ?? `provider:${prompt}`,
			})),
			now: () => 1000,
		};
		host = new RelayConversations(deps);
	});
	afterEach(() => fs.rmSync(baseDir, { recursive: true, force: true }));
	it('separates attachment identity from a text prompt containing the same canonical metadata', async () => {
		const originalAttachments = [{ jobId: 'job', audioId: 'audio' }] as const;
		const text = '{"originalAttachments":[{"audioId":"audio","jobId":"job"}],"prompt":"hello"}';
		await send(text);
		await expect(send('hello', { originalAttachments })).rejects.toThrow(/different content/);
		expect(deps.run).toHaveBeenCalledTimes(1);
	});

	it('rechecks authorization after the final worker persistence before starting a provider', async () => {
		let allowed = true;
		const update = deps.updateAgent;
		deps.updateAgent = (id, apply) => {
			update(id, apply);
			if (agent.aiTabs.some((tab) => tab.relayConversation?.status === 'running')) allowed = false;
		};
		await expect(
			host.send('agent', 'hello', opts, new AbortController().signal, undefined, () => {
				if (!allowed) throw Error('revoked during persistence');
			})
		).rejects.toThrow(/revoked/);
		expect(deps.run).not.toHaveBeenCalled();
	});
	it('rejects completion if uninstall occurs between its two durable reads', async () => {
		await send();
		const target = host as unknown as { read: (key: string) => Promise<unknown> };
		const original = target.read.bind(host);
		vi.spyOn(target, 'read').mockImplementationOnce(async (key) => {
			const value = await original(key);
			queueMicrotask(() => {
				void host.purge();
			});
			return value;
		});
		await expect(host.complete('agent', opts.conversationId, opts.messageId)).rejects.toThrow(
			/purged/
		);
		expect(agent.aiTabs[0].relayConversation?.completedAt).toBeUndefined();
	});
	it('denies new admission while uninstall cleanup is awaiting indexed persistence', async () => {
		await send();
		const target = host as unknown as { store: { mappingKeys: () => Promise<string[]> } };
		const gate = Promise.withResolvers<string[]>();
		vi.spyOn(target.store, 'mappingKeys').mockImplementationOnce(() => gate.promise);
		const purge = host.purge();
		await expect(send('new', { messageId: 'new' })).rejects.toThrow(/cleanup/);
		await expect(host.restore('agent', opts.conversationId, 'provider')).rejects.toThrow(/cleanup/);
		await expect(host.complete('agent', opts.conversationId, opts.messageId)).rejects.toThrow(
			/cleanup/
		);
		gate.resolve([]);
		await purge;
	});
	it('checks current Done authority after durable reads before marking completion', async () => {
		await send();
		let allowed = true;
		const target = host as unknown as { read: (key: string) => Promise<unknown> };
		const original = target.read.bind(host);
		vi.spyOn(target, 'read').mockImplementationOnce(async (key) => {
			const value = await original(key);
			allowed = false;
			return value;
		});
		await expect(
			host.complete('agent', opts.conversationId, opts.messageId, () => {
				if (!allowed) throw Error('Done authorization revoked');
			})
		).rejects.toThrow(/revoked/);
		expect(agent.aiTabs[0].relayConversation?.completedAt).toBeUndefined();
	});
	it('does not patch an existing desktop tab when restore authority changes during mapping', async () => {
		await send();
		agent.aiTabs[0].origin = 'user';
		delete agent.aiTabs[0].relayConversation;
		const target = host as unknown as { mapping: (...args: unknown[]) => Promise<unknown> };
		const original = target.mapping.bind(host);
		let allowed = true;
		vi.spyOn(target, 'mapping').mockImplementationOnce(async (...args) => {
			const value = await original(...args);
			allowed = false;
			return value;
		});
		await expect(
			host.restore('agent', opts.conversationId, 'provider:hello', () => {
				if (!allowed) throw Error('restore revoked');
			})
		).rejects.toThrow(/revoked/);
		expect(agent.aiTabs[0].origin).toBe('user');
		expect(agent.aiTabs[0].relayConversation).toBeUndefined();
	});
	it('creates one real background tab and resumes it across messages and host recreation', async () => {
		const first = await send();
		host = new RelayConversations(deps);
		const second = await send('continue', { messageId: 'message-2', sessionId: first.sessionId });
		expect(second.tabId).toBe(first.tabId);
		expect(agent.aiTabs).toHaveLength(1);
		expect(agent.aiTabs[0]).toMatchObject({
			origin: 'relay',
			agentSessionId: 'provider:hello',
			hidden: false,
		});
		expect(agent.aiTabs[0].logs.map((log: { text: string }) => log.text)).toEqual([
			'hello',
			'answer:hello',
			'continue',
			'answer:continue',
		]);
		expect(agent.unifiedTabOrder).toEqual([{ type: 'ai', id: first.tabId }]);
		expect(agent.activeTabId).toBe('desktop');
		expect(agent.activeFileTabId).toBe('file');
	});
	it('retries a failed first transcript restore and preserves later manual closes', async () => {
		deps.loadTranscript = vi
			.fn()
			.mockRejectedValueOnce(new Error('SSH unavailable'))
			.mockResolvedValue([]);
		await expect(host.restore('agent', opts.conversationId, 'provider')).rejects.toThrow(
			'SSH unavailable'
		);
		expect(agent.aiTabs).toHaveLength(0);
		host = new RelayConversations(deps);
		const restored = await host.restore('agent', opts.conversationId, 'provider');
		expect(agent.aiTabs).toHaveLength(1);
		expect(agent.aiTabs[0].id).toBe(restored.tabId);
		agent.aiTabs = [];
		await host.restore('agent', opts.conversationId, 'provider');
		expect(agent.aiTabs).toHaveLength(0);
		expect(deps.loadTranscript).toHaveBeenCalledTimes(2);
	});
	it('retries first materialization after the sessions write fails and memory is reloaded', async () => {
		deps.loadTranscript = vi.fn().mockResolvedValue([]);
		deps.flush = vi
			.fn()
			.mockRejectedValueOnce(new Error('disk write rejected'))
			.mockResolvedValue(undefined);
		await expect(host.restore('agent', opts.conversationId, 'provider')).rejects.toThrow(
			'disk write rejected'
		);
		const tabId = agent.aiTabs[0].id;
		// Simulate restart: the deferred sessions write failed, while the private ledger reached disk.
		agent.aiTabs = [];
		agent.unifiedTabOrder = [];
		host = new RelayConversations(deps);
		await expect(host.restore('agent', opts.conversationId, 'provider')).resolves.toMatchObject({
			success: true,
			tabId,
		});
		expect(agent.aiTabs[0].id).toBe(tabId);
		expect(deps.loadTranscript).toHaveBeenCalledTimes(2);
		agent.aiTabs = [];
		await host.restore('agent', opts.conversationId, 'provider');
		expect(agent.aiTabs).toHaveLength(0);
	});
	it('retries the same message after an initial session flush fails before provider invocation', async () => {
		deps.flush = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined);
		await expect(send()).rejects.toThrow('disk full');
		expect(deps.run).not.toHaveBeenCalled();
		expect(agent.aiTabs[0].relayConversation.status).toBe('error');
		host = new RelayConversations(deps);
		await expect(send()).resolves.toMatchObject({ success: true });
		expect(deps.run).toHaveBeenCalledTimes(1);
		await expect(send()).resolves.toMatchObject({ replayed: true });
		expect(deps.run).toHaveBeenCalledTimes(1);
	});
	it('retries a cancelled writer wait without abandoning protection after provider invocation', async () => {
		await send();
		const tab = agent.aiTabs[0];
		const release = await acquireProviderSessionWriter(
			'claude-code',
			'independent-writer',
			tab.agentSessionId
		);
		const pending = send('waiting', { messageId: 'message-2' });
		const outcome = pending.catch((error: Error) => error);
		await vi.waitFor(() =>
			expect(
				tab.relayConversation.status === 'queued' ||
					agent.aiTabs[0].relayConversation.status === 'queued'
			).toBe(true)
		);
		expect(cancelRelayConversationTurn(`agent-ai-${tab.id}`)).toBe(true);
		release();
		await outcome;
		await expect(send('waiting', { messageId: 'message-2' })).resolves.toMatchObject({
			success: true,
		});
		expect(deps.run).toHaveBeenCalledTimes(2);
	});
	it('allows a new message after proven no-start failure but never reexecutes its receipt', async () => {
		vi.mocked(deps.run).mockResolvedValueOnce({
			success: false,
			response: null,
			sessionId: null,
			error: 'CLI unavailable',
			executionStarted: false,
		});
		await expect(send()).resolves.toMatchObject({ success: false });
		host = new RelayConversations(deps);
		await expect(send()).resolves.toMatchObject({ replayed: true, success: false });
		await expect(send('retry after fixing CLI', { messageId: 'message-2' })).resolves.toMatchObject(
			{ success: true }
		);
		expect(deps.run).toHaveBeenCalledTimes(2);
	});
	it('retains the uncertainty fence when provider work may have started without a session id', async () => {
		vi.mocked(deps.run).mockResolvedValueOnce({
			success: false,
			response: null,
			sessionId: null,
			error: 'lost provider connection',
		});
		await send();
		await expect(send('next', { messageId: 'message-2' })).rejects.toThrow(
			'Previous Relay execution is uncertain'
		);
		expect(deps.run).toHaveBeenCalledTimes(1);
	});
	it('keeps two Relay threads and their provider contexts separate', async () => {
		const [one, two] = await Promise.all([
			send(),
			send('other', { conversationId: 'discord-thread-2' }),
		]);
		expect(one.tabId).not.toBe(two.tabId);
		expect(one.sessionId).not.toBe(two.sessionId);
		expect(agent.aiTabs).toHaveLength(2);
	});
	it('replays concurrent and late duplicates without another execution or transcript entry', async () => {
		const [first, duplicate] = await Promise.all([send(), send()]);
		expect(duplicate).toMatchObject({ ...first, replayed: true });
		host = new RelayConversations(deps);
		expect(await send()).toMatchObject({ replayed: true });
		expect(deps.run).toHaveBeenCalledTimes(1);
		expect(agent.aiTabs[0].logs).toHaveLength(2);
		await expect(send('changed')).rejects.toThrow(/different content/);
	});
	it('waits for the desktop writer and uses the provider identity the desktop left', async () => {
		const first = await send();
		const release = await acquireProviderSessionWriter(
			'claude-code',
			`agent-ai-${first.tabId}`,
			first.sessionId
		);
		let finished = false;
		const pending = send('relay followup', { messageId: 'message-2' }).then(() => {
			finished = true;
		});
		await vi.waitFor(() => expect(agent.aiTabs[0].relayConversation.status).toBe('queued'));
		expect(finished).toBe(false);
		agent.aiTabs[0].agentSessionId = 'desktop-resumed-provider';
		const releaseOther = await acquireProviderSessionWriter(
			'claude-code',
			'independent-other-tab',
			'desktop-resumed-provider'
		);
		release();
		await new Promise(setImmediate);
		expect(deps.run).toHaveBeenCalledTimes(1);
		agent.aiTabs[0].agentSessionId = 'desktop-latest-provider';
		const releaseLatest = await acquireProviderSessionWriter(
			'claude-code',
			'third-tab',
			'desktop-latest-provider'
		);
		releaseOther();
		await new Promise(setImmediate);
		expect(deps.run).toHaveBeenCalledTimes(1);
		releaseLatest();
		await pending;
		expect(deps.run).toHaveBeenLastCalledWith(
			'agent',
			'relay followup',
			'desktop-latest-provider',
			expect.any(AbortSignal),
			'relay',
			undefined,
			undefined,
			false,
			true
		);
	});
	it('waits for the new provider writer after lease resolution before Relay continuation', async () => {
		const first = await send();
		const processId = `agent-ai-${first.tabId}`;
		const initialProviderId = first.sessionId;
		expect(initialProviderId).toBe('provider:hello');
		expect(agent.aiTabs).toHaveLength(1);
		const newProviderId = 'relay-post-lease-new-provider';
		const releaseNewWriter = await acquireProviderSessionWriter(
			'claude-code',
			'relay-post-lease-independent-writer',
			newProviderId
		);
		let newWriterHeld = true;
		let injected = false;
		let boundary:
			| {
					providerId: string | undefined;
					runnerCalls: number;
					newWriterHeld: boolean;
			  }
			| undefined;
		const order: string[] = [];
		const getAgent = deps.getAgent;
		deps.getAgent = (id) => {
			const current = getAgent(id);
			const tab = current?.aiTabs[0];
			order.push(`store-read:${tab?.agentSessionId ?? 'absent'}`);
			return current;
		};
		const run = vi.mocked(deps.run).getMockImplementation()!;
		vi.mocked(deps.run)
			.mockClear()
			.mockImplementation((...args) => {
				order.push(`runner:${args[2]}`);
				return run(...args);
			});
		writerGate.afterAcquire = (id) => {
			if (id !== processId || injected) return;
			order.push('lease-resolved');
			const tab = agent.aiTabs[0];
			boundary = {
				providerId: tab.agentSessionId,
				runnerCalls: vi.mocked(deps.run).mock.calls.length,
				newWriterHeld,
			};
			tab.agentSessionId = newProviderId;
			injected = true;
			order.push('provider-id-changed');
		};
		const pending = send('relay post-lease followup', { messageId: 'message-2' });
		// Attach a rejection handler immediately so a failed preflight is reported by
		// the awaited outcome rather than an unhandled rejection during observation.
		const outcome = pending.then(
			(result) => ({ result }),
			(error: unknown) => ({ error })
		);
		try {
			await vi.waitFor(() => expect(boundary).toBeDefined());
			expect(boundary).toEqual({
				providerId: initialProviderId,
				runnerCalls: 0,
				newWriterHeld: true,
			});
			const resolvedAt = order.indexOf('lease-resolved');
			expect(order[resolvedAt - 1]).toBe(`store-read:${initialProviderId}`);
			expect(order.slice(resolvedAt, resolvedAt + 3)).toEqual([
				'lease-resolved',
				'provider-id-changed',
				`store-read:${newProviderId}`,
			]);
			// Real durable writes follow the caller continuation. Observe either a
			// request for B's actual lease or execution; one event-loop drain alone
			// could falsely pass before those writes finish on the broken caller.
			await vi.waitFor(() =>
				expect(
					vi
						.mocked(acquireProviderSessionWriter)
						.mock.calls.some(
							([, id, providerId]) => id === processId && providerId === newProviderId
						) || vi.mocked(deps.run).mock.calls.length > 0
				).toBe(true)
			);
			expect(newWriterHeld).toBe(true);
			expect(
				deps.run,
				`New provider writer is still held; boundary=${JSON.stringify(boundary)}; order=${JSON.stringify(order)}`
			).not.toHaveBeenCalled();
			order.push('new-writer-released');
			newWriterHeld = false;
			releaseNewWriter();
			await expect(outcome).resolves.toEqual({
				result: expect.objectContaining({ success: true, sessionId: newProviderId }),
			});
			expect(deps.run).toHaveBeenCalledExactlyOnceWith(
				'agent',
				'relay post-lease followup',
				newProviderId,
				expect.any(AbortSignal),
				'relay',
				undefined,
				undefined,
				false,
				true
			);
			expect(order.indexOf(`runner:${newProviderId}`)).toBeGreaterThan(
				order.indexOf('new-writer-released')
			);
		} finally {
			writerGate.afterAcquire = undefined;
			newWriterHeld = false;
			releaseNewWriter();
			await outcome;
		}
	});
	it('cancels while reacquiring a changed provider without executing or leaking a reservation', async () => {
		const first = await send();
		const processId = `agent-ai-${first.tabId}`;
		const releaseTab = await acquireProviderSessionWriter(
			'claude-code',
			processId,
			first.sessionId
		);
		const controller = new AbortController();
		const pending = host.send(
			'agent',
			'cancelled',
			{ ...opts, messageId: 'cancel-message' },
			controller.signal,
			undefined,
			() => {}
		);
		await vi.waitFor(() => expect(agent.aiTabs[0].relayConversation.status).toBe('queued'));
		agent.aiTabs[0].agentSessionId = 'changed-before-abort';
		const releaseOther = await acquireProviderSessionWriter(
			'claude-code',
			'other-tab',
			'changed-before-abort'
		);
		releaseTab();
		await new Promise(setImmediate);
		controller.abort();
		await expect(pending).rejects.toThrow(/cancel/i);
		expect(deps.run).toHaveBeenCalledTimes(1);
		releaseOther();
		const releaseAgain = await acquireProviderSessionWriter(
			'claude-code',
			processId,
			'changed-before-abort'
		);
		releaseAgain();
	});
	it('serializes two messages for one conversation', async () => {
		let resolveRun!: (value: { success: boolean; response: string; sessionId: string }) => void;
		vi.mocked(deps.run).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveRun = resolve;
				})
		);
		const first = send();
		await vi.waitFor(() => expect(resolveRun).toBeTypeOf('function'));
		const next = send('next', { messageId: 'message-2' });
		expect(deps.run).toHaveBeenCalledTimes(1);
		await expect(host.complete('agent', opts.conversationId, opts.messageId)).rejects.toThrow(
			/pending/
		);
		resolveRun({ success: true, response: 'first answer', sessionId: 'shared-provider' });
		await Promise.all([first, next]);
		expect(deps.run).toHaveBeenLastCalledWith(
			'agent',
			'next',
			'shared-provider',
			expect.any(AbortSignal),
			'relay',
			undefined,
			undefined,
			false,
			true
		);
	});
	it('retains an interrupted receipt and fails closed after restart', async () => {
		vi.mocked(deps.run).mockRejectedValueOnce(new Error('connection lost'));
		await expect(send()).rejects.toThrow(/connection lost/);
		host = new RelayConversations(deps);
		await host.reconcileInterrupted();
		expect(await send()).toMatchObject({
			success: false,
			replayed: true,
			error: expect.stringMatching(/interrupted/),
		});
		expect(deps.run).toHaveBeenCalledTimes(1);
		expect(agent.aiTabs[0].relayConversation.status).toBe('error');
	});
	it('requires explicit current completion and reopens an archived conversation with the same tab', async () => {
		const first = await send();
		expect(agent.aiTabs[0].relayConversation.completedAt).toBeUndefined();
		await host.complete('agent', opts.conversationId, opts.messageId);
		expect(agent.aiTabs[0].relayConversation.completedAt).toBe(1000);
		agent.aiTabs[0].hidden = true;
		agent.aiTabs[0].relayConversation.archivedAt = 2000;
		await send('wake', { messageId: 'message-2' });
		expect(agent.aiTabs[0]).toMatchObject({ id: first.tabId, hidden: false });
		expect(agent.aiTabs[0].relayConversation.completedAt).toBeUndefined();
		expect(agent.aiTabs[0].relayConversation.archivedAt).toBeUndefined();
		await expect(host.complete('agent', opts.conversationId, opts.messageId)).rejects.toThrow(
			/stale/
		);
	});
	it('rejects a late completion after desktop conversation input', async () => {
		await send();
		agent.aiTabs[0].logs.push({
			id: 'desktop-user',
			source: 'user',
			text: 'still working',
			timestamp: 2000,
		});
		await expect(host.complete('agent', opts.conversationId, opts.messageId)).rejects.toThrow(
			/stale/
		);
	});
	it('rejects binding the same provider to two conversation ids', async () => {
		const first = await send();
		await expect(
			send('other', { conversationId: 'other-thread', sessionId: first.sessionId })
		).rejects.toThrow(/another Relay conversation/);
		expect(agent.aiTabs).toHaveLength(1);
	});
	it('restores a manually closed conversation from the provider transcript with its original tab id', async () => {
		const first = await send();
		const logs = agent.aiTabs[0].logs;
		agent.aiTabs = [];
		agent.unifiedTabOrder = [];
		deps.loadTranscript = vi.fn(async () => logs);
		await send('reopen', { messageId: 'message-2' });
		expect(agent.aiTabs[0].id).toBe(first.tabId);
		expect(agent.aiTabs[0].logs).toHaveLength(4);
	});
	it('restores only an explicitly mapped old thread and preserves archived and manually closed tabs', async () => {
		deps.loadTranscript = vi.fn(async () => [
			{ id: 'old-user', source: 'user', timestamp: 1, text: 'old request' },
		]);
		const restored = await host.restore('agent', 'old-thread', 'old-provider');
		expect(deps.run).not.toHaveBeenCalled();
		expect(agent.aiTabs[0].logs).toHaveLength(1);
		agent.aiTabs[0].hidden = true;
		agent.aiTabs[0].relayConversation.archivedAt = 1000;
		await host.restore('agent', 'old-thread', 'old-provider');
		expect(agent.aiTabs[0].hidden).toBe(true);
		agent.aiTabs = [];
		await host.restore('agent', 'old-thread', 'old-provider');
		expect(agent.aiTabs).toHaveLength(0);
		expect(restored.tabId).toBeTypeOf('string');
	});
	it('routes the real tab Stop to the headless provider abort signal', async () => {
		vi.mocked(deps.run).mockImplementationOnce(
			(_agent, _prompt, _provider, signal) =>
				new Promise((resolve) => {
					signal!.addEventListener(
						'abort',
						() => resolve({ success: false, response: null, sessionId: null, error: 'cancelled' }),
						{ once: true }
					);
				})
		);
		const pending = send();
		await vi.waitFor(() => expect(agent.aiTabs[0].relayConversation.status).toBe('running'));
		expect(cancelRelayConversationTurn(`agent-ai-${agent.aiTabs[0].id}`)).toBe(true);
		expect(await pending).toMatchObject({ success: false, error: 'cancelled' });
		expect(agent.aiTabs[0].relayConversation.status).toBe('error');
		expect(cancelRelayConversationTurn(`agent-ai-${agent.aiTabs[0].id}`)).toBe(false);
	});
	it('cancels a queued Relay turn before it gets a writer without launching a process', async () => {
		const first = await send();
		const release = await acquireProviderSessionWriter(
			'claude-code',
			`agent-ai-${first.tabId}`,
			first.sessionId
		);
		const pending = send('queued followup', { messageId: 'message-2' });
		const rejection = expect(pending).rejects.toThrow(/cancelled/);
		await vi.waitFor(() => expect(agent.aiTabs[0].relayConversation.status).toBe('queued'));
		expect(cancelRelayConversationTurn(`agent-ai-${first.tabId}`)).toBe(true);
		await rejection;
		expect(deps.run).toHaveBeenCalledTimes(1);
		expect(agent.aiTabs[0].relayConversation.status).toBe('error');
		release();
	});
	it('purges private receipts on uninstall and fences late and queued writes without removing user history', async () => {
		let finish!: (result: { success: boolean; response: string; sessionId: string }) => void;
		vi.mocked(deps.run).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				})
		);
		const pending = send();
		const firstError = expect(pending).rejects.toThrow(/purged/);
		await vi.waitFor(() => expect(agent.aiTabs[0].relayConversation.status).toBe('running'));
		const next = send('queued', { messageId: 'message-2' });
		const queuedError = expect(next).rejects.toThrow(/purged/);
		await host.purge();
		finish({ success: true, response: 'late', sessionId: 'late-provider' });
		await Promise.all([firstError, queuedError]);
		expect(agent.aiTabs).toHaveLength(1);
		expect(agent.aiTabs[0].logs[0].text).toBe('hello');
		expect(agent.aiTabs[0].relayConversation.status).toBe('error');
		expect(fs.existsSync(path.join(baseDir, 'sh.maestro.relay'))).toBe(false);
		expect(deps.run).toHaveBeenCalledTimes(1);
	});
	it('does not resurrect private ledger or tab when restore finishes after uninstall', async () => {
		let finish!: (
			logs: Array<{ id: string; source: string; timestamp: number; text: string }>
		) => void;
		deps.loadTranscript = () =>
			new Promise((resolve) => {
				finish = resolve;
			});
		const pending = host.restore('agent', 'old', 'old-provider');
		const rejection = expect(pending).rejects.toThrow(/purged/);
		await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
		await host.purge();
		finish([{ id: 'old', source: 'user', timestamp: 1, text: 'old' }]);
		await rejection;
		expect(agent.aiTabs).toHaveLength(0);
		expect(fs.existsSync(path.join(baseDir, 'sh.maestro.relay'))).toBe(false);
	});
	it('retains silent late replay, Done and history after bounded response eviction and uninstall', async () => {
		deps.receiptLimits = { responseCount: 1 };
		host = new RelayConversations(deps);
		const first = await send();
		await send('next', { messageId: 'message-2' });
		const replay = await send();
		expect(replay).toMatchObject({
			replayed: true,
			success: true,
			response: null,
			sessionId: first.sessionId,
		});
		expect(deps.run).toHaveBeenCalledTimes(2);
		expect(agent.aiTabs[0].logs).toHaveLength(4);
		await send('other', { messageId: 'message-3', conversationId: 'other-thread' });
		await host.complete('agent', opts.conversationId, 'message-2');
		expect(agent.aiTabs[0].relayConversation.completedAt).toBe(1000);
		await host.purge();
		agent.aiTabs = [];
		host = new RelayConversations(deps);
		expect(await send()).toMatchObject({ replayed: true, response: null });
		expect(deps.run).toHaveBeenCalledTimes(3);
		expect(agent.aiTabs).toHaveLength(0);
	});
	it('refuses new work at durable fence capacity while replay and existing continuation stay safe', async () => {
		deps.receiptLimits = { messages: 2 };
		host = new RelayConversations(deps);
		await send();
		await send('next', { messageId: 'message-2' });
		await expect(send('overflow', { messageId: 'message-3' })).rejects.toThrow(/capacity/);
		expect(await send()).toMatchObject({ replayed: true });
		expect(deps.run).toHaveBeenCalledTimes(2);
	});
	it('refuses a fresh provider before execution when permanent bindings fill after uninstall', async () => {
		deps.receiptLimits = { mappings: 1 };
		host = new RelayConversations(deps);
		await send();
		await host.purge();
		await expect(send('another', { conversationId: 'other', messageId: 'other' })).rejects.toThrow(
			/capacity/
		);
		expect(deps.run).toHaveBeenCalledTimes(1);
	});
	it('refuses physical outcome exhaustion before invoking the provider', async () => {
		deps.receiptLimits = { pages: 128 };
		host = new RelayConversations(deps);
		await expect(send()).rejects.toThrow(/physical.*capacity/);
		expect(deps.run).not.toHaveBeenCalled();
	});
	it('flushes the provider answer before a failing post-run ledger commit and never executes its receipt again', async () => {
		const store = (
			host as unknown as { store: import('../../../main/plugins/relay-ledger').RelayLedger }
		).store;
		const flush = vi.fn(async () => {});
		deps.flush = flush;
		const finish = store.finishTurn.bind(store);
		vi.spyOn(store, 'finishTurn').mockImplementationOnce((...args) => {
			expect(flush).toHaveBeenCalled();
			expect(agent.aiTabs[0].logs.some((log) => log.text === 'answer:hello')).toBe(true);
			throw Error('post-provider filesystem unavailable');
		});
		await expect(send()).rejects.toThrow(/post-provider/);
		expect(agent.aiTabs[0].logs.some((log) => log.text === 'answer:hello')).toBe(true);
		vi.spyOn(store, 'finishTurn').mockImplementation(finish);
		expect(await send()).toMatchObject({ replayed: true, success: false });
		expect(deps.run).toHaveBeenCalledTimes(1);
	});
	it('releases binding reservations for proven preflight refusals before a later valid first turn', async () => {
		deps.receiptLimits = { mappings: 1 };
		host = new RelayConversations(deps);
		vi.mocked(deps.run).mockResolvedValueOnce({
			success: false,
			response: null,
			sessionId: null,
			error: 'CLI missing',
			executionStarted: false,
		});
		expect(await send()).toMatchObject({ success: false });
		expect(await send('valid', { messageId: 'next' })).toMatchObject({ success: true });
		expect(deps.run).toHaveBeenCalledTimes(2);
	});
	it('releases abandoned physical reservations at restart without making their receipts executable', async () => {
		deps.receiptLimits = { pages: 768 };
		host = new RelayConversations(deps);
		const target = host as unknown as {
			store: import('../../../main/plugins/relay-ledger').RelayLedger;
		};
		target.store.reserveTurn(
			'abandoned',
			JSON.stringify({ promptHash: 'h', messageId: 'old' }),
			'old-map',
			JSON.stringify({
				agentId: 'agent',
				tabId: 'old-tab',
				conversationId: 'old-thread',
				pendingReceiptKey: 'abandoned',
				interrupted: true,
			})
		);
		await host.reconcileInterrupted();
		expect(JSON.parse(target.store.get('abandoned')!).result.success).toBe(false);
		expect(await send()).toMatchObject({ success: true });
	});
	it('does not reconcile an active live Relay writer into a restart error', async () => {
		const result = Promise.withResolvers<Awaited<ReturnType<typeof deps.run>>>();
		vi.mocked(deps.run).mockReturnValueOnce(result.promise);
		const running = send();
		try {
			await vi.waitFor(() => expect(deps.run).toHaveBeenCalled());
			await host.reconcileInterrupted();
			expect(agent.aiTabs[0].relayConversation?.status).toBe('running');
		} finally {
			result.resolve({ success: true, response: 'finished', sessionId: 'provider' });
			await running;
		}
	});
});
