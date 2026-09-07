/**
 * Tests for RetryCountdownBanner - the live countdown shown above the composer
 * while an Agent Resilience auto-retry is pending for the active tab.
 *
 * Renders against real retryStore state (set directly) so the label, countdown
 * text, and firing state are exercised end-to-end. Cancel is asserted via its
 * store side effect; Retry now is covered by the retryStore engine tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RetryCountdownBanner } from '../../../renderer/components/RetryCountdownBanner';
import { useRetryStore, getRetryEntry } from '../../../renderer/stores/retryStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import { mockTheme } from '../../helpers/mockTheme';
import type { RetryEntry } from '../../../renderer/stores/retryStore';

const NOW = new Date('2026-01-01T00:00:00Z').getTime();

function setEntry(partial: Partial<RetryEntry>) {
	const entry: RetryEntry = {
		sessionId: 's1',
		tabId: 't1',
		key: 's1:t1',
		strategy: 'availability',
		mode: 'resend',
		status: 'scheduled',
		attempt: 0,
		nextRetryAt: NOW + 90_000,
		lastMessage: 'API Error: 529 Overloaded',
		...partial,
	};
	useRetryStore.setState({ retries: { 's1:t1': entry } });
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	useRetryStore.setState({ retries: {} });
	useSessionStore.setState({ sessions: [] } as never);
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

describe('RetryCountdownBanner', () => {
	it('renders nothing when there is no active retry for the tab', () => {
		const { container } = render(
			<RetryCountdownBanner sessionId="s1" tabId="t1" theme={mockTheme} />
		);
		expect(container.firstChild).toBeNull();
	});

	it('renders nothing when tabId is undefined', () => {
		setEntry({});
		const { container } = render(
			<RetryCountdownBanner sessionId="s1" tabId={undefined} theme={mockTheme} />
		);
		expect(container.firstChild).toBeNull();
	});

	it('shows the availability label and a live countdown while scheduled', () => {
		setEntry({ strategy: 'availability', nextRetryAt: NOW + 90_000 });
		render(<RetryCountdownBanner sessionId="s1" tabId="t1" theme={mockTheme} />);

		expect(screen.getByText('Service overloaded.')).toBeInTheDocument();
		expect(screen.getByText(/Auto-retrying in 1m 30s/)).toBeInTheDocument();
	});

	it('shows the token-exhaustion label and the attempt number after the first retry', () => {
		setEntry({ strategy: 'token-exhaustion', attempt: 2, nextRetryAt: NOW + 5_000 });
		render(<RetryCountdownBanner sessionId="s1" tabId="t1" theme={mockTheme} />);

		expect(screen.getByText('Plan quota exhausted.')).toBeInTheDocument();
		// attempt is 0-indexed internally; the banner shows the human 1-based number.
		expect(screen.getByText(/Auto-retrying in 5s \(attempt 3\)/)).toBeInTheDocument();
	});

	it('shows "Retrying now…" once the entry is in-flight', () => {
		setEntry({ status: 'in-flight' });
		render(<RetryCountdownBanner sessionId="s1" tabId="t1" theme={mockTheme} />);
		expect(screen.getByText('Retrying now…')).toBeInTheDocument();
	});

	it('Cancel removes the retry entry', () => {
		setEntry({});
		render(<RetryCountdownBanner sessionId="s1" tabId="t1" theme={mockTheme} />);

		fireEvent.click(screen.getByTitle('Cancel auto-retry'));
		expect(getRetryEntry('s1', 't1')).toBeUndefined();
	});

	// Messages sent during the countdown queue behind the retry instead of
	// burning against the same wall. The banner is where the user is looking, so
	// it has to say the messages are held rather than gone.
	it('names how many messages are queued behind the retry', () => {
		useSessionStore.setState({
			sessions: [
				createMockSession({
					id: 's1',
					activeTabId: 't1',
					aiTabs: [createMockAITab({ id: 't1' })],
					executionQueue: [
						{ id: 'q1', timestamp: NOW, tabId: 't1', type: 'message', text: 'a' },
						{ id: 'q2', timestamp: NOW, tabId: 't1', type: 'message', text: 'b' },
					],
				}),
			],
		} as never);
		setEntry({});
		render(<RetryCountdownBanner sessionId="s1" tabId="t1" theme={mockTheme} />);

		expect(screen.getByText(/2 messages queued behind it/)).toBeInTheDocument();
	});

	it('counts only the items bound for this tab, and says nothing when there are none', () => {
		useSessionStore.setState({
			sessions: [
				createMockSession({
					id: 's1',
					activeTabId: 't1',
					aiTabs: [createMockAITab({ id: 't1' }), createMockAITab({ id: 't2' })],
					executionQueue: [
						{ id: 'q1', timestamp: NOW, tabId: 't2', type: 'message', text: 'other tab' },
					],
				}),
			],
		} as never);
		setEntry({});
		render(<RetryCountdownBanner sessionId="s1" tabId="t1" theme={mockTheme} />);

		expect(screen.queryByText(/queued behind it/)).not.toBeInTheDocument();
	});
});
