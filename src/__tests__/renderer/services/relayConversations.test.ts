import { resetStores } from '../../helpers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockSession } from '../../helpers/mockSession';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { useHeadlessActivityStore } from '../../../renderer/stores/headlessActivityStore';
import {
	applyRelayConversationRuntime,
	subscribeRelayConversations,
	sweepRelayConversations,
} from '../../../renderer/services/relayConversations';
import { canArchiveRelayConversation } from '../../../shared/relayConversation';
import { createTab, revealAiTab } from '../../../renderer/utils/tabHelpers';
import { visibleAiTabs } from '../../../renderer/utils/unifiedTabOrderUtils';
import type { AITab, Session } from '../../../renderer/types';

const hour = 3_600_000;
let session: Session;
let tab: AITab;
let cleanup: (() => void) | undefined;
beforeEach(() => {
	resetStores(useSessionStore, useSettingsStore, useHeadlessActivityStore);
	session = createMockSession({
		id: 'agent',
		activeTabId: 'selected',
		aiTabs: [],
		executionQueue: [],
	});
	const result = createTab(session, {
		activate: false,
		agentSessionId: 'provider',
		origin: 'relay',
	})!;
	session = result.session;
	tab = result.tab;
	tab.relayConversation = {
		conversationId: 'thread',
		messageId: 'message',
		status: 'idle',
		lastActivityAt: 1000,
		completedAt: 1000,
	};
	useSessionStore.setState({
		sessions: [session],
		activeSessionId: session.id,
		initialLoadComplete: true,
	});
	useSettingsStore.setState({ relayArchiveHours: 24 });
	useHeadlessActivityStore.setState({ counts: {} });
});
afterEach(() => {
	vi.useRealTimers();
	cleanup?.();
	cleanup = undefined;
});

describe('Relay archive and restoration', () => {
	it('archives at 24h while retaining transcript, provider identity and restore', () => {
		sweepRelayConversations(1000 + 24 * hour - 1);
		expect(visibleAiTabs(useSessionStore.getState().sessions[0].aiTabs)).toHaveLength(1);
		sweepRelayConversations(1000 + 24 * hour);
		const archived = useSessionStore.getState().sessions[0];
		expect(visibleAiTabs(archived.aiTabs)).toHaveLength(0);
		expect(archived.aiTabs[0].agentSessionId).toBe('provider');
		expect(archived.aiTabs[0].id).toBe(tab.id);
		const restored = revealAiTab(archived, tab.id);
		expect(visibleAiTabs(restored.aiTabs)).toHaveLength(1);
		expect(restored.aiTabs[0].relayConversation?.archivedAt).toBeUndefined();
	});
	it.each([
		[
			'idle without task completion',
			{ relayConversation: { conversationId: 'thread', status: 'idle', lastActivityAt: 1000 } },
		],
		['running', { state: 'busy' }],
		['starred', { starred: true }],
		['unread', { hasUnread: true }],
		['text draft', { inputValue: 'draft' }],
		['image draft', { stagedImages: ['image'] }],
		['merge draft', { pendingMergedContext: 'pending' }],
		['open wizard', { wizardState: {} }],
		[
			'error',
			{
				relayConversation: {
					conversationId: 'thread',
					status: 'error',
					lastActivityAt: 1000,
					completedAt: 1000,
				},
			},
		],
	])('protects %s', (_name, patch) => {
		const candidate = { ...tab, ...patch } as AITab;
		expect(
			canArchiveRelayConversation(candidate, {
				now: 1000 + 25 * hour,
				hours: 24,
				selected: false,
				queued: false,
				busy: false,
			})
		).toBe(false);
	});
	it.each(['selected', 'queued', 'busy'] as const)('protects %s conversations', (flag) => {
		expect(
			canArchiveRelayConversation(tab, {
				now: 1000 + 25 * hour,
				hours: 24,
				selected: false,
				queued: false,
				busy: false,
				[flag]: true,
			})
		).toBe(false);
	});
	it('supports a different archive period and disabling, and ignores ordinary tabs', () => {
		useSettingsStore.setState({ relayArchiveHours: 0 });
		sweepRelayConversations(1000 + 48 * hour);
		expect(useSessionStore.getState().sessions[0].aiTabs[0].hidden).not.toBe(true);
		useSettingsStore.setState({ relayArchiveHours: 48 });
		sweepRelayConversations(1000 + 25 * hour);
		expect(useSessionStore.getState().sessions[0].aiTabs[0].hidden).not.toBe(true);
		expect(
			canArchiveRelayConversation(
				{ ...tab, relayConversation: undefined },
				{ now: 1000 + 25 * hour, hours: 24, selected: false, queued: false, busy: false }
			)
		).toBe(false);
	});
	it('restores explicit host running/queued/error states, without inventing completion', () => {
		tab.relayConversation!.status = 'running';
		expect(applyRelayConversationRuntime(session).aiTabs[0].state).toBe('busy');
		tab.relayConversation!.status = 'queued';
		expect(applyRelayConversationRuntime(session).aiTabs[0].state).toBe('busy');
		tab.relayConversation!.status = 'error';
		expect(applyRelayConversationRuntime(session).aiTabs[0]).toMatchObject({
			state: 'idle',
			agentError: { type: 'unknown' },
		});
	});
	it.each(['running', 'queued'] as const)(
		'does not revive persisted %s as a native live turn',
		(status) => {
			tab.relayConversation!.status = status;
			tab.state = 'busy';
			tab.thinkingStartTime = 999;
			const restored = applyRelayConversationRuntime(session, undefined, 'persisted').aiTabs[0];
			expect(restored.state).toBe('idle');
			expect(restored.thinkingStartTime).toBeUndefined();
			expect(restored.relayConversation).toEqual(tab.relayConversation);
		}
	);

	it('allows fresh live updates to reassert running after unverified native restoration', () => {
		tab.relayConversation!.status = 'running';
		const restored = applyRelayConversationRuntime(session, undefined, 'persisted');
		const live = {
			...restored,
			aiTabs: restored.aiTabs.map((t) => ({
				...t,
				relayConversation: { ...t.relayConversation!, lastActivityAt: 2000 },
			})),
		};
		expect(applyRelayConversationRuntime(live, restored).aiTabs[0]).toMatchObject({
			state: 'busy',
			thinkingStartTime: 2000,
		});
	});

	it('settles a reattached Relay parent when the Host reports completion', async () => {
		const { applyLiveAiTurns } = await import('../../../renderer/utils/liveTurnReattach');
		tab.relayConversation!.status = 'running';
		const live = applyLiveAiTurns(
			[session],
			[{ sessionId: session.id, tabId: tab.id, pid: 0, startTime: 1000 }]
		)[0];
		const complete = {
			...live,
			aiTabs: live.aiTabs.map((t) => ({
				...t,
				relayConversation: { ...t.relayConversation!, status: 'idle' as const },
			})),
		};
		const settled = applyRelayConversationRuntime(complete, live);
		expect(settled.aiTabs[0].state).toBe('idle');
		expect(settled.state).toBe('idle');
		expect(settled.busySource).toBeUndefined();
		expect(settled.thinkingStartTime).toBeUndefined();
		// A snapshot requested before completion may arrive after its lifecycle event.
		expect(applyLiveAiTurns([settled], [{ sessionId: session.id, tabId: tab.id, pid: 0 }])[0]).toBe(
			settled
		);
		const failed = {
			...settled,
			aiTabs: settled.aiTabs.map((t) => ({
				...t,
				relayConversation: { ...t.relayConversation!, status: 'error' as const },
			})),
		};
		expect(applyLiveAiTurns([failed], [{ sessionId: session.id, tabId: tab.id, pid: 0 }])[0]).toBe(
			failed
		);
		const closed = { ...settled, aiTabs: [] };
		expect(applyLiveAiTurns([closed], [{ sessionId: session.id, tabId: tab.id, pid: 0 }])[0]).toBe(
			closed
		);
	});

	it.each(['queued', 'running'] as const)(
		'reattaches a %s Host turn on normal and orphaned tabs',
		async (status) => {
			const { applyLiveAiTurns } = await import('../../../renderer/utils/liveTurnReattach');
			tab.relayConversation!.status = status;
			for (const orphaned of [false, true]) {
				const restored = {
					...session,
					aiTabs: orphaned ? [] : [tab],
					orphanedThinkingTabs: orphaned ? [tab] : [],
				};
				const live = applyLiveAiTurns(
					[restored],
					[{ sessionId: session.id, tabId: tab.id, pid: 0 }]
				)[0];
				expect(live.state).toBe('busy');
				expect((orphaned ? live.orphanedThinkingTabs! : live.aiTabs)[0].state).toBe('busy');
			}
		}
	);

	it.each(['busy', 'waiting_input', 'error'] as const)(
		'preserves unrelated %s runtime when a Relay tab settles',
		(state) => {
			const before = structuredClone(session);
			tab.relayConversation!.status = 'idle';
			tab.relayConversation!.lastActivityAt = 2000;
			session.state = state;
			session.busySource = state === 'busy' ? 'terminal' : 'ai';
			session.aiPid = 0;
			expect(applyRelayConversationRuntime(session, before).state).toBe(state);
		}
	);

	it('preserves another busy AI tab when a reattached Relay turn completes', () => {
		const before = structuredClone(session);
		tab.relayConversation!.status = 'idle';
		tab.relayConversation!.lastActivityAt = 2000;
		session.state = 'busy';
		session.busySource = 'ai';
		session.aiPid = 0;
		session.aiTabs.push({ ...tab, id: 'other', relayConversation: undefined, state: 'busy' });
		expect(applyRelayConversationRuntime(session, before).state).toBe('busy');
	});

	it('does not clear a newer desktop running state on an unchanged lifecycle echo', () => {
		const baseline = structuredClone(session);
		tab.state = 'busy';
		expect(applyRelayConversationRuntime(session, baseline).aiTabs[0].state).toBe('busy');
	});
	it('clears explicit completion when the desktop continues the conversation', () => {
		cleanup = subscribeRelayConversations();
		useSessionStore.getState().updateSession(session.id, {
			aiTabs: [
				{
					...tab,
					logs: [{ id: 'desktop-followup', source: 'user', timestamp: 2000, text: 'continue' }],
				},
			],
		});
		expect(
			useSessionStore.getState().sessions[0].aiTabs[0].relayConversation?.completedAt
		).toBeUndefined();
	});
	it('preserves completion when reading older user messages', () => {
		tab.logs = [{ id: 'answer', source: 'stdout', timestamp: 1000, text: 'done' }];
		cleanup = subscribeRelayConversations();
		useSessionStore.getState().updateSession(session.id, {
			aiTabs: [
				{
					...tab,
					logs: [
						{ id: 'historical-user', source: 'user', timestamp: 500, text: 'earlier' },
						...tab.logs,
					],
				},
			],
		});
		expect(useSessionStore.getState().sessions[0].aiTabs[0].relayConversation?.completedAt).toBe(
			1000
		);
		const current = useSessionStore.getState().sessions[0].aiTabs[0];
		useSessionStore.getState().updateSession(session.id, {
			aiTabs: [
				{
					...current,
					logs: [
						...current.logs,
						{ id: 'new-user', source: 'user', timestamp: 2000, text: 'continue' },
					],
				},
			],
		});
		expect(
			useSessionStore.getState().sessions[0].aiTabs[0].relayConversation?.completedAt
		).toBeUndefined();
	});
	it('keeps continuation and backfill scoped to their tabs across reordered agents', () => {
		vi.useFakeTimers();
		vi.setSystemTime(3000);
		const agents = ['first', 'second', 'unowned'].map((id) =>
			createMockSession({
				id,
				aiTabs: ['continue', 'backfill'].map((name) => ({
					...tab,
					id: `${id}-${name}`,
					hidden: true,
					logs: [{ id: `${id}-${name}-answer`, source: 'stdout', timestamp: 1000, text: 'done' }],
					relayConversation: { ...tab.relayConversation!, archivedAt: 1000 },
				})),
			})
		);
		useSessionStore.setState({ sessions: agents });
		cleanup = subscribeRelayConversations((id) => id !== 'unowned');
		useSessionStore.setState({
			sessions: agents.toReversed().map((agent) => ({
				...agent,
				aiTabs: agent.aiTabs.toReversed().map((item) => ({
					...item,
					logs: item.id.endsWith('continue')
						? [
								...item.logs,
								{ id: `${item.id}-new`, source: 'user', timestamp: 2000, text: 'continue' },
							]
						: [
								{ id: `${item.id}-old`, source: 'user', timestamp: 500, text: 'earlier' },
								...item.logs,
							],
				})),
			})),
		});
		for (const agent of useSessionStore.getState().sessions) {
			for (const item of agent.aiTabs) {
				const continued = agent.id !== 'unowned' && item.id.endsWith('continue');
				expect(item.hidden).toBe(!continued);
				expect(item.relayConversation).toMatchObject({
					completedAt: continued ? undefined : 1000,
					archivedAt: continued ? undefined : 1000,
					lastActivityAt: continued ? 3000 : 1000,
				});
			}
		}
	});
	it('restarts the archive period after deliberate reveal without losing completion', () => {
		vi.useFakeTimers();
		const now = 1000 + 30 * hour;
		vi.setSystemTime(now);
		sweepRelayConversations(now);
		const revealed = revealAiTab(useSessionStore.getState().sessions[0], tab.id);
		useSessionStore.setState({ sessions: [revealed] });
		expect(revealed.aiTabs[0].relayConversation?.completedAt).toBe(1000);
		sweepRelayConversations(now + 24 * hour - 1);
		expect(useSessionStore.getState().sessions[0].aiTabs[0].hidden).toBe(false);
		sweepRelayConversations(now + 24 * hour);
		expect(useSessionStore.getState().sessions[0].aiTabs[0].hidden).toBe(true);
	});
	it('adopts origin without clearing an already active desktop writer', () => {
		tab.state = 'busy';
		tab.relayConversation!.messageId = undefined;
		expect(applyRelayConversationRuntime(session).aiTabs[0].state).toBe('busy');
	});
});
