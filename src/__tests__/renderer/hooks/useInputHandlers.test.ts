/**
 * Tests for useInputHandlers hook (Phase 2J extraction from App.tsx)
 *
 * Tests cover:
 * - Hook initialization and return shape
 * - Input state management (AI vs terminal mode)
 * - Staged images (get/set)
 * - (thinkingSessions removed — replaced by thinkingItems in App.tsx)
 * - Completion suggestions (tab completion, @ mention)
 * - Tab switching effect (AI input persistence)
 * - Session switching effect (terminal input persistence)
 * - syncFileTreeToTabCompletion
 * - handleMainPanelInputBlur
 * - handleReplayMessage
 * - handlePaste (text trimming + image staging)
 * - handleDrop (image staging)
 * - processInputRef tracking
 * - Return value stability
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import type { Session, BatchRunState } from '../../../renderer/types';

// ============================================================================
// Mock InputContext
// ============================================================================

const mockInputContext = {
	slashCommandOpen: false,
	setSlashCommandOpen: vi.fn(),
	selectedSlashCommandIndex: 0,
	setSelectedSlashCommandIndex: vi.fn(),
	tabCompletionOpen: false,
	setTabCompletionOpen: vi.fn(),
	selectedTabCompletionIndex: 0,
	setSelectedTabCompletionIndex: vi.fn(),
	tabCompletionFilter: 'all' as const,
	setTabCompletionFilter: vi.fn(),
	atMentionOpen: false,
	setAtMentionOpen: vi.fn(),
	atMentionFilter: '',
	setAtMentionFilter: vi.fn(),
	atMentionStartIndex: -1,
	setAtMentionStartIndex: vi.fn(),
	selectedAtMentionIndex: 0,
	setSelectedAtMentionIndex: vi.fn(),
	commandHistoryOpen: false,
	setCommandHistoryOpen: vi.fn(),
	commandHistoryFilter: '',
	setCommandHistoryFilter: vi.fn(),
	commandHistorySelectedIndex: 0,
	setCommandHistorySelectedIndex: vi.fn(),
};

vi.mock('../../../renderer/contexts/InputContext', () => ({
	useInputContext: () => mockInputContext,
}));

// ============================================================================
// Mock sub-hooks
// ============================================================================

const mockSyncAiInputToSession = vi.fn();
const mockSyncTerminalInputToSession = vi.fn();

vi.mock('../../../renderer/hooks/input/useInputSync', () => ({
	useInputSync: vi.fn(() => ({
		syncAiInputToSession: mockSyncAiInputToSession,
		syncTerminalInputToSession: mockSyncTerminalInputToSession,
	})),
}));

const mockGetTabCompletionSuggestions = vi.fn().mockReturnValue([]);
vi.mock('../../../renderer/hooks/input/useTabCompletion', () => ({
	useTabCompletion: vi.fn(() => ({
		getSuggestions: mockGetTabCompletionSuggestions,
	})),
}));

const mockGetAtMentionSuggestions = vi.fn().mockReturnValue([]);
vi.mock('../../../renderer/hooks/input/useAtMentionCompletion', () => ({
	useAtMentionCompletion: vi.fn(() => ({
		getSuggestions: mockGetAtMentionSuggestions,
	})),
}));

const mockProcessInput = vi.fn();
const mockProcessInputRef = { current: mockProcessInput };
vi.mock('../../../renderer/hooks/input/useInputProcessing', () => ({
	useInputProcessing: vi.fn(() => ({
		processInput: mockProcessInput,
		processInputRef: mockProcessInputRef,
	})),
	DEFAULT_IMAGE_ONLY_PROMPT: 'Describe this image',
}));

const mockHandleInputKeyDown = vi.fn();
vi.mock('../../../renderer/hooks/input/useInputKeyDown', () => ({
	useInputKeyDown: vi.fn(() => ({
		handleInputKeyDown: mockHandleInputKeyDown,
	})),
}));

// Mock useDebouncedValue to return value immediately (no debounce delay)
vi.mock('../../../renderer/hooks/utils', () => ({
	useDebouncedValue: vi.fn((value: string) => value),
}));

// ============================================================================
// Now import the hook and stores
// ============================================================================

import {
	useInputHandlers,
	type UseInputHandlersDeps,
} from '../../../renderer/hooks/input/useInputHandlers';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { useGroupChatStore } from '../../../renderer/stores/groupChatStore';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { useFileExplorerStore } from '../../../renderer/stores/fileExplorerStore';

// ============================================================================
// Helpers
// ============================================================================

function createDefaultBatchState(overrides: Partial<BatchRunState> = {}): BatchRunState {
	return {
		isRunning: false,
		isStopping: false,
		documents: [],
		lockedDocuments: [],
		currentDocumentIndex: 0,
		currentDocTasksTotal: 0,
		currentDocTasksCompleted: 0,
		totalTasksAcrossAllDocs: 0,
		completedTasksAcrossAllDocs: 0,
		loopEnabled: false,
		loopIteration: 0,
		folderPath: '',
		worktreeActive: false,
		totalTasks: 0,
		completedTasks: 0,
		currentTaskIndex: 0,
		startTime: null,
		currentTask: null,
		sessionIds: [],
		...overrides,
	};
}

function createMockSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Test Agent',
		state: 'idle',
		busySource: undefined,
		toolType: 'claude-code',
		aiTabs: [
			{
				id: 'tab-1',
				name: 'Tab 1',
				inputValue: '',
				data: [],
				stagedImages: [],
			},
		],
		activeTabId: 'tab-1',
		inputMode: 'ai',
		isGitRepo: false,
		cwd: '/test',
		projectRoot: '/test',
		terminalDraftInput: '',
		terminalTabs: [],
		activeTerminalTabId: null,
		...overrides,
	} as Session;
}

function createMockDeps(overrides: Partial<UseInputHandlersDeps> = {}): UseInputHandlersDeps {
	return {
		inputRef: { current: { focus: vi.fn(), blur: vi.fn() } } as any,
		terminalOutputRef: { current: { focus: vi.fn() } } as any,
		fileTreeKeyboardNavRef: { current: false },
		dragCounterRef: { current: 0 },
		setIsDraggingImage: vi.fn(),
		getBatchState: vi.fn().mockReturnValue(createDefaultBatchState()),
		activeBatchRunState: createDefaultBatchState(),
		processQueuedItemRef: { current: null },
		flushBatchedUpdates: vi.fn(),
		handleHistoryCommand: vi.fn().mockResolvedValue(undefined),
		handleWizardCommand: vi.fn(),
		sendWizardMessageWithThinking: vi.fn().mockResolvedValue(undefined),
		isWizardActiveForCurrentTab: false,
		handleSkillsCommand: vi.fn().mockResolvedValue(undefined),
		allSlashCommands: [],
		allCustomCommands: [],
		sessionsRef: { current: [] },
		activeSessionIdRef: { current: 'session-1' },
		...overrides,
	};
}

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();

	// Reset InputContext mock
	Object.assign(mockInputContext, {
		slashCommandOpen: false,
		tabCompletionOpen: false,
		selectedTabCompletionIndex: 0,
		tabCompletionFilter: 'all',
		atMentionOpen: false,
		atMentionFilter: '',
		selectedAtMentionIndex: 0,
		commandHistoryOpen: false,
	});

	// Reset stores
	const session = createMockSession();
	useSessionStore.setState({
		sessions: [session],
		activeSessionId: 'session-1',
	} as any);

	useSettingsStore.setState({
		conductorProfile: 'default',
		automaticTabNamingEnabled: true,
	} as any);

	useGroupChatStore.setState({
		activeGroupChatId: null,
		setGroupChatStagedImages: vi.fn(),
	} as any);

	useUIStore.setState({
		activeRightTab: 'files',
		setActiveRightTab: vi.fn(),
		setSuccessFlashNotification: vi.fn(),
		outputSearchOpen: false,
	} as any);

	useFileExplorerStore.setState({
		flatFileList: [],
		setSelectedFileIndex: vi.fn(),
	} as any);
});

afterEach(() => {
	vi.useRealTimers();
	cleanup();
});

// ============================================================================
// Tests
// ============================================================================

describe('useInputHandlers', () => {
	// ========================================================================
	// Initialization & return shape
	// ========================================================================

	describe('initialization', () => {
		it('returns all expected properties', () => {
			const { result } = renderHook(() => useInputHandlers(createMockDeps()));

			expect(result.current).toHaveProperty('inputValue');
			expect(result.current).toHaveProperty('deferredInputValue');
			expect(result.current).toHaveProperty('setInputValue');
			expect(result.current).toHaveProperty('stagedImages');
			expect(result.current).toHaveProperty('setStagedImages');
			expect(result.current).toHaveProperty('processInput');
			expect(result.current).toHaveProperty('processInputRef');
			expect(result.current).toHaveProperty('handleInputKeyDown');
			expect(result.current).toHaveProperty('handleMainPanelInputBlur');
			expect(result.current).toHaveProperty('handleReplayMessage');
			expect(result.current).toHaveProperty('handlePaste');
			expect(result.current).toHaveProperty('handleDrop');
			expect(result.current).toHaveProperty('tabCompletionSuggestions');
			expect(result.current).toHaveProperty('atMentionSuggestions');
			expect(result.current).toHaveProperty('syncFileTreeToTabCompletion');
		});

		it('initializes with empty input value in AI mode', () => {
			const { result } = renderHook(() => useInputHandlers(createMockDeps()));
			expect(result.current.inputValue).toBe('');
		});

		it('initializes with empty staged images', () => {
			const { result } = renderHook(() => useInputHandlers(createMockDeps()));
			expect(result.current.stagedImages).toEqual([]);
		});

		it('initializes with empty completion suggestions', () => {
			const { result } = renderHook(() => useInputHandlers(createMockDeps()));
			expect(result.current.tabCompletionSuggestions).toEqual([]);
			expect(result.current.atMentionSuggestions).toEqual([]);
		});
	});

	// ========================================================================
	// Input state management
	// ========================================================================

	describe('input state', () => {
		it('setInputValue updates AI input in AI mode', () => {
			const { result } = renderHook(() => useInputHandlers(createMockDeps()));

			act(() => {
				result.current.setInputValue('hello AI');
			});

			expect(result.current.inputValue).toBe('hello AI');
		});

		it('setInputValue updates terminal input in terminal mode', () => {
			useSessionStore.setState({
				sessions: [createMockSession({ inputMode: 'terminal' })],
				activeSessionId: 'session-1',
			} as any);

			const { result } = renderHook(() => useInputHandlers(createMockDeps()));

			act(() => {
				result.current.setInputValue('ls -la');
			});

			expect(result.current.inputValue).toBe('ls -la');
		});

		it('setInputValue accepts function updater', () => {
			const { result } = renderHook(() => useInputHandlers(createMockDeps()));

			act(() => {
				result.current.setInputValue('hello');
			});
			act(() => {
				result.current.setInputValue((prev) => prev + ' world');
			});

			expect(result.current.inputValue).toBe('hello world');
		});

		it('deferredInputValue matches inputValue', () => {
			const { result } = renderHook(() => useInputHandlers(createMockDeps()));

			act(() => {
				result.current.setInputValue('test input');
			});

			// useDeferredValue in tests should match (no concurrent rendering)
			expect(result.current.deferredInputValue).toBe('test input');
		});
	});

	// ========================================================================
	// Staged images
	// ========================================================================

	describe('staged images', () => {
		it('returns staged images from active tab', () => {
			useSessionStore.setState({
				sessions: [
					createMockSession({
						aiTabs: [
							{
								id: 'tab-1',
								name: 'Tab 1',
								inputValue: '',
								data: [],
								stagedImages: ['img1.png', 'img2.png'],
							} as any,
						],
					}),
				],
				activeSessionId: 'session-1',
			} as any);

			const { result } = renderHook(() => useInputHandlers(createMockDeps()));
			expect(result.current.stagedImages).toEqual(['img1.png', 'img2.png']);
		});

		it('returns empty array in terminal mode', () => {
			useSessionStore.setState({
				sessions: [createMockSession({ inputMode: 'terminal' })],
				activeSessionId: 'session-1',
			} as any);

			const { result } = renderHook(() => useInputHandlers(createMockDeps()));
			expect(result.current.stagedImages).toEqual([]);
		});

		it('setStagedImages updates staged images on active tab', () => {
			const { result } = renderHook(() => useInputHandlers(createMockDeps()));

			act(() => {
				result.current.setStagedImages(['new-image.png']);
			});

			const sessions = useSessionStore.getState().sessions;
			const tab = sessions[0].aiTabs.find((t: any) => t.id === 'tab-1');
			expect(tab?.stagedImages).toEqual(['new-image.png']);
		});

		it('setStagedImages accepts function updater', () => {
			useSessionStore.setState({
				sessions: [
					createMockSession({
						aiTabs: [
							{
								id: 'tab-1',
								name: 'Tab 1',
								inputValue: '',
								data: [],
								stagedImages: ['existing.png'],
							} as any,
						],
					}),
				],
				activeSessionId: 'session-1',
			} as any);

			const { result } = renderHook(() => useInputHandlers(createMockDeps()));

			act(() => {
				result.current.setStagedImages((prev) => [...prev, 'added.png']);
			});

			const sessions = useSessionStore.getState().sessions;
			const tab = sessions[0].aiTabs.find((t: any) => t.id === 'tab-1');
			expect(tab?.stagedImages).toEqual(['existing.png', 'added.png']);
		});
	});

	// ========================================================================
	// Tab switching effect
	// ========================================================================

	describe('tab switching effect', () => {
		it('loads new tab input value when switching tabs', () => {
			// Start on tab-1, then switch to tab-2
			useSessionStore.setState({
				sessions: [
					createMockSession({
						aiTabs: [
							{
								id: 'tab-1',
								name: 'Tab 1',
								inputValue: 'tab1 text',
								data: [],
								stagedImages: [],
							} as any,
							{
								id: 'tab-2',
								name: 'Tab 2',
								inputValue: 'tab2 text',
								data: [],
								stagedImages: [],
							} as any,
						],
						activeTabId: 'tab-1',
					}),
				],
				activeSessionId: 'session-1',
			} as any);

			const { result, rerender } = renderHook(() => useInputHandlers(createMockDeps()));

			// Initially empty (hook doesn't load on first mount, only on tab switch)
			expect(result.current.inputValue).toBe('');

			// Switch to tab-2 — this triggers the effect
			act(() => {
				useSessionStore.setState({
					sessions: [
						createMockSession({
							aiTabs: [
								{
									id: 'tab-1',
									name: 'Tab 1',
									inputValue: 'tab1 text',
									data: [],
									stagedImages: [],
								} as any,
								{
									id: 'tab-2',
									name: 'Tab 2',
									inputValue: 'tab2 text',
									data: [],
									stagedImages: [],
								} as any,
							],
							activeTabId: 'tab-2',
						}),
					],
					activeSessionId: 'session-1',
				} as any);
			});

			rerender();
			expect(result.current.inputValue).toBe('tab2 text');
		});

		it('saves current input to previous tab on switch', () => {
			useSessionStore.setState({
				sessions: [
					createMockSession({
						aiTabs: [
							{ id: 'tab-1', name: 'Tab 1', inputValue: '', data: [], stagedImages: [] } as any,
							{ id: 'tab-2', name: 'Tab 2', inputValue: '', data: [], stagedImages: [] } as any,
						],
						activeTabId: 'tab-1',
					}),
				],
				activeSessionId: 'session-1',
			} as any);

			const { result, rerender } = renderHook(() => useInputHandlers(createMockDeps()));

			// Type into tab-1
			act(() => {
				result.current.setInputValue('typed in tab 1');
			});

			// Switch to tab-2
			act(() => {
				useSessionStore.setState({
					sessions: [
						createMockSession({
							aiTabs: [
								{ id: 'tab-1', name: 'Tab 1', inputValue: '', data: [], stagedImages: [] } as any,
								{
									id: 'tab-2',
									name: 'Tab 2',
									inputValue: 'tab2 content',
									data: [],
									stagedImages: [],
								} as any,
							],
							activeTabId: 'tab-2',
						}),
					],
					activeSessionId: 'session-1',
				} as any);
			});

			rerender();

			// Verify tab-1 had the typed input saved (check session store)
			const sessions = useSessionStore.getState().sessions;
			const tab1 = sessions[0].aiTabs.find((t: any) => t.id === 'tab-1');
			expect(tab1?.inputValue).toBe('typed in tab 1');
		});
	});

	// ========================================================================
	// Session switching effect
	// ========================================================================

	describe('session switching effect', () => {
		it('loads terminal input from new session when switching', () => {
			const session1 = createMockSession({
				id: 'session-1',
				inputMode: 'terminal',
				terminalDraftInput: 'session1 cmd',
			});
			const session2 = createMockSession({
				id: 'session-2',
				inputMode: 'terminal',
				terminalDraftInput: 'session2 cmd',
			});

			useSessionStore.setState({
				sessions: [session1, session2],
				activeSessionId: 'session-1',
			} as any);

			const deps = createMockDeps();
			const { result, rerender } = renderHook(() => useInputHandlers(deps));

			// Switch to session-2
			act(() => {
				useSessionStore.setState({
					sessions: [session1, session2],
					activeSessionId: 'session-2',
				} as any);
			});

			rerender();
			expect(result.current.inputValue).toBe('session2 cmd');
		});
	});

	// ========================================================================
	// Completion suggestions
	// ========================================================================

	describe('tab completion suggestions', () => {
		it('returns empty when tab completion is not open', () => {
			const { result } = renderHook(() => useInputHandlers(createMockDeps()));
			expect(result.current.tabCompletionSuggestions).toEqual([]);
			expect(mockGetTabCompletionSuggestions).not.toHaveBeenCalled();
		});

		it('calls getSuggestions when tab completion is open in terminal mode', () => {
			mockInputContext.tabCompletionOpen = true;

			useSessionStore.setState({
				sessions: [createMockSession({ inputMode: 'terminal' })],
				activeSessionId: 'session-1',
			} as any);

			mockGetTabCompletionSuggestions.mockReturnValue([
				{ type: 'file', value: 'src/', display: 'src/' },
			]);

			const { result } = renderHook(() => useInputHandlers(createMockDeps()));

			expect(result.current.tabCompletionSuggestions).toHaveLength(1);
			expect(result.current.tabCompletionSuggestions[0].value).toBe('src/');
		});

		it('returns empty in AI mode even when tab completion is open', () => {
			mockInputContext.tabCompletionOpen = true;

			const { result } = renderHook(() => useInputHandlers(createMockDeps()));
			expect(result.current.tabCompletionSuggestions).toEqual([]);
		});
	});

	describe('@ mention suggestions', () => {
		it('returns empty when @ mention is not open', () => {
			const { result } = renderHook(() => useInputHandlers(createMockDeps()));
			expect(result.current.atMentionSuggestions).toEqual([]);
		});

		it('calls getSuggestions when @ mention is open in AI mode', () => {
			mockInputContext.atMentionOpen = true;
			mockInputContext.atMentionFilter = 'test';

			mockGetAtMentionSuggestions.mockReturnValue([
				{ type: 'file', value: 'test.ts', display: 'test.ts' },
			]);

			const { result } = renderHook(() => useInputHandlers(createMockDeps()));

			expect(result.current.atMentionSuggestions).toHaveLength(1);
			expect(result.current.atMentionSuggestions[0].value).toBe('test.ts');
		});

		it('returns empty in terminal mode even when @ mention is open', () => {
			mockInputContext.atMentionOpen = true;
			mockInputContext.atMentionFilter = 'test';

			useSessionStore.setState({
				sessions: [createMockSession({ inputMode: 'terminal' })],
				activeSessionId: 'session-1',
			} as any);

			const { result } = renderHook(() => useInputHandlers(createMockDeps()));
			expect(result.current.atMentionSuggestions).toEqual([]);
		});
	});

	// ========================================================================
	// syncFileTreeToTabCompletion
	// ========================================================================

	describe('syncFileTreeToTabCompletion', () => {
		it('does nothing for undefined suggestion', () => {
			const { result } = renderHook(() => useInputHandlers(createMockDeps()));

			act(() => {
				result.current.syncFileTreeToTabCompletion(undefined);
			});

			expect(useFileExplorerStore.getState().setSelectedFileIndex).not.toHaveBeenCalled();
		});

		it('does nothing for history type suggestions', () => {
			const { result } = renderHook(() => useInputHandlers(createMockDeps()));

			act(() => {
				result.current.syncFileTreeToTabCompletion({
					type: 'history',
					value: 'ls',
					display: 'ls',
				} as any);
			});

			expect(useFileExplorerStore.getState().setSelectedFileIndex).not.toHaveBeenCalled();
		});

		it('does nothing when flatFileList is empty', () => {
			const { result } = renderHook(() => useInputHandlers(createMockDeps()));

			act(() => {
				result.current.syncFileTreeToTabCompletion({
					type: 'file',
					value: 'src/',
					display: 'src/',
				} as any);
			});

			expect(useFileExplorerStore.getState().setSelectedFileIndex).not.toHaveBeenCalled();
		});

		it('selects matching file in file tree', () => {
			const mockSetSelectedFileIndex = vi.fn();
			useFileExplorerStore.setState({
				flatFileList: [
					{ fullPath: 'src', name: 'src', isDirectory: true, depth: 0 },
					{ fullPath: 'package.json', name: 'package.json', isDirectory: false, depth: 0 },
				],
				setSelectedFileIndex: mockSetSelectedFileIndex,
			} as any);

			const deps = createMockDeps();
			const { result } = renderHook(() => useInputHandlers(deps));

			act(() => {
				result.current.syncFileTreeToTabCompletion({
					type: 'directory',
					value: 'src/',
					display: 'src/',
				} as any);
			});

			expect(mockSetSelectedFileIndex).toHaveBeenCalledWith(0);
			expect(deps.fileTreeKeyboardNavRef.current).toBe(true);
		});
	});

	// ========================================================================
	// handleMainPanelInputBlur
	// ========================================================================

	describe('handleMainPanelInputBlur', () => {
		it('syncs AI input to session in AI mode', () => {
			const session = createMockSession({ inputMode: 'ai' });
			const deps = createMockDeps({
				sessionsRef: { current: [session] },
				activeSessionIdRef: { current: 'session-1' },
			});

			const { result } = renderHook(() => useInputHandlers(deps));

			// Type some input first so the ref is populated
			act(() => {
				result.current.setInputValue('hello from AI');
			});

			act(() => {
				result.current.handleMainPanelInputBlur();
			});

			expect(mockSyncAiInputToSession).toHaveBeenCalled();
		});

		it('syncs terminal input to session in terminal mode', () => {
			const session = createMockSession({ inputMode: 'terminal' });
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			} as any);

			const deps = createMockDeps({
				sessionsRef: { current: [session] },
				activeSessionIdRef: { current: 'session-1' },
			});

			const { result } = renderHook(() => useInputHandlers(deps));

			act(() => {
				result.current.setInputValue('ls -la');
			});

			act(() => {
				result.current.handleMainPanelInputBlur();
			});

			expect(mockSyncTerminalInputToSession).toHaveBeenCalled();
		});
	});

	// ========================================================================
	// handleReplayMessage
	// ========================================================================

	describe('handleReplayMessage', () => {
		it('calls processInput via ref with text', () => {
			const { result } = renderHook(() => useInputHandlers(createMockDeps()));

			act(() => {
				result.current.handleReplayMessage('replay this');
			});

			// processInputRef is called via setTimeout
			act(() => {
				vi.runAllTimers();
			});

			expect(result.current.processInputRef.current).toBeDefined();
		});

		it('stages images before processing when provided', () => {
			const { result } = renderHook(() => useInputHandlers(createMockDeps()));

			act(() => {
				result.current.handleReplayMessage('describe these', ['img1.png', 'img2.png']);
			});

			// Check that images were staged
			const sessions = useSessionStore.getState().sessions;
			const tab = sessions[0].aiTabs.find((t: any) => t.id === 'tab-1');
			expect(tab?.stagedImages).toEqual(['img1.png', 'img2.png']);
		});

		it('does not stage images when array is empty', () => {
			const origStagedImages = ['keep-me.png'];
			useSessionStore.setState({
				sessions: [
					createMockSession({
						aiTabs: [
							{
								id: 'tab-1',
								name: 'Tab 1',
								inputValue: '',
								data: [],
								stagedImages: origStagedImages,
							} as any,
						],
					}),
				],
				activeSessionId: 'session-1',
			} as any);

			const { result } = renderHook(() => useInputHandlers(createMockDeps()));

			act(() => {
				result.current.handleReplayMessage('no images', []);
			});

			// Images should be unchanged (empty array doesn't trigger setStagedImages)
			const sessions = useSessionStore.getState().sessions;
			const tab = sessions[0].aiTabs.find((t: any) => t.id === 'tab-1');
			expect(tab?.stagedImages).toEqual(['keep-me.png']);
		});
	});

	// ========================================================================
	// handlePaste
	// ========================================================================

	describe('handlePaste', () => {
		it('trims whitespace from pasted text', () => {
			const { result } = renderHook(() => useInputHandlers(createMockDeps()));

			const mockPreventDefault = vi.fn();
			const mockTarget = {
				selectionStart: 0,
				selectionEnd: 0,
				value: '',
			};

			const pasteEvent = {
				preventDefault: mockPreventDefault,
				clipboardData: {
					items: [],
					getData: vi.fn().mockReturnValue('  trimmed text  '),
				},
				target: mockTarget,
			} as unknown as React.ClipboardEvent;

			// Patch items to be iterable
			Object.defineProperty(pasteEvent.clipboardData, 'items', {
				value: { length: 0, [Symbol.iterator]: function* () {} },
			});

			act(() => {
				result.current.handlePaste(pasteEvent);
			});

			expect(mockPreventDefault).toHaveBeenCalled();
			expect(result.current.inputValue).toBe('trimmed text');
		});

		it('does not intercept text paste when no trimming needed', () => {
			const { result } = renderHook(() => useInputHandlers(createMockDeps()));

			const mockPreventDefault = vi.fn();
			const pasteEvent = {
				preventDefault: mockPreventDefault,
				clipboardData: {
					items: { length: 0, [Symbol.iterator]: function* () {} },
					getData: vi.fn().mockReturnValue('no trim needed'),
				},
				target: { selectionStart: 0, selectionEnd: 0, value: '' },
			} as unknown as React.ClipboardEvent;

			act(() => {
				result.current.handlePaste(pasteEvent);
			});

			// Should NOT call preventDefault since no trimming was needed
			expect(mockPreventDefault).not.toHaveBeenCalled();
		});

		it('ignores image paste in terminal mode', () => {
			useSessionStore.setState({
				sessions: [createMockSession({ inputMode: 'terminal' })],
				activeSessionId: 'session-1',
			} as any);

			const { result } = renderHook(() => useInputHandlers(createMockDeps()));

			const mockItem = {
				type: 'image/png',
				getAsFile: vi.fn().mockReturnValue(new Blob(['data'], { type: 'image/png' })),
			};

			const pasteEvent = {
				preventDefault: vi.fn(),
				clipboardData: {
					items: {
						length: 1,
						0: mockItem,
						[Symbol.iterator]: function* () {
							yield mockItem;
						},
					},
					getData: vi.fn().mockReturnValue(''),
				},
			} as unknown as React.ClipboardEvent;

			act(() => {
				result.current.handlePaste(pasteEvent);
			});

			// Should not stage any images
			expect(result.current.stagedImages).toEqual([]);
		});
	});

	// ========================================================================
	// handleDrop
	// ========================================================================

	describe('handleDrop', () => {
		it('resets drag state on drop', () => {
			const deps = createMockDeps();
			deps.dragCounterRef.current = 3;
			const { result } = renderHook(() => useInputHandlers(deps));

			const dropEvent = {
				preventDefault: vi.fn(),
				dataTransfer: {
					files: { length: 0 } as any,
				},
			} as unknown as React.DragEvent;

			act(() => {
				result.current.handleDrop(dropEvent);
			});

			expect(deps.dragCounterRef.current).toBe(0);
			expect(deps.setIsDraggingImage).toHaveBeenCalledWith(false);
		});

		it('ignores drops in terminal mode', () => {
			useSessionStore.setState({
				sessions: [createMockSession({ inputMode: 'terminal' })],
				activeSessionId: 'session-1',
			} as any);

			const deps = createMockDeps();
			const { result } = renderHook(() => useInputHandlers(deps));

			const dropEvent = {
				preventDefault: vi.fn(),
				dataTransfer: {
					files: {
						length: 1,
						0: { type: 'image/png' },
					} as any,
				},
			} as unknown as React.DragEvent;

			act(() => {
				result.current.handleDrop(dropEvent);
			});

			// No images should be staged
			expect(result.current.stagedImages).toEqual([]);
		});

		it('accepts image drops in group chat mode', () => {
			const mockSetGroupChatStagedImages = vi.fn();
			useGroupChatStore.setState({
				activeGroupChatId: 'group-1',
				setGroupChatStagedImages: mockSetGroupChatStagedImages,
			} as any);

			const deps = createMockDeps();
			const { result } = renderHook(() => useInputHandlers(deps));

			// Create a mock file with FileReader support
			const mockFile = new Blob(['mock-image-data'], { type: 'image/png' });
			Object.defineProperty(mockFile, 'type', { value: 'image/png' });

			const dropEvent = {
				preventDefault: vi.fn(),
				dataTransfer: {
					files: {
						length: 1,
						0: mockFile,
					} as any,
				},
			} as unknown as React.DragEvent;

			act(() => {
				result.current.handleDrop(dropEvent);
			});

			// The drop handler creates a FileReader — just verify it doesn't throw
			expect(dropEvent.preventDefault).toHaveBeenCalled();
		});
	});

	// ========================================================================
	// processInputRef
	// ========================================================================

	describe('processInputRef', () => {
		it('processInputRef tracks processInput function', () => {
			const { result } = renderHook(() => useInputHandlers(createMockDeps()));
			expect(result.current.processInputRef.current).toBeDefined();
			expect(typeof result.current.processInputRef.current).toBe('function');
		});
	});

	// ========================================================================
	// handleInputKeyDown delegation
	// ========================================================================

	describe('handleInputKeyDown', () => {
		it('delegates to useInputKeyDown hook', () => {
			const { result } = renderHook(() => useInputHandlers(createMockDeps()));
			expect(result.current.handleInputKeyDown).toBe(mockHandleInputKeyDown);
		});
	});

	// ========================================================================
	// Return value stability
	// ========================================================================

	describe('return stability', () => {
		it('maintains stable handler references across rerenders', () => {
			const { result, rerender } = renderHook(() => useInputHandlers(createMockDeps()));

			const firstRender = {
				handleInputKeyDown: result.current.handleInputKeyDown,
				handleMainPanelInputBlur: result.current.handleMainPanelInputBlur,
				handleReplayMessage: result.current.handleReplayMessage,
				syncFileTreeToTabCompletion: result.current.syncFileTreeToTabCompletion,
			};

			rerender();

			expect(result.current.handleInputKeyDown).toBe(firstRender.handleInputKeyDown);
			expect(result.current.handleMainPanelInputBlur).toBe(firstRender.handleMainPanelInputBlur);
			expect(result.current.handleReplayMessage).toBe(firstRender.handleReplayMessage);
			expect(result.current.syncFileTreeToTabCompletion).toBe(
				firstRender.syncFileTreeToTabCompletion
			);
		});

		it('maintains stable processInputRef across rerenders', () => {
			const { result, rerender } = renderHook(() => useInputHandlers(createMockDeps()));
			const ref1 = result.current.processInputRef;
			rerender();
			expect(result.current.processInputRef).toBe(ref1);
		});
	});

	// ========================================================================
	// Input state edge cases
	// ========================================================================

	describe('input state edge cases', () => {
		it('setInputValue when no active session does not throw', () => {
			useSessionStore.setState({
				sessions: [],
				activeSessionId: null,
			} as any);

			const { result } = renderHook(() => useInputHandlers(createMockDeps()));

			expect(() => {
				act(() => {
					result.current.setInputValue('hello');
				});
			}).not.toThrow();
		});

		it('inputValue returns terminal draft input when in terminal mode', () => {
			const session = createMockSession({
				inputMode: 'terminal',
				terminalDraftInput: 'saved terminal cmd',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
			} as any);

			const { result } = renderHook(() => useInputHandlers(createMockDeps()));

			// Terminal input starts as '' from local state (session switching loads it)
			// Set it explicitly to verify the mode routing
			act(() => {
				result.current.setInputValue('terminal text');
			});

			expect(result.current.inputValue).toBe('terminal text');
		});
	});

	// ========================================================================
	// Staged images edge cases
	// ========================================================================

	describe('staged images edge cases', () => {
		it('setStagedImages when no active session returns early (no-op)', () => {
			useSessionStore.setState({
				sessions: [],
				activeSessionId: null,
			} as any);

			const { result } = renderHook(() => useInputHandlers(createMockDeps()));

			// Should not throw and should not modify store
			expect(() => {
				act(() => {
					result.current.setStagedImages(['new-image.png']);
				});
			}).not.toThrow();

			// Sessions remain empty
			expect(useSessionStore.getState().sessions).toEqual([]);
		});

		it('stagedImages returns empty when session has no matching active tab', () => {
			useSessionStore.setState({
				sessions: [
					createMockSession({
						aiTabs: [],
						activeTabId: 'nonexistent-tab',
					}),
				],
				activeSessionId: 'session-1',
			} as any);

			const { result } = renderHook(() => useInputHandlers(createMockDeps()));
			expect(result.current.stagedImages).toEqual([]);
		});
	});

	// ========================================================================
	// Tab switching edge cases
	// ========================================================================

	describe('tab switching edge cases', () => {
		it('clears hasUnread when switching to a tab that has hasUnread=true', () => {
			useSessionStore.setState({
				sessions: [
					createMockSession({
						aiTabs: [
							{
								id: 'tab-1',
								name: 'Tab 1',
								inputValue: '',
								data: [],
								stagedImages: [],
							} as any,
							{
								id: 'tab-2',
								name: 'Tab 2',
								inputValue: '',
								data: [],
								stagedImages: [],
								hasUnread: true,
							} as any,
						],
						activeTabId: 'tab-1',
					}),
				],
				activeSessionId: 'session-1',
			} as any);

			const { result, rerender } = renderHook(() => useInputHandlers(createMockDeps()));

			// Switch to tab-2 which has hasUnread=true
			act(() => {
				useSessionStore.setState({
					sessions: [
						createMockSession({
							aiTabs: [
								{
									id: 'tab-1',
									name: 'Tab 1',
									inputValue: '',
									data: [],
									stagedImages: [],
								} as any,
								{
									id: 'tab-2',
									name: 'Tab 2',
									inputValue: '',
									data: [],
									stagedImages: [],
									hasUnread: true,
								} as any,
							],
							activeTabId: 'tab-2',
						}),
					],
					activeSessionId: 'session-1',
				} as any);
			});

			rerender();

			// hasUnread should be cleared on tab-2
			const sessions = useSessionStore.getState().sessions;
			const tab2 = sessions[0].aiTabs.find((t: any) => t.id === 'tab-2');
			expect(tab2?.hasUnread).toBe(false);
		});

		it('handles switching when target tab has no inputValue property (defaults to empty)', () => {
			useSessionStore.setState({
				sessions: [
					createMockSession({
						aiTabs: [
							{
								id: 'tab-1',
								name: 'Tab 1',
								inputValue: 'some text',
								data: [],
								stagedImages: [],
							} as any,
							{
								id: 'tab-2',
								name: 'Tab 2',
								data: [],
								stagedImages: [],
								// inputValue intentionally omitted
							} as any,
						],
						activeTabId: 'tab-1',
					}),
				],
				activeSessionId: 'session-1',
			} as any);

			const { result, rerender } = renderHook(() => useInputHandlers(createMockDeps()));

			// Type in tab-1
			act(() => {
				result.current.setInputValue('tab1 content');
			});

			// Switch to tab-2 (no inputValue property)
			act(() => {
				useSessionStore.setState({
					sessions: [
						createMockSession({
							aiTabs: [
								{
									id: 'tab-1',
									name: 'Tab 1',
									inputValue: 'some text',
									data: [],
									stagedImages: [],
								} as any,
								{
									id: 'tab-2',
									name: 'Tab 2',
									data: [],
									stagedImages: [],
								} as any,
							],
							activeTabId: 'tab-2',
						}),
					],
					activeSessionId: 'session-1',
				} as any);
			});

			rerender();

			// Should default to empty string
			expect(result.current.inputValue).toBe('');
		});
	});

	// ========================================================================
	// Session switching edge cases
	// ========================================================================

	describe('session switching edge cases', () => {
		it('saves current terminal input to previous session terminalDraftInput on session switch', () => {
			const session1 = createMockSession({
				id: 'session-1',
				inputMode: 'terminal',
				terminalDraftInput: '',
			});
			const session2 = createMockSession({
				id: 'session-2',
				inputMode: 'terminal',
				terminalDraftInput: '',
			});

			useSessionStore.setState({
				sessions: [session1, session2],
				activeSessionId: 'session-1',
			} as any);

			const deps = createMockDeps();
			const { result, rerender } = renderHook(() => useInputHandlers(deps));

			// Type terminal input while on session-1
			act(() => {
				result.current.setInputValue('my command');
			});

			// Switch to session-2
			act(() => {
				useSessionStore.setState({
					sessions: [session1, session2],
					activeSessionId: 'session-2',
				} as any);
			});

			rerender();

			// Verify session-1 now has the typed terminal input saved
			const sessions = useSessionStore.getState().sessions;
			const s1 = sessions.find((s: any) => s.id === 'session-1');
			expect(s1?.terminalDraftInput).toBe('my command');
		});

		it('saves empty terminal input on session switch (persists cleared input)', () => {
			const session1 = createMockSession({
				id: 'session-1',
				inputMode: 'terminal',
				terminalDraftInput: 'previously saved',
			});
			const session2 = createMockSession({
				id: 'session-2',
				inputMode: 'terminal',
				terminalDraftInput: '',
			});

			useSessionStore.setState({
				sessions: [session1, session2],
				activeSessionId: 'session-1',
			} as any);

			const deps = createMockDeps();
			const { rerender } = renderHook(() => useInputHandlers(deps));

			// Do NOT type anything (terminal input remains empty '')

			// Switch to session-2
			act(() => {
				useSessionStore.setState({
					sessions: [session1, session2],
					activeSessionId: 'session-2',
				} as any);
			});

			rerender();

			// Session-1 terminalDraftInput should be overwritten with '' (cleared input is persisted)
			const sessions = useSessionStore.getState().sessions;
			const s1 = sessions.find((s: any) => s.id === 'session-1');
			expect(s1?.terminalDraftInput).toBe('');
		});
	});

	// ========================================================================
	// handlePaste edge cases
	// ========================================================================

	describe('handlePaste edge cases', () => {
		it('stages image on active tab when pasting image in AI mode', () => {
			// Mock FileReader
			const mockReadAsDataURL = vi.fn();
			const originalFileReader = global.FileReader;

			class MockFileReaderLocal {
				result: string | null = null;
				onload: ((ev: any) => void) | null = null;
				readAsDataURL = vi.fn(function (this: MockFileReaderLocal) {
					this.result = 'data:image/png;base64,mockImageData';
					if (this.onload) {
						this.onload({ target: { result: this.result } });
					}
				});
			}
			global.FileReader = MockFileReaderLocal as unknown as typeof FileReader;

			try {
				const { result } = renderHook(() => useInputHandlers(createMockDeps()));

				const mockBlob = new Blob(['image-data'], { type: 'image/png' });
				const mockItem = {
					type: 'image/png',
					getAsFile: vi.fn().mockReturnValue(mockBlob),
				};

				const pasteEvent = {
					preventDefault: vi.fn(),
					clipboardData: {
						items: {
							length: 1,
							0: mockItem,
							[Symbol.iterator]: function* () {
								yield mockItem;
							},
						},
						getData: vi.fn().mockReturnValue(''),
					},
				} as unknown as React.ClipboardEvent;

				act(() => {
					result.current.handlePaste(pasteEvent);
				});

				expect(pasteEvent.preventDefault).toHaveBeenCalled();

				// Verify image was staged on the active tab
				const sessions = useSessionStore.getState().sessions;
				const tab = sessions[0].aiTabs.find((t: any) => t.id === 'tab-1');
				expect(tab?.stagedImages).toContain('data:image/png;base64,mockImageData');
			} finally {
				global.FileReader = originalFileReader;
			}
		});

		it('stages image in group chat store when pasting image during active group chat', () => {
			const mockSetGroupChatStagedImages = vi.fn().mockImplementation((updater: any) => {
				if (typeof updater === 'function') {
					updater([]);
				}
			});
			useGroupChatStore.setState({
				activeGroupChatId: 'group-1',
				setGroupChatStagedImages: mockSetGroupChatStagedImages,
			} as any);

			// Mock FileReader
			const originalFileReader = global.FileReader;
			class MockFileReaderLocal {
				result: string | null = null;
				onload: ((ev: any) => void) | null = null;
				readAsDataURL = vi.fn(function (this: MockFileReaderLocal) {
					this.result = 'data:image/png;base64,groupChatImage';
					if (this.onload) {
						this.onload({ target: { result: this.result } });
					}
				});
			}
			global.FileReader = MockFileReaderLocal as unknown as typeof FileReader;

			try {
				const { result } = renderHook(() => useInputHandlers(createMockDeps()));

				const mockBlob = new Blob(['image-data'], { type: 'image/png' });
				const mockItem = {
					type: 'image/png',
					getAsFile: vi.fn().mockReturnValue(mockBlob),
				};

				const pasteEvent = {
					preventDefault: vi.fn(),
					clipboardData: {
						items: {
							length: 1,
							0: mockItem,
							[Symbol.iterator]: function* () {
								yield mockItem;
							},
						},
						getData: vi.fn().mockReturnValue(''),
					},
				} as unknown as React.ClipboardEvent;

				act(() => {
					result.current.handlePaste(pasteEvent);
				});

				expect(pasteEvent.preventDefault).toHaveBeenCalled();
				expect(mockSetGroupChatStagedImages).toHaveBeenCalled();
			} finally {
				global.FileReader = originalFileReader;
			}
		});

		it('does not call preventDefault for text paste with no whitespace to trim', () => {
			const { result } = renderHook(() => useInputHandlers(createMockDeps()));

			const mockPreventDefault = vi.fn();
			const pasteEvent = {
				preventDefault: mockPreventDefault,
				clipboardData: {
					items: { length: 0, [Symbol.iterator]: function* () {} },
					getData: vi.fn().mockReturnValue('no-whitespace'),
				},
				target: { selectionStart: 0, selectionEnd: 0, value: '' },
			} as unknown as React.ClipboardEvent;

			act(() => {
				result.current.handlePaste(pasteEvent);
			});

			expect(mockPreventDefault).not.toHaveBeenCalled();
		});
	});

	// ========================================================================
	// handleDrop edge cases
	// ========================================================================

	describe('handleDrop edge cases', () => {
		it('ignores drop with non-image file types', () => {
			const deps = createMockDeps();
			const { result } = renderHook(() => useInputHandlers(deps));

			const dropEvent = {
				preventDefault: vi.fn(),
				dataTransfer: {
					files: {
						length: 2,
						0: { type: 'application/pdf', name: 'doc.pdf' },
						1: { type: 'text/plain', name: 'readme.txt' },
					} as any,
				},
			} as unknown as React.DragEvent;

			act(() => {
				result.current.handleDrop(dropEvent);
			});

			// preventDefault is always called (for drag cleanup)
			expect(dropEvent.preventDefault).toHaveBeenCalled();
			// But no images should be staged
			const sessions = useSessionStore.getState().sessions;
			const tab = sessions[0].aiTabs.find((t: any) => t.id === 'tab-1');
			expect(tab?.stagedImages).toEqual([]);
		});

		it('processes all image files when dropping multiple images', () => {
			const originalFileReader = global.FileReader;
			let readerCount = 0;

			class MockFileReaderLocal {
				result: string | null = null;
				onload: ((ev: any) => void) | null = null;
				readAsDataURL = vi.fn(function (this: MockFileReaderLocal) {
					readerCount++;
					const idx = readerCount;
					this.result = `data:image/png;base64,image${idx}Data`;
					if (this.onload) {
						this.onload({ target: { result: this.result } });
					}
				});
			}
			global.FileReader = MockFileReaderLocal as unknown as typeof FileReader;

			try {
				const deps = createMockDeps();
				const { result } = renderHook(() => useInputHandlers(deps));

				const dropEvent = {
					preventDefault: vi.fn(),
					dataTransfer: {
						files: {
							length: 2,
							0: { type: 'image/png', name: 'img1.png' },
							1: { type: 'image/jpeg', name: 'img2.jpg' },
						} as any,
					},
				} as unknown as React.DragEvent;

				act(() => {
					result.current.handleDrop(dropEvent);
				});

				// Both images should have been processed
				const sessions = useSessionStore.getState().sessions;
				const tab = sessions[0].aiTabs.find((t: any) => t.id === 'tab-1');
				expect(tab?.stagedImages).toHaveLength(2);
				expect(tab?.stagedImages).toContain('data:image/png;base64,image1Data');
				expect(tab?.stagedImages).toContain('data:image/png;base64,image2Data');
			} finally {
				global.FileReader = originalFileReader;
			}
		});
	});

	// ========================================================================
	// handleReplayMessage edge cases
	// ========================================================================

	describe('handleReplayMessage edge cases', () => {
		it('does not call setStagedImages when images parameter is undefined', () => {
			const { result } = renderHook(() => useInputHandlers(createMockDeps()));

			// Set initial staged images
			act(() => {
				result.current.setStagedImages(['existing.png']);
			});

			act(() => {
				result.current.handleReplayMessage('replay without images');
			});

			// Staged images should remain unchanged
			const sessions = useSessionStore.getState().sessions;
			const tab = sessions[0].aiTabs.find((t: any) => t.id === 'tab-1');
			expect(tab?.stagedImages).toEqual(['existing.png']);
		});

		it('preserves draft input value after replay sends', () => {
			const { result } = renderHook(() => useInputHandlers(createMockDeps()));

			// Type a draft message
			act(() => {
				result.current.setInputValue('my draft message');
			});

			expect(result.current.inputValue).toBe('my draft message');

			// Simulate processInput clearing the input (as it does in real usage)
			mockProcessInput.mockImplementation(() => {
				result.current.setInputValue('');
			});

			// Replay a previous message
			act(() => {
				result.current.handleReplayMessage('replayed message');
			});

			act(() => {
				vi.runAllTimers();
			});

			// Draft should be restored after replay
			expect(result.current.inputValue).toBe('my draft message');
			expect(mockProcessInput).toHaveBeenCalledWith('replayed message');

			// Clean up mock
			mockProcessInput.mockReset();
		});
	});

	// ========================================================================
	// syncFileTreeToTabCompletion edge cases
	// ========================================================================

	describe('syncFileTreeToTabCompletion edge cases', () => {
		it('switches right bar to files tab when not already on files tab', () => {
			const mockSetActiveRightTab = vi.fn();
			const mockSetSelectedFileIndex = vi.fn();

			useUIStore.setState({
				activeRightTab: 'history',
				setActiveRightTab: mockSetActiveRightTab,
			} as any);

			useFileExplorerStore.setState({
				flatFileList: [{ fullPath: 'src', name: 'src', isDirectory: true, depth: 0 }],
				setSelectedFileIndex: mockSetSelectedFileIndex,
			} as any);

			const deps = createMockDeps();
			const { result } = renderHook(() => useInputHandlers(deps));

			act(() => {
				result.current.syncFileTreeToTabCompletion({
					type: 'directory',
					value: 'src/',
					display: 'src/',
				} as any);
			});

			expect(mockSetSelectedFileIndex).toHaveBeenCalledWith(0);
			expect(mockSetActiveRightTab).toHaveBeenCalledWith('files');
		});

		it('sets fileTreeKeyboardNavRef to true when matching file found', () => {
			const mockSetSelectedFileIndex = vi.fn();

			useFileExplorerStore.setState({
				flatFileList: [
					{ fullPath: 'package.json', name: 'package.json', isDirectory: false, depth: 0 },
				],
				setSelectedFileIndex: mockSetSelectedFileIndex,
			} as any);

			const deps = createMockDeps();
			deps.fileTreeKeyboardNavRef.current = false;
			const { result } = renderHook(() => useInputHandlers(deps));

			act(() => {
				result.current.syncFileTreeToTabCompletion({
					type: 'file',
					value: 'package.json',
					display: 'package.json',
				} as any);
			});

			expect(deps.fileTreeKeyboardNavRef.current).toBe(true);
			expect(mockSetSelectedFileIndex).toHaveBeenCalledWith(0);
		});
	});
});
