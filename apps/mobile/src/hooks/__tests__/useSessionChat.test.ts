/**
 * Tests for useSessionChat history-load behavior.
 *
 * Regression context: the Expo mobile chat screen used to start empty whenever
 * a session was opened; the hook was purely event-driven and never asked the
 * desktop for the existing conversation backlog. Fixing it added a
 * `get_session_history` request on session/tab change and a small dedupe-merge
 * step so the late-arriving response doesn't double-insert streaming events
 * that landed first.
 *
 * Per the codebase convention (see `messageRouting.test.ts`), these tests
 * mirror the production helpers rather than importing the hook directly:
 * pulling in `useSessionChat.ts` would drag in expo-haptics, React Context,
 * and the rest of the RN module graph. The helpers below are KEPT IN SYNC
 * INTENTIONALLY with `src/hooks/useSessionChat.ts` and
 * `src/lib/useMaestroWebSocket.ts`; changes to either must update both.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Mirrored types (kept in sync with src/lib/useMaestroWebSocket.ts)
// ---------------------------------------------------------------------------

type SessionHistoryMessage = {
	id: string;
	role: 'user' | 'assistant' | 'system' | 'tool' | 'thinking' | 'error' | 'unknown';
	source: string;
	content: string;
	timestamp: string;
};

type ChatMessage = {
	id: string;
	role: 'user' | 'assistant';
	content: string;
};

// ---------------------------------------------------------------------------
// Mirrored helper: historyToChatMessages
// (mirror of the function in src/hooks/useSessionChat.ts)
// ---------------------------------------------------------------------------

function historyToChatMessages(history: SessionHistoryMessage[]): ChatMessage[] {
	const result: ChatMessage[] = [];
	for (const entry of history) {
		if (!entry || typeof entry.content !== 'string' || entry.content.length === 0) continue;
		if (entry.role === 'user') {
			result.push({ id: entry.id, role: 'user', content: entry.content });
		} else if (entry.role === 'assistant') {
			result.push({ id: entry.id, role: 'assistant', content: entry.content });
		} else if (entry.role === 'tool') {
			const toolId = entry.id.startsWith('tool-') ? entry.id : `tool-${entry.id}`;
			result.push({ id: toolId, role: 'assistant', content: entry.content });
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// Mirrored merge: dedupe-prepend used after history arrives
// (mirror of the setMessages callback in the load-history effect)
// ---------------------------------------------------------------------------

function mergeHistoryIntoMessages(prev: ChatMessage[], initial: ChatMessage[]): ChatMessage[] {
	const seen = new Set(prev.map((m) => m.id));
	const deduped = initial.filter((m) => !seen.has(m.id));
	return deduped.length === 0 ? prev : [...deduped, ...prev];
}

// ---------------------------------------------------------------------------
// Tests: historyToChatMessages role mapping
// ---------------------------------------------------------------------------

describe('historyToChatMessages', () => {
	const baseEntry = { source: 'log', timestamp: '2026-06-20T10:00:00.000Z' } as const;

	it('maps user entries straight through', () => {
		const out = historyToChatMessages([{ ...baseEntry, id: 'u1', role: 'user', content: 'hello' }]);
		expect(out).toEqual([{ id: 'u1', role: 'user', content: 'hello' }]);
	});

	it('maps assistant entries straight through', () => {
		const out = historyToChatMessages([
			{ ...baseEntry, id: 'a1', role: 'assistant', content: 'hi back' },
		]);
		expect(out).toEqual([{ id: 'a1', role: 'assistant', content: 'hi back' }]);
	});

	it('prefixes tool ids with "tool-" so the renderer recognizes them', () => {
		const out = historyToChatMessages([
			{ ...baseEntry, id: 'abc123', role: 'tool', content: 'Running: Read' },
		]);
		expect(out).toEqual([{ id: 'tool-abc123', role: 'assistant', content: 'Running: Read' }]);
	});

	it('does not double-prefix tool ids that already start with "tool-"', () => {
		const out = historyToChatMessages([
			{ ...baseEntry, id: 'tool-xyz', role: 'tool', content: 'Completed: Edit' },
		]);
		expect(out).toEqual([{ id: 'tool-xyz', role: 'assistant', content: 'Completed: Edit' }]);
	});

	it('drops system, thinking, error, and unknown roles for parity with streaming', () => {
		const out = historyToChatMessages([
			{ ...baseEntry, id: 's1', role: 'system', content: 'system note' },
			{ ...baseEntry, id: 't1', role: 'thinking', content: 'thinking out loud' },
			{ ...baseEntry, id: 'e1', role: 'error', content: 'something broke' },
			{ ...baseEntry, id: 'x1', role: 'unknown', content: 'mystery' },
		]);
		expect(out).toEqual([]);
	});

	it('skips entries with empty content', () => {
		const out = historyToChatMessages([
			{ ...baseEntry, id: 'u1', role: 'user', content: '' },
			{ ...baseEntry, id: 'a1', role: 'assistant', content: 'kept' },
		]);
		expect(out).toEqual([{ id: 'a1', role: 'assistant', content: 'kept' }]);
	});

	it('skips entries with non-string content (defensive against malformed wire data)', () => {
		const out = historyToChatMessages([
			{ ...baseEntry, id: 'u1', role: 'user', content: null as any },
			{ ...baseEntry, id: 'u2', role: 'user', content: undefined as any },
			{ ...baseEntry, id: 'u3', role: 'user', content: 42 as any },
			{ ...baseEntry, id: 'a1', role: 'assistant', content: 'kept' },
		]);
		expect(out).toEqual([{ id: 'a1', role: 'assistant', content: 'kept' }]);
	});

	it('preserves order across mixed roles', () => {
		const out = historyToChatMessages([
			{ ...baseEntry, id: 'u1', role: 'user', content: 'q1' },
			{ ...baseEntry, id: 'a1', role: 'assistant', content: 'r1' },
			{ ...baseEntry, id: 'tool-1', role: 'tool', content: 'Running: X' },
			{ ...baseEntry, id: 'u2', role: 'user', content: 'q2' },
		]);
		expect(out.map((m) => m.id)).toEqual(['u1', 'a1', 'tool-1', 'u2']);
	});

	it('returns an empty array for an empty input', () => {
		expect(historyToChatMessages([])).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Tests: dedupe-prepend merge
// ---------------------------------------------------------------------------

describe('mergeHistoryIntoMessages', () => {
	it('prepends history before any messages that arrived during the fetch', () => {
		const prev: ChatMessage[] = [{ id: 'streamed-1', role: 'assistant', content: 'live' }];
		const initial: ChatMessage[] = [
			{ id: 'h1', role: 'user', content: 'old q' },
			{ id: 'h2', role: 'assistant', content: 'old a' },
		];
		const merged = mergeHistoryIntoMessages(prev, initial);
		expect(merged.map((m) => m.id)).toEqual(['h1', 'h2', 'streamed-1']);
	});

	it('drops duplicates so a re-fetch does not double-insert', () => {
		const prev: ChatMessage[] = [
			{ id: 'h1', role: 'user', content: 'old q' },
			{ id: 'h2', role: 'assistant', content: 'old a' },
		];
		const initial: ChatMessage[] = [
			{ id: 'h1', role: 'user', content: 'old q' },
			{ id: 'h2', role: 'assistant', content: 'old a' },
		];
		const merged = mergeHistoryIntoMessages(prev, initial);
		expect(merged).toBe(prev); // identity preserved when nothing new to add
		expect(merged.map((m) => m.id)).toEqual(['h1', 'h2']);
	});

	it('keeps the existing tail when only some history entries are new', () => {
		const prev: ChatMessage[] = [{ id: 'h2', role: 'assistant', content: 'old a' }];
		const initial: ChatMessage[] = [
			{ id: 'h1', role: 'user', content: 'old q' },
			{ id: 'h2', role: 'assistant', content: 'old a' },
		];
		const merged = mergeHistoryIntoMessages(prev, initial);
		expect(merged.map((m) => m.id)).toEqual(['h1', 'h2']);
	});

	it('is a no-op when history is empty', () => {
		const prev: ChatMessage[] = [{ id: 'live-1', role: 'assistant', content: 'x' }];
		const merged = mergeHistoryIntoMessages(prev, []);
		expect(merged).toBe(prev);
	});

	it('handles an empty prev by returning the history as-is', () => {
		const initial: ChatMessage[] = [{ id: 'h1', role: 'user', content: 'old q' }];
		const merged = mergeHistoryIntoMessages([], initial);
		expect(merged).toEqual(initial);
	});
});

// ---------------------------------------------------------------------------
// Tests: late-response session guard
// (mirror of `if (sessionIdRef.current !== targetSessionId) return;`)
// ---------------------------------------------------------------------------

describe('late-response session guard', () => {
	function shouldApplyHistory(currentSessionId: string | null, requestedFor: string): boolean {
		return currentSessionId === requestedFor;
	}

	it('applies history when the active session still matches the request', () => {
		expect(shouldApplyHistory('s1', 's1')).toBe(true);
	});

	it('drops history when the user switched to a different session before it arrived', () => {
		expect(shouldApplyHistory('s2', 's1')).toBe(false);
	});

	it('drops history when no session is active any more', () => {
		expect(shouldApplyHistory(null, 's1')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Tests: requestSessionHistory wire format
// (mirror of the message body built in useMaestroWebSocket.requestSessionHistory)
// ---------------------------------------------------------------------------

describe('requestSessionHistory wire format', () => {
	function buildRequest(
		tabId: string,
		requestId: string,
		options?: { sinceMs?: number; tail?: number }
	): Record<string, unknown> {
		const message: Record<string, unknown> = {
			type: 'get_session_history',
			tabId,
			requestId,
		};
		if (options?.sinceMs !== undefined) message.sinceMs = options.sinceMs;
		if (options?.tail !== undefined) message.tail = options.tail;
		return message;
	}

	it('always includes type, tabId, and requestId', () => {
		expect(buildRequest('tab-1', 'req-1')).toEqual({
			type: 'get_session_history',
			tabId: 'tab-1',
			requestId: 'req-1',
		});
	});

	it('includes sinceMs when provided', () => {
		expect(buildRequest('tab-1', 'req-1', { sinceMs: 1700000000000 })).toMatchObject({
			sinceMs: 1700000000000,
		});
	});

	it('includes tail when provided', () => {
		expect(buildRequest('tab-1', 'req-1', { tail: 50 })).toMatchObject({ tail: 50 });
	});

	it('omits sinceMs and tail when not provided (avoids sending undefined over the wire)', () => {
		const msg = buildRequest('tab-1', 'req-1');
		expect('sinceMs' in msg).toBe(false);
		expect('tail' in msg).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Tests: session_history_result dispatch / pending-request correlation
// (mirror of the handler in useMaestroWebSocket.handleMessage + the
// pendingHistoryRequestsRef map)
// ---------------------------------------------------------------------------

describe('session_history_result dispatch', () => {
	type Pending = {
		resolve: (result: unknown) => void;
		reject: (err: Error) => void;
	};

	function createDispatcher() {
		const pending = new Map<string, Pending>();
		function dispatch(message: any): void {
			if (message.type !== 'session_history_result') return;
			const requestId = typeof message.requestId === 'string' ? message.requestId : null;
			if (!requestId) return;
			const p = pending.get(requestId);
			if (!p) return;
			pending.delete(requestId);
			if (message.success === false) {
				p.reject(new Error(message.error || 'Failed to fetch session history'));
			} else {
				p.resolve({
					tabId: message.tabId,
					sessionId: message.sessionId,
					agentId: message.agentId,
					agentSessionId: message.agentSessionId ?? null,
					messages: Array.isArray(message.messages) ? message.messages : [],
				});
			}
		}
		return { pending, dispatch };
	}

	it('resolves the pending promise whose requestId matches', async () => {
		const { pending, dispatch } = createDispatcher();
		const promise = new Promise((resolve, reject) => pending.set('req-1', { resolve, reject }));

		dispatch({
			type: 'session_history_result',
			requestId: 'req-1',
			success: true,
			tabId: 'tab-1',
			sessionId: 's-1',
			agentId: 'claude-code',
			agentSessionId: 'agent-1',
			messages: [{ id: 'm1', role: 'user', source: 'log', content: 'hi', timestamp: 't' }],
		});

		await expect(promise).resolves.toMatchObject({
			tabId: 'tab-1',
			sessionId: 's-1',
			agentId: 'claude-code',
			agentSessionId: 'agent-1',
			messages: [{ id: 'm1' }],
		});
		expect(pending.has('req-1')).toBe(false);
	});

	it('rejects when success: false with the desktop-provided error', async () => {
		const { pending, dispatch } = createDispatcher();
		const promise = new Promise((resolve, reject) => pending.set('req-1', { resolve, reject }));

		dispatch({
			type: 'session_history_result',
			requestId: 'req-1',
			success: false,
			error: 'Tab not found: tab-1',
			code: 'TAB_NOT_FOUND',
		});

		await expect(promise).rejects.toThrow('Tab not found: tab-1');
	});

	it('falls back to a generic message when success:false has no error string', async () => {
		const { pending, dispatch } = createDispatcher();
		const promise = new Promise((resolve, reject) => pending.set('req-1', { resolve, reject }));

		dispatch({ type: 'session_history_result', requestId: 'req-1', success: false });

		await expect(promise).rejects.toThrow('Failed to fetch session history');
	});

	it('ignores results with an unknown requestId so unrelated promises do not resolve', () => {
		const { pending, dispatch } = createDispatcher();
		const resolve = jest.fn();
		const reject = jest.fn();
		pending.set('req-real', { resolve, reject });

		dispatch({
			type: 'session_history_result',
			requestId: 'req-other',
			success: true,
			messages: [],
		});

		expect(resolve).not.toHaveBeenCalled();
		expect(reject).not.toHaveBeenCalled();
		expect(pending.has('req-real')).toBe(true);
	});

	it('ignores results with a missing requestId entirely', () => {
		const { pending, dispatch } = createDispatcher();
		const resolve = jest.fn();
		const reject = jest.fn();
		pending.set('req-1', { resolve, reject });

		dispatch({ type: 'session_history_result', success: true, messages: [] });

		expect(resolve).not.toHaveBeenCalled();
		expect(reject).not.toHaveBeenCalled();
	});

	it('coerces a non-array messages payload to [] rather than crashing', async () => {
		const { pending, dispatch } = createDispatcher();
		const promise = new Promise<any>((resolve, reject) =>
			pending.set('req-1', { resolve, reject })
		);

		dispatch({
			type: 'session_history_result',
			requestId: 'req-1',
			success: true,
			tabId: 'tab-1',
			sessionId: 's-1',
			agentId: 'claude-code',
			messages: 'not an array',
		});

		const result = await promise;
		expect(result.messages).toEqual([]);
	});

	it('defaults agentSessionId to null when the desktop omits it', async () => {
		const { pending, dispatch } = createDispatcher();
		const promise = new Promise<any>((resolve, reject) =>
			pending.set('req-1', { resolve, reject })
		);

		dispatch({
			type: 'session_history_result',
			requestId: 'req-1',
			success: true,
			tabId: 'tab-1',
			sessionId: 's-1',
			agentId: 'claude-code',
			messages: [],
		});

		const result = await promise;
		expect(result.agentSessionId).toBeNull();
	});

	it('does nothing for non-history message types', () => {
		const { pending, dispatch } = createDispatcher();
		const resolve = jest.fn();
		const reject = jest.fn();
		pending.set('req-1', { resolve, reject });

		dispatch({ type: 'session_output', requestId: 'req-1' });

		expect(resolve).not.toHaveBeenCalled();
		expect(reject).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Tests: pending-request cleanup on disconnect / unmount
// (mirror of rejectPendingHistoryRequests in useMaestroWebSocket)
// ---------------------------------------------------------------------------

describe('rejectPendingHistoryRequests', () => {
	type Pending = {
		resolve: (result: unknown) => void;
		reject: (err: Error) => void;
		timeoutId: ReturnType<typeof setTimeout>;
	};

	function rejectAll(map: Map<string, Pending>, reason: string): void {
		if (map.size === 0) return;
		for (const entry of map.values()) {
			clearTimeout(entry.timeoutId);
			entry.reject(new Error(reason));
		}
		map.clear();
	}

	it('rejects every pending request and clears the map on disconnect', async () => {
		const map = new Map<string, Pending>();
		const p1 = new Promise<unknown>((resolve, reject) =>
			map.set('a', { resolve, reject, timeoutId: setTimeout(() => {}, 1_000_000) })
		);
		const p2 = new Promise<unknown>((resolve, reject) =>
			map.set('b', { resolve, reject, timeoutId: setTimeout(() => {}, 1_000_000) })
		);

		rejectAll(map, 'WebSocket disconnected');

		await expect(p1).rejects.toThrow('WebSocket disconnected');
		await expect(p2).rejects.toThrow('WebSocket disconnected');
		expect(map.size).toBe(0);
	});

	it('is a no-op when no requests are pending (no throws)', () => {
		const map = new Map<string, Pending>();
		expect(() => rejectAll(map, 'unused')).not.toThrow();
	});
});
