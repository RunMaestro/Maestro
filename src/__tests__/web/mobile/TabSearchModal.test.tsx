/**
 * Tests for TabSearchModal component
 *
 * @module TabSearchModal.test
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { TabSearchModal } from '../../../web/mobile/TabSearchModal';
import type { AITabData } from '../../../web/hooks/useWebSocket';

// Mock useThemeColors
const mockColors = {
	bgMain: '#1a1a1a',
	bgSidebar: '#111111',
	textMain: '#ffffff',
	textDim: '#888888',
	border: '#333333',
	accent: '#007acc',
	warning: '#f5a623',
	error: '#f44336',
	success: '#4caf50',
	textHeader: '#ffffff',
	vibeMain: '#ff00ff',
	vibeText: '#ffffff',
};

vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => mockColors,
}));

// Mock haptic feedback
const mockTriggerHaptic = vi.fn();
vi.mock('../../../web/mobile/constants', () => ({
	triggerHaptic: (...args: unknown[]) => mockTriggerHaptic(...args),
	HAPTIC_PATTERNS: {
		tap: [10],
		send: [20],
		interrupt: [30],
		success: [40],
		error: [50],
	},
	BREAKPOINTS: {
		phone: 0,
		tablet: 600,
		desktop: 960,
	},
}));

describe('TabSearchModal', () => {
	const createTab = (overrides: Partial<AITabData> & { id: string }): AITabData => ({
		name: '',
		agentSessionId: '',
		state: 'idle',
		starred: false,
		...overrides,
	});

	const defaultTabs: AITabData[] = [
		createTab({ id: 'tab-1', name: 'Main', agentSessionId: 'abc12345-6789' }),
		createTab({ id: 'tab-2', name: 'Feature', agentSessionId: 'def67890-abcd' }),
		createTab({ id: 'tab-3', name: 'Tests', agentSessionId: 'ghi11111-efgh' }),
	];

	let mockOnSelectTab: ReturnType<typeof vi.fn>;
	let mockOnClose: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockOnSelectTab = vi.fn();
		mockOnClose = vi.fn();
		mockTriggerHaptic.mockClear();
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
	});

	// ============================================================
	// TabCard Internal Component Tests (via TabSearchModal)
	// ============================================================
	describe('TabCard component', () => {
		describe('Display name logic', () => {
			it('uses tab.name when available', () => {
				const tabs = [createTab({ id: 'tab-1', name: 'MyCustomTab' })];
				render(
					<TabSearchModal
						isOpen={true}
						tabs={tabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				expect(screen.getByText('MyCustomTab')).toBeInTheDocument();
			});

			it('uses agentSessionId first segment in uppercase when name is empty', () => {
				const tabs = [createTab({ id: 'tab-1', name: '', agentSessionId: 'abc12345-6789-0def' })];
				render(
					<TabSearchModal
						isOpen={true}
						tabs={tabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				expect(screen.getByText('ABC12345')).toBeInTheDocument();
			});

			it('displays "New Tab" when both name and agentSessionId are empty', () => {
				const tabs = [createTab({ id: 'tab-1', name: '', agentSessionId: '' })];
				render(
					<TabSearchModal
						isOpen={true}
						tabs={tabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				expect(screen.getByText('New Tab')).toBeInTheDocument();
			});

			it('displays "New Tab" when agentSessionId is undefined', () => {
				const tabs = [{ id: 'tab-1', name: '', state: 'idle' as const, starred: false }];
				render(
					<TabSearchModal
						isOpen={true}
						tabs={tabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				expect(screen.getByText('New Tab')).toBeInTheDocument();
			});

			it('handles agentSessionId without dashes', () => {
				const tabs = [createTab({ id: 'tab-1', name: '', agentSessionId: 'simpleId' })];
				render(
					<TabSearchModal
						isOpen={true}
						tabs={tabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				expect(screen.getByText('SIMPLEID')).toBeInTheDocument();
			});
		});

		describe('Status color', () => {
			// Helper to normalize color (accepts both hex and rgb)
			const normalizeColor = (color: string) => color.toLowerCase().replace(/\s/g, '');

			it('uses warning color for busy state', () => {
				const tabs = [createTab({ id: 'tab-1', name: 'Busy Tab', state: 'busy' })];
				render(
					<TabSearchModal
						isOpen={true}
						tabs={tabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				const button = screen.getByText('Busy Tab').closest('button');
				// Find the status dot by its characteristic styles
				const allSpans = button?.querySelectorAll('span');
				const statusDot = Array.from(allSpans || []).find(
					(span) => span.style.borderRadius === '50%' && span.style.width === '10px'
				);
				expect(statusDot).toBeDefined();
				// Warning color #f5a623 -> rgb(245, 166, 35)
				const bgColor = normalizeColor(statusDot?.style.backgroundColor || '');
				expect(bgColor === '#f5a623' || bgColor === 'rgb(245,166,35)').toBe(true);
			});

			it('uses success color for idle state', () => {
				const tabs = [createTab({ id: 'tab-1', name: 'Idle Tab', state: 'idle' })];
				render(
					<TabSearchModal
						isOpen={true}
						tabs={tabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				const button = screen.getByText('Idle Tab').closest('button');
				// Find the status dot by its characteristic styles
				const allSpans = button?.querySelectorAll('span');
				const statusDot = Array.from(allSpans || []).find(
					(span) => span.style.borderRadius === '50%' && span.style.width === '10px'
				);
				expect(statusDot).toBeDefined();
				// Success color #4caf50 -> rgb(76, 175, 80)
				const bgColor = normalizeColor(statusDot?.style.backgroundColor || '');
				expect(bgColor === '#4caf50' || bgColor === 'rgb(76,175,80)').toBe(true);
			});
		});

		describe('Status dot animation', () => {
			it('has pulse animation for busy state', () => {
				const tabs = [createTab({ id: 'tab-1', name: 'Busy Tab', state: 'busy' })];
				render(
					<TabSearchModal
						isOpen={true}
						tabs={tabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				const button = screen.getByText('Busy Tab').closest('button');
				const statusDot = button?.querySelector('span[style*="animation"]');
				expect(statusDot).toHaveStyle({ animation: 'pulse 1.5s infinite' });
			});

			it('has no animation for idle state', () => {
				const tabs = [createTab({ id: 'tab-1', name: 'Idle Tab', state: 'idle' })];
				render(
					<TabSearchModal
						isOpen={true}
						tabs={tabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				const button = screen.getByText('Idle Tab').closest('button');
				// Find the status dot (first span with circular border-radius)
				const allSpans = button?.querySelectorAll('span');
				const statusDot = Array.from(allSpans || []).find(
					(span) => span.style.borderRadius === '50%' && span.style.width === '10px'
				);
				expect(statusDot).toBeDefined();
				expect(statusDot?.style.animation).toBe('none');
			});
		});

		describe('Starred indicator', () => {
			it('shows ★ when tab is starred', () => {
				const tabs = [createTab({ id: 'tab-1', name: 'Starred Tab', starred: true })];
				render(
					<TabSearchModal
						isOpen={true}
						tabs={tabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				expect(screen.getByText('★')).toBeInTheDocument();
			});

			it('hides star when tab is not starred', () => {
				const tabs = [createTab({ id: 'tab-1', name: 'Unstarred Tab', starred: false })];
				render(
					<TabSearchModal
						isOpen={true}
						tabs={tabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				expect(screen.queryByText('★')).not.toBeInTheDocument();
			});

			it('star uses warning color', () => {
				const tabs = [createTab({ id: 'tab-1', name: 'Starred Tab', starred: true })];
				render(
					<TabSearchModal
						isOpen={true}
						tabs={tabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				const star = screen.getByText('★');
				expect(star).toHaveStyle({ color: mockColors.warning });
			});
		});

		describe('Claude session ID display', () => {
			it('shows agentSessionId when available', () => {
				const tabs = [
					createTab({ id: 'tab-1', name: 'Test', agentSessionId: 'abc12345-6789-0def' }),
				];
				render(
					<TabSearchModal
						isOpen={true}
						tabs={tabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				expect(screen.getByText('abc12345-6789-0def')).toBeInTheDocument();
			});

			it('hides agentSessionId when not available', () => {
				const tabs = [createTab({ id: 'tab-1', name: 'Test', agentSessionId: '' })];
				render(
					<TabSearchModal
						isOpen={true}
						tabs={tabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				// Only the display name should be shown, not a monospace session ID
				const button = screen.getByText('Test').closest('button');
				expect(button?.querySelector('span[style*="monospace"]')).not.toBeInTheDocument();
			});

			it('uses monospace font for agentSessionId', () => {
				const tabs = [createTab({ id: 'tab-1', name: 'Test', agentSessionId: 'xyz-session' })];
				render(
					<TabSearchModal
						isOpen={true}
						tabs={tabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				const sessionId = screen.getByText('xyz-session');
				expect(sessionId).toHaveStyle({ fontFamily: 'monospace' });
			});
		});

		describe('Active tab styling', () => {
			it('shows different background for active tab', () => {
				const tabs = [
					createTab({ id: 'tab-1', name: 'Active' }),
					createTab({ id: 'tab-2', name: 'Inactive' }),
				];
				render(
					<TabSearchModal
						isOpen={true}
						tabs={tabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				const activeButton = screen.getByText('Active').closest('button');
				expect(activeButton).toHaveStyle({ backgroundColor: `${mockColors.accent}20` });
			});

			it('shows accent border for active tab', () => {
				const tabs = [
					createTab({ id: 'tab-1', name: 'Active' }),
					createTab({ id: 'tab-2', name: 'Inactive' }),
				];
				render(
					<TabSearchModal
						isOpen={true}
						tabs={tabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				const activeButton = screen.getByText('Active').closest('button');
				// Border color is converted to RGB by browser
				// #007acc -> rgb(0, 122, 204)
				expect(activeButton?.style.border).toContain('rgb(0, 122, 204)');
			});

			it('shows ACTIVE indicator text for active tab', () => {
				const tabs = [createTab({ id: 'tab-1', name: 'Test' })];
				render(
					<TabSearchModal
						isOpen={true}
						tabs={tabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				expect(screen.getByText('ACTIVE')).toBeInTheDocument();
			});

			it('does not show ACTIVE text for inactive tab', () => {
				const tabs = [
					createTab({ id: 'tab-1', name: 'Active' }),
					createTab({ id: 'tab-2', name: 'Inactive' }),
				];
				render(
					<TabSearchModal
						isOpen={true}
						tabs={tabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				const inactiveButton = screen.getByText('Inactive').closest('button');
				expect(inactiveButton?.textContent).not.toContain('ACTIVE');
			});

			it('active tab name has fontWeight 600', () => {
				const tabs = [
					createTab({ id: 'tab-1', name: 'Active' }),
					createTab({ id: 'tab-2', name: 'Inactive' }),
				];
				render(
					<TabSearchModal
						isOpen={true}
						tabs={tabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				const activeName = screen.getByText('Active');
				expect(activeName).toHaveStyle({ fontWeight: '600' });
			});

			it('inactive tab name has fontWeight 500', () => {
				const tabs = [
					createTab({ id: 'tab-1', name: 'Active' }),
					createTab({ id: 'tab-2', name: 'Inactive' }),
				];
				render(
					<TabSearchModal
						isOpen={true}
						tabs={tabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				const inactiveName = screen.getByText('Inactive');
				expect(inactiveName).toHaveStyle({ fontWeight: '500' });
			});
		});

		describe('Click handling', () => {
			it('triggers haptic feedback on click', () => {
				const tabs = [createTab({ id: 'tab-1', name: 'Test' })];
				render(
					<TabSearchModal
						isOpen={true}
						tabs={tabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				const button = screen.getByText('Test').closest('button');
				fireEvent.click(button!);
				expect(mockTriggerHaptic).toHaveBeenCalled();
			});

			it('calls onSelect callback on click', () => {
				const tabs = [createTab({ id: 'tab-1', name: 'Test' })];
				render(
					<TabSearchModal
						isOpen={true}
						tabs={tabs}
						activeTabId="tab-2"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				const button = screen.getByText('Test').closest('button');
				fireEvent.click(button!);
				expect(mockOnSelectTab).toHaveBeenCalledWith('tab-1');
			});
		});
	});

	// ============================================================
	// TabSearchModal Main Component Tests
	// ============================================================
	describe('TabSearchModal main component', () => {
		describe('Rendering', () => {
			it('renders nothing when isOpen is false', () => {
				render(
					<TabSearchModal
						isOpen={false}
						tabs={defaultTabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				expect(screen.queryByText('Main')).not.toBeInTheDocument();
			});

			it('renders as a dialog with aria-modal', () => {
				render(
					<TabSearchModal
						isOpen={true}
						tabs={defaultTabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				const dialog = screen.getByRole('dialog');
				expect(dialog).toHaveAttribute('aria-modal', 'true');
				expect(dialog).toHaveAttribute('aria-label', 'Search Tabs');
			});

			it('renders fixed-position overlay', () => {
				render(
					<TabSearchModal
						isOpen={true}
						tabs={defaultTabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				// The ResponsiveModal outer div uses `.fixed` (Tailwind) plus an
				// inline `zIndex` style — find it via the inline style attribute.
				const modal = screen.getByText('Main').closest('div[style*="z-index"]');
				expect(modal).toBeInTheDocument();
			});

			it('forwards zIndex prop to the overlay', () => {
				render(
					<TabSearchModal
						isOpen={true}
						tabs={defaultTabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				const modal = screen.getByText('Main').closest('div[style*="z-index"]');
				expect(modal).toHaveStyle({ zIndex: '1000' });
			});

			it('renders all tabs', () => {
				render(
					<TabSearchModal
						isOpen={true}
						tabs={defaultTabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				expect(screen.getByText('Main')).toBeInTheDocument();
				expect(screen.getByText('Feature')).toBeInTheDocument();
				expect(screen.getByText('Tests')).toBeInTheDocument();
			});
		});

		describe('Input auto-focus', () => {
			it('focuses search input on mount', async () => {
				render(
					<TabSearchModal
						isOpen={true}
						tabs={defaultTabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				const input = screen.getByPlaceholderText(/Search.*tabs/);
				await waitFor(() => {
					expect(document.activeElement).toBe(input);
				});
			});
		});

		describe('Search reset on close', () => {
			it('clears searchQuery when isOpen flips to false (no stale filter on reopen)', async () => {
				const { rerender } = render(
					<TabSearchModal
						isOpen={true}
						tabs={defaultTabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				const input = screen.getByPlaceholderText(/Search.*tabs/) as HTMLInputElement;
				fireEvent.change(input, { target: { value: 'main' } });
				expect(input.value).toBe('main');

				rerender(
					<TabSearchModal
						isOpen={false}
						tabs={defaultTabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				rerender(
					<TabSearchModal
						isOpen={true}
						tabs={defaultTabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				const reopenedInput = screen.getByPlaceholderText(/Search.*tabs/) as HTMLInputElement;
				expect(reopenedInput.value).toBe('');
			});
		});

		describe('Close button', () => {
			it('renders close button with X icon', () => {
				render(
					<TabSearchModal
						isOpen={true}
						tabs={defaultTabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				const closeButton = screen.getByRole('button', { name: /close modal/i });
				expect(closeButton).toBeInTheDocument();
				expect(closeButton.querySelector('svg')).toBeInTheDocument();
			});

			it('calls onClose when clicked', () => {
				render(
					<TabSearchModal
						isOpen={true}
						tabs={defaultTabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				const closeButton = screen.getByRole('button', { name: /close modal/i });
				fireEvent.click(closeButton);
				expect(mockOnClose).toHaveBeenCalledTimes(1);
			});
		});

		describe('Search input', () => {
			it('shows tab count in placeholder', () => {
				render(
					<TabSearchModal
						isOpen={true}
						tabs={defaultTabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				expect(screen.getByPlaceholderText('Search 3 tabs...')).toBeInTheDocument();
			});

			it('updates placeholder when tab count changes', () => {
				const tabs = [createTab({ id: 'tab-1', name: 'Only One' })];
				render(
					<TabSearchModal
						isOpen={true}
						tabs={tabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				expect(screen.getByPlaceholderText('Search 1 tabs...')).toBeInTheDocument();
			});

			it('is a controlled input', () => {
				render(
					<TabSearchModal
						isOpen={true}
						tabs={defaultTabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				const input = screen.getByPlaceholderText(/Search.*tabs/);
				fireEvent.change(input, { target: { value: 'test query' } });
				expect(input).toHaveValue('test query');
			});

			it('has magnifying glass icon', () => {
				render(
					<TabSearchModal
						isOpen={true}
						tabs={defaultTabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				// The search icon sits next to the search input inside the modal body.
				const searchInput = screen.getByPlaceholderText(/Search.*tabs/);
				const searchRow = searchInput.parentElement;
				expect(searchRow?.querySelector('svg circle')).toBeInTheDocument();
			});
		});

		describe('Clear search button', () => {
			it('is hidden when search is empty', () => {
				render(
					<TabSearchModal
						isOpen={true}
						tabs={defaultTabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				expect(screen.queryByText('×')).not.toBeInTheDocument();
			});

			it('is visible when search has text', () => {
				render(
					<TabSearchModal
						isOpen={true}
						tabs={defaultTabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				const input = screen.getByPlaceholderText(/Search.*tabs/);
				fireEvent.change(input, { target: { value: 'test' } });
				expect(screen.getByText('×')).toBeInTheDocument();
			});

			it('clears search when clicked', () => {
				render(
					<TabSearchModal
						isOpen={true}
						tabs={defaultTabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				const input = screen.getByPlaceholderText(/Search.*tabs/);
				fireEvent.change(input, { target: { value: 'test' } });
				const clearButton = screen.getByText('×');
				fireEvent.click(clearButton);
				expect(input).toHaveValue('');
			});
		});

		describe('Escape key handler', () => {
			it('closes modal on Escape key', () => {
				render(
					<TabSearchModal
						isOpen={true}
						tabs={defaultTabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				fireEvent.keyDown(document, { key: 'Escape' });
				expect(mockOnClose).toHaveBeenCalledTimes(1);
			});

			it('does not close on other keys', () => {
				render(
					<TabSearchModal
						isOpen={true}
						tabs={defaultTabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				fireEvent.keyDown(document, { key: 'Enter' });
				fireEvent.keyDown(document, { key: 'a' });
				expect(mockOnClose).not.toHaveBeenCalled();
			});

			it('cleans up event listener on unmount', () => {
				const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');
				const { unmount } = render(
					<TabSearchModal
						isOpen={true}
						tabs={defaultTabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				unmount();
				expect(removeEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
				removeEventListenerSpy.mockRestore();
			});
		});

		describe('Tab selection', () => {
			it('calls onSelectTab with correct tabId', () => {
				render(
					<TabSearchModal
						isOpen={true}
						tabs={defaultTabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				const featureButton = screen.getByText('Feature').closest('button');
				fireEvent.click(featureButton!);
				expect(mockOnSelectTab).toHaveBeenCalledWith('tab-2');
			});

			it('calls onClose after selecting tab', () => {
				render(
					<TabSearchModal
						isOpen={true}
						tabs={defaultTabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				const featureButton = screen.getByText('Feature').closest('button');
				fireEvent.click(featureButton!);
				expect(mockOnClose).toHaveBeenCalledTimes(1);
			});
		});

		describe('Tab filtering', () => {
			it('shows all tabs when search is empty', () => {
				render(
					<TabSearchModal
						isOpen={true}
						tabs={defaultTabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				expect(screen.getByText('Main')).toBeInTheDocument();
				expect(screen.getByText('Feature')).toBeInTheDocument();
				expect(screen.getByText('Tests')).toBeInTheDocument();
			});

			it('filters by name (case-insensitive)', () => {
				render(
					<TabSearchModal
						isOpen={true}
						tabs={defaultTabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				const input = screen.getByPlaceholderText(/Search.*tabs/);
				fireEvent.change(input, { target: { value: 'FEATURE' } });
				expect(screen.getByText('Feature')).toBeInTheDocument();
				expect(screen.queryByText('Main')).not.toBeInTheDocument();
				expect(screen.queryByText('Tests')).not.toBeInTheDocument();
			});

			it('filters by agentSessionId (case-insensitive)', () => {
				render(
					<TabSearchModal
						isOpen={true}
						tabs={defaultTabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				const input = screen.getByPlaceholderText(/Search.*tabs/);
				// 'abc12345' is unique to Main tab
				fireEvent.change(input, { target: { value: 'abc12345' } });
				expect(screen.getByText('Main')).toBeInTheDocument();
				expect(screen.queryByText('Feature')).not.toBeInTheDocument();
			});

			it('shows partial matches', () => {
				render(
					<TabSearchModal
						isOpen={true}
						tabs={defaultTabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				const input = screen.getByPlaceholderText(/Search.*tabs/);
				fireEvent.change(input, { target: { value: 'ea' } }); // Matches "Feature" and partially "Tests"
				expect(screen.getByText('Feature')).toBeInTheDocument();
				// 'Tests' does not contain 'ea'
				expect(screen.queryByText('Tests')).not.toBeInTheDocument();
			});

			it('treats whitespace-only search as empty', () => {
				render(
					<TabSearchModal
						isOpen={true}
						tabs={defaultTabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				const input = screen.getByPlaceholderText(/Search.*tabs/);
				fireEvent.change(input, { target: { value: '   ' } });
				// All tabs should still be visible
				expect(screen.getByText('Main')).toBeInTheDocument();
				expect(screen.getByText('Feature')).toBeInTheDocument();
				expect(screen.getByText('Tests')).toBeInTheDocument();
			});
		});

		describe('Empty states', () => {
			it('shows "No tabs available" when tabs array is empty', () => {
				render(
					<TabSearchModal
						isOpen={true}
						tabs={[]}
						activeTabId=""
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				expect(screen.getByText('No tabs available')).toBeInTheDocument();
			});

			it('shows "No tabs match your search" when search has no results', () => {
				render(
					<TabSearchModal
						isOpen={true}
						tabs={defaultTabs}
						activeTabId="tab-1"
						onSelectTab={mockOnSelectTab}
						onClose={mockOnClose}
					/>
				);
				const input = screen.getByPlaceholderText(/Search.*tabs/);
				fireEvent.change(input, { target: { value: 'nonexistent' } });
				expect(screen.getByText('No tabs match your search')).toBeInTheDocument();
			});
		});
	});

	// ============================================================
	// Edge Cases
	// ============================================================
	describe('Edge cases', () => {
		it('handles empty tabs array', () => {
			render(
				<TabSearchModal
					isOpen={true}
					tabs={[]}
					activeTabId=""
					onSelectTab={mockOnSelectTab}
					onClose={mockOnClose}
				/>
			);
			expect(screen.getByText('No tabs available')).toBeInTheDocument();
			expect(screen.getByPlaceholderText('Search 0 tabs...')).toBeInTheDocument();
		});

		it('handles single tab', () => {
			const tabs = [createTab({ id: 'tab-1', name: 'Only One' })];
			render(
				<TabSearchModal
					isOpen={true}
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onClose={mockOnClose}
				/>
			);
			expect(screen.getByText('Only One')).toBeInTheDocument();
			expect(screen.getByText('ACTIVE')).toBeInTheDocument();
		});

		it('handles many tabs', () => {
			const tabs = Array.from({ length: 50 }, (_, i) =>
				createTab({ id: `tab-${i}`, name: `Tab ${i}` })
			);
			render(
				<TabSearchModal
					isOpen={true}
					tabs={tabs}
					activeTabId="tab-0"
					onSelectTab={mockOnSelectTab}
					onClose={mockOnClose}
				/>
			);
			expect(screen.getByPlaceholderText('Search 50 tabs...')).toBeInTheDocument();
			// All tabs should render
			for (let i = 0; i < 50; i++) {
				expect(screen.getByText(`Tab ${i}`)).toBeInTheDocument();
			}
		});

		it('handles very long tab name', () => {
			const tabs = [
				createTab({
					id: 'tab-1',
					name: 'This is a very long tab name that should be handled gracefully without breaking the UI',
				}),
			];
			render(
				<TabSearchModal
					isOpen={true}
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onClose={mockOnClose}
				/>
			);
			const name = screen.getByText(
				'This is a very long tab name that should be handled gracefully without breaking the UI'
			);
			expect(name).toHaveStyle({ overflow: 'hidden', textOverflow: 'ellipsis' });
		});

		it('handles special characters in tab name', () => {
			const tabs = [createTab({ id: 'tab-1', name: '<script>alert("xss")</script>' })];
			render(
				<TabSearchModal
					isOpen={true}
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onClose={mockOnClose}
				/>
			);
			expect(screen.getByText('<script>alert("xss")</script>')).toBeInTheDocument();
		});

		it('handles unicode characters', () => {
			const tabs = [createTab({ id: 'tab-1', name: '🎵 Music Tab 中文 العربية 🎶' })];
			render(
				<TabSearchModal
					isOpen={true}
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onClose={mockOnClose}
				/>
			);
			expect(screen.getByText('🎵 Music Tab 中文 العربية 🎶')).toBeInTheDocument();
		});

		it('handles tab with null name and null agentSessionId', () => {
			// TypeScript would normally prevent this, but testing runtime behavior
			const tabs = [
				{
					id: 'tab-1',
					name: null as unknown as string,
					agentSessionId: null as unknown as string,
					state: 'idle' as const,
					starred: false,
				},
			];
			render(
				<TabSearchModal
					isOpen={true}
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onClose={mockOnClose}
				/>
			);
			// Should fall back to "New Tab"
			expect(screen.getByText('New Tab')).toBeInTheDocument();
		});

		it('handles active tab not in filtered results', () => {
			render(
				<TabSearchModal
					isOpen={true}
					tabs={defaultTabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onClose={mockOnClose}
				/>
			);
			const input = screen.getByPlaceholderText(/Search.*tabs/);
			// Filter to show only Feature, but active is Main
			fireEvent.change(input, { target: { value: 'Feature' } });
			// Should show Feature without ACTIVE indicator
			expect(screen.getByText('Feature')).toBeInTheDocument();
			expect(screen.queryByText('ACTIVE')).not.toBeInTheDocument();
		});

		it('handles rapid search input changes', () => {
			render(
				<TabSearchModal
					isOpen={true}
					tabs={defaultTabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onClose={mockOnClose}
				/>
			);
			const input = screen.getByPlaceholderText(/Search.*tabs/);

			// Rapid changes
			fireEvent.change(input, { target: { value: 'M' } });
			fireEvent.change(input, { target: { value: 'Ma' } });
			fireEvent.change(input, { target: { value: 'Mai' } });
			fireEvent.change(input, { target: { value: 'Main' } });

			expect(input).toHaveValue('Main');
			expect(screen.getByText('Main')).toBeInTheDocument();
			expect(screen.queryByText('Feature')).not.toBeInTheDocument();
		});

		it('handles search matching partial agentSessionId', () => {
			render(
				<TabSearchModal
					isOpen={true}
					tabs={defaultTabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onClose={mockOnClose}
				/>
			);
			const input = screen.getByPlaceholderText(/Search.*tabs/);
			// Search for partial session ID that matches 'def67890' in Feature tab
			fireEvent.change(input, { target: { value: '67890' } });
			expect(screen.getByText('Feature')).toBeInTheDocument();
			expect(screen.queryByText('Main')).not.toBeInTheDocument();
		});

		it('handles multiple rapid select actions', () => {
			render(
				<TabSearchModal
					isOpen={true}
					tabs={defaultTabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onClose={mockOnClose}
				/>
			);
			const featureButton = screen.getByText('Feature').closest('button');

			// Rapid clicks
			fireEvent.click(featureButton!);
			fireEvent.click(featureButton!);
			fireEvent.click(featureButton!);

			// Should still work
			expect(mockOnSelectTab).toHaveBeenCalledTimes(3);
			expect(mockOnClose).toHaveBeenCalledTimes(3);
		});

		it('filters correctly with mixed case in both search and names', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'MixedCase', agentSessionId: 'UPPER-lower-123' }),
			];
			render(
				<TabSearchModal
					isOpen={true}
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onClose={mockOnClose}
				/>
			);
			const input = screen.getByPlaceholderText(/Search.*tabs/);

			// Search with different case
			fireEvent.change(input, { target: { value: 'mixedcase' } });
			expect(screen.getByText('MixedCase')).toBeInTheDocument();

			// Search session ID with different case
			fireEvent.change(input, { target: { value: 'upper' } });
			expect(screen.getByText('MixedCase')).toBeInTheDocument();
		});
	});

	// ============================================================
	// Integration scenarios
	// ============================================================
	describe('Integration scenarios', () => {
		it('complete search and select flow', () => {
			render(
				<TabSearchModal
					isOpen={true}
					tabs={defaultTabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onClose={mockOnClose}
				/>
			);

			// 1. Initial state - all tabs visible
			expect(screen.getByText('Main')).toBeInTheDocument();
			expect(screen.getByText('Feature')).toBeInTheDocument();
			expect(screen.getByText('Tests')).toBeInTheDocument();

			// 2. Search
			const input = screen.getByPlaceholderText(/Search.*tabs/);
			fireEvent.change(input, { target: { value: 'Test' } });
			expect(screen.queryByText('Main')).not.toBeInTheDocument();
			expect(screen.queryByText('Feature')).not.toBeInTheDocument();
			expect(screen.getByText('Tests')).toBeInTheDocument();

			// 3. Select filtered tab
			const testsButton = screen.getByText('Tests').closest('button');
			fireEvent.click(testsButton!);

			// 4. Verify callbacks
			expect(mockOnSelectTab).toHaveBeenCalledWith('tab-3');
			expect(mockOnClose).toHaveBeenCalled();
		});

		it('search -> clear -> search flow', () => {
			render(
				<TabSearchModal
					isOpen={true}
					tabs={defaultTabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onClose={mockOnClose}
				/>
			);

			const input = screen.getByPlaceholderText(/Search.*tabs/);

			// Search
			fireEvent.change(input, { target: { value: 'Main' } });
			expect(screen.getByText('Main')).toBeInTheDocument();
			expect(screen.queryByText('Feature')).not.toBeInTheDocument();

			// Clear
			const clearButton = screen.getByText('×');
			fireEvent.click(clearButton);
			expect(screen.getByText('Main')).toBeInTheDocument();
			expect(screen.getByText('Feature')).toBeInTheDocument();
			expect(screen.getByText('Tests')).toBeInTheDocument();

			// Search again
			fireEvent.change(input, { target: { value: 'Feature' } });
			expect(screen.queryByText('Main')).not.toBeInTheDocument();
			expect(screen.getByText('Feature')).toBeInTheDocument();
		});

		it('escape during search clears and closes', () => {
			render(
				<TabSearchModal
					isOpen={true}
					tabs={defaultTabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onClose={mockOnClose}
				/>
			);

			const input = screen.getByPlaceholderText(/Search.*tabs/);
			fireEvent.change(input, { target: { value: 'test' } });

			// Press escape
			fireEvent.keyDown(document, { key: 'Escape' });

			expect(mockOnClose).toHaveBeenCalled();
		});

		it('shows all tab states correctly', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Idle', state: 'idle', starred: false }),
				createTab({ id: 'tab-2', name: 'Busy', state: 'busy', starred: true }),
				createTab({ id: 'tab-3', name: 'Also Idle', state: 'idle', starred: true }),
			];
			render(
				<TabSearchModal
					isOpen={true}
					tabs={tabs}
					activeTabId="tab-2"
					onSelectTab={mockOnSelectTab}
					onClose={mockOnClose}
				/>
			);

			// All tabs render
			expect(screen.getByText('Idle')).toBeInTheDocument();
			expect(screen.getByText('Busy')).toBeInTheDocument();
			expect(screen.getByText('Also Idle')).toBeInTheDocument();

			// Busy has ACTIVE indicator
			expect(screen.getByText('ACTIVE')).toBeInTheDocument();

			// 2 starred tabs
			expect(screen.getAllByText('★')).toHaveLength(2);

			// Busy state has animation
			const busyButton = screen.getByText('Busy').closest('button');
			const busyDot = busyButton?.querySelector('span[style*="animation"]');
			expect(busyDot).toHaveStyle({ animation: 'pulse 1.5s infinite' });
		});
	});

	// ============================================================
	// Export verification
	// ============================================================
	describe('Exports', () => {
		it('exports TabSearchModal as named export', async () => {
			const module = await import('../../../web/mobile/TabSearchModal');
			expect(module.TabSearchModal).toBeDefined();
		});

		it('exports TabSearchModal as default export', async () => {
			const module = await import('../../../web/mobile/TabSearchModal');
			expect(module.default).toBe(module.TabSearchModal);
		});
	});
});
