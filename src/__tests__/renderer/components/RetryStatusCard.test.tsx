/**
 * Tests for RetryStatusCard - the collapsed Agent Resilience "outage" bubble that
 * renders inline in the transcript (replacing the above-composer countdown banner).
 *
 * Driven entirely by the persistent `retryStore.outages[outageId]` record, so the
 * tests set that record directly and assert the card's four states: active (live
 * stats + controls), recovered, stopped, and the no-record fallback.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RetryStatusCard } from '../../../renderer/components/RetryStatusCard';
import { useRetryStore } from '../../../renderer/stores/retryStore';
import { mockTheme } from '../../helpers/mockTheme';
import type { OutageRecord } from '../../../renderer/stores/retryStore';

const NOW = new Date('2026-01-01T00:00:00Z').getTime();

function setOutage(partial: Partial<OutageRecord> = {}) {
	const outage: OutageRecord = {
		outageId: 'o1',
		sessionId: 's1',
		tabId: 't1',
		strategy: 'availability',
		startedAt: NOW,
		attempts: 0,
		nextRetryAt: NOW + 90_000,
		status: 'active',
		lastMessage: 'API Error: 529 Overloaded',
		...partial,
	};
	useRetryStore.setState({ outages: { o1: outage } });
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	useRetryStore.setState({ retries: {}, outages: {} });
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

describe('RetryStatusCard', () => {
	it('renders nothing when the outage record is gone and no fallback is given', () => {
		const { container } = render(<RetryStatusCard outageId="missing" theme={mockTheme} />);
		expect(container.firstChild).toBeNull();
	});

	it('falls back to the marker text when the outage record is gone (post-restart)', () => {
		render(<RetryStatusCard outageId="missing" theme={mockTheme} fallbackText="Old outage note" />);
		expect(screen.getByText('Old outage note')).toBeInTheDocument();
	});

	it('shows the availability label, live stats, and controls for an active outage', () => {
		setOutage({ strategy: 'availability', attempts: 2, nextRetryAt: NOW + 90_000 });
		render(<RetryStatusCard outageId="o1" theme={mockTheme} />);

		expect(screen.getByText('Service overloaded')).toBeInTheDocument();
		// Retry count stat reflects the dispatched-so-far count.
		expect(screen.getByText('2')).toBeInTheDocument();
		expect(screen.getByText(/in 1m 30s/)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /Try now/ })).toBeEnabled();
		expect(screen.getByRole('button', { name: /Stop/ })).toBeInTheDocument();
	});

	it('disables "Try now" and shows "now…" once the timer has fired', () => {
		setOutage({ nextRetryAt: NOW - 1_000 });
		render(<RetryStatusCard outageId="o1" theme={mockTheme} />);

		expect(screen.getByText('now…')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /Try now/ })).toBeDisabled();
	});

	it('freezes into a recovered summary with a pluralized retry count', () => {
		setOutage({
			status: 'recovered',
			attempts: 1,
			startedAt: NOW,
			resolvedAt: NOW + 5_000,
		});
		render(<RetryStatusCard outageId="o1" theme={mockTheme} />);

		expect(screen.getByText('Connection recovered.')).toBeInTheDocument();
		expect(screen.getByText(/cleared after 1 retry over 5s/)).toBeInTheDocument();
		// No live controls once resolved.
		expect(screen.queryByRole('button', { name: /Try now/ })).not.toBeInTheDocument();
	});

	it('freezes into a stopped summary', () => {
		setOutage({ status: 'stopped', attempts: 3, strategy: 'token-exhaustion' });
		render(<RetryStatusCard outageId="o1" theme={mockTheme} />);

		expect(screen.getByText('Auto-retry stopped.')).toBeInTheDocument();
		expect(
			screen.getByText(/Plan quota exhausted was not resolved after 3 retries/)
		).toBeInTheDocument();
	});
});
