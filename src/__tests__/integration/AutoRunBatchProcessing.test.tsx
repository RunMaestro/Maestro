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
import { imageCache } from '../../renderer/hooks/batch/useAutoRunImageHandling';
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

const getByExactTextContent = (text: string): HTMLElement =>
	screen.getByText((_, element) => {
		const normalize = (value: string | null | undefined) =>
			value?.replace(/\s+/g, ' ').trim() ?? '';
		const elementText = normalize(element?.textContent);
		const childHasSameText = Array.from(element?.children ?? []).some(
			(child) => normalize(child.textContent) === text
		);
		return elementText === text && !childHasSameText;
	});

// Mock external dependencies
vi.mock('react-markdown', () => ({
	default: ({
		children,
		components,
	}: {
		children: string;
		components?: {
			a?: React.ComponentType<{ href?: string; children?: React.ReactNode }>;
			img?: React.ComponentType<{ src?: string; alt?: string }>;
			pre?: React.ComponentType<{ children?: React.ReactNode }>;
		};
	}) => {
		if (typeof children !== 'string') {
			return <div data-testid="react-markdown">{children}</div>;
		}

		const nodes: React.ReactNode[] = [];
		const ImageComponent = components?.img;
		const LinkComponent = components?.a;
		const PreComponent = components?.pre;
		const pushInlineNodes = (text: string, keyPrefix: string) => {
			const inlinePattern = /!\[([^\]]*)\]\(([^)]*)\)|\[([^\]]+)\]\(([^)]+)\)/g;
			let lastIndex = 0;
			let match: RegExpExecArray | null;
			while ((match = inlinePattern.exec(text)) !== null) {
				if (match.index > lastIndex) {
					nodes.push(text.slice(lastIndex, match.index));
				}
				if (match[1] !== undefined && ImageComponent) {
					nodes.push(
						<ImageComponent
							key={`${keyPrefix}-image-${match.index}`}
							alt={match[1]}
							src={match[2]}
						/>
					);
				} else if (match[3] !== undefined && LinkComponent) {
					nodes.push(
						<LinkComponent key={`${keyPrefix}-link-${match.index}`} href={match[4]}>
							{match[3]}
						</LinkComponent>
					);
				} else {
					nodes.push(match[0]);
				}
				lastIndex = match.index + match[0].length;
			}
			if (lastIndex < text.length) {
				nodes.push(text.slice(lastIndex));
			}
		};

		const codeBlockPattern = /```(\w+)\n([\s\S]*?)```/g;
		let lastBlockIndex = 0;
		let blockMatch: RegExpExecArray | null;
		while ((blockMatch = codeBlockPattern.exec(children)) !== null) {
			if (blockMatch.index > lastBlockIndex) {
				pushInlineNodes(
					children.slice(lastBlockIndex, blockMatch.index),
					`text-${blockMatch.index}`
				);
			}
			if (PreComponent) {
				nodes.push(
					<PreComponent key={`pre-${blockMatch.index}`}>
						<code className={`language-${blockMatch[1]}`}>{blockMatch[2]}</code>
					</PreComponent>
				);
			} else {
				nodes.push(blockMatch[0]);
			}
			lastBlockIndex = blockMatch.index + blockMatch[0].length;
		}
		pushInlineNodes(children.slice(lastBlockIndex), 'tail');

		return <div data-testid="react-markdown">{nodes}</div>;
	},
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
	vs: {},
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
		onToggleBionify,
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
			<button data-testid="bionify-toggle" onClick={onToggleBionify}>
				Bionify
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
		shell: {
			openExternal: vi.fn().mockResolvedValue(undefined),
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
		imageCache.clear();
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

			// Preview button should be selected when locked.
			const previewButton = screen.getByRole('button', { name: /preview/i });
			expect(previewButton).toHaveAttribute('aria-pressed', 'true');
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
			expect(getByExactTextContent('0 of 3 tasks completed')).toBeInTheDocument();

			// Simulate task completion - content updated externally
			const updatedContent = `- [x] Task 1
- [ ] Task 2
- [ ] Task 3`;
			rerender(<AutoRun {...props} content={updatedContent} contentVersion={1} />);

			// Task count should update
			await waitFor(() => {
				expect(getByExactTextContent('1 of 3 tasks completed')).toBeInTheDocument();
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

			expect(getByExactTextContent('2 of 3 tasks completed')).toBeInTheDocument();
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
			const taskCountElement = getByExactTextContent('3 of 3 tasks completed');
			expect(taskCountElement.querySelector('span')).toHaveStyle({
				color: createMockTheme().colors.success,
			});
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
				expect(getByExactTextContent('1 of 1 task completed')).toBeInTheDocument();
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
		it('does not render image upload button during batch run', () => {
			const batchRunState = createBatchRunState({ isRunning: true });
			const props = createDefaultProps({ batchRunState });
			renderWithProvider(<AutoRun {...props} />);

			expect(
				screen.queryByTitle(
					/Add image \(or paste from clipboard\)|Switch to Edit mode to add images/i
				)
			).not.toBeInTheDocument();
		});

		it('does not render image upload button when batch run is idle', () => {
			const props = createDefaultProps();
			renderWithProvider(<AutoRun {...props} />);

			expect(screen.queryByTitle(/Add image \(or paste from clipboard\)/i)).not.toBeInTheDocument();
		});

		it('does not render image upload tooltip during batch run', () => {
			const batchRunState = createBatchRunState({ isRunning: true });
			const props = createDefaultProps({ batchRunState });
			renderWithProvider(<AutoRun {...props} />);

			expect(screen.queryByTitle(/Switch to Edit mode to add images/i)).not.toBeInTheDocument();
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

	describe('Preview Images And Editor Keyboard', () => {
		it('uses cached markdown image state and opens an external image lightbox', async () => {
			imageCache.set('/test/folder:images/cached.png', 'data:image/png;base64,cached');
			imageCache.set('/test/folder:plain-cached.png', 'data:image/png;base64,plain');
			const props = createDefaultProps({
				mode: 'preview',
				content: [
					'![Blank]()',
					'![Cached](images/cached.png)',
					'![Plain](plain-cached.png)',
					'![External](https://example.com/external.png)',
				].join('\n'),
			});

			renderWithProvider(<AutoRun {...props} />);

			expect(screen.queryByAltText('Blank')).not.toBeInTheDocument();
			expect(screen.getByAltText('Cached')).toHaveAttribute('src', 'data:image/png;base64,cached');
			expect(screen.getByAltText('Plain')).toHaveAttribute('src', 'data:image/png;base64,plain');
			expect(mockMaestro.fs.readFile).not.toHaveBeenCalledWith(
				'/test/folder/images/cached.png',
				undefined
			);
			expect(mockMaestro.fs.readFile).not.toHaveBeenCalledWith(
				'/test/folder/plain-cached.png',
				undefined
			);

			fireEvent.click(screen.getByAltText('Cached').closest('span')!);
			fireEvent.click(screen.getByAltText('External').closest('span')!);

			expect(await screen.findByAltText('https://example.com/external.png')).toBeInTheDocument();
		});

		it('loads markdown attachment images from data, remote, relative, and absolute sources', async () => {
			mockMaestro.fs.readFile
				.mockResolvedValueOnce('data:image/png;base64,relative')
				.mockResolvedValueOnce('not-image-data')
				.mockRejectedValueOnce(new Error('missing'));
			const props = createDefaultProps({
				mode: 'preview',
				content: [
					'![Inline](data:image/png;base64,aW5saW5l)',
					'![Remote](https://example.com/remote.png)',
					'![Relative](images/flow%20chart.png)',
					'![Invalid](/absolute/invalid.png)',
					'![Missing](plain-missing.png)',
				].join('\n'),
			});

			renderWithProvider(<AutoRun {...props} />);

			expect(screen.getByAltText('Inline')).toHaveAttribute(
				'src',
				'data:image/png;base64,aW5saW5l'
			);
			expect(screen.getByAltText('Remote')).toHaveAttribute(
				'src',
				'https://example.com/remote.png'
			);
			expect(await screen.findByAltText('Relative')).toHaveAttribute(
				'src',
				'data:image/png;base64,relative'
			);
			expect(mockMaestro.fs.readFile).toHaveBeenCalledWith(
				'/test/folder/images/flow chart.png',
				undefined
			);
			expect(mockMaestro.fs.readFile).toHaveBeenCalledWith('/absolute/invalid.png', undefined);
			expect(mockMaestro.fs.readFile).toHaveBeenCalledWith(
				'/test/folder/plain-missing.png',
				undefined
			);
			expect(await screen.findByText('Invalid image data')).toBeInTheDocument();
			expect(await screen.findByText('Failed to load image: missing')).toBeInTheDocument();
		});

		it('handles editor keyboard insertion, search, and save shortcuts', async () => {
			const props = createDefaultProps({
				content: 'Intro',
			});
			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
			textarea.setSelectionRange(5, 5);
			fireEvent.keyDown(textarea, { key: 'Tab' });
			expect(textarea).toHaveValue('Intro\t');

			textarea.setSelectionRange(0, 0);
			fireEvent.keyDown(textarea, { key: 'l', metaKey: true });
			expect(textarea).toHaveValue('- [ ] Intro\t');

			fireEvent.change(textarea, { target: { value: '- [ ] Task' } });
			textarea.setSelectionRange(textarea.value.length, textarea.value.length);
			fireEvent.keyDown(textarea, { key: 'Enter' });
			expect(textarea).toHaveValue('- [ ] Task\n- [ ] ');

			fireEvent.keyDown(textarea, { key: 'f', metaKey: true });
			fireEvent.change(screen.getByPlaceholderText(/search/i), {
				target: { value: 'Task' },
			});
			await act(async () => {
				vi.advanceTimersByTime(200);
				await Promise.resolve();
			});
			expect(screen.getByText('1/1')).toBeInTheDocument();

			fireEvent.keyDown(textarea, { key: 's', metaKey: true });
			await waitFor(() => expect(mockMaestro.autorun.writeDoc).toHaveBeenCalled());
		});

		it('renders existing attachment previews and removes an attachment through the preview panel', async () => {
			const onContentChange = vi.fn();
			mockMaestro.autorun.listImages.mockResolvedValueOnce({
				success: true,
				images: [{ filename: 'one.png', relativePath: 'images/one.png' }],
			});
			mockMaestro.fs.readFile.mockResolvedValueOnce('data:image/png;base64,one');
			const props = createDefaultProps({
				content: '![one.png](images/one.png)\n',
				onContentChange,
			});

			renderWithProvider(<AutoRun {...props} />);

			const attachmentToggle = await screen.findByRole('button', {
				name: /attached images \(1\)/i,
			});
			const thumbnail = await screen.findByAltText('images/one.png');
			fireEvent.click(thumbnail);
			expect(await screen.findByTitle(/copy markdown reference/i)).toBeInTheDocument();
			fireEvent.click(screen.getByTitle('Close (ESC)'));

			fireEvent.click(attachmentToggle);
			expect(screen.queryByAltText('images/one.png')).not.toBeInTheDocument();
			fireEvent.click(attachmentToggle);

			fireEvent.click(await screen.findByTitle('Remove image'));

			await waitFor(() => {
				expect(mockMaestro.autorun.deleteImage).toHaveBeenCalledWith(
					'/test/folder',
					'images/one.png',
					undefined
				);
			});
			expect(onContentChange).toHaveBeenCalledWith('');
		});

		it('resets completed tasks from the confirmation modal and reports the flash count', async () => {
			const ref = createRef<AutoRunHandle>();
			const onShowFlash = vi.fn();
			const resetContent = '- [ ] Done\n* [ ] Other\n- [ ] Open';
			const props = createDefaultProps({
				content: '- [x] Done\n* [x] Other\n- [ ] Open',
				onShowFlash,
			});

			renderWithProvider(<AutoRun {...props} ref={ref} />);

			act(() => {
				ref.current?.openResetTasksModal();
			});
			expect(screen.getByRole('dialog', { name: 'Reset Completed Tasks' })).toBeInTheDocument();

			fireEvent.click(screen.getByRole('button', { name: 'Reset Tasks' }));

			await waitFor(() => {
				expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledWith(
					'/test/folder',
					'Phase 1.md',
					resetContent,
					undefined
				);
			});
			expect(onShowFlash).toHaveBeenCalledWith('2 tasks reverted to incomplete');
			expect(screen.getByRole('textbox')).toHaveValue(resetContent);
			await waitFor(() => expect(ref.current?.getCompletedTaskCount()).toBe(0));
		});

		it('logs reset save failures without closing over stale task state', async () => {
			const ref = createRef<AutoRunHandle>();
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			try {
				mockMaestro.autorun.writeDoc.mockRejectedValueOnce(new Error('disk full'));
				const props = createDefaultProps({
					content: '- [x] Done',
				});

				renderWithProvider(<AutoRun {...props} ref={ref} />);

				act(() => {
					ref.current?.openResetTasksModal();
				});
				fireEvent.click(screen.getByRole('button', { name: 'Reset Tasks' }));

				await waitFor(() => {
					expect(consoleError).toHaveBeenCalledWith(
						'Failed to save after reset:',
						expect.any(Error)
					);
				});
			} finally {
				consoleError.mockRestore();
			}
		});

		it('navigates edit-mode search matches and closes back to the editor', async () => {
			const content = 'Alpha beta\nAlpha gamma\nAlpha delta';
			const props = createDefaultProps({ content });
			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
			Object.defineProperty(textarea, 'clientHeight', { value: 40, configurable: true });
			Object.defineProperty(textarea, 'clientWidth', { value: 240, configurable: true });

			fireEvent.keyDown(textarea, { key: 'f', metaKey: true });
			fireEvent.change(screen.getByPlaceholderText(/search/i), {
				target: { value: 'Alpha' },
			});

			await act(async () => {
				vi.advanceTimersByTime(200);
				await Promise.resolve();
			});
			expect(screen.getByText('1/3')).toBeInTheDocument();

			fireEvent.click(screen.getByTitle(/Next match/i));
			await waitFor(() => expect(screen.getByText('2/3')).toBeInTheDocument());
			await waitFor(() => expect(textarea.selectionStart).toBe(content.indexOf('Alpha', 1)));

			fireEvent.click(screen.getByTitle(/Previous match/i));
			await waitFor(() => expect(screen.getByText('1/3')).toBeInTheDocument());
			await waitFor(() => expect(textarea.selectionStart).toBe(0));

			fireEvent.click(screen.getByTitle(/Close search/i));
			expect(screen.queryByPlaceholderText(/search/i)).not.toBeInTheDocument();
			expect(document.activeElement).toBe(textarea);
		});

		it('handles undo, redo, checkbox insertion, and list continuation shortcuts', async () => {
			const props = createDefaultProps({ content: 'Middle' });
			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
			textarea.setSelectionRange(3, 3);
			fireEvent.keyDown(textarea, { key: 'l', metaKey: true });
			expect(textarea).toHaveValue('Mid\n- [ ] dle');
			await act(async () => {
				vi.advanceTimersByTime(0);
				await Promise.resolve();
			});
			expect(textarea.selectionStart).toBe(10);

			fireEvent.change(textarea, { target: { value: '- bullet' } });
			textarea.setSelectionRange(textarea.value.length, textarea.value.length);
			fireEvent.keyDown(textarea, { key: 'Enter' });
			expect(textarea).toHaveValue('- bullet\n- ');
			await act(async () => {
				vi.advanceTimersByTime(0);
				await Promise.resolve();
			});

			fireEvent.change(textarea, { target: { value: '1. first' } });
			textarea.setSelectionRange(textarea.value.length, textarea.value.length);
			fireEvent.keyDown(textarea, { key: 'Enter' });
			expect(textarea).toHaveValue('1. first\n2. ');

			fireEvent.keyDown(textarea, { key: 'z', metaKey: true });
			await waitFor(() => expect(textarea).toHaveValue('1. first'));
			fireEvent.keyDown(textarea, { key: 'z', metaKey: true, shiftKey: true });
			await waitFor(() => expect(textarea).toHaveValue('1. first\n2. '));
		});

		it('syncs externally managed draft content and save state', async () => {
			const onExternalLocalContentChange = vi.fn();
			const onExternalSavedContentChange = vi.fn();
			const props = createDefaultProps({
				content: 'Initial',
				externalLocalContent: 'Draft A',
				externalSavedContent: 'Initial',
				onExternalLocalContentChange,
				onExternalSavedContentChange,
			});
			const { rerender } = renderWithProvider(<AutoRun {...props} />);

			expect(screen.getByRole('textbox')).toHaveValue('Draft A');

			rerender(
				<AutoRun {...props} externalLocalContent="Draft B" externalSavedContent="Draft B" />
			);
			await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Draft B'));

			fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Draft C' } });
			expect(onExternalLocalContentChange).toHaveBeenCalledWith('Draft C');

			fireEvent.keyDown(screen.getByRole('textbox'), { key: 's', metaKey: true });
			await waitFor(() => {
				expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledWith(
					'/test/folder',
					'Phase 1.md',
					'Draft C',
					undefined
				);
			});
			expect(onExternalSavedContentChange).toHaveBeenCalledWith('Draft C');
		});

		it('routes preview markdown file links, external links, and mermaid blocks', async () => {
			const onSelectDocument = vi.fn();
			const props = createDefaultProps({
				mode: 'preview',
				onSelectDocument,
				documentTree: [
					{
						name: 'Nested',
						type: 'folder',
						path: 'Nested',
						children: [{ name: 'Note.md', type: 'file', path: 'Nested/Note.md' }],
					},
				],
				content: [
					'```mermaid',
					'graph TD; A-->B;',
					'```',
					'[Internal](Nested/Note.md)',
					'[External](https://example.com/docs)',
					'![Searchable](https://example.com/searchable.png)',
				].join('\n'),
			});
			const { container } = renderWithProvider(<AutoRun {...props} />);

			expect(screen.getByTestId('mermaid-renderer')).toHaveTextContent('graph TD; A-->B;');
			fireEvent.click(screen.getByText('Internal'));
			expect(onSelectDocument).toHaveBeenCalledWith('Nested/Note');
			fireEvent.click(screen.getByText('External'));
			expect(mockMaestro.shell.openExternal).toHaveBeenCalledWith('https://example.com/docs');

			const preview = container.querySelector('.prose') as HTMLDivElement;
			fireEvent.keyDown(preview, { key: 'f', metaKey: true });
			fireEvent.change(screen.getByPlaceholderText(/search/i), {
				target: { value: 'Searchable' },
			});
			await act(async () => {
				vi.advanceTimersByTime(200);
				await Promise.resolve();
			});
			expect(screen.getByText('1/2')).toBeInTheDocument();
			expect(screen.getByAltText('Searchable')).toHaveAttribute(
				'src',
				'https://example.com/searchable.png'
			);
		});

		it('refreshes the empty-folder state and clears the refresh animation timer', async () => {
			const onRefresh = vi.fn().mockResolvedValue(undefined);
			const props = createDefaultProps({
				documentList: [],
				selectedFile: null,
				content: '',
				onRefresh,
			});

			renderWithProvider(<AutoRun {...props} />);

			expect(screen.getByText('No Documents Found')).toBeInTheDocument();
			const refreshButtons = screen.getAllByRole('button', { name: /refresh/i });
			fireEvent.click(refreshButtons[refreshButtons.length - 1]);

			await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
			await act(async () => {
				vi.advanceTimersByTime(500);
				await Promise.resolve();
			});
		});

		it('persists preview scroll state and handles preview-mode shortcuts', async () => {
			const onStateChange = vi.fn();
			const onModeChange = vi.fn();
			const props = createDefaultProps({
				mode: 'preview',
				content: 'Preview body',
				onStateChange,
				onModeChange,
			});
			const { container } = renderWithProvider(<AutoRun {...props} />);

			const preview = container.querySelector('.prose') as HTMLDivElement;
			preview.scrollTop = 42;
			fireEvent.scroll(preview);
			await act(async () => {
				vi.advanceTimersByTime(500);
				await Promise.resolve();
			});

			expect(onStateChange).toHaveBeenCalledWith(
				expect.objectContaining({ mode: 'preview', previewScrollPos: 42 })
			);

			fireEvent.keyDown(preview, { key: 'f', metaKey: true });
			expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument();

			fireEvent.keyDown(preview, { key: 'e', metaKey: true });
			expect(onModeChange).toHaveBeenCalledWith('edit');
		});

		it('wires optional toolbar controls, bionify toggle, and help modal lifecycle', async () => {
			const onExpand = vi.fn();
			const onOpenMarketplace = vi.fn();
			const onLaunchWizard = vi.fn();
			const props = createDefaultProps({
				onExpand,
				onOpenMarketplace,
				onLaunchWizard,
				shortcuts: {
					toggleAutoRunExpanded: {
						id: 'toggleAutoRunExpanded',
						name: 'Toggle Auto Run Expanded',
						keys: ['Meta', 'Shift', 'E'],
						description: 'Toggle Auto Run Expanded',
						category: 'Auto Run',
					},
				},
			});

			renderWithProvider(<AutoRun {...props} />);

			fireEvent.click(screen.getByTitle(/Expand to full screen/i));
			fireEvent.click(screen.getByTitle(/Browse PlayBooks/i));
			fireEvent.click(screen.getByTitle('Launch In-Tab Wizard'));
			fireEvent.click(screen.getByTestId('bionify-toggle'));
			fireEvent.click(screen.getByTitle('Learn about Auto Runner'));

			expect(onExpand).toHaveBeenCalledTimes(1);
			expect(onOpenMarketplace).toHaveBeenCalledTimes(1);
			expect(onLaunchWizard).toHaveBeenCalledTimes(1);
			expect(screen.getByTestId('help-modal')).toBeInTheDocument();

			fireEvent.click(screen.getByText('Close'));
			expect(screen.queryByTestId('help-modal')).not.toBeInTheDocument();
		});
	});
});
