import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { HistoryEntryItem } from '../../../../renderer/components/History';
import type { HistoryEntry, HistoryEntryType } from '../../../../renderer/types';

import { useSettingsStore } from '../../../../renderer/stores/settingsStore';

import { mockTheme } from '../../../helpers/mockTheme';
// Create mock theme

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

	describe('provider mode pill', () => {
		afterEach(() => {
			useSettingsStore.setState({ showProviderModePill: false });
		});

		it('renders the token source pill when the display setting is on', () => {
			useSettingsStore.setState({ showProviderModePill: true });
			render(
				<HistoryEntryItem
					entry={createMockEntry({ tokenSource: 'api' })}
					index={0}
					isSelected={false}
					theme={mockTheme}
					onOpenDetailModal={vi.fn()}
				/>
			);
			expect(screen.getByText('claude -p')).toBeInTheDocument();
		});

		it('suppresses the pill when the display setting is off', () => {
			useSettingsStore.setState({ showProviderModePill: false });
			render(
				<HistoryEntryItem
					entry={createMockEntry({ tokenSource: 'api' })}
					index={0}
					isSelected={false}
					theme={mockTheme}
					onOpenDetailModal={vi.fn()}
				/>
			);
			expect(screen.queryByText('claude -p')).not.toBeInTheDocument();
		});
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

	it('shows CUE type pill for CUE entries', () => {
		render(
			<HistoryEntryItem
				entry={createMockEntry({ type: 'CUE' })}
				index={0}
				isSelected={false}
				theme={mockTheme}
				onOpenDetailModal={vi.fn()}
			/>
		);
		expect(screen.getByText('CUE')).toBeInTheDocument();
	});

	it('shows CUE pill with teal color', () => {
		render(
			<HistoryEntryItem
				entry={createMockEntry({ type: 'CUE' })}
				index={0}
				isSelected={false}
				theme={mockTheme}
				onOpenDetailModal={vi.fn()}
			/>
		);
		const cuePill = screen.getByText('CUE').closest('span')!;
		expect(cuePill).toHaveStyle({ color: '#06b6d4' });
	});

	it('shows success indicator for successful CUE entries', () => {
		render(
			<HistoryEntryItem
				entry={createMockEntry({ type: 'CUE', success: true })}
				index={0}
				isSelected={false}
				theme={mockTheme}
				onOpenDetailModal={vi.fn()}
			/>
		);
		expect(screen.getByTitle('Task completed successfully')).toBeInTheDocument();
	});

	it('shows failure indicator for failed CUE entries', () => {
		render(
			<HistoryEntryItem
				entry={createMockEntry({ type: 'CUE', success: false })}
				index={0}
				isSelected={false}
				theme={mockTheme}
				onOpenDetailModal={vi.fn()}
			/>
		);
		expect(screen.getByTitle('Task failed')).toBeInTheDocument();
	});

	it('shows CUE event type metadata when present', () => {
		render(
			<HistoryEntryItem
				entry={createMockEntry({ type: 'CUE', cueEventType: 'file.changed' })}
				index={0}
				isSelected={false}
				theme={mockTheme}
				onOpenDetailModal={vi.fn()}
			/>
		);
		// The raw type is humanized for display (raw value kept in the title attr).
		expect(screen.getByText('Triggered by: File Change')).toBeInTheDocument();
	});

	it('does not show CUE metadata for non-CUE entries', () => {
		render(
			<HistoryEntryItem
				entry={createMockEntry({ type: 'AUTO' })}
				index={0}
				isSelected={false}
				theme={mockTheme}
				onOpenDetailModal={vi.fn()}
			/>
		);
		expect(screen.queryByText(/Triggered by:/)).not.toBeInTheDocument();
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
		expect(
			screen.getByTitle('Task completed successfully, and you marked it as checked')
		).toBeInTheDocument();
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

	it('shows agent name as a heading when showAgentName prop is true', () => {
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
		const heading = screen.getByTitle('TestAgent');
		expect(heading).toBeInTheDocument();
		expect(heading.tagName).toBe('H3');
		expect(heading).toHaveClass('text-sm', 'font-bold');
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

	it('session name pill is shrinkable to avoid date collision', () => {
		const entry = createMockEntry({
			agentSessionId: 'abc12345-def6-7890',
			sessionName: 'A Very Long Session Name That Should Truncate',
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
		const sessionButton = screen.getByTitle('A Very Long Session Name That Should Truncate');
		expect(sessionButton).toHaveClass('flex-shrink');
		expect(sessionButton).not.toHaveClass('flex-shrink-0');
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

		expect(onOpenSessionAsTab).toHaveBeenCalledWith('session-abc-123', '/test/project', undefined);
	});

	// The pill is the only place the closed session's name still exists: the tab
	// that carried it is gone, and the origins fallback resume falls back to is
	// Claude-only and only ever written by a synopsis. Dropping it here is what
	// made a restore come back as the bare id octet.
	it('hands the entry name to onOpenSessionAsTab so the restored tab keeps it', () => {
		const onOpenSessionAsTab = vi.fn();
		const entry = createMockEntry({
			agentSessionId: 'session-abc-123',
			sessionName: 'PP Farm Meta Data',
		});
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

		fireEvent.click(screen.getByTitle('PP Farm Meta Data'));

		expect(onOpenSessionAsTab).toHaveBeenCalledWith(
			'session-abc-123',
			'/test/project',
			'PP Farm Meta Data'
		);
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

	/**
	 * Web Login sender pill.
	 *
	 * A turn a logged-in browser sent is attributed to that account, and the
	 * footer pill is where that attribution surfaces on the row. A turn typed
	 * at the desktop carries no account at all, so it must draw no pill - an
	 * empty one would claim somebody signed in for it.
	 */
	describe('sender pill', () => {
		it('renders the account display name for a turn a browser sent', () => {
			render(
				<HistoryEntryItem
					entry={createMockEntry({ userName: 'pedram', userDisplayName: 'Pedram A' })}
					index={0}
					isSelected={false}
					theme={mockTheme}
					onOpenDetailModal={vi.fn()}
				/>
			);

			expect(screen.getByTitle('Sent by pedram')).toBeInTheDocument();
			expect(screen.getByText('Pedram A')).toBeInTheDocument();
		});

		it('falls back to the username when the account has no display name', () => {
			render(
				<HistoryEntryItem
					entry={createMockEntry({ userName: 'pedram' })}
					index={0}
					isSelected={false}
					theme={mockTheme}
					onOpenDetailModal={vi.fn()}
				/>
			);

			expect(screen.getByText('pedram')).toBeInTheDocument();
		});

		it('draws no pill for a turn typed at the desktop', () => {
			render(
				<HistoryEntryItem
					entry={createMockEntry()}
					index={0}
					isSelected={false}
					theme={mockTheme}
					onOpenDetailModal={vi.fn()}
				/>
			);

			expect(screen.queryByTitle(/^Sent by /)).not.toBeInTheDocument();
		});
	});

	/**
	 * Collapsed Cue rows (CUE-HISTORY-03 task #3).
	 *
	 * A grouped row IS the group's newest run with a `cueGroup` summary attached,
	 * so these tests pin the three things the collapse changes: the header names
	 * the TRIGGER rather than leaving the run unlabelled, the per-run success dot
	 * gives way to the group's failure tally, and a row with no `cueGroup` is
	 * untouched.
	 */
	describe('collapsed Cue group', () => {
		const groupedRow = (overrides: Partial<HistoryEntry> = {}): HistoryEntry =>
			createMockEntry({
				type: 'CUE' as HistoryEntryType,
				summary: 'Bus drained 4 commands',
				success: true,
				cueTriggerName: 'Pedsidian-Command-Bus',
				cueEventType: 'file.changed',
				cueGroup: {
					key: 'Pedsidian-Command-Bus',
					label: 'Pedsidian-Command-Bus',
					runCount: 1382,
					failureCount: 3,
				},
				...overrides,
			});

		const renderRow = (entry: HistoryEntry) =>
			render(
				<HistoryEntryItem
					entry={entry}
					index={0}
					isSelected={false}
					theme={mockTheme}
					onOpenDetailModal={vi.fn()}
				/>
			);

		it('names the trigger and reports the run count with digit grouping', () => {
			renderRow(groupedRow());
			expect(screen.getByText('Pedsidian-Command-Bus')).toBeInTheDocument();
			// The number IS the information here, so it is never abbreviated to "1.4K".
			expect(screen.getByText('1,382 runs')).toBeInTheDocument();
		});

		it('reports the failure count when runs failed', () => {
			renderRow(groupedRow());
			expect(screen.getByText('3 failed')).toBeInTheDocument();
		});

		it('omits the failure count when every run succeeded', () => {
			renderRow(
				groupedRow({
					cueGroup: {
						key: 'Pedsidian-Command-Bus',
						label: 'Pedsidian-Command-Bus',
						runCount: 40,
						failureCount: 0,
					},
				})
			);
			expect(screen.getByText('40 runs')).toBeInTheDocument();
			expect(screen.queryByText(/failed$/)).not.toBeInTheDocument();
		});

		it('keeps the newest run summary as the row body', () => {
			renderRow(groupedRow());
			expect(screen.getByText('Bus drained 4 commands')).toBeInTheDocument();
		});

		it('folds the trigger type into the tally instead of a second subtitle line', () => {
			const { container } = renderRow(groupedRow());
			expect(container.textContent).not.toContain('Triggered by:');
			expect(screen.getByText('File Change')).toBeInTheDocument();
		});

		it('drops the per-run success indicator, which cannot speak for N runs', () => {
			const { container } = renderRow(groupedRow());
			// The ungrouped row paints a success/failure dot from `entry.success`.
			// On a group that dot would report only the newest run's outcome while
			// sitting next to a count of 1,382.
			expect(container.querySelector('[title="Task completed successfully"]')).toBeNull();
		});

		it('leaves an ungrouped Cue row exactly as it was', () => {
			const { container } = renderRow(groupedRow({ cueGroup: undefined }));
			expect(container.textContent).toContain('Triggered by: File Change');
			expect(container.querySelector('[data-cue-group]')).toBeNull();
			expect(container.querySelector('[title="Task completed successfully"]')).not.toBeNull();
		});
	});

	/**
	 * Expanding a collapsed row (CUE-HISTORY-03 task #4).
	 *
	 * Collapsing 1,382 runs to one line is only honest if the runs stay
	 * reachable, so these pin the escape hatch: the control exists on a group,
	 * opening it fetches and lists the runs, a run opens the detail modal on
	 * ITSELF rather than on the group, and a row with nothing behind it - an
	 * ungrouped row, or a caller that wired no loader - grows no control.
	 */
	describe('expanding a collapsed Cue group', () => {
		// The runs arrive from an async load, and `waitFor` cannot make progress
		// against the suite-wide fake clock. These cases do not assert on
		// timestamps, so real timers cost them nothing.
		beforeEach(() => {
			vi.useRealTimers();
		});

		const runs: HistoryEntry[] = [
			{
				id: 'run-new',
				type: 'CUE' as HistoryEntryType,
				timestamp: Date.now(),
				summary: 'Newest run body',
				projectPath: '/test/project',
				success: true,
			},
			{
				id: 'run-failed',
				type: 'CUE' as HistoryEntryType,
				timestamp: Date.now() - 60_000,
				summary: 'Failed run body',
				projectPath: '/test/project',
				success: false,
			},
		];

		const groupedRow = (overrides: Partial<HistoryEntry> = {}): HistoryEntry =>
			createMockEntry({
				type: 'CUE' as HistoryEntryType,
				summary: 'Bus drained 4 commands',
				sessionId: 'agent-rc',
				cueTriggerName: 'Pedsidian-Command-Bus',
				cueGroup: {
					key: 'Pedsidian-Command-Bus',
					label: 'Pedsidian-Command-Bus',
					runCount: 1382,
					failureCount: 3,
				},
				...overrides,
			});

		const renderRow = (
			entry: HistoryEntry,
			opts: {
				expanded?: boolean;
				loadRuns?: () => Promise<HistoryEntry[]>;
				toggle?: (id: string) => void;
				onOpenDetailModal?: (entry: HistoryEntry, index: number) => void;
				wired?: boolean;
			} = {}
		) => {
			const expansion = {
				toggle: opts.toggle ?? vi.fn(),
				loadRuns: opts.loadRuns ?? vi.fn(async () => runs),
			};
			return render(
				<HistoryEntryItem
					entry={entry}
					index={7}
					isSelected={false}
					theme={mockTheme}
					onOpenDetailModal={opts.onOpenDetailModal ?? vi.fn()}
					cueGroupExpansion={opts.wired === false ? undefined : expansion}
					isCueGroupExpanded={opts.expanded ?? false}
				/>
			);
		};

		it('renders collapsed by default, with a control to open the runs', () => {
			renderRow(groupedRow());
			const expander = screen.getByTitle('Show individual runs');
			expect(expander).toHaveAttribute('aria-expanded', 'false');
			expect(screen.queryByText('Newest run body')).not.toBeInTheDocument();
		});

		it('toggles the group without opening the detail modal', () => {
			const toggle = vi.fn();
			const onOpenDetailModal = vi.fn();
			renderRow(groupedRow({ id: 'group-row' }), { toggle, onOpenDetailModal });

			fireEvent.click(screen.getByTitle('Show individual runs'));

			expect(toggle).toHaveBeenCalledWith('group-row');
			// The row's own click handler opens the modal; the expander must not.
			expect(onOpenDetailModal).not.toHaveBeenCalled();
		});

		it('lists the individual runs once expanded', async () => {
			const loadRuns = vi.fn(async () => runs);
			renderRow(groupedRow(), { expanded: true, loadRuns });

			await waitFor(() => expect(screen.getByText('Newest run body')).toBeInTheDocument());
			expect(screen.getByText('Failed run body')).toBeInTheDocument();
			expect(loadRuns).toHaveBeenCalledTimes(1);
			expect(screen.getByTitle('Hide individual runs')).toHaveAttribute('aria-expanded', 'true');
		});

		it('opens the detail modal on the RUN that was clicked, not the group', async () => {
			const onOpenDetailModal = vi.fn();
			renderRow(groupedRow(), { expanded: true, onOpenDetailModal });

			await waitFor(() => expect(screen.getByText('Failed run body')).toBeInTheDocument());
			fireEvent.click(screen.getByTitle('Failed run body'));

			expect(onOpenDetailModal).toHaveBeenCalledTimes(1);
			expect(onOpenDetailModal).toHaveBeenCalledWith(runs[1], 7);
		});

		it('reports a failed load instead of rendering an empty list', async () => {
			const loadRuns = vi.fn(async () => {
				throw new Error('database is locked');
			});
			renderRow(groupedRow(), { expanded: true, loadRuns });

			await waitFor(() =>
				expect(screen.getByText(/Failed to load runs: database is locked/)).toBeInTheDocument()
			);
		});

		it('says so when the window holds no runs', async () => {
			renderRow(groupedRow(), { expanded: true, loadRuns: vi.fn(async () => []) });

			await waitFor(() => expect(screen.getByText('No runs in this window.')).toBeInTheDocument());
		});

		it('gives an UNGROUPED row no expander - there is nothing behind it', () => {
			renderRow(groupedRow({ cueGroup: undefined }));
			expect(screen.queryByTitle('Show individual runs')).not.toBeInTheDocument();
		});

		it('gives a group no expander when the caller wired no loader', () => {
			// Surfaces that never request grouped rows would otherwise draw a
			// control that cannot fetch anything.
			renderRow(groupedRow(), { wired: false });
			expect(screen.queryByTitle('Show individual runs')).not.toBeInTheDocument();
		});
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
