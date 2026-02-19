/**
 * @fileoverview Tests for VirtuososModal component
 * Tests: tab rendering, tab switching, keyboard navigation, tab state persistence
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Theme } from '../../../renderer/types';

// Mock Modal component to avoid layer stack / hook dependencies
vi.mock('../../../renderer/components/ui/Modal', () => ({
	Modal: ({
		children,
		title,
	}: {
		children: React.ReactNode;
		title: string;
		[key: string]: unknown;
	}) => (
		<div data-testid="modal" aria-label={title}>
			{children}
		</div>
	),
}));

// Mock child components to isolate VirtuososModal tab logic
vi.mock('../../../renderer/components/AccountsPanel', () => ({
	AccountsPanel: () => <div data-testid="accounts-panel">AccountsPanel</div>,
}));

vi.mock('../../../renderer/components/ProviderPanel', () => ({
	ProviderPanel: () => <div data-testid="provider-panel">ProviderPanel</div>,
}));

vi.mock('../../../renderer/components/VirtuosoUsageView', () => ({
	VirtuosoUsageView: () => (
		<div data-testid="virtuoso-usage-view">VirtuosoUsageView</div>
	),
}));

// Import after mocks
import { VirtuososModal } from '../../../renderer/components/VirtuososModal';

const createTheme = (): Theme => ({
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a2e',
		bgSidebar: '#16213e',
		bgActivity: '#0f3460',
		textMain: '#e8e8e8',
		textDim: '#888888',
		accent: '#7b2cbf',
		accentDim: '#7b2cbf40',
		accentText: '#7b2cbf',
		accentForeground: '#ffffff',
		border: '#333355',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
});

describe('VirtuososModal', () => {
	const theme = createTheme();
	const onClose = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('renders nothing when isOpen is false', () => {
		const { container } = render(
			<VirtuososModal isOpen={false} onClose={onClose} theme={theme} />
		);
		expect(container.firstChild).toBeNull();
	});

	it('renders Accounts tab by default', () => {
		render(<VirtuososModal isOpen={true} onClose={onClose} theme={theme} />);

		const accountsTab = screen.getByRole('tab', { name: /Accounts/i });
		const providersTab = screen.getByRole('tab', { name: /Providers/i });
		const usageTab = screen.getByRole('tab', { name: /Usage/i });

		expect(accountsTab).toBeDefined();
		expect(providersTab).toBeDefined();
		expect(usageTab).toBeDefined();

		expect(accountsTab.getAttribute('aria-selected')).toBe('true');
		expect(providersTab.getAttribute('aria-selected')).toBe('false');
		expect(usageTab.getAttribute('aria-selected')).toBe('false');

		expect(screen.getByTestId('accounts-panel')).toBeDefined();
	});

	it('switches to Providers tab on click', () => {
		render(<VirtuososModal isOpen={true} onClose={onClose} theme={theme} />);

		const providersTab = screen.getByRole('tab', { name: /Providers/i });
		fireEvent.click(providersTab);

		expect(providersTab.getAttribute('aria-selected')).toBe('true');

		const accountsTab = screen.getByRole('tab', { name: /Accounts/i });
		expect(accountsTab.getAttribute('aria-selected')).toBe('false');

		expect(screen.getByTestId('provider-panel')).toBeDefined();
	});

	it('switches to Usage tab on click', () => {
		render(<VirtuososModal isOpen={true} onClose={onClose} theme={theme} />);

		const usageTab = screen.getByRole('tab', { name: /Usage/i });
		fireEvent.click(usageTab);

		expect(usageTab.getAttribute('aria-selected')).toBe('true');

		const accountsTab = screen.getByRole('tab', { name: /Accounts/i });
		expect(accountsTab.getAttribute('aria-selected')).toBe('false');

		expect(screen.getByTestId('virtuoso-usage-view')).toBeDefined();
	});

	it('cycles tabs with Cmd+Shift+]', async () => {
		render(<VirtuososModal isOpen={true} onClose={onClose} theme={theme} />);

		const accountsTab = screen.getByRole('tab', { name: /Accounts/i });
		const providersTab = screen.getByRole('tab', { name: /Providers/i });
		const usageTab = screen.getByRole('tab', { name: /Usage/i });

		expect(accountsTab.getAttribute('aria-selected')).toBe('true');

		// Accounts -> Providers
		fireEvent.keyDown(window, {
			key: ']',
			metaKey: true,
			shiftKey: true,
		});

		await waitFor(() => {
			expect(providersTab.getAttribute('aria-selected')).toBe('true');
		});

		// Providers -> Usage
		fireEvent.keyDown(window, {
			key: ']',
			metaKey: true,
			shiftKey: true,
		});

		await waitFor(() => {
			expect(usageTab.getAttribute('aria-selected')).toBe('true');
		});
	});

	it('cycles tabs with Cmd+Shift+[', async () => {
		render(<VirtuososModal isOpen={true} onClose={onClose} theme={theme} />);

		const usageTab = screen.getByRole('tab', { name: /Usage/i });
		fireEvent.click(usageTab);
		expect(usageTab.getAttribute('aria-selected')).toBe('true');

		// Usage -> Providers
		fireEvent.keyDown(window, {
			key: '[',
			metaKey: true,
			shiftKey: true,
		});

		const providersTab = screen.getByRole('tab', { name: /Providers/i });
		await waitFor(() => {
			expect(providersTab.getAttribute('aria-selected')).toBe('true');
		});

		// Providers -> Accounts
		fireEvent.keyDown(window, {
			key: '[',
			metaKey: true,
			shiftKey: true,
		});

		const accountsTab = screen.getByRole('tab', { name: /Accounts/i });
		await waitFor(() => {
			expect(accountsTab.getAttribute('aria-selected')).toBe('true');
		});
	});

	it('preserves tab state when modal stays open', () => {
		render(<VirtuososModal isOpen={true} onClose={onClose} theme={theme} />);

		const usageTab = screen.getByRole('tab', { name: /Usage/i });
		fireEvent.click(usageTab);
		expect(usageTab.getAttribute('aria-selected')).toBe('true');

		// State persists without external reset
		expect(usageTab.getAttribute('aria-selected')).toBe('true');
	});

	it('renders tablist with correct aria attributes', () => {
		render(<VirtuososModal isOpen={true} onClose={onClose} theme={theme} />);

		const tablist = screen.getByRole('tablist');
		expect(tablist).toBeDefined();
		expect(tablist.getAttribute('aria-label')).toBe('Virtuosos view');
	});

	it('wraps around when cycling past last tab', async () => {
		render(<VirtuososModal isOpen={true} onClose={onClose} theme={theme} />);

		const usageTab = screen.getByRole('tab', { name: /Usage/i });
		fireEvent.click(usageTab);

		// Press ] to wrap from last to first
		fireEvent.keyDown(window, {
			key: ']',
			metaKey: true,
			shiftKey: true,
		});

		const accountsTab = screen.getByRole('tab', { name: /Accounts/i });
		await waitFor(() => {
			expect(accountsTab.getAttribute('aria-selected')).toBe('true');
		});
	});

	it('wraps around when cycling before first tab', async () => {
		render(<VirtuososModal isOpen={true} onClose={onClose} theme={theme} />);

		// Accounts is first, press [ to wrap to Usage (last)
		fireEvent.keyDown(window, {
			key: '[',
			metaKey: true,
			shiftKey: true,
		});

		const usageTab = screen.getByRole('tab', { name: /Usage/i });
		await waitFor(() => {
			expect(usageTab.getAttribute('aria-selected')).toBe('true');
		});
	});
});
