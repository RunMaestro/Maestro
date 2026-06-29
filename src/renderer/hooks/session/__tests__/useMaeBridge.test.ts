import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useMaeBridge } from '../useMaeBridge';
import { useSessionStore } from '../../../stores/sessionStore';
import type { Session } from '../../../types';

// Behavior test for the W3 renderer consumption. The live GUI rendering + the
// 8-step demo still need the running app; this locks the hook's decision logic:
// buffer-until-loaded, arrival-order flush, maestroSessionId reuse (no clobber /
// no duplicate), turn-state mapping, and finalize-but-keep on end.

type MaeCb = (payload: unknown) => void;

interface Captured {
	register?: MaeCb;
	event?: MaeCb;
	ended?: MaeCb;
}

let captured: Captured;

function installMaeMock(): void {
	captured = {};
	window.maestro.mae = {
		onSessionRegistered: (cb: MaeCb) => {
			captured.register = cb;
			return () => {};
		},
		onSessionEvent: (cb: MaeCb) => {
			captured.event = cb;
			return () => {};
		},
		onSessionEnded: (cb: MaeCb) => {
			captured.ended = cb;
			return () => {};
		},
	};
}

function reset(): void {
	act(() => {
		useSessionStore.getState().setSessions([]);
		useSessionStore.getState().setSessionsLoaded(false);
	});
}

function registerPayload(
	ompSessionId: string,
	extra: Record<string, unknown> = {}
): Record<string, unknown> {
	return { runId: 'run-1', ompSessionId, cwd: '/repo', engine: 'omp', startedAt: 1, ...extra };
}

function sessions(): Session[] {
	return useSessionStore.getState().sessions;
}

beforeEach(() => {
	installMaeMock();
	reset();
});

afterEach(reset);

describe('useMaeBridge', () => {
	test('buffers register until sessionsLoaded, then flushes', () => {
		renderHook(() => useMaeBridge());
		// sessionsLoaded === false -> buffered, store untouched (no clobber race).
		act(() => captured.register?.(registerPayload('/s/a.jsonl')));
		expect(sessions()).toHaveLength(0);
		// restoration completes -> buffered mutation flushes.
		act(() => useSessionStore.getState().setSessionsLoaded(true));
		expect(sessions().map((s) => s.id)).toEqual(['mae:/s/a.jsonl']);
		expect(sessions()[0].state).toBe('busy');
	});

	test('flushes buffered registers in arrival order', () => {
		renderHook(() => useMaeBridge());
		act(() => {
			captured.register?.(registerPayload('/s/a.jsonl'));
			captured.register?.(registerPayload('/s/b.jsonl'));
		});
		expect(sessions()).toHaveLength(0);
		act(() => useSessionStore.getState().setSessionsLoaded(true));
		expect(sessions().map((s) => s.id)).toEqual(['mae:/s/a.jsonl', 'mae:/s/b.jsonl']);
	});

	test('ignores invalid payloads', () => {
		act(() => useSessionStore.getState().setSessionsLoaded(true));
		renderHook(() => useMaeBridge());
		act(() => captured.register?.({ ompSessionId: 42 })); // fails parseSessionRegister
		expect(sessions()).toHaveLength(0);
	});

	test('maestroSessionId reuses the real row state-only (no duplicate, no clobber)', () => {
		act(() => {
			useSessionStore
				.getState()
				.setSessions([{ id: 'real-1', name: 'Real Work', state: 'idle' } as unknown as Session]);
			useSessionStore.getState().setSessionsLoaded(true);
		});
		renderHook(() => useMaeBridge());
		act(() => captured.register?.(registerPayload('/s/x.jsonl', { maestroSessionId: 'real-1' })));
		const rows = sessions();
		expect(rows).toHaveLength(1); // no mae:* duplicate
		expect(rows[0].id).toBe('real-1');
		expect(rows[0].name).toBe('Real Work'); // not overwritten with synthetic fields
		expect(rows[0].state).toBe('busy'); // state-only patch
	});

	test('turn_end -> idle; session.end finalizes idle without removing the row', () => {
		act(() => useSessionStore.getState().setSessionsLoaded(true));
		renderHook(() => useMaeBridge());
		act(() => captured.register?.(registerPayload('/s/c.jsonl')));
		expect(sessions()[0].state).toBe('busy');
		act(() =>
			captured.event?.({
				runId: 'run-1',
				ompSessionId: '/s/c.jsonl',
				kind: 'turn_end',
				at: 2,
			})
		);
		expect(sessions()[0].state).toBe('idle');
		act(() =>
			captured.ended?.({
				runId: 'run-1',
				ompSessionId: '/s/c.jsonl',
				at: 3,
				status: 'completed',
			})
		);
		expect(sessions()).toHaveLength(1); // kept (reopenable)
		expect(sessions()[0].state).toBe('idle');
	});
});
