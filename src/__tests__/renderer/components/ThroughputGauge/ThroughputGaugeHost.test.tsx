/**
 * Tests for ThroughputGaugeHost: nothing exists while the `throughputGauge`
 * Encore Feature is off, a mid-session flip on subscribes and pops the card up,
 * the close latch survives a remount, live process events move the published
 * needle, the capture loop honors the scope, window, and metric settings and
 * the window's agent ownership, and the card's position and size persist on
 * drag or resize end, come back on remount, and are pulled into a smaller
 * window. Those run with `window.maestro.floatingWidgets` absent (the browser
 * build); the desktop-window cases at the end install a fake one.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Window ownership. Unset permits every agent (no WindowProvider, like the
// primary window's catch-all); a predicate scopes the window like a secondary.
let mockOwnsSession: ((agentId: string) => boolean) | undefined;
vi.mock('../../../../renderer/contexts/WindowContext', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../renderer/contexts/WindowContext')>()),
	useWindowContextOptional: () => (mockOwnsSession ? { ownsSession: mockOwnsSession } : null),
}));

import { ThroughputGaugeHost } from '../../../../renderer/components/ThroughputGauge';
import {
	THROUGHPUT_PUBLISH_MS,
	throughputTracker,
} from '../../../../renderer/components/ThroughputGauge/useThroughputCapture';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import {
	THROUGHPUT_GAUGE_RECTS_KEY,
	THROUGHPUT_GAUGE_VISIBLE_KEY,
	useThroughputGaugeStore,
} from '../../../../renderer/stores/throughputGaugeStore';
import {
	GAUGE_CLAMP_MARGIN,
	GAUGE_DEFAULT_SIZE,
	GAUGE_EDGE_MARGIN,
	GAUGE_INPUT_AREA_CLEARANCE,
} from '../../../../renderer/components/ThroughputGauge/gaugeGeometry';
import { ENCORE_FEATURE_DEFAULTS } from '../../../../shared/encoreFeatureDefaults';
import {
	DEFAULT_THROUGHPUT_GAUGE_SETTINGS,
	type ThroughputGaugeSettings,
} from '../../../../shared/throughputGauge';
import type { CallUsage, UsageStats } from '../../../../shared/types';
import { installLocalStorageMock } from '../../../helpers/mockLocalStorage';
import { createMockSession } from '../../../helpers/mockSession';
import { createMockAITab } from '../../../helpers/mockTab';
import { PUBLISH_INTERVAL_MS } from '../../../../renderer/utils/windowStoreMirror';
import { mockTheme } from '../../../helpers/mockTheme';

const ZERO = { in: 0, out: 0, combined: 0 };
const AI_TAB_ID = 'agent-1-ai-tab-1';

type DataHandler = (sessionId: string, data: string) => void;
type UsageHandler = (sessionId: string, usage: UsageStats) => void;
type CallUsageHandler = (sessionId: string, usage: CallUsage) => void;
type ExitHandler = (sessionId: string, code: number) => void;

/** The `process.*` subscriptions the host makes, each returning its own unsubscribe spy. */
function makeProcessListeners() {
	const unsubscribes = {
		onData: vi.fn(),
		onThinkingChunk: vi.fn(),
		onUsage: vi.fn(),
		onCallUsage: vi.fn(),
		onExit: vi.fn(),
	};
	return {
		unsubscribes,
		onData: vi.fn((_handler: DataHandler) => unsubscribes.onData),
		onThinkingChunk: vi.fn((_handler: DataHandler) => unsubscribes.onThinkingChunk),
		onUsage: vi.fn((_handler: UsageHandler) => unsubscribes.onUsage),
		onCallUsage: vi.fn((_handler: CallUsageHandler) => unsubscribes.onCallUsage),
		onExit: vi.fn((_handler: ExitHandler) => unsubscribes.onExit),
	};
}

function usage(overrides: Partial<UsageStats> = {}): UsageStats {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		totalCostUsd: 0,
		contextWindow: 200000,
		...overrides,
	};
}

function setGaugeSettings(patch: Partial<ThroughputGaugeSettings>) {
	useSettingsStore.setState({
		throughputGaugeSettings: { ...DEFAULT_THROUGHPUT_GAUGE_SETTINGS, ...patch },
	});
}

function setFlag(enabled: boolean, settingsLoaded = true) {
	useSettingsStore.setState({
		settingsLoaded,
		encoreFeatures: { ...ENCORE_FEATURE_DEFAULTS, throughputGauge: enabled },
	});
}

describe('ThroughputGaugeHost', () => {
	let storage: Map<string, string>;
	let listeners: ReturnType<typeof makeProcessListeners>;
	const processApi = window.maestro.process as unknown as Record<string, unknown>;
	const originals = {
		onData: processApi.onData,
		onThinkingChunk: processApi.onThinkingChunk,
		onUsage: processApi.onUsage,
		onCallUsage: processApi.onCallUsage,
		onExit: processApi.onExit,
	};

	beforeEach(() => {
		mockOwnsSession = undefined;
		storage = installLocalStorageMock();
		listeners = makeProcessListeners();
		Object.assign(processApi, {
			onData: listeners.onData,
			onThinkingChunk: listeners.onThinkingChunk,
			onUsage: listeners.onUsage,
			onCallUsage: listeners.onCallUsage,
			onExit: listeners.onExit,
		});
		throughputTracker.clear();
		useThroughputGaugeStore.setState({
			visible: true,
			rates: ZERO,
			peak: ZERO,
			history: { in: [], out: [], combined: [] },
			rects: {},
		});
		setGaugeSettings({});
		useSessionStore.setState({
			sessions: [
				createMockSession({ id: 'agent-1', name: 'Backend' }),
				createMockSession({ id: 'agent-2', name: 'Frontend' }),
			],
			activeSessionId: 'agent-1',
		});
		setFlag(false);
	});

	afterEach(() => {
		Object.assign(processApi, originals);
		vi.useRealTimers();
	});

	it('renders nothing and subscribes to nothing while the flag is off', () => {
		const { container } = render(<ThroughputGaugeHost theme={mockTheme} />);

		expect(container).toBeEmptyDOMElement();
		expect(screen.queryByTestId('floating-throughput-gauge')).toBeNull();
		expect(listeners.onData).not.toHaveBeenCalled();
		expect(listeners.onThinkingChunk).not.toHaveBeenCalled();
		expect(listeners.onUsage).not.toHaveBeenCalled();
		expect(listeners.onCallUsage).not.toHaveBeenCalled();
		expect(listeners.onExit).not.toHaveBeenCalled();
	});

	it('flipping the flag on subscribes and pops the gauge up, even after a close', () => {
		useThroughputGaugeStore.setState({ visible: false });
		render(<ThroughputGaugeHost theme={mockTheme} />);

		act(() => setFlag(true));

		expect(listeners.onData).toHaveBeenCalledTimes(1);
		expect(listeners.onThinkingChunk).toHaveBeenCalledTimes(1);
		expect(listeners.onUsage).toHaveBeenCalledTimes(1);
		expect(listeners.onCallUsage).toHaveBeenCalledTimes(1);
		expect(listeners.onExit).toHaveBeenCalledTimes(1);
		expect(screen.getByTestId('floating-throughput-gauge')).toBeInTheDocument();
		expect(useThroughputGaugeStore.getState().visible).toBe(true);
	});

	it('the close button hides the card but keeps capturing', () => {
		setFlag(true);
		render(<ThroughputGaugeHost theme={mockTheme} />);

		fireEvent.click(screen.getByTestId('throughput-gauge-close'));

		expect(screen.queryByTestId('floating-throughput-gauge')).toBeNull();
		expect(storage.get(THROUGHPUT_GAUGE_VISIBLE_KEY)).toBe('false');
		expect(listeners.unsubscribes.onData).not.toHaveBeenCalled();
	});

	it('honors the persisted close on remount with the flag already on', () => {
		setFlag(true);
		const first = render(<ThroughputGaugeHost theme={mockTheme} />);
		fireEvent.click(screen.getByTestId('throughput-gauge-close'));
		first.unmount();

		render(<ThroughputGaugeHost theme={mockTheme} />);

		expect(screen.queryByTestId('floating-throughput-gauge')).toBeNull();
		expect(useThroughputGaugeStore.getState().visible).toBe(false);
	});

	it('treats the first value after settings load as the launch state, not a flip', () => {
		useThroughputGaugeStore.setState({ visible: false });
		setFlag(false, false);
		render(<ThroughputGaugeHost theme={mockTheme} />);

		// Settings arrive with the feature already on: the user's close stands.
		act(() => setFlag(true, true));

		expect(listeners.onData).toHaveBeenCalledTimes(1);
		expect(screen.queryByTestId('floating-throughput-gauge')).toBeNull();
	});

	it('turning the flag off unsubscribes every listener and drops every reading', () => {
		vi.useFakeTimers();
		setFlag(true);
		render(<ThroughputGaugeHost theme={mockTheme} />);
		const onUsage = listeners.onUsage.mock.calls[0][0];
		// A real reading, so the peak and the sparkline trace hold something.
		act(() => {
			onUsage(AI_TAB_ID, usage({ inputTokens: 1000, outputTokens: 300 }));
			vi.advanceTimersByTime(THROUGHPUT_PUBLISH_MS);
		});
		expect(useThroughputGaugeStore.getState().peak.combined).toBeGreaterThan(0);
		// The test setup's ResizeObserver mock reports on a setTimeout; let the
		// card's toast avoid zone take its first report so only the gauge's own
		// timers are left to count.
		act(() => vi.runOnlyPendingTimers());

		act(() => setFlag(false));

		expect(listeners.unsubscribes.onData).toHaveBeenCalledTimes(1);
		expect(listeners.unsubscribes.onThinkingChunk).toHaveBeenCalledTimes(1);
		expect(listeners.unsubscribes.onUsage).toHaveBeenCalledTimes(1);
		expect(listeners.unsubscribes.onCallUsage).toHaveBeenCalledTimes(1);
		expect(listeners.unsubscribes.onExit).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
		// Regression: the peak and the trace used to survive, so turning the
		// feature back on showed the old peak mark and sparkline.
		const { rates, peak, history } = useThroughputGaugeStore.getState();
		expect(rates).toEqual(ZERO);
		expect(peak).toEqual(ZERO);
		for (const metric of ['in', 'out', 'combined'] as const) {
			expect(history[metric].every((reading) => reading === 0)).toBe(true);
		}
	});

	it.each(['usage', 'call'] as const)(
		'accounts for the captured owner of closed tabs in %s reports',
		(kind) => {
			vi.useFakeTimers();
			setFlag(true);
			const session = createMockSession({
				id: 'agent-1',
				toolType: 'claude-code',
				orphanedThinkingTabs: [
					createMockAITab({
						id: 'tab-1',
						state: 'busy',
						tabProvider: 'claude-code',
						turnProvider: 'codex',
					}),
				],
			});
			useSessionStore.setState({ sessions: [session] });
			render(<ThroughputGaugeHost theme={mockTheme} />);
			act(() => {
				const report =
					kind === 'usage'
						? listeners.onUsage.mock.calls[0][0]
						: listeners.onCallUsage.mock.calls[0][0];
				report(
					AI_TAB_ID,
					usage({ inputTokens: 1000, cacheReadInputTokens: 900, outputTokens: 100 })
				);
				vi.advanceTimersByTime(THROUGHPUT_PUBLISH_MS);
			});
			// Codex includes cached reads in input; Claude does not.
			expect(useThroughputGaugeStore.getState().rates.in).toBeCloseTo(10);
			expect(useThroughputGaugeStore.getState().rates.out).toBeCloseTo(10);
		}
	);

	it('retains a raw process owner when another turn changes the tab stamp', () => {
		vi.useFakeTimers();
		setFlag(true);
		const tab = createMockAITab({
			id: 'tab-1',
			tabProvider: 'codex',
			turnProvider: 'codex',
			state: 'busy',
		});
		useSessionStore.setState({ sessions: [createMockSession({ id: 'agent-1', aiTabs: [tab] })] });
		render(<ThroughputGaugeHost theme={mockTheme} />);
		act(() => {
			listeners.onThinkingChunk.mock.calls[0][0](AI_TAB_ID + '-fp-123', 'hello');
			useSessionStore.setState({
				sessions: [
					createMockSession({ id: 'agent-1', aiTabs: [{ ...tab, turnProvider: 'claude-code' }] }),
				],
			});
			listeners.onUsage.mock.calls[0][0](
				AI_TAB_ID + '-fp-123',
				usage({ inputTokens: 1000, cacheReadInputTokens: 900 })
			);
			vi.advanceTimersByTime(THROUGHPUT_PUBLISH_MS);
		});
		expect(useThroughputGaugeStore.getState().rates.in).toBeCloseTo(10);
	});

	it('live output and usage move the published rate above zero and record a peak', () => {
		vi.useFakeTimers();
		setFlag(true);
		render(<ThroughputGaugeHost theme={mockTheme} />);
		const onData = listeners.onData.mock.calls[0][0];
		const onUsage = listeners.onUsage.mock.calls[0][0];

		act(() => {
			onData(AI_TAB_ID, 'x'.repeat(400));
			onUsage(AI_TAB_ID, usage({ inputTokens: 1000, outputTokens: 300 }));
			vi.advanceTimersByTime(THROUGHPUT_PUBLISH_MS);
		});

		const { rates, peak, history } = useThroughputGaugeStore.getState();
		expect(rates.in).toBeGreaterThan(0);
		expect(rates.out).toBeGreaterThan(0);
		expect(rates.combined).toBeCloseTo(rates.in + rates.out);
		expect(peak.combined).toBe(rates.combined);
		expect(history.combined[history.combined.length - 1]).toBe(rates.combined);
		expect(screen.getByTestId('throughput-gauge-reading').textContent).not.toBe('0');
	});

	it('per-call usage moves the rate mid-turn, and the turn report adds only what it missed', () => {
		vi.useFakeTimers();
		setFlag(true);
		render(<ThroughputGaugeHost theme={mockTheme} />);
		const onCallUsage = listeners.onCallUsage.mock.calls[0][0];
		const onThinkingChunk = listeners.onThinkingChunk.mock.calls[0][0];
		const onUsage = listeners.onUsage.mock.calls[0][0];
		const call = (inputTokens: number, outputTokens: number): CallUsage => ({
			inputTokens,
			outputTokens,
			cacheReadInputTokens: 150000,
			cacheCreationInputTokens: 0,
		});

		act(() => {
			onCallUsage(AI_TAB_ID, call(600, 200));
			// The same call's text, which the call report already counted.
			onThinkingChunk(AI_TAB_ID, 'x'.repeat(800));
			vi.advanceTimersByTime(THROUGHPUT_PUBLISH_MS);
		});
		// 800 tokens over the default 10s window, cache reads left out.
		expect(useThroughputGaugeStore.getState().rates.combined).toBeCloseTo(80);

		act(() => {
			onUsage(AI_TAB_ID, usage({ inputTokens: 1000, outputTokens: 300 }));
			vi.advanceTimersByTime(THROUGHPUT_PUBLISH_MS);
		});
		// The turn's 1300, counted once.
		expect(useThroughputGaugeStore.getState().rates.combined).toBeCloseTo(130);
	});

	it('with scope active, output from another agent does not move the rate', () => {
		vi.useFakeTimers();
		setGaugeSettings({ scope: 'active' });
		setFlag(true);
		render(<ThroughputGaugeHost theme={mockTheme} />);
		const onUsage = listeners.onUsage.mock.calls[0][0];

		act(() => {
			onUsage('agent-2-ai-tab-1', usage({ inputTokens: 1000, outputTokens: 300 }));
			vi.advanceTimersByTime(THROUGHPUT_PUBLISH_MS);
		});
		expect(useThroughputGaugeStore.getState().rates).toEqual(ZERO);

		act(() => {
			onUsage(AI_TAB_ID, usage({ inputTokens: 1000, outputTokens: 300 }));
			vi.advanceTimersByTime(THROUGHPUT_PUBLISH_MS);
		});
		// 1300 tokens from the active agent over the default 10s window.
		expect(useThroughputGaugeStore.getState().rates.combined).toBeCloseTo(130);
		expect(screen.getByTestId('throughput-gauge-label').textContent).toBe('Combined');
		expect(screen.getByTestId('throughput-gauge-caption').textContent).toBe('Backend');
	});

	it('with scope all, every agent counts', () => {
		vi.useFakeTimers();
		setFlag(true);
		render(<ThroughputGaugeHost theme={mockTheme} />);
		const onUsage = listeners.onUsage.mock.calls[0][0];

		act(() => {
			onUsage('agent-2-ai-tab-1', usage({ inputTokens: 1000, outputTokens: 300 }));
			vi.advanceTimersByTime(THROUGHPUT_PUBLISH_MS);
		});

		expect(useThroughputGaugeStore.getState().rates.combined).toBeCloseTo(130);
		expect(screen.getByTestId('throughput-gauge-caption').textContent).toBe('all agents');
	});

	it('averages over the chosen window and resets the peak when the window changes', () => {
		vi.useFakeTimers();
		setFlag(true);
		render(<ThroughputGaugeHost theme={mockTheme} />);
		const onUsage = listeners.onUsage.mock.calls[0][0];

		act(() => {
			onUsage(AI_TAB_ID, usage({ inputTokens: 1000, outputTokens: 500 }));
			vi.advanceTimersByTime(THROUGHPUT_PUBLISH_MS);
		});
		expect(useThroughputGaugeStore.getState().peak.combined).toBeCloseTo(150);

		act(() => {
			setGaugeSettings({ windowMs: 30000 });
			vi.advanceTimersByTime(THROUGHPUT_PUBLISH_MS);
		});

		// Same 1500 tokens over 30s; the 10s peak is gone, not carried over.
		const { rates, peak, history } = useThroughputGaugeStore.getState();
		expect(rates.combined).toBeCloseTo(50);
		expect(peak.combined).toBeCloseTo(50);
		expect(history.combined).toEqual([rates.combined]);
	});

	it('changing the scope also resets the peak, keeping the same listeners', () => {
		vi.useFakeTimers();
		setFlag(true);
		render(<ThroughputGaugeHost theme={mockTheme} />);
		const onUsage = listeners.onUsage.mock.calls[0][0];

		act(() => {
			onUsage('agent-2-ai-tab-1', usage({ inputTokens: 1000 }));
			vi.advanceTimersByTime(THROUGHPUT_PUBLISH_MS);
		});
		expect(useThroughputGaugeStore.getState().peak.combined).toBeCloseTo(100);

		act(() => {
			setGaugeSettings({ scope: 'active' });
			vi.advanceTimersByTime(THROUGHPUT_PUBLISH_MS);
		});

		expect(useThroughputGaugeStore.getState().peak).toEqual(ZERO);
		expect(listeners.onUsage).toHaveBeenCalledTimes(1);
		expect(listeners.unsubscribes.onUsage).not.toHaveBeenCalled();
	});

	it("shows the chosen metric and records every metric's history", () => {
		vi.useFakeTimers();
		setGaugeSettings({ metric: 'out' });
		setFlag(true);
		render(<ThroughputGaugeHost theme={mockTheme} />);
		const onUsage = listeners.onUsage.mock.calls[0][0];

		act(() => {
			onUsage(AI_TAB_ID, usage({ inputTokens: 1000, outputTokens: 300 }));
			vi.advanceTimersByTime(THROUGHPUT_PUBLISH_MS);
		});

		const { rates, history } = useThroughputGaugeStore.getState();
		expect(history).toEqual({ in: [rates.in], out: [rates.out], combined: [rates.combined] });
		expect(screen.getByTestId('throughput-gauge-reading').textContent).toBe('30');
		expect(screen.getByTestId('throughput-gauge-label').textContent).toBe('Out');
		expect(screen.getByTestId('throughput-gauge-caption').textContent).toBe('all agents');
	});

	it('ignores command-terminal output', () => {
		vi.useFakeTimers();
		setFlag(true);
		render(<ThroughputGaugeHost theme={mockTheme} />);
		const onData = listeners.onData.mock.calls[0][0];

		act(() => {
			onData('agent-1-terminal', 'x'.repeat(4000));
			vi.advanceTimersByTime(THROUGHPUT_PUBLISH_MS);
		});

		expect(useThroughputGaugeStore.getState().rates).toEqual(ZERO);
		expect(throughputTracker.sampleCount()).toBe(0);
	});

	it('ignores group chat processes, whatever the participant is called', () => {
		vi.useFakeTimers();
		setFlag(true);
		render(<ThroughputGaugeHost theme={mockTheme} />);
		const onUsage = listeners.onUsage.mock.calls[0][0];
		const chatId = '550e8400-e29b-41d4-a716-446655440000';

		act(() => {
			// Regression: a participant's name is user-supplied, and these two used
			// to parse as agent turns (`-ai-` as an AI tab, `-batch-{n}` as Auto Run).
			for (const processId of [
				`group-chat-${chatId}-participant-my-ai-agent-1702934567890`,
				`group-chat-${chatId}-participant-batch-1702934567890`,
				`group-chat-${chatId}-moderator-1702934567890`,
			]) {
				onUsage(processId, usage({ inputTokens: 1000, outputTokens: 300 }));
			}
			vi.advanceTimersByTime(THROUGHPUT_PUBLISH_MS);
		});

		expect(useThroughputGaugeStore.getState().rates).toEqual(ZERO);
		expect(throughputTracker.sampleCount()).toBe(0);
	});

	it('ignores agents a secondary window does not own', () => {
		vi.useFakeTimers();
		mockOwnsSession = (agentId) => agentId === 'agent-1';
		setFlag(true);
		render(<ThroughputGaugeHost theme={mockTheme} />);
		const onUsage = listeners.onUsage.mock.calls[0][0];

		act(() => {
			onUsage('agent-2-ai-tab-1', usage({ inputTokens: 1000, outputTokens: 300 }));
			vi.advanceTimersByTime(THROUGHPUT_PUBLISH_MS);
		});
		expect(useThroughputGaugeStore.getState().rates).toEqual(ZERO);

		act(() => {
			onUsage(AI_TAB_ID, usage({ inputTokens: 1000, outputTokens: 300 }));
			vi.advanceTimersByTime(THROUGHPUT_PUBLISH_MS);
		});
		expect(useThroughputGaugeStore.getState().rates.combined).toBeCloseTo(130);
	});

	it('counts a reply re-sent after its usage report once, and reopens the source on exit', () => {
		vi.useFakeTimers();
		setFlag(true);
		render(<ThroughputGaugeHost theme={mockTheme} />);
		const onThinkingChunk = listeners.onThinkingChunk.mock.calls[0][0];
		const onData = listeners.onData.mock.calls[0][0];
		const onUsage = listeners.onUsage.mock.calls[0][0];
		const onExit = listeners.onExit.mock.calls[0][0];

		act(() => {
			// 100 tokens stream, the report says 300 (tool calls never stream), then
			// the finished reply arrives again as process:data.
			onThinkingChunk(AI_TAB_ID, 'x'.repeat(400));
			onUsage(AI_TAB_ID, usage({ outputTokens: 300 }));
			onData(AI_TAB_ID, 'x'.repeat(400));
			vi.advanceTimersByTime(THROUGHPUT_PUBLISH_MS);
		});
		// 300 output tokens over the default 10s window, not 400.
		expect(useThroughputGaugeStore.getState().rates.out).toBeCloseTo(30);

		act(() => {
			onExit(AI_TAB_ID, 0);
			// The tab's next turn runs under the same process id.
			onData(AI_TAB_ID, 'x'.repeat(400));
			vi.advanceTimersByTime(THROUGHPUT_PUBLISH_MS);
		});
		expect(useThroughputGaugeStore.getState().rates.out).toBeCloseTo(40);
		expect(throughputTracker.sourceCount()).toBe(1);
	});

	it('with scope active, follows an agent switch within one tick', () => {
		vi.useFakeTimers();
		setGaugeSettings({ scope: 'active' });
		setFlag(true);
		render(<ThroughputGaugeHost theme={mockTheme} />);
		const onUsage = listeners.onUsage.mock.calls[0][0];

		act(() => {
			onUsage(AI_TAB_ID, usage({ inputTokens: 1000, outputTokens: 300 }));
			onUsage('agent-2-ai-tab-1', usage({ inputTokens: 500 }));
			vi.advanceTimersByTime(THROUGHPUT_PUBLISH_MS);
		});
		expect(useThroughputGaugeStore.getState().rates.combined).toBeCloseTo(130);

		act(() => {
			useSessionStore.setState({ activeSessionId: 'agent-2' });
			vi.advanceTimersByTime(THROUGHPUT_PUBLISH_MS);
		});

		// One tick later the reading is agent-2's alone, and agent-1's peak is gone.
		const { rates, peak } = useThroughputGaugeStore.getState();
		expect(rates.combined).toBeCloseTo(50);
		expect(peak.combined).toBeCloseTo(50);
		expect(screen.getByTestId('throughput-gauge-caption').textContent).toBe('Frontend');
	});

	describe('remembered geometry', () => {
		const VIEWPORT = { width: 1024, height: 768 };
		const SIZE = GAUGE_DEFAULT_SIZE.single;
		const INITIAL = {
			left: GAUGE_EDGE_MARGIN,
			top: VIEWPORT.height - SIZE.height - GAUGE_INPUT_AREA_CLEARANCE,
			...SIZE,
		};
		const prototype = HTMLElement.prototype as unknown as Record<string, unknown>;
		const originalCapture = {
			set: prototype.setPointerCapture,
			release: prototype.releasePointerCapture,
		};

		/** A pointer event jsdom can dispatch: a MouseEvent carrying a pointer id. */
		function pointer(type: string, clientX: number, clientY: number): MouseEvent {
			const event = new MouseEvent(type, { clientX, clientY, bubbles: true, cancelable: true });
			Object.defineProperty(event, 'pointerId', { value: 1 });
			return event;
		}

		function drag(handle: Element, dx: number, dy: number) {
			act(() => {
				handle.dispatchEvent(pointer('pointerdown', 100, 100));
				window.dispatchEvent(pointer('pointermove', 100 + dx / 2, 100 + dy / 2));
				window.dispatchEvent(pointer('pointermove', 100 + dx, 100 + dy));
			});
		}

		function release() {
			act(() => {
				window.dispatchEvent(pointer('pointerup', 0, 0));
			});
		}

		function setViewport(width: number, height: number) {
			Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
			Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
		}

		function cardRect() {
			const card = screen.getByTestId('floating-throughput-gauge');
			return {
				left: parseFloat(card.style.left),
				top: parseFloat(card.style.top),
				width: parseFloat(card.style.width),
				height: parseFloat(card.style.height),
			};
		}

		function storedRects() {
			const raw = storage.get(THROUGHPUT_GAUGE_RECTS_KEY);
			return raw ? JSON.parse(raw) : undefined;
		}

		beforeEach(() => {
			prototype.setPointerCapture = vi.fn();
			prototype.releasePointerCapture = vi.fn();
			setViewport(VIEWPORT.width, VIEWPORT.height);
			// No custom title strip, so the numbers below are the plain viewport's.
			useSettingsStore.setState({ useNativeTitleBar: true });
			setFlag(true);
		});

		afterEach(() => {
			prototype.setPointerCapture = originalCapture.set;
			prototype.releasePointerCapture = originalCapture.release;
		});

		it('takes focus when the title strip is grabbed, so Escape reaches the card', () => {
			render(<ThroughputGaugeHost theme={mockTheme} />);
			drag(screen.getByTestId('throughput-gauge-drag-handle'), 0, 0);
			release();
			expect(document.activeElement).toBe(screen.getByTestId('floating-throughput-gauge'));
		});

		it('opens bottom-left above the composer with nothing stored', () => {
			render(<ThroughputGaugeHost theme={mockTheme} />);
			expect(cardRect()).toEqual(INITIAL);
		});

		it('persists the rect when a drag ends, not while it moves', () => {
			render(<ThroughputGaugeHost theme={mockTheme} />);

			drag(screen.getByTestId('throughput-gauge-drag-handle'), 100, -50);
			const moved = { ...INITIAL, left: INITIAL.left + 100, top: INITIAL.top - 50 };
			expect(cardRect()).toEqual(moved);
			expect(storedRects()).toBeUndefined();

			release();
			expect(storedRects()).toEqual({ single: moved });
			expect(useThroughputGaugeStore.getState().rects.single).toEqual(moved);
		});

		it('persists the size when a resize from the grip ends', () => {
			render(<ThroughputGaugeHost theme={mockTheme} />);

			drag(screen.getByTestId('modal-resize-grip'), 60, 30);
			release();

			const resized = { ...INITIAL, width: SIZE.width + 60, height: SIZE.height + 30 };
			expect(cardRect()).toEqual(resized);
			expect(storedRects()).toEqual({ single: resized });
		});

		it('restores the remembered rect on remount', () => {
			const first = render(<ThroughputGaugeHost theme={mockTheme} />);
			drag(screen.getByTestId('throughput-gauge-drag-handle'), 200, -100);
			release();
			const saved = cardRect();
			first.unmount();

			render(<ThroughputGaugeHost theme={mockTheme} />);
			expect(cardRect()).toEqual(saved);
		});

		it('clamps a stored rect from a bigger window back into a smaller one', () => {
			useThroughputGaugeStore.setState({
				rects: { single: { left: 1800, top: 1200, width: 300, height: 260 } },
			});
			render(<ThroughputGaugeHost theme={mockTheme} />);

			expect(cardRect()).toEqual({
				left: VIEWPORT.width - GAUGE_CLAMP_MARGIN - 300,
				top: VIEWPORT.height - GAUGE_CLAMP_MARGIN - 260,
				width: 300,
				height: 260,
			});
		});

		it('pulls the card back in when the window shrinks, without overwriting the saved rect', () => {
			const saved = { left: 700, top: 400, ...SIZE };
			useThroughputGaugeStore.setState({ rects: { single: saved } });
			render(<ThroughputGaugeHost theme={mockTheme} />);
			expect(cardRect()).toEqual(saved);

			act(() => {
				setViewport(600, 500);
				window.dispatchEvent(new Event('resize'));
			});

			expect(cardRect()).toEqual({
				left: 600 - GAUGE_CLAMP_MARGIN - SIZE.width,
				top: 500 - GAUGE_CLAMP_MARGIN - SIZE.height,
				...SIZE,
			});
			expect(useThroughputGaugeStore.getState().rects.single).toEqual(saved);
		});

		it('remembers a separate rect for the all-three layout', () => {
			useThroughputGaugeStore.setState({
				rects: { single: { left: 300, top: 200, ...SIZE } },
			});
			setGaugeSettings({ layout: 'all' });
			render(<ThroughputGaugeHost theme={mockTheme} />);

			expect(cardRect()).toEqual({
				left: GAUGE_EDGE_MARGIN,
				top: VIEWPORT.height - GAUGE_DEFAULT_SIZE.all.height - GAUGE_INPUT_AREA_CLEARANCE,
				...GAUGE_DEFAULT_SIZE.all,
			});
		});
	});

	describe('two ways out and focus', () => {
		const card = () => screen.getByTestId('floating-throughput-gauge');

		beforeEach(() => setFlag(true));

		it('labels the close button and names the hotkey in its tooltip', () => {
			render(<ThroughputGaugeHost theme={mockTheme} />);
			const close = screen.getByTestId('throughput-gauge-close');
			expect(close).toHaveAttribute('aria-label', 'Hide throughput gauge');
			expect(close.getAttribute('title')).toMatch(/^Hide gauge \(.+\)$/);
		});

		it('Escape with focus inside the card hides it', () => {
			render(<ThroughputGaugeHost theme={mockTheme} />);
			act(() => card().focus());

			fireEvent.keyDown(card(), { key: 'Escape' });

			expect(screen.queryByTestId('floating-throughput-gauge')).toBeNull();
			expect(useThroughputGaugeStore.getState().visible).toBe(false);
		});

		it('Escape with focus elsewhere leaves the card up', () => {
			render(
				<>
					<textarea data-testid="composer" />
					<ThroughputGaugeHost theme={mockTheme} />
				</>
			);
			const composer = screen.getByTestId('composer');
			act(() => composer.focus());

			fireEvent.keyDown(composer, { key: 'Escape' });

			expect(card()).toBeInTheDocument();
			expect(useThroughputGaugeStore.getState().visible).toBe(true);
		});

		it('Escape with the gear popover open closes only the popover', () => {
			render(<ThroughputGaugeHost theme={mockTheme} />);
			fireEvent.click(screen.getByTestId('throughput-gauge-settings-button'));
			const popover = screen.getByTestId('throughput-gauge-settings');

			fireEvent.keyDown(popover, { key: 'Escape' });

			expect(screen.queryByTestId('throughput-gauge-settings')).toBeNull();
			expect(card()).toBeInTheDocument();
		});

		it('Escape on the frame with the popover open closes the popover first', () => {
			render(<ThroughputGaugeHost theme={mockTheme} />);
			fireEvent.click(screen.getByTestId('throughput-gauge-settings-button'));
			act(() => card().focus());

			fireEvent.keyDown(card(), { key: 'Escape' });
			expect(screen.queryByTestId('throughput-gauge-settings')).toBeNull();
			expect(card()).toBeInTheDocument();

			fireEvent.keyDown(card(), { key: 'Escape' });
			expect(screen.queryByTestId('floating-throughput-gauge')).toBeNull();
		});

		it('showing the card leaves focus in the composer', () => {
			useThroughputGaugeStore.setState({ visible: false });
			render(
				<>
					<textarea data-testid="composer" />
					<ThroughputGaugeHost theme={mockTheme} />
				</>
			);
			const composer = screen.getByTestId('composer');
			act(() => composer.focus());

			act(() => useThroughputGaugeStore.getState().show());

			expect(card()).toBeInTheDocument();
			expect(document.activeElement).toBe(composer);
		});
	});

	describe('desktop window mode', () => {
		type CommandHandler = (command: unknown) => void;
		const maestro = window.maestro as unknown as Record<string, unknown>;
		const originalFloatingWidgets = maestro.floatingWidgets;
		let commandHandlers: Set<CommandHandler>;
		let api: {
			show: ReturnType<typeof vi.fn>;
			hide: ReturnType<typeof vi.fn>;
			publishState: ReturnType<typeof vi.fn>;
			onCommand: ReturnType<typeof vi.fn>;
		};

		/** Send a command to the gauge as its widget window would. */
		function sendCommand(command: unknown) {
			act(() => commandHandlers.forEach((handler) => handler(command)));
		}

		function lastPublished() {
			const calls = api.publishState.mock.calls;
			expect(calls.length).toBeGreaterThan(0);
			const [id, state] = calls[calls.length - 1];
			expect(id).toBe('throughput-gauge');
			return state;
		}

		beforeEach(() => {
			commandHandlers = new Set();
			api = {
				show: vi.fn(async () => true),
				hide: vi.fn(async () => false),
				publishState: vi.fn(),
				onCommand: vi.fn((id: string, handler: CommandHandler) => {
					expect(id).toBe('throughput-gauge');
					commandHandlers.add(handler);
					return () => commandHandlers.delete(handler);
				}),
			};
			maestro.floatingWidgets = api;
		});

		afterEach(() => {
			// Unmount while the fake API is still installed: the host hides its
			// window on unmount, and RTL's own cleanup runs after this hook.
			cleanup();
			maestro.floatingWidgets = originalFloatingWidgets;
		});

		it('draws no in-app card but keeps capturing', () => {
			setFlag(true);
			const { container } = render(<ThroughputGaugeHost theme={mockTheme} />);

			expect(container).toBeEmptyDOMElement();
			expect(screen.queryByTestId('floating-throughput-gauge')).toBeNull();
			expect(listeners.onData).toHaveBeenCalledTimes(1);
		});

		it('does nothing at all while the flag is off', () => {
			render(<ThroughputGaugeHost theme={mockTheme} />);

			expect(api.show).not.toHaveBeenCalled();
			expect(api.hide).not.toHaveBeenCalled();
			expect(api.publishState).not.toHaveBeenCalled();
			expect(api.onCommand).not.toHaveBeenCalled();
		});

		it('publishes the readings, and the active agent name for the active scope', () => {
			vi.useFakeTimers();
			setGaugeSettings({ scope: 'active' });
			setFlag(true);
			render(<ThroughputGaugeHost theme={mockTheme} />);

			expect(lastPublished()).toEqual({
				rates: ZERO,
				peak: ZERO,
				history: { in: [], out: [], combined: [] },
				activeAgentName: 'Backend',
			});

			const onUsage = listeners.onUsage.mock.calls[0][0];
			act(() => {
				onUsage(AI_TAB_ID, usage({ inputTokens: 1000, outputTokens: 300 }));
				vi.advanceTimersByTime(THROUGHPUT_PUBLISH_MS + PUBLISH_INTERVAL_MS);
			});
			const { rates, peak, history } = useThroughputGaugeStore.getState();
			expect(rates.combined).toBeGreaterThan(0);
			expect(lastPublished()).toEqual({ rates, peak, history, activeAgentName: 'Backend' });

			act(() => useSessionStore.setState({ activeSessionId: 'agent-2' }));
			expect((lastPublished() as { activeAgentName: string }).activeAgentName).toBe('Frontend');
		});

		it('publishes no agent name for the all-agents scope', () => {
			setFlag(true);
			render(<ThroughputGaugeHost theme={mockTheme} />);

			expect((lastPublished() as { activeAgentName: unknown }).activeAgentName).toBeNull();
		});

		it('shows and hides the window with the visible latch', () => {
			setFlag(true);
			render(<ThroughputGaugeHost theme={mockTheme} />);
			expect(api.show).toHaveBeenCalledWith('throughput-gauge');

			act(() => useThroughputGaugeStore.getState().hide());
			expect(api.hide).toHaveBeenCalledWith('throughput-gauge');

			api.show.mockClear();
			act(() => useThroughputGaugeStore.getState().show());
			expect(api.show).toHaveBeenCalledWith('throughput-gauge');
		});

		it('keeps a closed window closed at launch, and opens it on a mid-session flip', () => {
			useThroughputGaugeStore.setState({ visible: false });
			setFlag(true);
			const first = render(<ThroughputGaugeHost theme={mockTheme} />);
			expect(api.show).not.toHaveBeenCalled();
			expect(api.hide).toHaveBeenCalledWith('throughput-gauge');
			first.unmount();

			setFlag(false);
			api.hide.mockClear();
			render(<ThroughputGaugeHost theme={mockTheme} />);
			act(() => setFlag(true));
			expect(api.show).toHaveBeenCalledWith('throughput-gauge');
		});

		it('the hide command goes through the store latch', () => {
			setFlag(true);
			render(<ThroughputGaugeHost theme={mockTheme} />);

			sendCommand({ type: 'hide' });

			expect(useThroughputGaugeStore.getState().visible).toBe(false);
			expect(storage.get(THROUGHPUT_GAUGE_VISIBLE_KEY)).toBe('false');
			expect(api.hide).toHaveBeenCalledWith('throughput-gauge');
		});

		it('the reset-peak command restarts the peak from the current reading', () => {
			setFlag(true);
			render(<ThroughputGaugeHost theme={mockTheme} />);
			const rates = { in: 5, out: 3, combined: 8 };
			act(() =>
				useThroughputGaugeStore.setState({ rates, peak: { in: 50, out: 30, combined: 80 } })
			);

			sendCommand({ type: 'reset-peak' });

			expect(useThroughputGaugeStore.getState().peak).toEqual(rates);
		});

		it('ignores a command it does not know', () => {
			setFlag(true);
			render(<ThroughputGaugeHost theme={mockTheme} />);

			sendCommand({ type: 'explode' });
			sendCommand('hide');

			expect(useThroughputGaugeStore.getState().visible).toBe(true);
		});

		it('turning the flag off hides the window and drops the command listener', () => {
			setFlag(true);
			render(<ThroughputGaugeHost theme={mockTheme} />);
			expect(commandHandlers.size).toBe(1);
			api.hide.mockClear();

			act(() => setFlag(false));

			expect(api.hide).toHaveBeenCalledWith('throughput-gauge');
			expect(commandHandlers.size).toBe(0);
			// The user's latch is untouched: the window comes back if the feature does.
			expect(useThroughputGaugeStore.getState().visible).toBe(true);
		});
	});
});
