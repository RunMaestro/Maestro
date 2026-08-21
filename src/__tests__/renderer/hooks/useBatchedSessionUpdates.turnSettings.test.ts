/**
 * Streamed agent output must be stamped with the configuration the turn was
 * SENT with, not with whatever the agent is configured with by the time the
 * output lands. Settings are codified at send: changing the model or effort
 * mid-turn applies from the next message, so the transcript has to keep
 * attributing the running turn to its original configuration.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBatchedSessionUpdates } from '../../../renderer/hooks/session/useBatchedSessionUpdates';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import type { AITab, LogEntry } from '../../../renderer/types';

const SESSION_ID = 'session-1';
const TAB_ID = 'tab-1';

function seed(tabOverrides: Partial<AITab>): void {
	useSessionStore.setState({
		sessions: [
			createMockSession({
				id: SESSION_ID,
				activeTabId: TAB_ID,
				aiTabs: [createMockAITab({ id: TAB_ID, logs: [], ...tabOverrides })],
			}),
		],
		activeSessionId: SESSION_ID,
	});
}

function tabLogs(): LogEntry[] {
	const session = useSessionStore.getState().sessions.find((s) => s.id === SESSION_ID);
	return session?.aiTabs.find((t) => t.id === TAB_ID)?.logs ?? [];
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('useBatchedSessionUpdates - turn settings stamped on agent output', () => {
	it("stamps the entry with the turn's codified model and effort", () => {
		seed({ turnModel: 'opus', turnEffort: 'high' });

		const { result } = renderHook(() => useBatchedSessionUpdates());

		act(() => {
			result.current.appendLog(SESSION_ID, TAB_ID, true, 'Working on it.');
			result.current.flushNow();
		});

		const [entry] = tabLogs();
		expect(entry.turnModel).toBe('opus');
		expect(entry.turnEffort).toBe('high');
	});

	it('ignores a model change made while the turn is still streaming', () => {
		// The user switched the tab to sonnet mid-turn. That applies to the NEXT
		// message; this response still came from opus and must say so.
		seed({ turnModel: 'opus', turnEffort: 'high', customModel: 'sonnet', customEffort: 'low' });

		const { result } = renderHook(() => useBatchedSessionUpdates());

		act(() => {
			result.current.appendLog(SESSION_ID, TAB_ID, true, 'Still the opus turn.');
			result.current.flushNow();
		});

		const [entry] = tabLogs();
		expect(entry.turnModel).toBe('opus');
		expect(entry.turnEffort).toBe('high');
	});

	it('leaves the entry unstamped when the agent default was in force', () => {
		seed({});

		const { result } = renderHook(() => useBatchedSessionUpdates());

		act(() => {
			result.current.appendLog(SESSION_ID, TAB_ID, true, 'Default configuration.');
			result.current.flushNow();
		});

		const [entry] = tabLogs();
		expect(entry.turnModel).toBeUndefined();
		expect(entry.turnEffort).toBeUndefined();
	});
});
