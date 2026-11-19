// Source: src/__tests__/renderer/stores/harnessInteractionStore.test.ts
// Source: src/__tests__/renderer/stores/composerInputStore.test.ts
// Source: src/__tests__/renderer/stores/contextTimelineStore.test.ts
// Source: src/__tests__/renderer/stores/crossAgentInFlightStore.test.ts
// Source: src/__tests__/renderer/stores/cueDirtyStore.test.ts
// Source: src/__tests__/renderer/stores/diffReviewStore.test.ts
// Source: src/__tests__/renderer/stores/thoughtStreamStore.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { beforeEach } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import { useHarnessInteractionStore } from '../../../renderer/stores/harnessInteractionStore';
import type { HarnessInteractionRequest } from '../../../shared/harness-control/types';
import { captureException } from '../../../renderer/utils/sentry';
import { useComposerInputStore } from '../../../renderer/stores/composerInputStore';
import { selectAiComposerValue } from '../../../renderer/stores/composerInputStore';
import { selectTerminalComposerValue } from '../../../renderer/stores/composerInputStore';
import { selectMentionRoutingOverride } from '../../../renderer/stores/composerInputStore';
import { useContextTimelineStore } from '../../../renderer/stores/contextTimelineStore';
import { selectPoints } from '../../../renderer/stores/contextTimelineStore';
import { MAX_POINTS_PER_SESSION } from '../../../renderer/stores/contextTimelineStore';
import { CONTEXT_SURFACE_MIN_WIDTH } from '../../../renderer/stores/contextTimelineStore';
import { CONTEXT_SURFACE_WIDTH } from '../../../renderer/stores/contextTimelineStore';
import { resolveContextSurfaceWidth } from '../../../renderer/stores/contextTimelineStore';
import type { ContextTimelinePointInput } from '../../../renderer/stores/contextTimelineStore';
import { useCrossAgentInFlightStore } from '../../../renderer/stores/crossAgentInFlightStore';
import { selectInFlightForTab } from '../../../renderer/stores/crossAgentInFlightStore';
import { selectConsultedSessionIds } from '../../../renderer/stores/crossAgentInFlightStore';
import { isAgentAwaitingConsult } from '../../../renderer/stores/crossAgentInFlightStore';
import type { InFlightCrossAgentRequest } from '../../../renderer/stores/crossAgentInFlightStore';
import { useCueDirtyStore } from '../../../renderer/stores/cueDirtyStore';
import { diffReviewKey } from '../../../renderer/stores/diffReviewStore';
import { useDiffReviewStore } from '../../../renderer/stores/diffReviewStore';
import { selectRepoComments } from '../../../renderer/stores/diffReviewStore';
import type { DiffComment } from '../../../renderer/utils/diffReviewComments';
import { useThoughtStreamStore } from '../../../renderer/stores/thoughtStreamStore';
import { selectActivityCount } from '../../../renderer/stores/thoughtStreamStore';
import { selectLastAppendAt } from '../../../renderer/stores/thoughtStreamStore';
import { isThoughtStreamLive } from '../../../renderer/stores/thoughtStreamStore';
import { groupThoughtsIntoBlocks } from '../../../renderer/stores/thoughtStreamStore';
import { buildActivityFeed } from '../../../renderer/stores/thoughtStreamStore';
import { isToolEvent } from '../../../renderer/stores/thoughtStreamStore';
import { THOUGHT_BLOCK_GAP_MS } from '../../../renderer/stores/thoughtStreamStore';
import { THOUGHT_LIVE_WINDOW_MS } from '../../../renderer/stores/thoughtStreamStore';
import { MAX_THOUGHTS_PER_SESSION } from '../../../renderer/stores/thoughtStreamStore';
import { MAX_THOUGHT_CHARS_PER_SESSION } from '../../../renderer/stores/thoughtStreamStore';
import { MAX_CAPTURED_SESSIONS } from '../../../renderer/stores/thoughtStreamStore';
import type { ThoughtEntry } from '../../../renderer/stores/thoughtStreamStore';
import type { StreamEvent } from '../../../renderer/stores/thoughtStreamStore';
import type { ToolActivityEntry } from '../../../renderer/stores/thoughtStreamStore';
import type { ToolActivityStatus } from '../../../renderer/stores/thoughtStreamStore';
vi.mock('../../../renderer/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../renderer/utils/logger', () => ({ logger: { warn: vi.fn() } }));
describeSourceSuite('harnessInteractionStore', () => {
	const request: HarnessInteractionRequest = {
		requestId: 'request-a',
		sessionId: 'session-a',
		spawnGeneration: 1,
		kind: 'permission',
		provider: 'fixture',
		title: 'Run tests?',
		options: [{ optionId: 'allow', label: 'Allow once', kind: 'allow-once' }],
		createdAt: 1,
	};

	describe('harnessInteractionStore', () => {
		beforeEach(() => {
			useHarnessInteractionStore.setState({ queue: [], responding: {}, settledIds: {} });
			vi.mocked(captureException).mockClear();
		});

		it('deduplicates live and restored requests and removes settled requests', () => {
			const store = useHarnessInteractionStore.getState();
			store.enqueue(request);
			store.enqueue(request);
			expect(useHarnessInteractionStore.getState().queue).toHaveLength(1);
			store.settle({ requestId: request.requestId });
			expect(useHarnessInteractionStore.getState().queue).toHaveLength(0);
		});

		it('keeps a request open when main rejects its response', async () => {
			const respondHarnessInteraction = vi.fn().mockResolvedValue('invalid-response');
			vi.stubGlobal('window', {
				maestro: { process: { respondHarnessInteraction } },
			});
			useHarnessInteractionStore.getState().enqueue(request);
			await useHarnessInteractionStore.getState().respond({
				requestId: request.requestId,
				outcome: 'selected',
				optionId: 'unknown',
			});
			expect(useHarnessInteractionStore.getState().queue).toHaveLength(1);
			expect(useHarnessInteractionStore.getState().responding).toEqual({});
			vi.unstubAllGlobals();
		});

		it('merges restored requests with requests that arrive during restoration', async () => {
			const { promise, resolve } = Promise.withResolvers<HarnessInteractionRequest[]>();
			const listHarnessInteractions = vi.fn(() => promise);
			vi.stubGlobal('window', { maestro: { process: { listHarnessInteractions } } });
			const loading = useHarnessInteractionStore.getState().loadPending();
			useHarnessInteractionStore.getState().enqueue(request);
			resolve([{ ...request, requestId: 'request-b' }]);
			await loading;
			expect(useHarnessInteractionStore.getState().queue.map((item) => item.requestId)).toEqual([
				'request-a',
				'request-b',
			]);
			vi.unstubAllGlobals();
		});

		it('does not resurrect a request settled before the pending-list response', async () => {
			const { promise, resolve } = Promise.withResolvers<HarnessInteractionRequest[]>();
			vi.stubGlobal('window', {
				maestro: { process: { listHarnessInteractions: vi.fn(() => promise) } },
			});
			const loading = useHarnessInteractionStore.getState().loadPending();
			useHarnessInteractionStore.getState().settle({ requestId: request.requestId });
			resolve([request, { ...request, requestId: 'request-b' }]);
			await loading;
			expect(useHarnessInteractionStore.getState().queue.map((item) => item.requestId)).toEqual([
				'request-b',
			]);
			vi.unstubAllGlobals();
		});

		it('reports unexpected response failures but treats disconnects as expected', async () => {
			const unexpected = new Error('broker invariant failed');
			vi.stubGlobal('window', {
				maestro: {
					process: {
						respondHarnessInteraction: vi.fn().mockRejectedValue(unexpected),
						listHarnessInteractions: vi.fn().mockRejectedValue(new Error('WebSocket is closed')),
					},
				},
			});
			await useHarnessInteractionStore.getState().respond({
				requestId: request.requestId,
				outcome: 'selected',
				optionId: 'allow',
			});
			await useHarnessInteractionStore.getState().loadPending();
			expect(captureException).toHaveBeenCalledExactlyOnceWith(unexpected, {
				extra: { operation: 'respond-interaction', requestId: request.requestId },
			});
			vi.unstubAllGlobals();
		});
	});
});
describeSourceSuite('composerInputStore', () => {
	describe('composerInputStore', () => {
		beforeEach(() => {
			useComposerInputStore.setState({
				aiValue: '',
				terminalValue: '',
				mentionRoutingOverride: null,
			});
		});

		it('initializes both slices empty', () => {
			const s = useComposerInputStore.getState();
			expect(s.aiValue).toBe('');
			expect(s.terminalValue).toBe('');
		});

		it('setAiValue sets a literal value without touching the terminal slice', () => {
			useComposerInputStore.getState().setAiValue('hello AI');
			expect(useComposerInputStore.getState().aiValue).toBe('hello AI');
			expect(useComposerInputStore.getState().terminalValue).toBe('');
		});

		it('setTerminalValue sets a literal value without touching the AI slice', () => {
			useComposerInputStore.getState().setTerminalValue('ls -la');
			expect(useComposerInputStore.getState().terminalValue).toBe('ls -la');
			expect(useComposerInputStore.getState().aiValue).toBe('');
		});

		it('setAiValue accepts a functional updater that sees the previous value', () => {
			useComposerInputStore.getState().setAiValue('hello');
			useComposerInputStore.getState().setAiValue((prev) => prev + ' world');
			expect(useComposerInputStore.getState().aiValue).toBe('hello world');
		});

		it('setTerminalValue accepts a functional updater', () => {
			useComposerInputStore.getState().setTerminalValue('git');
			useComposerInputStore.getState().setTerminalValue((prev) => `${prev} status`);
			expect(useComposerInputStore.getState().terminalValue).toBe('git status');
		});

		it('selectors read the matching slice', () => {
			useComposerInputStore.setState({ aiValue: 'a', terminalValue: 't' });
			const s = useComposerInputStore.getState();
			expect(selectAiComposerValue(s)).toBe('a');
			expect(selectTerminalComposerValue(s)).toBe('t');
		});

		it("drops a picked mention routing when another tab's draft loads", () => {
			// The pick qualified the mentions in THIS draft; the next tab's draft has
			// its own wording and must not inherit it.
			useComposerInputStore.getState().setMentionRoutingOverride('handoff');
			expect(selectMentionRoutingOverride(useComposerInputStore.getState())).toBe('handoff');

			useComposerInputStore.getState().loadAiDraft('tab-2', 'ask @Backend', 'off');

			expect(selectMentionRoutingOverride(useComposerInputStore.getState())).toBeNull();
		});

		it('notifies subscribers only when a slice actually changes', () => {
			let calls = 0;
			const unsub = useComposerInputStore.subscribe(() => {
				calls += 1;
			});
			useComposerInputStore.getState().setAiValue('x');
			expect(calls).toBe(1);
			unsub();
		});
	});
});
describeSourceSuite('contextTimelineStore', () => {
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
		useContextTimelineStore.setState({
			panelSessionId: null,
			anchorRect: null,
			sourceSize: null,
			buffers: {},
		});
	}

	describe('contextTimelineStore', () => {
		beforeEach(reset);

		it('starts hidden with no buffers', () => {
			const s = useContextTimelineStore.getState();
			expect(s.panelSessionId).toBeNull();
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
			expect(s.buffers[SID]).toEqual({ points: [], trimmed: false });
		});

		it('openPanel preserves history already captured before the panel opened', () => {
			const store = useContextTimelineStore.getState();
			store.appendPoint(SID, pt());
			store.openPanel(SID);
			expect(selectPoints(SID)(useContextTimelineStore.getState())).toHaveLength(1);
		});

		it('openPanel stores the anchor rect it was given', () => {
			const rect = { top: 10, left: 20, bottom: 30, right: 120, width: 100, height: 20 };
			useContextTimelineStore.getState().openPanel(SID, rect);
			expect(useContextTimelineStore.getState().anchorRect).toEqual(rect);
		});

		it('openPanel with no anchor clears any previous anchor (dock fallback)', () => {
			const rect = { top: 10, left: 20, bottom: 30, right: 120, width: 100, height: 20 };
			useContextTimelineStore.getState().openPanel(SID, rect);
			useContextTimelineStore.getState().openPanel(SID);
			expect(useContextTimelineStore.getState().anchorRect).toBeNull();
		});

		it('closePanel clears the anchor rect', () => {
			const rect = { top: 10, left: 20, bottom: 30, right: 120, width: 100, height: 20 };
			useContextTimelineStore.getState().openPanel(SID, rect);
			useContextTimelineStore.getState().closePanel();
			expect(useContextTimelineStore.getState().anchorRect).toBeNull();
		});

		it('togglePanel opens when hidden and closes on a second call for the same session', () => {
			const rect = { top: 10, left: 20, bottom: 30, right: 120, width: 100, height: 20 };
			const store = useContextTimelineStore.getState();
			store.appendPoint(SID, pt());

			store.togglePanel(SID, rect);
			expect(useContextTimelineStore.getState().panelSessionId).toBe(SID);
			expect(useContextTimelineStore.getState().anchorRect).toEqual(rect);

			// The gauge is the only open/close control, so the second press must put
			// the panel away rather than re-opening it in place.
			store.togglePanel(SID, rect);
			expect(useContextTimelineStore.getState().panelSessionId).toBeNull();
			expect(useContextTimelineStore.getState().anchorRect).toBeNull();

			// Closing is not clearing: the recorded history survives the round trip.
			expect(selectPoints(SID)(useContextTimelineStore.getState())).toHaveLength(1);
		});

		it('togglePanel re-targets rather than closing when a DIFFERENT session is showing', () => {
			const rect = { top: 10, left: 20, bottom: 30, right: 120, width: 100, height: 20 };
			const store = useContextTimelineStore.getState();
			store.togglePanel(SID, rect);
			// Clicking another agent's gauge asks to see THAT agent, not to dismiss.
			store.togglePanel('other', rect);
			const s = useContextTimelineStore.getState();
			expect(s.panelSessionId).toBe('other');
			expect(s.buffers.other).toEqual({ points: [], trimmed: false });
		});

		it('togglePanel carries the measured popover size, and closing clears it', () => {
			const rect = { top: 10, left: 20, bottom: 30, right: 120, width: 100, height: 20 };
			const size = { width: 480, height: 512 };
			const store = useContextTimelineStore.getState();

			store.togglePanel(SID, rect, size);
			expect(useContextTimelineStore.getState().sourceSize).toEqual(size);

			store.togglePanel(SID, rect, size);
			expect(useContextTimelineStore.getState().sourceSize).toBeNull();
		});

		it('an open with nothing measured does not inherit the previous open size', () => {
			const store = useContextTimelineStore.getState();
			store.openPanel(SID, null, { width: 480, height: 512 });
			store.openPanel(SID);
			expect(useContextTimelineStore.getState().sourceSize).toBeNull();
		});

		it('closePanel clears the measured size', () => {
			const store = useContextTimelineStore.getState();
			store.openPanel(SID, null, { width: 480, height: 512 });
			store.closePanel();
			expect(useContextTimelineStore.getState().sourceSize).toBeNull();
		});

		it('closePanel hides the panel but KEEPS the history', () => {
			const store = useContextTimelineStore.getState();
			store.appendPoint(SID, pt());
			store.openPanel(SID);
			store.closePanel();
			const s = useContextTimelineStore.getState();
			expect(s.panelSessionId).toBeNull();
			expect(selectPoints(SID)(s)).toHaveLength(1);
		});

		it('clearSession wipes the points but keeps the session key', () => {
			const store = useContextTimelineStore.getState();
			store.appendPoint(SID, pt());
			store.appendPoint(SID, pt());
			store.clearSession(SID);
			const s = useContextTimelineStore.getState();
			expect(selectPoints(SID)(s)).toHaveLength(0);
			// `hydrated` stays true after a clear: Clear also wipes main's capture log,
			// so re-fetching would only restore what the user just discarded.
			expect(s.buffers[SID]).toEqual({ points: [], trimmed: false, hydrated: true });
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

		// --- hydrateSession (finding S1) ---

		it('hydrateSession fills an empty buffer and marks it hydrated', () => {
			useContextTimelineStore
				.getState()
				.hydrateSession(SID, [{ ...pt(), seq: 1, timestamp: 111 }], false);
			const buffer = useContextTimelineStore.getState().buffers[SID];
			expect(buffer.points).toHaveLength(1);
			expect(buffer.points[0].timestamp).toBe(111);
			expect(buffer.hydrated).toBe(true);
		});

		it('hydrateSession skips a capture whose seq already landed live', () => {
			const store = useContextTimelineStore.getState();
			store.appendPoint(SID, pt({ seq: 2, contextTokens: 222 }));
			store.hydrateSession(
				SID,
				[
					{ ...pt(), seq: 1, timestamp: 100, contextTokens: 111 },
					{ ...pt(), seq: 2, timestamp: 200, contextTokens: 999 },
				],
				false
			);
			const points = useContextTimelineStore.getState().buffers[SID].points;
			expect(points.map((p) => p.seq)).toEqual([1, 2]);
			expect(points.map((p) => p.contextTokens)).toEqual([111, 222]);
		});

		it('hydrateSession bounds the merged buffer at MAX_POINTS_PER_SESSION', () => {
			const incoming = Array.from({ length: MAX_POINTS_PER_SESSION + 3 }, (_, i) => ({
				...pt({ contextTokens: i }),
				seq: i + 1,
				timestamp: i + 1,
			}));
			useContextTimelineStore.getState().hydrateSession(SID, incoming, false);
			const buffer = useContextTimelineStore.getState().buffers[SID];
			expect(buffer.points).toHaveLength(MAX_POINTS_PER_SESSION);
			expect(buffer.trimmed).toBe(true);
			expect(buffer.points[0].contextTokens).toBe(3);
		});

		it('hydrateSession marks the buffer hydrated even when nothing came back', () => {
			useContextTimelineStore.getState().hydrateSession(SID, [], true);
			const buffer = useContextTimelineStore.getState().buffers[SID];
			expect(buffer.points).toHaveLength(0);
			expect(buffer.trimmed).toBe(true);
			expect(buffer.hydrated).toBe(true);
		});
	});

	describe('resolveContextSurfaceWidth', () => {
		it('uses the shared default when the Timeline was never resized', () => {
			expect(resolveContextSurfaceWidth(undefined)).toBe(CONTEXT_SURFACE_WIDTH);
		});

		it('follows the width the user dragged the Timeline to', () => {
			expect(resolveContextSurfaceWidth({ width: 430, height: 502 })).toBe(430);
		});

		it('never goes narrower than the Timeline allows', () => {
			expect(resolveContextSurfaceWidth({ width: 200, height: 502 })).toBe(
				CONTEXT_SURFACE_MIN_WIDTH
			);
		});

		it('ignores a malformed saved size', () => {
			expect(resolveContextSurfaceWidth({ width: 'wide', height: 502 })).toBe(
				CONTEXT_SURFACE_WIDTH
			);
		});
	});
});
describeSourceSuite('crossAgentInFlightStore', () => {
	/**
	 * The in-flight store backs the "N agents responding…" indicator. It must
	 * register/remove requests cleanly and let the indicator scope to one source
	 * tab.
	 */

	function req(overrides: Partial<InFlightCrossAgentRequest> = {}): InFlightCrossAgentRequest {
		return {
			requestId: 'r1',
			sourceSessionId: 'src',
			sourceTabId: 'tab',
			targetSessionId: 'tgt',
			targetAgentName: 'Codex',
			targetToolType: 'codex',
			startedAt: 1000,
			...overrides,
		};
	}

	describe('crossAgentInFlightStore', () => {
		beforeEach(() => {
			useCrossAgentInFlightStore.setState({ requests: {} });
		});

		it('registers a dispatched request and removes it on finish', () => {
			const { start, finish } = useCrossAgentInFlightStore.getState();
			start(req());
			expect(useCrossAgentInFlightStore.getState().requests['r1']).toBeDefined();

			finish('r1');
			expect(useCrossAgentInFlightStore.getState().requests['r1']).toBeUndefined();
		});

		it('ignores a duplicate start for the same requestId', () => {
			const { start } = useCrossAgentInFlightStore.getState();
			start(req({ targetAgentName: 'First' }));
			start(req({ targetAgentName: 'Second' }));
			expect(useCrossAgentInFlightStore.getState().requests['r1'].targetAgentName).toBe('First');
		});

		it('no-ops finishing an unknown request', () => {
			const { finish } = useCrossAgentInFlightStore.getState();
			expect(() => finish('nope')).not.toThrow();
			expect(useCrossAgentInFlightStore.getState().requests).toEqual({});
		});
	});

	describe('selectInFlightForTab', () => {
		it('scopes to a single source tab, oldest first', () => {
			const requests: Record<string, InFlightCrossAgentRequest> = {
				a: req({ requestId: 'a', startedAt: 200 }),
				b: req({ requestId: 'b', startedAt: 100 }),
				c: req({ requestId: 'c', sourceTabId: 'other', startedAt: 50 }),
			};
			const scoped = selectInFlightForTab(requests, 'src', 'tab');
			expect(scoped.map((r) => r.requestId)).toEqual(['b', 'a']);
		});

		it('returns nothing when the source tab/session is missing', () => {
			const requests = { a: req() };
			expect(selectInFlightForTab(requests, null, 'tab')).toEqual([]);
			expect(selectInFlightForTab(requests, 'src', undefined)).toEqual([]);
		});
	});

	/**
	 * The Left Bar dot reads the TARGET side of the same store: a consulted agent
	 * is doing real work that `session.state` deliberately never records.
	 */
	describe('selectConsultedSessionIds', () => {
		it('collects every agent currently answering a consult', () => {
			const requests: Record<string, InFlightCrossAgentRequest> = {
				a: req({ requestId: 'a', targetSessionId: 'rc' }),
				b: req({ requestId: 'b', targetSessionId: 'maestro' }),
			};

			expect([...selectConsultedSessionIds(requests)].sort()).toEqual(['maestro', 'rc']);
		});

		// One agent fielding two consults must not double-count or flicker when the
		// first of them finishes.
		it('collapses several requests aimed at one agent', () => {
			const requests: Record<string, InFlightCrossAgentRequest> = {
				a: req({ requestId: 'a', targetSessionId: 'rc', sourceSessionId: 's1' }),
				b: req({ requestId: 'b', targetSessionId: 'rc', sourceSessionId: 's2' }),
			};

			expect([...selectConsultedSessionIds(requests)]).toEqual(['rc']);
		});

		it('is empty when nothing is in flight', () => {
			expect(selectConsultedSessionIds({}).size).toBe(0);
		});
	});

	describe('isAgentAwaitingConsult', () => {
		it('is true only for the agent that asked, not the one answering', () => {
			const requests = { r1: req({ sourceSessionId: 'manager', targetSessionId: 'worker' }) };
			expect(isAgentAwaitingConsult(requests, 'manager')).toBe(true);
			expect(isAgentAwaitingConsult(requests, 'worker')).toBe(false);
			expect(isAgentAwaitingConsult({}, 'manager')).toBe(false);
		});
	});
});
describeSourceSuite('cueDirtyStore', () => {
	beforeEach(() => {
		useCueDirtyStore.setState({ pipelineDirty: false, yamlDirty: false, pipelineSaving: false });
	});

	describe('useCueDirtyStore', () => {
		it('has all flags false initially', () => {
			const { pipelineDirty, yamlDirty, pipelineSaving } = useCueDirtyStore.getState();
			expect(pipelineDirty).toBe(false);
			expect(yamlDirty).toBe(false);
			expect(pipelineSaving).toBe(false);
		});

		it('isAnyDirty() returns false when neither flag is set', () => {
			expect(useCueDirtyStore.getState().isAnyDirty()).toBe(false);
		});

		it('setPipelineDirty(true) sets pipelineDirty and isAnyDirty returns true', () => {
			useCueDirtyStore.getState().setPipelineDirty(true);
			expect(useCueDirtyStore.getState().pipelineDirty).toBe(true);
			expect(useCueDirtyStore.getState().isAnyDirty()).toBe(true);
		});

		it('setYamlDirty(true) sets yamlDirty and isAnyDirty returns true', () => {
			useCueDirtyStore.getState().setYamlDirty(true);
			expect(useCueDirtyStore.getState().yamlDirty).toBe(true);
			expect(useCueDirtyStore.getState().isAnyDirty()).toBe(true);
		});

		it('isAnyDirty() is true when only pipeline is dirty', () => {
			useCueDirtyStore.getState().setPipelineDirty(true);
			expect(useCueDirtyStore.getState().isAnyDirty()).toBe(true);
		});

		it('isAnyDirty() is true when only yaml is dirty', () => {
			useCueDirtyStore.getState().setYamlDirty(true);
			expect(useCueDirtyStore.getState().isAnyDirty()).toBe(true);
		});

		it('resetAll() clears both flags', () => {
			useCueDirtyStore.getState().setPipelineDirty(true);
			useCueDirtyStore.getState().setYamlDirty(true);

			useCueDirtyStore.getState().resetAll();

			expect(useCueDirtyStore.getState().pipelineDirty).toBe(false);
			expect(useCueDirtyStore.getState().yamlDirty).toBe(false);
			expect(useCueDirtyStore.getState().isAnyDirty()).toBe(false);
		});

		it('setPipelineDirty(false) clears the pipeline flag', () => {
			useCueDirtyStore.getState().setPipelineDirty(true);
			useCueDirtyStore.getState().setPipelineDirty(false);
			expect(useCueDirtyStore.getState().pipelineDirty).toBe(false);
		});

		describe('pipelineSaving', () => {
			it('setPipelineSaving(true) sets the saving flag', () => {
				useCueDirtyStore.getState().setPipelineSaving(true);
				expect(useCueDirtyStore.getState().pipelineSaving).toBe(true);
			});

			it('setPipelineSaving(false) clears the saving flag', () => {
				useCueDirtyStore.getState().setPipelineSaving(true);
				useCueDirtyStore.getState().setPipelineSaving(false);
				expect(useCueDirtyStore.getState().pipelineSaving).toBe(false);
			});

			it('pipelineSaving does not affect isAnyDirty()', () => {
				useCueDirtyStore.getState().setPipelineSaving(true);
				expect(useCueDirtyStore.getState().isAnyDirty()).toBe(false);
			});

			it('resetAll() does NOT clear pipelineSaving (save outlives the modal)', () => {
				useCueDirtyStore.getState().setPipelineDirty(true);
				useCueDirtyStore.getState().setPipelineSaving(true);

				useCueDirtyStore.getState().resetAll();

				expect(useCueDirtyStore.getState().pipelineDirty).toBe(false);
				expect(useCueDirtyStore.getState().pipelineSaving).toBe(true);
			});
		});
	});
});
describeSourceSuite('diffReviewStore', () => {
	function comment(id: string, body = 'note'): DiffComment {
		return {
			id,
			file: 'a.ts',
			side: 'new',
			startLine: 1,
			endLine: 1,
			changeKeys: ['I1'],
			context: '@@ -0,0 +1 @@\n+x',
			body,
		};
	}

	describe('diffReviewStore', () => {
		beforeEach(() => useDiffReviewStore.setState({ commentsByRepo: {}, draftsByRepo: {} }));

		it('keeps comments per repo through add, update, and remove', () => {
			const store = useDiffReviewStore.getState();
			store.addComment('/repo', comment('1'));
			store.addComment('/repo', comment('2'));
			store.addComment('/other', comment('3'));
			store.updateComment('/repo', '1', 'edited');
			store.removeComment('/repo', '2');

			const state = useDiffReviewStore.getState();
			expect(selectRepoComments('/repo')(state).map((c) => [c.id, c.body])).toEqual([
				['1', 'edited'],
			]);
			expect(selectRepoComments('/other')(state)).toHaveLength(1);
		});

		it('forgets a repo once its last comment is gone, and returns a stable empty list', () => {
			const store = useDiffReviewStore.getState();
			store.addComment('/repo', comment('1'));
			store.clearComments('/repo');
			const state = useDiffReviewStore.getState();
			expect(state.commentsByRepo).toEqual({});
			expect(selectRepoComments('/repo')(state)).toBe(selectRepoComments('/nope')(state));
		});

		it('removeComments drops only the named ones (what a send delivered)', () => {
			const store = useDiffReviewStore.getState();
			store.addComment('/repo', comment('1'));
			store.addComment('/repo', comment('2'));
			store.removeComments('/repo', ['1']);
			expect(selectRepoComments('/repo')(useDiffReviewStore.getState()).map((c) => c.id)).toEqual([
				'2',
			]);
		});

		it('keys a remote repo by its SSH remote too, so two hosts never share a review', () => {
			expect(diffReviewKey('/home/u/p')).toBe('/home/u/p');
			expect(diffReviewKey('/home/u/p', 'host-a')).not.toBe(diffReviewKey('/home/u/p', 'host-b'));
			expect(diffReviewKey('/home/u/p', 'host-a')).not.toBe(diffReviewKey('/home/u/p'));
		});

		it('parks one comment box per repo and hands it back once', () => {
			const store = useDiffReviewStore.getState();
			const draft = { anchor: comment('x'), initialBody: '', body: 'half' };
			store.parkDraft('/repo', draft);
			expect(useDiffReviewStore.getState().takeDraft('/repo')).toEqual(draft);
			expect(useDiffReviewStore.getState().takeDraft('/repo')).toBeUndefined();
		});

		it('discarding a review also forgets its parked box', () => {
			const store = useDiffReviewStore.getState();
			store.parkDraft('/repo', { anchor: comment('x'), initialBody: '', body: 'half' });
			store.clearComments('/repo');
			expect(useDiffReviewStore.getState().draftsByRepo).toEqual({});
		});
	});
});
describeSourceSuite('thoughtStreamStore', () => {
	const SID = 'session-1';
	const TAB = 'tab-a';

	/** Build a ThoughtEntry with explicit timestamp/tab for block-grouping tests. */
	function entry(id: string, timestamp: number, text: string, tabId = TAB): ThoughtEntry {
		return { id, timestamp, tabId, text };
	}

	function reset() {
		useThoughtStreamStore.setState({
			panelSessionId: null,
			buffers: {},
		});
	}

	describe('thoughtStreamStore', () => {
		beforeEach(reset);

		it('starts hidden with no captures', () => {
			const s = useThoughtStreamStore.getState();
			expect(s.panelSessionId).toBeNull();
			expect(s.buffers).toEqual({});
		});

		it('openPanel focuses the session and seeds an empty buffer when it has not thought', () => {
			useThoughtStreamStore.getState().openPanel(SID);
			const s = useThoughtStreamStore.getState();
			expect(s.panelSessionId).toBe(SID);
			expect(s.buffers[SID]).toEqual({ entries: [], trimmed: false, chars: 0, lastAppendAt: 0 });
		});

		it('appendThought records into the buffer', () => {
			const store = useThoughtStreamStore.getState();
			store.openPanel(SID);
			store.appendThought(SID, TAB, 'first thought ');
			store.appendThought(SID, TAB, 'second thought');
			const buf = useThoughtStreamStore.getState().buffers[SID];
			expect(buf.entries).toHaveLength(2);
			expect(buf.entries[0].text).toBe('first thought ');
			expect(buf.entries[0].tabId).toBe(TAB);
			expect(buf.entries[1].text).toBe('second thought');
			expect(buf.chars).toBe('first thought '.length + 'second thought'.length);
			expect(buf.lastAppendAt).toBeGreaterThan(0);
		});

		// The whole point of the feature: you open the stream BECAUSE a run wedged,
		// so the history has to already be there.
		it('buffers ambiently for a session whose panel was never opened', () => {
			useThoughtStreamStore.getState().appendThought(SID, TAB, 'thought nobody was watching');
			const s = useThoughtStreamStore.getState();
			expect(s.panelSessionId).toBeNull();
			expect(s.buffers[SID].entries).toHaveLength(1);

			// Opening later shows that backlog rather than a fresh empty buffer.
			s.openPanel(SID);
			const after = useThoughtStreamStore.getState();
			expect(after.buffers[SID].entries).toHaveLength(1);
			expect(after.buffers[SID].entries[0].text).toBe('thought nobody was watching');
		});

		it('appendThought ignores empty text', () => {
			const store = useThoughtStreamStore.getState();
			store.openPanel(SID);
			store.appendThought(SID, TAB, '');
			expect(useThoughtStreamStore.getState().buffers[SID].entries).toHaveLength(0);
		});

		it('reopening a closed session preserves its existing buffer', () => {
			const store = useThoughtStreamStore.getState();
			store.openPanel(SID);
			store.appendThought(SID, TAB, 'kept');
			store.closePanel();
			store.openPanel(SID);
			const s = useThoughtStreamStore.getState();
			expect(s.panelSessionId).toBe(SID);
			expect(s.buffers[SID].entries).toHaveLength(1);
			expect(s.buffers[SID].entries[0].text).toBe('kept');
		});

		it('closePanel hides the panel but keeps the buffer and keeps recording', () => {
			const store = useThoughtStreamStore.getState();
			store.openPanel(SID);
			store.appendThought(SID, TAB, 'survives the close');
			store.closePanel();
			const s = useThoughtStreamStore.getState();
			expect(s.panelSessionId).toBeNull();
			expect(s.buffers[SID].entries).toHaveLength(1);

			s.appendThought(SID, TAB, ' and after');
			expect(useThoughtStreamStore.getState().buffers[SID].entries).toHaveLength(2);
		});

		it('clearBuffer discards entries and resets the counters', () => {
			const store = useThoughtStreamStore.getState();
			store.openPanel(SID);
			store.appendThought(SID, TAB, 'x');
			store.clearBuffer(SID);
			const buf = useThoughtStreamStore.getState().buffers[SID];
			expect(buf.entries).toHaveLength(0);
			expect(buf.chars).toBe(0);
			expect(buf.trimmed).toBe(false);
		});

		it('caps the buffer at MAX_THOUGHTS_PER_SESSION and sets trimmed', () => {
			const store = useThoughtStreamStore.getState();
			store.openPanel(SID);
			for (let i = 0; i < MAX_THOUGHTS_PER_SESSION + 5; i++) {
				store.appendThought(SID, TAB, `thought-${i}`);
			}
			const buf = useThoughtStreamStore.getState().buffers[SID];
			expect(buf.entries).toHaveLength(MAX_THOUGHTS_PER_SESSION);
			expect(buf.trimmed).toBe(true);
			// oldest dropped, newest retained
			expect(buf.entries[0].text).toBe('thought-5');
			expect(buf.entries[buf.entries.length - 1].text).toBe(
				`thought-${MAX_THOUGHTS_PER_SESSION + 4}`
			);
		});

		// The entry cap alone does not bound memory - one flush can carry a whole
		// reasoning paragraph - so the character budget is the cap that actually holds.
		it('caps the buffer at MAX_THOUGHT_CHARS_PER_SESSION by dropping whole oldest entries', () => {
			const store = useThoughtStreamStore.getState();
			const chunk = 'x'.repeat(MAX_THOUGHT_CHARS_PER_SESSION / 4);
			for (let i = 0; i < 6; i++) store.appendThought(SID, TAB, chunk);
			const buf = useThoughtStreamStore.getState().buffers[SID];
			expect(buf.chars).toBeLessThanOrEqual(MAX_THOUGHT_CHARS_PER_SESSION);
			expect(buf.chars).toBe(buf.entries.reduce((n, e) => n + e.text.length, 0));
			expect(buf.entries.length).toBeLessThan(6);
			expect(buf.trimmed).toBe(true);
		});

		it('keeps the newest thought even when it alone blows the character budget', () => {
			const store = useThoughtStreamStore.getState();
			store.appendThought(SID, TAB, 'y'.repeat(MAX_THOUGHT_CHARS_PER_SESSION + 100));
			const buf = useThoughtStreamStore.getState().buffers[SID];
			expect(buf.entries).toHaveLength(1);
			expect(buf.chars).toBe(MAX_THOUGHT_CHARS_PER_SESSION + 100);
		});

		// Ambient capture means a whole fleet buffers in parallel, so cold sessions
		// have to age out or an all-day app grows without limit.
		describe('cross-session eviction', () => {
			it('evicts the least-recently-active session past MAX_CAPTURED_SESSIONS', () => {
				const store = useThoughtStreamStore.getState();
				for (let i = 0; i < MAX_CAPTURED_SESSIONS + 3; i++) {
					store.appendThought(`sess-${i}`, TAB, `t${i}`);
				}
				const { buffers } = useThoughtStreamStore.getState();
				expect(Object.keys(buffers)).toHaveLength(MAX_CAPTURED_SESSIONS);
				// The three oldest are gone, the newest survive.
				expect(buffers['sess-0']).toBeUndefined();
				expect(buffers['sess-2']).toBeUndefined();
				expect(buffers[`sess-${MAX_CAPTURED_SESSIONS + 2}`]).toBeDefined();
			});

			it('never evicts the session the panel is focused on', () => {
				const store = useThoughtStreamStore.getState();
				store.appendThought('watched', TAB, 'the run being diagnosed');
				store.openPanel('watched');
				for (let i = 0; i < MAX_CAPTURED_SESSIONS + 5; i++) {
					store.appendThought(`noise-${i}`, TAB, `n${i}`);
				}
				const { buffers } = useThoughtStreamStore.getState();
				expect(Object.keys(buffers)).toHaveLength(MAX_CAPTURED_SESSIONS);
				expect(buffers['watched'].entries).toHaveLength(1);
			});
		});

		// N parallel Auto Runs must each capture into their own buffer - a thought
		// from one run must never leak into another. The store is keyed by sessionId
		// in `buffers`, and the capture listener routes every
		// IPC chunk by its parsed sessionId, so independence is structural; these
		// tests guard against a regression that reintroduces a shared accumulator.
		describe('parallel Auto Run independence', () => {
			it('keeps interleaved thoughts from N sessions in separate buffers', () => {
				const store = useThoughtStreamStore.getState();
				const sessions = ['run-a', 'run-b', 'run-c'];
				sessions.forEach((sid) => store.openPanel(sid));

				// Interleave appends across all three runs, as parallel streams would arrive.
				for (let i = 0; i < 4; i++) {
					store.appendThought('run-a', 'tab-a', `a${i} `);
					store.appendThought('run-b', 'tab-b', `b${i} `);
					store.appendThought('run-c', 'tab-c', `c${i} `);
				}

				const { buffers } = useThoughtStreamStore.getState();
				expect(buffers['run-a'].entries).toHaveLength(4);
				expect(buffers['run-b'].entries).toHaveLength(4);
				expect(buffers['run-c'].entries).toHaveLength(4);

				// Each buffer contains ONLY its own session's thoughts.
				expect(buffers['run-a'].entries.every((e) => e.text.startsWith('a'))).toBe(true);
				expect(buffers['run-b'].entries.every((e) => e.text.startsWith('b'))).toBe(true);
				expect(buffers['run-c'].entries.every((e) => e.text.startsWith('c'))).toBe(true);
				// ...and every entry is tagged with its own tab.
				expect(buffers['run-a'].entries.every((e) => e.tabId === 'tab-a')).toBe(true);
				expect(buffers['run-b'].entries.every((e) => e.tabId === 'tab-b')).toBe(true);
			});

			it('closing one run leaves every buffer intact', () => {
				const store = useThoughtStreamStore.getState();
				['run-a', 'run-b', 'run-c'].forEach((sid) => store.openPanel(sid));
				store.appendThought('run-a', 'tab-a', 'a');
				store.appendThought('run-b', 'tab-b', 'b');
				store.appendThought('run-c', 'tab-c', 'c');

				// Panel is focused on run-c (last opened); closing it must not touch a/b.
				expect(useThoughtStreamStore.getState().panelSessionId).toBe('run-c');
				store.closePanel();

				const s = useThoughtStreamStore.getState();
				expect(s.buffers['run-a'].entries).toHaveLength(1);
				expect(s.buffers['run-b'].entries).toHaveLength(1);
				expect(s.buffers['run-c'].entries).toHaveLength(1);
			});

			it('per-session cap trims only the overflowing run', () => {
				const store = useThoughtStreamStore.getState();
				store.openPanel('run-big');
				store.openPanel('run-small');
				for (let i = 0; i < MAX_THOUGHTS_PER_SESSION + 3; i++) {
					store.appendThought('run-big', 'tab', `x${i}`);
				}
				store.appendThought('run-small', 'tab', 'only one');

				const { buffers } = useThoughtStreamStore.getState();
				expect(buffers['run-big'].trimmed).toBe(true);
				expect(buffers['run-big'].entries).toHaveLength(MAX_THOUGHTS_PER_SESSION);
				expect(buffers['run-small'].trimmed).toBe(false);
				expect(buffers['run-small'].entries).toHaveLength(1);
			});
		});

		it('selectActivityCount reports how much is buffered', () => {
			const store = useThoughtStreamStore.getState();
			expect(selectActivityCount(SID)(useThoughtStreamStore.getState())).toBe(0);
			expect(selectActivityCount(undefined)(useThoughtStreamStore.getState())).toBe(0);
			store.appendThought(SID, TAB, 'a');
			store.appendThought(SID, TAB, 'b');
			expect(selectActivityCount(SID)(useThoughtStreamStore.getState())).toBe(2);
		});

		it('selectLastAppendAt drives the live indicator', () => {
			const store = useThoughtStreamStore.getState();
			expect(selectLastAppendAt(SID)(useThoughtStreamStore.getState())).toBe(0);
			store.appendThought(SID, TAB, 'thinking');
			const at = selectLastAppendAt(SID)(useThoughtStreamStore.getState());
			expect(isThoughtStreamLive(at, at)).toBe(true);
			expect(isThoughtStreamLive(at, at + THOUGHT_LIVE_WINDOW_MS + 1)).toBe(false);
			// A session that never thought is never "live".
			expect(isThoughtStreamLive(0)).toBe(false);
		});
	});

	describe('groupThoughtsIntoBlocks', () => {
		it('returns an empty list for no entries', () => {
			expect(groupThoughtsIntoBlocks([])).toEqual([]);
		});

		it('merges entries within the gap window into one block', () => {
			const blocks = groupThoughtsIntoBlocks([
				entry('a', 1000, 'one '),
				entry('b', 1500, 'two '),
				entry('c', 2000, 'three'),
			]);
			expect(blocks).toHaveLength(1);
			expect(blocks[0].id).toBe('a'); // keyed by first entry
			expect(blocks[0].text).toBe('one two three');
			expect(blocks[0].startTimestamp).toBe(1000);
			expect(blocks[0].endTimestamp).toBe(2000);
		});

		it('starts a new block when the gap exceeds THOUGHT_BLOCK_GAP_MS', () => {
			const blocks = groupThoughtsIntoBlocks([
				entry('a', 1000, 'first block'),
				entry('b', 1000 + THOUGHT_BLOCK_GAP_MS + 1, 'second block'),
			]);
			expect(blocks).toHaveLength(2);
			expect(blocks[0].text).toBe('first block');
			expect(blocks[1].text).toBe('second block');
			expect(blocks[1].startTimestamp).toBe(1000 + THOUGHT_BLOCK_GAP_MS + 1);
		});

		it('keeps a gap exactly at the threshold in the same block', () => {
			const blocks = groupThoughtsIntoBlocks([
				entry('a', 1000, 'a'),
				entry('b', 1000 + THOUGHT_BLOCK_GAP_MS, 'b'),
			]);
			expect(blocks).toHaveLength(1);
			expect(blocks[0].text).toBe('ab');
		});

		it('splits on a tab change even within the gap window', () => {
			const blocks = groupThoughtsIntoBlocks([
				entry('a', 1000, 'tab-a thought', 'tab-a'),
				entry('b', 1200, 'tab-b thought', 'tab-b'),
			]);
			expect(blocks).toHaveLength(2);
			expect(blocks[0].tabId).toBe('tab-a');
			expect(blocks[1].tabId).toBe('tab-b');
		});

		it('honors a custom gap argument', () => {
			const blocks = groupThoughtsIntoBlocks(
				[entry('a', 0, 'a'), entry('b', 100, 'b')],
				50 // tighter than the 100ms spacing -> two blocks
			);
			expect(blocks).toHaveLength(2);
		});
	});

	/**
	 * The action half of the timeline.
	 *
	 * The design constraint these pin down: reasoning and tool calls live in ONE
	 * array in arrival order. A previous attempt at this feature kept them in two
	 * lists and merged at display time, which cannot place a tool call inside a
	 * block of reasoning - the block has a single timestamp, so a fast tool call
	 * rendered AFTER the reasoning that actually followed it. For a feed whose
	 * whole purpose is "watch what the agent is doing, in order", that is the bug.
	 */
	describe('tool activity capture', () => {
		beforeEach(reset);

		const label = (verb: string, target = '') => ({ verb, target });

		function tool(
			sessionId: string,
			tabId: string,
			toolName: string,
			status: ToolActivityStatus,
			extra: { toolCallId?: string; timestamp?: number; target?: string } = {}
		) {
			useThoughtStreamStore.getState().appendToolActivity(sessionId, tabId, {
				toolName,
				label: label(toolName, extra.target ?? ''),
				status,
				toolCallId: extra.toolCallId,
				timestamp: extra.timestamp,
			});
		}

		it('records a tool call onto the same timeline as the reasoning', () => {
			const store = useThoughtStreamStore.getState();
			store.appendThought(SID, TAB, 'thinking ');
			tool(SID, TAB, 'Bash', 'running');

			const { entries } = useThoughtStreamStore.getState().buffers[SID];
			expect(entries).toHaveLength(2);
			expect(isToolEvent(entries[0])).toBe(false);
			expect(isToolEvent(entries[1])).toBe(true);
		});

		it('ignores an event with no tool name', () => {
			tool(SID, TAB, '   ', 'running');
			expect(useThoughtStreamStore.getState().buffers[SID]).toBeUndefined();
		});

		it('merges a completion into the running entry by toolCallId', () => {
			tool(SID, TAB, 'Bash', 'running', { toolCallId: 'call-1', timestamp: 1000 });
			tool(SID, TAB, 'Bash', 'completed', { toolCallId: 'call-1', timestamp: 5000 });

			const { entries } = useThoughtStreamStore.getState().buffers[SID];
			// One ACTION, not two state transitions.
			expect(entries).toHaveLength(1);
			const event = entries[0] as ToolActivityEntry;
			expect(event.tool.status).toBe('completed');
			expect(event.tool.endedAt).toBe(5000);
		});

		it('keeps the START timestamp when a call completes, so the row does not jump', () => {
			tool(SID, TAB, 'Bash', 'running', { toolCallId: 'call-1', timestamp: 1000 });
			tool(SID, TAB, 'Bash', 'completed', { toolCallId: 'call-1', timestamp: 90_000 });

			const event = useThoughtStreamStore.getState().buffers[SID].entries[0] as ToolActivityEntry;
			expect(event.timestamp).toBe(1000);
		});

		it('merges into its ORIGINAL slot, leaving later events after it', () => {
			const store = useThoughtStreamStore.getState();
			tool(SID, TAB, 'Bash', 'running', { toolCallId: 'call-1', timestamp: 1000 });
			store.appendThought(SID, TAB, 'while that runs');
			tool(SID, TAB, 'Bash', 'completed', { toolCallId: 'call-1', timestamp: 9000 });

			const { entries } = useThoughtStreamStore.getState().buffers[SID];
			expect(entries).toHaveLength(2);
			// The completed call stays FIRST - a long build must not leapfrog the
			// reasoning that happened while it ran.
			expect(isToolEvent(entries[0])).toBe(true);
			expect((entries[0] as ToolActivityEntry).tool.status).toBe('completed');
			expect(isToolEvent(entries[1])).toBe(false);
		});

		it('merges by newest running call of the same name when the provider sends no id', () => {
			tool(SID, TAB, 'shell', 'running', { timestamp: 1000 });
			tool(SID, TAB, 'shell', 'running', { timestamp: 2000 });
			tool(SID, TAB, 'shell', 'failed', { timestamp: 3000 });

			const { entries } = useThoughtStreamStore.getState().buffers[SID];
			expect(entries).toHaveLength(2);
			// The NEWEST running call is the one that finished.
			expect((entries[0] as ToolActivityEntry).tool.status).toBe('running');
			expect((entries[1] as ToolActivityEntry).tool.status).toBe('failed');
		});

		it('never merges a completion across tabs', () => {
			tool(SID, 'tab-a', 'shell', 'running', { timestamp: 1000 });
			tool(SID, 'tab-b', 'shell', 'completed', { timestamp: 2000 });

			const { entries } = useThoughtStreamStore.getState().buffers[SID];
			expect(entries).toHaveLength(2);
			expect((entries[0] as ToolActivityEntry).tool.status).toBe('running');
		});

		it('appends a completion with no matching start rather than dropping it', () => {
			tool(SID, TAB, 'Read', 'completed', { timestamp: 1000 });
			expect(useThoughtStreamStore.getState().buffers[SID].entries).toHaveLength(1);
		});

		it('prefers a descriptive label when the running event carried no target', () => {
			useThoughtStreamStore.getState().appendToolActivity(SID, TAB, {
				toolName: 'Bash',
				label: { verb: 'Ran', target: '', targetIsCode: true },
				status: 'running',
				toolCallId: 'c1',
			});
			useThoughtStreamStore.getState().appendToolActivity(SID, TAB, {
				toolName: 'Bash',
				label: { verb: 'Ran', target: 'npm test', targetIsCode: true },
				status: 'completed',
				toolCallId: 'c1',
			});
			const event = useThoughtStreamStore.getState().buffers[SID].entries[0] as ToolActivityEntry;
			expect(event.tool.label.target).toBe('npm test');
		});

		it('merges an id-carrying completion into a start the provider sent without one', () => {
			// Some providers only stamp the id on the completion. Bailing out on the
			// id miss rendered ONE action as two rows: a phantom "still running" call
			// sitting above its own result, which reads exactly like a hung tool.
			tool(SID, TAB, 'shell', 'running', { timestamp: 1000 });
			tool(SID, TAB, 'shell', 'completed', { toolCallId: 'late-id', timestamp: 2000 });

			const { entries } = useThoughtStreamStore.getState().buffers[SID];
			expect(entries).toHaveLength(1);
			const event = entries[0] as ToolActivityEntry;
			expect(event.tool.status).toBe('completed');
			expect(event.tool.toolCallId).toBe('late-id');
		});

		it('never steals a running call that already belongs to a different id', () => {
			tool(SID, TAB, 'shell', 'running', { toolCallId: 'call-a', timestamp: 1000 });
			tool(SID, TAB, 'shell', 'completed', { toolCallId: 'call-b', timestamp: 2000 });

			const { entries } = useThoughtStreamStore.getState().buffers[SID];
			expect(entries).toHaveLength(2);
			expect((entries[0] as ToolActivityEntry).tool.status).toBe('running');
			expect((entries[0] as ToolActivityEntry).tool.toolCallId).toBe('call-a');
		});

		it('re-derives the character total when a merge replaces the label', () => {
			// The merged row is LONGER than the one it replaced. Carrying the old
			// total forward undercounts what the buffer holds, which is what decides
			// when the budget trims and whether the panel admits it trimmed anything.
			useThoughtStreamStore.getState().appendToolActivity(SID, TAB, {
				toolName: 'Bash',
				label: { verb: 'Ran', target: '', targetIsCode: true },
				status: 'running',
				toolCallId: 'c1',
			});
			expect(useThoughtStreamStore.getState().buffers[SID].chars).toBe('Ran'.length);

			useThoughtStreamStore.getState().appendToolActivity(SID, TAB, {
				toolName: 'Bash',
				label: { verb: 'Ran', target: 'npm test', targetIsCode: true },
				status: 'completed',
				toolCallId: 'c1',
			});
			expect(useThoughtStreamStore.getState().buffers[SID].chars).toBe(
				'Ran'.length + 'npm test'.length
			);
		});

		it('counts tool calls toward the timeline cap', () => {
			for (let i = 0; i < MAX_THOUGHTS_PER_SESSION + 5; i++) {
				tool(SID, TAB, `tool-${i}`, 'completed', { timestamp: 1000 + i });
			}
			const buf = useThoughtStreamStore.getState().buffers[SID];
			expect(buf.entries).toHaveLength(MAX_THOUGHTS_PER_SESSION);
			expect(buf.trimmed).toBe(true);
		});

		it('a tool call keeps the session out of LRU eviction', () => {
			tool(SID, TAB, 'Bash', 'running', { timestamp: 5000 });
			expect(selectActivityCount(SID)(useThoughtStreamStore.getState())).toBe(1);
			expect(selectLastAppendAt(SID)(useThoughtStreamStore.getState())).toBe(5000);
		});
	});

	/**
	 * buildActivityFeed - the ordering guarantee.
	 *
	 * These are the regression tests for the defect that sank the first attempt at
	 * this feature: a tool call that happens in the MIDDLE of a run of reasoning
	 * has to render between the two halves of it. That is only expressible because
	 * both kinds of event come off one array in arrival order.
	 */
	describe('buildActivityFeed', () => {
		const toolEvent = (
			id: string,
			timestamp: number,
			name: string,
			tabId = TAB,
			status: ToolActivityStatus = 'completed'
		): StreamEvent => ({
			id,
			timestamp,
			tabId,
			tool: { name, label: { verb: name, target: '', targetIsCode: true }, status },
		});

		it('returns an empty feed for no events', () => {
			expect(buildActivityFeed([])).toEqual([]);
		});

		it('splits a block of reasoning around a tool call that interrupted it', () => {
			// All three thoughts are inside the gap window, so WITHOUT the tool they
			// would coalesce into a single block and the call would have nowhere to go.
			const feed = buildActivityFeed([
				entry('t1', 1000, 'I should check the tests. '),
				toolEvent('x1', 1100, 'Bash'),
				entry('t2', 1200, 'They passed, so '),
				entry('t3', 1300, 'the bug is elsewhere.'),
			]);

			expect(feed.map((i) => i.kind)).toEqual(['thought', 'tool', 'thought']);
			expect(feed[0].kind === 'thought' && feed[0].block.text).toBe('I should check the tests. ');
			expect(feed[1].kind === 'tool' && feed[1].activity.id).toBe('x1');
			// The reasoning AFTER the call is its own block, below it.
			expect(feed[2].kind === 'thought' && feed[2].block.text).toBe(
				'They passed, so the bug is elsewhere.'
			);
		});

		it('renders a fast tool call before the reasoning that followed it', () => {
			// The exact failure of the two-list design: `x1` is 1ms after the block
			// started, so a feed sorted by block START time buried it underneath.
			const feed = buildActivityFeed([
				entry('t1', 1000, 'first'),
				toolEvent('x1', 1001, 'Read'),
				entry('t2', 1002, 'second'),
			]);
			const toolIndex = feed.findIndex((i) => i.kind === 'tool');
			const afterIndex = feed.findIndex(
				(i) => i.kind === 'thought' && i.block.text.includes('second')
			);
			expect(toolIndex).toBeLessThan(afterIndex);
		});

		it('keeps consecutive tool calls as separate rows in order', () => {
			const feed = buildActivityFeed([
				toolEvent('x1', 1000, 'Read'),
				toolEvent('x2', 1100, 'Bash'),
				toolEvent('x3', 1200, 'Edit'),
			]);
			expect(feed).toHaveLength(3);
			expect(feed.map((i) => (i.kind === 'tool' ? i.activity.tool.name : null))).toEqual([
				'Read',
				'Bash',
				'Edit',
			]);
		});

		it('is emitted oldest-first so the panel can reverse for newest-on-top', () => {
			const feed = buildActivityFeed([entry('t1', 1000, 'old'), toolEvent('x1', 2000, 'Bash')]);
			expect(feed[0].kind).toBe('thought');
			expect(feed[1].kind).toBe('tool');
		});

		it('still coalesces reasoning when no tool interrupts it', () => {
			const feed = buildActivityFeed([entry('a', 1000, 'one '), entry('b', 1500, 'two')]);
			expect(feed).toHaveLength(1);
			expect(feed[0].kind === 'thought' && feed[0].block.text).toBe('one two');
		});

		it('groupThoughtsIntoBlocks projects the same walk, dropping tool rows', () => {
			const events: StreamEvent[] = [
				entry('t1', 1000, 'before '),
				toolEvent('x1', 1100, 'Bash'),
				entry('t2', 1200, 'after'),
			];
			// A tool call still SPLITS the reasoning here, because both views are the
			// one walk - they can never disagree about where a block starts.
			expect(groupThoughtsIntoBlocks(events).map((b) => b.text)).toEqual(['before ', 'after']);
		});
	});
});
