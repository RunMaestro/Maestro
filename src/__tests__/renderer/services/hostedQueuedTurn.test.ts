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
	followHostedHandoffs,
	hostedHandoffStep,
} from '../../../renderer/services/crossAgentHandoff';
import { fireHostStartedMentions } from '../../../renderer/services/hostedQueuedTurn';
import { useAgentStore } from '../../../renderer/stores/agentStore';
import { usePeerMirrorStore } from '../../../renderer/stores/peerMirrorStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import type { QueuedItem } from '../../../renderer/types';
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

function hydrateHost() {
	const { peer } = replacePeerAgents(
		createMirroredPeer({ peerId: 'box', remoteId: 'r1', name: 'Box' }),
		[{ id: 'h1', name: 'Docs', toolType: 'claude-code', aiTabs: [{ id: 't1' }] }],
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
		expect(row().aiTabs[0].pendingMentionHandoff?.hostTurn).toEqual({ stage: 'running' });
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
		const queued = { stage: 'sent', queueItemId: 'h9' };
		expect(
			hostedHandoffStep(
				{ state: 'busy', logs: [], pendingMentionHandoff: handoff(queued) },
				new Set(['h9'])
			)
		).toBe('wait');
		expect(
			hostedHandoffStep(
				{ state: 'busy', logs: [], pendingMentionHandoff: handoff(queued) },
				new Set()
			)
		).toBe('running');
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
		// ...but an idle tab with nothing new since the send is a turn that has not started.
		expect(
			hostedHandoffStep(
				{
					state: 'idle',
					logs: answer,
					pendingMentionHandoff: handoff({ stage: 'sent', afterEntryId: 'a' }),
				},
				new Set()
			)
		).toBe('wait');
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
		const readTranscript = vi.fn();
		followHostedHandoffs(row(), readTranscript);
		expect(readTranscript).toHaveBeenCalledWith('t1');
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
		await useAgentStore.getState().processQueuedItem('row', item, drainDeps);
		await flush();
		expect(sendCrossAgentRequest).not.toHaveBeenCalled();

		const withHost = (hostQueued: boolean, state: 'busy' | 'idle') =>
			useSessionStore.setState((current) => ({
				sessions: current.sessions.map((s) =>
					s.id === 'row'
						? {
								...s,
								aiTabs: s.aiTabs.map((t) => ({ ...t, state })),
								executionQueue: hostQueued
									? [queuedMessage({ id: 'h9', hostQueued: true, text: item.text })]
									: s.executionQueue.filter((q) => !q.hostQueued),
							}
						: s
				),
			}));
		withHost(true, 'busy');
		fireHostStartedMentions(row());
		expect(sendCrossAgentRequest).not.toHaveBeenCalled();
		withHost(false, 'busy');
		fireHostStartedMentions(row());
		expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
		expect(sendCrossAgentRequest.mock.calls[0][0]).toMatchObject({ targetSessionId: 'backend' });
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

	it('hosted: a queued message that mentions an agent waits for the drain instead of going at once', () => {
		seedWithBackend('hosted', [queuedMessage({ text: 'ask @Backend', crossAgentMention: true })]);
		expect(handQueuedItemToHost('row', 'q1')).toBe(false);
		expect(sends()).toEqual([]);
		expect(queue().map((queued) => queued.id)).toEqual(['q1']);
	});
});
