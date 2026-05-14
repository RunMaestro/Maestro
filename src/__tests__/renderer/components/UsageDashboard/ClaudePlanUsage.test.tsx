/**
 * Tests for the Claude Plan Usage dashboard section (MAESTRO-P-03 task 4).
 *
 * Covers:
 *   - Empty state when no snapshots are present
 *   - One row per `configDirKey` with the three quota bars
 *   - Account-short-name derivation (`.claude` → `default`, `.claude-foo` → `foo`)
 *   - Refresh button calls the IPC and then the store's refresh()
 *   - Refresh button disables itself while in flight
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

import { ClaudePlanUsage } from '../../../../renderer/components/UsageDashboard/ClaudePlanUsage';
import { useClaudeUsageStore } from '../../../../renderer/stores/claudeUsageStore';
import type { Theme } from '../../../../renderer/types';

const mockTheme = {
	name: 'test',
	colors: {
		bgMain: '#1a1a2e',
		bgSidebar: '#16213e',
		bgActivity: '#16213e',
		bgInput: '#0f3460',
		textMain: '#e0e0e0',
		textDim: '#888888',
		accent: '#4a90e2',
		border: '#333333',
		error: '#ff4444',
		success: '#00cc66',
		warning: '#ffaa00',
	},
} as unknown as Theme;

const refreshClaudeUsageSnapshots = vi.fn();
const getClaudeUsageSnapshots = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	refreshClaudeUsageSnapshots.mockResolvedValue({ refreshed: 0 });
	getClaudeUsageSnapshots.mockResolvedValue({});
	const maestro = (window as any).maestro;
	maestro.agents.refreshClaudeUsageSnapshots = refreshClaudeUsageSnapshots;
	maestro.agents.getClaudeUsageSnapshots = getClaudeUsageSnapshots;
	useClaudeUsageStore.setState({
		snapshots: {},
		loaded: true,
		loading: false,
		error: null,
	} as any);
});

afterEach(() => {
	cleanup();
});

describe('ClaudePlanUsage', () => {
	it('renders the empty state when no snapshots exist', () => {
		render(<ClaudePlanUsage theme={mockTheme} />);
		expect(screen.getByTestId('claude-plan-usage-empty')).toBeInTheDocument();
	});

	it('renders one row per configDirKey with all three quota bars', () => {
		const futureIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		useClaudeUsageStore.setState({
			snapshots: {
				'/Users/me/.claude': {
					sampledAt: new Date().toISOString(),
					configDirKey: '/Users/me/.claude',
					session: { percent: 12, resetsAt: futureIso },
					weekAllModels: { percent: 45, resetsAt: futureIso },
					weekSonnetOnly: { percent: 30, resetsAt: futureIso },
				},
				'/Users/me/.claude-gmail': {
					sampledAt: new Date().toISOString(),
					configDirKey: '/Users/me/.claude-gmail',
					session: { percent: 96, resetsAt: futureIso },
					weekAllModels: { percent: 80, resetsAt: futureIso },
					weekSonnetOnly: { percent: 60, resetsAt: futureIso },
				},
			},
			loaded: true,
			loading: false,
			error: null,
		} as any);

		render(<ClaudePlanUsage theme={mockTheme} />);

		expect(screen.getByTestId('claude-plan-row-/Users/me/.claude')).toBeInTheDocument();
		expect(screen.getByTestId('claude-plan-row-/Users/me/.claude-gmail')).toBeInTheDocument();
		// Account-short-name derivation rules
		expect(screen.getByText('default')).toBeInTheDocument();
		expect(screen.getByText('gmail')).toBeInTheDocument();
		// Three bars per row → six "Session" / "Week (...)" labels total
		expect(screen.getAllByText('Session')).toHaveLength(2);
		expect(screen.getAllByText('Week (all models)')).toHaveLength(2);
		expect(screen.getAllByText('Week (Sonnet only)')).toHaveLength(2);
	});

	it('calls the refresh IPC and store refresh() when the button is clicked', async () => {
		// One snapshot so the button has meaningful work to do.
		useClaudeUsageStore.setState({
			snapshots: {
				'/Users/me/.claude': {
					sampledAt: new Date().toISOString(),
					configDirKey: '/Users/me/.claude',
					session: { percent: 10, resetsAt: new Date().toISOString() },
					weekAllModels: { percent: 20, resetsAt: new Date().toISOString() },
					weekSonnetOnly: { percent: 5, resetsAt: new Date().toISOString() },
				},
			},
			loaded: true,
			loading: false,
			error: null,
		} as any);

		render(<ClaudePlanUsage theme={mockTheme} />);

		const button = screen.getByTestId('claude-plan-usage-refresh');
		fireEvent.click(button);

		await waitFor(() => {
			expect(refreshClaudeUsageSnapshots).toHaveBeenCalledTimes(1);
			// The store's refresh() goes through the same IPC seam to re-pull
			// fresh data, so we expect a second call to getClaudeUsageSnapshots
			// after the refresh-all completes.
			expect(getClaudeUsageSnapshots).toHaveBeenCalled();
		});
	});

	it('disables the refresh button while the request is in flight', async () => {
		let resolveRefresh: (value: { refreshed: number }) => void = () => {};
		refreshClaudeUsageSnapshots.mockReturnValue(
			new Promise<{ refreshed: number }>((resolve) => {
				resolveRefresh = resolve;
			})
		);

		render(<ClaudePlanUsage theme={mockTheme} />);

		const button = screen.getByTestId('claude-plan-usage-refresh') as HTMLButtonElement;
		fireEvent.click(button);

		await waitFor(() => {
			expect(button.disabled).toBe(true);
		});
		expect(button.textContent).toContain('Refreshing');

		resolveRefresh({ refreshed: 1 });
		await waitFor(() => {
			expect(button.disabled).toBe(false);
		});
	});
});
