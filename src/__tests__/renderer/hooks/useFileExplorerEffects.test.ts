/**
 * @file useFileExplorerEffects.test.ts
 * @description Unit tests for the useFileExplorerEffects hook (Phase 2.6)
 *
 * Tests cover:
 * - stableFileTree memo (empty array stability, reference identity)
 * - handleMainPanelFileClick (file open, external open, SSH, errors)
 * - Scroll restore effect on session switch
 * - Flat file list computation effect
 * - Pending jump path effect
 * - Scroll to selected file effect
 * - Keyboard navigation effect
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { useFileExplorerStore } from '../../../renderer/stores/fileExplorerStore';
import type { Session } from '../../../renderer/types';
import type { FileNode } from '../../../renderer/types/fileTree';
import type { UseFileExplorerEffectsDeps } from '../../../renderer/hooks/git/useFileExplorerEffects';

// --- Mocks ---

// Mock prompts (required by settingsStore)
vi.mock('../../../prompts', () => ({
	commitCommandPrompt: 'mock-commit-prompt',
	autorunSynopsisPrompt: 'mock-autorun-synopsis-prompt',
}));

// Mock LayerStack context
const mockHasOpenModal = vi.fn().mockReturnValue(false);
vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		hasOpenLayers: vi.fn().mockReturnValue(false),
		hasOpenModal: mockHasOpenModal,
		registerLayer: vi.fn(),
		unregisterLayer: vi.fn(),
	}),
}));

// Mock fileExplorer utils
vi.mock('../../../renderer/utils/fileExplorer', () => ({
	shouldOpenExternally: vi.fn().mockReturnValue(false),
	flattenTree: vi.fn().mockReturnValue([]),
}));

// --- Test Helpers ---

const createMockSession = (overrides: Partial<Session> = {}): Session =>
	({
		id: 'session-1',
		name: 'Test Session',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/test/project',
		fullPath: '/test/project',
		projectRoot: '/test/project',
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		isLive: false,
		changedFiles: [],
		isGitRepo: false,
		fileTree: [],
		fileExplorerExpanded: ['src'],
		fileExplorerScrollPos: 0,
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [],
		activeTabId: 'tab-1',
		closedTabHistory: [],
		...overrides,
	}) as Session;

const createDeps = (
	overrides: Partial<UseFileExplorerEffectsDeps> = {}
): UseFileExplorerEffectsDeps => ({
	sessionsRef: { current: [] },
	activeSessionIdRef: { current: 'session-1' },
	fileTreeContainerRef: { current: null },
	fileTreeKeyboardNavRef: { current: false },
	filteredFileTree: [],
	tabCompletionOpen: false,
	toggleFolder: vi.fn(),
	handleFileClick: vi.fn(),
	handleOpenFileTab: vi.fn(),
	...overrides,
});

// --- Setup ---

beforeEach(() => {
	vi.clearAllMocks();
	mockHasOpenModal.mockReturnValue(false);

	// Reset stores to default
	useSessionStore.setState({
		sessions: [],
		activeSessionId: null,
	});
	useUIStore.setState({
		activeFocus: 'main',
		activeRightTab: 'files',
	});
	useFileExplorerStore.setState({
		selectedFileIndex: 0,
		flatFileList: [],
	});

	// Setup window.maestro
	(window as any).maestro = {
		...(window as any).maestro,
		shell: { openExternal: vi.fn(), openPath: vi.fn() },
		fs: {
			readFile: vi.fn().mockResolvedValue('file content'),
			stat: vi.fn().mockResolvedValue({ modifiedAt: '2024-01-01T00:00:00Z' }),
		},
		settings: {
			get: vi.fn().mockResolvedValue(undefined),
			set: vi.fn().mockResolvedValue(undefined),
			getAll: vi.fn().mockResolvedValue({}),
		},
	};
});

// ============================================================================
// Tests
// ============================================================================

describe('useFileExplorerEffects', () => {
	// Dynamically import to avoid hoisting issues with mocks
	const loadHook = async () => {
		const mod = await import('../../../renderer/hooks/git/useFileExplorerEffects');
		return mod.useFileExplorerEffects;
	};

	// ====================================================================
	// stableFileTree
	// ====================================================================

	describe('stableFileTree', () => {
		it('returns empty array when active session has no file tree', async () => {
			const useFileExplorerEffects = await loadHook();
			const session = createMockSession({ fileTree: undefined as any });
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const deps = createDeps();
			const { result } = renderHook(() => useFileExplorerEffects(deps));

			expect(result.current.stableFileTree).toEqual([]);
		});

		it('returns the file tree when active session has one', async () => {
			const useFileExplorerEffects = await loadHook();
			const tree: FileNode[] = [{ name: 'src', type: 'folder', children: [] }];
			const session = createMockSession({ fileTree: tree });
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const deps = createDeps();
			const { result } = renderHook(() => useFileExplorerEffects(deps));

			expect(result.current.stableFileTree).toBe(tree);
		});

		it('returns stable reference when tree has not changed', async () => {
			const useFileExplorerEffects = await loadHook();
			const tree: FileNode[] = [{ name: 'src', type: 'folder', children: [] }];
			const session = createMockSession({ fileTree: tree });
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const deps = createDeps();
			const { result, rerender } = renderHook(() => useFileExplorerEffects(deps));

			const ref1 = result.current.stableFileTree;
			rerender();
			const ref2 = result.current.stableFileTree;

			expect(ref1).toBe(ref2);
		});
	});

	// ====================================================================
	// handleMainPanelFileClick
	// ====================================================================

	describe('handleMainPanelFileClick', () => {
		it('opens file by reading content and calling handleOpenFileTab', async () => {
			const useFileExplorerEffects = await loadHook();
			const session = createMockSession();
			const sessionsRef = { current: [session] };

			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const handleOpenFileTab = vi.fn();
			const deps = createDeps({
				sessionsRef,
				activeSessionIdRef: { current: 'session-1' },
				handleOpenFileTab,
			});

			const { result } = renderHook(() => useFileExplorerEffects(deps));

			await act(async () => {
				await result.current.handleMainPanelFileClick('src/index.ts');
			});

			expect(window.maestro.fs.readFile).toHaveBeenCalledWith(
				'/test/project/src/index.ts',
				undefined
			);
			expect(handleOpenFileTab).toHaveBeenCalledWith(
				expect.objectContaining({
					path: '/test/project/src/index.ts',
					name: 'index.ts',
					content: 'file content',
				}),
				{ openInNewTab: false }
			);
		});

		it('does nothing when session is not found', async () => {
			const useFileExplorerEffects = await loadHook();
			useSessionStore.setState({
				sessions: [],
				activeSessionId: null,
			});

			const handleOpenFileTab = vi.fn();
			const deps = createDeps({
				sessionsRef: { current: [] },
				activeSessionIdRef: { current: 'nonexistent' },
				handleOpenFileTab,
			});

			const { result } = renderHook(() => useFileExplorerEffects(deps));

			await act(async () => {
				await result.current.handleMainPanelFileClick('src/index.ts');
			});

			expect(handleOpenFileTab).not.toHaveBeenCalled();
		});

		it('opens externally for PDF files', async () => {
			const useFileExplorerEffects = await loadHook();
			const { shouldOpenExternally } = await import('../../../renderer/utils/fileExplorer');
			vi.mocked(shouldOpenExternally).mockReturnValue(true);

			const session = createMockSession();
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const handleOpenFileTab = vi.fn();
			const deps = createDeps({
				sessionsRef: { current: [session] },
				activeSessionIdRef: { current: 'session-1' },
				handleOpenFileTab,
			});

			const { result } = renderHook(() => useFileExplorerEffects(deps));

			await act(async () => {
				await result.current.handleMainPanelFileClick('docs/manual.pdf');
			});

			expect(window.maestro.shell.openPath).toHaveBeenCalledWith('/test/project/docs/manual.pdf');
			expect(handleOpenFileTab).not.toHaveBeenCalled();
		});

		it('passes openInNewTab option through', async () => {
			const useFileExplorerEffects = await loadHook();
			const { shouldOpenExternally } = await import('../../../renderer/utils/fileExplorer');
			vi.mocked(shouldOpenExternally).mockReturnValue(false);

			const session = createMockSession();
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const handleOpenFileTab = vi.fn();
			const deps = createDeps({
				sessionsRef: { current: [session] },
				activeSessionIdRef: { current: 'session-1' },
				handleOpenFileTab,
			});

			const { result } = renderHook(() => useFileExplorerEffects(deps));

			await act(async () => {
				await result.current.handleMainPanelFileClick('src/index.ts', { openInNewTab: true });
			});

			expect(handleOpenFileTab).toHaveBeenCalledWith(expect.anything(), { openInNewTab: true });
		});

		it('handles file read errors gracefully', async () => {
			const useFileExplorerEffects = await loadHook();
			const { shouldOpenExternally } = await import('../../../renderer/utils/fileExplorer');
			vi.mocked(shouldOpenExternally).mockReturnValue(false);

			(window.maestro.fs.readFile as ReturnType<typeof vi.fn>).mockRejectedValue(
				new Error('ENOENT')
			);

			const session = createMockSession();
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const handleOpenFileTab = vi.fn();
			const deps = createDeps({
				sessionsRef: { current: [session] },
				activeSessionIdRef: { current: 'session-1' },
				handleOpenFileTab,
			});

			const { result } = renderHook(() => useFileExplorerEffects(deps));

			// Should not throw
			await act(async () => {
				await result.current.handleMainPanelFileClick('nonexistent.txt');
			});

			expect(handleOpenFileTab).not.toHaveBeenCalled();
		});
	});

	// ====================================================================
	// Scroll restore effect
	// ====================================================================

	describe('scroll restore effect', () => {
		it('restores scroll position on session switch', async () => {
			const useFileExplorerEffects = await loadHook();

			const mockDiv = { scrollTop: 0 } as HTMLDivElement;
			const session = createMockSession({ fileExplorerScrollPos: 150 });
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const deps = createDeps({
				fileTreeContainerRef: { current: mockDiv },
			});

			renderHook(() => useFileExplorerEffects(deps));

			expect(mockDiv.scrollTop).toBe(150);
		});

		it('does not set scroll when fileTreeContainerRef is null', async () => {
			const useFileExplorerEffects = await loadHook();

			const session = createMockSession({ fileExplorerScrollPos: 150 });
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const deps = createDeps({
				fileTreeContainerRef: { current: null },
			});

			// Should not throw
			renderHook(() => useFileExplorerEffects(deps));
		});
	});

	// ====================================================================
	// Flat file list computation effect
	// ====================================================================

	describe('flat file list computation', () => {
		it('calls flattenTree with filtered tree and expanded set', async () => {
			const useFileExplorerEffects = await loadHook();
			const { flattenTree } = await import('../../../renderer/utils/fileExplorer');

			const tree: FileNode[] = [
				{ name: 'src', type: 'folder', children: [{ name: 'index.ts', type: 'file' }] },
			];
			const flatResult = [
				{ name: 'src', fullPath: 'src', isFolder: true, type: 'folder' as const },
				{ name: 'index.ts', fullPath: 'src/index.ts', isFolder: false, type: 'file' as const },
			];
			vi.mocked(flattenTree).mockReturnValue(flatResult);

			const session = createMockSession({
				fileExplorerExpanded: ['src'],
				fileTree: tree,
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const deps = createDeps({ filteredFileTree: tree });

			renderHook(() => useFileExplorerEffects(deps));

			expect(flattenTree).toHaveBeenCalledWith(tree, new Set(['src']));
			expect(useFileExplorerStore.getState().flatFileList).toEqual(flatResult);
		});

		it('clears flat list when no active session', async () => {
			const useFileExplorerEffects = await loadHook();

			useSessionStore.setState({
				sessions: [],
				activeSessionId: null,
			});

			const deps = createDeps();
			renderHook(() => useFileExplorerEffects(deps));

			expect(useFileExplorerStore.getState().flatFileList).toEqual([]);
		});

		it('filters hidden files when showHiddenFiles is false', async () => {
			const useFileExplorerEffects = await loadHook();
			const { flattenTree } = await import('../../../renderer/utils/fileExplorer');
			vi.mocked(flattenTree).mockReturnValue([]);

			useSettingsStore.setState({ showHiddenFiles: false } as any);

			const tree: FileNode[] = [
				{ name: '.hidden', type: 'folder', children: [] },
				{ name: 'visible', type: 'folder', children: [] },
			];

			const session = createMockSession({
				fileExplorerExpanded: ['visible'],
				fileTree: tree,
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const deps = createDeps({ filteredFileTree: tree });
			renderHook(() => useFileExplorerEffects(deps));

			// flattenTree should be called with filtered tree (no .hidden)
			const calledTree = vi.mocked(flattenTree).mock.calls[0]?.[0];
			expect(calledTree).toBeDefined();
			expect(calledTree?.some((n: any) => n.name === '.hidden')).toBe(false);
			expect(calledTree?.some((n: any) => n.name === 'visible')).toBe(true);
		});
	});

	// ====================================================================
	// Pending jump path effect
	// ====================================================================

	describe('pending jump path effect', () => {
		it('selects folder when pendingJumpPath is set', async () => {
			const useFileExplorerEffects = await loadHook();
			const { flattenTree } = await import('../../../renderer/utils/fileExplorer');

			// Mock flattenTree to return our desired flat list so the computation effect
			// populates the store correctly (instead of overwriting with [])
			const flatList = [
				{ name: 'src', fullPath: 'src', isFolder: true, type: 'folder' as const },
				{ name: 'index.ts', fullPath: 'src/index.ts', isFolder: false, type: 'file' as const },
			];
			vi.mocked(flattenTree).mockReturnValue(flatList);

			const tree: FileNode[] = [{ name: 'src', type: 'folder', children: [] }];
			const session = createMockSession({
				pendingJumpPath: 'src',
				fileTree: tree,
				fileExplorerExpanded: ['src'],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const deps = createDeps({
				filteredFileTree: tree,
			});

			renderHook(() => useFileExplorerEffects(deps));

			// The jump effect selects the target folder index
			expect(useFileExplorerStore.getState().selectedFileIndex).toBe(0);
		});

		it('selects first item when pendingJumpPath is empty string (root)', async () => {
			const useFileExplorerEffects = await loadHook();
			const { flattenTree } = await import('../../../renderer/utils/fileExplorer');

			const flatList = [{ name: 'src', fullPath: 'src', isFolder: true, type: 'folder' as const }];
			vi.mocked(flattenTree).mockReturnValue(flatList);

			const tree: FileNode[] = [{ name: 'src', type: 'folder', children: [] }];
			const session = createMockSession({
				pendingJumpPath: '',
				fileTree: tree,
				fileExplorerExpanded: ['src'],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const deps = createDeps({ filteredFileTree: tree });
			renderHook(() => useFileExplorerEffects(deps));

			expect(useFileExplorerStore.getState().selectedFileIndex).toBe(0);
		});

		it('clears pendingJumpPath after processing', async () => {
			const useFileExplorerEffects = await loadHook();
			const { flattenTree } = await import('../../../renderer/utils/fileExplorer');

			const flatList = [{ name: 'src', fullPath: 'src', isFolder: true, type: 'folder' as const }];
			vi.mocked(flattenTree).mockReturnValue(flatList);

			const tree: FileNode[] = [{ name: 'src', type: 'folder', children: [] }];
			const session = createMockSession({
				pendingJumpPath: 'src',
				fileTree: tree,
				fileExplorerExpanded: ['src'],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const deps = createDeps({ filteredFileTree: tree });
			renderHook(() => useFileExplorerEffects(deps));

			// The effect should have cleared pendingJumpPath
			const updatedSession = useSessionStore.getState().sessions[0];
			expect(updatedSession?.pendingJumpPath).toBeUndefined();
		});
	});

	// ====================================================================
	// Keyboard navigation effect
	// ====================================================================

	describe('keyboard navigation', () => {
		it('handles ArrowDown to move selection', async () => {
			const useFileExplorerEffects = await loadHook();
			useUIStore.setState({ activeFocus: 'right', activeRightTab: 'files' });

			const session = createMockSession();
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const deps = createDeps();
			const { rerender } = renderHook(() => useFileExplorerEffects(deps));

			// Set flat file list AFTER initial render so the computation effect doesn't overwrite
			const flatList = [
				{ name: 'src', fullPath: 'src', isFolder: true, type: 'folder' as const },
				{ name: 'lib', fullPath: 'lib', isFolder: true, type: 'folder' as const },
			];
			act(() => {
				useFileExplorerStore.setState({ flatFileList: flatList, selectedFileIndex: 0 });
			});
			rerender();

			act(() => {
				const event = new KeyboardEvent('keydown', { key: 'ArrowDown' });
				window.dispatchEvent(event);
			});

			expect(useFileExplorerStore.getState().selectedFileIndex).toBe(1);
		});

		it('handles ArrowUp to move selection', async () => {
			const useFileExplorerEffects = await loadHook();
			useUIStore.setState({ activeFocus: 'right', activeRightTab: 'files' });

			const session = createMockSession();
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const deps = createDeps();
			const { rerender } = renderHook(() => useFileExplorerEffects(deps));

			const flatList = [
				{ name: 'src', fullPath: 'src', isFolder: true, type: 'folder' as const },
				{ name: 'lib', fullPath: 'lib', isFolder: true, type: 'folder' as const },
			];
			act(() => {
				useFileExplorerStore.setState({ flatFileList: flatList, selectedFileIndex: 1 });
			});
			rerender();

			act(() => {
				const event = new KeyboardEvent('keydown', { key: 'ArrowUp' });
				window.dispatchEvent(event);
			});

			expect(useFileExplorerStore.getState().selectedFileIndex).toBe(0);
		});

		it('ignores keys when focus is not on right panel', async () => {
			const useFileExplorerEffects = await loadHook();

			const flatList = [
				{ name: 'src', fullPath: 'src', isFolder: true, type: 'folder' as const },
				{ name: 'lib', fullPath: 'lib', isFolder: true, type: 'folder' as const },
			];
			useFileExplorerStore.setState({ flatFileList: flatList, selectedFileIndex: 0 });
			useUIStore.setState({ activeFocus: 'main', activeRightTab: 'files' });

			const session = createMockSession();
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const deps = createDeps();
			renderHook(() => useFileExplorerEffects(deps));

			act(() => {
				const event = new KeyboardEvent('keydown', { key: 'ArrowDown' });
				window.dispatchEvent(event);
			});

			expect(useFileExplorerStore.getState().selectedFileIndex).toBe(0);
		});

		it('ignores keys when modal is open', async () => {
			const useFileExplorerEffects = await loadHook();
			mockHasOpenModal.mockReturnValue(true);

			const flatList = [
				{ name: 'src', fullPath: 'src', isFolder: true, type: 'folder' as const },
				{ name: 'lib', fullPath: 'lib', isFolder: true, type: 'folder' as const },
			];
			useFileExplorerStore.setState({ flatFileList: flatList, selectedFileIndex: 0 });
			useUIStore.setState({ activeFocus: 'right', activeRightTab: 'files' });

			const session = createMockSession();
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const deps = createDeps();
			renderHook(() => useFileExplorerEffects(deps));

			act(() => {
				const event = new KeyboardEvent('keydown', { key: 'ArrowDown' });
				window.dispatchEvent(event);
			});

			expect(useFileExplorerStore.getState().selectedFileIndex).toBe(0);
		});

		it('Enter on file calls handleFileClick', async () => {
			const useFileExplorerEffects = await loadHook();
			useUIStore.setState({ activeFocus: 'right', activeRightTab: 'files' });

			const session = createMockSession();
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const handleFileClick = vi.fn();
			const deps = createDeps({ handleFileClick });
			const { rerender } = renderHook(() => useFileExplorerEffects(deps));

			// Set flat file list AFTER initial render so the computation effect doesn't overwrite it
			const flatList = [
				{ name: 'index.ts', fullPath: 'src/index.ts', isFolder: false, type: 'file' as const },
			];
			act(() => {
				useFileExplorerStore.setState({ flatFileList: flatList, selectedFileIndex: 0 });
			});
			rerender();

			act(() => {
				const event = new KeyboardEvent('keydown', { key: 'Enter' });
				window.dispatchEvent(event);
			});

			expect(handleFileClick).toHaveBeenCalledWith(flatList[0], 'src/index.ts');
		});

		it('Enter on folder calls toggleFolder', async () => {
			const useFileExplorerEffects = await loadHook();
			useUIStore.setState({ activeFocus: 'right', activeRightTab: 'files' });

			const session = createMockSession();
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const toggleFolder = vi.fn();
			const deps = createDeps({ toggleFolder });
			const { rerender } = renderHook(() => useFileExplorerEffects(deps));

			const flatList = [{ name: 'src', fullPath: 'src', isFolder: true, type: 'folder' as const }];
			act(() => {
				useFileExplorerStore.setState({ flatFileList: flatList, selectedFileIndex: 0 });
			});
			rerender();

			act(() => {
				const event = new KeyboardEvent('keydown', { key: 'Enter' });
				window.dispatchEvent(event);
			});

			expect(toggleFolder).toHaveBeenCalledWith('src', 'session-1', expect.any(Function));
		});

		it('Cmd+ArrowDown jumps to last item', async () => {
			const useFileExplorerEffects = await loadHook();
			useUIStore.setState({ activeFocus: 'right', activeRightTab: 'files' });

			const session = createMockSession();
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const deps = createDeps();
			const { rerender } = renderHook(() => useFileExplorerEffects(deps));

			const flatList = [
				{ name: 'a', fullPath: 'a', isFolder: false, type: 'file' as const },
				{ name: 'b', fullPath: 'b', isFolder: false, type: 'file' as const },
				{ name: 'c', fullPath: 'c', isFolder: false, type: 'file' as const },
			];
			act(() => {
				useFileExplorerStore.setState({ flatFileList: flatList, selectedFileIndex: 0 });
			});
			rerender();

			act(() => {
				const event = new KeyboardEvent('keydown', { key: 'ArrowDown', metaKey: true });
				window.dispatchEvent(event);
			});

			expect(useFileExplorerStore.getState().selectedFileIndex).toBe(2);
		});
	});

	// ====================================================================
	// handleMainPanelFileClick — additional coverage
	// ====================================================================

	describe('handleMainPanelFileClick — additional coverage', () => {
		it('passes SSH remote ID to readFile and handleOpenFileTab', async () => {
			const useFileExplorerEffects = await loadHook();
			const { shouldOpenExternally } = await import('../../../renderer/utils/fileExplorer');
			vi.mocked(shouldOpenExternally).mockReturnValue(false);

			const session = createMockSession({
				sshRemoteId: 'ssh-remote-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const handleOpenFileTab = vi.fn();
			const deps = createDeps({
				sessionsRef: { current: [session] },
				activeSessionIdRef: { current: 'session-1' },
				handleOpenFileTab,
			});

			const { result } = renderHook(() => useFileExplorerEffects(deps));

			await act(async () => {
				await result.current.handleMainPanelFileClick('src/index.ts');
			});

			expect((window as any).maestro.fs.readFile).toHaveBeenCalledWith(
				'/test/project/src/index.ts',
				'ssh-remote-1'
			);
			expect(handleOpenFileTab).toHaveBeenCalledWith(
				expect.objectContaining({
					sshRemoteId: 'ssh-remote-1',
				}),
				expect.anything()
			);
		});

		it('reads SSH remote ID from sessionSshRemoteConfig when sshRemoteId is not set', async () => {
			const useFileExplorerEffects = await loadHook();
			const { shouldOpenExternally } = await import('../../../renderer/utils/fileExplorer');
			vi.mocked(shouldOpenExternally).mockReturnValue(false);

			const session = createMockSession({
				sessionSshRemoteConfig: { enabled: true, remoteId: 'config-remote-1' },
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const handleOpenFileTab = vi.fn();
			const deps = createDeps({
				sessionsRef: { current: [session] },
				activeSessionIdRef: { current: 'session-1' },
				handleOpenFileTab,
			});

			const { result } = renderHook(() => useFileExplorerEffects(deps));

			await act(async () => {
				await result.current.handleMainPanelFileClick('src/index.ts');
			});

			expect((window as any).maestro.fs.readFile).toHaveBeenCalledWith(
				'/test/project/src/index.ts',
				'config-remote-1'
			);
		});

		it('skips external open for SSH sessions even if shouldOpenExternally returns true', async () => {
			const useFileExplorerEffects = await loadHook();
			const { shouldOpenExternally } = await import('../../../renderer/utils/fileExplorer');
			vi.mocked(shouldOpenExternally).mockReturnValue(true);

			const session = createMockSession({
				sshRemoteId: 'ssh-remote-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const handleOpenFileTab = vi.fn();
			const deps = createDeps({
				sessionsRef: { current: [session] },
				activeSessionIdRef: { current: 'session-1' },
				handleOpenFileTab,
			});

			const { result } = renderHook(() => useFileExplorerEffects(deps));

			await act(async () => {
				await result.current.handleMainPanelFileClick('docs/manual.pdf');
			});

			// Should NOT open externally — SSH files are read via the remote
			expect((window as any).maestro.shell.openExternal).not.toHaveBeenCalled();
			// Should read file and open in tab instead
			expect(handleOpenFileTab).toHaveBeenCalled();
		});

		it('sets activeFocus to main after opening file', async () => {
			const useFileExplorerEffects = await loadHook();
			const { shouldOpenExternally } = await import('../../../renderer/utils/fileExplorer');
			vi.mocked(shouldOpenExternally).mockReturnValue(false);

			const session = createMockSession();
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const deps = createDeps({
				sessionsRef: { current: [session] },
				activeSessionIdRef: { current: 'session-1' },
			});

			// Start with focus on right
			useUIStore.setState({ activeFocus: 'right' });

			const { result } = renderHook(() => useFileExplorerEffects(deps));

			await act(async () => {
				await result.current.handleMainPanelFileClick('src/index.ts');
			});

			expect(useUIStore.getState().activeFocus).toBe('main');
		});

		it('passes lastModified from stat to handleOpenFileTab', async () => {
			const useFileExplorerEffects = await loadHook();
			const { shouldOpenExternally } = await import('../../../renderer/utils/fileExplorer');
			vi.mocked(shouldOpenExternally).mockReturnValue(false);

			((window as any).maestro.fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({
				modifiedAt: '2024-06-15T12:00:00Z',
			});

			const session = createMockSession();
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const handleOpenFileTab = vi.fn();
			const deps = createDeps({
				sessionsRef: { current: [session] },
				activeSessionIdRef: { current: 'session-1' },
				handleOpenFileTab,
			});

			const { result } = renderHook(() => useFileExplorerEffects(deps));

			await act(async () => {
				await result.current.handleMainPanelFileClick('src/index.ts');
			});

			expect(handleOpenFileTab).toHaveBeenCalledWith(
				expect.objectContaining({
					lastModified: new Date('2024-06-15T12:00:00Z').getTime(),
				}),
				expect.anything()
			);
		});

		it('handles stat failure gracefully (lastModified = undefined)', async () => {
			const useFileExplorerEffects = await loadHook();
			const { shouldOpenExternally } = await import('../../../renderer/utils/fileExplorer');
			vi.mocked(shouldOpenExternally).mockReturnValue(false);

			((window as any).maestro.fs.stat as ReturnType<typeof vi.fn>).mockRejectedValue(
				new Error('ENOENT')
			);

			const session = createMockSession();
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const handleOpenFileTab = vi.fn();
			const deps = createDeps({
				sessionsRef: { current: [session] },
				activeSessionIdRef: { current: 'session-1' },
				handleOpenFileTab,
			});

			const { result } = renderHook(() => useFileExplorerEffects(deps));

			await act(async () => {
				await result.current.handleMainPanelFileClick('src/index.ts');
			});

			// stat fails → caught → returns null → lastModified = undefined
			expect(handleOpenFileTab).toHaveBeenCalledWith(
				expect.objectContaining({
					lastModified: undefined,
				}),
				expect.anything()
			);
		});
	});

	// ====================================================================
	// Scroll restore — additional coverage
	// ====================================================================

	describe('scroll restore — additional coverage', () => {
		it('does not set scrollTop when fileExplorerScrollPos is undefined', async () => {
			const useFileExplorerEffects = await loadHook();

			const mockDiv = { scrollTop: 42 } as HTMLDivElement;
			const session = createMockSession({ fileExplorerScrollPos: undefined });
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const deps = createDeps({
				fileTreeContainerRef: { current: mockDiv },
			});

			renderHook(() => useFileExplorerEffects(deps));

			// scrollTop should remain unchanged
			expect(mockDiv.scrollTop).toBe(42);
		});
	});

	// ====================================================================
	// Flat file list computation — additional coverage
	// ====================================================================

	describe('flat file list computation — additional coverage', () => {
		it('passes all files through when showHiddenFiles is true', async () => {
			const useFileExplorerEffects = await loadHook();
			const { flattenTree } = await import('../../../renderer/utils/fileExplorer');
			vi.mocked(flattenTree).mockReturnValue([]);

			useSettingsStore.setState({ showHiddenFiles: true } as any);

			const tree: FileNode[] = [
				{ name: '.hidden', type: 'folder', children: [] },
				{ name: 'visible', type: 'folder', children: [] },
			];

			const session = createMockSession({
				fileExplorerExpanded: [],
				fileTree: tree,
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const deps = createDeps({ filteredFileTree: tree });
			renderHook(() => useFileExplorerEffects(deps));

			// flattenTree should be called with ALL files (including .hidden)
			const calledTree = vi.mocked(flattenTree).mock.calls[0]?.[0];
			expect(calledTree).toBeDefined();
			expect(calledTree?.some((n: any) => n.name === '.hidden')).toBe(true);
			expect(calledTree?.some((n: any) => n.name === 'visible')).toBe(true);
		});

		it('preserves selection by path when flat list changes', async () => {
			const useFileExplorerEffects = await loadHook();
			const { flattenTree } = await import('../../../renderer/utils/fileExplorer');

			// Initial flat list with selectedFileIndex = 1 pointing to 'lib'
			const initialFlatList = [
				{ name: 'src', fullPath: 'src', isFolder: true, type: 'folder' as const },
				{ name: 'lib', fullPath: 'lib', isFolder: true, type: 'folder' as const },
			];
			useFileExplorerStore.setState({ flatFileList: initialFlatList, selectedFileIndex: 1 });

			// New flat list has 'lib' at index 2 (a new item inserted before it)
			const newFlatList = [
				{ name: 'src', fullPath: 'src', isFolder: true, type: 'folder' as const },
				{ name: 'docs', fullPath: 'docs', isFolder: true, type: 'folder' as const },
				{ name: 'lib', fullPath: 'lib', isFolder: true, type: 'folder' as const },
			];
			vi.mocked(flattenTree).mockReturnValue(newFlatList);

			const tree: FileNode[] = [
				{ name: 'src', type: 'folder', children: [] },
				{ name: 'docs', type: 'folder', children: [] },
				{ name: 'lib', type: 'folder', children: [] },
			];
			const session = createMockSession({
				fileExplorerExpanded: ['src'],
				fileTree: tree,
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const deps = createDeps({ filteredFileTree: tree });
			renderHook(() => useFileExplorerEffects(deps));

			// Selection should follow 'lib' to its new index 2
			expect(useFileExplorerStore.getState().selectedFileIndex).toBe(2);
		});

		it('clamps selection when selected path is removed', async () => {
			const useFileExplorerEffects = await loadHook();
			const { flattenTree } = await import('../../../renderer/utils/fileExplorer');

			// Initial: selectedFileIndex=2 pointing to 'tests' (which will be removed)
			const initialFlatList = [
				{ name: 'src', fullPath: 'src', isFolder: true, type: 'folder' as const },
				{ name: 'lib', fullPath: 'lib', isFolder: true, type: 'folder' as const },
				{ name: 'tests', fullPath: 'tests', isFolder: true, type: 'folder' as const },
			];
			useFileExplorerStore.setState({ flatFileList: initialFlatList, selectedFileIndex: 2 });

			// New flat list doesn't have 'tests'
			const newFlatList = [
				{ name: 'src', fullPath: 'src', isFolder: true, type: 'folder' as const },
				{ name: 'lib', fullPath: 'lib', isFolder: true, type: 'folder' as const },
			];
			vi.mocked(flattenTree).mockReturnValue(newFlatList);

			const tree: FileNode[] = [
				{ name: 'src', type: 'folder', children: [] },
				{ name: 'lib', type: 'folder', children: [] },
			];
			const session = createMockSession({
				fileExplorerExpanded: [],
				fileTree: tree,
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const deps = createDeps({ filteredFileTree: tree });
			renderHook(() => useFileExplorerEffects(deps));

			// Should clamp to last item (index 1)
			expect(useFileExplorerStore.getState().selectedFileIndex).toBe(1);
		});

		it('filters hidden children recursively', async () => {
			const useFileExplorerEffects = await loadHook();
			const { flattenTree } = await import('../../../renderer/utils/fileExplorer');
			vi.mocked(flattenTree).mockReturnValue([]);

			useSettingsStore.setState({ showHiddenFiles: false } as any);

			const tree: FileNode[] = [
				{
					name: 'src',
					type: 'folder',
					children: [
						{ name: '.env', type: 'file' },
						{ name: 'index.ts', type: 'file' },
					],
				},
			];

			const session = createMockSession({
				fileExplorerExpanded: ['src'],
				fileTree: tree,
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const deps = createDeps({ filteredFileTree: tree });
			renderHook(() => useFileExplorerEffects(deps));

			const calledTree = vi.mocked(flattenTree).mock.calls[0]?.[0];
			// 'src' folder should be passed through
			const srcFolder = calledTree?.find((n: any) => n.name === 'src');
			expect(srcFolder).toBeDefined();
			// Its children should not include '.env'
			expect(srcFolder?.children?.some((n: any) => n.name === '.env')).toBe(false);
			expect(srcFolder?.children?.some((n: any) => n.name === 'index.ts')).toBe(true);
		});
	});

	// ====================================================================
	// Keyboard navigation — additional coverage
	// ====================================================================

	describe('keyboard navigation — additional coverage', () => {
		it('Cmd+ArrowUp jumps to first item', async () => {
			const useFileExplorerEffects = await loadHook();
			useUIStore.setState({ activeFocus: 'right', activeRightTab: 'files' });

			const session = createMockSession();
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const deps = createDeps();
			const { rerender } = renderHook(() => useFileExplorerEffects(deps));

			const flatList = [
				{ name: 'a', fullPath: 'a', isFolder: false, type: 'file' as const },
				{ name: 'b', fullPath: 'b', isFolder: false, type: 'file' as const },
				{ name: 'c', fullPath: 'c', isFolder: false, type: 'file' as const },
			];
			act(() => {
				useFileExplorerStore.setState({ flatFileList: flatList, selectedFileIndex: 2 });
			});
			rerender();

			act(() => {
				window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', metaKey: true }));
			});

			expect(useFileExplorerStore.getState().selectedFileIndex).toBe(0);
		});

		it('Ctrl+ArrowUp jumps to first item (cross-platform)', async () => {
			const useFileExplorerEffects = await loadHook();
			useUIStore.setState({ activeFocus: 'right', activeRightTab: 'files' });

			const session = createMockSession();
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const deps = createDeps();
			const { rerender } = renderHook(() => useFileExplorerEffects(deps));

			const flatList = [
				{ name: 'a', fullPath: 'a', isFolder: false, type: 'file' as const },
				{ name: 'b', fullPath: 'b', isFolder: false, type: 'file' as const },
			];
			act(() => {
				useFileExplorerStore.setState({ flatFileList: flatList, selectedFileIndex: 1 });
			});
			rerender();

			act(() => {
				window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', ctrlKey: true }));
			});

			expect(useFileExplorerStore.getState().selectedFileIndex).toBe(0);
		});

		it('Option+ArrowDown pages down 10 items', async () => {
			const useFileExplorerEffects = await loadHook();
			useUIStore.setState({ activeFocus: 'right', activeRightTab: 'files' });

			const session = createMockSession();
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const deps = createDeps();
			const { rerender } = renderHook(() => useFileExplorerEffects(deps));

			// Create a list of 20 items
			const flatList = Array.from({ length: 20 }, (_, i) => ({
				name: `file-${i}`,
				fullPath: `file-${i}`,
				isFolder: false,
				type: 'file' as const,
			}));
			act(() => {
				useFileExplorerStore.setState({ flatFileList: flatList, selectedFileIndex: 5 });
			});
			rerender();

			act(() => {
				window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true }));
			});

			expect(useFileExplorerStore.getState().selectedFileIndex).toBe(15);
		});

		it('Option+ArrowUp pages up 10 items', async () => {
			const useFileExplorerEffects = await loadHook();
			useUIStore.setState({ activeFocus: 'right', activeRightTab: 'files' });

			const session = createMockSession();
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const deps = createDeps();
			const { rerender } = renderHook(() => useFileExplorerEffects(deps));

			const flatList = Array.from({ length: 20 }, (_, i) => ({
				name: `file-${i}`,
				fullPath: `file-${i}`,
				isFolder: false,
				type: 'file' as const,
			}));
			act(() => {
				useFileExplorerStore.setState({ flatFileList: flatList, selectedFileIndex: 15 });
			});
			rerender();

			act(() => {
				window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true }));
			});

			expect(useFileExplorerStore.getState().selectedFileIndex).toBe(5);
		});

		it('Option+ArrowDown clamps to last item', async () => {
			const useFileExplorerEffects = await loadHook();
			useUIStore.setState({ activeFocus: 'right', activeRightTab: 'files' });

			const session = createMockSession();
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const deps = createDeps();
			const { rerender } = renderHook(() => useFileExplorerEffects(deps));

			const flatList = Array.from({ length: 5 }, (_, i) => ({
				name: `file-${i}`,
				fullPath: `file-${i}`,
				isFolder: false,
				type: 'file' as const,
			}));
			act(() => {
				useFileExplorerStore.setState({ flatFileList: flatList, selectedFileIndex: 3 });
			});
			rerender();

			act(() => {
				window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true }));
			});

			// 3 + 10 = 13, but clamped to 4 (last index)
			expect(useFileExplorerStore.getState().selectedFileIndex).toBe(4);
		});

		it('ArrowDown clamps at last item', async () => {
			const useFileExplorerEffects = await loadHook();
			useUIStore.setState({ activeFocus: 'right', activeRightTab: 'files' });

			const session = createMockSession();
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const deps = createDeps();
			const { rerender } = renderHook(() => useFileExplorerEffects(deps));

			const flatList = [
				{ name: 'a', fullPath: 'a', isFolder: false, type: 'file' as const },
				{ name: 'b', fullPath: 'b', isFolder: false, type: 'file' as const },
			];
			act(() => {
				useFileExplorerStore.setState({ flatFileList: flatList, selectedFileIndex: 1 });
			});
			rerender();

			act(() => {
				window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
			});

			// Already at last item, should stay at 1
			expect(useFileExplorerStore.getState().selectedFileIndex).toBe(1);
		});

		it('ArrowUp clamps at first item', async () => {
			const useFileExplorerEffects = await loadHook();
			useUIStore.setState({ activeFocus: 'right', activeRightTab: 'files' });

			const session = createMockSession();
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const deps = createDeps();
			const { rerender } = renderHook(() => useFileExplorerEffects(deps));

			const flatList = [
				{ name: 'a', fullPath: 'a', isFolder: false, type: 'file' as const },
				{ name: 'b', fullPath: 'b', isFolder: false, type: 'file' as const },
			];
			act(() => {
				useFileExplorerStore.setState({ flatFileList: flatList, selectedFileIndex: 0 });
			});
			rerender();

			act(() => {
				window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
			});

			// Already at first item, should stay at 0
			expect(useFileExplorerStore.getState().selectedFileIndex).toBe(0);
		});

		it('ArrowLeft collapses an expanded folder', async () => {
			const useFileExplorerEffects = await loadHook();
			useUIStore.setState({ activeFocus: 'right', activeRightTab: 'files' });

			const session = createMockSession({
				fileExplorerExpanded: ['src'],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const toggleFolder = vi.fn();
			const deps = createDeps({ toggleFolder });
			const { rerender } = renderHook(() => useFileExplorerEffects(deps));

			const flatList = [
				{ name: 'src', fullPath: 'src', isFolder: true, type: 'folder' as const },
				{ name: 'index.ts', fullPath: 'src/index.ts', isFolder: false, type: 'file' as const },
			];
			act(() => {
				useFileExplorerStore.setState({ flatFileList: flatList, selectedFileIndex: 0 });
			});
			rerender();

			act(() => {
				window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
			});

			// Should collapse 'src' folder
			expect(toggleFolder).toHaveBeenCalledWith('src', 'session-1', expect.any(Function));
		});

		it('ArrowLeft on file navigates to parent folder', async () => {
			const useFileExplorerEffects = await loadHook();
			useUIStore.setState({ activeFocus: 'right', activeRightTab: 'files' });

			const session = createMockSession({
				fileExplorerExpanded: ['src'],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const toggleFolder = vi.fn();
			const deps = createDeps({ toggleFolder });
			const { rerender } = renderHook(() => useFileExplorerEffects(deps));

			const flatList = [
				{ name: 'src', fullPath: 'src', isFolder: true, type: 'folder' as const },
				{ name: 'index.ts', fullPath: 'src/index.ts', isFolder: false, type: 'file' as const },
			];
			act(() => {
				useFileExplorerStore.setState({ flatFileList: flatList, selectedFileIndex: 1 });
			});
			rerender();

			act(() => {
				window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
			});

			// Should collapse parent 'src' and navigate to it
			expect(toggleFolder).toHaveBeenCalledWith('src', 'session-1', expect.any(Function));
			expect(useFileExplorerStore.getState().selectedFileIndex).toBe(0);
		});

		it('ArrowRight expands a collapsed folder', async () => {
			const useFileExplorerEffects = await loadHook();
			useUIStore.setState({ activeFocus: 'right', activeRightTab: 'files' });

			const session = createMockSession({
				fileExplorerExpanded: [], // 'src' is NOT expanded
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const toggleFolder = vi.fn();
			const deps = createDeps({ toggleFolder });
			const { rerender } = renderHook(() => useFileExplorerEffects(deps));

			const flatList = [{ name: 'src', fullPath: 'src', isFolder: true, type: 'folder' as const }];
			act(() => {
				useFileExplorerStore.setState({ flatFileList: flatList, selectedFileIndex: 0 });
			});
			rerender();

			act(() => {
				window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
			});

			// Should expand 'src' folder
			expect(toggleFolder).toHaveBeenCalledWith('src', 'session-1', expect.any(Function));
		});

		it('ArrowRight does nothing on already-expanded folder', async () => {
			const useFileExplorerEffects = await loadHook();
			useUIStore.setState({ activeFocus: 'right', activeRightTab: 'files' });

			const session = createMockSession({
				fileExplorerExpanded: ['src'], // already expanded
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const toggleFolder = vi.fn();
			const deps = createDeps({ toggleFolder });
			const { rerender } = renderHook(() => useFileExplorerEffects(deps));

			const flatList = [{ name: 'src', fullPath: 'src', isFolder: true, type: 'folder' as const }];
			act(() => {
				useFileExplorerStore.setState({ flatFileList: flatList, selectedFileIndex: 0 });
			});
			rerender();

			act(() => {
				window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
			});

			// Should NOT toggle — already expanded
			expect(toggleFolder).not.toHaveBeenCalled();
		});

		it('ignores keys when activeRightTab is not files', async () => {
			const useFileExplorerEffects = await loadHook();
			useUIStore.setState({ activeFocus: 'right', activeRightTab: 'history' });

			const session = createMockSession();
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const deps = createDeps();
			const { rerender } = renderHook(() => useFileExplorerEffects(deps));

			const flatList = [
				{ name: 'a', fullPath: 'a', isFolder: false, type: 'file' as const },
				{ name: 'b', fullPath: 'b', isFolder: false, type: 'file' as const },
			];
			act(() => {
				useFileExplorerStore.setState({ flatFileList: flatList, selectedFileIndex: 0 });
			});
			rerender();

			act(() => {
				window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
			});

			expect(useFileExplorerStore.getState().selectedFileIndex).toBe(0);
		});

		it('ignores keys when flatFileList is empty', async () => {
			const useFileExplorerEffects = await loadHook();
			useUIStore.setState({ activeFocus: 'right', activeRightTab: 'files' });

			const session = createMockSession();
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const toggleFolder = vi.fn();
			const deps = createDeps({ toggleFolder });
			const { rerender } = renderHook(() => useFileExplorerEffects(deps));

			act(() => {
				useFileExplorerStore.setState({ flatFileList: [], selectedFileIndex: 0 });
			});
			rerender();

			act(() => {
				window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
			});

			expect(toggleFolder).not.toHaveBeenCalled();
		});

		it('cleans up keyboard listener on unmount', async () => {
			const useFileExplorerEffects = await loadHook();
			useUIStore.setState({ activeFocus: 'right', activeRightTab: 'files' });

			const session = createMockSession();
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			});

			const deps = createDeps();
			const { rerender, unmount } = renderHook(() => useFileExplorerEffects(deps));

			const flatList = [
				{ name: 'a', fullPath: 'a', isFolder: false, type: 'file' as const },
				{ name: 'b', fullPath: 'b', isFolder: false, type: 'file' as const },
			];
			act(() => {
				useFileExplorerStore.setState({ flatFileList: flatList, selectedFileIndex: 0 });
			});
			rerender();

			// Unmount to trigger cleanup
			unmount();

			// Dispatch after unmount — should have no effect
			act(() => {
				window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
			});

			// Index should remain 0 (listener was removed)
			expect(useFileExplorerStore.getState().selectedFileIndex).toBe(0);
		});
	});

	// ====================================================================
	// stableFileTree — additional coverage
	// ====================================================================

	describe('stableFileTree — additional coverage', () => {
		it('returns new reference when fileTree changes', async () => {
			const useFileExplorerEffects = await loadHook();

			const tree1: FileNode[] = [{ name: 'src', type: 'folder', children: [] }];
			const session1 = createMockSession({ fileTree: tree1 });
			useSessionStore.setState({
				sessions: [session1],
				activeSessionId: 'session-1',
			});

			const deps = createDeps();
			const { result } = renderHook(() => useFileExplorerEffects(deps));

			const ref1 = result.current.stableFileTree;

			// Update to a new file tree
			const tree2: FileNode[] = [
				{ name: 'src', type: 'folder', children: [] },
				{ name: 'lib', type: 'folder', children: [] },
			];
			act(() => {
				useSessionStore.setState({
					sessions: [createMockSession({ fileTree: tree2 })],
				});
			});

			const ref2 = result.current.stableFileTree;

			// Should be a different reference since tree changed
			expect(ref1).not.toBe(ref2);
			expect(ref2).toBe(tree2);
		});
	});

	// ====================================================================
	// Return stability
	// ====================================================================

	describe('return stability', () => {
		it('returns stable handleMainPanelFileClick reference across rerenders', async () => {
			const useFileExplorerEffects = await loadHook();

			useSessionStore.setState({
				sessions: [createMockSession()],
				activeSessionId: 'session-1',
			});

			const deps = createDeps();
			const { result, rerender } = renderHook(() => useFileExplorerEffects(deps));

			const ref1 = result.current.handleMainPanelFileClick;
			rerender();
			const ref2 = result.current.handleMainPanelFileClick;

			expect(ref1).toBe(ref2);
		});
	});
});
