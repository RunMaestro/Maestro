/**
 * Parity U1: two queued messages that both mention an agent run in the same order in every mode.
 *
 * A local and an SSH agent hold the first message's turn open until its consult answers, then run
 * the second: message 1, consult, "replied", the answer, then message 2 the same way. A hosted
 * agent's turn runs on its host, and its tab reads the host's state: idle from the moment this
 * machine's drain handed the first message over until the host's first frame of that turn. The
 * drain took the second message in that gap, the host queued it behind the first and started it
 * the moment the first turn ended, while the first turn's consult still ran here. The tab now holds
 * its line here while a turn is on its way (`hostedTabHoldsLine()`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sendCrossAgentRequest } = vi.hoisted(() => ({ sendCrossAgentRequest: vi.fn() }));
vi.mock('../../../renderer/hooks/agent/useCrossAgentDispatch', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/hooks/agent/useCrossAgentDispatch')>()),
	sendCrossAgentRequest: (...args: unknown[]) => sendCrossAgentRequest(...args),
}));

import {
	loadCrossAgentConsultPrompts,
	settleConsultHold,
} from '../../../renderer/services/crossAgentConsultHold';
import { enqueuePromptForTab } from '../../../renderer/services/queuedPrompt';
import { useAgentStore } from '../../../renderer/stores/agentStore';
import { usePeerMirrorStore } from '../../../renderer/stores/peerMirrorStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import type { QueuedItem } from '../../../renderer/types';
import {
	nextQueueDrainItem,
	takeNextRunnableQueueItem,
} from '../../../renderer/utils/executionQueue';
import {
	hostedTabHoldsLine,
	resetHostedTabLinesForTest,
} from '../../../renderer/utils/hostedTabLine';
import {
	isQueuedItemTargetBusy,
	markTabRunningQueuedItem,
} from '../../../renderer/utils/tabHelpers';
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
const drainDeps = {
	conductorProfile: '',
	customAICommands: [],
	speckitCommands: [],
	openspecCommands: [],
};
const TWIN = 'look into the cache with @Backend';

function hydrateHost() {
	const { peer } = replacePeerAgents(
		createMirroredPeer({ peerId: 'box', remoteId: 'r1', name: 'Box' }),
		[{ id: 'h1', name: 'Docs', toolType: 'claude-code', aiTabs: [{ id: 't1' }] }],
		[],
		1
	);
	usePeerMirrorStore.getState().hydrate([{ ...peer, connection: 'connected' }]);
}

const twin = (id: string): QueuedItem => ({
	id,
	timestamp: 1,
	tabId: 't1',
	type: 'message',
	text: TWIN,
	crossAgentMention: true,
	mentionRouting: 'parallel',
});

function seed(mode: AgentMode, executionQueue: QueuedItem[]) {
	const session = createModeSession(mode, {
		id: 'row',
		name: 'Docs',
		state: 'idle',
		activeTabId: 't1',
		aiTabs: [createMockAITab({ id: 't1' })],
		executionQueue,
	});
	const backend = createMockSession({
		id: 'backend',
		name: 'Backend',
		aiTabs: [createMockAITab({ id: 'b1' })],
	});
	useSessionStore.setState({
		sessions: [session, backend],
		activeSessionId: session.id,
		groups: [],
	});
}

const row = () => useSessionStore.getState().sessions.find((s) => s.id === 'row')!;

/** The idle drain's take (`useQueueProcessing`): the same rules, then the item's dispatch. */
function drain(): void {
	let taken: QueuedItem | null = null;
	useSessionStore.getState().setSessions((prev) =>
		prev.map((s) => {
			if (s.id !== 'row' || s.state !== 'idle') return s;
			const first = nextQueueDrainItem(s.executionQueue);
			if (!first || isQueuedItemTargetBusy(s, first)) return s;
			const { item, remaining } = takeNextRunnableQueueItem(s.executionQueue);
			if (!item) return s;
			taken = item;
			return {
				...s,
				state: 'busy',
				busySource: 'ai',
				executionQueue: remaining,
				aiTabs: s.aiTabs.map((t) =>
					t.id === item.tabId ? markTabRunningQueuedItem(t, item, s) : t
				),
			};
		})
	);
	const item = taken as QueuedItem | null;
	if (item) void useAgentStore.getState().processQueuedItem('row', item, drainDeps);
}

/** The turn on the tab ended (a local exit, or the host's frame that the tab is idle). */
function endTurn(): void {
	useSessionStore.getState().setSessions((prev) =>
		prev.map((s) =>
			s.id === 'row'
				? {
						...s,
						state: 'idle',
						busySource: undefined,
						aiTabs: s.aiTabs.map((t) => ({ ...t, state: 'idle', thinkingStartTime: undefined })),
					}
				: s
		)
	);
}

describe('U1: two queued mentions run in the same order in every mode', () => {
	let events: string[];
	let answerHost: Array<() => void>;

	beforeEach(async () => {
		resetStores(usePeerMirrorStore, useSessionStore);
		resetHostedTabLinesForTest();
		useSettingsStore.setState({ federationHostedAgents: true });
		events = [];
		answerHost = [];
		// A released hold runs as the turn that finishes the answer: the host gets its words and the
		// replies as agent-only context, a local spawn gets the replies as its prompt.
		const label = (text: string) => (text.startsWith(TWIN) ? 'turn: message' : 'turn: finish');
		act$.mockReset();
		act$.mockImplementation(
			(_peer: unknown, _agent: unknown, action: { kind: string; text?: string }) => {
				if (action?.kind !== 'send') return Promise.resolve({ ok: true, result: {} });
				events.push(label(action.text ?? ''));
				// The host answers once the test lets it: the drain runs in between, as it does live.
				return new Promise((resolve) =>
					answerHost.push(() =>
						resolve({ ok: true, result: { kind: 'send', receipt: { status: 'started' } } })
					)
				);
			}
		);
		maestro.federation = { act: act$ };
		vi.mocked(window.maestro.agents.get).mockResolvedValue({
			id: 'claude-code',
			name: 'Claude Code',
			available: true,
			command: 'claude',
		} as never);
		const spawn = vi.mocked(window.maestro.process.spawn);
		spawn.mockReset();
		spawn.mockImplementation(async (config: { prompt?: string }) => {
			events.push(label(config.prompt ?? ''));
			return { pid: 1 } as never;
		});
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
		sendCrossAgentRequest.mockImplementation(() => {
			events.push('consult');
			return Promise.resolve();
		});
		hydrateHost();
	});

	afterEach(() => {
		delete maestro.federation;
		resetHostedTabLinesForTest();
	});

	/**
	 * One dispatch: the drain takes what it may, looks again (each store change re-runs it live), and
	 * the host answers the send. A turn and the consult it fires start together (a local turn spawns
	 * beside its consult), so within one dispatch the turn is listed first.
	 */
	async function dispatch(): Promise<void> {
		const from = events.length;
		drain();
		await flush();
		drain();
		for (const answer of answerHost.splice(0)) answer();
		await flush();
		await flush();
		drain();
		const step = events.splice(from);
		events.push(
			...step.filter((e) => e.startsWith('turn')),
			...step.filter((e) => !e.startsWith('turn'))
		);
	}

	it.each(AGENT_MODES)(
		'%s: message 1, consult, replied, answer, then message 2 the same way',
		async (mode) => {
			seed(mode, [twin('twin-1'), twin('twin-2')]);

			for (let round = 0; round < 2; round++) {
				await dispatch();
				// The message's own turn ends at once; its consult has not answered yet.
				endTurn();
				await dispatch();
				// The consult answers: the hold becomes the turn that finishes the answer.
				events.push('replied');
				settleConsultHold({
					sourceSessionId: 'row',
					sourceTabId: 't1',
					targetSessionId: 'backend',
					text: 'the cache is fine',
				});
				await dispatch();
				endTurn();
			}

			expect(events).toEqual([
				'turn: message',
				'consult',
				'replied',
				'turn: finish',
				'turn: message',
				'consult',
				'replied',
				'turn: finish',
			]);
			expect(row().executionQueue).toEqual([]);
		}
	);

	it('hosted: a turn on its way to the host holds its tab, and lets go once the host took it', async () => {
		seed('hosted', [twin('twin-1'), twin('twin-2')]);
		drain();
		await flush();
		expect(hostedTabHoldsLine('row', 't1')).toBe(true);
		expect(isQueuedItemTargetBusy(row(), twin('twin-2'))).toBe(true);
		for (const answer of answerHost.splice(0)) answer();
		await flush();
		await flush();
		expect(hostedTabHoldsLine('row', 't1')).toBe(false);
		// The consult's hold took over: the second message still waits behind it.
		expect(row().executionQueue.map((item) => (item.awaitingConsult ? 'hold' : item.id))).toEqual([
			'hold',
			'twin-2',
		]);
	});

	it('hosted: a message queued from outside the composer waits behind a turn on its way', async () => {
		seed('hosted', [twin('twin-1')]);
		drain();
		await flush();
		enqueuePromptForTab({ sessionId: 'row', tabId: 't1', text: 'and one more thing' });
		await flush();
		// Not handed to the host past the line: it stays here for the drain.
		expect(events).toEqual(['turn: message']);
		expect(row().executionQueue.map((item) => item.text)).toContain('and one more thing');
	});
});
