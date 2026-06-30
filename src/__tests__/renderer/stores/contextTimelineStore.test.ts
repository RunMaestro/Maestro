/**
 * contextTimelineStore tests
 *
 * Covers the in-memory Context Timeline capture lifecycle:
 * - always-on append (no capture gate) keyed by session
 * - open / minimize / restore / close semantics (close KEEPS history)
 * - clearSession wipes points but keeps the key
 * - per-session buffer cap / trimmed flag
 * - the selectPoints selector
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
	useContextTimelineStore,
	selectPoints,
	MAX_POINTS_PER_SESSION,
	type ContextTimelinePointInput,
} from '../../../renderer/stores/contextTimelineStore';

const SID = 'session-1';
const TAB = 'tab-a';

/** Build a point input with sane defaults; override per test. */
function pt(overrides: Partial<ContextTimelinePointInput> = {}): ContextTimelinePointInput {
	return {
		tabId: TAB,
		inputTokens: 100,
		outputTokens: 20,
		cacheReadInputTokens: 50,
		cacheCreationInputTokens: 10,
		reasoningTokens: 0,
		totalCostUsd: 0,
		contextTokens: 160,
		contextWindow: 200000,
		percentage: 1,
		...overrides,
	};
}

function reset() {
	useContextTimelineStore.setState({ panelSessionId: null, minimized: false, buffers: {} });
}

describe('contextTimelineStore', () => {
	beforeEach(reset);

	it('starts hidden with no buffers', () => {
		const s = useContextTimelineStore.getState();
		expect(s.panelSessionId).toBeNull();
		expect(s.minimized).toBe(false);
		expect(s.buffers).toEqual({});
	});

	it('appendPoint records points without any panel being open (always-on)', () => {
		useContextTimelineStore.getState().appendPoint(SID, pt({ percentage: 5 }));
		const points = selectPoints(SID)(useContextTimelineStore.getState());
		expect(points).toHaveLength(1);
		expect(points[0].percentage).toBe(5);
		expect(points[0].tabId).toBe(TAB);
		// id + timestamp are stamped by the store.
		expect(points[0].id).toBeTruthy();
		expect(typeof points[0].timestamp).toBe('number');
		// The panel stays hidden - capture is independent of focus.
		expect(useContextTimelineStore.getState().panelSessionId).toBeNull();
	});

	it('appendPoint is a no-op for an empty session id', () => {
		useContextTimelineStore.getState().appendPoint('', pt());
		expect(useContextTimelineStore.getState().buffers).toEqual({});
	});

	it('keeps separate buffers per session', () => {
		const store = useContextTimelineStore.getState();
		store.appendPoint(SID, pt({ percentage: 1 }));
		store.appendPoint('session-2', pt({ percentage: 2 }));
		expect(selectPoints(SID)(useContextTimelineStore.getState())).toHaveLength(1);
		expect(selectPoints('session-2')(useContextTimelineStore.getState())).toHaveLength(1);
	});

	it('openPanel focuses the session and seeds an empty buffer when none exists', () => {
		useContextTimelineStore.getState().openPanel(SID);
		const s = useContextTimelineStore.getState();
		expect(s.panelSessionId).toBe(SID);
		expect(s.minimized).toBe(false);
		expect(s.buffers[SID]).toEqual({ points: [], trimmed: false });
	});

	it('openPanel preserves history already captured before the panel opened', () => {
		const store = useContextTimelineStore.getState();
		store.appendPoint(SID, pt());
		store.openPanel(SID);
		expect(selectPoints(SID)(useContextTimelineStore.getState())).toHaveLength(1);
	});

	it('minimize then restore toggles the minimized flag without touching history', () => {
		const store = useContextTimelineStore.getState();
		store.appendPoint(SID, pt());
		store.openPanel(SID);
		store.minimizePanel();
		expect(useContextTimelineStore.getState().minimized).toBe(true);
		store.restorePanel();
		expect(useContextTimelineStore.getState().minimized).toBe(false);
		expect(selectPoints(SID)(useContextTimelineStore.getState())).toHaveLength(1);
	});

	it('closePanel hides the panel but KEEPS the history', () => {
		const store = useContextTimelineStore.getState();
		store.appendPoint(SID, pt());
		store.openPanel(SID);
		store.closePanel();
		const s = useContextTimelineStore.getState();
		expect(s.panelSessionId).toBeNull();
		expect(s.minimized).toBe(false);
		expect(selectPoints(SID)(s)).toHaveLength(1);
	});

	it('clearSession wipes the points but keeps the session key', () => {
		const store = useContextTimelineStore.getState();
		store.appendPoint(SID, pt());
		store.appendPoint(SID, pt());
		store.clearSession(SID);
		const s = useContextTimelineStore.getState();
		expect(selectPoints(SID)(s)).toHaveLength(0);
		expect(s.buffers[SID]).toEqual({ points: [], trimmed: false });
	});

	it('bounds the buffer at MAX_POINTS_PER_SESSION and sets trimmed', () => {
		const store = useContextTimelineStore.getState();
		for (let i = 0; i < MAX_POINTS_PER_SESSION + 5; i++) {
			store.appendPoint(SID, pt({ percentage: i }));
		}
		const s = useContextTimelineStore.getState();
		const points = selectPoints(SID)(s);
		expect(points).toHaveLength(MAX_POINTS_PER_SESSION);
		expect(s.buffers[SID].trimmed).toBe(true);
		// Oldest dropped: the first surviving point is index 5, not 0.
		expect(points[0].percentage).toBe(5);
		expect(points[points.length - 1].percentage).toBe(MAX_POINTS_PER_SESSION + 4);
	});

	it('selectPoints returns a stable empty array for unknown sessions', () => {
		const a = selectPoints('nope')(useContextTimelineStore.getState());
		const b = selectPoints(null)(useContextTimelineStore.getState());
		expect(a).toEqual([]);
		expect(b).toEqual([]);
		// The empty array is a shared constant, not a fresh allocation each call.
		expect(a).toBe(b);
	});

	it('removeSession drops the buffer entirely and hides the panel if focused', () => {
		const store = useContextTimelineStore.getState();
		store.appendPoint(SID, pt());
		store.openPanel(SID);
		store.removeSession(SID);
		const s = useContextTimelineStore.getState();
		// Key is gone (not just emptied), and the focused panel is hidden.
		expect(s.buffers[SID]).toBeUndefined();
		expect(s.panelSessionId).toBeNull();
	});

	it('removeSession leaves an unfocused panel untouched', () => {
		const store = useContextTimelineStore.getState();
		store.appendPoint(SID, pt());
		store.appendPoint('other', pt());
		store.openPanel('other');
		store.removeSession(SID);
		const s = useContextTimelineStore.getState();
		expect(s.buffers[SID]).toBeUndefined();
		expect(s.panelSessionId).toBe('other');
	});
});
