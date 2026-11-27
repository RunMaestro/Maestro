/**
 * Tests for `services/hostedQueuedTurn.ts`: a turn queued on this machine (a snooze, a review, a
 * web client, `maestro-cli dispatch --queue`) reaches the machine that runs the agent's turns in
 * every mode. A local and an SSH agent keep it in this queue for the drain to spawn; a hosted
 * agent's item goes to its host at once (`enqueuePromptForTab()`), and an item a drain takes
 * (`agentStore.processQueuedItem`) goes there instead of a spawn main would refuse.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sendCrossAgentRequest } = vi.hoisted(() => ({ sendCrossAgentRequest: vi.fn() }));
vi.mock('../../../renderer/hooks/agent/useCrossAgentDispatch', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/hooks/agent/useCrossAgentDispatch')>()),
	sendCrossAgentRequest: (...args: unknown[]) => sendCrossAgentRequest(...args),
}));

import {
	handQueuedItemToHost,
	isQueuedItemForHost,
	queuedItemHostText,
} from '../../../renderer/services/hostedQueuedTurn';
import { enqueuePromptForTab } from '../../../renderer/services/queuedPrompt';
import { loadCrossAgentConsultPrompts } from '../../../renderer/services/crossAgentConsultHold';
import {
	dropMentionHandoffs,
	followHostedHandoffs,
	HOST_QUEUE_START_GRACE_MS,
	hostedHandoffStep,
	hostedHandoffTurn,
	nextHostedHandoffDeadline,
	resetHostEntryClaims,
} from '../../../renderer/services/crossAgentHandoff';
import {
	dropStoppedHostStartMentions,
	fireHostStartedMentions,
	HOST_START_MENTION_TTL_MS,
	nextHostStartDeadline,
	pruneHostStartedMentions,
	settleStoppedHostStartMentions,
} from '../../../renderer/services/hostedQueuedTurn';
import { useAgentStore } from '../../../renderer/stores/agentStore';
import { usePeerMirrorStore } from '../../../renderer/stores/peerMirrorStore';
import {
	getRetryEntry,
	registerAgentErrorSurfacer,
	registerDispatchDepsProvider,
	scheduleRetryForError,
	useRetryStore,
} from '../../../renderer/stores/retryStore';
import { parseSessionId } from '../../../renderer/utils/sessionIdParser';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import type { LogEntry, QueuedItem } from '../../../renderer/types';
import type { QueueExit } from '../../../shared/maestro-lib/client/types';
import {
	createMirroredPeer,
	replacePeerAgents,
} from '../../../shared/maestro-lib/client/peer-mirror';
import {
	AGENT_MODES,
	createMockSession,
	createModeSession,
	resetStores,
	type AgentMode,
} from '../../helpers';
import { createMockAITab } from '../../helpers/mockTab';

const maestro = window.maestro as unknown as Record<string, unknown>;
const act$ = vi.fn();
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The host's own record of its tab: busy with a turn that started at `busySince` (host clock). */
function hydrateHost(busySince?: number) {
	const { peer } = replacePeerAgents(
		createMirroredPeer({ peerId: 'box', remoteId: 'r1', name: 'Box' }),
		[
			{
				id: 'h1',
				name: 'Docs',
				toolType: 'claude-code',
				aiTabs: [
					busySince === undefined
						? { id: 't1' }
						: { id: 't1', state: 'busy', thinkingStartTime: busySince },
				],
			},
		],
		[],
		1
	);
	usePeerMirrorStore.getState().hydrate([{ ...peer, connection: 'connected' }]);
}

/** What the mirror holds of the host's queue for `h1` now: the items waiting, and the exits named. */
function mirrorHostQueue(itemIds: string[], exits?: QueueExit[]) {
	usePeerMirrorStore.setState((state) => {
		const peer = state.peers.box;
		return {
			peers: {
				...state.peers,
				box: {
					...peer,
					queues: {
						h1: itemIds.map((itemId) => ({
							itemId,
							tabId: 't1',
							queuedAt: 1,
							kind: 'message' as const,
							text: 'look into the cache with @Backend',
							paused: false,
						})),
					},
					...(exits ? { queueExits: { h1: exits } } : {}),
				},
			},
		};
	});
}

function seed(mode: AgentMode, executionQueue: QueuedItem[] = []) {
	const session = createModeSession(mode, {
		id: 'row',
		name: 'Docs',
		state: 'idle',
		activeTabId: 't1',
		aiTabs: [createMockAITab({ id: 't1', customModel: 'opus' })],
		executionQueue,
	});
	useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
	return session;
}

const queue = () => useSessionStore.getState().sessions[0].executionQueue ?? [];
const sends = () => act$.mock.calls.filter(([, , action]) => action?.kind === 'send');

/** A host's word that `itemId` left its queue to run. */
const started = (itemId: string): QueueExit => ({ itemId, exit: 'started' });

const queuedMessage = (overrides: Partial<QueuedItem> = {}): QueuedItem => ({
	id: 'q1',
	timestamp: 1,
	tabId: 't1',
	type: 'message',
	text: 'wake up',
	...overrides,
});

// A host entry matched to one message in a test is never held for another test's message.
beforeEach(() => resetHostEntryClaims());

describe('hostedQueuedTurn', () => {
	beforeEach(() => {
		resetStores(usePeerMirrorStore, useSessionStore);
		useSettingsStore.setState({ federationHostedAgents: true });
		act$.mockReset();
		act$.mockResolvedValue({ ok: true, result: { kind: 'send', receipt: { status: 'started' } } });
		maestro.federation = { act: act$ };
		hydrateHost();
	});

	afterEach(() => {
		delete maestro.federation;
	});

	it('sends a command as the typed text, so the host resolves it as it does a typed one', () => {
		expect(queuedItemHostText(queuedMessage())).toBe('wake up');
		expect(
			queuedItemHostText(
				queuedMessage({ type: 'command', text: undefined, command: '/commit', commandArgs: 'fix' })
			)
		).toBe('/commit fix');
		expect(
			queuedItemHostText(
				queuedMessage({ type: 'command', text: undefined, command: '/commit', commandArgs: '' })
			)
		).toBe('/commit');
	});

	it.each(AGENT_MODES)(
		'%s: a queued prompt reaches the machine that runs the agent turns',
		async (mode) => {
			seed(mode);
			const item = enqueuePromptForTab({ sessionId: 'row', tabId: 't1', text: 'wake up' });
			await flush();

			// Same answer to the caller in every mode: the prompt was taken, for tab t1.
			expect(item).toMatchObject({ tabId: 't1', type: 'message', text: 'wake up' });
			if (mode === 'hosted') {
				// The host has it; nothing waits here for a drain that would spawn on this machine.
				expect(queue()).toEqual([]);
				expect(sends()).toEqual([
					['box', 'h1', expect.objectContaining({ kind: 'send', tabId: 't1', text: 'wake up' })],
				]);
				expect(sends()[0][2].overrides).toMatchObject({ model: 'opus' });
			} else {
				expect(queue().map((queued) => queued.id)).toEqual([item!.id]);
				expect(sends()).toEqual([]);
			}
		}
	);

	// Parity round 3, N1: a queued prompt handed to the host names its tab as the local drain names
	// the tab it runs (`queuedItemNamingText()`); a command names nothing in either.
	it('hosted: a queued prompt handed to the host names its tab, a command does not', async () => {
		const generateTabName = vi.fn().mockResolvedValue('Wake Up Call');
		maestro.tabNaming = { generateTabName };
		useSettingsStore.setState({ automaticTabNamingEnabled: true });
		try {
			seed('hosted');
			useSessionStore.setState((state) => ({
				sessions: state.sessions.map((s) => ({
					...s,
					aiTabs: s.aiTabs.map((tab) => ({ ...tab, name: null })),
				})),
			}));
			enqueuePromptForTab({
				sessionId: 'row',
				tabId: 't1',
				text: '/commit fix',
				slashCommand: true,
			});
			await flush();
			expect(generateTabName).not.toHaveBeenCalled();

			enqueuePromptForTab({ sessionId: 'row', tabId: 't1', text: 'wake up' });
			await flush();
			expect(generateTabName).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ userMessage: 'wake up' })
			);
			expect(useSessionStore.getState().sessions[0].aiTabs[0].name).toBe('Wake Up Call');
			expect(act$).toHaveBeenCalledWith('box', 'h1', {
				kind: 'rename-tab',
				tabId: 't1',
				name: 'Wake Up Call',
			});
		} finally {
			useSettingsStore.setState({ automaticTabNamingEnabled: false });
			delete maestro.tabNaming;
		}
	});

	it.each(AGENT_MODES)('%s: only a hosted agent hands its queued items to a host', (mode) => {
		const session = seed(mode);
		expect(isQueuedItemForHost(session, queuedMessage())).toBe(mode === 'hosted');
		// A host queue card is already the host's, and an admission is its native owner's.
		expect(isQueuedItemForHost(session, queuedMessage({ hostQueued: true }))).toBe(false);
		expect(isQueuedItemForHost(session, queuedMessage({ pendingAdmissionId: 'a1' }))).toBe(false);
	});

	it('works as an SSH agent while hosted agents are switched off', async () => {
		useSettingsStore.setState({ federationHostedAgents: false });
		seed('hosted');
		const item = enqueuePromptForTab({ sessionId: 'row', tabId: 't1', text: 'wake up' });
		await flush();
		expect(queue().map((queued) => queued.id)).toEqual([item!.id]);
		expect(sends()).toEqual([]);
	});

	it('keeps a refused prompt in its place, held, so Resume sends it again', async () => {
		act$.mockResolvedValue({ ok: false, error: 'host is down' });
		seed('hosted', [queuedMessage({ id: 'older', paused: true })]);
		const item = enqueuePromptForTab({ sessionId: 'row', tabId: 't1', text: 'wake up' });
		await flush();
		expect(sends()).toHaveLength(1);
		expect(queue().map((queued) => [queued.id, queued.paused])).toEqual([
			['older', true],
			[item!.id, true],
		]);
	});

	it('sends a held item held, so the host queues it paused', async () => {
		seed('hosted', [queuedMessage({ paused: true })]);
		expect(handQueuedItemToHost('row', 'q1')).toBe(true);
		await flush();
		expect(sends()[0][2]).toMatchObject({ kind: 'send', held: true });
		expect(queue()).toEqual([]);
	});

	it('hands an item a drain took to the host instead of spawning here', async () => {
		const spawn = vi.mocked(window.maestro.process.spawn);
		spawn.mockClear();
		seed('hosted');
		const item = queuedMessage({ text: 'left from before the move' });
		const dispatched = await useAgentStore.getState().processQueuedItem('row', item, {
			conductorProfile: '',
			customAICommands: [],
			speckitCommands: [],
			openspecCommands: [],
		});
		expect(dispatched).toBe(true);
		expect(spawn).not.toHaveBeenCalled();
		expect(sends()[0][2]).toMatchObject({
			kind: 'send',
			tabId: 't1',
			text: 'left from before the move',
		});
		expect(queue()).toEqual([]);
	});

	it('runs a held card the user force-sends on the host now, not parked there held', async () => {
		seed('hosted');
		const item = queuedMessage({ text: 'refused earlier', paused: true });
		const dispatched = await useAgentStore.getState().processQueuedItem('row', item, {
			conductorProfile: '',
			customAICommands: [],
			speckitCommands: [],
			openspecCommands: [],
		});
		expect(dispatched).toBe(true);
		expect(sends()[0][2]).toMatchObject({ kind: 'send', text: 'refused earlier' });
		expect(sends()[0][2].held).not.toBe(true);
		expect(queue()).toEqual([]);
	});

	it('puts a drained item the host refused back at the head of the queue, held', async () => {
		act$.mockResolvedValue({ ok: false, error: 'host is down' });
		seed('hosted', [queuedMessage({ id: 'next' })]);
		const dispatched = await useAgentStore.getState().processQueuedItem('row', queuedMessage(), {
			conductorProfile: '',
			customAICommands: [],
			speckitCommands: [],
			openspecCommands: [],
		});
		// Nothing for the caller to restore: the queue holds it.
		expect(dispatched).toBe(true);
		expect(queue().map((queued) => [queued.id, queued.paused])).toEqual([
			['q1', true],
			['next', undefined],
		]);
	});
});

// Parity M7: a hosted agent's `@mention` consults from this machine, as a local agent's does (the
// mentioned agent is in this machine's roster). The drain fires it as the turn goes to the host;
// the turn carries the agent-only notes and a released consult's replies there.
describe('hostedQueuedTurn: @mentions (M7)', () => {
	const drainDeps = {
		conductorProfile: '',
		customAICommands: [],
		speckitCommands: [],
		openspecCommands: [],
	};
	const backend = () =>
		createMockSession({ id: 'backend', name: 'Backend', aiTabs: [createMockAITab({ id: 'b1' })] });
	const seedWithBackend = (mode: AgentMode, executionQueue: QueuedItem[] = []) => {
		const session = seed(mode, executionQueue);
		useSessionStore.setState({ sessions: [session, backend()], groups: [] });
		return session;
	};
	const row = () => useSessionStore.getState().sessions.find((s) => s.id === 'row')!;

	beforeEach(async () => {
		resetStores(usePeerMirrorStore, useSessionStore);
		useSettingsStore.setState({ federationHostedAgents: true });
		act$.mockReset();
		act$.mockResolvedValue({ ok: true, result: { kind: 'send', receipt: { status: 'started' } } });
		maestro.federation = { act: act$ };
		const templates: Record<string, string> = {
			'cross-agent-consult-pending': 'Consulting {{CONSULTED_AGENTS}}: do not finish yet.',
			'cross-agent-consult-reply': 'Replies:\n{{CONSULT_REPLIES}}',
			'cross-agent-consult-first': 'First:\n{{CONSULT_REPLIES}}',
			'cross-agent-handoff-pending': 'Your answer goes to {{HANDOFF_AGENTS}}.',
		};
		maestro.prompts = {
			...(maestro.prompts as object),
			get: vi.fn(async (id: string) => ({ success: true, content: templates[id] })),
		};
		await loadCrossAgentConsultPrompts(true);
		sendCrossAgentRequest.mockReset();
		hydrateHost();
	});

	afterEach(() => {
		delete maestro.federation;
	});

	it.each(AGENT_MODES)(
		'%s: a drained message addressed only at a mentioned agent consults it and runs no turn',
		async (mode) => {
			const spawn = vi.mocked(window.maestro.process.spawn);
			spawn.mockClear();
			seedWithBackend(mode);
			const item = queuedMessage({
				text: '@Backend does this look right?',
				crossAgentMention: true,
				crossAgentOnly: true,
			});
			const dispatched = await useAgentStore.getState().processQueuedItem('row', item, drainDeps);
			await flush();

			expect(dispatched).toBe(true);
			expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
			expect(sendCrossAgentRequest.mock.calls[0][0]).toMatchObject({
				sourceSessionId: 'row',
				sourceTabId: 't1',
				targetSessionId: 'backend',
				userPrompt: '@Backend does this look right?',
			});
			expect(spawn).not.toHaveBeenCalled();
			expect(sends()).toEqual([]);
		}
	);

	it('hosted: a mid-sentence mention sends the turn with the pending note, then consults and holds the tab', async () => {
		seedWithBackend('hosted');
		const item = queuedMessage({
			text: 'look into the cache with @Backend',
			crossAgentMention: true,
			mentionRouting: 'parallel',
		});
		await useAgentStore.getState().processQueuedItem('row', item, drainDeps);
		await flush();

		// The host's transcript shows the message alone; the note is agent-only.
		expect(sends()).toHaveLength(1);
		expect(sends()[0][2]).toMatchObject({
			kind: 'send',
			text: 'look into the cache with @Backend',
			agentNotes: 'Consulting Backend: do not finish yet.',
		});
		expect(sends()[0][2].agentContext).toBeUndefined();
		expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
		expect(sendCrossAgentRequest.mock.calls[0][0]).toMatchObject({ targetSessionId: 'backend' });
		// The same hold a local turn waits behind, at the head of this machine's queue.
		expect(queue()[0].awaitingConsult?.pending).toEqual([
			{ targetSessionId: 'backend', targetAgentName: 'Backend' },
		]);
	});

	it('hosted: a turn the host refuses consults nobody, and comes back held with its mention', async () => {
		act$.mockResolvedValue({ ok: false, error: 'host is down' });
		seedWithBackend('hosted');
		const item = queuedMessage({
			text: 'look into the cache with @Backend',
			crossAgentMention: true,
			mentionRouting: 'parallel',
		});
		await useAgentStore.getState().processQueuedItem('row', item, drainDeps);
		await flush();

		expect(sendCrossAgentRequest).not.toHaveBeenCalled();
		expect(queue()).toHaveLength(1);
		expect(queue()[0]).toMatchObject({ id: 'q1', paused: true, crossAgentMention: true });
	});

	// R32: a mention in a message kept while the link is down runs its consult at once, from this
	// machine, as an SSH agent's dispatch consults before its spawn fails; once, across the retry.
	describe('a mention kept while the link is down (R32)', () => {
		const setConnection = (connection: 'connected' | 'lost') => {
			const peer = usePeerMirrorStore.getState().peers.box;
			usePeerMirrorStore.getState().hydrate([{ ...peer, connection }]);
		};
		const keptItem = () => queue().find((queued) => queued.id === 'q1')!;
		const parallel = () =>
			queuedMessage({
				text: 'look into the cache with @Backend',
				crossAgentMention: true,
				mentionRouting: 'parallel',
			});

		beforeEach(() => {
			useRetryStore.setState({ retries: {}, outages: {} });
			registerAgentErrorSurfacer((processSessionId, error) => {
				const parsed = parseSessionId(processSessionId);
				scheduleRetryForError(parsed.baseSessionId, parsed.tabId as string, error);
			});
			registerDispatchDepsProvider(() => ({}) as never);
		});

		afterEach(() => {
			registerAgentErrorSurfacer(null);
			registerDispatchDepsProvider(null);
			useRetryStore.setState({ retries: {}, outages: {} });
		});

		it.each(['ssh', 'hosted'] as const)(
			'%s: consults the mentioned agent at once, from this machine',
			async (mode) => {
				seedWithBackend(mode);
				if (mode === 'hosted') setConnection('lost');
				// An SSH turn fails after its consult ran (its spawn cannot reach the remote); here the
				// spawn step has no agent config and throws, which stands in for that failure.
				await useAgentStore
					.getState()
					.processQueuedItem('row', parallel(), drainDeps)
					.catch(() => undefined);
				await flush();

				expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
				expect(sendCrossAgentRequest.mock.calls[0][0]).toMatchObject({
					sourceSessionId: 'row',
					sourceTabId: 't1',
					targetSessionId: 'backend',
				});
			}
		);

		it('hosted: the kept message carries the consult notes and goes once the host is back, consulting nobody again', async () => {
			seedWithBackend('hosted');
			setConnection('lost');
			await useAgentStore.getState().processQueuedItem('row', parallel(), drainDeps);
			await flush();

			expect(sends()).toHaveLength(0);
			expect(getRetryEntry('row', 't1')).toMatchObject({ heldItemId: 'q1' });
			// The kept message first, then the hold its consult's replies release into, as for SSH.
			expect(queue().map((queued) => [queued.id === 'q1', !!queued.awaitingConsult])).toEqual([
				[true, false],
				[false, true],
			]);
			// What persists (a restart) and what Force Send after a Stop takes: no mention, the notes.
			expect(keptItem()).toMatchObject({ agentNotes: 'Consulting Backend: do not finish yet.' });
			expect(keptItem().crossAgentMention).toBeUndefined();

			// Refused again: still no second consult.
			await useAgentStore.getState().processQueuedItem('row', keptItem(), drainDeps);
			await flush();
			expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);

			setConnection('connected');
			const entry = getRetryEntry('row', 't1')!;
			useRetryStore.getState().setEntry(entry.key, { ...entry, status: 'in-flight' });
			await useAgentStore.getState().processQueuedItem('row', keptItem(), drainDeps);
			await flush();

			expect(sends()).toHaveLength(1);
			expect(sends()[0][2]).toMatchObject({
				kind: 'send',
				text: 'look into the cache with @Backend',
				agentNotes: 'Consulting Backend: do not finish yet.',
			});
			expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
		});

		// CodeRabbit on #2167: a consult-first message has one owner of its send, its consult's hold,
		// as for SSH (the drain consults and waits). No retry is kept beside it: that would send it
		// before the replies, and the hold would send it again after them.
		it('hosted: a consult-first message waits on its consult hold, with no retry of its own', async () => {
			seedWithBackend('hosted');
			setConnection('lost');
			const item = queuedMessage({
				text: 'ask @Backend about the cache first',
				crossAgentMention: true,
				mentionRouting: 'consult-first',
			});
			await useAgentStore.getState().processQueuedItem('row', item, drainDeps);
			await flush();

			expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
			expect(sends()).toHaveLength(0);
			expect(getRetryEntry('row', 't1')).toBeUndefined();
			// The one copy of the message: on the hold, released with the replies as a plain message.
			expect(queue().map((queued) => queued.awaitingConsult?.deferred?.message)).toEqual([
				'ask @Backend about the cache first',
			]);
		});

		it('hosted: a kept hand-off keeps its mention and is armed when the host takes the turn', async () => {
			seedWithBackend('hosted');
			setConnection('lost');
			const item = queuedMessage({
				text: 'look into the cache, then tell @Backend',
				crossAgentMention: true,
				mentionRouting: 'handoff',
			});
			await useAgentStore.getState().processQueuedItem('row', item, drainDeps);
			await flush();

			// Nobody is consulted before the turn has an answer, as for SSH.
			expect(sendCrossAgentRequest).not.toHaveBeenCalled();
			expect(keptItem()).toMatchObject({ crossAgentMention: true, mentionRouting: 'handoff' });

			setConnection('connected');
			const entry = getRetryEntry('row', 't1')!;
			useRetryStore.getState().setEntry(entry.key, { ...entry, status: 'in-flight' });
			await useAgentStore.getState().processQueuedItem('row', keptItem(), drainDeps);
			await flush();

			expect(sends()).toHaveLength(1);
			expect(sends()[0][2].agentNotes).toBe('Your answer goes to Backend.');
			expect(row().aiTabs[0].pendingMentionHandoff?.hostTurn).toMatchObject({ stage: 'sent' });
		});
	});

	it("hosted: a released consult's replies ride to the host as agent-only context", async () => {
		seedWithBackend('hosted');
		const item = queuedMessage({
			text: 'Backend replied. Finish your answer with what came back.',
			agentContext: 'Replies:\nBackend: the cache is fine.',
		});
		await useAgentStore.getState().processQueuedItem('row', item, drainDeps);
		await flush();

		expect(sends()[0][2]).toMatchObject({
			kind: 'send',
			text: 'Backend replied. Finish your answer with what came back.',
			agentContext: 'Replies:\nBackend: the cache is fine.',
		});
		expect(sendCrossAgentRequest).not.toHaveBeenCalled();
	});

	it("hosted: a hand-off goes out when the host's turn ends, with its answer", async () => {
		seedWithBackend('hosted');
		const item = queuedMessage({
			text: 'look into the cache, then tell @Backend',
			crossAgentMention: true,
			mentionRouting: 'handoff',
		});
		await useAgentStore.getState().processQueuedItem('row', item, drainDeps);
		await flush();

		expect(sends()[0][2].agentNotes).toBe('Your answer goes to Backend.');
		// Nobody is consulted yet: the answer does not exist.
		expect(sendCrossAgentRequest).not.toHaveBeenCalled();
		expect(row().aiTabs[0].pendingMentionHandoff?.hostTurn).toEqual({ stage: 'sent' });

		// The host's tab runs the turn...
		useSessionStore.setState((state) => ({
			sessions: state.sessions.map((s) =>
				s.id === 'row' ? { ...s, aiTabs: s.aiTabs.map((t) => ({ ...t, state: 'busy' })) } : s
			),
		}));
		followHostedHandoffs(row());
		expect(row().aiTabs[0].pendingMentionHandoff?.hostTurn).toMatchObject({ stage: 'running' });
		expect(sendCrossAgentRequest).not.toHaveBeenCalled();

		// ...and ends with an answer.
		useSessionStore.setState((state) => ({
			sessions: state.sessions.map((s) =>
				s.id === 'row'
					? {
							...s,
							aiTabs: s.aiTabs.map((t) => ({
								...t,
								state: 'idle',
								logs: [
									{ id: 'u', timestamp: 1, source: 'user', text: item.text! },
									{ id: 'a', timestamp: 2, source: 'ai', text: 'The cache is stale.' },
								],
							})),
						}
					: s
			),
		}));
		followHostedHandoffs(row());
		expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
		expect(sendCrossAgentRequest.mock.calls[0][0]).toMatchObject({
			targetSessionId: 'backend',
			userPrompt: 'look into the cache, then tell @Backend',
			handoffAnswer: 'The cache is stale.',
		});
		expect(row().aiTabs[0].pendingMentionHandoff).toBeUndefined();
	});

	it('a hand-off waits while its turn still sits in the host queue, and hands off the saved answer', () => {
		const handoff = (hostTurn: object) => ({ targets: [], message: 'm', hostTurn }) as never;
		const answer = [
			{ id: 'u', timestamp: 1, source: 'user' as const, text: 'm' },
			{ id: 'a', timestamp: 2, source: 'ai' as const, text: 'done' },
		];
		// Queued behind the turn that started at 100.
		const queued = { stage: 'sent', queueItemId: 'h9', turnStartedAt: 100 };
		const busyWith = (thinkingStartTime: number, hostTurn: object, logs: LogEntry[] = []) => ({
			state: 'busy' as const,
			thinkingStartTime,
			logs,
			pendingMentionHandoff: handoff(hostTurn),
		});
		// What the host streams as its turn starts: the message's own user entry.
		const ownEntry: LogEntry[] = [
			{ id: 'u-live', timestamp: 3, source: 'user', text: 'm', hostLive: true },
		];
		const otherEntry: LogEntry[] = [
			{ id: 'o-live', timestamp: 3, source: 'user', text: 'another message', hostLive: true },
		];
		expect(hostedHandoffStep(busyWith(100, queued), new Set(['h9']))).toBe('seen-queued');
		const seen = { ...queued, seenQueued: true };
		expect(hostedHandoffStep(busyWith(100, seen), new Set(['h9']))).toBe('wait');
		// The turn ahead is recorded once: a busy state that lands before the queue change is this
		// item's own turn, never a new turn ahead (M14).
		expect(hostedHandoffStep(busyWith(150, seen), new Set(['h9']))).toBe('wait');
		// Its own turn started: the host wrote its message on the tab.
		expect(hostedHandoffStep(busyWith(200, seen, ownEntry), new Set())).toBe('running');
		// Gone from the queue while the turn ahead still runs, or with the tab idle, or while another
		// message's turn runs: its own entry may still come, so it waits a short time (any number of
		// syncs). Another message's start is never its start (CodeRabbit on #2148).
		expect(hostedHandoffStep(busyWith(100, seen), new Set())).toBe('left-queue');
		expect(hostedHandoffStep({ ...busyWith(100, seen), state: 'idle' }, new Set())).toBe(
			'left-queue'
		);
		expect(hostedHandoffStep(busyWith(200, seen, otherEntry), new Set())).toBe('left-queue');
		const left = { ...seen, goneAt: 1_000 };
		const soon = 1_000 + HOST_QUEUE_START_GRACE_MS;
		const late = soon + 1;
		expect(hostedHandoffStep(busyWith(100, left), new Set(), false, undefined, soon)).toBe('wait');
		expect(
			hostedHandoffStep(busyWith(200, left, otherEntry), new Set(), false, undefined, soon)
		).toBe('wait');
		expect(
			hostedHandoffStep(busyWith(200, left, ownEntry), new Set(), false, undefined, soon)
		).toBe('running');
		// Still on the turn it was queued behind after the window: it was removed.
		expect(hostedHandoffStep(busyWith(100, left), new Set(), false, undefined, late)).toBe('drop');
		// Another message's turn after the window: that turn's end and saved transcript decide.
		const idleLate = (logs: LogEntry[], current: boolean) =>
			hostedHandoffStep(
				{ ...busyWith(200, left, logs), state: 'idle' },
				new Set(),
				current,
				undefined,
				late
			);
		expect(
			hostedHandoffStep(busyWith(200, left, otherEntry), new Set(), false, undefined, late)
		).toBe('wait');
		expect(idleLate(otherEntry, false)).toBe('read');
		expect(idleLate(otherEntry, true)).toBe('drop');
		// Its turn ran and ended while this window was not attached: the saved transcript shows its
		// message, so it runs, and its own answer releases it (CodeRabbit on #2148).
		const ranWhileDetached: LogEntry[] = [
			{ id: 'u', timestamp: 3, source: 'user', text: 'm' },
			{ id: 'a', timestamp: 4, source: 'ai', text: 'done' },
		];
		expect(idleLate(ranWhileDetached, true)).toBe('running');
		// The cases below are other hand-offs on fresh tabs that reuse the entry ids above: entry `u`
		// now belongs to h9's message, so forget that before them.
		resetHostEntryClaims();
		// The turn ended but the tab still draws what it streamed: read the saved transcript first.
		expect(
			hostedHandoffStep(
				{
					state: 'idle',
					logs: [{ ...answer[1], hostLive: true }],
					pendingMentionHandoff: handoff({ stage: 'running' }),
				},
				new Set()
			)
		).toBe('read');
		expect(
			hostedHandoffStep(
				{ state: 'idle', logs: answer, pendingMentionHandoff: handoff({ stage: 'running' }) },
				new Set()
			)
		).toBe('release');
		// A turn so short the tab never read busy: its saved answer after the send releases it...
		expect(
			hostedHandoffStep(
				{ state: 'idle', logs: answer, pendingMentionHandoff: handoff({ stage: 'sent' }) },
				new Set()
			)
		).toBe('release');
		// ...but an idle tab with nothing new since the send is a turn that has not started (with a
		// current transcript), or one whose answer the host has not been read for yet.
		const notYet = {
			state: 'idle' as const,
			logs: answer,
			pendingMentionHandoff: handoff({ stage: 'sent', afterEntryId: 'a' }),
		};
		expect(hostedHandoffStep(notYet, new Set(), true)).toBe('wait');
		expect(hostedHandoffStep(notYet, new Set(), false)).toBe('read');
		// A turn that ran but whose answer is not here: read the saved transcript, and release
		// (the release notes "no answer") only once that transcript is current.
		const ranNoAnswer = {
			state: 'idle' as const,
			logs: answer,
			pendingMentionHandoff: handoff({ stage: 'running', afterEntryId: 'a' }),
		};
		expect(hostedHandoffStep(ranNoAnswer, new Set(), false)).toBe('read');
		expect(hostedHandoffStep(ranNoAnswer, new Set(), true)).toBe('release');
		// The queue gate holds through `running`: the turn ahead ending is not this turn ending.
		expect(
			hostedHandoffStep(
				{
					state: 'idle',
					logs: answer,
					pendingMentionHandoff: handoff({ stage: 'running', queueItemId: 'h9', seenQueued: true }),
				},
				new Set(['h9']),
				true
			)
		).toBe('wait');
		// What it hands off is this turn's answer, never an earlier one's.
		expect(hostedHandoffTurn(answer, 'a')).toBeNull();
		expect(hostedHandoffTurn(answer, undefined)?.answer).toBe('done');
		// A local hand-off is released by its process exit, never here.
		expect(
			hostedHandoffStep(
				{ state: 'idle', logs: answer, pendingMentionHandoff: { targets: [], message: 'm' } },
				new Set()
			)
		).toBe('wait');
	});

	it("hosted: a hand-off asks for the saved transcript while the tab still draws the turn's stream", () => {
		seedWithBackend('hosted');
		useSessionStore.setState((state) => ({
			sessions: state.sessions.map((s) =>
				s.id === 'row'
					? {
							...s,
							aiTabs: s.aiTabs.map((t) => ({
								...t,
								state: 'idle',
								logs: [{ id: 'l', timestamp: 1, source: 'ai', text: 'narration', hostLive: true }],
								pendingMentionHandoff: {
									targets: [{ targetSessionId: 'backend', targetAgentName: 'Backend' }],
									message: 'm',
									hostTurn: { stage: 'running' },
								},
							})),
						}
					: s
			),
		}));
		const read = vi.fn();
		followHostedHandoffs(row(), { read, isCurrent: () => true });
		expect(read).toHaveBeenCalledWith('t1');
		expect(sendCrossAgentRequest).not.toHaveBeenCalled();
		expect(row().aiTabs[0].pendingMentionHandoff).toBeDefined();
	});

	it('hosted: a drained turn runs on the model, effort, and read-only it was queued with', async () => {
		seedWithBackend('hosted');
		const item = queuedMessage({
			text: 'look into the cache with @Backend',
			crossAgentMention: true,
			mentionRouting: 'parallel',
			turnSettings: { model: 'sonnet', effort: 'low' },
			readOnlyMode: true,
		});
		await useAgentStore.getState().processQueuedItem('row', item, drainDeps);
		await flush();
		// The live tab says `opus`; the message keeps what it was queued with.
		expect(sends()[0][2].overrides).toMatchObject({
			model: 'sonnet',
			effort: 'low',
			readOnly: true,
		});
	});

	it('hosted: a turn the host queued consults only once that turn starts', async () => {
		act$.mockResolvedValue({
			ok: true,
			result: {
				kind: 'send',
				receipt: { status: 'queued', itemId: 'h9', position: 1, queueLength: 1 },
			},
		});
		seedWithBackend('hosted');
		const item = queuedMessage({
			text: 'look into the cache with @Backend',
			crossAgentMention: true,
			mentionRouting: 'parallel',
		});
		const withHost = (hostQueued: boolean, thinkingStartTime: number, ran = false) =>
			useSessionStore.setState((current) => ({
				sessions: current.sessions.map((s) =>
					s.id === 'row'
						? {
								...s,
								aiTabs: s.aiTabs.map((t) => ({
									...t,
									state: 'busy',
									thinkingStartTime,
									// Its turn started: the host streams the message's own user entry.
									...(ran
										? {
												logs: [
													...t.logs,
													{
														id: 'u-live',
														timestamp: 3,
														source: 'user' as const,
														text: item.text ?? '',
														hostLive: true,
													},
												],
											}
										: {}),
								})),
								executionQueue: hostQueued
									? [queuedMessage({ id: 'h9', hostQueued: true, text: item.text })]
									: s.executionQueue.filter((q) => !q.hostQueued),
							}
						: s
				),
			}));
		// The turn it is queued behind started at 100.
		withHost(false, 100);
		await useAgentStore.getState().processQueuedItem('row', item, drainDeps);
		await flush();
		expect(sendCrossAgentRequest).not.toHaveBeenCalled();

		withHost(true, 100);
		fireHostStartedMentions(row());
		expect(sendCrossAgentRequest).not.toHaveBeenCalled();
		withHost(false, 200, true);
		fireHostStartedMentions(row());
		expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
		expect(sendCrossAgentRequest.mock.calls[0][0]).toMatchObject({ targetSessionId: 'backend' });
	});

	it('hosted: a queued turn removed from the host queue while the turn ahead runs consults nobody', async () => {
		act$.mockResolvedValue({
			ok: true,
			result: {
				kind: 'send',
				receipt: { status: 'queued', itemId: 'h7', position: 1, queueLength: 1 },
			},
		});
		seedWithBackend('hosted');
		const item = queuedMessage({
			text: 'look into the cache with @Backend',
			crossAgentMention: true,
			mentionRouting: 'parallel',
		});
		const withHost = (hostQueued: boolean, thinkingStartTime: number) =>
			useSessionStore.setState((current) => ({
				sessions: current.sessions.map((s) =>
					s.id === 'row'
						? {
								...s,
								aiTabs: s.aiTabs.map((t) => ({ ...t, state: 'busy', thinkingStartTime })),
								executionQueue: hostQueued
									? [queuedMessage({ id: 'h7', hostQueued: true, text: item.text })]
									: s.executionQueue.filter((q) => !q.hostQueued),
							}
						: s
				),
			}));
		withHost(false, 100);
		await useAgentStore.getState().processQueuedItem('row', item, drainDeps);
		await flush();
		withHost(true, 100);
		fireHostStartedMentions(row());
		// Gone while the turn ahead runs: one more sync, in case the tab's state comes later...
		withHost(false, 100);
		fireHostStartedMentions(row());
		// ...and still on the turn ahead, as long as a start takes to show: it was removed.
		withHost(false, 100);
		fireHostStartedMentions(row(), undefined, Date.now() + HOST_QUEUE_START_GRACE_MS + 1);
		// A later turn on the tab is not this message either.
		withHost(false, 300);
		fireHostStartedMentions(row());
		expect(sendCrossAgentRequest).not.toHaveBeenCalled();
	});

	it('hosted: a queued turn that starts before its queued state is seen still consults', async () => {
		act$.mockResolvedValue({
			ok: true,
			result: {
				kind: 'send',
				receipt: { status: 'queued', itemId: 'h8', position: 1, queueLength: 1 },
			},
		});
		seedWithBackend('hosted');
		// The tab is busy with the turn the message was queued behind, as the host tells it.
		hydrateHost(100);
		useSessionStore.setState((current) => ({
			sessions: current.sessions.map((s) =>
				s.id === 'row'
					? { ...s, aiTabs: s.aiTabs.map((t) => ({ ...t, state: 'busy', thinkingStartTime: 100 })) }
					: s
			),
		}));
		await useAgentStore.getState().processQueuedItem(
			'row',
			queuedMessage({
				text: 'look into the cache with @Backend',
				crossAgentMention: true,
				mentionRouting: 'parallel',
			}),
			drainDeps
		);
		await flush();
		fireHostStartedMentions(row());
		expect(sendCrossAgentRequest).not.toHaveBeenCalled();
		// The turn ahead (started before the receipt) still runs: not this one.
		useSessionStore.setState((current) => ({
			sessions: current.sessions.map((s) =>
				s.id === 'row'
					? { ...s, aiTabs: s.aiTabs.map((t) => ({ ...t, state: 'busy', thinkingStartTime: 100 })) }
					: s
			),
		}));
		fireHostStartedMentions(row());
		expect(sendCrossAgentRequest).not.toHaveBeenCalled();
		// The host started it before any queue frame arrived: a turn that began after the receipt,
		// and with it the message's own user entry.
		const startedAfter = Date.now() + 1;
		const busyWithLogs = (logs: LogEntry[]) =>
			useSessionStore.setState((current) => ({
				sessions: current.sessions.map((s) =>
					s.id === 'row'
						? {
								...s,
								aiTabs: s.aiTabs.map((t) => ({
									...t,
									state: 'busy',
									thinkingStartTime: startedAfter,
									logs: [...t.logs, ...logs],
								})),
							}
						: s
				),
			}));
		// Another message's turn is not its start.
		busyWithLogs([
			{ id: 'o', timestamp: 3, source: 'user', text: 'something else', hostLive: true },
		]);
		fireHostStartedMentions(row());
		expect(sendCrossAgentRequest).not.toHaveBeenCalled();
		busyWithLogs([
			{
				id: 'u-live',
				timestamp: 4,
				source: 'user',
				text: 'look into the cache with @Backend',
				hostLive: true,
			},
		]);

		fireHostStartedMentions(row());
		expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
	});

	it('hosted: a second hand-off waits for the first to release with its own answer, then arms', async () => {
		seedWithBackend('hosted');
		const setTab = (fields: Record<string, unknown>) =>
			useSessionStore.setState((current) => ({
				sessions: current.sessions.map((s) =>
					s.id === 'row' ? { ...s, aiTabs: s.aiTabs.map((t) => ({ ...t, ...fields })) } : s
				),
			}));
		// The first hand-off's turn still runs on the host.
		setTab({
			state: 'busy',
			logs: [{ id: 'u1', timestamp: 1, source: 'user', text: 'first, then tell @Backend' }],
			pendingMentionHandoff: {
				targets: [{ targetSessionId: 'backend', targetAgentName: 'Backend' }],
				message: 'first, then tell @Backend',
				hostTurn: { stage: 'running' },
			},
		});
		await useAgentStore.getState().processQueuedItem(
			'row',
			queuedMessage({
				text: 'second, then tell @Backend',
				crossAgentMention: true,
				mentionRouting: 'handoff',
			}),
			drainDeps
		);
		await flush();
		// Neither released early nor replaced.
		expect(sendCrossAgentRequest).not.toHaveBeenCalled();
		expect(row().aiTabs[0].pendingMentionHandoff?.message).toBe('first, then tell @Backend');
		followHostedHandoffs(row());
		await flush();
		expect(sendCrossAgentRequest).not.toHaveBeenCalled();

		// Both host turns ended before the next sync: each hand-off sends its own turn's answer.
		setTab({
			state: 'idle',
			logs: [
				{ id: 'u1', timestamp: 1, source: 'user', text: 'first, then tell @Backend' },
				{ id: 'a1', timestamp: 2, source: 'ai', text: 'first answer' },
				{ id: 'u2', timestamp: 3, source: 'user', text: 'second, then tell @Backend' },
				{ id: 'a2', timestamp: 4, source: 'ai', text: 'second answer' },
			],
		});
		followHostedHandoffs(row());
		await flush();
		expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
		expect(sendCrossAgentRequest.mock.calls[0][0]).toMatchObject({
			userPrompt: 'first, then tell @Backend',
			handoffAnswer: 'first answer',
		});
		// The second armed on the same sync, at the boundary it had when the host took it.
		expect(row().aiTabs[0].pendingMentionHandoff).toMatchObject({
			message: 'second, then tell @Backend',
			hostTurn: { stage: 'sent', afterEntryId: 'u1' },
		});
		followHostedHandoffs(row());
		await flush();
		expect(sendCrossAgentRequest).toHaveBeenCalledTimes(2);
		expect(sendCrossAgentRequest.mock.calls[1][0]).toMatchObject({
			userPrompt: 'second, then tell @Backend',
			handoffAnswer: 'second answer',
		});
	});

	it('hosted: Stop drops a hand-off waiting behind the armed one with it', async () => {
		seedWithBackend('hosted');
		useSessionStore.setState((current) => ({
			sessions: current.sessions.map((s) =>
				s.id === 'row'
					? {
							...s,
							aiTabs: s.aiTabs.map((t) => ({
								...t,
								state: 'busy',
								pendingMentionHandoff: {
									targets: [{ targetSessionId: 'backend', targetAgentName: 'Backend' }],
									message: 'first, then tell @Backend',
									hostTurn: { stage: 'running' },
								},
							})),
						}
					: s
			),
		}));
		await useAgentStore.getState().processQueuedItem(
			'row',
			queuedMessage({
				text: 'second, then tell @Backend',
				crossAgentMention: true,
				mentionRouting: 'handoff',
			}),
			drainDeps
		);
		await flush();
		dropMentionHandoffs('row');
		followHostedHandoffs(row());
		await flush();
		expect(row().aiTabs[0].pendingMentionHandoff).toBeUndefined();
		expect(sendCrossAgentRequest).not.toHaveBeenCalled();
	});

	it('hosted: a message addressed only at an agent that is gone sends this agent nothing', async () => {
		seed('hosted');
		const item = queuedMessage({
			text: '@Backend does this look right?',
			crossAgentMention: true,
			crossAgentOnly: true,
		});
		const dispatched = await useAgentStore.getState().processQueuedItem('row', item, drainDeps);
		await flush();
		expect(dispatched).toBe(true);
		expect(sends()).toEqual([]);
		expect(sendCrossAgentRequest).not.toHaveBeenCalled();
	});

	describe('a turn the host queued, whose queue change and tab state arrive apart (M14)', () => {
		/** `ran`: the host wrote this message's user entry (live, as its turn starts). */
		type HostView = { queued: boolean; busy?: number; logs?: boolean; ran?: boolean };
		/** One host message: the queue change, or the tab's state, as its own store update. */
		const hostSays = (itemId: string, text: string, view: HostView) =>
			useSessionStore.setState((current) => ({
				sessions: current.sessions.map((s) =>
					s.id === 'row'
						? {
								...s,
								aiTabs: s.aiTabs.map((t) => ({
									...t,
									state: view.busy === undefined ? 'idle' : 'busy',
									thinkingStartTime: view.busy,
									...(view.ran && !t.logs.some((entry) => entry.id === 'u-live')
										? {
												logs: [
													...t.logs,
													{
														id: 'u-live',
														timestamp: 3,
														source: 'user' as const,
														text,
														hostLive: true,
													},
												],
											}
										: {}),
									...(view.logs
										? {
												logs: [
													{ id: 'u', timestamp: 1, source: 'user' as const, text },
													{
														id: 'a',
														timestamp: 2,
														source: 'ai' as const,
														text: 'The cache is stale.',
													},
												],
											}
										: {}),
								})),
								executionQueue: view.queued
									? [queuedMessage({ id: itemId, hostQueued: true, text })]
									: s.executionQueue.filter((q) => !q.hostQueued),
							}
						: s
				),
			}));
		/** Drain a mention message the host answers `queued`, behind a turn that started at 100. */
		const drainQueued = async (itemId: string, mentionRouting: QueuedItem['mentionRouting']) => {
			act$.mockResolvedValue({
				ok: true,
				result: {
					kind: 'send',
					receipt: { status: 'queued', itemId, position: 1, queueLength: 1 },
				},
			});
			seedWithBackend('hosted');
			const text = 'look into the cache with @Backend';
			hostSays(itemId, text, { queued: false, busy: 100 });
			await useAgentStore
				.getState()
				.processQueuedItem(
					'row',
					queuedMessage({ text, crossAgentMention: true, mentionRouting }),
					drainDeps
				);
			await flush();
			return text;
		};

		it('a start grace that ran out is not armed again, so no timer fires sync after sync (Greptile and CodeRabbit on #2154)', async () => {
			const id = 'deadline';
			const queuedAt = Date.now();
			const text = await drainQueued(id, 'parallel');
			hostSays(id, text, { queued: false });
			const goneAt = queuedAt + 5;
			fireHostStartedMentions(row(), undefined, goneAt);
			const grace = goneAt + HOST_QUEUE_START_GRACE_MS;
			expect(nextHostStartDeadline(goneAt)).toBe(grace);
			expect(nextHostStartDeadline(grace)).toBe(grace);
			// Judged once past the grace, still waiting: only the time limit is left to wait for.
			fireHostStartedMentions(row(), undefined, grace + 1);
			const ttl = nextHostStartDeadline(grace + 1);
			expect(ttl).toBeGreaterThanOrEqual(queuedAt + HOST_START_MENTION_TTL_MS);
			expect(sendCrossAgentRequest).not.toHaveBeenCalled();
			// Let it go, so no later test sees it waiting.
			pruneHostStartedMentions(new Set());
		});

		it('a host that names its exits: a consult never seen waiting starts on its own entry, not only on a name that may never come (CodeRabbit on #2154)', async () => {
			const id = 'unseen';
			const text = await drainQueued(id, 'parallel');
			// The message joined and left the host queue between two of its frames: no name for it.
			hostSays(id, text, { queued: false, busy: 200, ran: true });
			fireHostStartedMentions(row(), []);
			expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
		});

		it('a host that names its exits: a consult never seen waiting, with no entry of its own yet, waits (CodeRabbit on #2154)', async () => {
			const id = 'unseen-wait';
			const text = await drainQueued(id, 'parallel');
			hostSays(id, text, { queued: false, busy: 100 });
			// One clock read: every later time derives from it, so no sync lands past the grace early.
			const now = Date.now();
			fireHostStartedMentions(row(), [], now);
			fireHostStartedMentions(row(), [], now + HOST_QUEUE_START_GRACE_MS + 1);
			expect(sendCrossAgentRequest).not.toHaveBeenCalled();
			expect(row().aiTabs[0].logs.some((entry) => /removed before it ran/.test(entry.text))).toBe(
				false
			);
			pruneHostStartedMentions(new Set());
		});

		it('a hand-off: a start grace that ran out is no deadline (Greptile and CodeRabbit on #2154)', () => {
			const tab = (goneAt: number) => ({
				...createMockSession({ id: 'h' }),
				aiTabs: [
					{
						id: 't1',
						logs: [],
						pendingMentionHandoff: {
							targets: [],
							message: 'm',
							hostTurn: { stage: 'sent' as const, queueItemId: 'q', goneAt },
						},
					},
				],
			});
			const grace = 1_000 + HOST_QUEUE_START_GRACE_MS;
			expect(nextHostedHandoffDeadline([tab(1_000)] as never, 1_000)).toBe(grace);
			expect(nextHostedHandoffDeadline([tab(1_000)] as never, grace)).toBe(grace);
			expect(nextHostedHandoffDeadline([tab(1_000)] as never, grace + 1)).toBeUndefined();
		});

		describe.each(['parallel', 'consult-first'] as const)('a %s consult', (routing) => {
			it('busy state first: the new turn is not taken for the turn ahead, and it consults', async () => {
				const id = `a-${routing}`;
				const text = await drainQueued(id, routing);
				hostSays(id, text, { queued: true, busy: 100 });
				fireHostStartedMentions(row());
				// The tab reads its own turn while the queue change has not come yet.
				hostSays(id, text, { queued: true, busy: 200, ran: true });
				fireHostStartedMentions(row());
				expect(sendCrossAgentRequest).not.toHaveBeenCalled();
				hostSays(id, text, { queued: false, busy: 200, ran: true });
				fireHostStartedMentions(row());
				expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
				expect(sendCrossAgentRequest.mock.calls[0][0]).toMatchObject({
					targetSessionId: 'backend',
				});
			});

			it('queue change first, tab idle: it waits a sync for the start, then consults', async () => {
				const id = `b-${routing}`;
				const text = await drainQueued(id, routing);
				hostSays(id, text, { queued: true, busy: 100 });
				fireHostStartedMentions(row());
				hostSays(id, text, { queued: false });
				fireHostStartedMentions(row());
				expect(sendCrossAgentRequest).not.toHaveBeenCalled();
				hostSays(id, text, { queued: false, busy: 200, ran: true });
				fireHostStartedMentions(row());
				expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
			});

			it('queue change first, tab still on the turn ahead: it waits a sync, then consults', async () => {
				const id = `c-${routing}`;
				const text = await drainQueued(id, routing);
				hostSays(id, text, { queued: true, busy: 100 });
				fireHostStartedMentions(row());
				hostSays(id, text, { queued: false, busy: 100 });
				fireHostStartedMentions(row());
				expect(sendCrossAgentRequest).not.toHaveBeenCalled();
				hostSays(id, text, { queued: false, busy: 200, ran: true });
				fireHostStartedMentions(row());
				expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
			});

			it("this window's own re-syncs between the queue change and the busy state never drop it (Greptile on #2148)", async () => {
				const id = `g-${routing}`;
				const text = await drainQueued(id, routing);
				hostSays(id, text, { queued: true, busy: 100 });
				fireHostStartedMentions(row());
				hostSays(id, text, { queued: false });
				// The projection's write, a hand-off's write, any store change: the same host state.
				for (let n = 0; n < 4; n++) fireHostStartedMentions(row());
				expect(sendCrossAgentRequest).not.toHaveBeenCalled();
				hostSays(id, text, { queued: false, busy: 200, ran: true });
				fireHostStartedMentions(row());
				expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
			});

			it('one that left the queue and never started is let go with a note, and a later turn is not it', async () => {
				const id = `r-${routing}`;
				const text = await drainQueued(id, routing);
				hostSays(id, text, { queued: true, busy: 100 });
				fireHostStartedMentions(row());
				hostSays(id, text, { queued: false });
				fireHostStartedMentions(row());
				// Another message's turn runs after the window: that turn's end and saved transcript
				// decide, never its start (CodeRabbit on #2148).
				const late = Date.now() + HOST_QUEUE_START_GRACE_MS + 1;
				const current = { read: vi.fn(), isCurrent: () => true };
				const removedNote = 'Nothing was asked of Backend: the message was removed before it ran.';
				hostSays(id, text, { queued: false, busy: 300 });
				fireHostStartedMentions(row(), undefined, late, 0, current);
				expect(row().aiTabs[0].logs.map((entry) => entry.text)).not.toContain(removedNote);
				// It ended, and the current saved transcript never shows this message.
				hostSays(id, text, { queued: false });
				const stale = { read: vi.fn(), isCurrent: () => false };
				fireHostStartedMentions(row(), undefined, late, 0, stale);
				expect(stale.read).toHaveBeenCalledWith('t1');
				expect(row().aiTabs[0].logs.map((entry) => entry.text)).not.toContain(removedNote);
				fireHostStartedMentions(row(), undefined, late, 0, current);
				expect(sendCrossAgentRequest).not.toHaveBeenCalled();
				expect(row().aiTabs[0].logs.map((entry) => entry.text)).toContain(removedNote);
			});

			it('one whose turn ran and ended while this window was not attached consults once, from the saved transcript (CodeRabbit on #2148)', async () => {
				const id = `t-${routing}`;
				const text = await drainQueued(id, routing);
				hostSays(id, text, { queued: true, busy: 100 });
				fireHostStartedMentions(row(), [], Date.now(), 0);
				// Detached: it started and ended. The reconnect reads the queue whole and the tab idle.
				hostSays(id, text, { queued: false });
				// One clock read for both: `late` must be past the grace counted from this sync.
				const now = Date.now();
				const late = now + HOST_QUEUE_START_GRACE_MS + 1;
				const stale = { read: vi.fn(), isCurrent: () => false };
				fireHostStartedMentions(row(), [], now, 1, stale);
				fireHostStartedMentions(row(), [], late, 1, stale);
				expect(stale.read).toHaveBeenCalledWith('t1');
				expect(sendCrossAgentRequest).not.toHaveBeenCalled();
				// The saved transcript shows its message and answer.
				hostSays(id, text, { queued: false, logs: true });
				fireHostStartedMentions(row(), [], late, 1, { read: vi.fn(), isCurrent: () => true });
				expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
				fireHostStartedMentions(row(), [], late, 1, { read: vi.fn(), isCurrent: () => true });
				expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
			});

			it('a host that names its exits: the named start consults in either order, a named removal never', async () => {
				const id = `d-${routing}`;
				const text = await drainQueued(id, routing);
				hostSays(id, text, { queued: true, busy: 100 });
				fireHostStartedMentions(row(), []);
				// Busy state first: nothing is inferred from it.
				hostSays(id, text, { queued: true, busy: 200, ran: true });
				fireHostStartedMentions(row(), []);
				expect(sendCrossAgentRequest).not.toHaveBeenCalled();
				// The queue change that names it, with the tab still idle between turns.
				hostSays(id, text, { queued: false });
				fireHostStartedMentions(row(), [started(id)]);
				expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);

				sendCrossAgentRequest.mockReset();
				const removed = `e-${routing}`;
				const again = await drainQueued(removed, routing);
				hostSays(removed, again, { queued: true, busy: 100 });
				fireHostStartedMentions(row(), [started(id)]);
				hostSays(removed, again, { queued: false, busy: 100 });
				fireHostStartedMentions(row(), [started(id), { itemId: removed, exit: 'removed' }]);
				// Its tab runs a later turn: the host named this item removed, so nobody is asked.
				hostSays(removed, again, { queued: false, busy: 300 });
				fireHostStartedMentions(row(), [started(id), { itemId: removed, exit: 'removed' }]);
				expect(sendCrossAgentRequest).not.toHaveBeenCalled();
			});

			it('a start named while this window was not attached still consults, once, after the reconnect read (M18)', async () => {
				const id = `m18-${routing}`;
				const text = await drainQueued(id, routing);
				hostSays(id, text, { queued: true, busy: 100 });
				fireHostStartedMentions(row(), [], Date.now(), 0);
				// Disconnected: the host starts it, and that named start never reaches this window.
				// The reconnect reads the queue whole (one read): it lacks the item and names nothing.
				hostSays(id, text, { queued: false, busy: 200, ran: true });
				fireHostStartedMentions(row(), [], Date.now(), 1);
				expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
				fireHostStartedMentions(row(), [], Date.now(), 1);
				expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
			});

			it('a start missed while detached still consults once when the next item starts during the reconnect read (M19)', async () => {
				const id = `m19-${routing}`;
				const text = await drainQueued(id, routing);
				hostSays(id, text, { queued: true, busy: 100 });
				fireHostStartedMentions(row(), [], Date.now(), 0);
				// Detached: this item starts unseen. On reconnect B starts during the queue read; that
				// change names only B, and main counts the read it replaced (one read).
				hostSays(id, text, { queued: false, busy: 300, ran: true });
				fireHostStartedMentions(row(), [started('B')], Date.now(), 1);
				expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
				fireHostStartedMentions(row(), [started('B')], Date.now(), 1);
				expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
				expect(row().aiTabs[0].logs.map((entry) => entry.text)).not.toContain(
					'Nothing was asked of Backend: the message was removed before it ran.'
				);
			});

			it('a host that names its exits: a start still in flight is never taken for a removal (CodeRabbit on #2148)', async () => {
				const id = `f-${routing}`;
				const text = await drainQueued(id, routing);
				hostSays(id, text, { queued: true, busy: 100 });
				fireHostStartedMentions(row(), []);
				// Another message was queued while this one's start was in flight: the snapshot
				// leaves it out and names no exit for it.
				hostSays(id, text, { queued: false, busy: 100 });
				fireHostStartedMentions(row(), []);
				fireHostStartedMentions(row(), [], Date.now() + HOST_QUEUE_START_GRACE_MS + 1);
				expect(sendCrossAgentRequest).not.toHaveBeenCalled();
				expect(row().aiTabs[0].logs.map((entry) => entry.text)).not.toContain(
					'Nothing was asked of Backend: the message was removed before it ran.'
				);
				// Then its start is named.
				hostSays(id, text, { queued: false, busy: 200, ran: true });
				fireHostStartedMentions(row(), [started(id)]);
				expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
			});
		});

		describe.each(['parallel', 'consult-first'] as const)(
			'a %s consult whose turn starts and ends between two syncs (M20)',
			(routing) => {
				const lateNote =
					'Backend was asked after the turn ran: the host did not say when the message started.';
				// One clock read per test: every sync gets its time from it, so `late` is always past the
				// grace counted from the sync that stamped the gone time (a second read could land later).
				let now = 0;
				let late = 0;
				beforeEach(() => {
					now = Date.now();
					late = now + HOST_QUEUE_START_GRACE_MS + 1;
				});

				it('a host that names its starts: the named start consults once, with no busy state ever seen', async () => {
					const id = `m20n-${routing}`;
					const text = await drainQueued(id, routing);
					hostSays(id, text, { queued: true, busy: 100 });
					fireHostStartedMentions(row(), [], now);
					// Between two syncs it started and ended: the tab reads idle, its turn never seen.
					hostSays(id, text, { queued: false });
					fireHostStartedMentions(row(), [started(id)], now);
					fireHostStartedMentions(row(), [started(id)], now);
					expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
					expect(row().aiTabs[0].logs.map((entry) => entry.text)).not.toContain(lateNote);
				});

				it('a host that names its starts: one that started and ended before its first queue frame consults once', async () => {
					const id = `m20m-${routing}`;
					const text = await drainQueued(id, routing);
					hostSays(id, text, { queued: false });
					fireHostStartedMentions(row(), [started(id)], now);
					expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
				});

				it('an older host: seen waiting, then gone with the tab idle, it consults late from the saved transcript, and says so', async () => {
					const id = `m20o-${routing}`;
					const text = await drainQueued(id, routing);
					hostSays(id, text, { queued: true, busy: 100 });
					fireHostStartedMentions(row(), undefined, now);
					hostSays(id, text, { queued: false });
					fireHostStartedMentions(row(), undefined, now);
					const stale = { read: vi.fn(), isCurrent: () => false };
					fireHostStartedMentions(row(), undefined, late, 0, stale);
					expect(stale.read).toHaveBeenCalledWith('t1');
					expect(sendCrossAgentRequest).not.toHaveBeenCalled();
					hostSays(id, text, { queued: false, logs: true });
					const current = { read: vi.fn(), isCurrent: () => true };
					fireHostStartedMentions(row(), undefined, late, 0, current);
					fireHostStartedMentions(row(), undefined, late, 0, current);
					expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
					expect(row().aiTabs[0].logs.map((entry) => entry.text)).toContain(lateNote);
				});

				it('an older host: never listed in the host queue, gone with the tab idle, it consults late instead of waiting out the time limit', async () => {
					const id = `m20u-${routing}`;
					const text = await drainQueued(id, routing);
					// Started and ended before any queue frame showed it.
					hostSays(id, text, { queued: false });
					fireHostStartedMentions(row(), undefined, now);
					const stale = { read: vi.fn(), isCurrent: () => false };
					fireHostStartedMentions(row(), undefined, late, 0, stale);
					expect(stale.read).toHaveBeenCalledWith('t1');
					hostSays(id, text, { queued: false, logs: true });
					fireHostStartedMentions(row(), undefined, late, 0, {
						read: vi.fn(),
						isCurrent: () => true,
					});
					expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
					expect(row().aiTabs[0].logs.map((entry) => entry.text)).toContain(lateNote);
				});

				it('an older host: never listed, its absence is no removal, while the turn ahead runs or the tab idles', async () => {
					const id = `m20w-${routing}`;
					const text = await drainQueued(id, routing);
					const removedNote =
						'Nothing was asked of Backend: the message was removed before it ran.';
					hostSays(id, text, { queued: false, busy: 100 });
					fireHostStartedMentions(row(), undefined, now);
					fireHostStartedMentions(row(), undefined, late);
					hostSays(id, text, { queued: false });
					fireHostStartedMentions(row(), undefined, late, 0, {
						read: vi.fn(),
						isCurrent: () => true,
					});
					expect(row().aiTabs[0].logs.map((entry) => entry.text)).not.toContain(removedNote);
					expect(sendCrossAgentRequest).not.toHaveBeenCalled();
					// Then it runs.
					hostSays(id, text, { queued: false, busy: 200, ran: true });
					fireHostStartedMentions(row(), undefined, late);
					expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
					expect(row().aiTabs[0].logs.map((entry) => entry.text)).not.toContain(lateNote);
				});
			}
		);

		describe.each(['parallel', 'consult-first'] as const)(
			'a %s consult of the turn Stop ended never fires after Stop (M24)',
			(routing) => {
				const stoppedNote = 'Nothing was asked of Backend: the turn was stopped.';
				const lateNote =
					'Backend was asked after the turn ran: the host did not say when the message started.';

				it('one the host queue never listed (an older desktop host): its saved entry, never seen running after Stop, fires nothing', async () => {
					const id = `m24-${routing}`;
					const text = await drainQueued(id, routing);
					const now = Date.now();
					const late = now + HOST_QUEUE_START_GRACE_MS + 1;
					// The host runs it: no queue frame ever listed it, and its user entry is not drawn yet.
					hostSays(id, text, { queued: false, busy: 200 });
					hydrateHost(200);
					fireHostStartedMentions(row(), undefined, now);
					const stop = dropStoppedHostStartMentions('row', ['t1']);
					// No queue frame shows it: Stop keeps it, as it may still wait (M25).
					settleStoppedHostStartMentions(stop);
					const notes = () => row().aiTabs[0].logs.map((entry) => entry.text);
					expect(notes()).not.toContain(stoppedNote);
					// The stopped turn's saved transcript holds its message: before M24 it consulted here.
					hostSays(id, text, { queued: false, logs: true });
					const current = { read: vi.fn(), isCurrent: () => true };
					fireHostStartedMentions(row(), undefined, late, 0, current);
					fireHostStartedMentions(row(), [started(id)], late, 1, current);
					expect(sendCrossAgentRequest).not.toHaveBeenCalled();
					expect(notes().filter((entry) => entry === stoppedNote)).toHaveLength(1);
					expect(notes()).not.toContain(lateNote);
				});

				it('one gone from a host that names its exits, with no name yet (its start in flight): Stop lets it go', async () => {
					const id = `m24n-${routing}`;
					const text = await drainQueued(id, routing);
					const now = Date.now();
					hostSays(id, text, { queued: true, busy: 100 });
					fireHostStartedMentions(row(), [], now);
					hostSays(id, text, { queued: false, busy: 200 });
					fireHostStartedMentions(row(), [], now);
					dropStoppedHostStartMentions('row', ['t1']);
					// The start's name lands after Stop: it ran as the stopped turn, so nothing is asked.
					fireHostStartedMentions(row(), [started(id)], now);
					expect(sendCrossAgentRequest).not.toHaveBeenCalled();
					expect(row().aiTabs[0].logs.map((entry) => entry.text)).toContain(stoppedNote);
				});

				it('an older desktop host (no queue frames): a message queued after attach keeps its consult through a Stop of another turn, and consults once when it runs (M25)', async () => {
					const id = `m25d-${routing}`;
					const text = await drainQueued(id, routing);
					const now = Date.now();
					// The tab runs another message's turn: no queue frame ever lists this one.
					hostSays(id, text, { queued: false, busy: 200 });
					hydrateHost(200);
					fireHostStartedMentions(row(), undefined, now);
					const stop = dropStoppedHostStartMentions('row', ['t1']);
					settleStoppedHostStartMentions(stop);
					expect(row().aiTabs[0].logs.map((entry) => entry.text)).not.toContain(stoppedNote);
					// The host starts it after Stop: its own entry, on a turn that is not the stopped one.
					hostSays(id, text, { queued: false, busy: 300, ran: true });
					hydrateHost(300);
					fireHostStartedMentions(row(), undefined, now);
					fireHostStartedMentions(row(), undefined, now);
					expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
					expect(row().aiTabs[0].logs.map((entry) => entry.text)).not.toContain(stoppedNote);
				});

				it('an older desktop host: one whose own entry is on the tab when Stop lands was the stopped turn (M25)', async () => {
					const id = `m25e-${routing}`;
					const text = await drainQueued(id, routing);
					const now = Date.now();
					hostSays(id, text, { queued: false, busy: 200 });
					hydrateHost(200);
					fireHostStartedMentions(row(), undefined, now);
					// Its entry lands as Stop does, before any sync judged it.
					hostSays(id, text, { queued: false, busy: 200, ran: true });
					const stop = dropStoppedHostStartMentions('row', ['t1']);
					settleStoppedHostStartMentions(stop);
					fireHostStartedMentions(row(), undefined, now);
					expect(sendCrossAgentRequest).not.toHaveBeenCalled();
					expect(
						row()
							.aiTabs[0].logs.map((entry) => entry.text)
							.filter((entry) => entry === stoppedNote)
					).toHaveLength(1);
				});

				it('an older desktop host: its entry seen while the tab still runs the stopped turn fires nothing (M25)', async () => {
					const id = `m25s-${routing}`;
					const text = await drainQueued(id, routing);
					const now = Date.now();
					hostSays(id, text, { queued: false, busy: 200 });
					hydrateHost(200);
					fireHostStartedMentions(row(), undefined, now);
					const stop = dropStoppedHostStartMentions('row', ['t1']);
					settleStoppedHostStartMentions(stop);
					// The host's stopped turn was its own: its entry shows on the turn Stop ended.
					hostSays(id, text, { queued: false, busy: 200, ran: true });
					fireHostStartedMentions(row(), undefined, now);
					expect(sendCrossAgentRequest).not.toHaveBeenCalled();
					expect(row().aiTabs[0].logs.map((entry) => entry.text)).toContain(stoppedNote);
				});

				it('a host that names its starts: a message still listed when Stop lands, whose start comes before the host answers, was the stopped turn (M25)', async () => {
					const id = `m25n-${routing}`;
					const text = await drainQueued(id, routing);
					const now = Date.now();
					hostSays(id, text, { queued: true, busy: 100 });
					fireHostStartedMentions(row(), [], now);
					// The host already runs it; its queue frame is still on the way when Stop lands.
					hostSays(id, text, { queued: true, busy: 200 });
					hydrateHost(200);
					const stop = dropStoppedHostStartMentions('row', ['t1']);
					expect(row().aiTabs[0].logs.map((entry) => entry.text)).not.toContain(stoppedNote);
					hostSays(id, text, { queued: false, busy: 200 });
					fireHostStartedMentions(row(), [started(id)], now);
					settleStoppedHostStartMentions(stop);
					fireHostStartedMentions(row(), [started(id)], now);
					expect(sendCrossAgentRequest).not.toHaveBeenCalled();
					expect(row().aiTabs[0].logs.map((entry) => entry.text)).toContain(stoppedNote);
				});

				it('a host that names its starts: a start the mirror holds when the host answers, with no sync since, goes at the answer (M25)', async () => {
					const id = `m25a-${routing}`;
					const text = await drainQueued(id, routing);
					const now = Date.now();
					hostSays(id, text, { queued: true, busy: 100 });
					fireHostStartedMentions(row(), [], now);
					const stop = dropStoppedHostStartMentions('row', ['t1']);
					// The host named the start before it answered the Stop; no sync ran in between. The
					// mirror still lists it, so only the named exit lets it go (CodeRabbit on #2160).
					mirrorHostQueue([id], [started(id)]);
					settleStoppedHostStartMentions(stop);
					expect(row().aiTabs[0].logs.map((entry) => entry.text)).toContain(stoppedNote);
					hostSays(id, text, { queued: false, busy: 300, ran: true });
					fireHostStartedMentions(row(), [started(id)], now);
					expect(sendCrossAgentRequest).not.toHaveBeenCalled();
				});

				it('a host that names its starts: a message the host still lists when it answers the Stop consults once when it starts after it (M25)', async () => {
					const id = `m25l-${routing}`;
					const text = await drainQueued(id, routing);
					const now = Date.now();
					hostSays(id, text, { queued: true, busy: 100 });
					hydrateHost(100);
					fireHostStartedMentions(row(), [], now);
					const stop = dropStoppedHostStartMentions('row', ['t1']);
					mirrorHostQueue([id], []);
					// The host's own list, read just before the Stop, holds it.
					settleStoppedHostStartMentions(stop, { waitingAtStop: [id] });
					// The host starts it after its answer: the named start fires, even before the tab
					// reads busy with it.
					hostSays(id, text, { queued: false });
					fireHostStartedMentions(row(), [started(id)], now);
					fireHostStartedMentions(row(), [started(id)], now);
					expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
					expect(row().aiTabs[0].logs.map((entry) => entry.text)).not.toContain(stoppedNote);
				});

				it('no list from the host (its read failed): one only the mirror lists consults once its own turn runs after Stop, not on the named start alone (CodeRabbit on #2160)', async () => {
					const id = `m25x-${routing}`;
					const text = await drainQueued(id, routing);
					const now = Date.now();
					hostSays(id, text, { queued: true, busy: 100 });
					hydrateHost(100);
					fireHostStartedMentions(row(), [], now);
					const stop = dropStoppedHostStartMentions('row', ['t1']);
					mirrorHostQueue([id], []);
					settleStoppedHostStartMentions(stop);
					// A named start with the tab idle: it may be the stopped turn's late frame.
					hostSays(id, text, { queued: false });
					fireHostStartedMentions(row(), [started(id)], now);
					expect(sendCrossAgentRequest).not.toHaveBeenCalled();
					// Its own turn runs after Stop.
					hostSays(id, text, { queued: false, busy: 300, ran: true });
					fireHostStartedMentions(row(), [started(id)], now);
					fireHostStartedMentions(row(), [started(id)], now);
					expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
				});

				it('no list from the host: a late named start of the stopped turn, with its entry on an idle tab, asks nothing (CodeRabbit on #2160)', async () => {
					const id = `m25y-${routing}`;
					const text = await drainQueued(id, routing);
					const now = Date.now();
					hostSays(id, text, { queued: true, busy: 100 });
					hydrateHost(100);
					fireHostStartedMentions(row(), [], now);
					const stop = dropStoppedHostStartMentions('row', ['t1']);
					mirrorHostQueue([id], []);
					settleStoppedHostStartMentions(stop);
					hostSays(id, text, { queued: false, logs: true });
					fireHostStartedMentions(row(), [started(id)], now, 0, {
						read: vi.fn(),
						isCurrent: () => true,
					});
					expect(sendCrossAgentRequest).not.toHaveBeenCalled();
					expect(row().aiTabs[0].logs.map((entry) => entry.text)).toContain(stoppedNote);
				});

				it('another Stop that settles first leaves this Stop waiting for its own answer (Greptile on #2160)', async () => {
					const id = `m25t-${routing}`;
					const text = await drainQueued(id, routing);
					const now = Date.now();
					hostSays(id, text, { queued: true, busy: 100 });
					fireHostStartedMentions(row(), [], now);
					const first = dropStoppedHostStartMentions('row', ['t1']);
					// A Stop of another tab (no request to the host) settles while the first one waits,
					// and the mirror still lists the message.
					mirrorHostQueue([id], []);
					settleStoppedHostStartMentions(dropStoppedHostStartMentions('row', ['another-tab']));
					// The first Stop's host reports, before its answer, that the message had started.
					hostSays(id, text, { queued: false, busy: 100 });
					fireHostStartedMentions(row(), [started(id)], now);
					settleStoppedHostStartMentions(first);
					expect(sendCrossAgentRequest).not.toHaveBeenCalled();
					expect(row().aiTabs[0].logs.map((entry) => entry.text)).toContain(stoppedNote);
				});

				it("a desktop host whose queue frames trail its writes: the host's own list at the Stop says the message had started (Greptile on #2160)", async () => {
					const id = `m25q-${routing}`;
					const text = await drainQueued(id, routing);
					const now = Date.now();
					hostSays(id, text, { queued: true, busy: 100 });
					fireHostStartedMentions(row(), [], now);
					const stop = dropStoppedHostStartMentions('row', ['t1']);
					// The mirror still lists it (the host's frame is seconds behind); the host's own read
					// just before the Stop did not: it was the turn the Stop ended.
					mirrorHostQueue([id], []);
					settleStoppedHostStartMentions(stop, { waitingAtStop: [] });
					expect(row().aiTabs[0].logs.map((entry) => entry.text)).toContain(stoppedNote);
					// The late frame names the start: nothing is asked.
					hostSays(id, text, { queued: false, busy: 100 });
					fireHostStartedMentions(row(), [started(id)], now);
					expect(sendCrossAgentRequest).not.toHaveBeenCalled();
				});

				it('a desktop host that names the turns its Stop ended: the answer first, the started frame after, asks nothing (M27)', async () => {
					const id = `m27n-${routing}`;
					const text = await drainQueued(id, routing);
					const now = Date.now();
					hostSays(id, text, { queued: true, busy: 100 });
					hydrateHost(100);
					fireHostStartedMentions(row(), [], now);
					const stop = dropStoppedHostStartMentions('row', ['t1']);
					// The host started it between its queue read and its Stop: the read still lists it, and
					// its "started" frame is still on its way. The answer names it as the turn it stopped.
					mirrorHostQueue([id], []);
					settleStoppedHostStartMentions(stop, { waitingAtStop: [id], stoppedItemIds: [id] });
					expect(row().aiTabs[0].logs.map((entry) => entry.text)).toContain(stoppedNote);
					// The late frame names the start, with the turn still drawn running: nothing is asked.
					hostSays(id, text, { queued: false, busy: 200, ran: true });
					fireHostStartedMentions(row(), [started(id)], now);
					fireHostStartedMentions(row(), [started(id)], now);
					expect(sendCrossAgentRequest).not.toHaveBeenCalled();
				});

				it('a desktop host that names the turns its Stop ended, not this one: it waited through the Stop, and consults once when it starts (M27)', async () => {
					const id = `m27w-${routing}`;
					const text = await drainQueued(id, routing);
					const now = Date.now();
					hostSays(id, text, { queued: true, busy: 100 });
					hydrateHost(100);
					fireHostStartedMentions(row(), [], now);
					const stop = dropStoppedHostStartMentions('row', ['t1']);
					mirrorHostQueue([id], []);
					// No list from the host (its read was late), but it named the turn it stopped.
					settleStoppedHostStartMentions(stop, { stoppedItemIds: ['the-turn-ahead'] });
					hostSays(id, text, { queued: false });
					fireHostStartedMentions(row(), [started(id)], now);
					fireHostStartedMentions(row(), [started(id)], now);
					expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
					expect(row().aiTabs[0].logs.map((entry) => entry.text)).not.toContain(stoppedNote);
				});

				it('a desktop host that names nothing, whose frames trail its answer: a listed message keeps its Stop mark through a stale frame, and its late start asks nothing (M27)', async () => {
					const id = `m27t-${routing}`;
					const text = await drainQueued(id, routing);
					const now = Date.now();
					hostSays(id, text, { queued: true, busy: 100 });
					hydrateHost(100);
					fireHostStartedMentions(row(), [], now);
					const stop = dropStoppedHostStartMentions('row', ['t1']);
					mirrorHostQueue([id], []);
					// The answer first: its read lists the message, which may have started just after it.
					settleStoppedHostStartMentions(stop, { waitingAtStop: [id], queueFramesTrail: true });
					expect(row().aiTabs[0].logs.map((entry) => entry.text)).not.toContain(stoppedNote);
					// A frame written before the Stop still lists it: no word on its exit yet.
					hostSays(id, text, { queued: true, busy: 100 });
					fireHostStartedMentions(row(), [], now);
					// Then the started frame, with the stopped turn ended on the tab: nothing is asked.
					hostSays(id, text, { queued: false, logs: true });
					fireHostStartedMentions(row(), [started(id)], now, 0, {
						read: vi.fn(),
						isCurrent: () => true,
					});
					expect(sendCrossAgentRequest).not.toHaveBeenCalled();
					expect(row().aiTabs[0].logs.map((entry) => entry.text)).toContain(stoppedNote);
				});

				it("a later Stop's answer that names nothing keeps the mark an earlier Stop set until that one answers (CodeRabbit on #2160)", async () => {
					const id = `m27s-${routing}`;
					const text = await drainQueued(id, routing);
					const now = Date.now();
					hostSays(id, text, { queued: true, busy: 100 });
					hydrateHost(100);
					fireHostStartedMentions(row(), [], now);
					const first = dropStoppedHostStartMentions('row', ['t1']);
					const second = dropStoppedHostStartMentions('row', ['t1']);
					mirrorHostQueue([id], []);
					// The second Stop answers first: it ended no queued turn.
					settleStoppedHostStartMentions(second, { waitingAtStop: [id], stoppedItemIds: [] });
					// The first Stop's started frame lands before its answer: still the stopped turn.
					hostSays(id, text, { queued: false, busy: 200, ran: true });
					fireHostStartedMentions(row(), [started(id)], now);
					settleStoppedHostStartMentions(first, { waitingAtStop: [id], stoppedItemIds: [id] });
					fireHostStartedMentions(row(), [started(id)], now);
					expect(sendCrossAgentRequest).not.toHaveBeenCalled();
					expect(row().aiTabs[0].logs.map((entry) => entry.text)).toContain(stoppedNote);
				});

				it("an earlier Stop with no answer keeps its doubt through a later Stop's answer that names nothing (CodeRabbit on #2160)", async () => {
					const id = `m27o-${routing}`;
					const text = await drainQueued(id, routing);
					const now = Date.now();
					hostSays(id, text, { queued: true, busy: 100 });
					hydrateHost(100);
					fireHostStartedMentions(row(), [], now);
					const first = dropStoppedHostStartMentions('row', ['t1']);
					const second = dropStoppedHostStartMentions('row', ['t1']);
					mirrorHostQueue([id], []);
					// The first Stop gets no answer; the second names no queued turn.
					settleStoppedHostStartMentions(first);
					settleStoppedHostStartMentions(second, { waitingAtStop: [id], stoppedItemIds: [] });
					// A stale frame still lists it; then its late start, with the stopped turn ended.
					hostSays(id, text, { queued: true, busy: 100 });
					fireHostStartedMentions(row(), [], now);
					hostSays(id, text, { queued: false, logs: true });
					fireHostStartedMentions(row(), [started(id)], now, 0, {
						read: vi.fn(),
						isCurrent: () => true,
					});
					expect(sendCrossAgentRequest).not.toHaveBeenCalled();
					expect(row().aiTabs[0].logs.map((entry) => entry.text)).toContain(stoppedNote);
				});

				it('a Stop with no answer keeps a listed message marked through a stale frame, and its late start asks nothing (CodeRabbit on #2160)', async () => {
					const id = `m27f-${routing}`;
					const text = await drainQueued(id, routing);
					const now = Date.now();
					hostSays(id, text, { queued: true, busy: 100 });
					hydrateHost(100);
					fireHostStartedMentions(row(), [], now);
					const stop = dropStoppedHostStartMentions('row', ['t1']);
					mirrorHostQueue([id], []);
					// The Stop failed partway: no answer.
					settleStoppedHostStartMentions(stop);
					hostSays(id, text, { queued: true, busy: 100 });
					fireHostStartedMentions(row(), [], now);
					hostSays(id, text, { queued: false, logs: true });
					fireHostStartedMentions(row(), [started(id)], now, 0, {
						read: vi.fn(),
						isCurrent: () => true,
					});
					expect(sendCrossAgentRequest).not.toHaveBeenCalled();
					expect(row().aiTabs[0].logs.map((entry) => entry.text)).toContain(stoppedNote);
				});

				it("the host's own list at the Stop still holds it: it waited through the Stop, and consults once when it starts (M25)", async () => {
					const id = `m25r-${routing}`;
					const text = await drainQueued(id, routing);
					const now = Date.now();
					// An older desktop host: no frame ever lists it, but its queue read does.
					hostSays(id, text, { queued: false, busy: 200 });
					hydrateHost(200);
					fireHostStartedMentions(row(), undefined, now);
					const stop = dropStoppedHostStartMentions('row', ['t1']);
					settleStoppedHostStartMentions(stop, { waitingAtStop: [id] });
					// It starts after the Stop and ends between two syncs: seen only in the saved transcript.
					hostSays(id, text, { queued: false, logs: true });
					fireHostStartedMentions(row(), undefined, now, 0, {
						read: vi.fn(),
						isCurrent: () => true,
					});
					expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
					expect(row().aiTabs[0].logs.map((entry) => entry.text)).not.toContain(stoppedNote);
				});

				it("a stopped message's entry read back while another message's turn runs is no start of its own (CodeRabbit on #2160)", async () => {
					const id = `m25o-${routing}`;
					const text = await drainQueued(id, routing);
					const now = Date.now();
					hostSays(id, text, { queued: false, busy: 200 });
					hydrateHost(200);
					fireHostStartedMentions(row(), undefined, now);
					// No list from the host: no queue ever listed it, so it is kept.
					settleStoppedHostStartMentions(dropStoppedHostStartMentions('row', ['t1']));
					// Its own (stopped) entry shows up, while the tab runs another message's turn.
					useSessionStore.setState((current) => ({
						sessions: current.sessions.map((session) =>
							session.id === 'row'
								? {
										...session,
										aiTabs: session.aiTabs.map((tab) => ({
											...tab,
											state: 'busy' as const,
											thinkingStartTime: 300,
											logs: [
												{ id: 'u', timestamp: 1, source: 'user' as const, text },
												{ id: 'a', timestamp: 2, source: 'ai' as const, text: 'Stopped.' },
												{
													id: 'u2',
													timestamp: 4,
													source: 'user' as const,
													text: 'another message',
												},
											],
										})),
									}
								: session
						),
					}));
					fireHostStartedMentions(row(), undefined, now);
					expect(sendCrossAgentRequest).not.toHaveBeenCalled();
					expect(row().aiTabs[0].logs.map((entry) => entry.text)).toContain(stoppedNote);
				});

				it('Stop on another tab keeps it', async () => {
					const id = `m24t-${routing}`;
					const text = await drainQueued(id, routing);
					const now = Date.now();
					hostSays(id, text, { queued: false, busy: 200 });
					fireHostStartedMentions(row(), undefined, now);
					dropStoppedHostStartMentions('row', ['another-tab']);
					fireHostStartedMentions(row(), [started(id)], now);
					expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
				});

				it('one the host queued behind the turn Stop ends, not listed yet: it still waits, and consults once when it starts (CodeRabbit on #2154)', async () => {
					const id = `m24w-${routing}`;
					// The host's record runs the turn ahead at the receipt, so the receipt records it.
					hydrateHost(100);
					const text = await drainQueued(id, routing);
					const now = Date.now();
					// Stop lands before any queue frame listed the message: the tab runs the turn ahead.
					const stop = dropStoppedHostStartMentions('row', ['t1']);
					settleStoppedHostStartMentions(stop);
					expect(row().aiTabs[0].logs.map((entry) => entry.text)).not.toContain(stoppedNote);
					// Its own turn starts after Stop, and after the host answered it.
					hostSays(id, text, { queued: false, busy: 300, ran: true });
					fireHostStartedMentions(row(), [started(id)], now);
					fireHostStartedMentions(row(), [started(id)], now);
					expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
				});
			}
		);

		describe('a hand-off', () => {
			const releasesWithItsAnswer = (text: string, hostExits?: QueueExit[]) => {
				hostSays('', text, { queued: false, logs: true });
				followHostedHandoffs(row(), undefined, hostExits);
				expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
				expect(sendCrossAgentRequest.mock.calls[0][0]).toMatchObject({
					targetSessionId: 'backend',
					handoffAnswer: 'The cache is stale.',
				});
				expect(row().aiTabs[0].pendingMentionHandoff).toBeUndefined();
			};

			it('busy state first: it runs, then hands off its answer', async () => {
				const text = await drainQueued('h-a', 'handoff');
				hostSays('h-a', text, { queued: true, busy: 100 });
				followHostedHandoffs(row());
				hostSays('h-a', text, { queued: true, busy: 200, ran: true });
				followHostedHandoffs(row());
				expect(row().aiTabs[0].pendingMentionHandoff?.hostTurn).toMatchObject({
					turnStartedAt: 100,
				});
				hostSays('h-a', text, { queued: false, busy: 200, ran: true });
				followHostedHandoffs(row());
				expect(row().aiTabs[0].pendingMentionHandoff?.hostTurn?.stage).toBe('running');
				releasesWithItsAnswer(text);
			});

			it('queue change first, tab idle: it is not dropped, it runs, then hands off', async () => {
				const text = await drainQueued('h-b', 'handoff');
				hostSays('h-b', text, { queued: true, busy: 100 });
				followHostedHandoffs(row());
				hostSays('h-b', text, { queued: false });
				followHostedHandoffs(row());
				expect(row().aiTabs[0].pendingMentionHandoff).toBeDefined();
				hostSays('h-b', text, { queued: false, busy: 200, ran: true });
				followHostedHandoffs(row());
				expect(row().aiTabs[0].pendingMentionHandoff?.hostTurn?.stage).toBe('running');
				releasesWithItsAnswer(text);
			});

			it("this window's own re-syncs before the busy state never drop it (Greptile on #2148)", async () => {
				const text = await drainQueued('h-g', 'handoff');
				hostSays('h-g', text, { queued: true, busy: 100 });
				followHostedHandoffs(row());
				hostSays('h-g', text, { queued: false });
				for (let n = 0; n < 4; n++) followHostedHandoffs(row());
				expect(row().aiTabs[0].pendingMentionHandoff).toBeDefined();
				hostSays('h-g', text, { queued: false, busy: 200, ran: true });
				followHostedHandoffs(row());
				expect(row().aiTabs[0].pendingMentionHandoff?.hostTurn?.stage).toBe('running');
				releasesWithItsAnswer(text);
			});

			it('a host that names its exits: the named start runs and hands off, with no tab inference', async () => {
				const text = await drainQueued('h-c', 'handoff');
				hostSays('h-c', text, { queued: true, busy: 100 });
				followHostedHandoffs(row(), undefined, []);
				hostSays('h-c', text, { queued: false, busy: 200, ran: true });
				followHostedHandoffs(row(), undefined, [started('h-c')]);
				expect(row().aiTabs[0].pendingMentionHandoff?.hostTurn?.stage).toBe('running');
				releasesWithItsAnswer(text, [started('h-c')]);
			});

			it('a start named while this window was not attached arms once, after the reconnect read (M18)', async () => {
				const text = await drainQueued('h-m18', 'handoff');
				hostSays('h-m18', text, { queued: true, busy: 100 });
				followHostedHandoffs(row(), undefined, [], Date.now(), 0);
				hostSays('h-m18', text, { queued: false, busy: 200, ran: true });
				// Without a read since it was seen, a missing item with no name waits for its name...
				followHostedHandoffs(row(), undefined, [], Date.now(), 0);
				expect(row().aiTabs[0].pendingMentionHandoff?.hostTurn?.stage).toBe('sent');
				// ...after the reconnect's read the tab's state decides: its own turn runs.
				followHostedHandoffs(row(), undefined, [], Date.now(), 1);
				expect(row().aiTabs[0].pendingMentionHandoff?.hostTurn?.stage).toBe('running');
				followHostedHandoffs(row(), undefined, [], Date.now(), 1);
				expect(row().aiTabs[0].pendingMentionHandoff?.hostTurn?.stage).toBe('running');
				releasesWithItsAnswer(text, []);
			});

			it('a start missed while detached arms once when the next item starts during the reconnect read (M19)', async () => {
				const text = await drainQueued('h-m19', 'handoff');
				hostSays('h-m19', text, { queued: true, busy: 100 });
				followHostedHandoffs(row(), undefined, [], Date.now(), 0);
				// Detached: it starts unseen; B starts during the reconnect read, named alone, and main
				// counts the replaced read.
				hostSays('h-m19', text, { queued: false, busy: 300, ran: true });
				followHostedHandoffs(row(), undefined, [started('B')], Date.now(), 1);
				expect(row().aiTabs[0].pendingMentionHandoff?.hostTurn?.stage).toBe('running');
				followHostedHandoffs(row(), undefined, [started('B')], Date.now(), 1);
				expect(row().aiTabs[0].pendingMentionHandoff?.hostTurn?.stage).toBe('running');
				releasesWithItsAnswer(text, [started('B')]);
			});

			it('a hand-off whose turn ran and ended while this window was not attached releases once, with its own answer (CodeRabbit on #2148)', async () => {
				const text = await drainQueued('h-t', 'handoff');
				hostSays('h-t', text, { queued: true, busy: 100 });
				followHostedHandoffs(row(), undefined, [], Date.now(), 0);
				// Detached: it started and ended. The reconnect reads the queue whole and the tab idle.
				hostSays('h-t', text, { queued: false });
				// One clock read for both: `late` must be past the grace counted from this sync.
				const now = Date.now();
				const late = now + HOST_QUEUE_START_GRACE_MS + 1;
				const stale = { read: vi.fn(), isCurrent: () => false };
				followHostedHandoffs(row(), stale, [], now, 1);
				followHostedHandoffs(row(), stale, [], late, 1);
				expect(stale.read).toHaveBeenCalledWith('t1');
				expect(row().aiTabs[0].pendingMentionHandoff).toBeDefined();
				// The saved transcript shows its message and answer: it ran, and its answer goes out.
				hostSays('h-t', text, { queued: false, logs: true });
				const current = { read: vi.fn(), isCurrent: () => true };
				followHostedHandoffs(row(), current, [], late, 1);
				expect(row().aiTabs[0].pendingMentionHandoff?.hostTurn?.stage).toBe('running');
				followHostedHandoffs(row(), current, [], late, 1);
				expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
				expect(sendCrossAgentRequest.mock.calls[0][0]).toMatchObject({
					targetSessionId: 'backend',
					handoffAnswer: 'The cache is stale.',
				});
				followHostedHandoffs(row(), current, [], late, 1);
				expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
			});

			it('a named start on a tab that still reads idle never releases from a transcript older than it (CodeRabbit on #2148)', async () => {
				const text = await drainQueued('h-e', 'handoff');
				hostSays('h-e', text, { queued: true, busy: 100 });
				followHostedHandoffs(row(), undefined, []);
				// Named started, its busy state not here yet, and the saved transcript current.
				hostSays('h-e', text, { queued: false });
				const current = { read: vi.fn(), isCurrent: () => true };
				followHostedHandoffs(row(), current, [started('h-e')]);
				followHostedHandoffs(row(), current, [started('h-e')]);
				expect(row().aiTabs[0].pendingMentionHandoff).toBeDefined();
				expect(sendCrossAgentRequest).not.toHaveBeenCalled();
				// Its own saved answer, once the host wrote it, is what releases it.
				releasesWithItsAnswer(text, [started('h-e')]);
			});

			it('a named start on an idle tab that still draws a stream reads the saved transcript (CodeRabbit on #2148)', () => {
				const tab = {
					state: 'idle' as const,
					logs: [{ id: 'l', timestamp: 1, source: 'ai' as const, text: 'done', hostLive: true }],
					pendingMentionHandoff: {
						targets: [],
						message: 'm',
						hostTurn: { stage: 'sent', queueItemId: 'h-l', turnStartedAt: 100, seenQueued: true },
					} as never,
				};
				expect(hostedHandoffStep(tab, new Set(), false, [started('h-l')])).toBe('read');
				// Busy with the turn ahead, it still waits.
				expect(
					hostedHandoffStep({ ...tab, state: 'busy', thinkingStartTime: 100 }, new Set(), false, [
						started('h-l'),
					])
				).toBe('wait');
			});

			it('an older host: a hand-off never listed in the host queue, whose turn started and ended between two syncs, releases once with its answer (M20)', async () => {
				const text = await drainQueued('h-m20', 'handoff');
				hostSays('h-m20', text, { queued: false });
				// One clock read: the gone time and `late` both derive from it.
				const now = Date.now();
				followHostedHandoffs(row(), undefined, undefined, now);
				const late = now + HOST_QUEUE_START_GRACE_MS + 1;
				const stale = { read: vi.fn(), isCurrent: () => false };
				followHostedHandoffs(row(), stale, undefined, late);
				expect(stale.read).toHaveBeenCalledWith('t1');
				hostSays('h-m20', text, { queued: false, logs: true });
				const current = { read: vi.fn(), isCurrent: () => true };
				followHostedHandoffs(row(), current, undefined, late);
				expect(row().aiTabs[0].pendingMentionHandoff?.hostTurn?.stage).toBe('running');
				followHostedHandoffs(row(), current, undefined, late);
				expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
				expect(sendCrossAgentRequest.mock.calls[0][0]).toMatchObject({
					targetSessionId: 'backend',
					handoffAnswer: 'The cache is stale.',
				});
			});

			it('a host that names its exits: a named removal drops it with a note; an unnamed gap waits', async () => {
				const text = await drainQueued('h-d', 'handoff');
				hostSays('h-d', text, { queued: true, busy: 100 });
				followHostedHandoffs(row(), undefined, []);
				hostSays('h-d', text, { queued: false, busy: 300 });
				followHostedHandoffs(row(), undefined, []);
				expect(row().aiTabs[0].pendingMentionHandoff).toBeDefined();
				followHostedHandoffs(row(), undefined, [{ itemId: 'h-d', exit: 'removed' }]);
				expect(row().aiTabs[0].pendingMentionHandoff).toBeUndefined();
				expect(sendCrossAgentRequest).not.toHaveBeenCalled();
			});
		});
	});

	describe('a consult waiting for a host start is let go, and says so (M15)', () => {
		const notes = () =>
			row()
				.aiTabs[0].logs.filter((entry) => entry.source === 'system')
				.map((entry) => entry.text);
		/** `ran`: the host wrote the queued message's user entry, as its turn starts. */
		const busy = (thinkingStartTime: number | undefined, hostQueuedId?: string, ran = false) =>
			useSessionStore.setState((current) => ({
				sessions: current.sessions.map((s) =>
					s.id === 'row'
						? {
								...s,
								aiTabs: s.aiTabs.map((t) => ({
									...t,
									state: thinkingStartTime === undefined ? 'idle' : 'busy',
									thinkingStartTime,
									...(ran
										? {
												logs: [
													...t.logs,
													{
														id: `u-live-${t.logs.length}`,
														timestamp: 3,
														source: 'user' as const,
														text: 'look into the cache with @Backend',
														hostLive: true,
													},
												],
											}
										: {}),
								})),
								executionQueue: hostQueuedId
									? [queuedMessage({ id: hostQueuedId, hostQueued: true })]
									: s.executionQueue.filter((q) => !q.hostQueued),
							}
						: s
				),
			}));
		/** A parallel mention message the host queues behind the turn its own record shows. */
		const queueOnHost = async (itemId: string, hostBusySince?: number) => {
			act$.mockResolvedValue({
				ok: true,
				result: {
					kind: 'send',
					receipt: { status: 'queued', itemId, position: 1, queueLength: 1 },
				},
			});
			seedWithBackend('hosted');
			hydrateHost(hostBusySince);
			await useAgentStore.getState().processQueuedItem(
				'row',
				queuedMessage({
					text: 'look into the cache with @Backend',
					crossAgentMention: true,
					mentionRouting: 'parallel',
				}),
				drainDeps
			);
			await flush();
		};

		it("compares the host's start times only with each other, so a host clock behind this one still consults", async () => {
			// The host's clock is far behind this machine's: every start it reports is "in the past".
			await queueOnHost('m15-clock', 100);
			busy(100);
			fireHostStartedMentions(row());
			expect(sendCrossAgentRequest).not.toHaveBeenCalled();
			busy(150, undefined, true);
			fireHostStartedMentions(row());
			expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
		});

		it('an agent moved back from its host lets go, with a note, and never consults later', async () => {
			await queueOnHost('m15-moved', 100);
			pruneHostStartedMentions(new Set(['row']));
			expect(notes()).toEqual([]);
			pruneHostStartedMentions(new Set());
			expect(notes()).toEqual([
				'Nothing was asked of Backend: the agent no longer runs on that host.',
			]);
			busy(200);
			fireHostStartedMentions(row());
			expect(sendCrossAgentRequest).not.toHaveBeenCalled();
		});

		it('a deleted agent lets go without a note to write', async () => {
			await queueOnHost('m15-deleted', 100);
			useSessionStore.setState({ sessions: [backend()] });
			expect(() => pruneHostStartedMentions(new Set())).not.toThrow();
			seedWithBackend('hosted');
			busy(200);
			fireHostStartedMentions(row());
			expect(sendCrossAgentRequest).not.toHaveBeenCalled();
		});

		it('the time limit runs from when the host queue last showed it, not from the receipt (CodeRabbit on #2148)', async () => {
			await queueOnHost('m15-long', 100);
			const later = Date.now() + HOST_START_MENTION_TTL_MS + 60_000;
			// Still waiting on the host 13 hours later...
			busy(100, 'm15-long');
			fireHostStartedMentions(row(), [], later);
			// ...then it starts, and its start shows a moment after it left the queue.
			busy(100);
			fireHostStartedMentions(row(), [], later + 1);
			expect(notes()).toEqual([]);
			busy(200);
			fireHostStartedMentions(row(), [started('m15-long')], later + 2);
			expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
		});

		it('one the host queue never shows lets go past the time limit; one it shows stays', async () => {
			await queueOnHost('m15-shown', 100);
			busy(100, 'm15-shown');
			fireHostStartedMentions(row(), undefined, Date.now() + HOST_START_MENTION_TTL_MS + 1);
			expect(notes()).toEqual([]);

			await queueOnHost('m15-never', 100);
			busy(100);
			fireHostStartedMentions(row(), [], Date.now() + HOST_START_MENTION_TTL_MS + 1);
			expect(notes()).toContain(
				'Nothing was asked of Backend: its message never started on the host.'
			);
			busy(200);
			fireHostStartedMentions(row(), []);
			expect(sendCrossAgentRequest).not.toHaveBeenCalled();
			// The one still shown waits for its exit to be named; name it, so no later test sees it.
			fireHostStartedMentions(row(), [{ itemId: 'm15-shown', exit: 'removed' }]);
		});

		it('a removal the host names leaves the note a local mention leaves', async () => {
			await queueOnHost('m15-removed', 100);
			busy(100, 'm15-removed');
			fireHostStartedMentions(row(), []);
			busy(100);
			fireHostStartedMentions(row(), [{ itemId: 'm15-removed', exit: 'removed' }]);
			expect(notes()).toEqual([
				'Nothing was asked of Backend: the message was removed before it ran.',
			]);
			expect(sendCrossAgentRequest).not.toHaveBeenCalled();
		});

		it('Stop lets go of the one whose turn it stopped, and keeps one that still waits on the host', async () => {
			await queueOnHost('m15-stopped', 100);
			busy(100, 'm15-stopped');
			fireHostStartedMentions(row());
			// It left the host queue and the tab runs a new turn (its own): Stop ends that turn, while
			// its start is not confirmed yet.
			busy(150);
			hydrateHost(150);
			fireHostStartedMentions(row());
			dropStoppedHostStartMentions('row', ['t1']);
			expect(notes()).toEqual(['Nothing was asked of Backend: the turn was stopped.']);
			busy(200);
			fireHostStartedMentions(row());
			expect(sendCrossAgentRequest).not.toHaveBeenCalled();

			await queueOnHost('m15-waits', 100);
			busy(100, 'm15-waits');
			fireHostStartedMentions(row());
			const stop = dropStoppedHostStartMentions('row', ['t1']);
			// The host answers the Stop with the message still in its queue.
			mirrorHostQueue(['m15-waits']);
			settleStoppedHostStartMentions(stop);
			busy(300, undefined, true);
			fireHostStartedMentions(row());
			expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
		});
	});

	it('hosted: a queued message that mentions an agent waits for the drain instead of going at once', () => {
		seedWithBackend('hosted', [queuedMessage({ text: 'ask @Backend', crossAgentMention: true })]);
		expect(handQueuedItemToHost('row', 'q1')).toBe(false);
		expect(sends()).toEqual([]);
		expect(queue().map((queued) => queued.id)).toEqual(['q1']);
	});
});
