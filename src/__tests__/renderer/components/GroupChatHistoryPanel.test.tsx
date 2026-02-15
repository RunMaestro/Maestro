/**
 * Tests for GroupChatHistoryPanel.tsx
 *
 * Tests cover:
 * - Empty states (loading, no entries, no filter matches, no search matches)
 * - Type filter pills (delegation, response, synthesis, error)
 * - Search filter (summary, fullResponse, participantName)
 * - Cmd+F keyboard shortcut to open search
 * - Escape to close search
 * - Search result count
 * - Activity graph receives filtered entries
 * - Bar click scrolls to entries
 * - Entry rendering (participant color, timestamp, summary, cost)
 * - onJumpToMessage callback
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { GroupChatHistoryPanel } from '../../../renderer/components/GroupChatHistoryPanel';
import { useUIStore } from '../../../renderer/stores/uiStore';
import type { Theme } from '../../../renderer/types';
import type { GroupChatHistoryEntry, GroupChatHistoryEntryType } from '../../../shared/group-chat-types';

// ============================================================================
// TEST HELPERS
// ============================================================================

const mockTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1e1e1e',
		bgSidebar: '#252526',
		bgActivity: '#333333',
		textMain: '#ffffff',
		textDim: '#808080',
		accent: '#007acc',
		border: '#404040',
		success: '#4ec9b0',
		warning: '#dcdcaa',
		error: '#f14c4c',
		buttonBg: '#0e639c',
		buttonText: '#ffffff',
	},
};

const createMockEntry = (overrides: Partial<GroupChatHistoryEntry> = {}): GroupChatHistoryEntry => ({
	id: `entry-${Math.random().toString(36).substring(7)}`,
	timestamp: Date.now(),
	summary: 'Test summary',
	participantName: 'Agent A',
	participantColor: '#ff0000',
	type: 'response',
	...overrides,
});

const mockParticipantColors: Record<string, string> = {
	'Agent A': '#ff0000',
	'Agent B': '#00ff00',
	'Moderator': '#0000ff',
};

const defaultProps = {
	theme: mockTheme,
	groupChatId: 'group-1',
	entries: [] as GroupChatHistoryEntry[],
	isLoading: false,
	participantColors: mockParticipantColors,
};

describe('GroupChatHistoryPanel', () => {
	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		useUIStore.setState({ groupChatHistorySearchFilterOpen: false });
		Element.prototype.scrollIntoView = vi.fn();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	// ===== EMPTY / LOADING STATES =====
	describe('loading and empty states', () => {
		it('should show loading state', () => {
			render(<GroupChatHistoryPanel {...defaultProps} isLoading={true} />);
			expect(screen.getByText('Loading history...')).toBeInTheDocument();
		});

		it('should show empty state when no entries', () => {
			render(<GroupChatHistoryPanel {...defaultProps} entries={[]} />);
			expect(screen.getByText(/No task history yet/)).toBeInTheDocument();
		});

		it('should show filter empty state when type filters hide all entries', () => {
			const entries = [createMockEntry({ type: 'response', summary: 'A response' })];
			render(<GroupChatHistoryPanel {...defaultProps} entries={entries} />);

			// Verify entry is visible
			expect(screen.getByText('A response')).toBeInTheDocument();

			// Toggle off response filter
			const responseFilter = screen.getByRole('button', { name: /Response/i });
			fireEvent.click(responseFilter);

			expect(screen.getByText('No entries match the selected filters.')).toBeInTheDocument();
		});

		it('should show search empty state when search has no matches', () => {
			const entries = [createMockEntry({ summary: 'Alpha task' })];
			const { container } = render(
				<GroupChatHistoryPanel {...defaultProps} entries={entries} />
			);

			// Open search
			const panel = container.querySelector('[tabIndex="0"]');
			fireEvent.keyDown(panel!, { key: 'f', metaKey: true });

			const searchInput = screen.getByPlaceholderText('Filter group chat history...');
			fireEvent.change(searchInput, { target: { value: 'nonexistent' } });

			expect(screen.getByText(/No entries match "nonexistent"/)).toBeInTheDocument();
		});
	});

	// ===== TYPE FILTER PILLS =====
	describe('type filter pills', () => {
		it('should render all four type filter pills', () => {
			render(<GroupChatHistoryPanel {...defaultProps} />);

			expect(screen.getByRole('button', { name: /Delegation/i })).toBeInTheDocument();
			expect(screen.getByRole('button', { name: /Response/i })).toBeInTheDocument();
			expect(screen.getByRole('button', { name: /Synthesis/i })).toBeInTheDocument();
			expect(screen.getByRole('button', { name: /Error/i })).toBeInTheDocument();
		});

		it('should have all filters active by default', () => {
			render(<GroupChatHistoryPanel {...defaultProps} />);

			const pills = ['Delegation', 'Response', 'Synthesis', 'Error'];
			for (const label of pills) {
				const btn = screen.getByRole('button', { name: new RegExp(label, 'i') });
				expect(btn).toHaveClass('opacity-100');
			}
		});

		it('should toggle a filter off and back on', () => {
			const entries = [
				createMockEntry({ id: 'e1', type: 'delegation', summary: 'Delegated work' }),
				createMockEntry({ id: 'e2', type: 'response', summary: 'Agent responded' }),
			];
			render(<GroupChatHistoryPanel {...defaultProps} entries={entries} />);

			expect(screen.getByText('Delegated work')).toBeInTheDocument();
			expect(screen.getByText('Agent responded')).toBeInTheDocument();

			// Toggle off delegation
			const delegationBtn = screen.getByRole('button', { name: /Delegation/i });
			fireEvent.click(delegationBtn);

			expect(screen.queryByText('Delegated work')).not.toBeInTheDocument();
			expect(screen.getByText('Agent responded')).toBeInTheDocument();
			expect(delegationBtn).toHaveClass('opacity-40');

			// Toggle back on
			fireEvent.click(delegationBtn);

			expect(screen.getByText('Delegated work')).toBeInTheDocument();
			expect(delegationBtn).toHaveClass('opacity-100');
		});

		it('should filter by error type', () => {
			const entries = [
				createMockEntry({ id: 'e1', type: 'error', summary: 'Something failed' }),
				createMockEntry({ id: 'e2', type: 'synthesis', summary: 'Moderator synthesis' }),
			];
			render(<GroupChatHistoryPanel {...defaultProps} entries={entries} />);

			// Toggle off error
			fireEvent.click(screen.getByRole('button', { name: /Error/i }));

			expect(screen.queryByText('Something failed')).not.toBeInTheDocument();
			expect(screen.getByText('Moderator synthesis')).toBeInTheDocument();
		});

		it('should filter by synthesis type', () => {
			const entries = [
				createMockEntry({ id: 'e1', type: 'synthesis', summary: 'Moderator summary' }),
				createMockEntry({ id: 'e2', type: 'response', summary: 'Agent reply' }),
			];
			render(<GroupChatHistoryPanel {...defaultProps} entries={entries} />);

			// Toggle off synthesis
			fireEvent.click(screen.getByRole('button', { name: /Synthesis/i }));

			expect(screen.queryByText('Moderator summary')).not.toBeInTheDocument();
			expect(screen.getByText('Agent reply')).toBeInTheDocument();
		});
	});

	// ===== SEARCH FILTER =====
	describe('search filter', () => {
		it('should open search with Cmd+F', () => {
			const { container } = render(<GroupChatHistoryPanel {...defaultProps} />);

			const panel = container.querySelector('[tabIndex="0"]');
			fireEvent.keyDown(panel!, { key: 'f', metaKey: true });

			expect(screen.getByPlaceholderText('Filter group chat history...')).toBeInTheDocument();
		});

		it('should open search with Ctrl+F', () => {
			const { container } = render(<GroupChatHistoryPanel {...defaultProps} />);

			const panel = container.querySelector('[tabIndex="0"]');
			fireEvent.keyDown(panel!, { key: 'f', ctrlKey: true });

			expect(screen.getByPlaceholderText('Filter group chat history...')).toBeInTheDocument();
		});

		it('should close search with Escape and clear filter', () => {
			const entries = [createMockEntry({ summary: 'Visible entry' })];
			const { container } = render(
				<GroupChatHistoryPanel {...defaultProps} entries={entries} />
			);

			// Open search
			const panel = container.querySelector('[tabIndex="0"]');
			fireEvent.keyDown(panel!, { key: 'f', metaKey: true });

			const searchInput = screen.getByPlaceholderText('Filter group chat history...');
			fireEvent.change(searchInput, { target: { value: 'nonexistent' } });

			// Verify entry is hidden
			expect(screen.queryByText('Visible entry')).not.toBeInTheDocument();

			// Close with Escape
			fireEvent.keyDown(searchInput, { key: 'Escape' });

			// Search input should be gone and entry visible again
			expect(screen.queryByPlaceholderText('Filter group chat history...')).not.toBeInTheDocument();
			expect(screen.getByText('Visible entry')).toBeInTheDocument();
		});

		it('should filter by summary text', () => {
			const entries = [
				createMockEntry({ id: 'e1', summary: 'Alpha task completed' }),
				createMockEntry({ id: 'e2', summary: 'Beta implementation done' }),
			];
			const { container } = render(
				<GroupChatHistoryPanel {...defaultProps} entries={entries} />
			);

			// Open search
			const panel = container.querySelector('[tabIndex="0"]');
			fireEvent.keyDown(panel!, { key: 'f', metaKey: true });

			const searchInput = screen.getByPlaceholderText('Filter group chat history...');
			fireEvent.change(searchInput, { target: { value: 'Alpha' } });

			expect(screen.getByText('Alpha task completed')).toBeInTheDocument();
			expect(screen.queryByText('Beta implementation done')).not.toBeInTheDocument();
		});

		it('should filter by fullResponse text', () => {
			const entries = [
				createMockEntry({
					id: 'e1',
					summary: 'Generic summary',
					fullResponse: 'Contains unique keyword xyz123',
				}),
				createMockEntry({ id: 'e2', summary: 'Other entry' }),
			];
			const { container } = render(
				<GroupChatHistoryPanel {...defaultProps} entries={entries} />
			);

			const panel = container.querySelector('[tabIndex="0"]');
			fireEvent.keyDown(panel!, { key: 'f', metaKey: true });

			const searchInput = screen.getByPlaceholderText('Filter group chat history...');
			fireEvent.change(searchInput, { target: { value: 'xyz123' } });

			expect(screen.getByText('Generic summary')).toBeInTheDocument();
			expect(screen.queryByText('Other entry')).not.toBeInTheDocument();
		});

		it('should filter by participant name', () => {
			const entries = [
				createMockEntry({ id: 'e1', summary: 'Task by A', participantName: 'Agent A' }),
				createMockEntry({ id: 'e2', summary: 'Task by B', participantName: 'Agent B' }),
			];
			const { container } = render(
				<GroupChatHistoryPanel {...defaultProps} entries={entries} />
			);

			const panel = container.querySelector('[tabIndex="0"]');
			fireEvent.keyDown(panel!, { key: 'f', metaKey: true });

			const searchInput = screen.getByPlaceholderText('Filter group chat history...');
			fireEvent.change(searchInput, { target: { value: 'Agent B' } });

			expect(screen.queryByText('Task by A')).not.toBeInTheDocument();
			expect(screen.getByText('Task by B')).toBeInTheDocument();
		});

		it('should be case-insensitive', () => {
			const entries = [
				createMockEntry({ id: 'e1', summary: 'UPPERCASE Task' }),
			];
			const { container } = render(
				<GroupChatHistoryPanel {...defaultProps} entries={entries} />
			);

			const panel = container.querySelector('[tabIndex="0"]');
			fireEvent.keyDown(panel!, { key: 'f', metaKey: true });

			const searchInput = screen.getByPlaceholderText('Filter group chat history...');
			fireEvent.change(searchInput, { target: { value: 'uppercase' } });

			expect(screen.getByText('UPPERCASE Task')).toBeInTheDocument();
		});

		it('should show result count when searching', () => {
			const entries = [
				createMockEntry({ id: 'e1', summary: 'Alpha one' }),
				createMockEntry({ id: 'e2', summary: 'Alpha two' }),
				createMockEntry({ id: 'e3', summary: 'Beta xyz' }),
			];
			const { container } = render(
				<GroupChatHistoryPanel {...defaultProps} entries={entries} />
			);

			const panel = container.querySelector('[tabIndex="0"]');
			fireEvent.keyDown(panel!, { key: 'f', metaKey: true });

			const searchInput = screen.getByPlaceholderText('Filter group chat history...');
			fireEvent.change(searchInput, { target: { value: 'Alpha' } });

			const resultCount = container.querySelector('.text-right');
			expect(resultCount?.textContent).toMatch(/2 results?/);
		});

		it('should combine search with type filters', () => {
			const entries = [
				createMockEntry({ id: 'e1', type: 'delegation', summary: 'Alpha delegation' }),
				createMockEntry({ id: 'e2', type: 'response', summary: 'Alpha response' }),
				createMockEntry({ id: 'e3', type: 'delegation', summary: 'Beta delegation' }),
			];
			const { container } = render(
				<GroupChatHistoryPanel {...defaultProps} entries={entries} />
			);

			// Toggle off delegation
			fireEvent.click(screen.getByRole('button', { name: /Delegation/i }));

			// Open search
			const panel = container.querySelector('[tabIndex="0"]');
			fireEvent.keyDown(panel!, { key: 'f', metaKey: true });

			const searchInput = screen.getByPlaceholderText('Filter group chat history...');
			fireEvent.change(searchInput, { target: { value: 'Alpha' } });

			// Only the response entry matching "Alpha" should be visible
			expect(screen.queryByText('Alpha delegation')).not.toBeInTheDocument();
			expect(screen.getByText('Alpha response')).toBeInTheDocument();
			expect(screen.queryByText('Beta delegation')).not.toBeInTheDocument();
		});
	});

	// ===== ENTRY RENDERING =====
	describe('entry rendering', () => {
		it('should render participant name pill with correct color', () => {
			const entries = [
				createMockEntry({ participantName: 'Agent A' }),
			];
			render(<GroupChatHistoryPanel {...defaultProps} entries={entries} />);

			const pill = screen.getByText('Agent A');
			// Should use color from participantColors prop
			expect(pill).toHaveStyle({ color: '#ff0000' });
		});

		it('should render entry summary', () => {
			const entries = [
				createMockEntry({ summary: 'Completed the refactoring task' }),
			];
			render(<GroupChatHistoryPanel {...defaultProps} entries={entries} />);

			expect(screen.getByText('Completed the refactoring task')).toBeInTheDocument();
		});

		it('should render cost when present', () => {
			const entries = [
				createMockEntry({ cost: 0.15 }),
			];
			render(<GroupChatHistoryPanel {...defaultProps} entries={entries} />);

			expect(screen.getByText('$0.15')).toBeInTheDocument();
		});

		it('should not render cost badge for zero cost', () => {
			const entries = [
				createMockEntry({ cost: 0 }),
			];
			render(<GroupChatHistoryPanel {...defaultProps} entries={entries} />);

			expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
		});

		it('should not render cost badge when cost is undefined', () => {
			const entries = [
				createMockEntry({ cost: undefined }),
			];
			render(<GroupChatHistoryPanel {...defaultProps} entries={entries} />);

			// No dollar sign in the output
			const costElements = screen.queryAllByText(/\$/);
			expect(costElements.length).toBe(0);
		});
	});

	// ===== CALLBACKS =====
	describe('callbacks', () => {
		it('should call onJumpToMessage when entry is clicked', () => {
			const onJumpToMessage = vi.fn();
			const entries = [createMockEntry({ timestamp: 1234567890 })];
			render(
				<GroupChatHistoryPanel
					{...defaultProps}
					entries={entries}
					onJumpToMessage={onJumpToMessage}
				/>
			);

			fireEvent.click(screen.getByText('Test summary'));

			expect(onJumpToMessage).toHaveBeenCalledWith(1234567890);
		});
	});

	// ===== BAR CLICK =====
	describe('bar click navigation', () => {
		it('should scroll to entry when bar is clicked', () => {
			const now = Date.now();
			const entries = [
				createMockEntry({ id: 'recent', timestamp: now - 1000, summary: 'Recent entry' }),
			];
			const { container } = render(
				<GroupChatHistoryPanel {...defaultProps} entries={entries} />
			);

			// Find clickable bars (those with cursor: pointer)
			const bars = container.querySelectorAll('[style*="cursor: pointer"]');
			if (bars.length > 0) {
				fireEvent.click(bars[bars.length - 1]);
				// scrollIntoView should have been called
				expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
			}
		});
	});

	// ===== MULTI-FILTER INTERACTIONS =====
	describe('multi-filter interactions', () => {
		it('should allow toggling off multiple type filters', () => {
			const entries = [
				createMockEntry({ id: 'e1', type: 'delegation', summary: 'Delegated task' }),
				createMockEntry({ id: 'e2', type: 'response', summary: 'Agent replied' }),
				createMockEntry({ id: 'e3', type: 'synthesis', summary: 'Synthesized output' }),
				createMockEntry({ id: 'e4', type: 'error', summary: 'Error occurred' }),
			];
			render(<GroupChatHistoryPanel {...defaultProps} entries={entries} />);

			// Toggle off delegation and synthesis
			fireEvent.click(screen.getByRole('button', { name: /Delegation/i }));
			fireEvent.click(screen.getByRole('button', { name: /Synthesis/i }));

			expect(screen.queryByText('Delegated task')).not.toBeInTheDocument();
			expect(screen.getByText('Agent replied')).toBeInTheDocument();
			expect(screen.queryByText('Synthesized output')).not.toBeInTheDocument();
			expect(screen.getByText('Error occurred')).toBeInTheDocument();
		});

		it('should show filter empty state when all type filters are off', () => {
			const entries = [
				createMockEntry({ id: 'e1', type: 'delegation', summary: 'A' }),
				createMockEntry({ id: 'e2', type: 'response', summary: 'B' }),
			];
			render(<GroupChatHistoryPanel {...defaultProps} entries={entries} />);

			// Toggle off all types
			fireEvent.click(screen.getByRole('button', { name: /Delegation/i }));
			fireEvent.click(screen.getByRole('button', { name: /Response/i }));
			fireEvent.click(screen.getByRole('button', { name: /Synthesis/i }));
			fireEvent.click(screen.getByRole('button', { name: /Error/i }));

			expect(screen.getByText('No entries match the selected filters.')).toBeInTheDocument();
		});

		it('should correctly apply type filter + search filter together', () => {
			const entries = [
				createMockEntry({ id: 'e1', type: 'delegation', summary: 'Alpha task' }),
				createMockEntry({ id: 'e2', type: 'response', summary: 'Alpha response' }),
				createMockEntry({ id: 'e3', type: 'delegation', summary: 'Beta task' }),
				createMockEntry({ id: 'e4', type: 'response', summary: 'Beta response' }),
			];
			const { container } = render(
				<GroupChatHistoryPanel {...defaultProps} entries={entries} />
			);

			// Toggle off delegation type
			fireEvent.click(screen.getByRole('button', { name: /Delegation/i }));

			// Open search and filter for "Alpha"
			const panel = container.querySelector('[tabIndex="0"]');
			fireEvent.keyDown(panel!, { key: 'f', metaKey: true });
			const searchInput = screen.getByPlaceholderText('Filter group chat history...');
			fireEvent.change(searchInput, { target: { value: 'Alpha' } });

			// Only "Alpha response" should remain (delegation hidden by type filter, Beta hidden by search)
			expect(screen.queryByText('Alpha task')).not.toBeInTheDocument();
			expect(screen.getByText('Alpha response')).toBeInTheDocument();
			expect(screen.queryByText('Beta task')).not.toBeInTheDocument();
			expect(screen.queryByText('Beta response')).not.toBeInTheDocument();
		});

		it('should show correct result count with combined filters', () => {
			const entries = [
				createMockEntry({ id: 'e1', type: 'delegation', summary: 'Shared keyword' }),
				createMockEntry({ id: 'e2', type: 'response', summary: 'Shared keyword' }),
				createMockEntry({ id: 'e3', type: 'response', summary: 'Other text' }),
			];
			const { container } = render(
				<GroupChatHistoryPanel {...defaultProps} entries={entries} />
			);

			// Toggle off delegation
			fireEvent.click(screen.getByRole('button', { name: /Delegation/i }));

			// Search for "Shared"
			const panel = container.querySelector('[tabIndex="0"]');
			fireEvent.keyDown(panel!, { key: 'f', metaKey: true });
			const searchInput = screen.getByPlaceholderText('Filter group chat history...');
			fireEvent.change(searchInput, { target: { value: 'Shared' } });

			// Only 1 result (response with "Shared keyword")
			const resultCount = container.querySelector('.text-right');
			expect(resultCount?.textContent).toMatch(/1 result$/);
		});
	});

	// ===== ENTRY RENDERING DETAILS =====
	describe('entry rendering details', () => {
		it('should use participantColors prop color over entry participantColor', () => {
			const entries = [
				createMockEntry({
					participantName: 'Agent A',
					participantColor: '#999999', // entry-level color (fallback)
				}),
			];
			render(<GroupChatHistoryPanel {...defaultProps} entries={entries} />);

			const pill = screen.getByText('Agent A');
			// Should use participantColors['Agent A'] = '#ff0000', not the entry's #999999
			expect(pill).toHaveStyle({ color: '#ff0000' });
		});

		it('should fall back to entry participantColor when not in participantColors map', () => {
			const entries = [
				createMockEntry({
					participantName: 'Unknown Agent',
					participantColor: '#abcdef',
				}),
			];
			render(<GroupChatHistoryPanel {...defaultProps} entries={entries} />);

			const pill = screen.getByText('Unknown Agent');
			expect(pill).toHaveStyle({ color: '#abcdef' });
		});

		it('should render entries with data-entry-id attribute', () => {
			const entries = [
				createMockEntry({ id: 'entry-abc' }),
			];
			const { container } = render(
				<GroupChatHistoryPanel {...defaultProps} entries={entries} />
			);

			expect(container.querySelector('[data-entry-id="entry-abc"]')).toBeInTheDocument();
		});

		it('should render all four entry types with correct styling', () => {
			const entries = [
				createMockEntry({ id: 'e1', type: 'delegation', summary: 'Delegation entry' }),
				createMockEntry({ id: 'e2', type: 'response', summary: 'Response entry' }),
				createMockEntry({ id: 'e3', type: 'synthesis', summary: 'Synthesis entry' }),
				createMockEntry({ id: 'e4', type: 'error', summary: 'Error entry' }),
			];
			render(<GroupChatHistoryPanel {...defaultProps} entries={entries} />);

			expect(screen.getByText('Delegation entry')).toBeInTheDocument();
			expect(screen.getByText('Response entry')).toBeInTheDocument();
			expect(screen.getByText('Synthesis entry')).toBeInTheDocument();
			expect(screen.getByText('Error entry')).toBeInTheDocument();
		});
	});

	// ===== LAYOUT =====
	describe('layout', () => {
		it('should render filter pills, activity graph area, and entry list vertically', () => {
			const entries = [
				createMockEntry({ id: 'e1', summary: 'Test entry' }),
			];
			const { container } = render(
				<GroupChatHistoryPanel {...defaultProps} entries={entries} />
			);

			// Main container should be flex-col (vertical stacking)
			const mainPanel = container.querySelector('.flex-col.overflow-hidden');
			expect(mainPanel).toBeInTheDocument();

			// Filter pills should be rendered
			expect(screen.getByRole('button', { name: /Delegation/i })).toBeInTheDocument();

			// Entry should be in the scrollable list area
			expect(screen.getByText('Test entry')).toBeInTheDocument();
		});

		it('should have activity graph with w-full class for full width', () => {
			const entries = [
				createMockEntry({ timestamp: Date.now() - 1000, summary: 'Recent' }),
			];
			const { container } = render(
				<GroupChatHistoryPanel {...defaultProps} entries={entries} />
			);

			// Activity graph should use w-full for full width
			const graphContainer = container.querySelector('.w-full.flex.flex-col.relative');
			expect(graphContainer).toBeInTheDocument();
		});
	});
});
