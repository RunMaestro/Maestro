import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTerminalMounting } from '../../../renderer/hooks/terminal/useTerminalMounting';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { Session } from '../../../renderer/types';

// Mock TerminalView to avoid importing xterm.js
vi.mock('../../../renderer/components/TerminalView', () => ({
	TerminalView: vi.fn(),
	TerminalViewHandle: {},
	createTabStateChangeHandler: vi.fn(),
	createTabPidChangeHandler: vi.fn(),
}));

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Test Session',
		cwd: '/test',
		fullPath: '/test',
		toolType: 'claude-code',
		inputMode: 'ai',
		aiTabs: [],
		terminalTabs: [],
		isGitRepo: false,
		bookmarked: false,
		...overrides,
	} as Session;
}

describe('useTerminalMounting', () => {
	beforeEach(() => {
		useSessionStore.setState({
			sessions: [makeSession()],
		});
	});

	it('returns initial empty state', () => {
		const { result } = renderHook(() => useTerminalMounting(null));

		expect(result.current.mountedTerminalSessionIds).toEqual([]);
		expect(result.current.terminalSearchOpen).toBe(false);
		expect(result.current.terminalViewRefs.current.size).toBe(0);
	});

	it('mounts session when it has terminal tabs', () => {
		const session = makeSession({
			terminalTabs: [{ id: 'tab-1', name: 'bash', state: 'idle' }] as Session['terminalTabs'],
		});

		const { result } = renderHook(() => useTerminalMounting(session));

		expect(result.current.mountedTerminalSessionIds).toContain('session-1');
		expect(result.current.mountedTerminalSessionsRef.current.has('session-1')).toBe(true);
	});

	it('does not mount session without terminal tabs', () => {
		const session = makeSession({ terminalTabs: [] });

		const { result } = renderHook(() => useTerminalMounting(session));

		expect(result.current.mountedTerminalSessionIds).toEqual([]);
	});

	it('removes session when terminal tabs are closed', () => {
		const session = makeSession({
			terminalTabs: [{ id: 'tab-1', name: 'bash', state: 'idle' }] as Session['terminalTabs'],
		});

		const { result, rerender } = renderHook(({ s }) => useTerminalMounting(s), {
			initialProps: { s: session },
		});

		expect(result.current.mountedTerminalSessionIds).toContain('session-1');

		// Close all terminal tabs
		const updated = makeSession({ terminalTabs: [] });
		rerender({ s: updated });

		expect(result.current.mountedTerminalSessionIds).not.toContain('session-1');
	});

	it('evicts deleted sessions from mounted set', () => {
		const session = makeSession({
			terminalTabs: [{ id: 'tab-1', name: 'bash', state: 'idle' }] as Session['terminalTabs'],
		});

		const { result } = renderHook(() => useTerminalMounting(session));
		expect(result.current.mountedTerminalSessionIds).toContain('session-1');

		// Remove session from store
		act(() => {
			useSessionStore.setState({ sessions: [] });
		});

		expect(result.current.mountedTerminalSessionIds).not.toContain('session-1');
		expect(result.current.mountedTerminalSessionsRef.current.has('session-1')).toBe(false);
	});

	it('closes terminal search when switching away from terminal mode', () => {
		const session = makeSession({ inputMode: 'terminal' });

		const { result, rerender } = renderHook(({ s }) => useTerminalMounting(s), {
			initialProps: { s: session },
		});

		// Open terminal search
		act(() => {
			result.current.setTerminalSearchOpen(true);
		});
		expect(result.current.terminalSearchOpen).toBe(true);

		// Switch to AI mode
		const updated = makeSession({ inputMode: 'ai' });
		rerender({ s: updated });

		expect(result.current.terminalSearchOpen).toBe(false);
	});

	it('does not remount already-mounted session', () => {
		const session = makeSession({
			terminalTabs: [{ id: 'tab-1', name: 'bash', state: 'idle' }] as Session['terminalTabs'],
		});

		const { result, rerender } = renderHook(({ s }) => useTerminalMounting(s), {
			initialProps: { s: session },
		});

		const initialIds = result.current.mountedTerminalSessionIds;
		expect(initialIds).toContain('session-1');

		// Rerender with same session (same number of terminal tabs)
		rerender({ s: session });

		// Should be same array reference (no state update)
		expect(result.current.mountedTerminalSessionIds).toBe(initialIds);
	});

	it('provides stable terminalViewRefs across rerenders', () => {
		const session = makeSession();
		const { result, rerender } = renderHook(({ s }) => useTerminalMounting(s), {
			initialProps: { s: session },
		});

		const refs1 = result.current.terminalViewRefs;
		rerender({ s: session });
		const refs2 = result.current.terminalViewRefs;

		expect(refs1).toBe(refs2);
	});

	it('handles null session gracefully', () => {
		const { result } = renderHook(() => useTerminalMounting(null));

		expect(result.current.mountedTerminalSessionIds).toEqual([]);
		expect(result.current.terminalSearchOpen).toBe(false);
	});
});
