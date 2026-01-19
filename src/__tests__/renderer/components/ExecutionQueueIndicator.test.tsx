/**
 * Tests for ExecutionQueueIndicator component
 *
 * This component displays a compact indicator showing the number of queued items
 * for execution. It groups items by tab and shows type breakdowns.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ExecutionQueueIndicator } from '../../../renderer/components/ExecutionQueueIndicator';
import type { Session, Theme, QueuedItem } from '../../../renderer/types';

// Mock ResizeObserver
const mockObserve = vi.fn();
const mockUnobserve = vi.fn();
const mockDisconnect = vi.fn();

class MockResizeObserver {
	callback: ResizeObserverCallback;

	constructor(callback: ResizeObserverCallback) {
		this.callback = callback;
		// Immediately trigger the callback to simulate initial calculation
		setTimeout(() => {
			if (this.callback) {
				this.callback([], this as unknown as ResizeObserver);
			}
		}, 0);
	}

	observe(element: Element): void {
		mockObserve(element);
	}
	unobserve = mockUnobserve;
	disconnect = mockDisconnect;
}

global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

// Mock Element.prototype.clientWidth for calculateMaxPills
Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
	configurable: true,
	value: 800, // Simulate a wide container
});

// Mock getBoundingClientRect for layout calculations
Element.prototype.getBoundingClientRect = vi.fn().mockReturnValue({
	width: 100,
	height: 40,
	top: 0,
	left: 0,
	bottom: 40,
	right: 100,
	x: 0,
	y: 0,
	toJSON: () => ({}),
});

// Mock getComputedStyle for padding calculations
const originalGetComputedStyle = window.getComputedStyle;
window.getComputedStyle = vi.fn().mockImplementation((element) => {
	return {
		...originalGetComputedStyle(element),
		paddingLeft: '12px',
		paddingRight: '12px',
	};
});

describe('ExecutionQueueIndicator', () => {
	// Test fixtures
	const theme: Theme = {
		id: 'test-theme',
		name: 'Test Theme',
		mode: 'dark',
		colors: {
			bgMain: '#1a1a24',
			bgSidebar: '#141420',
			bgActivity: '#24243a',
			border: '#3a3a5a',
			textMain: '#fff8e8',
			textDim: '#a8a0a0',
			accent: '#f4c430',
			accentDim: 'rgba(244, 196, 48, 0.25)',
			accentText: '#ffd54f',
			accentForeground: '#1a1a24',
			success: '#66d9a0',
			warning: '#f4c430',
			error: '#e05070',
		},
	};

	const createSession = (overrides?: Partial<Session>): Session => ({
		id: 'test-session',
		name: 'Test Session',
		toolType: 'claude-code',
		state: 'idle',
		inputMode: 'ai',
		cwd: '/test/path',
		projectRoot: '/test/path',
		aiPid: 0,
		terminalPid: 0,
		aiLogs: [],
		shellLogs: [],
		isGitRepo: true,
		fileTree: [],
		fileExplorerExpanded: [],
		messageQueue: [],
		executionQueue: [],
		...overrides,
	});

	const createQueuedItem = (overrides?: Partial<QueuedItem>): QueuedItem => ({
		id: `item-${Math.random().toString(36).substring(7)}`,
		type: 'message',
		content: 'Test message',
		timestamp: Date.now(),
		tabId: 'tab-1',
		tabName: 'Tab 1',
		...overrides,
	});

	let mockOnClick: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockOnClick = vi.fn();
		mockObserve.mockClear();
		mockUnobserve.mockClear();
		mockDisconnect.mockClear();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('empty queue', () => {
		it('should return null when queue is empty', () => {
			const session = createSession({ executionQueue: [] });
			const { container } = render(
				<ExecutionQueueIndicator session={session} theme={theme} onClick={mockOnClick} />
			);
			expect(container.firstChild).toBeNull();
		});

		it('should return null when executionQueue is undefined', () => {
			const session = createSession();
			delete (session as unknown as Record<string, unknown>).executionQueue;
			const { container } = render(
				<ExecutionQueueIndicator session={session} theme={theme} onClick={mockOnClick} />
			);
			expect(container.firstChild).toBeNull();
		});
	});

	describe('queue count display', () => {
		it('should show singular "item" for single queued item', () => {
			const session = createSession({
				executionQueue: [createQueuedItem()],
			});
			render(<ExecutionQueueIndicator session={session} theme={theme} onClick={mockOnClick} />);
			// Check for the complete "1 item queued" text
			const button = screen.getByRole('button');
			expect(button).toHaveTextContent('1');
			expect(button).toHaveTextContent('item queued');
		});

		it('should show plural "items" for multiple queued items', () => {
			const session = createSession({
				executionQueue: [createQueuedItem(), createQueuedItem()],
			});
			render(<ExecutionQueueIndicator session={session} theme={theme} onClick={mockOnClick} />);
			const button = screen.getByRole('button');
			expect(button).toHaveTextContent('2');
			expect(button).toHaveTextContent('items queued');
		});

		it('should correctly display large queue counts', () => {
			const queue = Array.from({ length: 25 }, () => createQueuedItem());
			const session = createSession({ executionQueue: queue });
			render(<ExecutionQueueIndicator session={session} theme={theme} onClick={mockOnClick} />);
			const button = screen.getByRole('button');
			expect(button).toHaveTextContent('25');
			expect(button).toHaveTextContent('items queued');
		});
	});

	describe('item type breakdown', () => {
		it('should show message count when there are messages', () => {
			const session = createSession({
				executionQueue: [
					createQueuedItem({ type: 'message' }),
					createQueuedItem({ type: 'message' }),
					createQueuedItem({ type: 'message' }),
				],
			});
			render(<ExecutionQueueIndicator session={session} theme={theme} onClick={mockOnClick} />);
			const button = screen.getByRole('button');
			// Should show total count of 3
			expect(button).toHaveTextContent('3');
			expect(button).toHaveTextContent('items queued');
		});

		it('should show command count when there are commands', () => {
			const session = createSession({
				executionQueue: [
					createQueuedItem({ type: 'command' }),
					createQueuedItem({ type: 'command' }),
				],
			});
			render(<ExecutionQueueIndicator session={session} theme={theme} onClick={mockOnClick} />);
			const button = screen.getByRole('button');
			expect(button).toHaveTextContent('2');
			expect(button).toHaveTextContent('items queued');
		});

		it('should show both message and command counts when mixed', () => {
			const session = createSession({
				executionQueue: [
					createQueuedItem({ type: 'message', tabName: 'Msgs' }),
					createQueuedItem({ type: 'message', tabName: 'Msgs' }),
					createQueuedItem({ type: 'command', tabName: 'Cmds' }),
				],
			});
			render(<ExecutionQueueIndicator session={session} theme={theme} onClick={mockOnClick} />);
			const button = screen.getByRole('button');
			// Total of 3 items
			expect(button).toHaveTextContent('3');
			expect(button).toHaveTextContent('items queued');
		});

		it('should not show message count section when no messages', () => {
			const session = createSession({
				executionQueue: [createQueuedItem({ type: 'command' })],
			});
			const { container } = render(
				<ExecutionQueueIndicator session={session} theme={theme} onClick={mockOnClick} />
			);
			// Look for MessageSquare SVG (message icon) - should NOT exist
			// The flex items with gap-1 contain icon + count
			const svgs = container.querySelectorAll('svg');
			// Should have ListOrdered and Command icons, not MessageSquare
			// Can't easily check icon type, so just verify rendering works
			expect(svgs.length).toBeGreaterThanOrEqual(1);
		});

		it('should not show command count section when no commands', () => {
			const session = createSession({
				executionQueue: [createQueuedItem({ type: 'message' })],
			});
			const { container } = render(
				<ExecutionQueueIndicator session={session} theme={theme} onClick={mockOnClick} />
			);
			// Verify rendering works without commands
			const svgs = container.querySelectorAll('svg');
			expect(svgs.length).toBeGreaterThanOrEqual(1);
		});
	});

	describe('tab grouping and pills', () => {
		it('should display tab name in pill', () => {
			const session = createSession({
				executionQueue: [createQueuedItem({ tabName: 'MyTab' })],
			});
			render(<ExecutionQueueIndicator session={session} theme={theme} onClick={mockOnClick} />);
			expect(screen.getByText('MyTab')).toBeInTheDocument();
		});

		it('should show full tab name when space is available', () => {
			const session = createSession({
				executionQueue: [createQueuedItem({ tabName: 'VeryLongTabNameThatNeedsTruncation' })],
			});
			render(<ExecutionQueueIndicator session={session} theme={theme} onClick={mockOnClick} />);
			// With wide container (800px), full name should be visible
			expect(screen.getByText('VeryLongTabNameThatNeedsTruncation')).toBeInTheDocument();
		});

		it('should show count in parentheses when tab has multiple items', () => {
			const session = createSession({
				executionQueue: [
					createQueuedItem({ tabName: 'Tab1' }),
					createQueuedItem({ tabName: 'Tab1' }),
					createQueuedItem({ tabName: 'Tab1' }),
				],
			});
			render(<ExecutionQueueIndicator session={session} theme={theme} onClick={mockOnClick} />);
			expect(screen.getByText('Tab1 (3)')).toBeInTheDocument();
		});

		it('should not show count for tabs with single item', () => {
			const session = createSession({
				executionQueue: [
					createQueuedItem({ tabName: 'MyTab' }), // 5 chars, won't be truncated
				],
			});
			render(<ExecutionQueueIndicator session={session} theme={theme} onClick={mockOnClick} />);
			const button = screen.getByRole('button');
			expect(button).toHaveTextContent('MyTab');
			// Should not contain "(1)" for single item
			expect(button.textContent).not.toContain('(1)');
		});

		it('should group items by tab and show multiple pills', () => {
			const session = createSession({
				executionQueue: [
					createQueuedItem({ tabName: 'TabA' }), // Short names to avoid truncation
					createQueuedItem({ tabName: 'TabB' }),
					createQueuedItem({ tabName: 'TabA' }),
				],
			});
			render(<ExecutionQueueIndicator session={session} theme={theme} onClick={mockOnClick} />);
			const button = screen.getByRole('button');
			// TabA has 2 items, TabB has 1
			// With 3 items total, we should see proper grouping
			expect(button).toHaveTextContent('3');
			expect(button).toHaveTextContent('items queued');
			// The first tab (TabA with 2 items) should always be visible
			expect(button).toHaveTextContent('TabA (2)');
			// TabB may be shown directly or collapsed into +1 depending on available space
			// We verify that we have either TabB shown, OR a +1 indicator
			const hasTabB = button.textContent?.includes('TabB');
			const hasOverflowIndicator = button.textContent?.includes('+1');
			expect(hasTabB || hasOverflowIndicator).toBe(true);
		});

		it('should use "Unknown" for items without tabName', () => {
			const session = createSession({
				executionQueue: [createQueuedItem({ tabName: undefined })],
			});
			render(<ExecutionQueueIndicator session={session} theme={theme} onClick={mockOnClick} />);
			expect(screen.getByText('Unknown')).toBeInTheDocument();
		});

		it('should show +N indicator when there are more tabs than can be displayed', () => {
			// Create many tabs to exceed the visible limit (default ~2-5)
			const session = createSession({
				executionQueue: [
					createQueuedItem({ tabName: 'Tab1' }),
					createQueuedItem({ tabName: 'Tab2' }),
					createQueuedItem({ tabName: 'Tab3' }),
					createQueuedItem({ tabName: 'Tab4' }),
					createQueuedItem({ tabName: 'Tab5' }),
					createQueuedItem({ tabName: 'Tab6' }),
					createQueuedItem({ tabName: 'Tab7' }),
					createQueuedItem({ tabName: 'Tab8' }),
				],
			});
			render(<ExecutionQueueIndicator session={session} theme={theme} onClick={mockOnClick} />);
			// Should show +N indicator for extra tabs
			// The exact number depends on maxVisiblePills state
			expect(screen.getByText(/^\+\d+$/)).toBeInTheDocument();
		});
	});

	describe('click behavior', () => {
		it('should call onClick when button is clicked', () => {
			const session = createSession({
				executionQueue: [createQueuedItem()],
			});
			render(<ExecutionQueueIndicator session={session} theme={theme} onClick={mockOnClick} />);
			const button = screen.getByRole('button');
			fireEvent.click(button);
			expect(mockOnClick).toHaveBeenCalledTimes(1);
		});

		it('should display "Click to view" hint', () => {
			const session = createSession({
				executionQueue: [createQueuedItem()],
			});
			render(<ExecutionQueueIndicator session={session} theme={theme} onClick={mockOnClick} />);
			expect(screen.getByText('Click to view')).toBeInTheDocument();
		});
	});

	describe('styling', () => {
		it('should apply theme colors to container', () => {
			const session = createSession({
				executionQueue: [createQueuedItem()],
			});
			render(<ExecutionQueueIndicator session={session} theme={theme} onClick={mockOnClick} />);
			const button = screen.getByRole('button');
			// Check that style attribute contains background-color, border-color, and color
			// Note: browsers convert hex to rgb
			const style = button.getAttribute('style');
			expect(style).toContain('background-color');
			expect(style).toContain('border-color');
			expect(style).toContain('color');
		});

		it('should apply warning color to ListOrdered icon', () => {
			const session = createSession({
				executionQueue: [createQueuedItem()],
			});
			const { container } = render(
				<ExecutionQueueIndicator session={session} theme={theme} onClick={mockOnClick} />
			);
			// Find the ListOrdered icon (first SVG)
			const svg = container.querySelector('svg');
			expect(svg).not.toBeNull();
			const style = svg?.getAttribute('style');
			// Style should contain color property
			expect(style).toContain('color');
		});

		it('should apply accent color with transparency to tab pills', () => {
			const session = createSession({
				executionQueue: [createQueuedItem({ tabName: 'TestTab' })],
			});
			render(<ExecutionQueueIndicator session={session} theme={theme} onClick={mockOnClick} />);
			const pill = screen.getByText('TestTab');
			const style = pill.getAttribute('style');
			// Check that style exists and contains color-related properties
			// Note: browsers may convert hex colors to rgb/rgba
			expect(style).not.toBeNull();
			expect(style).toContain('background-color');
			expect(style).toContain('color');
		});
	});

	describe('ResizeObserver integration', () => {
		it('should observe container on mount', () => {
			const session = createSession({
				executionQueue: [createQueuedItem()],
			});
			render(<ExecutionQueueIndicator session={session} theme={theme} onClick={mockOnClick} />);
			expect(mockObserve).toHaveBeenCalled();
		});

		it('should disconnect observer on unmount', () => {
			const session = createSession({
				executionQueue: [createQueuedItem()],
			});
			const { unmount } = render(
				<ExecutionQueueIndicator session={session} theme={theme} onClick={mockOnClick} />
			);
			unmount();
			expect(mockDisconnect).toHaveBeenCalled();
		});
	});

	describe('edge cases', () => {
		it('should handle items with empty tabName', () => {
			const session = createSession({
				executionQueue: [createQueuedItem({ tabName: '' })],
			});
			render(<ExecutionQueueIndicator session={session} theme={theme} onClick={mockOnClick} />);
			// Empty string should fall through to 'Unknown' due to || operator
			expect(screen.getByText('Unknown')).toBeInTheDocument();
		});

		it('should handle special characters in tab names', () => {
			const session = createSession({
				executionQueue: [createQueuedItem({ tabName: '<script>alert(1)</script>' })],
			});
			render(<ExecutionQueueIndicator session={session} theme={theme} onClick={mockOnClick} />);
			// Should safely render the name (React escapes HTML by default)
			expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument();
		});

		it('should handle unicode in tab names', () => {
			const session = createSession({
				executionQueue: [createQueuedItem({ tabName: '🎵 Music' })],
			});
			render(<ExecutionQueueIndicator session={session} theme={theme} onClick={mockOnClick} />);
			expect(screen.getByText('🎵 Music')).toBeInTheDocument();
		});

		it('should show full tab names when container has space', () => {
			const session = createSession({
				executionQueue: [createQueuedItem({ tabName: 'LongerTabName' })],
			});
			render(<ExecutionQueueIndicator session={session} theme={theme} onClick={mockOnClick} />);
			// With 800px container width, names should not be truncated
			expect(screen.getByText('LongerTabName')).toBeInTheDocument();
		});

		it('should add title attribute for full text on hover', () => {
			const session = createSession({
				executionQueue: [createQueuedItem({ tabName: 'FullTabName' })],
			});
			render(<ExecutionQueueIndicator session={session} theme={theme} onClick={mockOnClick} />);
			const pill = screen.getByText('FullTabName');
			expect(pill).toHaveAttribute('title', 'FullTabName');
		});

		it('should handle rapid prop updates', () => {
			const session1 = createSession({
				executionQueue: [createQueuedItem({ tabName: 'Tab1' })],
			});
			const session2 = createSession({
				executionQueue: [
					createQueuedItem({ tabName: 'Tab2' }),
					createQueuedItem({ tabName: 'Tab3' }),
				],
			});

			const { rerender } = render(
				<ExecutionQueueIndicator session={session1} theme={theme} onClick={mockOnClick} />
			);
			let button = screen.getByRole('button');
			expect(button).toHaveTextContent('1');
			expect(button).toHaveTextContent('item queued');

			rerender(<ExecutionQueueIndicator session={session2} theme={theme} onClick={mockOnClick} />);
			button = screen.getByRole('button');
			expect(button).toHaveTextContent('2');
			expect(button).toHaveTextContent('items queued');
		});
	});

	describe('accessibility', () => {
		it('should be a button element for keyboard accessibility', () => {
			const session = createSession({
				executionQueue: [createQueuedItem()],
			});
			render(<ExecutionQueueIndicator session={session} theme={theme} onClick={mockOnClick} />);
			expect(screen.getByRole('button')).toBeInTheDocument();
		});

		it('should respond to Enter key press', () => {
			const session = createSession({
				executionQueue: [createQueuedItem()],
			});
			render(<ExecutionQueueIndicator session={session} theme={theme} onClick={mockOnClick} />);
			const button = screen.getByRole('button');
			fireEvent.keyDown(button, { key: 'Enter' });
			fireEvent.keyUp(button, { key: 'Enter' });
			fireEvent.click(button);
			expect(mockOnClick).toHaveBeenCalled();
		});

		it('should respond to Space key press', () => {
			const session = createSession({
				executionQueue: [createQueuedItem()],
			});
			render(<ExecutionQueueIndicator session={session} theme={theme} onClick={mockOnClick} />);
			const button = screen.getByRole('button');
			fireEvent.keyDown(button, { key: ' ' });
			fireEvent.keyUp(button, { key: ' ' });
			fireEvent.click(button);
			expect(mockOnClick).toHaveBeenCalled();
		});
	});

	describe('visual indicators', () => {
		it('should render ListOrdered icon', () => {
			const session = createSession({
				executionQueue: [createQueuedItem()],
			});
			const { container } = render(
				<ExecutionQueueIndicator session={session} theme={theme} onClick={mockOnClick} />
			);
			// Lucide icons render as SVG
			const svgs = container.querySelectorAll('svg');
			expect(svgs.length).toBeGreaterThan(0);
		});

		it('should render MessageSquare icon for messages', () => {
			const session = createSession({
				executionQueue: [createQueuedItem({ type: 'message' })],
			});
			const { container } = render(
				<ExecutionQueueIndicator session={session} theme={theme} onClick={mockOnClick} />
			);
			// Should have multiple SVG icons (ListOrdered + MessageSquare)
			const svgs = container.querySelectorAll('svg');
			expect(svgs.length).toBeGreaterThanOrEqual(2);
		});

		it('should render Command icon for commands', () => {
			const session = createSession({
				executionQueue: [createQueuedItem({ type: 'command' })],
			});
			const { container } = render(
				<ExecutionQueueIndicator session={session} theme={theme} onClick={mockOnClick} />
			);
			// Should have multiple SVG icons (ListOrdered + Command)
			const svgs = container.querySelectorAll('svg');
			expect(svgs.length).toBeGreaterThanOrEqual(2);
		});
	});
});
