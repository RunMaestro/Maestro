import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { RightPanel, RightPanelHandle } from '../../../renderer/components/RightPanel';
import { createRef } from 'react';
import type { Session, Theme, Shortcut, BatchRunState } from '../../../renderer/types';

// Mock child components
vi.mock('../../../renderer/components/FileExplorerPanel', () => ({
	FileExplorerPanel: vi.fn(({ session }) => (
		<div data-testid="file-explorer-panel">FileExplorerPanel: {session?.name}</div>
	)),
}));

vi.mock('../../../renderer/components/HistoryPanel', () => ({
	HistoryPanel: vi.fn((props) => <div data-testid="history-panel">HistoryPanel</div>),
}));

vi.mock('../../../renderer/components/AutoRun', () => ({
	AutoRun: vi.fn((props) => <div data-testid="auto-run">AutoRun</div>),
}));

vi.mock('../../../renderer/utils/shortcutFormatter', () => ({
	formatShortcutKeys: vi.fn((keys) => keys.join('+')),
}));

// Mock lucide-react
vi.mock('lucide-react', () => ({
	PanelRightClose: () => <span data-testid="panel-right-close">Close</span>,
	PanelRightOpen: () => <span data-testid="panel-right-open">Open</span>,
	Loader2: ({ className }: { className?: string }) => (
		<span data-testid="loader" className={className}>
			Loading
		</span>
	),
}));

describe('RightPanel', () => {
	const mockTheme: Theme = {
		id: 'dracula',
		name: 'Dracula',
		mode: 'dark',
		colors: {
			bgMain: '#282a36',
			bgSidebar: '#21222c',
			bgActivity: '#1e1f29',
			border: '#44475a',
			textMain: '#f8f8f2',
			textDim: '#6272a4',
			accent: '#bd93f9',
			accentDim: 'rgba(189, 147, 249, 0.2)',
			accentText: '#bd93f9',
			accentForeground: '#f8f8f2',
			success: '#50fa7b',
			warning: '#f1fa8c',
			error: '#ff5555',
		},
	};

	const mockSession: Session = {
		id: 'session-1',
		name: 'Test Session',
		cwd: '/test/path',
		projectRoot: '/test/path',
		toolType: 'claude-code',
		state: 'idle',
		inputMode: 'ai',
		isGitRepo: true,
		aiPid: 1234,
		terminalPid: 5678,
		aiLogs: [],
		shellLogs: [],
		fileTree: [],
		fileExplorerExpanded: [],
		messageQueue: [],
		autoRunFolderPath: '/test/autorun',
		autoRunSelectedFile: 'test.md',
		autoRunMode: 'edit',
		autoRunCursorPosition: 0,
		autoRunEditScrollPos: 0,
		autoRunPreviewScrollPos: 0,
	};

	const mockShortcuts: Record<string, Shortcut> = {
		toggleRightPanel: {
			id: 'toggleRightPanel',
			name: 'Toggle Right Panel',
			keys: ['Cmd', 'B'],
			description: 'Toggle the right panel',
			category: 'Navigation',
		},
	};

	const createDefaultProps = (overrides: Partial<ReturnType<typeof createDefaultProps>> = {}) => ({
		session: mockSession,
		theme: mockTheme,
		shortcuts: mockShortcuts,
		rightPanelOpen: true,
		setRightPanelOpen: vi.fn(),
		rightPanelWidth: 400,
		setRightPanelWidthState: vi.fn(),
		activeRightTab: 'files' as const,
		setActiveRightTab: vi.fn(),
		activeFocus: 'right',
		setActiveFocus: vi.fn(),
		fileTreeFilter: '',
		setFileTreeFilter: vi.fn(),
		fileTreeFilterOpen: false,
		setFileTreeFilterOpen: vi.fn(),
		filteredFileTree: [],
		selectedFileIndex: 0,
		setSelectedFileIndex: vi.fn(),
		previewFile: null,
		fileTreeContainerRef: { current: null } as React.RefObject<HTMLDivElement>,
		fileTreeFilterInputRef: { current: null } as React.RefObject<HTMLInputElement>,
		toggleFolder: vi.fn(),
		handleFileClick: vi.fn(),
		expandAllFolders: vi.fn(),
		collapseAllFolders: vi.fn(),
		updateSessionWorkingDirectory: vi.fn(),
		refreshFileTree: vi.fn(),
		setSessions: vi.fn(),
		onAutoRefreshChange: vi.fn(),
		onShowFlash: vi.fn(),
		autoRunDocumentList: ['doc1', 'doc2'],
		autoRunDocumentTree: [],
		autoRunContent: '',
		autoRunIsLoadingDocuments: false,
		onAutoRunContentChange: vi.fn(),
		onAutoRunModeChange: vi.fn(),
		onAutoRunStateChange: vi.fn(),
		onAutoRunSelectDocument: vi.fn(),
		onAutoRunCreateDocument: vi.fn(),
		onAutoRunRefresh: vi.fn(),
		onAutoRunOpenSetup: vi.fn(),
		batchRunState: undefined,
		currentSessionBatchState: undefined, // For session-specific progress display
		onOpenBatchRunner: vi.fn(),
		onStopBatchRun: vi.fn(),
		onJumpToAgentSession: vi.fn(),
		onResumeSession: vi.fn(),
		onOpenSessionAsTab: vi.fn(),
		...overrides,
	});

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		// Mock requestAnimationFrame
		vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
			cb(0);
			return 0;
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	describe('Render conditions', () => {
		it('should return null when session is null', () => {
			const props = createDefaultProps({ session: null });
			const { container } = render(<RightPanel {...props} />);
			expect(container.firstChild).toBeNull();
		});

		it('should render when session is provided', () => {
			const props = createDefaultProps();
			render(<RightPanel {...props} />);
			// The toggle button renders with the icon text as its accessible name
			expect(screen.getByTitle(/collapse right panel/i)).toBeInTheDocument();
		});

		it('should hide content when panel is closed', () => {
			const props = createDefaultProps({ rightPanelOpen: false });
			const { container } = render(<RightPanel {...props} />);
			const panel = container.firstChild as HTMLElement;
			expect(panel.style.width).toBe('0px');
			expect(panel.classList.contains('w-0')).toBe(true);
		});

		it('should show content when panel is open', () => {
			const props = createDefaultProps({ rightPanelOpen: true });
			const { container } = render(<RightPanel {...props} />);
			const panel = container.firstChild as HTMLElement;
			expect(panel.style.width).toBe('400px');
		});
	});

	describe('Panel toggle', () => {
		it('should show PanelRightClose icon when open', () => {
			const props = createDefaultProps({ rightPanelOpen: true });
			render(<RightPanel {...props} />);
			expect(screen.getByTestId('panel-right-close')).toBeInTheDocument();
		});

		it('should show PanelRightOpen icon when closed', () => {
			const props = createDefaultProps({ rightPanelOpen: false });
			render(<RightPanel {...props} />);
			expect(screen.getByTestId('panel-right-open')).toBeInTheDocument();
		});

		it('should call setRightPanelOpen when toggle button clicked', () => {
			const setRightPanelOpen = vi.fn();
			const props = createDefaultProps({ setRightPanelOpen, rightPanelOpen: true });
			render(<RightPanel {...props} />);

			const toggleButton = screen.getByTitle(/collapse right panel/i);
			fireEvent.click(toggleButton);

			expect(setRightPanelOpen).toHaveBeenCalledWith(false);
		});

		it('should have correct tooltip with keyboard shortcut', () => {
			const props = createDefaultProps({ rightPanelOpen: true });
			render(<RightPanel {...props} />);

			const toggleButton = screen.getByTitle(/collapse right panel/i);
			expect(toggleButton.title).toContain('Cmd+B');
		});
	});

	describe('Tab navigation', () => {
		it('should render all three tabs', () => {
			const props = createDefaultProps();
			render(<RightPanel {...props} />);

			expect(screen.getByRole('button', { name: 'Files' })).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'History' })).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Auto Run' })).toBeInTheDocument();
		});

		it('should highlight active tab with accent color', () => {
			const props = createDefaultProps({ activeRightTab: 'files' });
			render(<RightPanel {...props} />);

			const filesTab = screen.getByRole('button', { name: 'Files' });
			// Browser normalizes hex to rgb
			expect(filesTab.style.borderColor).toBe('rgb(189, 147, 249)');
		});

		it('should show transparent border for inactive tabs', () => {
			const props = createDefaultProps({ activeRightTab: 'files' });
			render(<RightPanel {...props} />);

			const historyTab = screen.getByRole('button', { name: 'History' });
			expect(historyTab.style.borderColor).toBe('transparent');
		});

		it('should call setActiveRightTab when tab is clicked', () => {
			const setActiveRightTab = vi.fn();
			const props = createDefaultProps({ setActiveRightTab });
			render(<RightPanel {...props} />);

			fireEvent.click(screen.getByRole('button', { name: 'History' }));
			expect(setActiveRightTab).toHaveBeenCalledWith('history');

			fireEvent.click(screen.getByRole('button', { name: 'Auto Run' }));
			expect(setActiveRightTab).toHaveBeenCalledWith('autorun');

			fireEvent.click(screen.getByRole('button', { name: 'Files' }));
			expect(setActiveRightTab).toHaveBeenCalledWith('files');
		});
	});

	describe('Tab content', () => {
		it('should show FileExplorerPanel when files tab is active', () => {
			const props = createDefaultProps({ activeRightTab: 'files' });
			render(<RightPanel {...props} />);

			expect(screen.getByTestId('file-explorer-panel')).toBeInTheDocument();
			expect(screen.queryByTestId('history-panel')).not.toBeInTheDocument();
			expect(screen.queryByTestId('auto-run')).not.toBeInTheDocument();
		});

		it('should show HistoryPanel when history tab is active', () => {
			const props = createDefaultProps({ activeRightTab: 'history' });
			render(<RightPanel {...props} />);

			expect(screen.queryByTestId('file-explorer-panel')).not.toBeInTheDocument();
			expect(screen.getByTestId('history-panel')).toBeInTheDocument();
			expect(screen.queryByTestId('auto-run')).not.toBeInTheDocument();
		});

		it('should show AutoRun when autorun tab is active', () => {
			const props = createDefaultProps({ activeRightTab: 'autorun' });
			render(<RightPanel {...props} />);

			expect(screen.queryByTestId('file-explorer-panel')).not.toBeInTheDocument();
			expect(screen.queryByTestId('history-panel')).not.toBeInTheDocument();
			expect(screen.getByTestId('auto-run')).toBeInTheDocument();
		});
	});

	describe('Focus management', () => {
		it('should call setActiveFocus when panel is clicked', () => {
			const setActiveFocus = vi.fn();
			const props = createDefaultProps({ setActiveFocus });
			const { container } = render(<RightPanel {...props} />);

			fireEvent.click(container.firstChild as Element);
			expect(setActiveFocus).toHaveBeenCalledWith('right');
		});

		it('should call setActiveFocus when panel is focused', () => {
			const setActiveFocus = vi.fn();
			const props = createDefaultProps({ setActiveFocus });
			const { container } = render(<RightPanel {...props} />);

			fireEvent.focus(container.firstChild as Element);
			expect(setActiveFocus).toHaveBeenCalledWith('right');
		});

		it('should show focus ring when activeFocus is right', () => {
			const props = createDefaultProps({ activeFocus: 'right' });
			const { container } = render(<RightPanel {...props} />);

			const panel = container.firstChild as HTMLElement;
			expect(panel.classList.contains('ring-1')).toBe(true);
			expect(panel.classList.contains('ring-inset')).toBe(true);
		});

		it('should not show focus ring when activeFocus is not right', () => {
			const props = createDefaultProps({ activeFocus: 'main' });
			const { container } = render(<RightPanel {...props} />);

			const panel = container.firstChild as HTMLElement;
			expect(panel.classList.contains('ring-1')).toBe(false);
		});
	});

	describe('Resize handle', () => {
		it('should render resize handle when panel is open', () => {
			const props = createDefaultProps({ rightPanelOpen: true });
			const { container } = render(<RightPanel {...props} />);

			const resizeHandle = container.querySelector('.cursor-col-resize');
			expect(resizeHandle).toBeInTheDocument();
		});

		it('should not render resize handle when panel is closed', () => {
			const props = createDefaultProps({ rightPanelOpen: false });
			const { container } = render(<RightPanel {...props} />);

			const resizeHandle = container.querySelector('.cursor-col-resize');
			expect(resizeHandle).not.toBeInTheDocument();
		});

		it('should handle mouse down on resize handle', () => {
			const setRightPanelWidthState = vi.fn();
			const props = createDefaultProps({ setRightPanelWidthState, rightPanelWidth: 400 });
			const { container } = render(<RightPanel {...props} />);

			const resizeHandle = container.querySelector('.cursor-col-resize') as HTMLElement;

			// Start resize
			fireEvent.mouseDown(resizeHandle, { clientX: 500 });

			// Simulate mouse move (direct DOM update for performance, no state call yet)
			fireEvent.mouseMove(document, { clientX: 450 }); // 50px to the left (makes panel wider since reversed)

			// State is only updated on mouseUp for performance (avoids ~60 re-renders/sec)
			expect(setRightPanelWidthState).not.toHaveBeenCalled();

			// End resize - state is updated
			fireEvent.mouseUp(document);
			expect(setRightPanelWidthState).toHaveBeenCalled();
		});

		it('should respect min/max width constraints during resize', () => {
			const setRightPanelWidthState = vi.fn();
			const props = createDefaultProps({ setRightPanelWidthState, rightPanelWidth: 400 });
			const { container } = render(<RightPanel {...props} />);

			const resizeHandle = container.querySelector('.cursor-col-resize') as HTMLElement;

			// Start resize
			fireEvent.mouseDown(resizeHandle, { clientX: 500 });

			// Try to make it very wide (delta = 500 - (-500) = 1000)
			fireEvent.mouseMove(document, { clientX: -500 });

			// End resize - state is updated on mouseUp
			fireEvent.mouseUp(document);

			// Should be clamped to max 800
			const calls = setRightPanelWidthState.mock.calls;
			const lastCall = calls[calls.length - 1][0];
			expect(lastCall).toBeLessThanOrEqual(800);
		});

		it('should save width on mouse up', () => {
			const setRightPanelWidthState = vi.fn();
			const props = createDefaultProps({ setRightPanelWidthState, rightPanelWidth: 400 });
			const { container } = render(<RightPanel {...props} />);

			const resizeHandle = container.querySelector('.cursor-col-resize') as HTMLElement;

			// Start resize
			fireEvent.mouseDown(resizeHandle, { clientX: 500 });

			// Move
			fireEvent.mouseMove(document, { clientX: 450 });

			// End resize
			fireEvent.mouseUp(document);

			expect(window.maestro.settings.set).toHaveBeenCalledWith(
				'rightPanelWidth',
				expect.any(Number)
			);
		});
	});

	describe('Scroll position tracking', () => {
		it('should update session scroll position on scroll for files tab', () => {
			const setSessions = vi.fn();
			const props = createDefaultProps({ activeRightTab: 'files', setSessions });
			const { container } = render(<RightPanel {...props} />);

			const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;

			// Mock scrollTop
			Object.defineProperty(scrollContainer, 'scrollTop', { value: 150, writable: true });

			fireEvent.scroll(scrollContainer);

			expect(setSessions).toHaveBeenCalled();
		});

		it('should not update scroll position for non-files tabs', () => {
			const setSessions = vi.fn();
			const props = createDefaultProps({ activeRightTab: 'history', setSessions });
			const { container } = render(<RightPanel {...props} />);

			const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;
			Object.defineProperty(scrollContainer, 'scrollTop', { value: 150, writable: true });

			fireEvent.scroll(scrollContainer);

			// setSessions may be called for other reasons, but not for scroll tracking
			// The implementation checks activeRightTab === 'files'
			const calls = setSessions.mock.calls;
			// Should not be called for scroll tracking
			expect(calls.length).toBe(0);
		});
	});

	describe('Batch run progress', () => {
		it('should not show progress when currentSessionBatchState is undefined', () => {
			const props = createDefaultProps({ currentSessionBatchState: undefined });
			render(<RightPanel {...props} />);

			expect(screen.queryByText('Auto Run Active')).not.toBeInTheDocument();
		});

		it('should not show progress when batch run is not running', () => {
			const currentSessionBatchState: BatchRunState = {
				isRunning: false,
				isStopping: false,
				documents: ['doc1'],
				currentDocumentIndex: 0,
				totalTasks: 10,
				completedTasks: 5,
				currentDocTasksTotal: 10,
				currentDocTasksCompleted: 5,
				totalTasksAcrossAllDocs: 10,
				completedTasksAcrossAllDocs: 5,
				loopEnabled: false,
				loopIteration: 0,
			};
			const props = createDefaultProps({ currentSessionBatchState });
			render(<RightPanel {...props} />);

			expect(screen.queryByText('Auto Run Active')).not.toBeInTheDocument();
		});

		it('should show progress when batch run is running', () => {
			const currentSessionBatchState: BatchRunState = {
				isRunning: true,
				isStopping: false,
				documents: ['doc1'],
				currentDocumentIndex: 0,
				totalTasks: 10,
				completedTasks: 5,
				currentDocTasksTotal: 10,
				currentDocTasksCompleted: 5,
				totalTasksAcrossAllDocs: 10,
				completedTasksAcrossAllDocs: 5,
				loopEnabled: false,
				loopIteration: 0,
			};
			const props = createDefaultProps({ currentSessionBatchState });
			render(<RightPanel {...props} />);

			expect(screen.getByText('Auto Run Active')).toBeInTheDocument();
		});

		it('should show "Stopping..." when isStopping is true', () => {
			const currentSessionBatchState: BatchRunState = {
				isRunning: true,
				isStopping: true,
				documents: ['doc1'],
				currentDocumentIndex: 0,
				totalTasks: 10,
				completedTasks: 5,
				currentDocTasksTotal: 10,
				currentDocTasksCompleted: 5,
				totalTasksAcrossAllDocs: 10,
				completedTasksAcrossAllDocs: 5,
				loopEnabled: false,
				loopIteration: 0,
			};
			const props = createDefaultProps({ currentSessionBatchState });
			render(<RightPanel {...props} />);

			expect(screen.getByText('Stopping...')).toBeInTheDocument();
			expect(screen.getByText(/waiting for current task/i)).toBeInTheDocument();
		});

		it('should show loop iteration indicator when loopEnabled', () => {
			const currentSessionBatchState: BatchRunState = {
				isRunning: true,
				isStopping: false,
				documents: ['doc1'],
				currentDocumentIndex: 0,
				totalTasks: 10,
				completedTasks: 5,
				currentDocTasksTotal: 10,
				currentDocTasksCompleted: 5,
				totalTasksAcrossAllDocs: 10,
				completedTasksAcrossAllDocs: 5,
				loopEnabled: true,
				loopIteration: 2,
				maxLoops: 5,
			};
			const props = createDefaultProps({ currentSessionBatchState });
			render(<RightPanel {...props} />);

			// There are two indicators with the same text - one in the header and one at the bottom
			// Text is split across multiple elements, so use a function matcher
			expect(
				screen.getByText((content, element) => {
					return element?.textContent === 'Loop 3 of 5';
				})
			).toBeInTheDocument();
		});

		it('should show infinity symbol when maxLoops is undefined', () => {
			const currentSessionBatchState: BatchRunState = {
				isRunning: true,
				isStopping: false,
				documents: ['doc1'],
				currentDocumentIndex: 0,
				totalTasks: 10,
				completedTasks: 5,
				currentDocTasksTotal: 10,
				currentDocTasksCompleted: 5,
				totalTasksAcrossAllDocs: 10,
				completedTasksAcrossAllDocs: 5,
				loopEnabled: true,
				loopIteration: 2,
				maxLoops: undefined,
			};
			const props = createDefaultProps({ currentSessionBatchState });
			render(<RightPanel {...props} />);

			expect(screen.getByText('Loop 3 of ∞')).toBeInTheDocument();
		});

		it('should show document progress for multi-document runs', () => {
			const currentSessionBatchState: BatchRunState = {
				isRunning: true,
				isStopping: false,
				documents: ['doc1', 'doc2', 'doc3'],
				currentDocumentIndex: 1,
				totalTasks: 10,
				completedTasks: 5,
				currentDocTasksTotal: 10,
				currentDocTasksCompleted: 5,
				totalTasksAcrossAllDocs: 30,
				completedTasksAcrossAllDocs: 15,
				loopEnabled: false,
				loopIteration: 0,
			};
			const props = createDefaultProps({ currentSessionBatchState });
			render(<RightPanel {...props} />);

			// Document name shown without .md extension (full path with .md is in tooltip)
			expect(screen.getByText(/Document 2\/3: doc2/)).toBeInTheDocument();
		});

		it('should not show document progress bar for single-document runs but should show document name', () => {
			const currentSessionBatchState: BatchRunState = {
				isRunning: true,
				isStopping: false,
				documents: ['doc1'],
				currentDocumentIndex: 0,
				totalTasks: 10,
				completedTasks: 5,
				currentDocTasksTotal: 10,
				currentDocTasksCompleted: 5,
				totalTasksAcrossAllDocs: 10,
				completedTasksAcrossAllDocs: 5,
				loopEnabled: false,
				loopIteration: 0,
			};
			const props = createDefaultProps({ currentSessionBatchState });
			render(<RightPanel {...props} />);

			// Should not show "Document 1/1" format (multi-doc progress)
			expect(screen.queryByText(/Document 1\/1/)).not.toBeInTheDocument();
			// But should show the document name
			expect(screen.getByText('doc1.md')).toBeInTheDocument();
		});

		it('should show total tasks completed', () => {
			const currentSessionBatchState: BatchRunState = {
				isRunning: true,
				isStopping: false,
				documents: ['doc1', 'doc2'],
				currentDocumentIndex: 0,
				totalTasks: 10,
				completedTasks: 5,
				currentDocTasksTotal: 10,
				currentDocTasksCompleted: 5,
				totalTasksAcrossAllDocs: 20,
				completedTasksAcrossAllDocs: 7,
				loopEnabled: false,
				loopIteration: 0,
			};
			const props = createDefaultProps({ currentSessionBatchState });
			render(<RightPanel {...props} />);

			expect(screen.getByText('7 of 20 tasks completed')).toBeInTheDocument();
		});

		it('should show single document task count when totalTasksAcrossAllDocs is 0', () => {
			const currentSessionBatchState: BatchRunState = {
				isRunning: true,
				isStopping: false,
				documents: ['doc1'],
				currentDocumentIndex: 0,
				totalTasks: 10,
				completedTasks: 5,
				currentDocTasksTotal: 10,
				currentDocTasksCompleted: 5,
				totalTasksAcrossAllDocs: 0,
				completedTasksAcrossAllDocs: 0,
				loopEnabled: false,
				loopIteration: 0,
			};
			const props = createDefaultProps({ currentSessionBatchState });
			render(<RightPanel {...props} />);

			expect(screen.getByText('5 of 10 tasks completed')).toBeInTheDocument();
		});

		it('should show loading spinner during batch run', () => {
			const currentSessionBatchState: BatchRunState = {
				isRunning: true,
				isStopping: false,
				documents: ['doc1'],
				currentDocumentIndex: 0,
				totalTasks: 10,
				completedTasks: 5,
				currentDocTasksTotal: 10,
				currentDocTasksCompleted: 5,
				totalTasksAcrossAllDocs: 10,
				completedTasksAcrossAllDocs: 5,
				loopEnabled: false,
				loopIteration: 0,
			};
			const props = createDefaultProps({ currentSessionBatchState });
			render(<RightPanel {...props} />);

			expect(screen.getByTestId('loader')).toBeInTheDocument();
		});
	});

	describe('Imperative handle', () => {
		it('should expose refreshHistoryPanel method', () => {
			const ref = createRef<RightPanelHandle>();
			const props = createDefaultProps();
			render(<RightPanel {...props} ref={ref} />);

			expect(ref.current).not.toBeNull();
			expect(typeof ref.current?.refreshHistoryPanel).toBe('function');
		});

		it('should expose focusAutoRun method', () => {
			const ref = createRef<RightPanelHandle>();
			const props = createDefaultProps();
			render(<RightPanel {...props} ref={ref} />);

			expect(ref.current).not.toBeNull();
			expect(typeof ref.current?.focusAutoRun).toBe('function');
		});

		it('should call refreshHistoryPanel without throwing', () => {
			const ref = createRef<RightPanelHandle>();
			const props = createDefaultProps();
			render(<RightPanel {...props} ref={ref} />);

			expect(() => ref.current?.refreshHistoryPanel()).not.toThrow();
		});

		it('should call focusAutoRun without throwing', () => {
			const ref = createRef<RightPanelHandle>();
			const props = createDefaultProps();
			render(<RightPanel {...props} ref={ref} />);

			expect(() => ref.current?.focusAutoRun()).not.toThrow();
		});
	});

	describe('Focus effects', () => {
		it('should not focus history panel when tab is not history', () => {
			const props = createDefaultProps({
				activeRightTab: 'files',
				rightPanelOpen: true,
				activeFocus: 'right',
			});
			render(<RightPanel {...props} />);

			// requestAnimationFrame should not trigger focus for non-history tab
			// The history panel ref focus method shouldn't be called
			// This is implicit - if files tab is active, history panel isn't rendered
			expect(screen.queryByTestId('history-panel')).not.toBeInTheDocument();
		});

		it('should not focus autorun panel when tab is not autorun', () => {
			const props = createDefaultProps({
				activeRightTab: 'files',
				rightPanelOpen: true,
				activeFocus: 'right',
			});
			render(<RightPanel {...props} />);

			expect(screen.queryByTestId('auto-run')).not.toBeInTheDocument();
		});
	});

	describe('Content container click behavior', () => {
		it('should set active focus when content area is clicked', () => {
			const setActiveFocus = vi.fn();
			const props = createDefaultProps({ setActiveFocus });
			const { container } = render(<RightPanel {...props} />);

			const contentArea = container.querySelector('.overflow-y-auto') as HTMLElement;
			fireEvent.click(contentArea);

			expect(setActiveFocus).toHaveBeenCalledWith('right');
		});

		it('should have content container with tabIndex -1 for programmatic focus', () => {
			const props = createDefaultProps({ activeRightTab: 'files' });
			const { container } = render(<RightPanel {...props} />);

			const contentArea = container.querySelector('.overflow-y-auto') as HTMLElement;
			expect(contentArea.tabIndex).toBe(-1);
		});

		it('should render files content when files tab is active', () => {
			const props = createDefaultProps({ activeRightTab: 'files' });
			render(<RightPanel {...props} />);

			expect(screen.getByTestId('file-explorer-panel')).toBeInTheDocument();
		});

		it('should render autorun content when autorun tab is active', () => {
			const props = createDefaultProps({ activeRightTab: 'autorun' });
			render(<RightPanel {...props} />);

			expect(screen.getByTestId('auto-run')).toBeInTheDocument();
		});
	});

	describe('Styling', () => {
		it('should apply theme background color to panel', () => {
			const props = createDefaultProps();
			const { container } = render(<RightPanel {...props} />);

			const panel = container.firstChild as HTMLElement;
			// Browser normalizes hex to rgb
			expect(panel.style.backgroundColor).toBe('rgb(33, 34, 44)');
		});

		it('should apply theme border color', () => {
			const props = createDefaultProps();
			const { container } = render(<RightPanel {...props} />);

			const panel = container.firstChild as HTMLElement;
			// Browser normalizes hex to rgb
			expect(panel.style.borderColor).toBe('rgb(68, 71, 90)');
		});

		it('should apply theme accent color to focus ring', () => {
			const props = createDefaultProps({ activeFocus: 'right' });
			const { container } = render(<RightPanel {...props} />);

			const panel = container.firstChild as HTMLElement;
			// --tw-ring-color is a CSS custom property for Tailwind ring utility
			expect(panel.style.getPropertyValue('--tw-ring-color')).toBe('#bd93f9');
		});

		it('should apply correct width based on rightPanelWidth', () => {
			const props = createDefaultProps({ rightPanelWidth: 500 });
			const { container } = render(<RightPanel {...props} />);

			const panel = container.firstChild as HTMLElement;
			expect(panel.style.width).toBe('500px');
		});
	});

	describe('Edge cases', () => {
		it('should handle session with missing optional properties', () => {
			const sessionWithoutOptional: Session = {
				...mockSession,
				autoRunFolderPath: undefined,
				autoRunSelectedFile: undefined,
				autoRunMode: undefined,
				autoRunCursorPosition: undefined,
				autoRunEditScrollPos: undefined,
				autoRunPreviewScrollPos: undefined,
			};
			const props = createDefaultProps({
				session: sessionWithoutOptional,
				activeRightTab: 'autorun',
			});

			expect(() => render(<RightPanel {...props} />)).not.toThrow();
		});

		it('should handle empty autoRunDocumentList', () => {
			const props = createDefaultProps({ autoRunDocumentList: [], activeRightTab: 'autorun' });

			expect(() => render(<RightPanel {...props} />)).not.toThrow();
			expect(screen.getByTestId('auto-run')).toBeInTheDocument();
		});

		it('should handle undefined autoRunDocumentTree', () => {
			const props = createDefaultProps({
				autoRunDocumentTree: undefined,
				activeRightTab: 'autorun',
			});

			expect(() => render(<RightPanel {...props} />)).not.toThrow();
		});

		it('should handle currentSessionBatchState with zero tasks', () => {
			const currentSessionBatchState: BatchRunState = {
				isRunning: true,
				isStopping: false,
				documents: ['doc1'],
				currentDocumentIndex: 0,
				totalTasks: 0,
				completedTasks: 0,
				currentDocTasksTotal: 0,
				currentDocTasksCompleted: 0,
				totalTasksAcrossAllDocs: 0,
				completedTasksAcrossAllDocs: 0,
				loopEnabled: false,
				loopIteration: 0,
			};
			const props = createDefaultProps({ currentSessionBatchState });

			expect(() => render(<RightPanel {...props} />)).not.toThrow();
		});

		it('should handle special characters in document names', () => {
			const currentSessionBatchState: BatchRunState = {
				isRunning: true,
				isStopping: false,
				documents: ['doc<script>', 'doc&name', 'doc"quote'],
				currentDocumentIndex: 0,
				totalTasks: 10,
				completedTasks: 5,
				currentDocTasksTotal: 10,
				currentDocTasksCompleted: 5,
				totalTasksAcrossAllDocs: 30,
				completedTasksAcrossAllDocs: 5,
				loopEnabled: false,
				loopIteration: 0,
			};
			const props = createDefaultProps({ currentSessionBatchState });

			expect(() => render(<RightPanel {...props} />)).not.toThrow();
		});

		it('should handle rapid tab switching', () => {
			const setActiveRightTab = vi.fn();
			const props = createDefaultProps({ setActiveRightTab });
			render(<RightPanel {...props} />);

			const historyTab = screen.getByRole('button', { name: 'History' });
			const filesTab = screen.getByRole('button', { name: 'Files' });
			const autoRunTab = screen.getByRole('button', { name: 'Auto Run' });

			// Rapid clicks
			for (let i = 0; i < 10; i++) {
				fireEvent.click(historyTab);
				fireEvent.click(filesTab);
				fireEvent.click(autoRunTab);
			}

			expect(setActiveRightTab).toHaveBeenCalledTimes(30);
		});
	});

	describe('Progress bar calculations', () => {
		it('should calculate correct progress percentage', () => {
			const currentSessionBatchState: BatchRunState = {
				isRunning: true,
				isStopping: false,
				documents: ['doc1'],
				currentDocumentIndex: 0,
				totalTasks: 10,
				completedTasks: 5,
				currentDocTasksTotal: 10,
				currentDocTasksCompleted: 5,
				totalTasksAcrossAllDocs: 20,
				completedTasksAcrossAllDocs: 10,
				loopEnabled: false,
				loopIteration: 0,
			};
			const props = createDefaultProps({ currentSessionBatchState });
			const { container } = render(<RightPanel {...props} />);

			// Find the progress bar
			const progressBars = container.querySelectorAll('.h-1\\.5, .h-1');
			expect(progressBars.length).toBeGreaterThan(0);
		});

		it('should use error color when stopping', () => {
			const currentSessionBatchState: BatchRunState = {
				isRunning: true,
				isStopping: true,
				documents: ['doc1'],
				currentDocumentIndex: 0,
				totalTasks: 10,
				completedTasks: 5,
				currentDocTasksTotal: 10,
				currentDocTasksCompleted: 5,
				totalTasksAcrossAllDocs: 10,
				completedTasksAcrossAllDocs: 5,
				loopEnabled: false,
				loopIteration: 0,
			};
			const props = createDefaultProps({ currentSessionBatchState });
			const { container } = render(<RightPanel {...props} />);

			// Find the progress bar inner div with error color (browser normalizes hex to rgb)
			const progressInner = container.querySelector('.h-1\\.5 > div') as HTMLElement;
			expect(progressInner?.style.backgroundColor).toBe('rgb(255, 85, 85)');
		});

		it('should use warning color when not stopping', () => {
			const currentSessionBatchState: BatchRunState = {
				isRunning: true,
				isStopping: false,
				documents: ['doc1'],
				currentDocumentIndex: 0,
				totalTasks: 10,
				completedTasks: 5,
				currentDocTasksTotal: 10,
				currentDocTasksCompleted: 5,
				totalTasksAcrossAllDocs: 10,
				completedTasksAcrossAllDocs: 5,
				loopEnabled: false,
				loopIteration: 0,
			};
			const props = createDefaultProps({ currentSessionBatchState });
			const { container } = render(<RightPanel {...props} />);

			// Find the progress bar inner div with warning color (browser normalizes hex to rgb)
			const progressInner = container.querySelector('.h-1\\.5 > div') as HTMLElement;
			expect(progressInner?.style.backgroundColor).toBe('rgb(241, 250, 140)');
		});
	});

	describe('Accessibility', () => {
		it('should have tabIndex on main panel', () => {
			const props = createDefaultProps();
			const { container } = render(<RightPanel {...props} />);

			const panel = container.firstChild as HTMLElement;
			expect(panel.tabIndex).toBe(0);
		});

		it('should have tabIndex on content container', () => {
			const props = createDefaultProps();
			const { container } = render(<RightPanel {...props} />);

			const contentContainer = container.querySelector('.overflow-y-auto') as HTMLElement;
			expect(contentContainer.tabIndex).toBe(-1);
		});

		it('should have proper button roles for tabs', () => {
			const props = createDefaultProps();
			render(<RightPanel {...props} />);

			expect(screen.getAllByRole('button')).toHaveLength(4); // toggle + 3 tabs
		});
	});

	describe('Elapsed time calculation', () => {
		// Note: Elapsed time display uses wall clock time (Date.now() - startTime)
		// and is updated via an interval while the batch run is active.

		it('should clear elapsed time when batch run is not running', async () => {
			const currentSessionBatchState: BatchRunState = {
				isRunning: false,
				isStopping: false,
				documents: ['doc1'],
				currentDocumentIndex: 0,
				totalTasks: 10,
				completedTasks: 5,
				currentDocTasksTotal: 10,
				currentDocTasksCompleted: 5,
				totalTasksAcrossAllDocs: 10,
				completedTasksAcrossAllDocs: 5,
				loopEnabled: false,
				loopIteration: 0,
				startTime: Date.now() - 5000,
				cumulativeTaskTimeMs: 5000,
			};
			const props = createDefaultProps({ currentSessionBatchState });
			render(<RightPanel {...props} />);

			// Elapsed time should not be displayed when not running
			expect(screen.queryByText(/\d+s/)).not.toBeInTheDocument();
		});

		it('should display elapsed seconds when batch run is running', async () => {
			// Set startTime to 5 seconds ago
			const currentSessionBatchState: BatchRunState = {
				isRunning: true,
				isStopping: false,
				documents: ['doc1'],
				currentDocumentIndex: 0,
				totalTasks: 10,
				completedTasks: 5,
				currentDocTasksTotal: 10,
				currentDocTasksCompleted: 5,
				totalTasksAcrossAllDocs: 10,
				completedTasksAcrossAllDocs: 5,
				loopEnabled: false,
				loopIteration: 0,
				startTime: Date.now() - 5000, // 5 seconds ago
				cumulativeTaskTimeMs: 5000,
			};
			const props = createDefaultProps({ currentSessionBatchState });
			render(<RightPanel {...props} />);

			// Should show "5s" based on wall clock time (startTime was 5 seconds ago)
			expect(screen.getByText('5s')).toBeInTheDocument();
		});

		it('should display elapsed minutes and seconds', async () => {
			// Set startTime to 2 minutes 5 seconds ago
			const currentSessionBatchState: BatchRunState = {
				isRunning: true,
				isStopping: false,
				documents: ['doc1'],
				currentDocumentIndex: 0,
				totalTasks: 10,
				completedTasks: 5,
				currentDocTasksTotal: 10,
				currentDocTasksCompleted: 5,
				totalTasksAcrossAllDocs: 10,
				completedTasksAcrossAllDocs: 5,
				loopEnabled: false,
				loopIteration: 0,
				startTime: Date.now() - 125000, // 2 minutes 5 seconds ago
				cumulativeTaskTimeMs: 125000,
			};
			const props = createDefaultProps({ currentSessionBatchState });
			render(<RightPanel {...props} />);

			// Should show format like "2m 5s"
			expect(screen.getByText('2m 5s')).toBeInTheDocument();
		});

		it('should display elapsed hours and minutes', async () => {
			// Set startTime to 1 hour 2 minutes 5 seconds ago
			const currentSessionBatchState: BatchRunState = {
				isRunning: true,
				isStopping: false,
				documents: ['doc1'],
				currentDocumentIndex: 0,
				totalTasks: 10,
				completedTasks: 5,
				currentDocTasksTotal: 10,
				currentDocTasksCompleted: 5,
				totalTasksAcrossAllDocs: 10,
				completedTasksAcrossAllDocs: 5,
				loopEnabled: false,
				loopIteration: 0,
				startTime: Date.now() - 3725000, // 1 hour, 2 minutes, 5 seconds ago
				cumulativeTaskTimeMs: 3725000,
			};
			const props = createDefaultProps({ currentSessionBatchState });
			render(<RightPanel {...props} />);

			// Should show format like "1h 2m"
			expect(screen.getByText('1h 2m')).toBeInTheDocument();
		});

		it('should update elapsed time when startTime changes', async () => {
			const now = Date.now();
			const currentSessionBatchState: BatchRunState = {
				isRunning: true,
				isStopping: false,
				documents: ['doc1'],
				currentDocumentIndex: 0,
				totalTasks: 10,
				completedTasks: 5,
				currentDocTasksTotal: 10,
				currentDocTasksCompleted: 5,
				totalTasksAcrossAllDocs: 10,
				completedTasksAcrossAllDocs: 5,
				loopEnabled: false,
				loopIteration: 0,
				startTime: now - 3000, // 3 seconds ago
				cumulativeTaskTimeMs: 3000,
			};
			const props = createDefaultProps({ currentSessionBatchState });
			const { rerender } = render(<RightPanel {...props} />);

			// Initial render shows 3s
			expect(screen.getByText('3s')).toBeInTheDocument();

			// Update startTime to 6 seconds ago (simulating a new batch run or elapsed time update)
			const updatedBatchState = { ...currentSessionBatchState, startTime: now - 6000 };
			rerender(
				<RightPanel {...createDefaultProps({ currentSessionBatchState: updatedBatchState })} />
			);

			// Should now show 6s
			expect(screen.getByText('6s')).toBeInTheDocument();
		});

		it('should show 0s elapsed time when batch run just started', async () => {
			const currentSessionBatchState: BatchRunState = {
				isRunning: true,
				isStopping: false,
				documents: ['doc1'],
				currentDocumentIndex: 0,
				totalTasks: 10,
				completedTasks: 0,
				currentDocTasksTotal: 10,
				currentDocTasksCompleted: 0,
				totalTasksAcrossAllDocs: 10,
				completedTasksAcrossAllDocs: 0,
				loopEnabled: false,
				loopIteration: 0,
				startTime: Date.now(), // Just started
				cumulativeTaskTimeMs: 0,
			};
			const props = createDefaultProps({ currentSessionBatchState });
			render(<RightPanel {...props} />);

			// Should show 0s when just started (elapsed time is displayed even at 0)
			expect(screen.getByText('0s')).toBeInTheDocument();
		});
	});

	describe('Scroll position tracking with callback execution', () => {
		it('should execute setSessions callback to update fileExplorerScrollPos', () => {
			const setSessions = vi.fn((callback) => {
				// Execute the callback with a mock sessions array
				if (typeof callback === 'function') {
					const mockSessions = [
						{ id: 'session-1', name: 'Test Session' },
						{ id: 'other-session', name: 'Other Session' },
					];
					const result = callback(mockSessions);
					// Verify the callback transforms sessions correctly
					expect(result[0].fileExplorerScrollPos).toBe(250);
					expect(result[1].fileExplorerScrollPos).toBeUndefined();
				}
			});
			const props = createDefaultProps({ activeRightTab: 'files', setSessions });
			const { container } = render(<RightPanel {...props} />);

			const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;
			Object.defineProperty(scrollContainer, 'scrollTop', { value: 250, writable: true });

			fireEvent.scroll(scrollContainer);

			expect(setSessions).toHaveBeenCalled();
		});
	});
});
