/**
 * Tests for TabBar component
 *
 * @module TabBar.test
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react';
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

// Mock useLongPress to make it testable without real touch events
let capturedOnLongPress: ((rect: DOMRect) => void) | undefined;
let capturedOnTap: (() => void) | undefined;
vi.mock('../../../web/hooks/useLongPress', () => ({
	useLongPress: ({
		onLongPress,
		onTap,
	}: {
		onLongPress: (rect: DOMRect) => void;
		onTap?: () => void;
	}) => {
		capturedOnLongPress = onLongPress;
		capturedOnTap = onTap;
		const elementRef = { current: null };
		return {
			elementRef,
			handlers: {
				onTouchStart: () => {},
				onTouchMove: () => {},
				onTouchEnd: () => {},
				onTouchCancel: () => {},
			},
			handleClick: () => onTap?.(),
			handleContextMenu: (e: React.MouseEvent) => {
				e.preventDefault();
				const target = e.currentTarget as HTMLElement;
				onLongPress(target.getBoundingClientRect());
			},
		};
	},
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
	let mockOnRenameTab: ReturnType<typeof vi.fn>;
	let mockOnStarTab: ReturnType<typeof vi.fn>;
	let mockOnReorderTab: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockOnSelectTab = vi.fn();
		mockOnNewTab = vi.fn();
		mockOnCloseTab = vi.fn();
		mockOnOpenTabSearch = vi.fn();
		mockOnRenameTab = vi.fn();
		mockOnStarTab = vi.fn();
		mockOnReorderTab = vi.fn();
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
	});

	describe('Render conditions', () => {
		it('renders tab bar chrome even when tabs array is empty', () => {
			const { container } = render(
				<TabBar
					tabs={[]}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);
			expect(container.firstChild).not.toBeNull();
		});

		it('renders tab bar chrome with a single tab', () => {
			const { container } = render(
				<TabBar
					tabs={[defaultTab]}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);
			expect(container.firstChild).not.toBeNull();
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
			expect(activeButton).toHaveClass('font-semibold');
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
			expect(inactiveButton).toHaveClass('font-normal');
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
			// Tailwind arbitrary value `z-[1]` preserves the exact legacy z-index
			// while Tailwind's preset `z-0` handles the inactive case below.
			expect(activeButton).toHaveClass('z-[1]');
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
			expect(inactiveButton).toHaveClass('z-0');
		});
	});

	describe('Hover state', () => {
		it('applies Tailwind hover class to inactive tab for hover tint', () => {
			// Phase 2.2 moved the inactive-tab hover tint from React state to a CSS
			// rule. Phase 2.3 migrated it further onto the Tailwind `hover:` utility
			// so the rule sits on the element rather than in a standalone <style>
			// block. Mouse events no longer mutate inline style in any form.
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
			const inactiveButton = screen.getByText('Inactive').closest('button')!;

			expect(inactiveButton).toHaveClass('hover:bg-text-main/[0.08]');
			expect(inactiveButton).toHaveClass('bg-transparent');

			// Mouse events must not mutate inline style — the Tailwind `hover:`
			// utility handles the tint and jsdom does not fire real `:hover`
			// matches anyway, so inline `style` should stay absent throughout.
			const initialStyle = inactiveButton.getAttribute('style') ?? '';
			fireEvent.mouseEnter(inactiveButton);
			expect(inactiveButton.getAttribute('style') ?? '').toBe(initialStyle);
			fireEvent.mouseLeave(inactiveButton);
			expect(inactiveButton.getAttribute('style') ?? '').toBe(initialStyle);
		});

		it('keeps the active tab background class untouched by mouse events', () => {
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
			const activeButton = screen.getByText('Active').closest('button')!;

			expect(activeButton).toHaveClass('bg-bg-main');
			// Active tab never applies the inactive hover tint class.
			expect(activeButton).not.toHaveClass('hover:bg-text-main/[0.08]');

			fireEvent.mouseEnter(activeButton);
			expect(activeButton).toHaveClass('bg-bg-main');
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
			// Close button is a sibling button with aria-label, inside the same wrapper div
			const tabWrapper = screen.getByText('Active').closest('button')!.parentElement!;
			const closeButton = within(tabWrapper).getByLabelText('Close tab');
			expect(closeButton).toBeInTheDocument();
		});

		it('always renders close button for inactive tabs (touch reachability)', () => {
			// Phase 2.2: the `×` must be in the DOM at every viewport tier so
			// touch users can reach it without hovering. Phase 2.3 keeps the
			// desktop-only hover reveal, now expressed as Tailwind
			// `group-hover:` / `group-focus-within:` utilities on the close
			// button keyed off the `group` class on the row wrapper.
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
			const inactiveButton = screen.getByText('Inactive').closest('button')!;
			const tabWrapper = inactiveButton.parentElement!;

			// Close button present even before any hover event.
			const closeButton = within(tabWrapper).getByLabelText('Close tab');
			expect(closeButton).toBeInTheDocument();
			// Row wrapper is a Tailwind `group` so the close button's
			// `min-[960px]:group-hover:*` utilities can key off row hover.
			expect(tabWrapper).toHaveClass('group');
			// Close button carries the desktop-only hide + group-hover reveal
			// utilities when sitting on an inactive tab.
			expect(closeButton.className).toMatch(/min-\[960px\]:opacity-0/);
			expect(closeButton.className).toMatch(/min-\[960px\]:group-hover:opacity-100/);

			// Mouse events must not toggle DOM presence any more.
			fireEvent.mouseEnter(inactiveButton);
			fireEvent.mouseLeave(inactiveButton);
			expect(within(tabWrapper).getByLabelText('Close tab')).toBeInTheDocument();
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
			const tabWrapper = screen.getByText('Active').closest('button')!.parentElement!;
			const closeButton = within(tabWrapper).getByLabelText('Close tab');

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
			const tabWrapper = screen.getByText('Active').closest('button')!.parentElement!;
			const closeButton = within(tabWrapper).getByLabelText('Close tab');

			mockOnSelectTab.mockClear();
			fireEvent.click(closeButton);

			// onSelectTab should not be called
			expect(mockOnSelectTab).not.toHaveBeenCalled();
		});
	});

	describe('Busy indicator', () => {
		// Phase 2.3 migrated the busy dot from inline styles to Tailwind classes,
		// including an arbitrary `[animation:pulse_1.5s_infinite]` utility. The
		// `.bg-warning` class sits on that same span and uniquely identifies the
		// dot (the star icon uses `text-warning`, not `bg-warning`).
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
			const dot = busyButton?.querySelector('.bg-warning');
			expect(dot).toBeInTheDocument();
			// Arbitrary Tailwind utility carries the animation declaration.
			expect(dot?.className).toContain('[animation:pulse_1.5s_infinite]');
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
			const dot = idleButton?.querySelector('.bg-warning');
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
			const dot = errorButton?.querySelector('.bg-warning');
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
			const dot = busyButton?.querySelector('.bg-warning');
			expect(dot).toHaveClass('bg-warning');
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
			expect(star).toHaveClass('text-warning');
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
			const dot = bothButton?.querySelector('.bg-warning');
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

		it('calls onNewTab when New AI Chat is selected from the menu', () => {
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

			// Click the "New Tab" button to open the dropdown menu
			fireEvent.click(screen.getByTitle('New Tab'));

			// Then click "New AI Chat" in the dropdown
			fireEvent.click(screen.getByText('New AI Chat'));

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
		it('applies bg-bg-sidebar background class', () => {
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

			expect(container.firstChild).toHaveClass('bg-bg-sidebar');
		});

		it('has bottom border classes', () => {
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

			expect(container.firstChild).toHaveClass('border-b', 'border-border');
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
			expect(longName).toHaveClass('overflow-hidden', 'text-ellipsis');
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
			const dot = connectingButton?.querySelector('.bg-warning');
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

	describe('Tab actions popover', () => {
		const twoTabs = [
			createTab({ id: 'tab-1', name: 'First', starred: false }),
			createTab({ id: 'tab-2', name: 'Second', starred: false }),
		];

		const threeTabs = [
			createTab({ id: 'tab-1', name: 'First', starred: false }),
			createTab({ id: 'tab-2', name: 'Second', starred: true }),
			createTab({ id: 'tab-3', name: 'Third', starred: false }),
		];

		const renderWithActions = (tabs: AITabData[], activeTabId = 'tab-1') =>
			render(
				<TabBar
					tabs={tabs}
					activeTabId={activeTabId}
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
					onRenameTab={mockOnRenameTab}
					onStarTab={mockOnStarTab}
					onReorderTab={mockOnReorderTab}
				/>
			);

		const openPopoverViaContextMenu = (tabName: string) => {
			const tabButton = screen.getByText(tabName).closest('button')!;
			fireEvent.contextMenu(tabButton);
		};

		it('opens popover on context menu (right-click)', () => {
			renderWithActions(twoTabs);
			openPopoverViaContextMenu('First');
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});

		it('shows tab name in popover header', () => {
			renderWithActions(twoTabs);
			openPopoverViaContextMenu('First');
			const dialog = screen.getByRole('dialog');
			expect(within(dialog).getByText('First')).toBeInTheDocument();
		});

		it('shows Star action for unstarred tab', () => {
			renderWithActions(twoTabs);
			openPopoverViaContextMenu('First');
			expect(screen.getByText('Star')).toBeInTheDocument();
		});

		it('shows Unstar action for starred tab', () => {
			renderWithActions(threeTabs);
			openPopoverViaContextMenu('Second');
			expect(screen.getByText('Unstar')).toBeInTheDocument();
		});

		it('calls onStarTab when Star is clicked', () => {
			renderWithActions(twoTabs);
			openPopoverViaContextMenu('First');
			fireEvent.click(screen.getByText('Star'));
			expect(mockOnStarTab).toHaveBeenCalledWith('tab-1', true);
		});

		it('calls onStarTab with false when Unstar is clicked', () => {
			renderWithActions(threeTabs);
			openPopoverViaContextMenu('Second');
			fireEvent.click(screen.getByText('Unstar'));
			expect(mockOnStarTab).toHaveBeenCalledWith('tab-2', false);
		});

		it('shows Rename action', () => {
			renderWithActions(twoTabs);
			openPopoverViaContextMenu('First');
			expect(screen.getByText('Rename')).toBeInTheDocument();
		});

		it('switches to rename input view when Rename is clicked', () => {
			renderWithActions(twoTabs);
			openPopoverViaContextMenu('First');
			fireEvent.click(screen.getByText('Rename'));
			expect(screen.getByPlaceholderText('Tab name')).toBeInTheDocument();
			expect(screen.getByText('Save')).toBeInTheDocument();
			expect(screen.getByText('Cancel')).toBeInTheDocument();
		});

		it('calls onRenameTab when Save is clicked in rename view', () => {
			renderWithActions(twoTabs);
			openPopoverViaContextMenu('First');
			fireEvent.click(screen.getByText('Rename'));

			const input = screen.getByPlaceholderText('Tab name');
			fireEvent.change(input, { target: { value: 'Renamed Tab' } });
			fireEvent.click(screen.getByText('Save'));

			expect(mockOnRenameTab).toHaveBeenCalledWith('tab-1', 'Renamed Tab');
		});

		it('returns to action list when Cancel is clicked in rename view', () => {
			renderWithActions(twoTabs);
			openPopoverViaContextMenu('First');
			fireEvent.click(screen.getByText('Rename'));

			// Should be in rename view
			expect(screen.getByPlaceholderText('Tab name')).toBeInTheDocument();

			fireEvent.click(screen.getByText('Cancel'));

			// Should be back to action list
			expect(screen.queryByPlaceholderText('Tab name')).not.toBeInTheDocument();
			expect(screen.getByText('Star')).toBeInTheDocument();
		});

		it('shows Move Left and Move Right actions', () => {
			renderWithActions(threeTabs);
			openPopoverViaContextMenu('Second');
			expect(screen.getByText('Move Left')).toBeInTheDocument();
			expect(screen.getByText('Move Right')).toBeInTheDocument();
		});

		it('disables Move Left for first tab', () => {
			renderWithActions(threeTabs);
			openPopoverViaContextMenu('First');
			const moveLeft = screen.getByText('Move Left').closest('button')!;
			expect(moveLeft).toBeDisabled();
		});

		it('disables Move Right for last tab', () => {
			renderWithActions(threeTabs);
			openPopoverViaContextMenu('Third');
			const moveRight = screen.getByText('Move Right').closest('button')!;
			expect(moveRight).toBeDisabled();
		});

		it('calls onReorderTab when Move Left is clicked on middle tab', () => {
			renderWithActions(threeTabs);
			openPopoverViaContextMenu('Second');
			fireEvent.click(screen.getByText('Move Left'));
			expect(mockOnReorderTab).toHaveBeenCalledWith(1, 0);
		});

		it('calls onReorderTab when Move Right is clicked on middle tab', () => {
			renderWithActions(threeTabs);
			openPopoverViaContextMenu('Second');
			fireEvent.click(screen.getByText('Move Right'));
			expect(mockOnReorderTab).toHaveBeenCalledWith(1, 2);
		});

		it('closes popover when backdrop is clicked', () => {
			renderWithActions(twoTabs);
			openPopoverViaContextMenu('First');
			expect(screen.getByRole('dialog')).toBeInTheDocument();

			// Click the backdrop (the div with aria-hidden="true")
			const backdrop = document.querySelector('[aria-hidden="true"]') as HTMLElement;
			fireEvent.click(backdrop);

			expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
		});

		it('closes popover when close button in header is clicked', () => {
			renderWithActions(twoTabs);
			openPopoverViaContextMenu('First');
			expect(screen.getByRole('dialog')).toBeInTheDocument();

			const dialog = screen.getByRole('dialog');
			const closeButton = within(dialog).getByLabelText('Close');
			fireEvent.click(closeButton);

			expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
		});

		it('does not show action buttons when callbacks are not provided', () => {
			render(
				<TabBar
					tabs={twoTabs}
					activeTabId="tab-1"
					onSelectTab={mockOnSelectTab}
					onNewTab={mockOnNewTab}
					onCloseTab={mockOnCloseTab}
				/>
			);
			const tabButton = screen.getByText('First').closest('button')!;
			fireEvent.contextMenu(tabButton);

			// Popover should open but without action buttons
			expect(screen.getByRole('dialog')).toBeInTheDocument();
			expect(screen.queryByText('Star')).not.toBeInTheDocument();
			expect(screen.queryByText('Rename')).not.toBeInTheDocument();
			expect(screen.queryByText('Move Left')).not.toBeInTheDocument();
			expect(screen.queryByText('Move Right')).not.toBeInTheDocument();
		});
	});

	describe('Default export', () => {
		it('exports TabBar as default', async () => {
			const module = await import('../../../web/mobile/TabBar');
			expect(module.default).toBe(module.TabBar);
		});
	});
});
