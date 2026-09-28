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

	describe('deleting a command-mode card', () => {
		function cardLog(id: string, command: string) {
			return {
				id,
				source: 'stdout',
				text: 'output',
				timestamp: Date.now(),
				shellCommand: { command, cwd: '/repo', status: 'finished', exitCode: 0 },
			};
		}

		it('removes just that card and prunes its bang-prefixed recall entry', () => {
			const tab = createMockAITab({
				id: 'ai-1',
				agentSessionId: 'agent-1',
				logs: [
					{ id: 'u1', source: 'user', text: 'run tests', timestamp: Date.now() },
					cardLog('c1', 'npm test'),
					{ id: 'a1', source: 'claude', text: 'ok', timestamp: Date.now() },
				] as any,
			});
			setupSession({ aiTabs: [tab], cwd: '/repo', aiCommandHistory: ['!npm test', 'run tests'] });
			const { result } = renderHook(() => useScrollLogHandlers());

			let nextIndex: number | null = 0;
			act(() => {
				nextIndex = result.current.handleDeleteLog('c1');
			});

			// Only the card goes; the surrounding conversation is untouched.
			expect(getSession().aiTabs[0].logs.map((log) => log.id)).toEqual(['u1', 'a1']);
			expect(getSession().aiCommandHistory).toEqual(['run tests']);
			// No scroll target - removing a card should not move the reader.
			expect(nextIndex).toBeNull();
		});

		it('never asks the provider to delete a message pair for it', () => {
			// The agent was bypassed entirely, so there is no pair in its session.
			const tab = createMockAITab({
				id: 'ai-1',
				agentSessionId: 'agent-1',
				logs: [cardLog('c1', 'npm test')] as any,
			});
			setupSession({ aiTabs: [tab], cwd: '/repo', aiCommandHistory: ['!npm test'] });
			const { result } = renderHook(() => useScrollLogHandlers());

			act(() => {
				result.current.handleDeleteLog('c1');
			});

			expect(window.maestro.claude.deleteMessagePair).not.toHaveBeenCalled();
		});

		it('keeps the recall entry while another card still shows that command', () => {
			// aiCommandHistory is per agent and deduplicated, so pruning on the
			// first delete would contradict the cards still on screen.
			const tab = createMockAITab({
				id: 'ai-1',
				logs: [cardLog('c1', 'ls'), cardLog('c2', 'ls')] as any,
			});
			setupSession({ aiTabs: [tab], aiCommandHistory: ['!ls'] });
			const { result } = renderHook(() => useScrollLogHandlers());

			act(() => {
				result.current.handleDeleteLog('c1');
			});
			expect(getSession().aiCommandHistory).toEqual(['!ls']);

			act(() => {
				result.current.handleDeleteLog('c2');
			});
			expect(getSession().aiCommandHistory).toEqual([]);
		});

		it('counts survivors across every tab, not just the active one', () => {
			const active = createMockAITab({ id: 'ai-1', logs: [cardLog('c1', 'ls')] as any });
			const other = createMockAITab({ id: 'ai-2', logs: [cardLog('c2', 'ls')] as any });
			setupSession({ aiTabs: [active, other], aiCommandHistory: ['!ls'] });
			const { result } = renderHook(() => useScrollLogHandlers());

			act(() => {
				result.current.handleDeleteLog('c1');
			});

			// Guard against a silent no-op passing this assertion: the card really
			// went, and the recall entry really survived because ai-2 still has one.
			expect(getSession().aiTabs[0].logs).toEqual([]);
			expect(getSession().aiCommandHistory).toEqual(['!ls']);
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
