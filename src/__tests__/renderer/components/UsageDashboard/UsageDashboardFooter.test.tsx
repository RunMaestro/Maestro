/**
 * Tests for the Usage Dashboard footer and its summary publish/consume wiring.
 *
 * Verifies:
 * - The three footer slots still render (range label, db size, Esc hint)
 * - A panel-published summary beats the modal's fallback for the same tab
 * - Summaries are keyed by tab, so an outgoing panel's unmount cleanup cannot
 *   erase the summary the incoming tab just published
 * - A panel that unmounts (tab switch, dashboard close) leaves nothing behind
 */

import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UsageDashboardFooter } from '../../../../renderer/components/UsageDashboard/UsageDashboardFooter';
import {
	useFooterSummaryStore,
	usePublishFooterSummary,
} from '../../../../renderer/components/UsageDashboard/useFooterSummary';
import type { FooterSummaryTab } from '../../../../renderer/components/UsageDashboard/footerSummary';
import { THEMES } from '../../../../shared/themes';

const theme = THEMES['dracula'];

function Publisher({ tab, summary }: { tab: FooterSummaryTab; summary: string | null }) {
	usePublishFooterSummary(tab, summary);
	return null;
}

function Footer({
	viewMode = 'agents',
	fallbackSummary = null,
	databaseSizeLabel = null,
}: {
	viewMode?: FooterSummaryTab;
	fallbackSummary?: string | null;
	databaseSizeLabel?: string | null;
}) {
	return (
		<UsageDashboardFooter
			theme={theme}
			viewMode={viewMode}
			rangeLabel="Showing this month data"
			fallbackSummary={fallbackSummary}
			databaseSizeLabel={databaseSizeLabel}
		/>
	);
}

// The store is module-level (per renderer process), so a summary left behind by
// one test would leak into the next.
beforeEach(() => {
	useFooterSummaryStore.setState({ summaries: {} });
});

describe('UsageDashboardFooter', () => {
	it('renders the range label, database size, and escape hint', () => {
		render(<Footer databaseSizeLabel="8.6 MB" />);

		expect(screen.getByText('Showing this month data')).toBeInTheDocument();
		expect(screen.getByTestId('database-size-indicator')).toHaveTextContent('8.6 MB');
		expect(screen.getByText('Press Esc to close')).toBeInTheDocument();
	});

	it('omits the database chip when the size is unknown', () => {
		render(<Footer databaseSizeLabel={null} />);

		expect(screen.queryByTestId('database-size-indicator')).not.toBeInTheDocument();
	});

	it('renders no center slot when the tab has nothing to say', () => {
		// A row of zeroes is worse than an empty slot.
		render(<Footer fallbackSummary={null} />);

		expect(screen.queryByTestId('usage-dashboard-footer-summary')).not.toBeInTheDocument();
	});

	it('shows the modal fallback when no panel has published', () => {
		render(<Footer viewMode="overview" fallbackSummary="2.1K queries · 84 agents" />);

		expect(screen.getByTestId('usage-dashboard-footer-summary')).toHaveTextContent(
			'2.1K queries · 84 agents'
		);
	});

	it('prefers a panel-published summary over the modal fallback', () => {
		// The panel owns the filter state; the modal cannot see it.
		render(
			<>
				<Publisher tab="agents" summary="24 of 84 agents" />
				<Footer viewMode="agents" fallbackSummary="84 agents" />
			</>
		);

		expect(screen.getByTestId('usage-dashboard-footer-summary')).toHaveTextContent(
			'24 of 84 agents'
		);
	});

	it('falls through to the fallback when the panel publishes null', () => {
		render(
			<>
				<Publisher tab="agents" summary={null} />
				<Footer viewMode="agents" fallbackSummary="84 agents" />
			</>
		);

		expect(screen.getByTestId('usage-dashboard-footer-summary')).toHaveTextContent('84 agents');
	});

	it('ignores a summary published for a different tab', () => {
		render(
			<>
				<Publisher tab="cue" summary="126 runs · 8 failed" />
				<Footer viewMode="agents" fallbackSummary="84 agents" />
			</>
		);

		expect(screen.getByTestId('usage-dashboard-footer-summary')).toHaveTextContent('84 agents');
	});

	it('survives the mount-before-unmount order of a tab switch', () => {
		// React mounts the incoming panel before unmounting the outgoing one. A
		// single "latest publisher wins" slot would let the outgoing panel's
		// cleanup erase the summary the new tab just wrote; keying by tab means
		// a panel can only ever clear its own entry.
		const { rerender } = render(
			<>
				<Publisher tab="cue" summary="126 runs · 8 failed" />
				<Footer viewMode="cue" />
			</>
		);

		expect(screen.getByTestId('usage-dashboard-footer-summary')).toHaveTextContent('126 runs');

		rerender(
			<>
				<Publisher tab="shortcuts" summary="1.2K presses · Virtuoso" />
				<Footer viewMode="shortcuts" />
			</>
		);

		expect(screen.getByTestId('usage-dashboard-footer-summary')).toHaveTextContent(
			'1.2K presses · Virtuoso'
		);
	});

	it('clears a summary when its publisher unmounts', () => {
		const { rerender } = render(
			<>
				<Publisher tab="agents" summary="24 of 84 agents" />
				<Footer viewMode="agents" fallbackSummary="84 agents" />
			</>
		);

		expect(screen.getByTestId('usage-dashboard-footer-summary')).toHaveTextContent(
			'24 of 84 agents'
		);

		rerender(<Footer viewMode="agents" fallbackSummary="84 agents" />);

		expect(screen.getByTestId('usage-dashboard-footer-summary')).toHaveTextContent('84 agents');
		// Closing the dashboard must not leave the next open showing stale counts.
		expect(useFooterSummaryStore.getState().summaries.agents).toBeUndefined();
	});

	it('publishes from a panel rendered standalone without throwing', () => {
		// Panels are unit-tested outside the dashboard; publishing must be safe there.
		expect(() => render(<Publisher tab="agents" summary="24 of 84 agents" />)).not.toThrow();
		expect(useFooterSummaryStore.getState().summaries.agents).toBe('24 of 84 agents');
	});
});
