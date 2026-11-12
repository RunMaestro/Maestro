/**
 * Tests for src/renderer/services/reopenClosedTab.ts
 *
 * The renderer half of `maestro-cli tab reopen`. It must reopen into the agent
 * the caller NAMED (not the active one), say so when there is nothing to
 * reopen, and leave the agent's visible tab alone on a background reopen.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { reopenClosedTabInAgent } from '../../../renderer/services/reopenClosedTab';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import { NOTHING_TO_REOPEN_ERROR } from '../../../shared/reopenClosedTab';
import type { ClosedTabEntry, Session } from '../../../renderer/types';

function agentWithClosedTab(id: string): Session {
	const open = createMockAITab({ id: `${id}-open` });
	const closed = createMockAITab({ id: `${id}-closed`, agentSessionId: `${id}-provider` });
	const entry: ClosedTabEntry = { type: 'ai', tab: closed, unifiedIndex: 1, closedAt: 1 };
	return createMockSession({
		id,
		aiTabs: [open],
		activeTabId: open.id,
		unifiedTabOrder: [{ type: 'ai', id: open.id }],
		unifiedClosedTabHistory: [entry],
		closedTabHistory: [],
	});
}

const sessionById = (id: string) => useSessionStore.getState().sessions.find((s) => s.id === id)!;

describe('reopenClosedTabInAgent', () => {
	beforeEach(() => {
		useSessionStore.setState({
			sessions: [agentWithClosedTab('agent-a'), agentWithClosedTab('agent-b')],
			activeSessionId: 'agent-a',
		});
	});

	it('reopens into the named agent, not the active one, and activates the tab', () => {
		const result = reopenClosedTabInAgent('agent-b');

		expect(result).toMatchObject({ success: true, tabType: 'ai', background: false });
		if (!result.success) throw new Error('expected success');
		const b = sessionById('agent-b');
		expect(b.aiTabs.some((t) => t.id === result.tabId)).toBe(true);
		expect(b.activeTabId).toBe(result.tabId);
		expect(b.unifiedClosedTabHistory).toHaveLength(0);
		// The active agent is untouched.
		expect(sessionById('agent-a').unifiedClosedTabHistory).toHaveLength(1);
	});

	it('keeps the visible tab on a background reopen', () => {
		const result = reopenClosedTabInAgent('agent-b', { background: true });

		expect(result).toMatchObject({ success: true, background: true });
		if (!result.success) throw new Error('expected success');
		const b = sessionById('agent-b');
		expect(b.aiTabs.some((t) => t.id === result.tabId)).toBe(true);
		expect(b.activeTabId).toBe('agent-b-open');
	});

	it('reports an empty history instead of pretending to succeed', () => {
		reopenClosedTabInAgent('agent-b');
		expect(reopenClosedTabInAgent('agent-b')).toEqual({
			success: false,
			error: NOTHING_TO_REOPEN_ERROR,
		});
	});

	it('reports an unknown agent', () => {
		expect(reopenClosedTabInAgent('nope')).toEqual({
			success: false,
			error: 'Session not found: nope',
		});
	});
});
