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
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useUIStore } from '../../../../renderer/stores/uiStore';
import { THEMES } from '../../../../shared/themes';

const theme = THEMES['dracula'];

const refreshClaudeUsageSnapshotsMock = vi.fn();
const getClaudeUsageSnapshotsMock = vi.fn();
const getCustomEnvVarsMock = vi.fn();

beforeEach(() => {
	refreshClaudeUsageSnapshotsMock.mockReset().mockResolvedValue({ refreshed: 1 });
	getClaudeUsageSnapshotsMock.mockReset().mockResolvedValue({});
	getCustomEnvVarsMock.mockReset().mockResolvedValue({});

	(global as any).window = (global as any).window ?? {};
	(window as any).maestro = {
		agents: {
			getClaudeUsageSnapshots: getClaudeUsageSnapshotsMock,
			refreshClaudeUsageSnapshots: refreshClaudeUsageSnapshotsMock,
			getCustomEnvVars: getCustomEnvVarsMock,
		},
	};

	useClaudeUsageStore.getState().__resetForTests();
	useSessionStore.setState({ sessions: [] } as any);
	useUIStore.setState({ hiddenQuotaAccounts: {} });
	cleanup();
});

function seedSnapshots(snapshots: Record<string, any>) {
	useClaudeUsageStore.setState({ snapshots, loaded: true, refreshing: false } as any);
}

function seedSessions(configDirs: string[]) {
	// Build minimal claude-code session records that carry the requested
	// CLAUDE_CONFIG_DIR values via customEnvVars - that's all the dashboard
	// needs to enumerate them as configured accounts.
	const sessions = configDirs.map((dir, i) => ({
		id: `sess-${i}`,
		name: `sess-${i}`,
		toolType: 'claude-code',
		cwd: '/tmp',
		customEnvVars: { CLAUDE_CONFIG_DIR: dir },
	}));
	useSessionStore.setState({ sessions } as any);
}

describe('ClaudePlanUsage - empty state', () => {
	it('renders the empty message when no accounts are configured and no snapshots cached', () => {
		render(<ClaudePlanUsage theme={theme} />);
		expect(screen.getByTestId('claude-plan-empty')).toBeInTheDocument();
		expect(screen.queryByTestId('claude-plan-row-default')).toBeNull();
	});
});

describe('ClaudePlanUsage - configured account without snapshot', () => {
	it('renders a "hit Refresh" CTA for a session-configured account that has no snapshot yet', () => {
		// Session declares CLAUDE_CONFIG_DIR but the snapshot store is empty -
		// the tab list should still surface the account, and the per-tab body
		// should guide the user to hit Refresh instead of showing nothing.
		seedSessions(['/Users/me/.claude-pending']);

		render(<ClaudePlanUsage theme={theme} />);

		expect(screen.getByTestId('claude-plan-row-pending-pending')).toBeInTheDocument();
		expect(screen.queryAllByRole('progressbar')).toHaveLength(0);
	});

	it('mixes a configured-but-empty tab with an authenticated one', () => {
		seedSnapshots({
			'/Users/me/.claude': {
				sampledAt: '2026-05-15T00:00:00.000Z',
				configDirKey: '/Users/me/.claude',
				authState: 'authenticated',
				session: { percent: 50, resetsAt: '2026-05-15T05:00:00.000Z' },
				weekAllModels: { percent: 30, resetsAt: '2026-05-22T00:00:00.000Z' },
				weekSonnetOnly: { percent: 10, resetsAt: '2026-05-22T00:00:00.000Z' },
			},
		});
		seedSessions(['/Users/me/.claude', '/Users/me/.claude-pending']);

		render(<ClaudePlanUsage theme={theme} />);

		// Both tabs render.
		expect(screen.getByTestId('claude-plan-tab-default')).toBeInTheDocument();
		expect(screen.getByTestId('claude-plan-tab-pending')).toBeInTheDocument();

		// Switch to the pending tab - CTA visible, no bars.
		fireEvent.click(screen.getByTestId('claude-plan-tab-pending'));
		expect(screen.getByTestId('claude-plan-row-pending-pending')).toBeInTheDocument();
		expect(screen.queryAllByRole('progressbar')).toHaveLength(0);
	});
});

describe('ClaudePlanUsage - multi-account tabs', () => {
	it('renders a tab per account but only one row at a time (selected tab)', () => {
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

		// Both account tabs render.
		expect(screen.getByTestId('claude-plan-account-tabs')).toBeInTheDocument();
		expect(screen.getByTestId('claude-plan-tab-default')).toBeInTheDocument();
		expect(screen.getByTestId('claude-plan-tab-gmail')).toBeInTheDocument();

		// Only the first tab's row is visible (entries sort by short name; "default" wins).
		expect(screen.getByTestId('claude-plan-row-default')).toBeInTheDocument();
		expect(screen.queryByTestId('claude-plan-row-gmail')).toBeNull();
		expect(screen.getAllByRole('progressbar')).toHaveLength(3);
	});

	it('switches the visible row when a different tab is clicked', () => {
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

		fireEvent.click(screen.getByTestId('claude-plan-tab-gmail'));

		expect(screen.queryByTestId('claude-plan-row-default')).toBeNull();
		expect(screen.getByTestId('claude-plan-row-gmail')).toBeInTheDocument();
	});

	it('renders the tab bar even when only one account exists', () => {
		// Tab bar stays visible for single-account configurations so the user
		// always sees the account picker structure (they explicitly want to
		// enumerate accounts even when there's just one today, in case they
		// add more later).
		seedSnapshots({
			'/Users/me/.claude': {
				sampledAt: '2026-05-15T00:00:00.000Z',
				configDirKey: '/Users/me/.claude',
				session: { percent: 50, resetsAt: '2026-05-15T05:00:00.000Z' },
				weekAllModels: { percent: 30, resetsAt: '2026-05-22T00:00:00.000Z' },
				weekSonnetOnly: { percent: 10, resetsAt: '2026-05-22T00:00:00.000Z' },
			},
		});

		render(<ClaudePlanUsage theme={theme} />);

		expect(screen.getByTestId('claude-plan-account-tabs')).toBeInTheDocument();
		expect(screen.getByTestId('claude-plan-tab-default')).toBeInTheDocument();
		expect(screen.getByTestId('claude-plan-row-default')).toBeInTheDocument();
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

describe('ClaudePlanUsage - case-variant dedup', () => {
	it('collapses a case-variant CLAUDE_CONFIG_DIR onto the canonical snapshot row', () => {
		// macOS filesystem is case-insensitive: `/Users/me/.claude-opswat` (the
		// fs-discovered, snapshot-keyed spelling) and `/users/me/.claude-opswat`
		// (a lowercase path typed into a session env var) are one directory. The
		// dashboard must render a single account, not two near-identical rows.
		seedSnapshots({
			'/Users/me/.claude-opswat': {
				sampledAt: '2026-05-15T00:00:00.000Z',
				configDirKey: '/Users/me/.claude-opswat',
				authState: 'authenticated',
				session: { percent: 12, resetsAt: '2026-05-15T05:00:00.000Z' },
				weekAllModels: { percent: 8, resetsAt: '2026-05-22T00:00:00.000Z' },
				weekSonnetOnly: { percent: 1, resetsAt: '2026-05-22T00:00:00.000Z' },
			},
		});
		seedSessions(['/users/me/.claude-opswat']);

		render(<ClaudePlanUsage theme={theme} showAllAccounts autoRefresh={false} />);

		// Exactly one opswat account row, and it's the canonical-cased one that
		// carries the snapshot (three bars render, not a pending CTA).
		expect(screen.getAllByTestId('claude-plan-account-opswat')).toHaveLength(1);
		expect(screen.getByText('/Users/me/.claude-opswat')).toBeInTheDocument();
		expect(screen.queryByText('/users/me/.claude-opswat')).toBeNull();
		expect(screen.getAllByRole('progressbar')).toHaveLength(3);
	});
});

describe('ClaudePlanUsage - unauthenticated row', () => {
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

	it('renders the unauthenticated CTA when its tab is selected', () => {
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

		// Both tabs render. Entries sort by deriveAccountShortName; "0din" (digit '0',
		// charcode 48) sorts before "default" (letter 'd'), so the unauthenticated
		// tab is the initial selection.
		expect(screen.getByTestId('claude-plan-tab-default')).toBeInTheDocument();
		expect(screen.getByTestId('claude-plan-tab-0din')).toBeInTheDocument();
		expect(screen.getByTestId('claude-plan-row-0din-unauthenticated')).toBeInTheDocument();
		expect(screen.queryAllByRole('progressbar')).toHaveLength(0);

		// Switch to the authenticated tab - CTA disappears, three bars appear.
		fireEvent.click(screen.getByTestId('claude-plan-tab-default'));
		expect(screen.queryByTestId('claude-plan-row-0din-unauthenticated')).toBeNull();
		expect(screen.getAllByRole('progressbar')).toHaveLength(3);
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

describe('ClaudePlanUsage - refresh wiring', () => {
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
		expect(button.textContent).toContain('Sampling');
	});
});

describe('ClaudePlanUsage - hide/show accounts (list view)', () => {
	function seedTwoAccounts() {
		seedSnapshots({
			'/Users/me/.claude': {
				sampledAt: '2026-05-15T00:00:00.000Z',
				configDirKey: '/Users/me/.claude',
				authState: 'authenticated',
				session: { percent: 50, resetsAt: '2026-05-15T05:00:00.000Z' },
				weekAllModels: { percent: 30, resetsAt: '2026-05-22T00:00:00.000Z' },
				weekSonnetOnly: { percent: 10, resetsAt: '2026-05-22T00:00:00.000Z' },
			},
			'/Users/me/.claude-work': {
				sampledAt: '2026-05-15T00:00:00.000Z',
				configDirKey: '/Users/me/.claude-work',
				authState: 'authenticated',
				session: { percent: 90, resetsAt: '2026-05-15T05:00:00.000Z' },
				weekAllModels: { percent: 70, resetsAt: '2026-05-22T00:00:00.000Z' },
				weekSonnetOnly: { percent: 5, resetsAt: '2026-05-22T00:00:00.000Z' },
			},
		});
	}

	it('hides a row, surfaces Show all, and brings it back when unhidden', () => {
		seedTwoAccounts();
		render(<ClaudePlanUsage theme={theme} showAllAccounts autoRefresh={false} />);

		expect(screen.getByTestId('claude-plan-account-default')).toBeInTheDocument();
		expect(screen.getByTestId('claude-plan-account-work')).toBeInTheDocument();
		expect(screen.queryByTestId('claude-plan-show-all')).toBeNull();

		// Hide the default account: its row drops out, Show all (1) appears.
		fireEvent.click(screen.getByTestId('claude-plan-visibility-default'));
		expect(screen.queryByTestId('claude-plan-account-default')).toBeNull();
		expect(screen.getByTestId('claude-plan-account-work')).toBeInTheDocument();
		expect(screen.getByTestId('claude-plan-show-all')).toHaveTextContent('Show all (1)');

		// Reveal hidden: the hidden row reappears marked as hidden.
		fireEvent.click(screen.getByTestId('claude-plan-show-all'));
		expect(screen.getByTestId('claude-plan-account-default-hidden')).toBeInTheDocument();

		// Unhide from its revealed row toggle: back to visible, Show all gone.
		fireEvent.click(screen.getByTestId('claude-plan-visibility-default'));
		expect(screen.getByTestId('claude-plan-account-default')).toBeInTheDocument();
		expect(screen.queryByTestId('claude-plan-show-all')).toBeNull();
	});

	it('persists the hidden set through uiStore so it survives a remount', () => {
		seedTwoAccounts();
		const { unmount } = render(
			<ClaudePlanUsage theme={theme} showAllAccounts autoRefresh={false} />
		);

		fireEvent.click(screen.getByTestId('claude-plan-visibility-work'));
		expect(useUIStore.getState().hiddenQuotaAccounts['claude-code']).toEqual([
			'/Users/me/.claude-work',
		]);

		unmount();
		render(<ClaudePlanUsage theme={theme} showAllAccounts autoRefresh={false} />);
		expect(screen.queryByTestId('claude-plan-account-work')).toBeNull();
		expect(screen.getByTestId('claude-plan-show-all')).toHaveTextContent('Show all (1)');
	});

	it('does not render per-row hide toggles in tab (single-account) view', () => {
		seedTwoAccounts();
		render(<ClaudePlanUsage theme={theme} />);

		expect(screen.queryByTestId('claude-plan-visibility-default')).toBeNull();
		expect(screen.queryByTestId('claude-plan-show-all')).toBeNull();
	});
});
