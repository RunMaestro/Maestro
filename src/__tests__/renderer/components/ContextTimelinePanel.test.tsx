/**
 * Tests for ContextTimelinePanel
 *
 * Focus: the over-limit rendering contract (finding R1). Every row's label, bar
 * width and color derive from ONE value - computeOverLimitDisplay over that
 * row's stored contextTokens/contextWindow - so a row that breached the window
 * still reads its true percentage instead of collapsing to "~" or a clamped
 * full-width 100% bar.
 *
 * Deliberately provider-agnostic: rows are seeded from explicit token/window
 * pairs, never from "provider X produces over-limit rows".
 */

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContextTimelinePanel } from '../../../renderer/components/ContextTimelinePanel';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import {
	useContextTimelineStore,
	type ContextTimelinePointInput,
} from '../../../renderer/stores/contextTimelineStore';
import { computeOverLimitDisplay } from '../../../renderer/utils/contextUsage';
import type { Theme } from '../../../renderer/types';

vi.mock('lucide-react', () => ({
	Gauge: () => <svg data-testid="gauge-icon" />,
	Minus: () => <svg data-testid="minus-icon" />,
	X: () => <svg data-testid="x-icon" />,
	Trash2: () => <svg data-testid="trash-icon" />,
	BarChart3: () => <svg data-testid="bar-icon" />,
	LineChart: () => <svg data-testid="line-icon" />,
}));

const testTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1e1e1e',
		bgSidebar: '#252526',
		bgActivity: '#333333',
		textMain: '#d4d4d4',
		textDim: '#808080',
		accent: '#007acc',
		accentForeground: '#ffffff',
		border: '#404040',
		error: '#f14c4c',
		warning: '#cca700',
		success: '#89d185',
	},
};

const SID = 'session-timeline';
const WINDOW = 200_000;

function pt(overrides: Partial<ContextTimelinePointInput> = {}): ContextTimelinePointInput {
	return {
		tabId: 'tab-a',
		inputTokens: 100,
		outputTokens: 20,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		reasoningTokens: 0,
		totalCostUsd: 0,
		contextTokens: 100_000,
		contextWindow: WINDOW,
		percentage: 50,
		...overrides,
	};
}

function reset() {
	useContextTimelineStore.setState({
		panelSessionId: null,
		minimized: false,
		view: 'bar',
		anchorRect: null,
		buffers: {},
	});
}

/** Seed points (oldest first) and open the panel for them. */
function seed(points: ContextTimelinePointInput[]) {
	const store = useContextTimelineStore.getState();
	store.openPanel(SID);
	for (const p of points) store.appendPoint(SID, p);
}

function renderPanel() {
	return render(
		<LayerStackProvider>
			<ContextTimelinePanel theme={testTheme} />
		</LayerStackProvider>
	);
}

/** Fill-bar widths in render order (newest first, as the panel displays them). */
function fillWidths(): string[] {
	return screen.getAllByTestId('timeline-bar-fill').map((el) => (el as HTMLElement).style.width);
}

/**
 * Row labels in render order. The label is assembled from several JSX text
 * nodes, so it is read off the element rather than matched with getByText.
 */
function rowLabels(): HTMLElement[] {
	return screen.getAllByTestId('timeline-row-label') as HTMLElement[];
}

function labelTexts(): string[] {
	return rowLabels().map((el) => el.textContent ?? '');
}

/** The single row whose label contains `needle`. */
function rowLabel(needle: string): HTMLElement {
	const match = rowLabels().filter((el) => (el.textContent ?? '').includes(needle));
	expect(match).toHaveLength(1);
	return match[0];
}

describe('ContextTimelinePanel over-limit rendering', () => {
	beforeEach(reset);

	// Under, exactly at, and over the window. The store's own `percentage` is
	// null for the over-limit point, exactly as useAgentUsageListener records it.
	const UNDER = pt({ contextTokens: 100_000, percentage: 50 });
	const AT = pt({ contextTokens: WINDOW, percentage: 100 });
	const OVER = pt({ contextTokens: 310_000, percentage: null });

	it('labels each row with its true percentage, including past 100%', () => {
		seed([UNDER, AT, OVER]);
		renderPanel();

		// Newest first. The 155% row used to render "~" beside a capped "200k+".
		expect(labelTexts()).toEqual([
			'155% · 310.0K / 200.0K',
			'100% · 200.0K / 200.0K',
			'50% · 100.0K / 200.0K',
		]);
	});

	it('sizes every fill bar from computeOverLimitDisplay against the shared scale', () => {
		seed([UNDER, AT, OVER]);
		renderPanel();

		// Per-panel headroom scale: max(window, peak tokens) = 310k.
		const scaleMax = 310_000;
		// Newest first.
		const expected = [OVER, AT, UNDER].map((p) => {
			const d = computeOverLimitDisplay(p.contextTokens, p.contextWindow, scaleMax);
			return `${Math.max(d.fillFraction * 100, 2)}%`;
		});

		expect(fillWidths()).toEqual(expected);
		// The point of the headroom scale: the bars are no longer all full width.
		expect(fillWidths()[0]).toBe('100%');
		expect(fillWidths()[1]).not.toBe('100%');
		expect(fillWidths()[2]).not.toBe('100%');
	});

	it('renders the 100% tick only when a turn exceeded the window', () => {
		seed([UNDER, AT]);
		const { unmount } = renderPanel();
		expect(screen.queryAllByTestId('timeline-limit-tick')).toHaveLength(0);
		unmount();

		reset();
		seed([UNDER, AT, OVER]);
		renderPanel();
		const ticks = screen.getAllByTestId('timeline-limit-tick');
		expect(ticks).toHaveLength(3);
		// window / scaleMax = 200k / 310k.
		expect((ticks[0] as HTMLElement).style.left).toBe(`${(200_000 / 310_000) * 100}%`);
	});

	// Review of PR #1364, flagged independently by both bots. The scale was
	// seeded from the LATEST window only, and one shared tick was drawn from it,
	// while each row divides by its OWN stored window. A mid-session window
	// change therefore contradicted the labels - exactly what Decision 3 says
	// must not happen.
	describe('mixed windows across turns', () => {
		// An older, roomier turn (800k of 1M) followed by a turn recorded after
		// the window shrank to 200k.
		const OLD_BIG = pt({ id: 'old', contextTokens: 800_000, contextWindow: 1_000_000 });
		const NEW_SMALL = pt({ id: 'new', contextTokens: 100_000, contextWindow: 200_000 });

		it('does not draw an under-limit row at full width', () => {
			seed([OLD_BIG, NEW_SMALL]);
			renderPanel();

			// Scale is max over tokens AND windows = 1M, so the 800k row fills 80%.
			// Seeding from the latest window alone made the scale 800k and drew this
			// 80% row as a full bar.
			expect(labelTexts()).toEqual(['50% · 100.0K / 200.0K', '80% · 800.0K / 1.0M']);
			expect(fillWidths()).toEqual(['10%', '80%']);
		});

		it('places each row 100% tick at that row own window', () => {
			seed([OLD_BIG, NEW_SMALL]);
			renderPanel();

			// Only ONE tick: the 1M row's limit IS the scale maximum, so it has no
			// headroom beyond it and correctly draws none. The 200k row does.
			const ticks = screen.getAllByTestId('timeline-limit-tick');
			expect(ticks).toHaveLength(1);
			// 200k/1M = 20%. The old shared tick used the latest window over a
			// latest-seeded scale and would have put it at 100%.
			expect((ticks[0] as HTMLElement).style.left).toBe(`${(200_000 / 1_000_000) * 100}%`);
		});
	});

	it('colors an over-limit row with the error color and an under-limit row with success', () => {
		seed([UNDER, OVER]);
		renderPanel();

		expect(rowLabel('155%')).toHaveStyle({ color: testTheme.colors.error });
		expect(rowLabel('50%')).toHaveStyle({ color: testTheme.colors.success });
	});

	it('explains an over-limit row without claiming what the tokens measure', () => {
		seed([OVER]);
		const { unmount } = renderPanel();

		expect(rowLabel('155%')).toHaveAttribute(
			'title',
			'Over the context limit: 310.0K against a 200.0K window'
		);
		unmount();

		// An in-window row carries no such note.
		reset();
		seed([UNDER]);
		renderPanel();
		expect(rowLabel('50%')).not.toHaveAttribute('title');
	});

	it('keeps "~" only when a point has no window to divide by', () => {
		seed([pt({ contextTokens: 12_000, contextWindow: 0, percentage: null })]);
		renderPanel();

		expect(labelTexts()).toEqual(['~ · 12.0K']);
	});

	it('shows the newest turn true percentage in the panel header past 100%', () => {
		seed([UNDER, OVER]);
		renderPanel();

		expect(screen.getByTitle('Latest context fill')).toHaveTextContent('155%');
	});
});

/**
 * Task 5 / 5b: the empty-state copy is held back until the backfill has
 * answered, and the bar/graph toggle switches views without either view
 * recomputing its own percentages.
 */
describe('ContextTimelinePanel view toggle and empty state', () => {
	beforeEach(reset);

	it('shows a loading line, not the empty copy, before hydration has answered', () => {
		useContextTimelineStore.getState().openPanel(SID);
		renderPanel();

		expect(screen.getByText(/Loading recorded history/)).toBeInTheDocument();
		expect(screen.queryByText(/No usage recorded yet for this agent/)).not.toBeInTheDocument();
	});

	it('shows the approved empty copy once hydration returned nothing', () => {
		useContextTimelineStore.getState().openPanel(SID);
		useContextTimelineStore.getState().hydrateSession(SID, [], false);
		renderPanel();

		expect(
			screen.getByText(
				'No usage recorded yet for this agent. The timeline fills as the agent takes turns, and it does not survive an app restart.'
			)
		).toBeInTheDocument();
	});

	it('defaults to the bar list', () => {
		seed([pt()]);
		renderPanel();

		expect(screen.getAllByTestId('timeline-bar-fill').length).toBe(1);
		expect(screen.queryByTestId('timeline-graph')).not.toBeInTheDocument();
		expect(screen.getByTestId('timeline-view-bar')).toHaveAttribute('aria-pressed', 'true');
	});

	it('switches to the graph and back, and the choice persists in the store', () => {
		seed([pt(), pt({ contextTokens: 150_000, percentage: 75 })]);
		const { unmount } = renderPanel();

		fireEvent.click(screen.getByTestId('timeline-view-graph'));
		expect(screen.getByTestId('timeline-graph')).toBeInTheDocument();
		expect(screen.queryAllByTestId('timeline-bar-fill')).toHaveLength(0);
		expect(useContextTimelineStore.getState().view).toBe('graph');

		// Closing and reopening the panel keeps the chosen view.
		unmount();
		renderPanel();
		expect(screen.getByTestId('timeline-graph')).toBeInTheDocument();

		fireEvent.click(screen.getByTestId('timeline-view-bar'));
		expect(screen.queryByTestId('timeline-graph')).not.toBeInTheDocument();
		expect(useContextTimelineStore.getState().view).toBe('bar');
	});

	it('plots the graph from the same per-point value as the bars, over-limit included', () => {
		// Peak 310K against a 200K window, so the shared scale is 310K.
		seed([
			pt({ contextTokens: 100_000, percentage: 50 }),
			pt({ contextTokens: 310_000, percentage: null }),
		]);
		renderPanel();
		fireEvent.click(screen.getByTestId('timeline-view-graph'));

		const segments = screen.getAllByTestId('timeline-graph-segment');
		expect(segments).toHaveLength(1);
		const scaleMax = 310_000;
		const expected = [100_000, 310_000]
			.map((tokens) => computeOverLimitDisplay(tokens, WINDOW, scaleMax).fillFraction)
			.map((f, i) => `${i === 0 ? 0 : 100},${100 - f * 100}`)
			.join(' ');
		expect(segments[0].getAttribute('points')).toBe(expected);
		// And the readout carries the same figures the bar row's label would.
		expect(screen.getByTestId('timeline-graph-readout')).toHaveTextContent(
			'155% · 310.0K / 200.0K'
		);
	});

	it('breaks the line at a turn with no window instead of plotting it as zero', () => {
		seed([
			pt({ contextTokens: 100_000, percentage: 50 }),
			pt({ contextTokens: 12_000, contextWindow: 0, percentage: null }),
			pt({ contextTokens: 150_000, percentage: 75 }),
		]);
		renderPanel();
		fireEvent.click(screen.getByTestId('timeline-view-graph'));

		// Two one-point runs either side of the gap, never a single line through it.
		const segments = screen.getAllByTestId('timeline-graph-segment');
		expect(segments).toHaveLength(2);
		expect(segments[0].getAttribute('points')?.split(' ')).toHaveLength(1);
		expect(segments[1].getAttribute('points')?.split(' ')).toHaveLength(1);
	});

	it('draws the 100% reference line in the graph', () => {
		seed([pt()]);
		renderPanel();
		fireEvent.click(screen.getByTestId('timeline-view-graph'));

		expect(screen.getByTestId('timeline-graph-limit-line')).toBeInTheDocument();
	});

	// Review of PR #1365 (Greptile). One flat line drawn from the LATEST window
	// judged earlier turns against a limit that was not theirs: an 80%-of-1M turn
	// rendered above a line representing a later 200k window.
	it('steps the graph limit line when the window changed mid-session', () => {
		seed([
			pt({ id: 'old', contextTokens: 800_000, contextWindow: 1_000_000 }),
			pt({ id: 'new', contextTokens: 100_000, contextWindow: 200_000 }),
		]);
		renderPanel();
		fireEvent.click(screen.getByTestId('timeline-view-graph'));

		const d = screen.getByTestId('timeline-graph-limit-line').getAttribute('d') ?? '';
		// scaleMax is 1M, so the 1M limit sits at y=0 and the 200k one at y=80.
		// Two distinct heights: the line has to move where the window moved.
		expect(d).toContain('0');
		expect(d).toContain('80');
		// A flat line would name exactly one y value.
		const ys = new Set((d.match(/-?\d+(\.\d+)?/g) ?? []).filter((_, i) => i % 2 === 1));
		expect(ys.size).toBeGreaterThan(1);
	});

	it('shows a hovered turn figures instead of the latest', () => {
		seed([
			pt({ contextTokens: 100_000, percentage: 50 }),
			pt({ contextTokens: 150_000, percentage: 75 }),
		]);
		renderPanel();
		fireEvent.click(screen.getByTestId('timeline-view-graph'));

		expect(screen.getByTestId('timeline-graph-readout')).toHaveTextContent('75% · 150.0K / 200.0K');
		fireEvent.mouseEnter(screen.getAllByTestId('timeline-graph-hit')[0]);
		expect(screen.getByTestId('timeline-graph-readout')).toHaveTextContent('50% · 100.0K / 200.0K');
	});
});
