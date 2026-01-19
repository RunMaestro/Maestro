/**
 * Tests for TabBar component
 *
 * @module TabBar.test
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { TabBar } from '../../../web/mobile/TabBar';
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

describe('TabBar', () => {
	const defaultTab: AITabData = {
		id: 'tab-1',
		name: 'Main',
		agentSessionId: 'abc12345-6789-0def-ghij-klmnopqrstuv',
		state: 'idle',
		starred: false,
	};

	const createTab = (overrides: Partial<AITabData> & { id: string }): AITabData => ({
		name: '',
		agentSessionId: '',
		state: 'idle',
		starred: false,
		...overrides,
	});

	let mockOnSelectTab: ReturnType<typeof vi.fn>;
	let mockOnNewTab: ReturnType<typeof vi.fn>;
	let mockOnCloseTab: ReturnType<typeof vi.fn>;
	let mockOnOpenTabSearch: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockOnSelectTab = vi.fn();
		mockOnNewTab = vi.fn();
		mockOnCloseTab = vi.fn();
		mockOnOpenTabSearch = vi.fn();
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
	});

	describe('Render conditions', () => {
		it('returns null when tabs array is empty', () => {
			const { container } = render(
				<TabBar
					tabs={[]}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);
			expect(container.firstChild).toBeNull();
		});

		it('returns null when there is only one tab', () => {
			const { container } = render(
				<TabBar
					tabs={[defaultTab]}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);
			expect(container.firstChild).toBeNull();
		});

		it('renders when there are two or more tabs', () => {
			const tabs = [defaultTab, createTab({ id: 'tab-2', name: 'Second' })];
			const { container } = render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);
			expect(container.firstChild).not.toBeNull();
		});

		it('renders multiple tabs correctly', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'First' }),
				createTab({ id: 'tab-2', name: 'Second' }),
				createTab({ id: 'tab-3', name: 'Third' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);
			expect(screen.getByText('First')).toBeInTheDocument();
			expect(screen.getByText('Second')).toBeInTheDocument();
			expect(screen.getByText('Third')).toBeInTheDocument();
		});
	});

	describe('Tab display name', () => {
		it('displays tab.name when provided', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'MyCustomName' }),
				createTab({ id: 'tab-2', name: 'Other' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);
			expect(screen.getByText('MyCustomName')).toBeInTheDocument();
		});

		it('displays agentSessionId first segment in uppercase when name is empty', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: '', agentSessionId: 'abc12345-6789-0def' }),
				createTab({ id: 'tab-2', name: 'Other' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);
			expect(screen.getByText('ABC12345')).toBeInTheDocument();
		});

		it('displays "New" when both name and agentSessionId are empty', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: '', agentSessionId: '' }),
				createTab({ id: 'tab-2', name: 'Other' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);
			expect(screen.getByText('New')).toBeInTheDocument();
		});

		it('displays "New" when name is empty and agentSessionId is undefined', () => {
			const tabs = [
				{ id: 'tab-1', name: '', state: 'idle' as const, starred: false },
				createTab({ id: 'tab-2', name: 'Other' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);
			expect(screen.getByText('New')).toBeInTheDocument();
		});

		it('handles agentSessionId without dashes', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: '', agentSessionId: 'simpleId' }),
				createTab({ id: 'tab-2', name: 'Other' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);
			expect(screen.getByText('SIMPLEID')).toBeInTheDocument();
		});
	});

	describe('Active tab styling', () => {
		it('applies active styling to the selected tab', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Active' }),
				createTab({ id: 'tab-2', name: 'Inactive' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);
			const activeButton = screen.getByText('Active').closest('button');
			expect(activeButton).toHaveStyle({ fontWeight: '600' });
		});

		it('applies inactive styling to non-selected tabs', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Active' }),
				createTab({ id: 'tab-2', name: 'Inactive' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);
			const inactiveButton = screen.getByText('Inactive').closest('button');
			expect(inactiveButton).toHaveStyle({ fontWeight: '400' });
		});

		it('sets active tab z-index to 1', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Active' }),
				createTab({ id: 'tab-2', name: 'Inactive' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);
			const activeButton = screen.getByText('Active').closest('button');
			expect(activeButton).toHaveStyle({ zIndex: '1' });
		});

		it('sets inactive tab z-index to 0', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Active' }),
				createTab({ id: 'tab-2', name: 'Inactive' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);
			const inactiveButton = screen.getByText('Inactive').closest('button');
			expect(inactiveButton).toHaveStyle({ zIndex: '0' });
		});
	});

	describe('Hover state', () => {
		it('changes background on mouse enter for inactive tab', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Active' }),
				createTab({ id: 'tab-2', name: 'Inactive' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);
			const inactiveButton = screen.getByText('Inactive').closest('button');

			// Hover
			fireEvent.mouseEnter(inactiveButton!);
			expect(inactiveButton).toHaveStyle({ backgroundColor: 'rgba(255, 255, 255, 0.08)' });
		});

		it('resets background on mouse leave for inactive tab', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Active' }),
				createTab({ id: 'tab-2', name: 'Inactive' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);
			const inactiveButton = screen.getByText('Inactive').closest('button');

			fireEvent.mouseEnter(inactiveButton!);
			// Get the hovered background
			const hoveredBg = inactiveButton?.style.backgroundColor;
			expect(hoveredBg).toBe('rgba(255, 255, 255, 0.08)');

			fireEvent.mouseLeave(inactiveButton!);
			// After mouse leave, background should change back (not the hovered state)
			const afterLeaveBg = inactiveButton?.style.backgroundColor;
			expect(afterLeaveBg).not.toBe('rgba(255, 255, 255, 0.08)');
		});

		it('does not change background for active tab on hover', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Active' }),
				createTab({ id: 'tab-2', name: 'Inactive' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);
			const activeButton = screen.getByText('Active').closest('button');

			fireEvent.mouseEnter(activeButton!);
			expect(activeButton).toHaveStyle({ backgroundColor: mockColors.bgMain });
		});
	});

	describe('Close button', () => {
		it('shows close button for active tab', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Active' }),
				createTab({ id: 'tab-2', name: 'Inactive' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);
			const activeButton = screen.getByText('Active').closest('button');
			const closeButton = within(activeButton!).getByText('×');
			expect(closeButton).toBeInTheDocument();
		});

		it('shows close button on hover for inactive tab', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Active' }),
				createTab({ id: 'tab-2', name: 'Inactive' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);
			const inactiveButton = screen.getByText('Inactive').closest('button');

			// Before hover - no close button
			expect(within(inactiveButton!).queryByText('×')).not.toBeInTheDocument();

			// Hover - close button appears
			fireEvent.mouseEnter(inactiveButton!);
			expect(within(inactiveButton!).getByText('×')).toBeInTheDocument();
		});

		it('hides close button when mouse leaves inactive tab', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Active' }),
				createTab({ id: 'tab-2', name: 'Inactive' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);
			const inactiveButton = screen.getByText('Inactive').closest('button');

			fireEvent.mouseEnter(inactiveButton!);
			fireEvent.mouseLeave(inactiveButton!);

			expect(within(inactiveButton!).queryByText('×')).not.toBeInTheDocument();
		});

		it('calls onCloseTab with correct tab id when close button clicked', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Active' }),
				createTab({ id: 'tab-2', name: 'Inactive' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);
			const activeButton = screen.getByText('Active').closest('button');
			const closeButton = within(activeButton!).getByText('×');

			fireEvent.click(closeButton);

			expect(mockOnCloseTab).toHaveBeenCalledTimes(1);
			expect(mockOnCloseTab).toHaveBeenCalledWith('tab-1');
		});

		it('stops propagation when close button clicked (does not select tab)', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Active' }),
				createTab({ id: 'tab-2', name: 'Inactive' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);
			const activeButton = screen.getByText('Active').closest('button');
			const closeButton = within(activeButton!).getByText('×');

			mockOnSelectTab.mockClear();
			fireEvent.click(closeButton);

			// onSelectTab should not be called
			expect(mockOnSelectTab).not.toHaveBeenCalled();
		});
	});

	describe('Busy indicator', () => {
		it('shows pulsing dot for busy tab', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Busy Tab', state: 'busy' }),
				createTab({ id: 'tab-2', name: 'Idle Tab' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);

			const busyButton = screen.getByText('Busy Tab').closest('button');
			const dot = busyButton?.querySelector('span[style*="animation"]');
			expect(dot).toBeInTheDocument();
			expect(dot).toHaveStyle({ animation: 'pulse 1.5s infinite' });
		});

		it('does not show pulsing dot for idle tab', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Idle Tab', state: 'idle' }),
				createTab({ id: 'tab-2', name: 'Other' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);

			const idleButton = screen.getByText('Idle Tab').closest('button');
			const dot = idleButton?.querySelector('span[style*="animation"]');
			expect(dot).not.toBeInTheDocument();
		});

		it('does not show pulsing dot for error tab', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Error Tab', state: 'error' }),
				createTab({ id: 'tab-2', name: 'Other' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);

			const errorButton = screen.getByText('Error Tab').closest('button');
			const dot = errorButton?.querySelector('span[style*="animation"]');
			expect(dot).not.toBeInTheDocument();
		});

		it('dot uses warning color', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Busy Tab', state: 'busy' }),
				createTab({ id: 'tab-2', name: 'Other' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);

			const busyButton = screen.getByText('Busy Tab').closest('button');
			const dot = busyButton?.querySelector('span[style*="animation"]');
			expect(dot).toHaveStyle({ backgroundColor: mockColors.warning });
		});
	});

	describe('Starred indicator', () => {
		it('shows star for starred tab', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Starred', starred: true }),
				createTab({ id: 'tab-2', name: 'Not Starred' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);

			expect(screen.getByText('★')).toBeInTheDocument();
		});

		it('does not show star for non-starred tab', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Not Starred', starred: false }),
				createTab({ id: 'tab-2', name: 'Other' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);

			expect(screen.queryByText('★')).not.toBeInTheDocument();
		});

		it('star uses warning color', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Starred', starred: true }),
				createTab({ id: 'tab-2', name: 'Other' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);

			const star = screen.getByText('★');
			expect(star).toHaveStyle({ color: mockColors.warning });
		});

		it('shows both star and busy indicator when both are true', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Both', starred: true, state: 'busy' }),
				createTab({ id: 'tab-2', name: 'Other' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);

			expect(screen.getByText('★')).toBeInTheDocument();
			const bothButton = screen.getByText('Both').closest('button');
			const dot = bothButton?.querySelector('span[style*="animation"]');
			expect(dot).toBeInTheDocument();
		});
	});

	describe('Tab selection', () => {
		it('calls onSelectTab with correct tab id when clicked', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'First' }),
				createTab({ id: 'tab-2', name: 'Second' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);

			const secondTab = screen.getByText('Second').closest('button');
			fireEvent.click(secondTab!);

			expect(mockOnSelectTab).toHaveBeenCalledTimes(1);
			expect(mockOnSelectTab).toHaveBeenCalledWith('tab-2');
		});

		it('allows clicking already active tab', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'First' }),
				createTab({ id: 'tab-2', name: 'Second' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);

			const firstTab = screen.getByText('First').closest('button');
			fireEvent.click(firstTab!);

			expect(mockOnSelectTab).toHaveBeenCalledWith('tab-1');
		});
	});

	describe('New tab button', () => {
		it('renders new tab button', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'First' }),
				createTab({ id: 'tab-2', name: 'Second' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);

			expect(screen.getByTitle('New Tab')).toBeInTheDocument();
		});

		it('displays + icon (SVG)', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'First' }),
				createTab({ id: 'tab-2', name: 'Second' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);

			const newTabButton = screen.getByTitle('New Tab');
			// The + icon is rendered as an SVG, not text
			const svg = newTabButton.querySelector('svg');
			expect(svg).toBeInTheDocument();
			// SVG has two lines forming a plus sign
			const lines = svg?.querySelectorAll('line');
			expect(lines).toHaveLength(2);
		});

		it('calls onNewTab when clicked', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'First' }),
				createTab({ id: 'tab-2', name: 'Second' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);

			fireEvent.click(screen.getByTitle('New Tab'));

			expect(mockOnNewTab).toHaveBeenCalledTimes(1);
		});
	});

	describe('Search tabs button', () => {
		it('renders search button when onOpenTabSearch is provided', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'First' }),
				createTab({ id: 'tab-2', name: 'Second' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
					onOpenTabSearch={mockOnOpenTabSearch}
				/>
			);

			expect(screen.getByTitle('Search 2 tabs')).toBeInTheDocument();
		});

		it('does not render search button when onOpenTabSearch is not provided', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'First' }),
				createTab({ id: 'tab-2', name: 'Second' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);

			expect(screen.queryByTitle(/Search/)).not.toBeInTheDocument();
		});

		it('shows correct tab count in search button title', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'First' }),
				createTab({ id: 'tab-2', name: 'Second' }),
				createTab({ id: 'tab-3', name: 'Third' }),
				createTab({ id: 'tab-4', name: 'Fourth' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
					onOpenTabSearch={mockOnOpenTabSearch}
				/>
			);

			expect(screen.getByTitle('Search 4 tabs')).toBeInTheDocument();
		});

		it('calls onOpenTabSearch when clicked', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'First' }),
				createTab({ id: 'tab-2', name: 'Second' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
					onOpenTabSearch={mockOnOpenTabSearch}
				/>
			);

			fireEvent.click(screen.getByTitle('Search 2 tabs'));

			expect(mockOnOpenTabSearch).toHaveBeenCalledTimes(1);
		});

		it('contains magnifying glass SVG icon', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'First' }),
				createTab({ id: 'tab-2', name: 'Second' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
					onOpenTabSearch={mockOnOpenTabSearch}
				/>
			);

			const searchButton = screen.getByTitle('Search 2 tabs');
			expect(searchButton.querySelector('svg')).toBeInTheDocument();
			expect(searchButton.querySelector('circle')).toBeInTheDocument();
			expect(searchButton.querySelector('line')).toBeInTheDocument();
		});
	});

	describe('Container styling', () => {
		it('applies bgSidebar background color', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'First' }),
				createTab({ id: 'tab-2', name: 'Second' }),
			];
			const { container } = render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);

			expect(container.firstChild).toHaveStyle({ backgroundColor: mockColors.bgSidebar });
		});

		it('has border bottom', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'First' }),
				createTab({ id: 'tab-2', name: 'Second' }),
			];
			const { container } = render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);

			expect(container.firstChild).toHaveStyle({
				borderBottom: `1px solid ${mockColors.border}`,
			});
		});

		it('includes hide-scrollbar class for scrollable area', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'First' }),
				createTab({ id: 'tab-2', name: 'Second' }),
			];
			const { container } = render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);

			expect(container.querySelector('.hide-scrollbar')).toBeInTheDocument();
		});
	});

	describe('CSS animations', () => {
		it('includes style element with keyframes', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'First' }),
				createTab({ id: 'tab-2', name: 'Second' }),
			];
			const { container } = render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);

			const styleElement = container.querySelector('style');
			expect(styleElement).toBeInTheDocument();
			expect(styleElement?.textContent).toContain('@keyframes pulse');
			expect(styleElement?.textContent).toContain('.hide-scrollbar');
		});
	});

	describe('Edge cases', () => {
		it('handles empty tab name with special characters in agentSessionId', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: '', agentSessionId: 'αβγ-δεζ' }),
				createTab({ id: 'tab-2', name: 'Other' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);
			expect(screen.getByText('ΑΒΓ')).toBeInTheDocument();
		});

		it('handles very long tab names (text overflow)', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'This is a very long tab name that should be truncated' }),
				createTab({ id: 'tab-2', name: 'Other' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);
			const longName = screen.getByText('This is a very long tab name that should be truncated');
			expect(longName).toHaveStyle({ overflow: 'hidden', textOverflow: 'ellipsis' });
		});

		it('handles XSS-like characters in tab names', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: '<script>alert("xss")</script>' }),
				createTab({ id: 'tab-2', name: 'Other' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);
			expect(screen.getByText('<script>alert("xss")</script>')).toBeInTheDocument();
		});

		it('handles unicode emojis in tab names', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: '🎵 Music Tab 🎶' }),
				createTab({ id: 'tab-2', name: 'Other' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);
			expect(screen.getByText('🎵 Music Tab 🎶')).toBeInTheDocument();
		});

		it('handles rapid tab switches', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'First' }),
				createTab({ id: 'tab-2', name: 'Second' }),
				createTab({ id: 'tab-3', name: 'Third' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);

			fireEvent.click(screen.getByText('Second').closest('button')!);
			fireEvent.click(screen.getByText('Third').closest('button')!);
			fireEvent.click(screen.getByText('First').closest('button')!);

			expect(mockOnSelectTab).toHaveBeenCalledTimes(3);
			expect(mockOnSelectTab).toHaveBeenNthCalledWith(1, 'tab-2');
			expect(mockOnSelectTab).toHaveBeenNthCalledWith(2, 'tab-3');
			expect(mockOnSelectTab).toHaveBeenNthCalledWith(3, 'tab-1');
		});

		it('handles many tabs', () => {
			const tabs = Array.from({ length: 20 }, (_, i) =>
				createTab({ id: `tab-${i}`, name: `Tab ${i}` })
			);
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-0"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);

			// All tabs should render
			for (let i = 0; i < 20; i++) {
				expect(screen.getByText(`Tab ${i}`)).toBeInTheDocument();
			}
		});

		it('handles tab with connecting state', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Connecting', state: 'connecting' }),
				createTab({ id: 'tab-2', name: 'Other' }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);

			// Connecting state should not show busy dot
			const connectingButton = screen.getByText('Connecting').closest('button');
			const dot = connectingButton?.querySelector('span[style*="animation"]');
			expect(dot).not.toBeInTheDocument();
		});

		it('handles mixed tab states in same bar', () => {
			const tabs = [
				createTab({ id: 'tab-1', name: 'Busy', state: 'busy', starred: true }),
				createTab({ id: 'tab-2', name: 'Idle', state: 'idle', starred: false }),
				createTab({ id: 'tab-3', name: 'Error', state: 'error', starred: true }),
			];
			render(
				<TabBar
					tabs={tabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);

			expect(screen.getByText('Busy')).toBeInTheDocument();
			expect(screen.getByText('Idle')).toBeInTheDocument();
			expect(screen.getByText('Error')).toBeInTheDocument();
			// 2 starred tabs
			expect(screen.getAllByText('★')).toHaveLength(2);
		});
	});

	describe('Default export', () => {
		it('exports TabBar as default', async () => {
			const module = await import('../../../web/mobile/TabBar');
			expect(module.default).toBe(module.TabBar);
		});
	});
});
