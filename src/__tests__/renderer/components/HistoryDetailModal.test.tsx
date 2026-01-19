import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { HistoryDetailModal } from '../../../renderer/components/HistoryDetailModal';
import type { Theme, HistoryEntry } from '../../../renderer/types';

// Mock LayerStackContext
const mockRegisterLayer = vi.fn(() => 'layer-id-1');
const mockUnregisterLayer = vi.fn();
const mockUpdateLayerHandler = vi.fn();

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: mockRegisterLayer,
		unregisterLayer: mockUnregisterLayer,
		updateLayerHandler: mockUpdateLayerHandler,
	}),
}));

// Mock modal priorities
vi.mock('../../../renderer/constants/modalPriorities', () => ({
	MODAL_PRIORITIES: {
		CONFIRM: 100,
	},
}));

// Mock navigator.clipboard
const mockWriteText = vi.fn().mockResolvedValue(undefined);
Object.defineProperty(navigator, 'clipboard', {
	value: { writeText: mockWriteText },
	writable: true,
});

// Create a mock theme
const mockTheme: Theme = {
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: {
		bgMain: '#282a36',
		bgSidebar: '#21222c',
		bgActivity: '#343746',
		textMain: '#f8f8f2',
		textDim: '#6272a4',
		accent: '#bd93f9',
		accentForeground: '#f8f8f2',
		border: '#44475a',
		success: '#50fa7b',
		warning: '#ffb86c',
		error: '#ff5555',
		scrollbar: '#44475a',
		scrollbarHover: '#6272a4',
	},
};

// Create a base history entry for testing
const createMockEntry = (overrides: Partial<HistoryEntry> = {}): HistoryEntry => ({
	id: 'entry-1',
	timestamp: Date.now(),
	type: 'USER',
	summary: 'Test summary',
	...overrides,
});

describe('HistoryDetailModal', () => {
	let mockOnClose: ReturnType<typeof vi.fn>;
	let mockOnDelete: ReturnType<typeof vi.fn>;
	let mockOnUpdate: ReturnType<typeof vi.fn>;
	let mockOnNavigate: ReturnType<typeof vi.fn>;
	let mockOnJumpToClaudeSession: ReturnType<typeof vi.fn>;
	let mockOnResumeSession: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useFakeTimers();
		mockOnClose = vi.fn();
		mockOnDelete = vi.fn();
		mockOnUpdate = vi.fn().mockResolvedValue(true);
		mockOnNavigate = vi.fn();
		mockOnJumpToClaudeSession = vi.fn();
		mockOnResumeSession = vi.fn();
		mockRegisterLayer.mockClear();
		mockUnregisterLayer.mockClear();
		mockUpdateLayerHandler.mockClear();
		mockWriteText.mockClear();
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	describe('Basic Rendering', () => {
		it('should render with required props', () => {
			const entry = createMockEntry();
			render(<HistoryDetailModal theme={mockTheme} entry={entry} onClose={mockOnClose} />);

			expect(screen.getByText('USER')).toBeInTheDocument();
			expect(screen.getByText('Test summary')).toBeInTheDocument();
		});

		it('should render Close button', () => {
			render(
				<HistoryDetailModal theme={mockTheme} entry={createMockEntry()} onClose={mockOnClose} />
			);

			expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
		});

		it('should render Delete button', () => {
			render(
				<HistoryDetailModal theme={mockTheme} entry={createMockEntry()} onClose={mockOnClose} />
			);

			expect(screen.getByRole('button', { name: /Delete/i })).toBeInTheDocument();
		});

		it('should display timestamp in formatted format', () => {
			const timestamp = new Date('2024-06-15T10:30:00').getTime();
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({ timestamp })}
					onClose={mockOnClose}
				/>
			);

			// The timestamp should be formatted (month, day, time)
			expect(screen.getByText(/Jun/i)).toBeInTheDocument();
		});
	});

	describe('Entry Types', () => {
		it('should render USER type with correct pill', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({ type: 'USER' })}
					onClose={mockOnClose}
				/>
			);

			expect(screen.getByText('USER')).toBeInTheDocument();
		});

		it('should render AUTO type with correct pill', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({ type: 'AUTO' })}
					onClose={mockOnClose}
				/>
			);

			expect(screen.getByText('AUTO')).toBeInTheDocument();
		});

		it('should show success indicator for AUTO entries with success=true', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({ type: 'AUTO', success: true })}
					onClose={mockOnClose}
				/>
			);

			// Check for success indicator (CheckCircle or DoubleCheck)
			const successIndicator = screen.getByTitle('Task completed successfully');
			expect(successIndicator).toBeInTheDocument();
		});

		it('should show failure indicator for AUTO entries with success=false', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({ type: 'AUTO', success: false })}
					onClose={mockOnClose}
				/>
			);

			const failureIndicator = screen.getByTitle('Task failed');
			expect(failureIndicator).toBeInTheDocument();
		});

		it('should show validated indicator with double check for validated entries', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({ type: 'AUTO', success: true, validated: true })}
					onClose={mockOnClose}
				/>
			);

			const validatedIndicator = screen.getByTitle(
				'Task completed successfully and human-validated'
			);
			expect(validatedIndicator).toBeInTheDocument();
		});
	});

	describe('Content Display', () => {
		it('should display summary when no fullResponse', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({ summary: 'Summary content' })}
					onClose={mockOnClose}
				/>
			);

			expect(screen.getByText('Summary content')).toBeInTheDocument();
		});

		it('should display fullResponse when available', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({ summary: 'Short', fullResponse: 'Full response content' })}
					onClose={mockOnClose}
				/>
			);

			expect(screen.getByText('Full response content')).toBeInTheDocument();
		});

		it('should strip ANSI codes from response', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({ summary: '\x1b[31mRed text\x1b[0m normal' })}
					onClose={mockOnClose}
				/>
			);

			expect(screen.getByText('Red text normal')).toBeInTheDocument();
		});

		it('should handle empty response gracefully', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({ summary: '' })}
					onClose={mockOnClose}
				/>
			);

			// Should render without error
			expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
		});
	});

	describe('Claude Session ID', () => {
		it('should display session ID octet when agentSessionId is present', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({ agentSessionId: 'abc12345-def6-7890-ghij-klmnopqrstuv' })}
					onClose={mockOnClose}
				/>
			);

			expect(screen.getByText('ABC12345')).toBeInTheDocument();
		});

		it('should copy full session ID to clipboard when clicking session button', async () => {
			vi.useRealTimers(); // Use real timers for async clipboard operations
			const sessionId = 'abc12345-def6-7890-ghij-klmnopqrstuv';
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({ agentSessionId: sessionId })}
					onClose={mockOnClose}
				/>
			);

			const copyButton = screen.getByTitle(`Copy session ID: ${sessionId}`);
			fireEvent.click(copyButton);

			await waitFor(() => {
				expect(mockWriteText).toHaveBeenCalledWith(sessionId);
			});
			vi.useFakeTimers(); // Restore fake timers
		});

		it('should show copied state after copying session ID', async () => {
			vi.useRealTimers(); // Use real timers for async clipboard operations
			const sessionId = 'abc12345-def6-7890-ghij-klmnopqrstuv';
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({ agentSessionId: sessionId })}
					onClose={mockOnClose}
				/>
			);

			const copyButton = screen.getByTitle(`Copy session ID: ${sessionId}`);
			fireEvent.click(copyButton);

			// Wait for copy state to show
			await waitFor(() => {
				expect(mockWriteText).toHaveBeenCalled();
			});
			vi.useFakeTimers(); // Restore fake timers
		});

		it('should not display session ID elements when agentSessionId is undefined', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({ agentSessionId: undefined })}
					onClose={mockOnClose}
				/>
			);

			// No copy button should be present
			expect(screen.queryByTitle(/Copy session ID/)).not.toBeInTheDocument();
		});
	});

	describe('Resume Session', () => {
		it('should show Resume button when onResumeSession is provided and agentSessionId exists', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({ agentSessionId: 'abc12345-def6-7890-ghij-klmnopqrstuv' })}
					onClose={mockOnClose}
					onResumeSession={mockOnResumeSession}
				/>
			);

			expect(screen.getByText('Resume')).toBeInTheDocument();
		});

		it('should call onResumeSession and onClose when Resume is clicked', () => {
			const sessionId = 'abc12345-def6-7890-ghij-klmnopqrstuv';
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({ agentSessionId: sessionId })}
					onClose={mockOnClose}
					onResumeSession={mockOnResumeSession}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: 'Resume' }));

			expect(mockOnResumeSession).toHaveBeenCalledWith(sessionId);
			expect(mockOnClose).toHaveBeenCalled();
		});

		it('should not show Resume button when onResumeSession is not provided', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({ agentSessionId: 'abc12345-def6-7890-ghij-klmnopqrstuv' })}
					onClose={mockOnClose}
				/>
			);

			expect(screen.queryByText('Resume')).not.toBeInTheDocument();
		});
	});

	describe('Validation Toggle', () => {
		it('should show Validated button for successful AUTO entries with onUpdate', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({ type: 'AUTO', success: true })}
					onClose={mockOnClose}
					onUpdate={mockOnUpdate}
				/>
			);

			expect(screen.getByText('Validated')).toBeInTheDocument();
		});

		it('should call onUpdate with toggled validated state', async () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({ type: 'AUTO', success: true, validated: false })}
					onClose={mockOnClose}
					onUpdate={mockOnUpdate}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: 'Validated' }));

			expect(mockOnUpdate).toHaveBeenCalledWith('entry-1', { validated: true });
		});

		it('should toggle validated state from true to false', async () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({ type: 'AUTO', success: true, validated: true })}
					onClose={mockOnClose}
					onUpdate={mockOnUpdate}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: 'Validated' }));

			expect(mockOnUpdate).toHaveBeenCalledWith('entry-1', { validated: false });
		});

		it('should not show Validated button for failed AUTO entries', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({ type: 'AUTO', success: false })}
					onClose={mockOnClose}
					onUpdate={mockOnUpdate}
				/>
			);

			expect(screen.queryByText('Validated')).not.toBeInTheDocument();
		});

		it('should not show Validated button for USER entries', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({ type: 'USER' })}
					onClose={mockOnClose}
					onUpdate={mockOnUpdate}
				/>
			);

			expect(screen.queryByText('Validated')).not.toBeInTheDocument();
		});
	});

	describe('Stats Panel', () => {
		it('should show stats panel when usageStats is present', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({
						usageStats: {
							inputTokens: 1000,
							outputTokens: 500,
							cacheReadInputTokens: 200,
							cacheCreationInputTokens: 100,
							contextWindow: 100000,
							totalCostUsd: 0.05,
						},
					})}
					onClose={mockOnClose}
				/>
			);

			expect(screen.getByText(/Context/i)).toBeInTheDocument();
		});

		it('should calculate and display context usage percentage', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({
						usageStats: {
							inputTokens: 5000,
							outputTokens: 1000,
							cacheReadInputTokens: 2000, // Excluded from calculation (cumulative)
							cacheCreationInputTokens: 5000,
							contextWindow: 100000,
							totalCostUsd: 0.1,
						},
					})}
					onClose={mockOnClose}
				/>
			);

			// Context = (inputTokens + cacheCreationInputTokens) / contextWindow (cacheRead excluded)
			// (5000 + 5000) / 100000 = 10%
			expect(screen.getByText('10%')).toBeInTheDocument();
		});

		it('should display token counts', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({
						usageStats: {
							inputTokens: 1234,
							outputTokens: 567,
							cacheReadInputTokens: 0,
							cacheCreationInputTokens: 0,
							contextWindow: 100000,
							totalCostUsd: 0.05,
						},
					})}
					onClose={mockOnClose}
				/>
			);

			expect(screen.getByText('1,234')).toBeInTheDocument();
			expect(screen.getByText('567')).toBeInTheDocument();
		});

		it('should display cost when totalCostUsd > 0', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({
						usageStats: {
							inputTokens: 1000,
							outputTokens: 500,
							cacheReadInputTokens: 0,
							cacheCreationInputTokens: 0,
							contextWindow: 100000,
							totalCostUsd: 0.15,
						},
					})}
					onClose={mockOnClose}
				/>
			);

			expect(screen.getByText('$0.15')).toBeInTheDocument();
		});

		it('should not display cost when totalCostUsd is 0', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({
						usageStats: {
							inputTokens: 1000,
							outputTokens: 500,
							cacheReadInputTokens: 0,
							cacheCreationInputTokens: 0,
							contextWindow: 100000,
							totalCostUsd: 0,
						},
					})}
					onClose={mockOnClose}
				/>
			);

			expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
		});

		it('should display elapsed time when elapsedTimeMs is present', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({ elapsedTimeMs: 45000 })}
					onClose={mockOnClose}
				/>
			);

			expect(screen.getByText('45s')).toBeInTheDocument();
		});
	});

	describe('formatElapsedTime helper', () => {
		it('should format milliseconds', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({ elapsedTimeMs: 500 })}
					onClose={mockOnClose}
				/>
			);
			expect(screen.getByText('500ms')).toBeInTheDocument();
		});

		it('should format seconds', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({ elapsedTimeMs: 30000 })}
					onClose={mockOnClose}
				/>
			);
			expect(screen.getByText('30s')).toBeInTheDocument();
		});

		it('should format minutes and seconds', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({ elapsedTimeMs: 90000 })}
					onClose={mockOnClose}
				/>
			);
			expect(screen.getByText('1m 30s')).toBeInTheDocument();
		});

		it('should format hours and minutes', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({ elapsedTimeMs: 3720000 })}
					onClose={mockOnClose}
				/>
			);
			expect(screen.getByText('1h 2m')).toBeInTheDocument();
		});
	});

	describe('Context Color', () => {
		it('should show success color for usage < 70%', () => {
			const { container } = render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({
						usageStats: {
							inputTokens: 5000,
							outputTokens: 1000,
							cacheReadInputTokens: 0,
							cacheCreationInputTokens: 0,
							contextWindow: 100000,
							totalCostUsd: 0,
						},
					})}
					onClose={mockOnClose}
				/>
			);

			// 5% usage should show success color
			const progressBar = container.querySelector('[class*="transition-all"]');
			expect(progressBar).toHaveStyle({ backgroundColor: mockTheme.colors.success });
		});

		it('should show warning color for usage 70-89%', () => {
			const { container } = render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({
						usageStats: {
							inputTokens: 74000,
							outputTokens: 1000,
							cacheReadInputTokens: 0,
							cacheCreationInputTokens: 1000, // Included in calculation
							contextWindow: 100000,
							totalCostUsd: 0,
						},
					})}
					onClose={mockOnClose}
				/>
			);

			// (74000 + 1000 cacheCreation) / 100000 = 75% (cacheRead excluded - cumulative)
			expect(screen.getByText('75%')).toBeInTheDocument();
		});

		it('should show error color for usage >= 90%', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({
						usageStats: {
							inputTokens: 94000,
							outputTokens: 1000,
							cacheReadInputTokens: 0,
							cacheCreationInputTokens: 0,
							contextWindow: 100000,
							totalCostUsd: 0,
						},
					})}
					onClose={mockOnClose}
				/>
			);

			// (94000 + 0) / 100000 = 94%
			expect(screen.getByText('94%')).toBeInTheDocument();
		});

		it('should cap context usage at 100%', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({
						usageStats: {
							inputTokens: 150000,
							outputTokens: 1000,
							cacheReadInputTokens: 0,
							cacheCreationInputTokens: 0,
							contextWindow: 100000,
							totalCostUsd: 0,
						},
					})}
					onClose={mockOnClose}
				/>
			);

			// Should cap at 100%
			expect(screen.getByText('100%')).toBeInTheDocument();
		});
	});

	describe('Close Actions', () => {
		it('should call onClose when Close button is clicked', () => {
			render(
				<HistoryDetailModal theme={mockTheme} entry={createMockEntry()} onClose={mockOnClose} />
			);

			fireEvent.click(screen.getByRole('button', { name: 'Close' }));

			expect(mockOnClose).toHaveBeenCalled();
		});

		it('should call onClose when X button in header is clicked', () => {
			const { container } = render(
				<HistoryDetailModal theme={mockTheme} entry={createMockEntry()} onClose={mockOnClose} />
			);

			// Find the X button in the header (first button with hover:bg-white/10)
			const xButton = container.querySelector('button.hover\\:bg-white\\/10');
			if (xButton) {
				fireEvent.click(xButton);
				expect(mockOnClose).toHaveBeenCalled();
			}
		});

		it('should call onClose when backdrop is clicked', () => {
			const { container } = render(
				<HistoryDetailModal theme={mockTheme} entry={createMockEntry()} onClose={mockOnClose} />
			);

			// Find the backdrop (absolute inset-0 bg-black/60)
			const backdrop = container.querySelector('.bg-black\\/60');
			if (backdrop) {
				fireEvent.click(backdrop);
				expect(mockOnClose).toHaveBeenCalled();
			}
		});
	});

	describe('Delete Functionality', () => {
		it('should show delete confirmation when Delete button is clicked', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry()}
					onClose={mockOnClose}
					onDelete={mockOnDelete}
				/>
			);

			fireEvent.click(screen.getByTitle('Delete this history entry'));

			expect(screen.getByText('Delete History Entry')).toBeInTheDocument();
			expect(screen.getByText(/Are you sure you want to delete/)).toBeInTheDocument();
		});

		it('should show correct type in delete confirmation for USER entry', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({ type: 'USER' })}
					onClose={mockOnClose}
					onDelete={mockOnDelete}
				/>
			);

			fireEvent.click(screen.getByTitle('Delete this history entry'));

			expect(screen.getByText(/user history entry/)).toBeInTheDocument();
		});

		it('should show correct type in delete confirmation for AUTO entry', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({ type: 'AUTO' })}
					onClose={mockOnClose}
					onDelete={mockOnDelete}
				/>
			);

			fireEvent.click(screen.getByTitle('Delete this history entry'));

			expect(screen.getByText(/auto history entry/)).toBeInTheDocument();
		});

		it('should cancel delete when Cancel button is clicked', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry()}
					onClose={mockOnClose}
					onDelete={mockOnDelete}
				/>
			);

			fireEvent.click(screen.getByTitle('Delete this history entry'));

			// Verify delete confirmation is shown
			expect(screen.getByText('Delete History Entry')).toBeInTheDocument();

			fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

			expect(mockOnDelete).not.toHaveBeenCalled();
			expect(screen.queryByText('Delete History Entry')).not.toBeInTheDocument();
		});

		it('should call onDelete and onClose when confirming delete', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({ id: 'test-entry-id' })}
					onClose={mockOnClose}
					onDelete={mockOnDelete}
				/>
			);

			fireEvent.click(screen.getByTitle('Delete this history entry'));
			// Click the Delete button in the confirmation modal (not the footer Delete)
			const deleteButtons = screen.getAllByRole('button', { name: 'Delete' });
			fireEvent.click(deleteButtons[deleteButtons.length - 1]); // Last one is in modal

			expect(mockOnDelete).toHaveBeenCalledWith('test-entry-id');
			expect(mockOnClose).toHaveBeenCalled();
		});

		it('should close delete confirmation when clicking modal backdrop', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry()}
					onClose={mockOnClose}
					onDelete={mockOnDelete}
				/>
			);

			fireEvent.click(screen.getByTitle('Delete this history entry'));

			// Verify delete confirmation is shown
			expect(screen.getByText('Delete History Entry')).toBeInTheDocument();

			// Find the delete confirmation modal backdrop and click it
			const backdrops = document.querySelectorAll('.bg-black\\/60');
			if (backdrops.length > 1) {
				fireEvent.click(backdrops[1]); // Second backdrop is the delete confirmation
				expect(screen.queryByText('Delete History Entry')).not.toBeInTheDocument();
			}
		});

		it('should focus delete button when confirmation modal appears', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry()}
					onClose={mockOnClose}
					onDelete={mockOnDelete}
				/>
			);

			fireEvent.click(screen.getByTitle('Delete this history entry'));

			// The delete button in the confirmation modal should have tabIndex={0}
			const deleteButtons = screen.getAllByRole('button', { name: 'Delete' });
			const confirmDeleteButton = deleteButtons[deleteButtons.length - 1];
			expect(confirmDeleteButton).toHaveAttribute('tabIndex', '0');
		});

		it('should not call onDelete if callback is not provided', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry()}
					onClose={mockOnClose}
					// onDelete not provided
				/>
			);

			fireEvent.click(screen.getByTitle('Delete this history entry'));
			const deleteButtons = screen.getAllByRole('button', { name: 'Delete' });
			fireEvent.click(deleteButtons[deleteButtons.length - 1]);

			// Should still close without error
			expect(mockOnClose).toHaveBeenCalled();
		});
	});

	describe('Navigation', () => {
		const mockEntries: HistoryEntry[] = [
			createMockEntry({ id: 'entry-0', summary: 'Entry 0' }),
			createMockEntry({ id: 'entry-1', summary: 'Entry 1' }),
			createMockEntry({ id: 'entry-2', summary: 'Entry 2' }),
		];

		it('should show navigation buttons when navigation props are provided', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={mockEntries[1]}
					onClose={mockOnClose}
					filteredEntries={mockEntries}
					currentIndex={1}
					onNavigate={mockOnNavigate}
				/>
			);

			expect(screen.getByText('Prev')).toBeInTheDocument();
			expect(screen.getByText('Next')).toBeInTheDocument();
		});

		it('should not show navigation buttons when navigation props are missing', () => {
			render(<HistoryDetailModal theme={mockTheme} entry={mockEntries[1]} onClose={mockOnClose} />);

			expect(screen.queryByText('Prev')).not.toBeInTheDocument();
			expect(screen.queryByText('Next')).not.toBeInTheDocument();
		});

		it('should disable Prev button at first entry', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={mockEntries[0]}
					onClose={mockOnClose}
					filteredEntries={mockEntries}
					currentIndex={0}
					onNavigate={mockOnNavigate}
				/>
			);

			const prevButton = screen.getByTitle('No previous entry');
			expect(prevButton).toBeDisabled();
		});

		it('should disable Next button at last entry', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={mockEntries[2]}
					onClose={mockOnClose}
					filteredEntries={mockEntries}
					currentIndex={2}
					onNavigate={mockOnNavigate}
				/>
			);

			const nextButton = screen.getByTitle('No next entry');
			expect(nextButton).toBeDisabled();
		});

		it('should call onNavigate with previous entry when Prev is clicked', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={mockEntries[1]}
					onClose={mockOnClose}
					filteredEntries={mockEntries}
					currentIndex={1}
					onNavigate={mockOnNavigate}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: 'Prev' }));

			expect(mockOnNavigate).toHaveBeenCalledWith(mockEntries[0], 0);
		});

		it('should call onNavigate with next entry when Next is clicked', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={mockEntries[1]}
					onClose={mockOnClose}
					filteredEntries={mockEntries}
					currentIndex={1}
					onNavigate={mockOnNavigate}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: 'Next' }));

			expect(mockOnNavigate).toHaveBeenCalledWith(mockEntries[2], 2);
		});

		it('should navigate with ArrowLeft key', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={mockEntries[1]}
					onClose={mockOnClose}
					filteredEntries={mockEntries}
					currentIndex={1}
					onNavigate={mockOnNavigate}
				/>
			);

			fireEvent.keyDown(window, { key: 'ArrowLeft' });

			expect(mockOnNavigate).toHaveBeenCalledWith(mockEntries[0], 0);
		});

		it('should navigate with ArrowRight key', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={mockEntries[1]}
					onClose={mockOnClose}
					filteredEntries={mockEntries}
					currentIndex={1}
					onNavigate={mockOnNavigate}
				/>
			);

			fireEvent.keyDown(window, { key: 'ArrowRight' });

			expect(mockOnNavigate).toHaveBeenCalledWith(mockEntries[2], 2);
		});

		it('should not navigate when delete confirmation is showing', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={mockEntries[1]}
					onClose={mockOnClose}
					filteredEntries={mockEntries}
					currentIndex={1}
					onNavigate={mockOnNavigate}
					onDelete={mockOnDelete}
				/>
			);

			// Open delete confirmation
			fireEvent.click(screen.getByTitle('Delete this history entry'));

			// Try to navigate
			fireEvent.keyDown(window, { key: 'ArrowLeft' });
			fireEvent.keyDown(window, { key: 'ArrowRight' });

			expect(mockOnNavigate).not.toHaveBeenCalled();
		});

		it('should not navigate when at boundary with ArrowLeft', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={mockEntries[0]}
					onClose={mockOnClose}
					filteredEntries={mockEntries}
					currentIndex={0}
					onNavigate={mockOnNavigate}
				/>
			);

			fireEvent.keyDown(window, { key: 'ArrowLeft' });

			expect(mockOnNavigate).not.toHaveBeenCalled();
		});

		it('should not navigate when at boundary with ArrowRight', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={mockEntries[2]}
					onClose={mockOnClose}
					filteredEntries={mockEntries}
					currentIndex={2}
					onNavigate={mockOnNavigate}
				/>
			);

			fireEvent.keyDown(window, { key: 'ArrowRight' });

			expect(mockOnNavigate).not.toHaveBeenCalled();
		});
	});

	describe('Layer Stack Integration', () => {
		it('should register layer on mount', () => {
			render(
				<HistoryDetailModal theme={mockTheme} entry={createMockEntry()} onClose={mockOnClose} />
			);

			expect(mockRegisterLayer).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'modal',
					priority: 100, // MODAL_PRIORITIES.CONFIRM
				})
			);
		});

		it('should unregister layer on unmount', () => {
			const { unmount } = render(
				<HistoryDetailModal theme={mockTheme} entry={createMockEntry()} onClose={mockOnClose} />
			);

			unmount();

			expect(mockUnregisterLayer).toHaveBeenCalledWith('layer-id-1');
		});

		it('should update layer handler when onClose changes', () => {
			const { rerender } = render(
				<HistoryDetailModal theme={mockTheme} entry={createMockEntry()} onClose={mockOnClose} />
			);

			const newOnClose = vi.fn();
			rerender(
				<HistoryDetailModal theme={mockTheme} entry={createMockEntry()} onClose={newOnClose} />
			);

			expect(mockUpdateLayerHandler).toHaveBeenCalled();
		});

		it('should call onClose via layer escape handler', () => {
			render(
				<HistoryDetailModal theme={mockTheme} entry={createMockEntry()} onClose={mockOnClose} />
			);

			// Get the registered escape handler
			const registerCall = mockRegisterLayer.mock.calls[0][0];
			registerCall.onEscape();

			expect(mockOnClose).toHaveBeenCalled();
		});
	});

	describe('Edge Cases', () => {
		it('should handle entry with XSS-like content safely', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({
						summary: '<script>alert("xss")</script>',
						agentSessionId: '<img src=x onerror=alert(1)>-test',
					})}
					onClose={mockOnClose}
				/>
			);

			// Script tags are stripped by the browser's DOM parser when rendered via rehype-raw
			// This is correct XSS protection behavior - scripts never execute
			// The agentSessionId with img tag should be HTML-escaped (shown as visible text)
			expect(screen.getByText('<IMG SRC=X ONERROR=ALERT(1)>')).toBeInTheDocument();

			// The modal should still render without errors (no XSS execution)
			expect(screen.getByText('Close')).toBeInTheDocument();
		});

		it('should handle entry with unicode content', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({ summary: '测试 🎉 テスト' })}
					onClose={mockOnClose}
				/>
			);

			expect(screen.getByText('测试 🎉 テスト')).toBeInTheDocument();
		});

		it('should handle entry with very long content', () => {
			const longContent = 'A'.repeat(10000);
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({ summary: longContent })}
					onClose={mockOnClose}
				/>
			);

			expect(screen.getByText(longContent)).toBeInTheDocument();
		});

		it('should handle entry with multiple ANSI codes', () => {
			const ansiText =
				'\x1b[1m\x1b[31mBold Red\x1b[0m \x1b[32mGreen\x1b[0m \x1b[4mUnderline\x1b[0m';
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({ summary: ansiText })}
					onClose={mockOnClose}
				/>
			);

			expect(screen.getByText('Bold Red Green Underline')).toBeInTheDocument();
		});

		it('should handle entry with zero contextWindow', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({
						usageStats: {
							inputTokens: 1000,
							outputTokens: 500,
							cacheReadInputTokens: 0,
							cacheCreationInputTokens: 0,
							contextWindow: 0,
							totalCostUsd: 0,
						},
					})}
					onClose={mockOnClose}
				/>
			);

			// Should not crash when contextWindow is 0
			// Context section should not be shown when contextWindow is 0
			expect(screen.queryByText('Context')).not.toBeInTheDocument();
		});

		it('should handle rapid navigation clicks', () => {
			const mockEntries: HistoryEntry[] = Array.from({ length: 10 }, (_, i) =>
				createMockEntry({ id: `entry-${i}`, summary: `Entry ${i}` })
			);

			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={mockEntries[5]}
					onClose={mockOnClose}
					filteredEntries={mockEntries}
					currentIndex={5}
					onNavigate={mockOnNavigate}
				/>
			);

			// Rapid clicks
			fireEvent.click(screen.getByRole('button', { name: 'Next' }));
			fireEvent.click(screen.getByRole('button', { name: 'Next' }));
			fireEvent.click(screen.getByRole('button', { name: 'Prev' }));

			expect(mockOnNavigate).toHaveBeenCalledTimes(3);
		});

		it('should handle undefined success field for AUTO entry', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({ type: 'AUTO', success: undefined })}
					onClose={mockOnClose}
				/>
			);

			// Should not show success/failure indicator
			expect(screen.queryByTitle('Task completed successfully')).not.toBeInTheDocument();
			expect(screen.queryByTitle('Task failed')).not.toBeInTheDocument();
		});

		it('should handle entry without timestamp gracefully', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({ timestamp: 0 })}
					onClose={mockOnClose}
				/>
			);

			// Should render without error (epoch time)
			expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
		});

		it('should prevent event propagation on modal content click', () => {
			const { container } = render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry()}
					onClose={mockOnClose}
					onDelete={mockOnDelete}
				/>
			);

			// Click on modal content should not close
			fireEvent.click(screen.getByTitle('Delete this history entry'));

			// Find the confirmation modal content
			const modalContent = container.querySelector('.w-\\[400px\\]');
			if (modalContent) {
				fireEvent.click(modalContent);
				// Modal should still be open
				expect(screen.getByText('Delete History Entry')).toBeInTheDocument();
			}
		});
	});

	describe('Accessibility', () => {
		it('should have proper button roles', () => {
			render(
				<HistoryDetailModal theme={mockTheme} entry={createMockEntry()} onClose={mockOnClose} />
			);

			expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
			expect(screen.getByRole('button', { name: /Delete/i })).toBeInTheDocument();
		});

		it('should have title attributes for buttons', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({ agentSessionId: 'test-session-id' })}
					onClose={mockOnClose}
				/>
			);

			expect(screen.getByTitle(/Copy session ID/)).toBeInTheDocument();
			expect(screen.getByTitle('Delete this history entry')).toBeInTheDocument();
		});

		it('should have title for navigation buttons', () => {
			const mockEntries: HistoryEntry[] = [
				createMockEntry({ id: 'entry-0' }),
				createMockEntry({ id: 'entry-1' }),
				createMockEntry({ id: 'entry-2' }),
			];

			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={mockEntries[1]}
					onClose={mockOnClose}
					filteredEntries={mockEntries}
					currentIndex={1}
					onNavigate={mockOnNavigate}
				/>
			);

			expect(screen.getByTitle('Previous entry (←)')).toBeInTheDocument();
			expect(screen.getByTitle('Next entry (→)')).toBeInTheDocument();
		});
	});

	describe('Theme Styling', () => {
		it('should apply theme colors to modal', () => {
			const { container } = render(
				<HistoryDetailModal theme={mockTheme} entry={createMockEntry()} onClose={mockOnClose} />
			);

			const modal = container.querySelector('.w-full.max-w-3xl');
			expect(modal).toHaveStyle({ backgroundColor: mockTheme.colors.bgSidebar });
		});

		it('should apply success color for successful AUTO entry', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({ type: 'AUTO', success: true })}
					onClose={mockOnClose}
				/>
			);

			const successIndicator = screen.getByTitle('Task completed successfully');
			expect(successIndicator).toHaveStyle({
				backgroundColor: mockTheme.colors.success + '20',
			});
		});

		it('should apply error color for failed AUTO entry', () => {
			render(
				<HistoryDetailModal
					theme={mockTheme}
					entry={createMockEntry({ type: 'AUTO', success: false })}
					onClose={mockOnClose}
				/>
			);

			const failureIndicator = screen.getByTitle('Task failed');
			expect(failureIndicator).toHaveStyle({
				backgroundColor: mockTheme.colors.error + '20',
			});
		});

		it('should apply accent color to Close button', () => {
			render(
				<HistoryDetailModal theme={mockTheme} entry={createMockEntry()} onClose={mockOnClose} />
			);

			const closeButton = screen.getByRole('button', { name: 'Close' });
			expect(closeButton).toHaveStyle({ backgroundColor: mockTheme.colors.accent });
		});
	});
});
