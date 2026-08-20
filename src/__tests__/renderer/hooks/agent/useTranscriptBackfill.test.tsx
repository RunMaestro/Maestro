/**
 * Tests for useTranscriptBackfill - scroll-to-top history loading (issue #1407).
 *
 * An AI tab only holds the newest slice of its conversation, so the behaviours
 * that matter are: a page of older history actually lands at the head of the
 * tab, successive pages widen the read window rather than re-reading the same
 * one, the caller is told how many entries were prepended (so the render window
 * can absorb them), and the hook stops once the transcript is exhausted.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useTranscriptBackfill } from '../../../../renderer/hooks/agent/useTranscriptBackfill';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { createMockSession } from '../../../helpers/mockSession';
import type { AITab, Session } from '../../../../renderer/types';

const read = vi.fn();

/** A provider transcript message as agentSessions.read returns it. */
function message(n: number) {
	return {
		type: n % 2 === 0 ? 'user' : 'assistant',
		content: `message ${n}`,
		timestamp: new Date(1_700_000_000_000 + n * 1000).toISOString(),
		uuid: `uuid-${n}`,
	};
}

/** The newest `count` of a `total`-message transcript, as storage would page it. */
function page(total: number, count: number) {
	const start = Math.max(0, total - count);
	return {
		messages: Array.from({ length: total - start }, (_, i) => message(start + i)),
		total,
		hasMore: start > 0,
	};
}

function makeTab(overrides: Partial<AITab> = {}): AITab {
	return {
		id: 'tab-1',
		agentSessionId: 'agent-session-1',
		name: null,
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: 0,
		state: 'idle',
		...overrides,
	} as AITab;
}

function seedStore(tab: AITab): Session {
	const session = createMockSession({
		id: 'sess-1',
		toolType: 'claude-code',
		projectRoot: '/repo',
		activeTabId: tab.id,
		aiTabs: [tab],
	} as Partial<Session>);
	useSessionStore.setState({ sessions: [session] } as never);
	return session;
}

/** Logs on the seeded tab, read back out of the store. */
function storedLogs(): string[] {
	const tab = useSessionStore.getState().sessions[0]?.aiTabs?.[0];
	return (tab?.logs ?? []).map((l) => l.text);
}

beforeEach(() => {
	vi.clearAllMocks();
	useSessionStore.setState({
		sessions: [],
		groups: [],
		activeSessionId: '',
		initialLoadComplete: false,
		removedWorktreePaths: new Set(),
	} as never);
	(window as any).maestro = {
		...((window as any).maestro || {}),
		agentSessions: { read },
	};
});

describe('useTranscriptBackfill', () => {
	it('prepends older history above what the tab already shows', async () => {
		// Tab holds the newest 2 of a 10-message transcript.
		const visible = [message(8), message(9)].map((m) => ({
			id: m.uuid,
			timestamp: new Date(m.timestamp).getTime(),
			source: 'user' as const,
			text: m.content,
		}));
		const session = seedStore(makeTab({ logs: visible }));
		read.mockResolvedValue(page(10, 10));

		const { result } = renderHook(() =>
			useTranscriptBackfill(session, useSessionStore.getState().sessions[0].aiTabs![0])
		);

		act(() => result.current.loadEarlier());
		await waitFor(() => expect(result.current.isLoading).toBe(false));

		// All 8 older messages land at the head; the 2 already on screen are not duplicated.
		expect(storedLogs()).toEqual([
			...Array.from({ length: 8 }, (_, i) => `message ${i}`),
			'message 8',
			'message 9',
		]);
	});

	it('reports the prepended count so the render window can absorb it', async () => {
		const session = seedStore(makeTab({ logs: [] }));
		read.mockResolvedValue(page(4, 4));
		const onPrepend = vi.fn();

		const { result } = renderHook(() =>
			useTranscriptBackfill(session, useSessionStore.getState().sessions[0].aiTabs![0], {
				onPrepend,
			})
		);

		act(() => result.current.loadEarlier());
		await waitFor(() => expect(result.current.isLoading).toBe(false));

		expect(onPrepend).toHaveBeenCalledWith(4);
	});

	it('widens the read window on each successive page', async () => {
		const session = seedStore(makeTab({ logs: [] }));
		read.mockResolvedValue(page(2000, 250));

		const { result } = renderHook(() =>
			useTranscriptBackfill(session, useSessionStore.getState().sessions[0].aiTabs![0])
		);

		act(() => result.current.loadEarlier());
		await waitFor(() => expect(result.current.isLoading).toBe(false));
		act(() => result.current.loadEarlier());
		await waitFor(() => expect(result.current.isLoading).toBe(false));

		expect(read.mock.calls[0][3]).toEqual({ offset: 0, limit: 250 });
		expect(read.mock.calls[1][3]).toEqual({ offset: 0, limit: 500 });
	});

	it('stops once the window covers the whole transcript', async () => {
		const session = seedStore(makeTab({ logs: [] }));
		read.mockResolvedValue(page(3, 3)); // hasMore: false

		const { result } = renderHook(() =>
			useTranscriptBackfill(session, useSessionStore.getState().sessions[0].aiTabs![0])
		);

		act(() => result.current.loadEarlier());
		await waitFor(() => expect(result.current.reachedStart).toBe(true));

		act(() => result.current.loadEarlier());
		expect(read).toHaveBeenCalledTimes(1);
	});

	it('does nothing for a tab with no agent session on disk', () => {
		const session = seedStore(makeTab({ agentSessionId: null }));

		const { result } = renderHook(() =>
			useTranscriptBackfill(session, useSessionStore.getState().sessions[0].aiTabs![0])
		);

		act(() => result.current.loadEarlier());
		expect(read).not.toHaveBeenCalled();
	});

	it('surfaces a retryable error when the read fails', async () => {
		const session = seedStore(makeTab({ logs: [] }));
		read.mockRejectedValue(new Error('ENOENT'));

		const { result } = renderHook(() =>
			useTranscriptBackfill(session, useSessionStore.getState().sessions[0].aiTabs![0])
		);

		act(() => result.current.loadEarlier());
		await waitFor(() => expect(result.current.error).toBe('Could not load earlier messages'));

		// A failed read must not latch the hook shut - the user can retry.
		expect(result.current.reachedStart).toBe(false);
		read.mockResolvedValue(page(2, 2));
		act(() => result.current.loadEarlier());
		await waitFor(() => expect(result.current.error).toBeNull());
		expect(storedLogs()).toEqual(['message 0', 'message 1']);
	});
});
