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
