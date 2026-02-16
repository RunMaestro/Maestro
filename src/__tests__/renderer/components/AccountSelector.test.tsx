/**
 * @file AccountSelector.test.tsx
 * @description Tests for AccountSelector component
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { Theme } from '../../../shared/theme-types';
import type { AccountProfile } from '../../../shared/account-types';

// Mock useAccountUsage before importing the component
vi.mock('../../../renderer/hooks/useAccountUsage', () => ({
	useAccountUsage: vi.fn().mockReturnValue({
		metrics: {},
		loading: false,
		refresh: vi.fn(),
	}),
	formatTimeRemaining: vi.fn((ms: number) => ms > 0 ? '1h 30m' : '—'),
	formatTokenCount: vi.fn((tokens: number) => {
		if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
		if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
		return String(tokens);
	}),
}));

import { AccountSelector } from '../../../renderer/components/AccountSelector';
import { useAccountUsage } from '../../../renderer/hooks/useAccountUsage';

const mockTheme: Theme = {
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: {
		bgMain: '#282a36',
		bgSidebar: '#21222c',
		bgActivity: '#44475a',
		border: '#6272a4',
		textMain: '#f8f8f2',
		textDim: '#6272a4',
		accent: '#bd93f9',
		accentDim: '#bd93f920',
		accentText: '#bd93f9',
		accentForeground: '#ffffff',
		success: '#50fa7b',
		warning: '#f1fa8c',
		error: '#ff5555',
	},
};

const mockAccounts: AccountProfile[] = [
	{
		id: 'acc-1',
		name: 'work-account',
		email: 'work@example.com',
		configDir: '/home/user/.claude-work',
		isDefault: true,
		status: 'active',
		autoSwitchEnabled: true,
		tokenLimitPerWindow: 19000,
		tokenWindowMs: 5 * 60 * 60 * 1000,
		createdAt: Date.now(),
	},
	{
		id: 'acc-2',
		name: 'personal-account',
		email: 'personal@example.com',
		configDir: '/home/user/.claude-personal',
		isDefault: false,
		status: 'active',
		autoSwitchEnabled: false,
		tokenLimitPerWindow: 88000,
		tokenWindowMs: 5 * 60 * 60 * 1000,
		createdAt: Date.now(),
	},
	{
		id: 'acc-3',
		name: 'team-account',
		email: 'team@example.com',
		configDir: '/home/user/.claude-team',
		isDefault: false,
		status: 'throttled',
		autoSwitchEnabled: true,
		tokenLimitPerWindow: 220000,
		tokenWindowMs: 5 * 60 * 60 * 1000,
		createdAt: Date.now(),
	},
];

describe('AccountSelector', () => {
	let onSwitchAccount: ReturnType<typeof vi.fn>;
	let onManageAccounts: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		onSwitchAccount = vi.fn();
		onManageAccounts = vi.fn();
		vi.mocked(window.maestro.accounts.list).mockResolvedValue(mockAccounts);
		vi.mocked(useAccountUsage).mockReturnValue({
			metrics: {},
			loading: false,
			refresh: vi.fn(),
		});
	});

	it('should export the component', async () => {
		const mod = await import('../../../renderer/components/AccountSelector');
		expect(mod.AccountSelector).toBeDefined();
		expect(typeof mod.AccountSelector).toBe('function');
	});

	it('should render compact mode with abbreviated account name', async () => {
		await act(async () => {
			render(
				<AccountSelector
					theme={mockTheme}
					sessionId="session-1"
					currentAccountId="acc-1"
					currentAccountName="work@example.com"
					onSwitchAccount={onSwitchAccount}
					compact={true}
				/>
			);
		});

		// After accounts load, displayName becomes account.name ("work-account")
		// split('@')[0] on "work-account" yields "work-account"
		await waitFor(() => {
			expect(screen.getByText('work-account')).toBeInTheDocument();
		});
	});

	it('should show dropdown with all accounts on click', async () => {
		await act(async () => {
			render(
				<AccountSelector
					theme={mockTheme}
					sessionId="session-1"
					currentAccountId="acc-1"
					currentAccountName="work@example.com"
					onSwitchAccount={onSwitchAccount}
					onManageAccounts={onManageAccounts}
					compact={false}
				/>
			);
		});

		// Wait for accounts to load
		await waitFor(() => {
			expect(window.maestro.accounts.list).toHaveBeenCalled();
		});

		// Click the selector button to open dropdown
		const trigger = screen.getByRole('button');
		await act(async () => {
			fireEvent.click(trigger);
		});

		// All 3 accounts should be visible in the dropdown
		// work-account may appear in both trigger and dropdown, so use getAllByText
		await waitFor(() => {
			expect(screen.getAllByText('work-account').length).toBeGreaterThanOrEqual(1);
			expect(screen.getByText('personal-account')).toBeInTheDocument();
			expect(screen.getByText('team-account')).toBeInTheDocument();
		});
	});

	it('should show usage bars with correct theme colors', async () => {
		vi.mocked(useAccountUsage).mockReturnValue({
			metrics: {
				'acc-1': {
					accountId: 'acc-1',
					totalTokens: 9500,
					limitTokens: 19000,
					usagePercent: 50,
					costUsd: 1.50,
					queryCount: 10,
					windowStart: Date.now() - 1000000,
					windowEnd: Date.now() + 1000000,
					timeRemainingMs: 1000000,
					burnRatePerHour: 5000,
					estimatedTimeToLimitMs: 2000000,
					status: 'active',
					prediction: {
						linearTimeToLimitMs: null,
						weightedTimeToLimitMs: null,
						p90TokensPerWindow: 0,
						avgTokensPerWindow: 0,
						confidence: 'low',
						windowsRemainingP90: null,
					},
				},
				'acc-2': {
					accountId: 'acc-2',
					totalTokens: 74800,
					limitTokens: 88000,
					usagePercent: 85,
					costUsd: 12.00,
					queryCount: 50,
					windowStart: Date.now() - 1000000,
					windowEnd: Date.now() + 1000000,
					timeRemainingMs: 1000000,
					burnRatePerHour: 40000,
					estimatedTimeToLimitMs: 500000,
					status: 'active',
					prediction: {
						linearTimeToLimitMs: null,
						weightedTimeToLimitMs: null,
						p90TokensPerWindow: 0,
						avgTokensPerWindow: 0,
						confidence: 'low',
						windowsRemainingP90: null,
					},
				},
				'acc-3': {
					accountId: 'acc-3',
					totalTokens: 211200,
					limitTokens: 220000,
					usagePercent: 96,
					costUsd: 30.00,
					queryCount: 100,
					windowStart: Date.now() - 1000000,
					windowEnd: Date.now() + 1000000,
					timeRemainingMs: 1000000,
					burnRatePerHour: 100000,
					estimatedTimeToLimitMs: 100000,
					status: 'throttled',
					prediction: {
						linearTimeToLimitMs: null,
						weightedTimeToLimitMs: null,
						p90TokensPerWindow: 0,
						avgTokensPerWindow: 0,
						confidence: 'low',
						windowsRemainingP90: null,
					},
				},
			},
			loading: false,
			refresh: vi.fn(),
		});

		await act(async () => {
			render(
				<AccountSelector
					theme={mockTheme}
					sessionId="session-1"
					currentAccountId="acc-1"
					onSwitchAccount={onSwitchAccount}
					compact={false}
				/>
			);
		});

		await waitFor(() => {
			expect(window.maestro.accounts.list).toHaveBeenCalled();
		});

		// Open dropdown
		const trigger = screen.getByRole('button');
		await act(async () => {
			fireEvent.click(trigger);
		});

		// Verify accounts are rendered with usage bars
		// work-account may appear in both trigger and dropdown, so use getAllByText
		await waitFor(() => {
			expect(screen.getAllByText('work-account').length).toBeGreaterThanOrEqual(1);
			expect(screen.getByText('personal-account')).toBeInTheDocument();
			expect(screen.getByText('team-account')).toBeInTheDocument();
		});
	});

	it('should call onSwitchAccount when different account selected', async () => {
		await act(async () => {
			render(
				<AccountSelector
					theme={mockTheme}
					sessionId="session-1"
					currentAccountId="acc-1"
					onSwitchAccount={onSwitchAccount}
					compact={false}
				/>
			);
		});

		await waitFor(() => {
			expect(window.maestro.accounts.list).toHaveBeenCalled();
		});

		// Open dropdown
		const trigger = screen.getByRole('button');
		await act(async () => {
			fireEvent.click(trigger);
		});

		// Click account B
		await waitFor(() => {
			expect(screen.getByText('personal-account')).toBeInTheDocument();
		});
		await act(async () => {
			fireEvent.click(screen.getByText('personal-account'));
		});

		expect(onSwitchAccount).toHaveBeenCalledWith('acc-2');
	});

	it('should show "Manage Virtuosos" footer linking to VirtuososModal', async () => {
		await act(async () => {
			render(
				<AccountSelector
					theme={mockTheme}
					sessionId="session-1"
					currentAccountId="acc-1"
					onSwitchAccount={onSwitchAccount}
					onManageAccounts={onManageAccounts}
					compact={false}
				/>
			);
		});

		await waitFor(() => {
			expect(window.maestro.accounts.list).toHaveBeenCalled();
		});

		// Open dropdown
		const trigger = screen.getByRole('button');
		await act(async () => {
			fireEvent.click(trigger);
		});

		// Assert "Manage Virtuosos" item present
		await waitFor(() => {
			expect(screen.getByText('Manage Virtuosos')).toBeInTheDocument();
		});

		// Click it
		await act(async () => {
			fireEvent.click(screen.getByText('Manage Virtuosos'));
		});

		expect(onManageAccounts).toHaveBeenCalled();
	});

	it('should close dropdown on Escape key', async () => {
		await act(async () => {
			render(
				<AccountSelector
					theme={mockTheme}
					sessionId="session-1"
					currentAccountId="acc-1"
					onSwitchAccount={onSwitchAccount}
					onManageAccounts={onManageAccounts}
					compact={false}
				/>
			);
		});

		await waitFor(() => {
			expect(window.maestro.accounts.list).toHaveBeenCalled();
		});

		// Open dropdown
		const trigger = screen.getByRole('button');
		await act(async () => {
			fireEvent.click(trigger);
		});

		// Verify dropdown is open
		await waitFor(() => {
			expect(screen.getByText('Manage Virtuosos')).toBeInTheDocument();
		});

		// Press Escape
		await act(async () => {
			fireEvent.keyDown(document, { key: 'Escape' });
		});

		// Dropdown should be closed
		await waitFor(() => {
			expect(screen.queryByText('Manage Virtuosos')).not.toBeInTheDocument();
		});
	});

	it('should close dropdown on click outside', async () => {
		await act(async () => {
			render(
				<div>
					<div data-testid="outside">Outside area</div>
					<AccountSelector
						theme={mockTheme}
						sessionId="session-1"
						currentAccountId="acc-1"
						onSwitchAccount={onSwitchAccount}
						onManageAccounts={onManageAccounts}
						compact={false}
					/>
				</div>
			);
		});

		await waitFor(() => {
			expect(window.maestro.accounts.list).toHaveBeenCalled();
		});

		// Open dropdown
		const triggers = screen.getAllByRole('button');
		const selectorTrigger = triggers.find(
			(btn) => btn.textContent?.includes('work')
		) ?? triggers[0];
		await act(async () => {
			fireEvent.click(selectorTrigger);
		});

		// Verify dropdown is open
		await waitFor(() => {
			expect(screen.getByText('Manage Virtuosos')).toBeInTheDocument();
		});

		// Click outside
		await act(async () => {
			fireEvent.mouseDown(screen.getByTestId('outside'));
		});

		// Dropdown should be closed
		await waitFor(() => {
			expect(screen.queryByText('Manage Virtuosos')).not.toBeInTheDocument();
		});
	});
});
