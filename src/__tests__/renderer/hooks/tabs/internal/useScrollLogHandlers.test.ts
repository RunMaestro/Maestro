import { renderHook, act, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useScrollLogHandlers } from '../../../../../renderer/hooks/tabs/internal/useScrollLogHandlers';
import { createMockAITab, getSession, resetTabHandlerStores, setupSession } from './testUtils';

describe('useScrollLogHandlers', () => {
	beforeEach(() => {
		resetTabHandlerStores();
	});

	afterEach(() => {
		cleanup();
	});

	it('updates active AI tab scroll and at-bottom unread state', () => {
		const tab = createMockAITab({ id: 'ai-1', hasUnread: true });
		setupSession({ aiTabs: [tab] });
		const { result } = renderHook(() => useScrollLogHandlers());

		act(() => {
			result.current.handleScrollPositionChange(123);
			result.current.handleAtBottomChange(true);
		});

		expect(getSession().aiTabs[0]).toMatchObject({
			scrollTop: 123,
			isAtBottom: true,
			hasUnread: false,
		});
	});

	it('updates terminal scroll when terminal mode is active', () => {
		setupSession({ inputMode: 'terminal' });
		const { result } = renderHook(() => useScrollLogHandlers());

		act(() => {
			result.current.handleScrollPositionChange(456);
		});

		expect(getSession().terminalScrollTop).toBe(456);
	});

	it('deletes an AI user message pair and command history entry', async () => {
		const tab = createMockAITab({
			id: 'ai-1',
			agentSessionId: 'agent-1',
			logs: [
				{ id: 'u1', source: 'user', text: 'run tests', timestamp: Date.now() },
				{ id: 'a1', source: 'claude', text: 'ok', timestamp: Date.now() },
				{ id: 'u2', source: 'user', text: 'next', timestamp: Date.now() },
			] as any,
		});
		setupSession({
			aiTabs: [tab],
			cwd: '/repo',
			aiCommandHistory: ['run tests', 'next'],
		});
		vi.mocked(window.maestro.claude.deleteMessagePair).mockResolvedValue({ success: true });
		const { result } = renderHook(() => useScrollLogHandlers());

		let nextIndex: number | null = null;
		act(() => {
			nextIndex = result.current.handleDeleteLog('u1');
		});

		expect(nextIndex).toBe(0);
		expect(getSession().aiTabs[0].logs.map((log) => log.id)).toEqual(['u2']);
		expect(getSession().aiCommandHistory).toEqual(['next']);
		await vi.waitFor(() => {
			expect(window.maestro.claude.deleteMessagePair).toHaveBeenCalledWith(
				'/repo',
				'agent-1',
				'u1',
				'run tests'
			);
		});
	});

	it('deletes shell logs and returns null for non-user logs', () => {
		setupSession({
			inputMode: 'terminal',
			shellLogs: [
				{ id: 's1', source: 'system', text: 'boot', timestamp: Date.now() },
				{ id: 'u1', source: 'user', text: 'pwd', timestamp: Date.now() },
				{ id: 'o1', source: 'stdout', text: '/repo', timestamp: Date.now() },
			] as any,
			shellCommandHistory: ['pwd'],
		});
		const { result } = renderHook(() => useScrollLogHandlers());

		expect(result.current.handleDeleteLog('s1')).toBeNull();
		act(() => {
			expect(result.current.handleDeleteLog('u1')).toBeNull();
		});

		expect(getSession().shellLogs.map((log) => log.id)).toEqual(['s1']);
		expect(getSession().shellCommandHistory).toEqual([]);
	});
});
