/**
 * Quick Chat in every agent mode: a message opens its hidden background tab, runs, and comes back
 * as the reply the window shows, the same for a local, an SSH, and a hosted agent. Only the
 * transport differs. A local or SSH agent's tab is made here and its turn is spawned from here; a
 * hosted agent's tab is opened on its host and the host runs the turn (the main process refuses a
 * spawn here for it), and Stop goes to the host.
 *
 * The router is mocked (a new tab for every message); routing is quickChatRouter.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { useAgentStore } from '../../../renderer/stores/agentStore';
import { usePeerMirrorStore } from '../../../renderer/stores/peerMirrorStore';
import { registerDispatchDepsProvider } from '../../../renderer/stores/retryStore';
import {
	buildQuickChatSnapshot,
	resetQuickChatEngineForTests,
	runQuickChatCommand,
} from '../../../renderer/services/quickChatEngine';
import { DEFAULT_QUICK_CHAT_SETTINGS } from '../../../shared/quickChat';
import {
	createMirroredPeer,
	replacePeerAgents,
} from '../../../shared/maestro-lib/client/peer-mirror';
import { AGENT_MODES, createModeSession, resetStores, type AgentMode } from '../../helpers';
import { createMockAITab } from '../../helpers/mockTab';
import type { AITab, LogEntry } from '../../../renderer/types';

vi.mock('../../../renderer/services/quickChatRouter', () => ({
	routeQuickChatMessage: vi.fn(async () => ({ kind: 'new' })),
	reopenClosedConversation: vi.fn(async () => null),
}));
vi.mock('../../../renderer/services/tabAutoNaming', async (original) => ({
	...(await original<typeof import('../../../renderer/services/tabAutoNaming')>()),
	requestTabAutoName: vi.fn(),
}));

const maestro = window.maestro as unknown as Record<string, unknown>;
const act$ = vi.fn();
const interrupt$ = vi.fn();
const HOST_TAB = 'host-qc';

function seed(mode: AgentMode) {
	const { peer } = replacePeerAgents(
		createMirroredPeer({ peerId: 'box', remoteId: 'r1', name: 'Box' }),
		[{ id: 'h1', name: 'Docs', toolType: 'claude-code', aiTabs: [{ id: 'main' }] }],
		[],
		1
	);
	usePeerMirrorStore.getState().hydrate([{ ...peer, connection: 'connected' }]);
	const session = createModeSession(mode, {
		id: 'row',
		name: 'Docs',
		state: 'idle',
		activeTabId: 'main',
		aiTabs: [createMockAITab({ id: 'main' })],
		unifiedTabOrder: [{ type: 'ai', id: 'main' }],
		executionQueue: [],
	});
	useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
}

const row = () => useSessionStore.getState().sessions[0];
const sent = () => buildQuickChatSnapshot().messages.filter((m) => m.role === 'user');
const actions = (kind: string) =>
	act$.mock.calls.filter(([, , action]) => action?.kind === kind).map(([, , action]) => action);

function patchTab(tabId: string, patch: (tab: AITab) => Partial<AITab>): void {
	useSessionStore.setState({
		sessions: useSessionStore.getState().sessions.map((s) => ({
			...s,
			aiTabs: s.aiTabs.map((t) => (t.id === tabId ? { ...t, ...patch(t) } : t)),
		})),
	});
}

/**
 * The turn starts in its tab, as each mode's transport shows it: the drain here writes the card
 * (with its queue item id); a host's transcript brings its own user entry, which carries none.
 */
function startTurn(mode: AgentMode, tabId: string): void {
	if (mode !== 'hosted') return;
	const card: LogEntry = { id: 'host-u1', timestamp: 5, source: 'user', text: 'hello' };
	patchTab(tabId, (t) => ({ state: 'busy', logs: [...t.logs, card] }));
}

function finishTurn(tabId: string): void {
	patchTab(tabId, (t) => ({
		state: 'idle',
		logs: [...t.logs, { id: 'out-1', timestamp: 6, source: 'stdout', text: 'answer' }],
	}));
}

describe('Quick Chat in every agent mode', () => {
	beforeEach(() => {
		resetQuickChatEngineForTests();
		resetStores(usePeerMirrorStore, useSessionStore);
		useSettingsStore.setState({
			federationHostedAgents: true,
			quickChatSettings: { ...DEFAULT_QUICK_CHAT_SETTINGS },
			defaultSaveToHistory: true,
			automaticTabNamingEnabled: true,
			primaryAgentId: null,
		});
		registerDispatchDepsProvider(() => ({
			conductorProfile: '',
			customAICommands: [],
			speckitCommands: [],
			openspecCommands: [],
		}));
		useAgentStore.setState({ processQueuedItem: vi.fn().mockResolvedValue(true) });
		interrupt$.mockReset().mockResolvedValue(true);
		(window.maestro.process as { interrupt?: unknown }).interrupt = interrupt$;
		act$.mockReset().mockImplementation(async (_peer, _agent, action: { kind: string }) => {
			switch (action.kind) {
				case 'new-tab':
					return { ok: true, result: { kind: 'new-tab', tabId: HOST_TAB } };
				case 'send':
					return { ok: true, result: { kind: 'send', receipt: { status: 'started' } } };
				default:
					return { ok: true, result: { kind: action.kind } };
			}
		});
		maestro.federation = { act: act$ };
	});

	afterEach(() => {
		registerDispatchDepsProvider(null);
		delete maestro.federation;
	});

	it.each(AGENT_MODES)(
		'%s: a message runs in a hidden background tab and its reply comes back',
		async (mode) => {
			seed(mode);
			await runQuickChatCommand({ type: 'send', text: 'hello' });
			await vi.waitFor(() => expect(sent()[0]?.route?.status).toBe('running'));

			const tabId = sent()[0].route!.tabId!;
			expect(row().aiTabs.find((t) => t.id === tabId)).toMatchObject({
				quickChat: true,
				hidden: true,
				saveToHistory: true,
			});
			// The user's view did not move.
			expect(row().activeTabId).toBe('main');

			startTurn(mode, tabId);
			expect(sent()[0].route?.status).toBe('running');
			finishTurn(tabId);
			expect(sent()[0].route?.status).toBe('done');
			expect(buildQuickChatSnapshot().messages.map((m) => m.text)).toContain('answer');

			// Only the transport differs.
			const spawned = vi.mocked(useAgentStore.getState().processQueuedItem);
			if (mode === 'hosted') {
				expect(tabId).toBe(HOST_TAB);
				expect(actions('new-tab')).toHaveLength(1);
				expect(actions('send')).toEqual([
					expect.objectContaining({ kind: 'send', tabId: HOST_TAB, text: 'hello' }),
				]);
				expect(spawned).not.toHaveBeenCalled();
			} else {
				expect(spawned).toHaveBeenCalledWith(
					'row',
					expect.objectContaining({ tabId, text: 'hello' }),
					expect.anything()
				);
				expect(act$).not.toHaveBeenCalled();
			}
		}
	);

	it.each(AGENT_MODES)('%s: Stop interrupts the reply where it runs', async (mode) => {
		seed(mode);
		await runQuickChatCommand({ type: 'send', text: 'hello' });
		await vi.waitFor(() => expect(sent()[0]?.route?.status).toBe('running'));
		const tabId = sent()[0].route!.tabId!;
		startTurn(mode, tabId);

		await runQuickChatCommand({ type: 'stop' });

		if (mode === 'hosted') {
			expect(actions('interrupt')).toEqual([{ kind: 'interrupt', tabId: HOST_TAB }]);
			expect(interrupt$).not.toHaveBeenCalled();
		} else {
			expect(interrupt$).toHaveBeenCalledWith(`row-ai-${tabId}`);
			expect(act$).not.toHaveBeenCalled();
		}
	});

	it('hosted: a message the host queues behind a running reply is followed by its queue id', async () => {
		seed('hosted');
		act$.mockImplementation(async (_peer, _agent, action: { kind: string }) =>
			action.kind === 'new-tab'
				? { ok: true, result: { kind: 'new-tab', tabId: HOST_TAB } }
				: action.kind === 'send'
					? {
							ok: true,
							result: {
								kind: 'send',
								receipt: { status: 'queued', itemId: 'host-q1', position: 1, queueLength: 1 },
							},
						}
					: { ok: true, result: { kind: action.kind } }
		);
		await runQuickChatCommand({ type: 'send', text: 'hello' });
		await vi.waitFor(() => expect(actions('send')).toHaveLength(1));
		await vi.waitFor(() => expect(sent()[0]?.route?.status).not.toBe('searching'));
		// The host's queue reaches this record as a host queue card.
		useSessionStore.setState({
			sessions: [
				{
					...row(),
					executionQueue: [
						{
							id: 'host-q1',
							timestamp: 1,
							tabId: HOST_TAB,
							type: 'message',
							text: 'hello',
							hostQueued: true,
						},
					],
				},
			],
		});
		expect(sent()[0].route?.status).toBe('queued');

		await runQuickChatCommand({ type: 'stop' });
		expect(actions('remove-queued')).toEqual([{ kind: 'remove-queued', itemId: 'host-q1' }]);
		expect(sent()[0].route?.status).toBe('cancelled');
	});
});
