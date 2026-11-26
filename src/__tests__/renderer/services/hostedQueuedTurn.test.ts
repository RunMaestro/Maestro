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
} from '../../../renderer/services/crossAgentHandoff';
import {
	dropStoppedHostStartMentions,
	fireHostStartedMentions,
	HOST_START_MENTION_TTL_MS,
	pruneHostStartedMentions,
} from '../../../renderer/services/hostedQueuedTurn';
import { useAgentStore } from '../../../renderer/stores/agentStore';
import { usePeerMirrorStore } from '../../../renderer/stores/peerMirrorStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import type { QueuedItem } from '../../../renderer/types';
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
		const busyWith = (thinkingStartTime: number, hostTurn: object) => ({
			state: 'busy' as const,
			thinkingStartTime,
			logs: [],
			pendingMentionHandoff: handoff(hostTurn),
		});
		expect(hostedHandoffStep(busyWith(100, queued), new Set(['h9']))).toBe('seen-queued');
		const seen = { ...queued, seenQueued: true };
		expect(hostedHandoffStep(busyWith(100, seen), new Set(['h9']))).toBe('wait');
		// The turn ahead is recorded once: a busy state that lands before the queue change is this
		// item's own turn, never a new turn ahead (M14).
		expect(hostedHandoffStep(busyWith(150, seen), new Set(['h9']))).toBe('wait');
		// Its own turn started: a new start time on the tab.
		expect(hostedHandoffStep(busyWith(200, seen), new Set())).toBe('running');
		// Gone from the queue while the turn ahead still runs, or with the tab idle: the tab's state
		// may still come, so it waits a short time for its start (any number of syncs), then counts
		// as removed and nothing goes out (Greptile on #2148).
		expect(hostedHandoffStep(busyWith(100, seen), new Set())).toBe('left-queue');
		expect(hostedHandoffStep({ ...busyWith(100, seen), state: 'idle' }, new Set())).toBe(
			'left-queue'
		);
		const left = { ...seen, goneAt: 1_000 };
		const soon = 1_000 + HOST_QUEUE_START_GRACE_MS;
		const late = soon + 1;
		expect(hostedHandoffStep(busyWith(100, left), new Set(), false, undefined, soon)).toBe('wait');
		expect(hostedHandoffStep(busyWith(200, left), new Set(), false, undefined, soon)).toBe(
			'running'
		);
		expect(hostedHandoffStep(busyWith(100, left), new Set(), false, undefined, late)).toBe('drop');
		// A start seen after the window is not its turn: it was removed.
		expect(hostedHandoffStep(busyWith(200, left), new Set(), false, undefined, late)).toBe('drop');
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
		const withHost = (hostQueued: boolean, thinkingStartTime: number) =>
			useSessionStore.setState((current) => ({
				sessions: current.sessions.map((s) =>
					s.id === 'row'
						? {
								...s,
								aiTabs: s.aiTabs.map((t) => ({ ...t, state: 'busy', thinkingStartTime })),
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
		withHost(false, 200);
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
		// The host started it before any queue frame arrived: a turn that began after the receipt.
		const startedAfter = Date.now() + 1;
		useSessionStore.setState((current) => ({
			sessions: current.sessions.map((s) =>
				s.id === 'row'
					? {
							...s,
							aiTabs: s.aiTabs.map((t) => ({
								...t,
								state: 'busy',
								thinkingStartTime: startedAfter,
							})),
						}
					: s
			),
		}));

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
			logs: [{ id: 'u1', timestamp: 1, source: 'user', text: 'first' }],
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
				{ id: 'u1', timestamp: 1, source: 'user', text: 'first' },
				{ id: 'a1', timestamp: 2, source: 'ai', text: 'first answer' },
				{ id: 'u2', timestamp: 3, source: 'user', text: 'second' },
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
		type HostView = { queued: boolean; busy?: number; logs?: boolean };
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

		describe.each(['parallel', 'consult-first'] as const)('a %s consult', (routing) => {
			it('busy state first: the new turn is not taken for the turn ahead, and it consults', async () => {
				const id = `a-${routing}`;
				const text = await drainQueued(id, routing);
				hostSays(id, text, { queued: true, busy: 100 });
				fireHostStartedMentions(row());
				// The tab reads its own turn while the queue change has not come yet.
				hostSays(id, text, { queued: true, busy: 200 });
				fireHostStartedMentions(row());
				expect(sendCrossAgentRequest).not.toHaveBeenCalled();
				hostSays(id, text, { queued: false, busy: 200 });
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
				hostSays(id, text, { queued: false, busy: 200 });
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
				hostSays(id, text, { queued: false, busy: 200 });
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
				hostSays(id, text, { queued: false, busy: 200 });
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
				hostSays(id, text, { queued: false, busy: 300 });
				fireHostStartedMentions(row(), undefined, Date.now() + HOST_QUEUE_START_GRACE_MS + 1);
				expect(sendCrossAgentRequest).not.toHaveBeenCalled();
				expect(row().aiTabs[0].logs.map((entry) => entry.text)).toContain(
					'Nothing was asked of Backend: the message was removed before it ran.'
				);
			});

			it('a host that names its exits: the named start consults in either order, a named removal never', async () => {
				const id = `d-${routing}`;
				const text = await drainQueued(id, routing);
				hostSays(id, text, { queued: true, busy: 100 });
				fireHostStartedMentions(row(), []);
				// Busy state first: nothing is inferred from it.
				hostSays(id, text, { queued: true, busy: 200 });
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
				hostSays(id, text, { queued: false, busy: 200 });
				fireHostStartedMentions(row(), [started(id)]);
				expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
			});
		});

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
				hostSays('h-a', text, { queued: true, busy: 200 });
				followHostedHandoffs(row());
				expect(row().aiTabs[0].pendingMentionHandoff?.hostTurn).toMatchObject({
					turnStartedAt: 100,
				});
				hostSays('h-a', text, { queued: false, busy: 200 });
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
				hostSays('h-b', text, { queued: false, busy: 200 });
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
				hostSays('h-g', text, { queued: false, busy: 200 });
				followHostedHandoffs(row());
				expect(row().aiTabs[0].pendingMentionHandoff?.hostTurn?.stage).toBe('running');
				releasesWithItsAnswer(text);
			});

			it('a host that names its exits: the named start runs and hands off, with no tab inference', async () => {
				const text = await drainQueued('h-c', 'handoff');
				hostSays('h-c', text, { queued: true, busy: 100 });
				followHostedHandoffs(row(), undefined, []);
				hostSays('h-c', text, { queued: false, busy: 200 });
				followHostedHandoffs(row(), undefined, [started('h-c')]);
				expect(row().aiTabs[0].pendingMentionHandoff?.hostTurn?.stage).toBe('running');
				releasesWithItsAnswer(text, [started('h-c')]);
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
		const busy = (thinkingStartTime: number | undefined, hostQueuedId?: string) =>
			useSessionStore.setState((current) => ({
				sessions: current.sessions.map((s) =>
					s.id === 'row'
						? {
								...s,
								aiTabs: s.aiTabs.map((t) => ({
									...t,
									state: thinkingStartTime === undefined ? 'idle' : 'busy',
									thinkingStartTime,
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
			busy(150);
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
			// It left the host queue; its start is not confirmed yet when Stop lands.
			busy(undefined);
			fireHostStartedMentions(row());
			dropStoppedHostStartMentions('row', 't1');
			expect(notes()).toEqual(['Nothing was asked of Backend: the turn was stopped.']);
			busy(200);
			fireHostStartedMentions(row());
			expect(sendCrossAgentRequest).not.toHaveBeenCalled();

			await queueOnHost('m15-waits', 100);
			busy(100, 'm15-waits');
			fireHostStartedMentions(row());
			dropStoppedHostStartMentions('row');
			busy(300);
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
