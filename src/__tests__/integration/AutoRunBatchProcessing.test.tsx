/**
 * @file AutoRunBatchProcessing.test.tsx
 * @description Integration tests for Auto Run and Batch Processing interaction
 *
 * Tests the integration between the AutoRun component and batch processing:
 * - Batch run locks editing
 * - Mode switches to preview during batch run
 * - Mode restores after batch run ends
 * - Task checkbox updates during batch run
 * - Stop button cancels batch run
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React, { createRef } from 'react';
import { AutoRun, AutoRunHandle } from '../../renderer/components/AutoRun';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import type { Theme, BatchRunState, SessionState } from '../../renderer/types';

// Helper to render with LayerStackProvider (required by AutoRunSearchBar)
const renderWithProvider = (ui: React.ReactElement) => {
	const result = render(<LayerStackProvider>{ui}</LayerStackProvider>);
	return {
		...result,
		rerender: (newUi: React.ReactElement) =>
			result.rerender(<LayerStackProvider>{newUi}</LayerStackProvider>),
	};
};

// Mock external dependencies
vi.mock('react-markdown', () => ({
	default: ({ children }: { children: string }) => (
		<div data-testid="react-markdown">{children}</div>
	),
}));

vi.mock('remark-gfm', () => ({
	default: {},
}));

vi.mock('react-syntax-highlighter', () => ({
	Prism: ({ children }: { children: string }) => (
		<code data-testid="syntax-highlighter">{children}</code>
	),
}));

vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({
	vscDarkPlus: {},
}));

vi.mock('../../renderer/components/AutoRunnerHelpModal', () => ({
	AutoRunnerHelpModal: ({ onClose }: { onClose: () => void }) => (
		<div data-testid="help-modal">
			<button onClick={onClose}>Close</button>
		</div>
	),
}));

vi.mock('../../renderer/components/MermaidRenderer', () => ({
	MermaidRenderer: ({ chart }: { chart: string }) => (
		<div data-testid="mermaid-renderer">{chart}</div>
	),
}));

vi.mock('../../renderer/components/AutoRunDocumentSelector', () => ({
	AutoRunDocumentSelector: ({
		documents,
		selectedDocument,
		onSelectDocument,
		onRefresh,
		onChangeFolder,
		isLoading,
	}: any) => (
		<div data-testid="document-selector">
			<select
				data-testid="doc-select"
				value={selectedDocument || ''}
				onChange={(e) => onSelectDocument(e.target.value)}
			>
				{documents.map((doc: string) => (
					<option key={doc} value={doc}>
						{doc}
					</option>
				))}
			</select>
			<button data-testid="refresh-btn" onClick={onRefresh}>
				Refresh
			</button>
			<button data-testid="change-folder-btn" onClick={onChangeFolder}>
				Change
			</button>
			{isLoading && <span data-testid="loading-indicator">Loading...</span>}
		</div>
	),
}));

vi.mock('../../renderer/hooks/useTemplateAutocomplete', () => ({
	useTemplateAutocomplete: ({ onChange }: { value: string; onChange: (value: string) => void }) => {
		return {
			autocompleteState: {
				isOpen: false,
				suggestions: [],
				selectedIndex: 0,
				position: { top: 0, left: 0 },
			},
			handleKeyDown: () => false,
			handleChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => {
				onChange(e.target.value);
			},
			selectVariable: () => {},
			closeAutocomplete: () => {},
			autocompleteRef: { current: null },
		};
	},
}));

vi.mock('../../renderer/components/TemplateAutocompleteDropdown', () => ({
	TemplateAutocompleteDropdown: React.forwardRef(() => null),
}));

// Create a mock theme for testing
const createMockTheme = (): Theme => ({
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a1a',
		bgPanel: '#252525',
		bgActivity: '#2d2d2d',
		bgSidebar: '#1e1e1e',
		textMain: '#ffffff',
		textDim: '#888888',
		accent: '#0066ff',
		accentForeground: '#ffffff',
		border: '#333333',
		highlight: '#0066ff33',
		success: '#00aa00',
		warning: '#ffaa00',
		error: '#ff0000',
	},
});

// Setup window.maestro mock
const setupMaestroMock = () => {
	const mockMaestro = {
		fs: {
			readFile: vi.fn().mockResolvedValue('data:image/png;base64,abc123'),
			readDir: vi.fn().mockResolvedValue([]),
		},
		autorun: {
			listImages: vi.fn().mockResolvedValue({ success: true, images: [] }),
			saveImage: vi.fn().mockResolvedValue({ success: true, relativePath: 'images/test-123.png' }),
			deleteImage: vi.fn().mockResolvedValue({ success: true }),
			writeDoc: vi.fn().mockResolvedValue(undefined),
		},
		settings: {
			get: vi.fn().mockResolvedValue(null),
			set: vi.fn().mockResolvedValue(undefined),
		},
	};

	(window as any).maestro = mockMaestro;
	return mockMaestro;
};

// Create base batch run state
const createBatchRunState = (overrides: Partial<BatchRunState> = {}): BatchRunState => ({
	isRunning: false,
	isStopping: false,
	documents: ['Phase 1'],
	lockedDocuments: ['Phase 1'], // Lock the default selectedFile so isLocked = true when isRunning
	currentDocumentIndex: 0,
	currentDocTasksTotal: 3,
	currentDocTasksCompleted: 0,
	totalTasksAcrossAllDocs: 3,
	completedTasksAcrossAllDocs: 0,
	loopEnabled: false,
	loopIteration: 0,
	folderPath: '/test/folder',
	worktreeActive: false,
	totalTasks: 3,
	completedTasks: 0,
	currentTaskIndex: 0,
	originalContent: '',
	sessionIds: [],
	...overrides,
});

// Default props for AutoRun component
const createDefaultProps = (overrides: Partial<React.ComponentProps<typeof AutoRun>> = {}) => ({
	theme: createMockTheme(),
	sessionId: 'test-session-1',
	folderPath: '/test/folder',
	selectedFile: 'Phase 1',
	documentList: ['Phase 1', 'Phase 2'],
	content: `# Phase 1 Tasks

- [ ] Task 1: Set up project structure
- [ ] Task 2: Create main component
- [ ] Task 3: Add styling

## Notes
Some implementation notes here.`,
	onContentChange: vi.fn(),
	mode: 'edit' as const,
	onModeChange: vi.fn(),
	onOpenSetup: vi.fn(),
	onRefresh: vi.fn(),
	onSelectDocument: vi.fn(),
	onCreateDocument: vi.fn().mockResolvedValue(true),
	onOpenBatchRunner: vi.fn(),
	onStopBatchRun: vi.fn(),
	sessionState: 'idle' as SessionState,
	...overrides,
});

describe('AutoRun + Batch Processing Integration', () => {
	let mockMaestro: ReturnType<typeof setupMaestroMock>;

	beforeEach(() => {
		mockMaestro = setupMaestroMock();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	describe('Batch Run Locks Editing', () => {
		it('disables textarea when batch run is active', () => {
			const batchRunState = createBatchRunState({ isRunning: true });
			const props = createDefaultProps({ batchRunState });
			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			expect(textarea).toHaveAttribute('readonly');
		});

		it('shows locked styling on textarea during batch run', () => {
			const batchRunState = createBatchRunState({ isRunning: true });
			const props = createDefaultProps({ batchRunState });
			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			expect(textarea).toHaveClass('cursor-not-allowed');
			expect(textarea).toHaveClass('opacity-70');
		});

		it('prevents keyboard shortcuts like Cmd+L from working during batch run', () => {
			const batchRunState = createBatchRunState({ isRunning: true });
			const props = createDefaultProps({ batchRunState, content: 'Test content' });
			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			fireEvent.keyDown(textarea, { key: 'l', metaKey: true });

			// Content should not be modified (no checkbox inserted)
			expect(textarea).toHaveValue('Test content');
		});

		it('disables the Edit button during batch run', () => {
			const batchRunState = createBatchRunState({ isRunning: true });
			const props = createDefaultProps({ batchRunState, mode: 'preview' });
			renderWithProvider(<AutoRun {...props} />);

			const editButton = screen.getByTitle(/Editing disabled while Auto Run active/i);
			expect(editButton).toBeDisabled();
		});

		it('shows Stop button instead of Run button during batch run', () => {
			const batchRunState = createBatchRunState({ isRunning: true });
			const props = createDefaultProps({ batchRunState });
			renderWithProvider(<AutoRun {...props} />);

			expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();
			expect(screen.queryByRole('button', { name: /^run$/i })).not.toBeInTheDocument();
		});

		it('allows editing when batch run is not active', () => {
			const props = createDefaultProps();
			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			expect(textarea).not.toHaveAttribute('readonly');
		});

		it('does not lock editing when batchRunState.isRunning is false', () => {
			const batchRunState = createBatchRunState({ isRunning: false });
			const props = createDefaultProps({ batchRunState });
			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			expect(textarea).not.toHaveAttribute('readonly');
			expect(textarea).not.toHaveClass('cursor-not-allowed');
		});
	});

	describe('Mode Switches to Preview During Batch Run', () => {
		it('automatically switches to preview mode when batch run starts', async () => {
			const onModeChange = vi.fn();
			const props = createDefaultProps({ mode: 'edit', onModeChange });
			const { rerender } = renderWithProvider(<AutoRun {...props} />);

			// Verify initially in edit mode
			expect(screen.getByRole('textbox')).toBeInTheDocument();

			// Start batch run
			const batchRunState = createBatchRunState({ isRunning: true });
			rerender(<AutoRun {...props} batchRunState={batchRunState} />);

			// Should have called onModeChange to switch to preview
			await waitFor(() => {
				expect(onModeChange).toHaveBeenCalledWith('preview');
			});
		});

		it('forces preview mode display when batch run is active regardless of mode prop', () => {
			const batchRunState = createBatchRunState({ isRunning: true });
			// Note: Component switches to preview internally, but we test that textarea is readonly
			// which is the locked state indicator
			const props = createDefaultProps({ batchRunState, mode: 'edit' });
			renderWithProvider(<AutoRun {...props} />);

			// Textarea should be locked (readonly)
			const textarea = screen.getByRole('textbox');
			expect(textarea).toHaveAttribute('readonly');
		});

		it('shows preview-selected styling during batch run', () => {
			const batchRunState = createBatchRunState({ isRunning: true });
			const props = createDefaultProps({ batchRunState, mode: 'preview' });
			renderWithProvider(<AutoRun {...props} />);

			// Preview button should be styled as selected when locked (has font-semibold class)
			const previewButton = screen.getByRole('button', { name: /preview/i });
			// font-semibold in Tailwind applies font-weight: 600, but toHaveStyle doesn't work well with Tailwind
			// Instead, check the class is applied
			expect(previewButton).toHaveClass('font-semibold');
		});
	});

	describe('Mode Restores After Batch Run Ends', () => {
		it('restores edit mode after batch run ends if it was in edit mode before', async () => {
			const onModeChange = vi.fn();
			const props = createDefaultProps({ mode: 'edit', onModeChange });
			const { rerender } = renderWithProvider(<AutoRun {...props} />);

			// Start batch run
			const batchRunStateRunning = createBatchRunState({ isRunning: true });
			rerender(<AutoRun {...props} batchRunState={batchRunStateRunning} />);

			// Wait for mode switch to preview
			await waitFor(() => {
				expect(onModeChange).toHaveBeenCalledWith('preview');
			});

			// End batch run
			const batchRunStateStopped = createBatchRunState({ isRunning: false });
			rerender(<AutoRun {...props} batchRunState={batchRunStateStopped} mode="preview" />);

			// Should restore to edit mode
			await waitFor(() => {
				expect(onModeChange).toHaveBeenCalledWith('edit');
			});
		});

		it('keeps preview mode after batch run ends if it was in preview mode before', async () => {
			const onModeChange = vi.fn();
			const props = createDefaultProps({ mode: 'preview', onModeChange });
			const { rerender } = renderWithProvider(<AutoRun {...props} />);

			// Start batch run
			const batchRunStateRunning = createBatchRunState({ isRunning: true });
			rerender(<AutoRun {...props} batchRunState={batchRunStateRunning} />);

			// End batch run
			const batchRunStateStopped = createBatchRunState({ isRunning: false });
			rerender(<AutoRun {...props} batchRunState={batchRunStateStopped} />);

			// Should restore to preview mode (original mode)
			await waitFor(() => {
				expect(onModeChange).toHaveBeenLastCalledWith('preview');
			});
		});

		it('unlocks textarea after batch run ends', async () => {
			const props = createDefaultProps();
			const { rerender } = renderWithProvider(<AutoRun {...props} />);

			// Start batch run
			const batchRunStateRunning = createBatchRunState({ isRunning: true });
			rerender(<AutoRun {...props} batchRunState={batchRunStateRunning} />);

			// Verify locked
			expect(screen.getByRole('textbox')).toHaveAttribute('readonly');

			// End batch run
			const batchRunStateStopped = createBatchRunState({ isRunning: false });
			rerender(<AutoRun {...props} batchRunState={batchRunStateStopped} />);

			// Should be unlocked
			expect(screen.getByRole('textbox')).not.toHaveAttribute('readonly');
		});

		it('re-enables Edit button after batch run ends', async () => {
			const props = createDefaultProps({ mode: 'preview' });
			const { rerender } = renderWithProvider(<AutoRun {...props} />);

			// Start batch run
			const batchRunStateRunning = createBatchRunState({ isRunning: true });
			rerender(<AutoRun {...props} batchRunState={batchRunStateRunning} />);

			// Verify Edit button is disabled
			const editButtonLocked = screen.getByTitle(/Editing disabled while Auto Run active/i);
			expect(editButtonLocked).toBeDisabled();

			// End batch run
			const batchRunStateStopped = createBatchRunState({ isRunning: false });
			rerender(<AutoRun {...props} batchRunState={batchRunStateStopped} />);

			// Edit button should be enabled - use title to get specific Edit button
			const editButton = screen.getByTitle('Edit document');
			expect(editButton).not.toBeDisabled();
		});
	});

	describe('Task Checkbox Updates During Batch Run', () => {
		it('displays updated task count when content changes during batch run', async () => {
			const batchRunState = createBatchRunState({ isRunning: true });
			const initialContent = `- [ ] Task 1
- [ ] Task 2
- [ ] Task 3`;
			const props = createDefaultProps({ batchRunState, content: initialContent, mode: 'preview' });
			const { rerender } = renderWithProvider(<AutoRun {...props} />);

			// Verify initial task count (3 tasks, 0 completed)
			expect(screen.getByText(/0 of 3 tasks completed/i)).toBeInTheDocument();

			// Simulate task completion - content updated externally
			const updatedContent = `- [x] Task 1
- [ ] Task 2
- [ ] Task 3`;
			rerender(<AutoRun {...props} content={updatedContent} contentVersion={1} />);

			// Task count should update
			await waitFor(() => {
				expect(screen.getByText(/1 of 3 tasks completed/i)).toBeInTheDocument();
			});
		});

		it('shows progress when multiple tasks are completed', async () => {
			const batchRunState = createBatchRunState({ isRunning: true });
			const props = createDefaultProps({
				batchRunState,
				content: `- [x] Task 1
- [x] Task 2
- [ ] Task 3`,
				mode: 'preview',
			});
			renderWithProvider(<AutoRun {...props} />);

			expect(screen.getByText(/2 of 3 tasks completed/i)).toBeInTheDocument();
		});

		it('shows success styling when all tasks are completed', async () => {
			const batchRunState = createBatchRunState({ isRunning: true });
			const props = createDefaultProps({
				batchRunState,
				content: `- [x] Task 1
- [x] Task 2
- [x] Task 3`,
				mode: 'preview',
			});
			const { container } = renderWithProvider(<AutoRun {...props} />);

			// Find the task count element and verify it has success color
			const taskCountElement = screen.getByText(/3 of 3 tasks completed/i);
			expect(taskCountElement).toHaveStyle({ color: createMockTheme().colors.success });
		});

		it('reflects content version changes by syncing with external updates', async () => {
			const batchRunState = createBatchRunState({ isRunning: true });
			const props = createDefaultProps({
				batchRunState,
				content: '- [ ] Initial task',
				contentVersion: 0,
				mode: 'preview',
			});
			const { rerender } = renderWithProvider(<AutoRun {...props} />);

			// Update with new version
			rerender(<AutoRun {...props} content="- [x] Initial task" contentVersion={1} />);

			await waitFor(() => {
				expect(screen.getByText(/1 of 1 task completed/i)).toBeInTheDocument();
			});
		});

		it('handles documents with no tasks gracefully', () => {
			const batchRunState = createBatchRunState({ isRunning: true });
			const props = createDefaultProps({
				batchRunState,
				content: '# Notes\n\nJust some text, no tasks.',
				mode: 'preview',
			});
			renderWithProvider(<AutoRun {...props} />);

			// Should not display task count when there are no tasks
			expect(screen.queryByText(/tasks? completed/i)).not.toBeInTheDocument();
		});
	});

	describe('Stop Button Cancels Batch Run', () => {
		it('shows Stop button when batch run is active', () => {
			const batchRunState = createBatchRunState({ isRunning: true });
			const props = createDefaultProps({ batchRunState });
			renderWithProvider(<AutoRun {...props} />);

			expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();
		});

		it('calls onStopBatchRun when Stop button is clicked', () => {
			const onStopBatchRun = vi.fn();
			const batchRunState = createBatchRunState({ isRunning: true });
			const props = createDefaultProps({ batchRunState, onStopBatchRun });
			renderWithProvider(<AutoRun {...props} />);

			fireEvent.click(screen.getByRole('button', { name: /stop/i }));

			expect(onStopBatchRun).toHaveBeenCalledTimes(1);
		});

		it('shows "Stopping..." state when isStopping is true', () => {
			const batchRunState = createBatchRunState({ isRunning: true, isStopping: true });
			const props = createDefaultProps({ batchRunState });
			renderWithProvider(<AutoRun {...props} />);

			expect(screen.getByRole('button', { name: /stopping/i })).toBeInTheDocument();
		});

		it('disables Stop button while stopping', () => {
			const batchRunState = createBatchRunState({ isRunning: true, isStopping: true });
			const props = createDefaultProps({ batchRunState });
			renderWithProvider(<AutoRun {...props} />);

			const stopButton = screen.getByRole('button', { name: /stopping/i });
			expect(stopButton).toBeDisabled();
		});

		it('shows loading spinner while stopping', () => {
			const batchRunState = createBatchRunState({ isRunning: true, isStopping: true });
			const props = createDefaultProps({ batchRunState });
			const { container } = renderWithProvider(<AutoRun {...props} />);

			// Look for the animate-spin class which indicates the loading spinner
			const spinner = container.querySelector('.animate-spin');
			expect(spinner).toBeInTheDocument();
		});

		it('shows Run button after batch run is stopped', () => {
			const batchRunState = createBatchRunState({ isRunning: false });
			const props = createDefaultProps({ batchRunState });
			renderWithProvider(<AutoRun {...props} />);

			expect(screen.getByRole('button', { name: /^run$/i })).toBeInTheDocument();
			expect(screen.queryByRole('button', { name: /stop/i })).not.toBeInTheDocument();
		});

		it('Run button is disabled when agent is busy', () => {
			const props = createDefaultProps({ sessionState: 'busy' as SessionState });
			renderWithProvider(<AutoRun {...props} />);

			// Use title to get specific Run button (avoids matching "Auto Run" in other text)
			const runButton = screen.getByTitle(/Cannot run while agent is thinking/i);
			expect(runButton).toBeDisabled();
		});

		it('Run button is disabled when agent is connecting', () => {
			const props = createDefaultProps({ sessionState: 'connecting' as SessionState });
			renderWithProvider(<AutoRun {...props} />);

			// Use title to get specific Run button (avoids matching "Auto Run" in other text)
			const runButton = screen.getByTitle(/Cannot run while agent is thinking/i);
			expect(runButton).toBeDisabled();
		});

		it('shows Stop button even when viewing an unlocked document while Auto Run is active', () => {
			// This tests the key behavior: you can only run one Auto Run per session at a time.
			// Even if viewing a document NOT in the batch, the Stop button should show.
			const batchRunState = createBatchRunState({
				isRunning: true,
				lockedDocuments: ['Phase 1'], // Only Phase 1 is locked
			});
			// Viewing Phase 2 (not in lockedDocuments), but batch run is active
			const props = createDefaultProps({
				batchRunState,
				selectedFile: 'Phase 2',
				documentList: ['Phase 1', 'Phase 2'],
			});
			renderWithProvider(<AutoRun {...props} />);

			// Should still show Stop button (not Run) because Auto Run is active for session
			expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();
			expect(screen.queryByRole('button', { name: /^run$/i })).not.toBeInTheDocument();
		});

		it('prevents starting another Auto Run while one is already active', () => {
			// When Auto Run is active, user should not be able to start another one
			const batchRunState = createBatchRunState({ isRunning: true });
			const onOpenBatchRunner = vi.fn();
			const props = createDefaultProps({ batchRunState, onOpenBatchRunner });
			renderWithProvider(<AutoRun {...props} />);

			// Run button should not be visible at all (replaced by Stop button)
			expect(screen.queryByRole('button', { name: /^run$/i })).not.toBeInTheDocument();

			// Stop button should be visible instead
			const stopButton = screen.getByRole('button', { name: /stop/i });
			expect(stopButton).toBeInTheDocument();

			// Clicking Stop should NOT open batch runner
			fireEvent.click(stopButton);
			expect(onOpenBatchRunner).not.toHaveBeenCalled();
		});
	});

	describe('Image Upload Disabled During Batch Run', () => {
		it('disables image upload button during batch run', () => {
			const batchRunState = createBatchRunState({ isRunning: true });
			const props = createDefaultProps({ batchRunState });
			renderWithProvider(<AutoRun {...props} />);

			// Image button should be disabled/ghosted
			const imageButton = screen.getByTitle(/Switch to Edit mode to add images/i);
			expect(imageButton).toBeDisabled();
		});

		it('enables image upload button when batch run ends', () => {
			const props = createDefaultProps();
			renderWithProvider(<AutoRun {...props} />);

			const imageButton = screen.getByTitle(/Add image \(or paste from clipboard\)/i);
			expect(imageButton).not.toBeDisabled();
		});

		it('shows correct tooltip for image button during batch run', () => {
			const batchRunState = createBatchRunState({ isRunning: true });
			const props = createDefaultProps({ batchRunState });
			renderWithProvider(<AutoRun {...props} />);

			const imageButton = screen.getByTitle(/Switch to Edit mode to add images/i);
			expect(imageButton).toBeInTheDocument();
		});
	});

	describe('Imperative Handle During Batch Run', () => {
		it('isDirty() returns false during batch run since editing is locked', async () => {
			const ref = createRef<AutoRunHandle>();
			const batchRunState = createBatchRunState({ isRunning: true });
			const props = createDefaultProps({ batchRunState });
			renderWithProvider(<AutoRun {...props} ref={ref} />);

			// Since editing is locked, there should be no dirty state
			expect(ref.current?.isDirty()).toBe(false);
		});

		it('switchMode() still works via ref during batch run', async () => {
			const ref = createRef<AutoRunHandle>();
			const onModeChange = vi.fn();
			const batchRunState = createBatchRunState({ isRunning: true });
			const props = createDefaultProps({ batchRunState, onModeChange, mode: 'edit' });
			renderWithProvider(<AutoRun {...props} ref={ref} />);

			// Call switchMode via ref
			act(() => {
				ref.current?.switchMode('preview');
			});

			expect(onModeChange).toHaveBeenCalledWith('preview');
		});

		it('focus() works during batch run', async () => {
			const ref = createRef<AutoRunHandle>();
			const batchRunState = createBatchRunState({ isRunning: true });
			const props = createDefaultProps({ batchRunState });
			renderWithProvider(<AutoRun {...props} ref={ref} />);

			// Should not throw
			act(() => {
				ref.current?.focus();
			});

			// Textarea should be focused (even though readonly)
			expect(document.activeElement?.tagName).toBe('TEXTAREA');
		});
	});

	describe('Batch Run State Transitions', () => {
		it('handles transition from idle to running', async () => {
			const onModeChange = vi.fn();
			const props = createDefaultProps({ mode: 'edit', onModeChange });
			const { rerender } = renderWithProvider(<AutoRun {...props} />);

			// Initial state - editing enabled
			expect(screen.getByRole('textbox')).not.toHaveAttribute('readonly');

			// Transition to running
			const runningState = createBatchRunState({ isRunning: true });
			rerender(<AutoRun {...props} batchRunState={runningState} />);

			// Should be locked now
			expect(screen.getByRole('textbox')).toHaveAttribute('readonly');
		});

		it('handles transition from running to stopping', async () => {
			const runningState = createBatchRunState({ isRunning: true });
			const props = createDefaultProps({ batchRunState: runningState });
			const { rerender } = renderWithProvider(<AutoRun {...props} />);

			// Verify Stop button
			expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();

			// Transition to stopping
			const stoppingState = createBatchRunState({ isRunning: true, isStopping: true });
			rerender(<AutoRun {...props} batchRunState={stoppingState} />);

			// Should show Stopping... button
			expect(screen.getByRole('button', { name: /stopping/i })).toBeInTheDocument();
		});

		it('handles transition from stopping to stopped', async () => {
			const stoppingState = createBatchRunState({ isRunning: true, isStopping: true });
			const props = createDefaultProps({ batchRunState: stoppingState });
			const { rerender } = renderWithProvider(<AutoRun {...props} />);

			// Verify Stopping... button
			expect(screen.getByRole('button', { name: /stopping/i })).toBeInTheDocument();

			// Transition to stopped
			const stoppedState = createBatchRunState({ isRunning: false, isStopping: false });
			rerender(<AutoRun {...props} batchRunState={stoppedState} />);

			// Should show Run button
			expect(screen.getByRole('button', { name: /^run$/i })).toBeInTheDocument();
		});

		it('handles undefined batchRunState gracefully', () => {
			const props = createDefaultProps({ batchRunState: undefined });
			renderWithProvider(<AutoRun {...props} />);

			// Should render normally with Run button
			expect(screen.getByRole('button', { name: /^run$/i })).toBeInTheDocument();
			expect(screen.getByRole('textbox')).not.toHaveAttribute('readonly');
		});
	});

	describe('Run Button Behavior', () => {
		it('calls onOpenBatchRunner when Run button is clicked', () => {
			const onOpenBatchRunner = vi.fn();
			const props = createDefaultProps({ onOpenBatchRunner });
			renderWithProvider(<AutoRun {...props} />);

			fireEvent.click(screen.getByRole('button', { name: /^run$/i }));

			expect(onOpenBatchRunner).toHaveBeenCalledTimes(1);
		});

		it('saves dirty content before opening batch runner', async () => {
			const onOpenBatchRunner = vi.fn();
			const props = createDefaultProps({ onOpenBatchRunner, content: 'Initial' });
			renderWithProvider(<AutoRun {...props} />);

			// Make content dirty
			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Modified content' } });

			// Click Run
			fireEvent.click(screen.getByRole('button', { name: /^run$/i }));

			// writeDoc should have been called to save
			await waitFor(() => {
				expect(mockMaestro.autorun.writeDoc).toHaveBeenCalled();
			});

			expect(onOpenBatchRunner).toHaveBeenCalledTimes(1);
		});

		it('does not save clean content before opening batch runner', async () => {
			const onOpenBatchRunner = vi.fn();
			const props = createDefaultProps({ onOpenBatchRunner });
			renderWithProvider(<AutoRun {...props} />);

			// Click Run without modifying content
			fireEvent.click(screen.getByRole('button', { name: /^run$/i }));

			// writeDoc should not have been called
			expect(mockMaestro.autorun.writeDoc).not.toHaveBeenCalled();
			expect(onOpenBatchRunner).toHaveBeenCalledTimes(1);
		});

		it('shows tooltip explaining why Run is disabled when agent is busy', () => {
			const props = createDefaultProps({ sessionState: 'busy' as SessionState });
			renderWithProvider(<AutoRun {...props} />);

			// Use title to get specific Run button (avoids matching "Auto Run" in other text)
			const runButton = screen.getByTitle('Cannot run while agent is thinking');
			expect(runButton).toBeDisabled();
		});
	});

	describe('Keyboard Shortcuts During Batch Run', () => {
		it('Cmd+S does not trigger save during batch run (locked)', () => {
			const batchRunState = createBatchRunState({ isRunning: true });
			const props = createDefaultProps({ batchRunState });
			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			fireEvent.keyDown(textarea, { key: 's', metaKey: true });

			// writeDoc should not be called
			expect(mockMaestro.autorun.writeDoc).not.toHaveBeenCalled();
		});

		it('Cmd+E still toggles mode during batch run (via container)', () => {
			const onModeChange = vi.fn();
			const batchRunState = createBatchRunState({ isRunning: true });
			const props = createDefaultProps({ batchRunState, mode: 'edit', onModeChange });
			const { container } = renderWithProvider(<AutoRun {...props} />);

			// Find the container div
			const containerDiv = container.querySelector('[tabIndex="-1"]');
			fireEvent.keyDown(containerDiv!, { key: 'e', metaKey: true });

			expect(onModeChange).toHaveBeenCalledWith('preview');
		});

		it('Cmd+F opens search during batch run', () => {
			const batchRunState = createBatchRunState({ isRunning: true });
			const props = createDefaultProps({ batchRunState, mode: 'preview' });
			const { container } = renderWithProvider(<AutoRun {...props} />);

			// Find the container div
			const containerDiv = container.querySelector('[tabIndex="-1"]');
			fireEvent.keyDown(containerDiv!, { key: 'f', metaKey: true });

			// Search bar should be visible
			expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument();
		});
	});

	describe('Progress Display During Batch Run', () => {
		it('shows warning border color on textarea during batch run', () => {
			const batchRunState = createBatchRunState({ isRunning: true });
			const props = createDefaultProps({ batchRunState });
			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			expect(textarea).toHaveStyle({ borderColor: createMockTheme().colors.warning });
		});

		it('displays document name during batch run', () => {
			const batchRunState = createBatchRunState({
				isRunning: true,
				documents: ['Phase 1', 'Phase 2'],
				currentDocumentIndex: 0,
			});
			const props = createDefaultProps({ batchRunState, selectedFile: 'Phase 1' });
			renderWithProvider(<AutoRun {...props} />);

			// Document selector should show current document
			expect(screen.getByTestId('doc-select')).toHaveValue('Phase 1');
		});
	});
});
