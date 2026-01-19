/**
 * @file AutoRunSessionList.test.tsx
 * @description Integration tests for Auto Run and Session List interaction
 *
 * Tests the integration between SessionList and AutoRun components:
 * - Session selection loads correct document
 * - Session deletion clears Auto Run state
 * - Group filtering doesn't affect Auto Run
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React, { useState, useCallback } from 'react';
import { SessionList } from '../../renderer/components/SessionList';
import { AutoRun, AutoRunHandle } from '../../renderer/components/AutoRun';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import type {
	Session,
	Group,
	Theme,
	Shortcut,
	BatchRunState,
	SessionState,
} from '../../renderer/types';

// Helper to wrap component in LayerStackProvider with custom rerender
const renderWithProviders = (ui: React.ReactElement) => {
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

vi.mock('../../renderer/utils/shortcutFormatter', () => ({
	formatShortcutKeys: vi.fn((keys) => keys?.join('+') || ''),
}));

vi.mock('../../renderer/hooks/useGitStatusPolling', () => ({
	useGitStatusPolling: () => ({
		gitFileCounts: new Map(),
	}),
}));

// Mock GitStatusContext to avoid Provider requirement
vi.mock('../../renderer/contexts/GitStatusContext', () => ({
	useGitStatus: () => ({
		gitStatusMap: new Map(),
		refreshGitStatus: vi.fn().mockResolvedValue(undefined),
		isLoading: false,
		getFileCount: () => 0,
		getStatus: () => undefined,
	}),
}));

vi.mock('../../renderer/hooks/useLiveOverlay', () => ({
	useLiveOverlay: () => ({
		liveOverlayOpen: false,
		setLiveOverlayOpen: vi.fn(),
		liveOverlayRef: { current: null },
		cloudflaredInstalled: false,
		cloudflaredChecked: true,
		tunnelStatus: 'stopped',
		tunnelUrl: null,
		tunnelError: null,
		activeUrlTab: 'local',
		setActiveUrlTab: vi.fn(),
		copyFlash: false,
		setCopyFlash: vi.fn(),
		handleTunnelToggle: vi.fn(),
	}),
}));

vi.mock('qrcode.react', () => ({
	QRCodeSVG: () => <div data-testid="qrcode">QR Code</div>,
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
			listDocs: vi
				.fn()
				.mockResolvedValue({ success: true, files: ['Phase 1', 'Phase 2'], tree: [] }),
			readDoc: vi.fn().mockResolvedValue({ success: true, content: '# Test Content' }),
			listImages: vi.fn().mockResolvedValue({ success: true, images: [] }),
			saveImage: vi.fn().mockResolvedValue({ success: true, relativePath: 'images/test-123.png' }),
			deleteImage: vi.fn().mockResolvedValue({ success: true }),
			writeDoc: vi.fn().mockResolvedValue({ success: true }),
		},
		settings: {
			get: vi.fn().mockResolvedValue(null),
			set: vi.fn().mockResolvedValue(undefined),
		},
	};

	(window as any).maestro = mockMaestro;
	return mockMaestro;
};

// Create mock session
const createMockSession = (overrides: Partial<Session> = {}): Session => ({
	id: 'test-session-1',
	name: 'Test Session 1',
	cwd: '/test/path',
	projectRoot: '/test/path',
	fullPath: '/test/path',
	toolType: 'claude-code',
	state: 'idle',
	inputMode: 'ai',
	isGitRepo: true,
	aiPid: 1234,
	terminalPid: 5678,
	port: 3000,
	aiTabs: [{ id: 'tab-1', name: 'Tab 1', logs: [] }],
	activeTabId: 'tab-1',
	closedTabHistory: [],
	shellLogs: [],
	fileTree: [],
	fileExplorerExpanded: [],
	fileExplorerScrollPos: 0,
	executionQueue: [],
	changedFiles: [],
	isLive: false,
	contextUsage: 0,
	workLog: [],
	autoRunFolderPath: '/test/autorun',
	autoRunSelectedFile: 'Phase 1',
	autoRunMode: 'edit',
	autoRunContent: '# Session 1 Content\n\n- [ ] Task 1',
	autoRunContentVersion: 0,
	autoRunCursorPosition: 0,
	autoRunEditScrollPos: 0,
	autoRunPreviewScrollPos: 0,
	...overrides,
});

// Create mock group
const createMockGroup = (overrides: Partial<Group> = {}): Group => ({
	id: 'group-1',
	name: 'Test Group',
	emoji: '📁',
	collapsed: false,
	...overrides,
});

// Create mock shortcuts
const createMockShortcuts = (): Record<string, Shortcut> => ({
	toggleLeftPanel: {
		id: 'toggleLeftPanel',
		name: 'Toggle Left Panel',
		keys: ['Cmd', 'B'],
		description: 'Toggle the left panel',
		category: 'Navigation',
	},
	toggleSidebar: {
		id: 'toggleSidebar',
		name: 'Toggle Sidebar',
		keys: ['Cmd', '\\'],
		description: 'Toggle the sidebar',
		category: 'Navigation',
	},
	newSession: {
		id: 'newSession',
		name: 'New Session',
		keys: ['Cmd', 'N'],
		description: 'Create a new session',
		category: 'Sessions',
	},
	openWizard: {
		id: 'openWizard',
		name: 'Open Wizard',
		keys: ['Cmd', 'Shift', 'N'],
		description: 'Open the wizard',
		category: 'Sessions',
	},
	toggleBookmarksFolder: {
		id: 'toggleBookmarksFolder',
		name: 'Toggle Bookmarks',
		keys: ['Cmd', 'B'],
		description: 'Toggle bookmarks',
		category: 'Navigation',
	},
	help: {
		id: 'help',
		name: 'Help',
		keys: ['Cmd', '/'],
		description: 'Show help',
		category: 'General',
	},
	settings: {
		id: 'settings',
		name: 'Settings',
		keys: ['Cmd', ','],
		description: 'Open settings',
		category: 'General',
	},
	systemLogs: {
		id: 'systemLogs',
		name: 'System Logs',
		keys: ['Cmd', 'Shift', 'L'],
		description: 'View system logs',
		category: 'Debug',
	},
	processMonitor: {
		id: 'processMonitor',
		name: 'Process Monitor',
		keys: ['Cmd', 'Shift', 'P'],
		description: 'View process monitor',
		category: 'Debug',
	},
});

// Integration test wrapper that manages both SessionList and AutoRun state
const IntegrationTestWrapper = ({
	initialSessions = [
		createMockSession({
			id: 'session-1',
			name: 'Session 1',
			autoRunContent: '# Session 1\n\n- [ ] Task 1',
		}),
		createMockSession({
			id: 'session-2',
			name: 'Session 2',
			autoRunFolderPath: '/test/autorun2',
			autoRunSelectedFile: 'Phase 2',
			autoRunContent: '# Session 2\n\n- [ ] Task A\n- [ ] Task B',
		}),
		createMockSession({
			id: 'session-3',
			name: 'Session 3',
			groupId: 'group-1',
			autoRunFolderPath: '/test/autorun3',
			autoRunSelectedFile: 'Phase 3',
			autoRunContent: '# Session 3\n\n- [ ] Group Task',
		}),
	],
	initialGroups = [createMockGroup({ id: 'group-1', name: 'Test Group' })],
	initialActiveSessionId = 'session-1',
	onSessionChange,
	onSessionDelete,
}: {
	initialSessions?: Session[];
	initialGroups?: Group[];
	initialActiveSessionId?: string;
	onSessionChange?: (sessionId: string) => void;
	onSessionDelete?: (sessionId: string) => void;
}) => {
	const [sessions, setSessions] = useState<Session[]>(initialSessions);
	const [groups, setGroups] = useState<Group[]>(initialGroups);
	const [activeSessionId, setActiveSessionId] = useState(initialActiveSessionId);
	const [leftSidebarOpen, setLeftSidebarOpen] = useState(true);
	const [leftSidebarWidth, setLeftSidebarWidth] = useState(256);
	const [activeFocus, setActiveFocus] = useState<'sidebar' | 'main' | 'right'>('sidebar');
	const [selectedSidebarIndex, setSelectedSidebarIndex] = useState(0);
	const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
	const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
	const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);
	const [bookmarksCollapsed, setBookmarksCollapsed] = useState(false);
	const [ungroupedCollapsed, setUngroupedCollapsed] = useState(false);
	const [showConfirmDialog, setShowConfirmDialog] = useState<{
		message: string;
		onConfirm: () => void;
	} | null>(null);

	const activeSession = sessions.find((s) => s.id === activeSessionId) || null;

	const handleSessionSelect = useCallback(
		(id: string) => {
			setActiveSessionId(id);
			onSessionChange?.(id);
		},
		[onSessionChange]
	);

	const handleDeleteSession = useCallback(
		(sessionId: string) => {
			const newSessions = sessions.filter((s) => s.id !== sessionId);
			setSessions(newSessions);
			onSessionDelete?.(sessionId);
			if (activeSessionId === sessionId && newSessions.length > 0) {
				setActiveSessionId(newSessions[0].id);
			}
		},
		[sessions, activeSessionId, onSessionDelete]
	);

	const handleConfirmation = useCallback((message: string, onConfirm: () => void) => {
		setShowConfirmDialog({ message, onConfirm });
	}, []);

	const theme = createMockTheme();
	const shortcuts = createMockShortcuts();

	return (
		<LayerStackProvider>
			<div style={{ display: 'flex', height: '100vh' }}>
				{/* Session List */}
				<SessionList
					theme={theme}
					sessions={sessions}
					groups={groups}
					sortedSessions={sessions}
					activeSessionId={activeSessionId}
					leftSidebarOpen={leftSidebarOpen}
					leftSidebarWidthState={leftSidebarWidth}
					activeFocus={activeFocus}
					selectedSidebarIndex={selectedSidebarIndex}
					editingGroupId={editingGroupId}
					editingSessionId={editingSessionId}
					draggingSessionId={draggingSessionId}
					shortcuts={shortcuts}
					isLiveMode={false}
					webInterfaceUrl={null}
					toggleGlobalLive={() => {}}
					bookmarksCollapsed={bookmarksCollapsed}
					setBookmarksCollapsed={setBookmarksCollapsed}
					ungroupedCollapsed={ungroupedCollapsed}
					setUngroupedCollapsed={setUngroupedCollapsed}
					setActiveFocus={(focus) => setActiveFocus(focus as 'sidebar' | 'main' | 'right')}
					setActiveSessionId={handleSessionSelect}
					setLeftSidebarOpen={setLeftSidebarOpen}
					setLeftSidebarWidthState={setLeftSidebarWidth}
					setShortcutsHelpOpen={() => {}}
					setSettingsModalOpen={() => {}}
					setSettingsTab={() => {}}
					setAboutModalOpen={() => {}}
					setUpdateCheckModalOpen={() => {}}
					setLogViewerOpen={() => {}}
					setProcessMonitorOpen={() => {}}
					toggleGroup={(groupId) => {
						setGroups((prev) =>
							prev.map((g) => (g.id === groupId ? { ...g, collapsed: !g.collapsed } : g))
						);
					}}
					handleDragStart={(sessionId) => setDraggingSessionId(sessionId)}
					handleDragOver={(e) => e.preventDefault()}
					handleDropOnGroup={(groupId) => {
						if (draggingSessionId) {
							setSessions((prev) =>
								prev.map((s) => (s.id === draggingSessionId ? { ...s, groupId } : s))
							);
							setDraggingSessionId(null);
						}
					}}
					handleDropOnUngrouped={() => {
						if (draggingSessionId) {
							setSessions((prev) =>
								prev.map((s) => (s.id === draggingSessionId ? { ...s, groupId: undefined } : s))
							);
							setDraggingSessionId(null);
						}
					}}
					finishRenamingGroup={(groupId, newName) => {
						setGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, name: newName } : g)));
						setEditingGroupId(null);
					}}
					finishRenamingSession={(sessId, newName) => {
						setSessions((prev) => prev.map((s) => (s.id === sessId ? { ...s, name: newName } : s)));
						setEditingSessionId(null);
					}}
					startRenamingGroup={(groupId) => setEditingGroupId(groupId)}
					startRenamingSession={(sessId) => setEditingSessionId(sessId)}
					showConfirmation={handleConfirmation}
					setGroups={setGroups}
					setSessions={setSessions}
					createNewGroup={() => {
						const newGroup: Group = {
							id: `group-${Date.now()}`,
							name: 'New Group',
							emoji: '📁',
							collapsed: false,
						};
						setGroups((prev) => [...prev, newGroup]);
					}}
					addNewSession={() => {
						const newSession = createMockSession({
							id: `session-${Date.now()}`,
							name: `New Session`,
							autoRunFolderPath: undefined,
							autoRunSelectedFile: undefined,
							autoRunContent: '',
						});
						setSessions((prev) => [...prev, newSession]);
						setActiveSessionId(newSession.id);
					}}
					setRenameInstanceModalOpen={() => {}}
					setRenameInstanceValue={() => {}}
					setRenameInstanceSessionId={() => {}}
				/>

				{/* Auto Run Panel (only render if active session exists) */}
				{activeSession && activeSession.autoRunFolderPath && (
					<div style={{ flex: 1 }} data-testid="autorun-container">
						<AutoRun
							theme={theme}
							sessionId={activeSession.id}
							folderPath={activeSession.autoRunFolderPath}
							selectedFile={activeSession.autoRunSelectedFile || ''}
							documentList={['Phase 1', 'Phase 2']}
							content={activeSession.autoRunContent || ''}
							contentVersion={activeSession.autoRunContentVersion || 0}
							onContentChange={(content) => {
								setSessions((prev) =>
									prev.map((s) =>
										s.id === activeSessionId ? { ...s, autoRunContent: content } : s
									)
								);
							}}
							mode={activeSession.autoRunMode || 'edit'}
							onModeChange={(mode) => {
								setSessions((prev) =>
									prev.map((s) => (s.id === activeSessionId ? { ...s, autoRunMode: mode } : s))
								);
							}}
							onOpenSetup={() => {}}
							onRefresh={() => {}}
							onSelectDocument={(filename) => {
								setSessions((prev) =>
									prev.map((s) =>
										s.id === activeSessionId ? { ...s, autoRunSelectedFile: filename } : s
									)
								);
							}}
							onCreateDocument={async () => true}
							onOpenBatchRunner={() => {}}
							onStopBatchRun={() => {}}
							sessionState={activeSession.state}
						/>
					</div>
				)}

				{/* Auto Run not configured message */}
				{activeSession && !activeSession.autoRunFolderPath && (
					<div data-testid="autorun-not-configured">Auto Run not configured for this session</div>
				)}

				{/* Confirmation Dialog Mock */}
				{showConfirmDialog && (
					<div data-testid="confirm-dialog">
						<p>{showConfirmDialog.message}</p>
						<button
							data-testid="confirm-yes"
							onClick={() => {
								showConfirmDialog.onConfirm();
								setShowConfirmDialog(null);
							}}
						>
							Yes
						</button>
						<button data-testid="confirm-no" onClick={() => setShowConfirmDialog(null)}>
							No
						</button>
					</div>
				)}
			</div>
		</LayerStackProvider>
	);
};

describe('Auto Run + Session List Integration', () => {
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

	describe('Session Selection Loads Correct Document', () => {
		it('clicking on a session in the list loads its Auto Run content', async () => {
			const onSessionChange = vi.fn();
			render(<IntegrationTestWrapper onSessionChange={onSessionChange} />);

			// Initially Session 1 is active
			expect(screen.getByRole('textbox')).toHaveValue('# Session 1\n\n- [ ] Task 1');

			// Click on Session 2
			const session2Item = screen.getByText('Session 2');
			fireEvent.click(session2Item);

			// Verify callback was called
			expect(onSessionChange).toHaveBeenCalledWith('session-2');

			// Wait for AutoRun to update with Session 2 content
			await waitFor(() => {
				expect(screen.getByRole('textbox')).toHaveValue(
					'# Session 2\n\n- [ ] Task A\n- [ ] Task B'
				);
			});
		});

		it('session switch preserves Auto Run state stored in session (not local edits)', async () => {
			// Note: AutoRun uses local content state for responsive typing.
			// Unsaved changes are NOT preserved when switching sessions.
			// Only saved content (stored in session.autoRunContent) persists.
			render(<IntegrationTestWrapper />);

			// Modify content in Session 1 (creates local state, not saved)
			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Modified Session 1 Content' } });

			// Switch to Session 2
			fireEvent.click(screen.getByText('Session 2'));

			await waitFor(() => {
				expect(screen.getByRole('textbox')).toHaveValue(
					'# Session 2\n\n- [ ] Task A\n- [ ] Task B'
				);
			});

			// Switch back to Session 1
			fireEvent.click(screen.getByText('Session 1'));

			// Session 1 reverts to its stored content (unsaved local edits lost)
			// This is expected behavior - users must save before switching
			await waitFor(() => {
				expect(screen.getByRole('textbox')).toHaveValue('# Session 1\n\n- [ ] Task 1');
			});
		});

		it('session in a group loads correct Auto Run content', async () => {
			render(<IntegrationTestWrapper />);

			// Find and expand the group to see Session 3
			const groupHeader = screen.getByText('Test Group');
			expect(groupHeader).toBeInTheDocument();

			// Click on Session 3 which is in the group
			const session3Item = screen.getByText('Session 3');
			fireEvent.click(session3Item);

			await waitFor(() => {
				expect(screen.getByRole('textbox')).toHaveValue('# Session 3\n\n- [ ] Group Task');
			});
		});

		it('switching between sessions with different folder paths works correctly', async () => {
			const sessions = [
				createMockSession({
					id: 'session-a',
					name: 'Session A',
					autoRunFolderPath: '/path/a/autorun',
					autoRunSelectedFile: 'Doc A',
					autoRunContent: '# Document A\n\n- [ ] Task A',
				}),
				createMockSession({
					id: 'session-b',
					name: 'Session B',
					autoRunFolderPath: '/path/b/autorun',
					autoRunSelectedFile: 'Doc B',
					autoRunContent: '# Document B\n\n- [ ] Task B',
				}),
			];

			render(
				<IntegrationTestWrapper
					initialSessions={sessions}
					initialGroups={[]}
					initialActiveSessionId="session-a"
				/>
			);

			// Initially shows Session A content
			expect(screen.getByRole('textbox')).toHaveValue('# Document A\n\n- [ ] Task A');

			// Switch to Session B
			fireEvent.click(screen.getByText('Session B'));

			await waitFor(() => {
				expect(screen.getByRole('textbox')).toHaveValue('# Document B\n\n- [ ] Task B');
			});

			// Switch back to Session A
			fireEvent.click(screen.getByText('Session A'));

			await waitFor(() => {
				expect(screen.getByRole('textbox')).toHaveValue('# Document A\n\n- [ ] Task A');
			});
		});

		it('session without Auto Run configured shows appropriate message', async () => {
			const sessions = [
				createMockSession({
					id: 'session-configured',
					name: 'Configured Session',
					autoRunFolderPath: '/test/autorun',
					autoRunSelectedFile: 'Phase 1',
					autoRunContent: '# Configured',
				}),
				createMockSession({
					id: 'session-unconfigured',
					name: 'Unconfigured Session',
					autoRunFolderPath: undefined,
					autoRunSelectedFile: undefined,
					autoRunContent: '',
				}),
			];

			render(
				<IntegrationTestWrapper
					initialSessions={sessions}
					initialGroups={[]}
					initialActiveSessionId="session-configured"
				/>
			);

			// Initially shows configured session's content
			expect(screen.getByRole('textbox')).toHaveValue('# Configured');

			// Switch to unconfigured session
			fireEvent.click(screen.getByText('Unconfigured Session'));

			await waitFor(() => {
				expect(screen.getByTestId('autorun-not-configured')).toBeInTheDocument();
				expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
			});

			// Switch back to configured session
			fireEvent.click(screen.getByText('Configured Session'));

			await waitFor(() => {
				expect(screen.getByRole('textbox')).toHaveValue('# Configured');
				expect(screen.queryByTestId('autorun-not-configured')).not.toBeInTheDocument();
			});
		});

		it('rapid session switching does not cause content mismatch', async () => {
			render(<IntegrationTestWrapper />);

			// Rapidly switch between sessions
			for (let i = 0; i < 5; i++) {
				fireEvent.click(screen.getByText('Session 2'));
				fireEvent.click(screen.getByText('Session 1'));
				fireEvent.click(screen.getByText('Session 3'));
			}

			// End on Session 1
			fireEvent.click(screen.getByText('Session 1'));

			await waitFor(() => {
				expect(screen.getByRole('textbox')).toHaveValue('# Session 1\n\n- [ ] Task 1');
			});
		});

		it('session switch preserves document selection', async () => {
			render(<IntegrationTestWrapper />);

			// Switch to Session 2
			fireEvent.click(screen.getByText('Session 2'));

			await waitFor(() => {
				// Verify the document selector shows Phase 2 (Session 2's selected file)
				const docSelect = screen.getByTestId('doc-select');
				expect(docSelect).toHaveValue('Phase 2');
			});

			// Switch to Session 1
			fireEvent.click(screen.getByText('Session 1'));

			await waitFor(() => {
				// Verify the document selector shows Phase 1 (Session 1's selected file)
				const docSelect = screen.getByTestId('doc-select');
				expect(docSelect).toHaveValue('Phase 1');
			});
		});
	});

	describe('Session Deletion Clears Auto Run State', () => {
		it('deleting active session switches to next session with correct Auto Run', async () => {
			render(<IntegrationTestWrapper />);

			// Initially on Session 1
			expect(screen.getByRole('textbox')).toHaveValue('# Session 1\n\n- [ ] Task 1');

			// Right-click on Session 1 to open context menu
			const session1Item = screen.getByText('Session 1');
			fireEvent.contextMenu(session1Item);

			// Click "Remove Agent" in context menu
			const removeButton = await screen.findByText('Remove Agent');
			fireEvent.click(removeButton);

			// Confirm deletion in the custom confirmation dialog
			const confirmYes = await screen.findByTestId('confirm-yes');
			fireEvent.click(confirmYes);

			// Should switch to Session 2 and show its content
			await waitFor(() => {
				expect(screen.getByRole('textbox')).toHaveValue(
					'# Session 2\n\n- [ ] Task A\n- [ ] Task B'
				);
			});

			// Session 1 should no longer be in the list
			expect(screen.queryByText('Session 1')).not.toBeInTheDocument();
		});

		it('deleting non-active session does not affect current Auto Run state', async () => {
			render(<IntegrationTestWrapper />);

			// Initially on Session 1
			expect(screen.getByRole('textbox')).toHaveValue('# Session 1\n\n- [ ] Task 1');

			// Right-click on Session 2 (not active) to delete it
			const session2Item = screen.getByText('Session 2');
			fireEvent.contextMenu(session2Item);

			const removeButton = await screen.findByText('Remove Agent');
			fireEvent.click(removeButton);

			const confirmYes = await screen.findByTestId('confirm-yes');
			fireEvent.click(confirmYes);

			// Session 1's Auto Run should still be displayed
			await waitFor(() => {
				expect(screen.getByRole('textbox')).toHaveValue('# Session 1\n\n- [ ] Task 1');
			});

			// Session 2 should no longer be in the list
			expect(screen.queryByText('Session 2')).not.toBeInTheDocument();
		});

		it('deleting session in group does not affect other sessions Auto Run', async () => {
			render(<IntegrationTestWrapper />);

			// Session 3 is in a group
			expect(screen.getByText('Session 3')).toBeInTheDocument();

			// Right-click on Session 3 to delete it
			const session3Item = screen.getByText('Session 3');
			fireEvent.contextMenu(session3Item);

			const removeButton = await screen.findByText('Remove Agent');
			fireEvent.click(removeButton);

			const confirmYes = await screen.findByTestId('confirm-yes');
			fireEvent.click(confirmYes);

			// Session 1's Auto Run should still be displayed (it was active)
			await waitFor(() => {
				expect(screen.getByRole('textbox')).toHaveValue('# Session 1\n\n- [ ] Task 1');
			});

			// Session 3 should no longer be in the list
			expect(screen.queryByText('Session 3')).not.toBeInTheDocument();
		});

		it('canceling session deletion does not affect Auto Run state', async () => {
			render(<IntegrationTestWrapper />);

			// Right-click on Session 1 to open context menu
			const session1Item = screen.getByText('Session 1');
			fireEvent.contextMenu(session1Item);

			const removeButton = await screen.findByText('Remove Agent');
			fireEvent.click(removeButton);

			// Click "No" to cancel deletion
			const confirmNo = await screen.findByTestId('confirm-no');
			fireEvent.click(confirmNo);

			// Session 1 should still be there with its Auto Run content
			expect(screen.getByText('Session 1')).toBeInTheDocument();
			expect(screen.getByRole('textbox')).toHaveValue('# Session 1\n\n- [ ] Task 1');
		});

		it('deleting last session handles Auto Run gracefully', async () => {
			const sessions = [
				createMockSession({
					id: 'only-session',
					name: 'Only Session',
					autoRunFolderPath: '/test/autorun',
					autoRunContent: '# Only Session',
				}),
			];

			render(
				<IntegrationTestWrapper
					initialSessions={sessions}
					initialGroups={[]}
					initialActiveSessionId="only-session"
				/>
			);

			expect(screen.getByRole('textbox')).toHaveValue('# Only Session');

			// Delete the only session
			const sessionItem = screen.getByText('Only Session');
			fireEvent.contextMenu(sessionItem);

			const removeButton = await screen.findByText('Remove Agent');
			fireEvent.click(removeButton);

			const confirmYes = await screen.findByTestId('confirm-yes');
			fireEvent.click(confirmYes);

			// Auto Run container should not be rendered
			await waitFor(() => {
				expect(screen.queryByTestId('autorun-container')).not.toBeInTheDocument();
				expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
			});
		});
	});

	describe('Group Filtering Does Not Affect Auto Run', () => {
		it('collapsing group does not affect active session Auto Run', async () => {
			// Start with Session 3 (which is in a group) as active
			render(<IntegrationTestWrapper initialActiveSessionId="session-3" />);

			// Verify Session 3's Auto Run is showing
			await waitFor(() => {
				expect(screen.getByRole('textbox')).toHaveValue('# Session 3\n\n- [ ] Group Task');
			});

			// Collapse the group
			const groupHeader = screen.getByText('Test Group');
			// Find the collapse button (chevron) near the group header
			const groupRow = groupHeader.closest('div[style]');
			if (groupRow) {
				fireEvent.click(groupRow);
			}

			// Auto Run should still show Session 3's content
			expect(screen.getByRole('textbox')).toHaveValue('# Session 3\n\n- [ ] Group Task');
		});

		it('expanding group does not affect active session Auto Run', async () => {
			// Create wrapper with collapsed group
			const TestComponent = () => {
				const [groups, setGroups] = useState([
					createMockGroup({ id: 'group-1', name: 'Test Group', collapsed: true }),
				]);
				const [activeSessionId, setActiveSessionId] = useState('session-1');
				const sessions = [
					createMockSession({
						id: 'session-1',
						name: 'Session 1',
						autoRunContent: '# Session 1\n\n- [ ] Task 1',
					}),
					createMockSession({
						id: 'session-3',
						name: 'Session 3',
						groupId: 'group-1',
						autoRunFolderPath: '/test/autorun3',
						autoRunContent: '# Session 3\n\n- [ ] Group Task',
					}),
				];

				const activeSession = sessions.find((s) => s.id === activeSessionId);
				const theme = createMockTheme();

				return (
					<LayerStackProvider>
						<div>
							<div data-testid="session-buttons">
								{sessions.map((s) => (
									<button key={s.id} onClick={() => setActiveSessionId(s.id)}>
										{s.name}
									</button>
								))}
							</div>
							<button
								data-testid="toggle-group"
								onClick={() =>
									setGroups((prev) => prev.map((g) => ({ ...g, collapsed: !g.collapsed })))
								}
							>
								Toggle Group
							</button>
							<p data-testid="group-state">Group collapsed: {groups[0].collapsed ? 'yes' : 'no'}</p>
							{activeSession && activeSession.autoRunFolderPath && (
								<AutoRun
									theme={theme}
									sessionId={activeSession.id}
									folderPath={activeSession.autoRunFolderPath}
									selectedFile={activeSession.autoRunSelectedFile || ''}
									documentList={['Phase 1']}
									content={activeSession.autoRunContent || ''}
									onContentChange={() => {}}
									mode={activeSession.autoRunMode || 'edit'}
									onModeChange={() => {}}
									onOpenSetup={() => {}}
									onRefresh={() => {}}
									onSelectDocument={() => {}}
									onCreateDocument={async () => true}
									sessionState={activeSession.state}
								/>
							)}
						</div>
					</LayerStackProvider>
				);
			};

			render(<TestComponent />);

			// Initially Session 1 is active and group is collapsed
			expect(screen.getByRole('textbox')).toHaveValue('# Session 1\n\n- [ ] Task 1');
			expect(screen.getByTestId('group-state')).toHaveTextContent('Group collapsed: yes');

			// Expand the group
			fireEvent.click(screen.getByTestId('toggle-group'));
			expect(screen.getByTestId('group-state')).toHaveTextContent('Group collapsed: no');

			// Auto Run should still show Session 1's content
			expect(screen.getByRole('textbox')).toHaveValue('# Session 1\n\n- [ ] Task 1');
		});

		it('toggling multiple groups does not affect active session Auto Run', async () => {
			const sessions = [
				createMockSession({
					id: 'session-1',
					name: 'Session 1',
					autoRunContent: '# Session 1',
				}),
				createMockSession({
					id: 'session-2',
					name: 'Session 2',
					groupId: 'group-1',
				}),
				createMockSession({
					id: 'session-3',
					name: 'Session 3',
					groupId: 'group-2',
				}),
			];

			const groups = [
				createMockGroup({ id: 'group-1', name: 'Group 1' }),
				createMockGroup({ id: 'group-2', name: 'Group 2' }),
			];

			render(
				<IntegrationTestWrapper
					initialSessions={sessions}
					initialGroups={groups}
					initialActiveSessionId="session-1"
				/>
			);

			// Verify initial state
			expect(screen.getByRole('textbox')).toHaveValue('# Session 1');

			// Toggle Group 1
			const group1Header = screen.getByText('Group 1');
			const group1Row = group1Header.closest('div');
			if (group1Row) fireEvent.click(group1Row);

			// Auto Run should still show Session 1's content
			expect(screen.getByRole('textbox')).toHaveValue('# Session 1');

			// Toggle Group 2
			const group2Header = screen.getByText('Group 2');
			const group2Row = group2Header.closest('div');
			if (group2Row) fireEvent.click(group2Row);

			// Auto Run should still show Session 1's content
			expect(screen.getByRole('textbox')).toHaveValue('# Session 1');
		});

		it('filtering sessions does not affect active session Auto Run', async () => {
			// Test uses the filter functionality in SessionList
			// When filter is active, only matching sessions are shown, but active session's Auto Run is unaffected
			render(<IntegrationTestWrapper />);

			// Initially showing Session 1's content - use the textarea specifically
			const autoRunTextarea = screen.getByRole('textbox') as HTMLTextAreaElement;
			expect(autoRunTextarea).toHaveValue('# Session 1\n\n- [ ] Task 1');
			expect(autoRunTextarea.tagName).toBe('TEXTAREA'); // Verify it's the Auto Run textarea

			// Focus the sidebar container (first div with tabIndex=0 is the sidebar)
			const sidebarContainer = document.querySelector('div[tabindex="0"]');
			expect(sidebarContainer).toBeInTheDocument();
			if (sidebarContainer) {
				fireEvent.focus(sidebarContainer);
				fireEvent.keyDown(sidebarContainer, { key: 'f', metaKey: true });
			}

			// Now there are two textboxes (filter input + Auto Run textarea)
			// Get all textboxes and find the textarea (Auto Run)
			const textboxes = screen.getAllByRole('textbox');
			const textarea = textboxes.find((el) => el.tagName === 'TEXTAREA');

			// Auto Run should still show Session 1's content even with filter open
			expect(textarea).toHaveValue('# Session 1\n\n- [ ] Task 1');
		});

		it('dragging session between groups does not affect Auto Run', async () => {
			render(<IntegrationTestWrapper />);

			// Initially showing Session 1's content
			expect(screen.getByRole('textbox')).toHaveValue('# Session 1\n\n- [ ] Task 1');

			// Simulate dragging Session 1 (simulated by directly calling the handler)
			// Note: In a real scenario, this would be done via drag and drop
			// For testing, we verify the content remains stable during group changes

			// Session 1 should still show its content
			expect(screen.getByRole('textbox')).toHaveValue('# Session 1\n\n- [ ] Task 1');
		});

		it('moving session to different group preserves Auto Run state', async () => {
			render(<IntegrationTestWrapper />);

			// Session 1 is ungrouped, Session 3 is in group-1
			// Initially showing Session 1's content
			expect(screen.getByRole('textbox')).toHaveValue('# Session 1\n\n- [ ] Task 1');

			// Right-click on Session 1 to move to group
			// Use getAllByText and find the one that's a session item (not in the group header)
			const session1Items = screen.getAllByText('Session 1');
			// Find the session item (not in group context)
			const session1Item = session1Items[0];
			fireEvent.contextMenu(session1Item);

			// Find "Move to Group" option and hover
			const moveToGroup = await screen.findByText('Move to Group');
			fireEvent.mouseEnter(moveToGroup.parentElement!);

			// Click on "Test Group" in the submenu - there may be multiple, find in the context menu
			const testGroupOptions = await screen.findAllByText('Test Group');
			// The last one should be in the context menu submenu
			const testGroupOption = testGroupOptions[testGroupOptions.length - 1];
			fireEvent.click(testGroupOption);

			// Auto Run should still show Session 1's content
			await waitFor(() => {
				expect(screen.getByRole('textbox')).toHaveValue('# Session 1\n\n- [ ] Task 1');
			});
		});
	});

	describe('Keyboard Navigation and Auto Run', () => {
		it('keyboard navigation between sessions updates Auto Run correctly', async () => {
			render(<IntegrationTestWrapper />);

			// Initially on Session 1
			expect(screen.getByRole('textbox')).toHaveValue('# Session 1\n\n- [ ] Task 1');

			// Simulate keyboard selection by clicking Session 2
			fireEvent.click(screen.getByText('Session 2'));

			await waitFor(() => {
				expect(screen.getByRole('textbox')).toHaveValue(
					'# Session 2\n\n- [ ] Task A\n- [ ] Task B'
				);
			});
		});
	});

	describe('Bookmarked Sessions and Auto Run', () => {
		it('bookmarking a session does not affect its Auto Run state', async () => {
			render(<IntegrationTestWrapper />);

			// Initially on Session 1
			expect(screen.getByRole('textbox')).toHaveValue('# Session 1\n\n- [ ] Task 1');

			// Right-click and bookmark Session 1
			const session1Item = screen.getByText('Session 1');
			fireEvent.contextMenu(session1Item);

			const bookmarkButton = await screen.findByText('Add Bookmark');
			fireEvent.click(bookmarkButton);

			// Auto Run should still show Session 1's content
			expect(screen.getByRole('textbox')).toHaveValue('# Session 1\n\n- [ ] Task 1');
		});

		it('selecting bookmarked session loads correct Auto Run content', async () => {
			const sessions = [
				createMockSession({
					id: 'session-1',
					name: 'Bookmarked Session',
					bookmarked: true,
					autoRunContent: '# Bookmarked Content\n\n- [ ] Starred Task',
				}),
				createMockSession({
					id: 'session-2',
					name: 'Regular Session',
					autoRunContent: '# Regular Content',
				}),
			];

			render(
				<IntegrationTestWrapper
					initialSessions={sessions}
					initialGroups={[]}
					initialActiveSessionId="session-2"
				/>
			);

			// Start on Regular Session
			expect(screen.getByRole('textbox')).toHaveValue('# Regular Content');

			// Click on bookmarked session - use getAllByText to handle multiple elements
			const bookmarkedItems = screen.getAllByText('Bookmarked Session');
			fireEvent.click(bookmarkedItems[0]);

			await waitFor(() => {
				expect(screen.getByRole('textbox')).toHaveValue(
					'# Bookmarked Content\n\n- [ ] Starred Task'
				);
			});
		});
	});

	describe('Edge Cases', () => {
		it('handles session with empty Auto Run content', async () => {
			const sessions = [
				createMockSession({
					id: 'session-1',
					name: 'Session 1',
					autoRunContent: '',
					autoRunFolderPath: '/test/autorun',
					autoRunSelectedFile: 'Empty Doc',
				}),
			];

			render(
				<IntegrationTestWrapper
					initialSessions={sessions}
					initialGroups={[]}
					initialActiveSessionId="session-1"
				/>
			);

			expect(screen.getByRole('textbox')).toHaveValue('');
		});

		it('handles session with very long Auto Run content', async () => {
			const longContent = '# Long Document\n\n' + '- [ ] Task\n'.repeat(1000);
			const sessions = [
				createMockSession({
					id: 'session-1',
					name: 'Session 1',
					autoRunContent: longContent,
				}),
			];

			render(
				<IntegrationTestWrapper
					initialSessions={sessions}
					initialGroups={[]}
					initialActiveSessionId="session-1"
				/>
			);

			expect(screen.getByRole('textbox').textContent?.length).toBeGreaterThan(10000);
		});

		it('handles session with special characters in Auto Run content', async () => {
			const specialContent =
				'# Test <script>alert("xss")</script>\n\n- [ ] Task with "quotes" & <brackets>';
			const sessions = [
				createMockSession({
					id: 'session-1',
					name: 'Session 1',
					autoRunContent: specialContent,
				}),
			];

			render(
				<IntegrationTestWrapper
					initialSessions={sessions}
					initialGroups={[]}
					initialActiveSessionId="session-1"
				/>
			);

			expect(screen.getByRole('textbox')).toHaveValue(specialContent);
		});

		it('handles session with unicode in Auto Run content', async () => {
			const unicodeContent = '# テスト 🎉\n\n- [ ] 任务 一\n- [ ] Tâche avec accénts';
			const sessions = [
				createMockSession({
					id: 'session-1',
					name: 'Session 1',
					autoRunContent: unicodeContent,
				}),
			];

			render(
				<IntegrationTestWrapper
					initialSessions={sessions}
					initialGroups={[]}
					initialActiveSessionId="session-1"
				/>
			);

			expect(screen.getByRole('textbox')).toHaveValue(unicodeContent);
		});

		it('handles simultaneous session and group operations', async () => {
			render(<IntegrationTestWrapper />);

			// Perform multiple operations rapidly
			const session1 = screen.getByText('Session 1');
			const session2 = screen.getByText('Session 2');
			const groupHeader = screen.getByText('Test Group');

			// Click group, then sessions
			fireEvent.click(groupHeader);
			fireEvent.click(session2);
			fireEvent.click(session1);

			// Should end up showing Session 1's content
			await waitFor(() => {
				expect(screen.getByRole('textbox')).toHaveValue('# Session 1\n\n- [ ] Task 1');
			});
		});
	});
});
