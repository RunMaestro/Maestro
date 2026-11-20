/**
 * Tests for DelegationGraphLegend - what the lines, badges and borders mean,
 * and how much of each is on the graph.
 */

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { DelegationGraphLegend } from '../../../../renderer/components/DelegationGraph/DelegationGraphLegend';
import { DELEGATION_EDGE_LINES } from '../../../../renderer/components/DelegationGraph/edges/DelegationEdge';
import { AGENT_DELEGATION_NODE_BORDER_STYLE } from '../../../../renderer/components/DelegationGraph/nodes/AgentDelegationNode';
import type { DelegationGraphStats } from '../../../../shared/delegationGraph';
import { mockTheme } from '../../../helpers/mockTheme';

const STATS: DelegationGraphStats = {
	agents: 6,
	edges: 4,
	mutual: 1,
	isolated: 2,
	spill: 1,
	placed: 0,
};

describe('DelegationGraphLegend', () => {
	it('exposes the shared shortcuts as clickable controls', () => {
		const onCycleLayout = vi.fn();
		const onFit = vi.fn();
		const onToggleScroll = vi.fn();
		const onIncreaseSpacing = vi.fn();
		const onDecreaseSpacing = vi.fn();
		render(
			<DelegationGraphLegend
				theme={mockTheme}
				stats={STATS}
				onClose={vi.fn()}
				onCycleLayout={onCycleLayout}
				onFit={onFit}
				onToggleScroll={onToggleScroll}
				onIncreaseSpacing={onIncreaseSpacing}
				onDecreaseSpacing={onDecreaseSpacing}
			/>
		);
		const shortcuts = within(screen.getByRole('region', { name: 'Legend' }));
		for (const label of [
			'Cycle layout',
			'Fit graph',
			'Switch scroll mode',
			'More spacing',
			'Less spacing',
		]) {
			fireEvent.click(shortcuts.getByRole('button', { name: new RegExp(label) }));
		}
		for (const handler of [
			onCycleLayout,
			onFit,
			onToggleScroll,
			onIncreaseSpacing,
			onDecreaseSpacing,
		]) {
			expect(handler).toHaveBeenCalledTimes(1);
		}
	});

	it('describes cluster navigation without showing editor-only node states in View', () => {
		render(<DelegationGraphLegend theme={mockTheme} stats={STATS} onClose={vi.fn()} mode="view" />);
		expect(screen.getByText(/Double-click an agent/)).toBeInTheDocument();
		expect(
			screen.getByTestId('delegation-graph-legend').querySelector('[data-node-state]')
		).toBeNull();
	});
	const renderLegend = (onClose = vi.fn()) => {
		render(<DelegationGraphLegend theme={mockTheme} stats={STATS} onClose={onClose} />);
		return onClose;
	};

	// The samples come from the table the canvas draws from, so the legend
	// cannot show a line the graph does not use.
	it('draws one sample per kind of edge, with the line and the badge of that kind', () => {
		renderLegend();
		const legend = screen.getByTestId('delegation-graph-legend');

		for (const kind of ['consult', 'delegate', 'both'] as const) {
			const row = legend.querySelector(`li[data-edge-kind="${kind}"]`) as HTMLElement;
			const line = row.querySelector('line') as SVGLineElement;
			expect(line.getAttribute('stroke-width')).toBe(String(DELEGATION_EDGE_LINES[kind].width));
			expect(line.getAttribute('stroke-dasharray')).toBe(DELEGATION_EDGE_LINES[kind].dash ?? null);
			expect(within(row).getByTestId('delegation-edge-badge')).toHaveAttribute(
				'data-edge-kind',
				kind
			);
		}
	});

	it('draws one sample per agent state, with the border of that state', () => {
		renderLegend();
		const legend = screen.getByTestId('delegation-graph-legend');

		for (const state of ['in-scope', 'spill', 'isolated', 'placed'] as const) {
			const sample = legend.querySelector(`li[data-node-state="${state}"] > span`) as HTMLElement;
			expect(sample.style.borderStyle).toBe(AGENT_DELEGATION_NODE_BORDER_STYLE[state]);
		}
	});

	// Spill and placed share a border, so the sample needs a second sign.
	it('tells the placed sample from the spill sample by opacity and a glyph', () => {
		renderLegend();
		const legend = screen.getByTestId('delegation-graph-legend');
		const sampleOf = (state: string) =>
			legend.querySelector(`li[data-node-state="${state}"] > span`) as HTMLElement;

		expect(Number(sampleOf('spill').style.opacity)).toBeLessThan(1);
		expect(sampleOf('placed').style.opacity).toBe('1');
		expect(sampleOf('placed').querySelector('svg')).not.toBeNull();
		expect(sampleOf('spill').querySelector('svg')).toBeNull();
	});

	// The Peers tab writes the two bits as R and W; an edge writes them as C and D.
	it('ties the edge letters to the letters on the Peers tab', () => {
		renderLegend();
		const text = screen.getByTestId('delegation-graph-legend').textContent ?? '';

		expect(text).toMatch(/C is consult, the R box/);
		expect(text).toMatch(/D is delegate,\s*the W box/);
	});

	it('shows the counts', () => {
		renderLegend();
		expect(screen.getByTestId('delegation-graph-stats')).toHaveTextContent('6 agents, 4 edges');
		expect(screen.getByTestId('delegation-graph-stats')).toHaveTextContent('2 with no peers');
	});

	it('closes from its own button', () => {
		const onClose = renderLegend();
		fireEvent.click(screen.getByRole('button', { name: 'Hide the legend' }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
