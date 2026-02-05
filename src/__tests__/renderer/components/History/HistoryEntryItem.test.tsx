import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HistoryEntryItem } from '../../../../renderer/components/History';
import type { Theme, HistoryEntry, HistoryEntryType } from '../../../../renderer/types';

// Create mock theme
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
		scrollbar: '#404040',
		scrollbarHover: '#808080',
	},
};

// Create mock history entry factory
const createMockEntry = (overrides: Partial<HistoryEntry> = {}): HistoryEntry => ({
	id: 'entry-1',
	type: 'AUTO' as HistoryEntryType,
	timestamp: Date.now(),
	summary: 'Test summary',
	projectPath: '/test/project',
	...overrides,
});

describe('HistoryEntryItem', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2025-06-15T12:00:00Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('renders entry with summary text', () => {
		render(
			<HistoryEntryItem
				entry={createMockEntry({ summary: 'Implemented new feature' })}
				index={0}
				isSelected={false}
				theme={mockTheme}
				onOpenDetailModal={vi.fn()}
			/>
		);
		expect(screen.getByText('Implemented new feature')).toBeInTheDocument();
	});

	it('renders "No summary available" when summary is empty', () => {
		render(
			<HistoryEntryItem
				entry={createMockEntry({ summary: '' })}
				index={0}
				isSelected={false}
				theme={mockTheme}
				onOpenDetailModal={vi.fn()}
			/>
		);
		expect(screen.getByText('No summary available')).toBeInTheDocument();
	});

	it('shows AUTO type pill for AUTO entries', () => {
		render(
			<HistoryEntryItem
				entry={createMockEntry({ type: 'AUTO' })}
				index={0}
				isSelected={false}
				theme={mockTheme}
				onOpenDetailModal={vi.fn()}
			/>
		);
		expect(screen.getByText('AUTO')).toBeInTheDocument();
	});

	it('shows USER type pill for USER entries', () => {
		render(
			<HistoryEntryItem
				entry={createMockEntry({ type: 'USER' })}
				index={0}
				isSelected={false}
				theme={mockTheme}
				onOpenDetailModal={vi.fn()}
			/>
		);
		expect(screen.getByText('USER')).toBeInTheDocument();
	});

	it('shows success indicator for successful AUTO entries', () => {
		render(
			<HistoryEntryItem
				entry={createMockEntry({ type: 'AUTO', success: true })}
				index={0}
				isSelected={false}
				theme={mockTheme}
				onOpenDetailModal={vi.fn()}
			/>
		);
		expect(screen.getByTitle('Task completed successfully')).toBeInTheDocument();
	});

	it('shows validated indicator for validated AUTO entries', () => {
		render(
			<HistoryEntryItem
				entry={createMockEntry({ type: 'AUTO', success: true, validated: true })}
				index={0}
				isSelected={false}
				theme={mockTheme}
				onOpenDetailModal={vi.fn()}
			/>
		);
		expect(screen.getByTitle('Task completed successfully and human-validated')).toBeInTheDocument();
	});

	it('shows failure indicator for failed AUTO entries', () => {
		render(
			<HistoryEntryItem
				entry={createMockEntry({ type: 'AUTO', success: false })}
				index={0}
				isSelected={false}
				theme={mockTheme}
				onOpenDetailModal={vi.fn()}
			/>
		);
		expect(screen.getByTitle('Task failed')).toBeInTheDocument();
	});

	it('does not show success/failure indicator for USER entries', () => {
		render(
			<HistoryEntryItem
				entry={createMockEntry({ type: 'USER', success: true })}
				index={0}
				isSelected={false}
				theme={mockTheme}
				onOpenDetailModal={vi.fn()}
			/>
		);
		expect(screen.queryByTitle('Task completed successfully')).not.toBeInTheDocument();
	});

	it('applies selection styling when isSelected is true', () => {
		const { container } = render(
			<HistoryEntryItem
				entry={createMockEntry()}
				index={0}
				isSelected={true}
				theme={mockTheme}
				onOpenDetailModal={vi.fn()}
			/>
		);
		const entryDiv = container.firstChild as HTMLElement;
		expect(entryDiv).toHaveStyle({ borderColor: mockTheme.colors.accent });
		expect(entryDiv).toHaveStyle({ outline: `2px solid ${mockTheme.colors.accent}` });
	});

	it('does not apply selection styling when isSelected is false', () => {
		const { container } = render(
			<HistoryEntryItem
				entry={createMockEntry()}
				index={0}
				isSelected={false}
				theme={mockTheme}
				onOpenDetailModal={vi.fn()}
			/>
		);
		const entryDiv = container.firstChild as HTMLElement;
		expect(entryDiv).toHaveStyle({ borderColor: mockTheme.colors.border });
		expect(entryDiv).toHaveStyle({ outline: 'none' });
	});

	it('calls onOpenDetailModal with entry and index when clicked', () => {
		const onOpenDetailModal = vi.fn();
		const entry = createMockEntry({ summary: 'Click me' });
		render(
			<HistoryEntryItem
				entry={entry}
				index={3}
				isSelected={false}
				theme={mockTheme}
				onOpenDetailModal={onOpenDetailModal}
			/>
		);
		fireEvent.click(screen.getByText('Click me'));
		expect(onOpenDetailModal).toHaveBeenCalledWith(entry, 3);
	});

	it('shows agent name when showAgentName prop is true', () => {
		const entryWithAgent = {
			...createMockEntry(),
			agentName: 'TestAgent',
		};
		render(
			<HistoryEntryItem
				entry={entryWithAgent}
				index={0}
				isSelected={false}
				theme={mockTheme}
				onOpenDetailModal={vi.fn()}
				showAgentName
			/>
		);
		expect(screen.getByText('TestAgent')).toBeInTheDocument();
	});

	it('does not show agent name when showAgentName is false', () => {
		const entryWithAgent = {
			...createMockEntry(),
			agentName: 'TestAgent',
		};
		render(
			<HistoryEntryItem
				entry={entryWithAgent}
				index={0}
				isSelected={false}
				theme={mockTheme}
				onOpenDetailModal={vi.fn()}
			/>
		);
		expect(screen.queryByText('TestAgent')).not.toBeInTheDocument();
	});

	it('shows session ID button when agentSessionId is present', () => {
		const entry = createMockEntry({ agentSessionId: 'abc12345-def6-7890' });
		render(
			<HistoryEntryItem
				entry={entry}
				index={0}
				isSelected={false}
				theme={mockTheme}
				onOpenDetailModal={vi.fn()}
			/>
		);
		// Session ID first octet should be shown
		expect(screen.getByText('ABC12345')).toBeInTheDocument();
	});

	it('shows session name when both sessionName and agentSessionId are present', () => {
		const entry = createMockEntry({
			agentSessionId: 'abc12345-def6-7890',
			sessionName: 'My Session',
		});
		render(
			<HistoryEntryItem
				entry={entry}
				index={0}
				isSelected={false}
				theme={mockTheme}
				onOpenDetailModal={vi.fn()}
			/>
		);
		expect(screen.getByText('My Session')).toBeInTheDocument();
	});

	it('calls onOpenSessionAsTab when session button is clicked', () => {
		const onOpenSessionAsTab = vi.fn();
		const entry = createMockEntry({ agentSessionId: 'session-abc-123' });
		render(
			<HistoryEntryItem
				entry={entry}
				index={0}
				isSelected={false}
				theme={mockTheme}
				onOpenDetailModal={vi.fn()}
				onOpenSessionAsTab={onOpenSessionAsTab}
			/>
		);

		// Click the session button (not the entry itself)
		const sessionButton = screen.getByTitle('session-abc-123');
		fireEvent.click(sessionButton);

		expect(onOpenSessionAsTab).toHaveBeenCalledWith('session-abc-123');
	});

	it('shows elapsed time when present', () => {
		const entry = createMockEntry({ elapsedTimeMs: 45000 });
		render(
			<HistoryEntryItem
				entry={entry}
				index={0}
				isSelected={false}
				theme={mockTheme}
				onOpenDetailModal={vi.fn()}
			/>
		);
		expect(screen.getByText('45s')).toBeInTheDocument();
	});

	it('shows cost when usageStats has totalCostUsd', () => {
		const entry = createMockEntry({
			usageStats: {
				inputTokens: 100,
				outputTokens: 50,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				totalCostUsd: 1.23,
				contextWindow: 128000,
			},
		});
		render(
			<HistoryEntryItem
				entry={entry}
				index={0}
				isSelected={false}
				theme={mockTheme}
				onOpenDetailModal={vi.fn()}
			/>
		);
		expect(screen.getByText('$1.23')).toBeInTheDocument();
	});

	it('does not show footer when no elapsed time, cost, or achievement', () => {
		const entry = createMockEntry();
		const { container } = render(
			<HistoryEntryItem
				entry={entry}
				index={0}
				isSelected={false}
				theme={mockTheme}
				onOpenDetailModal={vi.fn()}
			/>
		);
		// No footer with border-t should exist
		expect(container.querySelector('.border-t')).not.toBeInTheDocument();
	});

	it('shows achievement button for entries with achievementAction', () => {
		const onOpenAboutModal = vi.fn();
		const entry = createMockEntry({ achievementAction: 'openAbout' });
		render(
			<HistoryEntryItem
				entry={entry}
				index={0}
				isSelected={false}
				theme={mockTheme}
				onOpenDetailModal={vi.fn()}
				onOpenAboutModal={onOpenAboutModal}
			/>
		);
		expect(screen.getByText('View Achievements')).toBeInTheDocument();
	});

	it('calls onOpenAboutModal when achievement button is clicked', () => {
		const onOpenAboutModal = vi.fn();
		const onOpenDetailModal = vi.fn();
		const entry = createMockEntry({ achievementAction: 'openAbout' });
		render(
			<HistoryEntryItem
				entry={entry}
				index={0}
				isSelected={false}
				theme={mockTheme}
				onOpenDetailModal={onOpenDetailModal}
				onOpenAboutModal={onOpenAboutModal}
			/>
		);

		fireEvent.click(screen.getByText('View Achievements'));

		// Should call onOpenAboutModal but NOT onOpenDetailModal (stopPropagation)
		expect(onOpenAboutModal).toHaveBeenCalled();
		expect(onOpenDetailModal).not.toHaveBeenCalled();
	});

	it('formats today timestamps as time only', () => {
		const now = new Date('2025-06-15T12:00:00Z');
		const entry = createMockEntry({ timestamp: now.getTime() });
		render(
			<HistoryEntryItem
				entry={entry}
				index={0}
				isSelected={false}
				theme={mockTheme}
				onOpenDetailModal={vi.fn()}
			/>
		);
		// Should show time format (no date portion since it's today)
		const timestampEl = screen.getByText(/^\d{1,2}:\d{2}\s*(AM|PM)$/i);
		expect(timestampEl).toBeInTheDocument();
	});
});
