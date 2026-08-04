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
import { render, screen } from '@testing-library/react';
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
