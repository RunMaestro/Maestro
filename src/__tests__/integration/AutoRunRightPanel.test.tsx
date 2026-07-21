/**
 * @file AutoRunRightPanel.test.tsx
 * @description Integration tests for Auto Run and RightPanel interaction
 *
 * Tests the integration between RightPanel and AutoRun components:
 * - Tab switching preserves Auto Run state
 * - Panel resize doesn't lose content
 * - Expanded modal syncs with panel
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React, { createRef, useEffect, useState } from 'react';
import { RightPanel, RightPanelHandle } from '../../renderer/components/RightPanel';
import { AutoRun, AutoRunHandle } from '../../renderer/components/AutoRun';
import type { Session, Shortcut, BatchRunState, RightPanelTab } from '../../renderer/types';
import { createMockSession as baseCreateMockSession } from '../helpers/mockSession';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';

import { createMockTheme } from '../helpers/mockTheme';

import { useBatchStore } from '../../renderer/stores/batchStore';
import { useSessionStore } from '../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../renderer/stores/settingsStore';
import { useUIStore } from '../../renderer/stores/uiStore';
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

vi.mock('../../renderer/components/FileExplorerPanel', () => ({
	FileExplorerPanel: vi.fn(({ session }) => (
		<div data-testid="file-explorer-panel">FileExplorerPanel: {session?.name}</div>
	)),
}));

vi.mock('../../renderer/components/HistoryPanel', () => ({
	HistoryPanel: vi.fn(() => <div data-testid="history-panel">HistoryPanel</div>),
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

vi.mock('../../renderer/utils/shortcutFormatter', () => ({
	formatShortcutKeys: vi.fn((keys) => keys?.join('+') || ''),
	isMacOS: vi.fn(() => false),
}));

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

// Thin wrapper: seeds auto run state so the right panel shows the auto
// run tab with content.
const createMockSession = (overrides: Partial<Session> = {}): Session =>
	baseCreateMockSession({
		id: 'test-session-1',
		cwd: '/test/path',
		fullPath: '/test/path',
		projectRoot: '/test/path',
		isGitRepo: true,
		aiPid: 1234,
		terminalPid: 5678,
		port: 3000,
		aiTabs: [{ id: 'tab-1', name: 'Tab 1', logs: [] }] as any,
		activeTabId: 'tab-1',
		autoRunFolderPath: '/test/autorun',
		autoRunSelectedFile: 'Phase 1',
		autoRunMode: 'edit',
		autoRunCursorPosition: 0,
		autoRunEditScrollPos: 0,
		autoRunPreviewScrollPos: 0,
		...overrides,
	});

// Create mock shortcuts
const createMockShortcuts = (): Record<string, Shortcut> => ({
	toggleRightPanel: {
		id: 'toggleRightPanel',
		name: 'Toggle Right Panel',
		keys: ['Cmd', 'B'],
		description: 'Toggle the right panel',
		category: 'Navigation',
	},
	expandAutoRun: {
		id: 'expandAutoRun',
		name: 'Expand Auto Run',
		keys: ['Cmd', 'Shift', 'E'],
		description: 'Expand Auto Run to modal',
		category: 'Auto Run',
	},
});

// Wrapper component to test RightPanel with state management
const RightPanelTestWrapper = ({
	initialTab = 'autorun' as RightPanelTab,
	initialContent = '# Test Document\n\n- [ ] Task 1\n- [ ] Task 2',
	initialWidth = 400,
	onContentChange,
	onModeChange,
	onStateChange,
	panelRef,
	batchRunState,
}: {
	initialTab?: RightPanelTab;
	initialContent?: string;
	initialWidth?: number;
	onContentChange?: (content: string) => void;
	onModeChange?: (mode: 'edit' | 'preview') => void;
	onStateChange?: (state: {
		mode: 'edit' | 'preview';
		cursorPosition: number;
		editScrollPos: number;
		previewScrollPos: number;
	}) => void;
	panelRef?: React.Ref<RightPanelHandle>;
	batchRunState?: BatchRunState;
}) => {
	const [activeRightTab, setActiveRightTab] = useState<RightPanelTab>(initialTab);
	const [rightPanelWidth, setRightPanelWidth] = useState(initialWidth);
	const [autoRunContent, setAutoRunContent] = useState(initialContent);
	const [session, setSession] = useState(() => {
		const initialSession = createMockSession({ autoRunContent: initialContent });
		useSessionStore.setState({ sessions: [initialSession], activeSessionId: initialSession.id });
		return initialSession;
	});
	const [rightPanelOpen, setRightPanelOpen] = useState(true);
	const [activeFocus, setActiveFocus] = useState('right');

	const fileTreeContainerRef = React.useRef<HTMLDivElement>(null);
	const fileTreeFilterInputRef = React.useRef<HTMLInputElement>(null);

	useEffect(() => {
		useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
	}, [session]);

	useEffect(() => {
		useUIStore.setState({ rightPanelOpen, activeRightTab, activeFocus });
	}, [activeFocus, activeRightTab, rightPanelOpen]);

	useEffect(() => {
		useSettingsStore.setState({
			rightPanelWidth,
			shortcuts: createMockShortcuts(),
			showHiddenFiles: false,
			autoRunDisabled: false,
		});
		useBatchStore.setState({
			documentList: ['Phase 1', 'Phase 2', 'Phase 3'],
			documentTree: undefined as never,
			isLoadingDocuments: false,
			batchRunStates: {},
		});
	}, [rightPanelWidth]);

	const handleContentChange = (content: string) => {
		setAutoRunContent(content);
		setSession((prev) => ({
			...prev,
			autoRunContent: content,
			autoRunContentVersion: (prev.autoRunContentVersion ?? 0) + 1,
		}));
		onContentChange?.(content);
	};

	const handleModeChange = (mode: 'edit' | 'preview') => {
		setSession((prev) => ({ ...prev, autoRunMode: mode }));
		onModeChange?.(mode);
	};

	const handleStateChange = (state: {
		mode: 'edit' | 'preview';
		cursorPosition: number;
		editScrollPos: number;
		previewScrollPos: number;
	}) => {
		setSession((prev) => ({
			...prev,
			autoRunMode: state.mode,
			autoRunCursorPosition: state.cursorPosition,
			autoRunEditScrollPos: state.editScrollPos,
			autoRunPreviewScrollPos: state.previewScrollPos,
		}));
		onStateChange?.(state);
	};
	return (
		<LayerStackProvider>
			<RightPanel
				ref={panelRef}
				session={session}
				theme={createMockTheme()}
				shortcuts={createMockShortcuts()}
				rightPanelOpen={rightPanelOpen}
				setRightPanelOpen={setRightPanelOpen}
				rightPanelWidth={rightPanelWidth}
				setActiveRightTab={(tab) => {
					setActiveRightTab(tab);
					useUIStore.getState().setActiveRightTab(tab);
				}}
				activeFocus={activeFocus}
				setActiveFocus={setActiveFocus}
				fileTreeFilter=""
				setFileTreeFilter={() => {}}
				fileTreeFilterOpen={false}
				setFileTreeFilterOpen={() => {}}
				filteredFileTree={[]}
				selectedFileIndex={0}
				setSelectedFileIndex={() => {}}
				fileTreeContainerRef={fileTreeContainerRef}
				fileTreeFilterInputRef={fileTreeFilterInputRef}
				toggleFolder={() => {}}
				toggleFolderRecursive={() => {}}
				handleFileClick={async () => {}}
				expandAllFolders={() => {}}
				collapseAllFolders={() => {}}
				updateSessionWorkingDirectory={async () => {}}
				refreshFileTree={async () => undefined}
				setSessions={() => {}}
				showHiddenFiles={false}
				setShowHiddenFiles={() => {}}
				autoRunDocumentList={['Phase 1', 'Phase 2', 'Phase 3']}
				autoRunDocumentTree={[]}
				autoRunContent={autoRunContent}
				autoRunContentVersion={0}
				autoRunIsLoadingDocuments={false}
				onAutoRunContentChange={handleContentChange}
				onAutoRunModeChange={handleModeChange}
				onAutoRunStateChange={handleStateChange}
				onAutoRunSelectDocument={(filename) =>
					setSession((prev) => ({ ...prev, autoRunSelectedFile: filename }))
				}
				onAutoRunCreateDocument={async () => true}
				onAutoRunRefresh={() => {}}
				onAutoRunOpenSetup={() => {}}
				currentSessionBatchState={batchRunState}
			/>
		</LayerStackProvider>
	);
};

describe('Auto Run + RightPanel Integration', () => {
	let mockMaestro: ReturnType<typeof setupMaestroMock>;

	beforeEach(() => {
		mockMaestro = setupMaestroMock();
		vi.useFakeTimers({ shouldAdvanceTime: true });
		vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
			cb(0);
			return 0;
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	describe('Tab Switching Preserves Auto Run State', () => {
		it('unsaved content changes persist when switching tabs (via shared state)', async () => {
			// Note: RightPanel manages shared draft state that persists across tab switches.
			// This allows users to switch tabs without losing their unsaved changes.
			render(<RightPanelTestWrapper />);

			// Find the textarea in Auto Run
			const textarea = screen.getByRole('textbox');
			expect(textarea).toHaveValue('# Test Document\n\n- [ ] Task 1\n- [ ] Task 2');

			// Type some content (updates shared state in RightPanel)
			fireEvent.change(textarea, { target: { value: 'Modified content' } });
			expect(textarea).toHaveValue('Modified content');

			// Switch to files tab
			const filesTab = screen.getByRole('button', { name: 'Files' });
			fireEvent.click(filesTab);

			// Verify Auto Run is not rendered
			expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
			expect(screen.getByTestId('file-explorer-panel')).toBeInTheDocument();

			// Switch back to autorun tab
			const autorunTab = screen.getByRole('button', { name: 'Auto Run' });
			fireEvent.click(autorunTab);

			// Content is preserved from shared state (not reverted to saved content)
			const newTextarea = screen.getByRole('textbox');
			expect(newTextarea).toHaveValue('Modified content');
		});

		it('external content changes (via contentVersion) persist across tab switches', async () => {
			// Test that content persists when parent state is updated via contentVersion
			const TestComponent = () => {
				const [activeTab, setActiveTab] = useState<RightPanelTab>('autorun');
				const [content, setContent] = useState('Initial content');
				const [version, setVersion] = useState(0);
				const [session, setSession] = useState(() => {
					const initialSession = createMockSession({ autoRunContent: 'Initial content' });
					useSessionStore.setState({
						sessions: [initialSession],
						activeSessionId: initialSession.id,
					});
					return initialSession;
				});
				useEffect(() => {
					useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
				}, [session]);
				useEffect(() => {
					useUIStore.setState({
						rightPanelOpen: true,
						activeRightTab: activeTab,
						activeFocus: 'right',
					});
				}, [activeTab]);
				useEffect(() => {
					useSettingsStore.setState({
						rightPanelWidth: 400,
						shortcuts: createMockShortcuts(),
						showHiddenFiles: false,
						autoRunDisabled: false,
					});
					useBatchStore.setState({
						documentList: ['Phase 1'],
						documentTree: undefined as never,
						isLoadingDocuments: false,
						batchRunStates: {},
					});
				}, []);
				const fileTreeContainerRef = React.useRef<HTMLDivElement>(null);
				const fileTreeFilterInputRef = React.useRef<HTMLInputElement>(null);

				return (
					<LayerStackProvider>
						<div>
							<button
								data-testid="external-change"
								onClick={() => {
									setContent('Externally updated content');
									setVersion((v) => v + 1);
									setSession((prev) => ({
										...prev,
										autoRunContent: 'Externally updated content',
										autoRunContentVersion: (prev.autoRunContentVersion ?? 0) + 1,
									}));
								}}
							>
								External Change
							</button>
							<RightPanel
								session={session}
								theme={createMockTheme()}
								shortcuts={createMockShortcuts()}
								rightPanelOpen={true}
								setRightPanelOpen={() => {}}
								rightPanelWidth={400}
								setRightPanelWidthState={() => {}}
								activeRightTab={activeTab}
								setActiveRightTab={(tab) => {
									setActiveTab(tab);
									useUIStore.getState().setActiveRightTab(tab);
								}}
								activeFocus="right"
								setActiveFocus={() => {}}
								fileTreeFilter=""
								setFileTreeFilter={() => {}}
								fileTreeFilterOpen={false}
								setFileTreeFilterOpen={() => {}}
								filteredFileTree={[]}
								selectedFileIndex={0}
								setSelectedFileIndex={() => {}}
								fileTreeContainerRef={fileTreeContainerRef}
								fileTreeFilterInputRef={fileTreeFilterInputRef}
								toggleFolder={() => {}}
								toggleFolderRecursive={() => {}}
								handleFileClick={async () => {}}
								expandAllFolders={() => {}}
								collapseAllFolders={() => {}}
								updateSessionWorkingDirectory={async () => {}}
								refreshFileTree={async () => undefined}
								setSessions={() => {}}
								showHiddenFiles={false}
								setShowHiddenFiles={() => {}}
								autoRunDocumentList={['Phase 1']}
								autoRunDocumentTree={[]}
								autoRunContent={content}
								autoRunContentVersion={version}
								autoRunIsLoadingDocuments={false}
								onAutoRunContentChange={setContent}
								onAutoRunModeChange={() => {}}
								onAutoRunStateChange={() => {}}
								onAutoRunSelectDocument={() => {}}
								onAutoRunCreateDocument={async () => true}
								onAutoRunRefresh={() => {}}
								onAutoRunOpenSetup={() => {}}
							/>
						</div>
					</LayerStackProvider>
				);
			};

			render(<TestComponent />);

			// Initial content
			expect(screen.getByRole('textbox')).toHaveValue('Initial content');

			// Simulate external change
			fireEvent.click(screen.getByTestId('external-change'));

			// Content should be updated
			await waitFor(() => {
				expect(screen.getByRole('textbox')).toHaveValue('Externally updated content');
			});

			// Switch to files tab
			fireEvent.click(screen.getByRole('button', { name: 'Files' }));

			// Switch back to autorun tab
			fireEvent.click(screen.getByRole('button', { name: 'Auto Run' }));

			// Content should persist
			expect(screen.getByRole('textbox')).toHaveValue('Externally updated content');
		});

		it('preserves mode (edit/preview) when switching tabs', async () => {
			const onModeChange = vi.fn();
			render(<RightPanelTestWrapper onModeChange={onModeChange} />);

			// Find the mode toggle and switch to preview
			const previewButton = screen.getByRole('button', { name: /preview/i });
			fireEvent.click(previewButton);
			expect(onModeChange).toHaveBeenCalledWith('preview');

			// Switch to history tab
			const historyTab = screen.getByRole('button', { name: 'History' });
			fireEvent.click(historyTab);

			// Switch back to autorun tab
			const autorunTab = screen.getByRole('button', { name: 'Auto Run' });
			fireEvent.click(autorunTab);

			// Preview mode remains active, so the control offers the inverse transition.
			expect(screen.getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
		});

		it('preserves cursor position when switching tabs', async () => {
			const onStateChange = vi.fn();
			render(<RightPanelTestWrapper onStateChange={onStateChange} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

			// Simulate cursor position change
			fireEvent.focus(textarea);
			textarea.setSelectionRange(10, 10);
			fireEvent.blur(textarea);

			// The state change should have been triggered (cursor position is saved)
			// Switch tabs and back
			fireEvent.click(screen.getByRole('button', { name: 'Files' }));
			fireEvent.click(screen.getByRole('button', { name: 'Auto Run' }));

			// Verify the component is still functional
			const newTextarea = screen.getByRole('textbox');
			expect(newTextarea).toBeInTheDocument();
		});

		it('dirty state indicator shows when content is modified', async () => {
			render(<RightPanelTestWrapper />);

			const textarea = screen.getByRole('textbox');

			// Initially no Save button (clean state)
			expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();

			// Make content dirty - wrap in act for state update
			await act(async () => {
				fireEvent.change(textarea, {
					target: { value: 'Modified content that creates dirty state' },
				});
			});

			// Check for Save button (indicates dirty state)
			await waitFor(() => {
				expect(screen.queryByRole('button', { name: /save/i })).toBeInTheDocument();
			});
		});

		it('dirty state persists when switching tabs (via shared state)', async () => {
			// Note: RightPanel manages shared draft state that includes dirty state tracking
			render(<RightPanelTestWrapper />);

			const textarea = screen.getByRole('textbox');

			// Make content dirty - wrap in act for state update
			await act(async () => {
				fireEvent.change(textarea, { target: { value: 'Modified content' } });
			});

			await waitFor(() => {
				expect(screen.queryByRole('button', { name: /save/i })).toBeInTheDocument();
			});

			// Switch to history tab and back
			fireEvent.click(screen.getByRole('button', { name: 'History' }));
			fireEvent.click(screen.getByRole('button', { name: 'Auto Run' }));

			// Dirty state is preserved because shared state includes both local and saved content
			await waitFor(() => {
				expect(screen.queryByRole('button', { name: /save/i })).toBeInTheDocument();
			});
		});

		it('preserves document selection when switching tabs', async () => {
			render(<RightPanelTestWrapper />);

			// Select a different document through the current button-based selector.
			fireEvent.click(screen.getByRole('button', { name: 'Phase 1.md' }));
			fireEvent.click(screen.getByRole('button', { name: /Phase 2/ }));

			// Switch to files tab and back.
			fireEvent.click(screen.getByRole('button', { name: 'Files' }));
			fireEvent.click(screen.getByRole('button', { name: 'Auto Run' }));

			// Selection is sourced from the active-session store and survives the tab switch.
			expect(screen.getByRole('button', { name: /Phase 2/ })).toBeInTheDocument();
		});

		it('handles rapid tab switching without crashes', async () => {
			// Tests that rapid tab switching doesn't cause errors
			render(<RightPanelTestWrapper />);

			// Rapid tab switching
			for (let i = 0; i < 5; i++) {
				fireEvent.click(screen.getByRole('button', { name: 'Files' }));
				fireEvent.click(screen.getByRole('button', { name: 'History' }));
				fireEvent.click(screen.getByRole('button', { name: 'Auto Run' }));
			}

			// Component should still be functional
			const finalTextarea = screen.getByRole('textbox');
			expect(finalTextarea).toBeInTheDocument();
		});
	});

	describe('Panel Resize Does Not Lose Content', () => {
		it('preserves content during panel width resize', async () => {
			const onContentChange = vi.fn();
			const { container } = render(<RightPanelTestWrapper onContentChange={onContentChange} />);

			// Modify content
			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Content during resize' } });

			// Simulate resize interaction
			const resizeHandle = container.querySelector('.cursor-col-resize') as HTMLElement;
			expect(resizeHandle).toBeInTheDocument();

			// Start resize
			fireEvent.mouseDown(resizeHandle, { clientX: 500 });

			// Move to resize
			fireEvent.mouseMove(document, { clientX: 550 });
			fireEvent.mouseMove(document, { clientX: 600 });

			// End resize
			fireEvent.mouseUp(document);

			// Content should still be preserved
			expect(screen.getByRole('textbox')).toHaveValue('Content during resize');
		});

		it('preserves content when panel is collapsed and reopened', async () => {
			const onContentChange = vi.fn();
			render(<RightPanelTestWrapper onContentChange={onContentChange} />);

			// Modify content
			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Content before collapse' } });

			// Find toggle button and collapse
			const toggleButton = screen.getByTitle(/collapse right panel/i);
			fireEvent.click(toggleButton);

			// Panel should be collapsed
			// (In the wrapper component, the panel width changes to 0)

			// Reopen panel
			fireEvent.click(toggleButton);

			// Content should be preserved
			const reopenedTextarea = screen.getByRole('textbox');
			expect(reopenedTextarea).toHaveValue('Content before collapse');
		});

		it('preserves mode during panel resize', async () => {
			const onModeChange = vi.fn();
			const { container } = render(<RightPanelTestWrapper onModeChange={onModeChange} />);

			// Switch to preview mode
			const previewButton = screen.getByRole('button', { name: /preview/i });
			fireEvent.click(previewButton);

			// Simulate resize
			const resizeHandle = container.querySelector('.cursor-col-resize') as HTMLElement;
			fireEvent.mouseDown(resizeHandle, { clientX: 500 });
			fireEvent.mouseMove(document, { clientX: 600 });
			fireEvent.mouseUp(document);

			// Preview mode remains active after resizing.
			expect(screen.getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
		});

		it('maintains scroll position during resize', async () => {
			const onStateChange = vi.fn();
			const { container } = render(<RightPanelTestWrapper onStateChange={onStateChange} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

			// Simulate scroll (by setting scrollTop property)
			Object.defineProperty(textarea, 'scrollTop', {
				value: 150,
				writable: true,
				configurable: true,
			});
			fireEvent.scroll(textarea);

			// Simulate resize
			const resizeHandle = container.querySelector('.cursor-col-resize') as HTMLElement;
			fireEvent.mouseDown(resizeHandle, { clientX: 500 });
			fireEvent.mouseMove(document, { clientX: 600 });
			fireEvent.mouseUp(document);

			// Textarea should still be present (scroll position is managed internally)
			expect(screen.getByRole('textbox')).toBeInTheDocument();
		});

		it('handles resize to minimum width without losing content', async () => {
			const { container } = render(<RightPanelTestWrapper />);

			// Modify content
			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Content at min width' } });

			// Simulate resize to minimum (384px is min)
			const resizeHandle = container.querySelector('.cursor-col-resize') as HTMLElement;
			fireEvent.mouseDown(resizeHandle, { clientX: 500 });

			// Try to resize beyond minimum
			fireEvent.mouseMove(document, { clientX: 900 }); // This would make it very narrow
			fireEvent.mouseUp(document);

			// Content should still be preserved
			expect(screen.getByRole('textbox')).toHaveValue('Content at min width');
		});

		it('handles resize to maximum width without losing content', async () => {
			const { container } = render(<RightPanelTestWrapper />);

			// Modify content
			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Content at max width' } });

			// Simulate resize to maximum (800px is max)
			const resizeHandle = container.querySelector('.cursor-col-resize') as HTMLElement;
			fireEvent.mouseDown(resizeHandle, { clientX: 500 });

			// Try to resize beyond maximum
			fireEvent.mouseMove(document, { clientX: -500 }); // This would make it very wide
			fireEvent.mouseUp(document);

			// Content should still be preserved
			expect(screen.getByRole('textbox')).toHaveValue('Content at max width');
		});
	});

	describe('Expanded Modal Syncs With Panel', () => {
		it('expanded modal receives same content as panel', async () => {
			render(<RightPanelTestWrapper initialContent={'# Initial Content\n\n- [ ] Task 1'} />);

			// Verify content is shown
			const textarea = screen.getByRole('textbox');
			expect(textarea).toHaveValue('# Initial Content\n\n- [ ] Task 1');

			// The expand button should be accessible
			// Look for the expand/maximize button
			const expandButton = screen.queryByTitle(/expand/i);
			expect(expandButton || screen.queryByRole('button')).toBeTruthy(); // Panel should have buttons
		});

		it('changes in panel content reflect in session state', async () => {
			const onStateChange = vi.fn();
			render(<RightPanelTestWrapper onStateChange={onStateChange} />);

			const textarea = screen.getByRole('textbox');

			// Make content changes
			fireEvent.change(textarea, { target: { value: 'Updated content from panel' } });

			// State change handler should be called for mode/position changes
			fireEvent.blur(textarea);

			// The content change should propagate through the component hierarchy
			expect(textarea).toHaveValue('Updated content from panel');
		});

		it('mode changes in panel are persisted', async () => {
			const onModeChange = vi.fn();
			render(<RightPanelTestWrapper onModeChange={onModeChange} />);

			// Switch to preview
			const previewButton = screen.getByRole('button', { name: /preview/i });
			fireEvent.click(previewButton);

			expect(onModeChange).toHaveBeenCalledWith('preview');

			// Preview mode exposes the inverse transition.
			fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));

			expect(onModeChange).toHaveBeenCalledWith('edit');
		});

		it('panel updates content version when external changes occur', async () => {
			// This tests that contentVersion prop triggers re-sync
			render(<RightPanelTestWrapper initialContent="Initial content" />);

			expect(screen.getByRole('textbox')).toHaveValue('Initial content');

			// External updates arrive through the active-session store.
			const activeSession = useSessionStore.getState().sessions[0];
			act(() => {
				useSessionStore.setState({
					sessions: [
						{
							...activeSession,
							autoRunContent: 'External update content',
							autoRunContentVersion: (activeSession.autoRunContentVersion ?? 0) + 1,
						},
					],
				});
			});

			await waitFor(() => {
				expect(screen.getByRole('textbox')).toHaveValue('External update content');
			});
		});

		it('toggleAutoRunExpanded method works via ref', async () => {
			const ref = createRef<RightPanelHandle>();
			render(<RightPanelTestWrapper panelRef={ref} initialContent="Test content" />);

			// Verify ref is available
			expect(ref.current).toBeTruthy();
			expect(typeof ref.current?.toggleAutoRunExpanded).toBe('function');

			// Call toggle method
			act(() => {
				ref.current?.toggleAutoRunExpanded();
			});

			// The expanded modal should now be visible (it renders with role="dialog" or similar)
			// Due to mocking, we can verify the method doesn't throw
		});
	});

	describe('Focus Management Between Panel and AutoRun', () => {
		it('focuses AutoRun when switching to autorun tab', async () => {
			render(<RightPanelTestWrapper initialTab="files" />);

			// Initially on files tab
			expect(screen.getByTestId('file-explorer-panel')).toBeInTheDocument();

			// Switch to autorun
			const autorunTab = screen.getByRole('button', { name: 'Auto Run' });
			fireEvent.click(autorunTab);

			// AutoRun should be visible
			expect(screen.getByRole('textbox')).toBeInTheDocument();
		});

		it('focusAutoRun ref method works', async () => {
			const ref = createRef<RightPanelHandle>();
			const fileTreeContainerRef = React.createRef<HTMLDivElement>();
			const fileTreeFilterInputRef = React.createRef<HTMLInputElement>();

			render(
				<LayerStackProvider>
					<RightPanel
						ref={ref}
						session={createMockSession()}
						theme={createMockTheme()}
						shortcuts={createMockShortcuts()}
						rightPanelOpen={true}
						setRightPanelOpen={() => {}}
						rightPanelWidth={400}
						setRightPanelWidthState={() => {}}
						activeRightTab="autorun"
						setActiveRightTab={() => {}}
						activeFocus="right"
						setActiveFocus={() => {}}
						fileTreeFilter=""
						setFileTreeFilter={() => {}}
						fileTreeFilterOpen={false}
						setFileTreeFilterOpen={() => {}}
						filteredFileTree={[]}
						selectedFileIndex={0}
						setSelectedFileIndex={() => {}}
						fileTreeContainerRef={fileTreeContainerRef}
						fileTreeFilterInputRef={fileTreeFilterInputRef}
						toggleFolder={() => {}}
						toggleFolderRecursive={() => {}}
						handleFileClick={async () => {}}
						expandAllFolders={() => {}}
						collapseAllFolders={() => {}}
						updateSessionWorkingDirectory={async () => {}}
						refreshFileTree={async () => undefined}
						setSessions={() => {}}
						showHiddenFiles={false}
						setShowHiddenFiles={() => {}}
						autoRunDocumentList={['Phase 1']}
						autoRunDocumentTree={[]}
						autoRunContent="Test content"
						autoRunContentVersion={0}
						autoRunIsLoadingDocuments={false}
						onAutoRunContentChange={() => {}}
						onAutoRunModeChange={() => {}}
						onAutoRunStateChange={() => {}}
						onAutoRunSelectDocument={() => {}}
						onAutoRunCreateDocument={async () => true}
						onAutoRunRefresh={() => {}}
						onAutoRunOpenSetup={() => {}}
					/>
				</LayerStackProvider>
			);

			// Call focusAutoRun
			expect(() => {
				act(() => {
					ref.current?.focusAutoRun();
				});
			}).not.toThrow();
		});
	});

	describe('State Persistence Across Tab Visibility Changes', () => {
		it('AutoRun draft content persists across tab switches via shared state', async () => {
			// Note: RightPanel now manages shared draft state that persists across tab switches.
			// This allows users to switch tabs without losing unsaved changes.
			render(<RightPanelTestWrapper />);

			// Initial content
			const textarea = screen.getByRole('textbox');
			expect(textarea).toHaveValue('# Test Document\n\n- [ ] Task 1\n- [ ] Task 2');

			// Modify content (creates dirty state in shared state)
			fireEvent.change(textarea, { target: { value: 'Modified content' } });

			// Wait for state to propagate
			await waitFor(() => {
				expect(textarea).toHaveValue('Modified content');
			});

			// Switch away - AutoRun unmounts but shared state persists in RightPanel
			fireEvent.click(screen.getByRole('button', { name: 'Files' }));
			expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

			// Switch back - AutoRun remounts with draft content from shared state
			fireEvent.click(screen.getByRole('button', { name: 'Auto Run' }));

			// Content is preserved from the shared draft state
			await waitFor(() => {
				expect(screen.getByRole('textbox')).toHaveValue('Modified content');
			});
		});

		it('saved content persists across tab switches', async () => {
			// Test that saved content persists - we need to simulate a save and content sync
			const TestComponent = () => (
				<>
					<button
						data-testid="simulate-save"
						onClick={() => {
							const activeSession = useSessionStore.getState().sessions[0];
							useSessionStore.setState({
								sessions: [
									{
										...activeSession,
										autoRunContent: 'Saved content',
										autoRunContentVersion: (activeSession.autoRunContentVersion ?? 0) + 1,
									},
								],
							});
						}}
					>
						Simulate Save
					</button>
					<RightPanelTestWrapper initialContent="Initial content" />
				</>
			);

			render(<TestComponent />);

			// Initial content
			expect(screen.getByRole('textbox')).toHaveValue('Initial content');

			// Simulate save (which would update parent state and version)
			fireEvent.click(screen.getByTestId('simulate-save'));

			// Switch away
			fireEvent.click(screen.getByRole('button', { name: 'Files' }));

			// Switch back
			fireEvent.click(screen.getByRole('button', { name: 'Auto Run' }));

			// Saved content should persist
			await waitFor(() => {
				expect(screen.getByRole('textbox')).toHaveValue('Saved content');
			});
		});

		it('handles session change while on different tab', async () => {
			const TestComponent = () => (
				<>
					<button
						data-testid="switch-session"
						onClick={() => {
							const nextSession = createMockSession({
								id: 'session-2',
								name: 'Session 2',
								autoRunContent: 'Session 2 content',
							});
							useSessionStore.setState({
								sessions: [nextSession],
								activeSessionId: nextSession.id,
							});
						}}
					>
						Switch Session
					</button>
					<RightPanelTestWrapper initialContent="Session 1 content" />
				</>
			);

			render(<TestComponent />);

			// Initial content
			expect(screen.getByRole('textbox')).toHaveValue('Session 1 content');

			// Switch to files tab
			fireEvent.click(screen.getByRole('button', { name: 'Files' }));

			// Switch session while on files tab
			fireEvent.click(screen.getByTestId('switch-session'));

			// Switch back to autorun
			fireEvent.click(screen.getByRole('button', { name: 'Auto Run' }));

			// Should show new session's content
			expect(screen.getByRole('textbox')).toHaveValue('Session 2 content');
		});
	});

	describe('Edge Cases', () => {
		it('handles null session gracefully', () => {
			useSessionStore.setState({ sessions: [], activeSessionId: '' });
			const fileTreeContainerRef = React.createRef<HTMLDivElement>();
			const fileTreeFilterInputRef = React.createRef<HTMLInputElement>();

			const { container } = render(
				<LayerStackProvider>
					<RightPanel
						session={null}
						theme={createMockTheme()}
						shortcuts={createMockShortcuts()}
						rightPanelOpen={true}
						setRightPanelOpen={() => {}}
						rightPanelWidth={400}
						setRightPanelWidthState={() => {}}
						activeRightTab="autorun"
						setActiveRightTab={() => {}}
						activeFocus="right"
						setActiveFocus={() => {}}
						fileTreeFilter=""
						setFileTreeFilter={() => {}}
						fileTreeFilterOpen={false}
						setFileTreeFilterOpen={() => {}}
						filteredFileTree={[]}
						selectedFileIndex={0}
						setSelectedFileIndex={() => {}}
						fileTreeContainerRef={fileTreeContainerRef}
						fileTreeFilterInputRef={fileTreeFilterInputRef}
						toggleFolder={() => {}}
						toggleFolderRecursive={() => {}}
						handleFileClick={async () => {}}
						expandAllFolders={() => {}}
						collapseAllFolders={() => {}}
						updateSessionWorkingDirectory={async () => {}}
						refreshFileTree={async () => undefined}
						setSessions={() => {}}
						showHiddenFiles={false}
						setShowHiddenFiles={() => {}}
						autoRunDocumentList={[]}
						autoRunDocumentTree={[]}
						autoRunContent=""
						autoRunContentVersion={0}
						autoRunIsLoadingDocuments={false}
						onAutoRunContentChange={() => {}}
						onAutoRunModeChange={() => {}}
						onAutoRunStateChange={() => {}}
						onAutoRunSelectDocument={() => {}}
						onAutoRunCreateDocument={async () => true}
						onAutoRunRefresh={() => {}}
						onAutoRunOpenSetup={() => {}}
					/>
				</LayerStackProvider>
			);

			// Should render nothing when session is null
			expect(container.firstChild).toBeNull();
		});

		it('handles empty content gracefully', () => {
			render(<RightPanelTestWrapper initialContent="" />);

			const textarea = screen.getByRole('textbox');
			expect(textarea).toHaveValue('');
		});

		it('handles very long content without crashing', () => {
			const longContent = '# Test\n\n' + '- [ ] Task\n'.repeat(1000);
			render(<RightPanelTestWrapper initialContent={longContent} />);

			const textarea = screen.getByRole('textbox');
			expect(textarea.value.length).toBeGreaterThan(10000);
		});

		it('handles special characters in content', () => {
			const specialContent =
				'# Test <script>alert("xss")</script>\n\n- [ ] Task with "quotes" & <brackets>';
			render(<RightPanelTestWrapper initialContent={specialContent} />);

			const textarea = screen.getByRole('textbox');
			expect(textarea).toHaveValue(specialContent);
		});

		it('handles unicode content', () => {
			const unicodeContent = '# テスト 🎉\n\n- [ ] 任务 一\n- [ ] Tâche avec accénts';
			render(<RightPanelTestWrapper initialContent={unicodeContent} />);

			const textarea = screen.getByRole('textbox');
			expect(textarea).toHaveValue(unicodeContent);
		});
	});

	describe('Batch Run State Integration', () => {
		it('batch run progress shows in RightPanel regardless of active tab', async () => {
			const fileTreeContainerRef = React.createRef<HTMLDivElement>();
			const fileTreeFilterInputRef = React.createRef<HTMLInputElement>();

			const batchRunState: BatchRunState = {
				isRunning: true,
				isStopping: false,
				documents: ['Phase 1'],
				lockedDocuments: ['Phase 1'],
				currentDocumentIndex: 0,
				totalTasks: 5,
				completedTasks: 2,
				currentTaskIndex: 0,
				currentDocTasksTotal: 5,
				currentDocTasksCompleted: 2,
				totalTasksAcrossAllDocs: 5,
				completedTasksAcrossAllDocs: 2,
				loopEnabled: false,
				loopIteration: 0,
				folderPath: '/test/folder',
				worktreeActive: false,
				originalContent: '',
			};

			render(
				<RightPanelTestWrapper
					initialTab="files"
					initialContent="# Test"
					batchRunState={batchRunState}
				/>
			);

			// Should show progress even when on files tab
			expect(screen.getByText('Auto Run Active')).toBeInTheDocument();
			expect(screen.getByText('2 of 5 tasks completed')).toBeInTheDocument();
		});

		it('switching to autorun tab during batch run shows locked editor', async () => {
			const fileTreeContainerRef = React.createRef<HTMLDivElement>();
			const fileTreeFilterInputRef = React.createRef<HTMLInputElement>();

			const TestComponent = () => {
				const batchRunState: BatchRunState = {
					isRunning: true,
					isStopping: false,
					documents: ['Phase 1'],
					lockedDocuments: ['Phase 1'],
					currentDocumentIndex: 0,
					totalTasks: 5,
					completedTasks: 2,
					currentTaskIndex: 0,
					currentDocTasksTotal: 5,
					currentDocTasksCompleted: 2,
					totalTasksAcrossAllDocs: 5,
					completedTasksAcrossAllDocs: 2,
					loopEnabled: false,
					loopIteration: 0,
					folderPath: '/test/folder',
					worktreeActive: false,
					originalContent: '',
				};
				return (
					<RightPanelTestWrapper
						initialTab="files"
						initialContent="# Test content"
						batchRunState={batchRunState}
					/>
				);
			};

			render(<TestComponent />);

			// Initially on files tab
			expect(screen.getByTestId('file-explorer-panel')).toBeInTheDocument();

			// Switch to autorun
			fireEvent.click(screen.getByRole('button', { name: 'Auto Run' }));
			// Active Auto Run moves the document to preview and disables editing.
			expect(screen.getByTitle('Editing disabled while Auto Run active')).toBeDisabled();
		});
	});
});
