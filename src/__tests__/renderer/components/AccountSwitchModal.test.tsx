/**
 * @file AccountSwitchModal.test.tsx
 * @description Tests for AccountSwitchModal component
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import { AccountSwitchModal } from '../../../renderer/components/AccountSwitchModal';
import type { Theme } from '../../../shared/theme-types';

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

const renderWithLayerStack = (ui: React.ReactElement) => {
	return render(<LayerStackProvider>{ui}</LayerStackProvider>);
};

const baseSwitchData = {
	sessionId: 'session-1',
	fromAccountId: 'acc-1',
	fromAccountName: 'Account 1',
	toAccountId: 'acc-2',
	toAccountName: 'Account 2',
	reason: 'throttled',
};

describe('AccountSwitchModal', () => {
	let onClose: ReturnType<typeof vi.fn>;
	let onConfirmSwitch: ReturnType<typeof vi.fn>;
	let onViewDashboard: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		onClose = vi.fn();
		onConfirmSwitch = vi.fn();
		onViewDashboard = vi.fn();
	});

	it('should export the component', async () => {
		const mod = await import('../../../renderer/components/AccountSwitchModal');
		expect(mod.AccountSwitchModal).toBeDefined();
		expect(typeof mod.AccountSwitchModal).toBe('function');
	});

	it('should return null when isOpen is false', () => {
		const { container } = renderWithLayerStack(
			<AccountSwitchModal
				theme={mockTheme}
				isOpen={false}
				onClose={onClose}
				switchData={baseSwitchData}
				onConfirmSwitch={onConfirmSwitch}
				onViewDashboard={onViewDashboard}
			/>
		);
		expect(container.innerHTML).toBe('');
	});

	it('should display throttle reason with warning styling', () => {
		renderWithLayerStack(
			<AccountSwitchModal
				theme={mockTheme}
				isOpen={true}
				onClose={onClose}
				switchData={{ ...baseSwitchData, reason: 'throttled' }}
				onConfirmSwitch={onConfirmSwitch}
				onViewDashboard={onViewDashboard}
			/>
		);

		// Header should show the throttled title
		expect(screen.getByText('Virtuoso Throttled')).toBeInTheDocument();
		// Description should mention rate limiting
		expect(screen.getByText('Virtuoso Account 1 has been rate limited')).toBeInTheDocument();
	});

	it('should display auth-expired reason with error styling', () => {
		renderWithLayerStack(
			<AccountSwitchModal
				theme={mockTheme}
				isOpen={true}
				onClose={onClose}
				switchData={{ ...baseSwitchData, reason: 'auth-expired' }}
				onConfirmSwitch={onConfirmSwitch}
				onViewDashboard={onViewDashboard}
			/>
		);

		expect(screen.getByText('Authentication Expired')).toBeInTheDocument();
		expect(screen.getByText('Virtuoso Account 1 authentication has expired')).toBeInTheDocument();
	});

	it('should call onConfirmSwitch on "Switch Virtuoso" click', async () => {
		renderWithLayerStack(
			<AccountSwitchModal
				theme={mockTheme}
				isOpen={true}
				onClose={onClose}
				switchData={baseSwitchData}
				onConfirmSwitch={onConfirmSwitch}
				onViewDashboard={onViewDashboard}
			/>
		);

		const switchButton = screen.getByText('Switch Virtuoso');
		await act(async () => {
			fireEvent.click(switchButton);
		});

		expect(onConfirmSwitch).toHaveBeenCalledTimes(1);
	});

	it('should dismiss on "Stay on Current" click', async () => {
		renderWithLayerStack(
			<AccountSwitchModal
				theme={mockTheme}
				isOpen={true}
				onClose={onClose}
				switchData={baseSwitchData}
				onConfirmSwitch={onConfirmSwitch}
				onViewDashboard={onViewDashboard}
			/>
		);

		const stayButton = screen.getByText('Stay on Current');
		await act(async () => {
			fireEvent.click(stayButton);
		});

		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('should call onViewDashboard on "View All Virtuosos" click', async () => {
		renderWithLayerStack(
			<AccountSwitchModal
				theme={mockTheme}
				isOpen={true}
				onClose={onClose}
				switchData={baseSwitchData}
				onConfirmSwitch={onConfirmSwitch}
				onViewDashboard={onViewDashboard}
			/>
		);

		const viewButton = screen.getByText('View All Virtuosos');
		await act(async () => {
			fireEvent.click(viewButton);
		});

		expect(onViewDashboard).toHaveBeenCalledTimes(1);
	});

	it('should display both account names', () => {
		renderWithLayerStack(
			<AccountSwitchModal
				theme={mockTheme}
				isOpen={true}
				onClose={onClose}
				switchData={baseSwitchData}
				onConfirmSwitch={onConfirmSwitch}
				onViewDashboard={onViewDashboard}
			/>
		);

		expect(screen.getByText('Account 1')).toBeInTheDocument();
		expect(screen.getByText('Account 2')).toBeInTheDocument();
		expect(screen.getByText('Current virtuoso')).toBeInTheDocument();
		expect(screen.getByText('Recommended switch target')).toBeInTheDocument();
	});

	it('should display limit-approaching reason with usage percent', () => {
		renderWithLayerStack(
			<AccountSwitchModal
				theme={mockTheme}
				isOpen={true}
				onClose={onClose}
				switchData={{
					...baseSwitchData,
					reason: 'limit-approaching',
					usagePercent: 87,
				}}
				onConfirmSwitch={onConfirmSwitch}
				onViewDashboard={onViewDashboard}
			/>
		);

		expect(screen.getByText('Virtuoso Limit Reached')).toBeInTheDocument();
		expect(screen.getByText('Virtuoso Account 1 is at 87% of its token limit')).toBeInTheDocument();
	});
});
