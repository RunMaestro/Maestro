/**
 * Tests for ClaudePlanUsage
 *
 * Covers:
 *   - empty state when no snapshots are cached
 *   - multi-row rendering with the same account-short-name derivation as the badge
 *     (incl. the `.claude` → `default` fallback)
 *   - bars render with progressbar role + accessible percentage
 *   - refresh button calls the IPC and triggers a store refresh
 *   - in-flight `refreshing` flag disables the refresh button
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ClaudePlanUsage } from '../../../../renderer/components/UsageDashboard/ClaudePlanUsage';
import { useClaudeUsageStore } from '../../../../renderer/stores/claudeUsageStore';
import { THEMES } from '../../../../shared/themes';

const theme = THEMES['dracula'];

const refreshClaudeUsageSnapshotsMock = vi.fn();
const getClaudeUsageSnapshotsMock = vi.fn();

beforeEach(() => {
	refreshClaudeUsageSnapshotsMock.mockReset().mockResolvedValue({ refreshed: 1 });
	getClaudeUsageSnapshotsMock.mockReset().mockResolvedValue({});

	(global as any).window = (global as any).window ?? {};
	(window as any).maestro = {
		agents: {
			getClaudeUsageSnapshots: getClaudeUsageSnapshotsMock,
			refreshClaudeUsageSnapshots: refreshClaudeUsageSnapshotsMock,
		},
	};

	useClaudeUsageStore.getState().__resetForTests();
	cleanup();
});

function seedSnapshots(snapshots: Record<string, any>) {
	useClaudeUsageStore.setState({ snapshots, loaded: true, refreshing: false } as any);
}

describe('ClaudePlanUsage — empty state', () => {
	it('renders the empty message when no snapshots are cached', () => {
		render(<ClaudePlanUsage theme={theme} />);
		expect(screen.getByTestId('claude-plan-empty')).toBeInTheDocument();
		expect(screen.queryByTestId('claude-plan-row-default')).toBeNull();
	});
});

describe('ClaudePlanUsage — multi-row rendering', () => {
	it('renders one row per snapshot with account-short-name derivation', () => {
		seedSnapshots({
			'/Users/me/.claude': {
				sampledAt: '2026-05-15T00:00:00.000Z',
				configDirKey: '/Users/me/.claude',
				session: { percent: 50, resetsAt: '2026-05-15T05:00:00.000Z' },
				weekAllModels: { percent: 30, resetsAt: '2026-05-22T00:00:00.000Z' },
				weekSonnetOnly: { percent: 10, resetsAt: '2026-05-22T00:00:00.000Z' },
			},
			'/Users/me/.claude-gmail': {
				sampledAt: '2026-05-15T00:00:00.000Z',
				configDirKey: '/Users/me/.claude-gmail',
				session: { percent: 97, resetsAt: '2026-05-15T05:00:00.000Z' },
				weekAllModels: { percent: 80, resetsAt: '2026-05-22T00:00:00.000Z' },
				weekSonnetOnly: { percent: 5, resetsAt: '2026-05-22T00:00:00.000Z' },
			},
		});

		render(<ClaudePlanUsage theme={theme} />);

		// `.claude` → `default`, `.claude-gmail` → `gmail`
		expect(screen.getByTestId('claude-plan-row-default')).toBeInTheDocument();
		expect(screen.getByTestId('claude-plan-row-gmail')).toBeInTheDocument();

		// Each row renders three progressbar bars (session, week all, week sonnet).
		const bars = screen.getAllByRole('progressbar');
		expect(bars).toHaveLength(6);
	});

	it('exposes percent values via aria-valuenow on each bar', () => {
		seedSnapshots({
			'/Users/me/.claude-work': {
				sampledAt: '2026-05-15T00:00:00.000Z',
				configDirKey: '/Users/me/.claude-work',
				session: { percent: 42, resetsAt: '2026-05-15T05:00:00.000Z' },
				weekAllModels: { percent: 7, resetsAt: '2026-05-22T00:00:00.000Z' },
				weekSonnetOnly: { percent: 99, resetsAt: '2026-05-22T00:00:00.000Z' },
			},
		});

		render(<ClaudePlanUsage theme={theme} />);

		const bars = screen.getAllByRole('progressbar');
		const values = bars.map((b) => b.getAttribute('aria-valuenow'));
		expect(values).toEqual(['42', '7', '99']);
	});
});

describe('ClaudePlanUsage — unauthenticated row', () => {
	it('renders the "run /login" CTA in place of bars when authState is unauthenticated', () => {
		seedSnapshots({
			'/Users/me/.claude-0din': {
				sampledAt: '2026-05-15T00:00:00.000Z',
				configDirKey: '/Users/me/.claude-0din',
				authState: 'unauthenticated',
				session: { percent: 0, resetsAt: '2026-05-15T00:00:00.000Z' },
				weekAllModels: { percent: 0, resetsAt: '2026-05-15T00:00:00.000Z' },
				weekSonnetOnly: { percent: 0, resetsAt: '2026-05-15T00:00:00.000Z' },
			},
		});

		render(<ClaudePlanUsage theme={theme} />);

		// CTA element rendered, bars suppressed.
		expect(screen.getByTestId('claude-plan-row-0din-unauthenticated')).toBeInTheDocument();
		expect(screen.queryAllByRole('progressbar')).toHaveLength(0);
		expect(screen.getByText(/Not logged in/i)).toBeInTheDocument();
		expect(screen.getByText(/\/login/i)).toBeInTheDocument();
	});

	it('still renders bars for authenticated snapshots alongside unauthenticated ones', () => {
		seedSnapshots({
			'/Users/me/.claude': {
				sampledAt: '2026-05-15T00:00:00.000Z',
				configDirKey: '/Users/me/.claude',
				authState: 'authenticated',
				session: { percent: 50, resetsAt: '2026-05-15T05:00:00.000Z' },
				weekAllModels: { percent: 30, resetsAt: '2026-05-22T00:00:00.000Z' },
				weekSonnetOnly: { percent: 10, resetsAt: '2026-05-22T00:00:00.000Z' },
			},
			'/Users/me/.claude-0din': {
				sampledAt: '2026-05-15T00:00:00.000Z',
				configDirKey: '/Users/me/.claude-0din',
				authState: 'unauthenticated',
				session: { percent: 0, resetsAt: '2026-05-15T00:00:00.000Z' },
				weekAllModels: { percent: 0, resetsAt: '2026-05-15T00:00:00.000Z' },
				weekSonnetOnly: { percent: 0, resetsAt: '2026-05-15T00:00:00.000Z' },
			},
		});

		render(<ClaudePlanUsage theme={theme} />);

		// Authenticated account renders 3 bars; unauthenticated renders the CTA.
		expect(screen.getAllByRole('progressbar')).toHaveLength(3);
		expect(screen.getByTestId('claude-plan-row-0din-unauthenticated')).toBeInTheDocument();
	});

	it('treats missing authState as authenticated for back-compat', () => {
		// Snapshots persisted before authState existed must continue to
		// render as bars, not as the unauthenticated CTA.
		seedSnapshots({
			'/Users/me/.claude': {
				sampledAt: '2026-05-15T00:00:00.000Z',
				configDirKey: '/Users/me/.claude',
				session: { percent: 22, resetsAt: '2026-05-15T05:00:00.000Z' },
				weekAllModels: { percent: 8, resetsAt: '2026-05-22T00:00:00.000Z' },
				weekSonnetOnly: { percent: 1, resetsAt: '2026-05-22T00:00:00.000Z' },
			},
		});

		render(<ClaudePlanUsage theme={theme} />);

		expect(screen.getAllByRole('progressbar')).toHaveLength(3);
		expect(screen.queryByTestId('claude-plan-row-default-unauthenticated')).toBeNull();
	});
});

describe('ClaudePlanUsage — refresh wiring', () => {
	it('calls the refresh IPC and re-pulls the store on click', async () => {
		getClaudeUsageSnapshotsMock.mockResolvedValue({
			'/Users/me/.claude': {
				sampledAt: '2026-05-15T01:00:00.000Z',
				configDirKey: '/Users/me/.claude',
				session: { percent: 11, resetsAt: '2026-05-15T05:00:00.000Z' },
				weekAllModels: { percent: 2, resetsAt: '2026-05-22T00:00:00.000Z' },
				weekSonnetOnly: { percent: 1, resetsAt: '2026-05-22T00:00:00.000Z' },
			},
		});

		render(<ClaudePlanUsage theme={theme} />);
		fireEvent.click(screen.getByTestId('claude-plan-refresh'));

		await waitFor(() => {
			expect(refreshClaudeUsageSnapshotsMock).toHaveBeenCalledTimes(1);
			expect(getClaudeUsageSnapshotsMock).toHaveBeenCalledTimes(1);
		});

		await waitFor(() => {
			expect(screen.getByTestId('claude-plan-row-default')).toBeInTheDocument();
		});
	});

	it('disables the refresh button while a refresh is in flight', () => {
		useClaudeUsageStore.setState({
			snapshots: {},
			loaded: true,
			refreshing: true,
		} as any);

		render(<ClaudePlanUsage theme={theme} />);
		const button = screen.getByTestId('claude-plan-refresh') as HTMLButtonElement;
		expect(button.disabled).toBe(true);
		expect(button.textContent).toContain('Refreshing');
	});
});
