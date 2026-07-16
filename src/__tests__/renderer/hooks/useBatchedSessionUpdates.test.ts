import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useBatchedSessionUpdates } from '../../../renderer/hooks/session/useBatchedSessionUpdates';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';

describe('useBatchedSessionUpdates', () => {
	beforeEach(() => {
		vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
		useSessionStore.setState({
			sessions: [
				createMockSession({
					id: 'session-1',
					aiTabs: [createMockAITab({ id: 'tab-1' })],
					activeTabId: 'tab-1',
				}),
			],
			groups: [],
			activeSessionId: 'session-1',
			initialLoadComplete: true,
			removedWorktreePaths: new Set(),
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each([
		['stderr first', true],
		['stdout first', false],
	])('keeps same-frame stdout and stderr separate when %s', (_order, stderrFirst) => {
		const { result, unmount } = renderHook(() => useBatchedSessionUpdates());

		if (stderrFirst) {
			result.current.appendLog('session-1', 'tab-1', true, 'OMP actual failure', true);
			result.current.appendLog('session-1', 'tab-1', true, 'Hello! How can I help?', false);
		} else {
			result.current.appendLog('session-1', 'tab-1', true, 'Hello! How can I help?', false);
			result.current.appendLog('session-1', 'tab-1', true, 'OMP actual failure', true);
		}
		result.current.flushNow();

		const logs = useSessionStore.getState().sessions[0].aiTabs[0].logs;
		expect(logs).toHaveLength(2);
		expect(logs.map((log) => log.source)).toEqual(
			stderrFirst ? ['stderr', 'stdout'] : ['stdout', 'stderr']
		);
		expect(logs.find((log) => log.source === 'stdout')?.text).toBe('Hello! How can I help?');
		expect(logs.find((log) => log.source === 'stderr')?.text).toBe('OMP actual failure');

		unmount();
	});

	it('applies source-separated entries in timestamp order', () => {
		const { result, unmount } = renderHook(() => useBatchedSessionUpdates());
		vi.spyOn(Date, 'now')
			.mockReturnValueOnce(300)
			.mockReturnValueOnce(300)
			.mockReturnValueOnce(100)
			.mockReturnValueOnce(100);
		result.current.appendLog('session-1', 'tab-1', true, 'assistant', false);
		result.current.appendLog('session-1', 'tab-1', true, 'error', true);
		result.current.flushNow();

		const logs = useSessionStore.getState().sessions[0].aiTabs[0].logs;
		expect(logs.map((log) => [log.source, log.text])).toEqual([
			['stderr', 'error'],
			['stdout', 'assistant'],
		]);

		unmount();
	});
});
