// Source: src/__tests__/renderer/hooks/useInputHandlersDraftOwnership.test.ts
// Source: src/__tests__/renderer/hooks/useDraftPersistence.test.ts
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import { afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { act } from '@testing-library/react';
import { cleanup } from '@testing-library/react';
import type { Session } from '../../../renderer/types';
import type { BatchRunState } from '../../../renderer/types';
import { createMockSession as baseCreateMockSession } from '../../helpers/mockSession';
import { useInputHandlers } from '../../../renderer/hooks/input/useInputHandlers';
import type { UseInputHandlersDeps } from '../../../renderer/hooks/input/useInputHandlers';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useComposerInputStore } from '../../../renderer/stores/composerInputStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { useGroupChatStore } from '../../../renderer/stores/groupChatStore';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { useFileExplorerStore } from '../../../renderer/stores/fileExplorerStore';
import { useDraftPersistence } from '../../../renderer/hooks/input/useDraftPersistence';
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
const mockSyncAiInputToSession = vi.fn();
const mockQueueAiDraftFlush = vi.fn();
const mockSyncTerminalInputToSession = vi.fn();
vi.mock('../../../renderer/contexts/InputContext', () => ({
	useInputContext: () => mockInputContext,
}));
vi.mock('../../../renderer/hooks/input/useInputSync', () => ({
	useInputSync: vi.fn(() => ({
		syncAiInputToSession: mockSyncAiInputToSession,
		queueAiDraftFlush: mockQueueAiDraftFlush,
		syncTerminalInputToSession: mockSyncTerminalInputToSession,
	})),
}));
vi.mock('../../../renderer/hooks/input/useTabCompletion', () => ({
	useTabCompletion: vi.fn(() => ({ getSuggestions: vi.fn().mockReturnValue([]) })),
}));
vi.mock('../../../renderer/hooks/input/useAtMentionCompletion', () => ({
	useAtMentionCompletion: vi.fn(() => ({ getSuggestions: vi.fn().mockReturnValue([]) })),
}));
vi.mock('../../../renderer/hooks/input/useInputProcessing', () => ({
	useInputProcessing: vi.fn(() => ({ processInput: vi.fn(), processInputRef: { current: null } })),
	DEFAULT_IMAGE_ONLY_PROMPT: 'Describe this image',
}));
vi.mock('../../../renderer/hooks/input/useInputKeyDown', () => ({
	useInputKeyDown: vi.fn(() => ({ handleInputKeyDown: vi.fn() })),
}));
vi.mock('../../../renderer/hooks/utils', () => ({
	useDebouncedValue: vi.fn((value: string) => value),
}));
vi.mock('../../../renderer/stores/centerFlashStore', () => ({ notifyCenterFlash: vi.fn() }));
describe('useInputHandlersDraftOwnership', () => {
	function createDefaultBatchState(): BatchRunState {
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
		} as any;
	}

	function createMockDeps(overrides: Partial<UseInputHandlersDeps> = {}): UseInputHandlersDeps {
		return {
			inputRef: { current: { focus: vi.fn(), blur: vi.fn() } } as any,
			terminalOutputRef: { current: { focus: vi.fn() } } as any,
			fileTreeKeyboardNavRef: { current: false },
			dragCounterRef: { current: 0 },
			setIsDraggingFile: vi.fn(),
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
			activeSessionIdRef: { current: 'session-a' },
			...overrides,
		};
	}

	const agentA = (): Session =>
		baseCreateMockSession({
			id: 'session-a',
			name: 'Agent A',
			aiTabs: [{ id: 'a1', name: 'A1', inputValue: '', data: [], stagedImages: [] }] as any,
			activeTabId: 'a1',
			inputMode: 'ai',
		} as any);

	/** Agent B mid-flight: a file tab is open but it has no AI tab (a legal state). */
	const agentBWithoutAiTabs = (): Session =>
		baseCreateMockSession({
			id: 'session-b',
			name: 'Agent B',
			aiTabs: [] as any,
			activeTabId: null as any,
			inputMode: 'ai',
		} as any);

	const agentB = (inputValue = ''): Session =>
		baseCreateMockSession({
			id: 'session-b',
			name: 'Agent B',
			aiTabs: [{ id: 'b1', name: 'B1', inputValue, data: [], stagedImages: [] }] as any,
			activeTabId: 'b1',
			inputMode: 'ai',
		} as any);

	/** Writes of real text (not the empty-string clears) aimed at a given tab. */
	const textWrittenTo = (tabId: string): string[] => [
		...mockSyncAiInputToSession.mock.calls
			.filter(([value, target]) => target === tabId && String(value).trim() !== '')
			.map(([value]) => String(value)),
		...mockQueueAiDraftFlush.mock.calls
			.filter(([target, value]) => target === tabId && String(value).trim() !== '')
			.map(([, value]) => String(value)),
	];

	beforeEach(() => {
		vi.clearAllMocks();
		useComposerInputStore.setState({
			aiValue: '',
			aiValueTabId: null,
			terminalValue: '',
			aiCommandMode: 'off',
		});
		useSessionStore.setState({ sessions: [agentA()], activeSessionId: 'session-a' } as any);
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
		useFileExplorerStore.setState({ flatFileList: [], setSelectedFileIndex: vi.fn() } as any);
	});

	afterEach(() => cleanup());

	describe('composer draft ownership', () => {
		it('attributes typing to the active tab on an ordinary agent switch', () => {
			renderHook(() => useInputHandlers(createMockDeps()));

			act(() => {
				useSessionStore.setState({
					sessions: [agentA(), agentB()],
					activeSessionId: 'session-b',
				} as any);
			});
			act(() => {
				useComposerInputStore.getState().setAiValue('typed on B');
			});

			expect(textWrittenTo('b1')).toContain('typed on B');
			expect(textWrittenTo('a1')).toEqual([]);
		});

		it('does not file text on the previous agent when the new one has no AI tab yet', () => {
			renderHook(() => useInputHandlers(createMockDeps()));

			// Land on an agent with a file tab open and no AI tab.
			act(() => {
				useSessionStore.setState({
					sessions: [agentA(), agentBWithoutAiTabs()],
					activeSessionId: 'session-b',
				} as any);
			});
			act(() => {
				useComposerInputStore.getState().setAiValue('half a thought');
			});
			// Its AI tab materializes.
			act(() => {
				useSessionStore.setState({
					sessions: [agentA(), agentB()],
					activeSessionId: 'session-b',
				} as any);
			});

			expect(textWrittenTo('a1')).toEqual([]);
			// The text the user typed is not thrown away: the tab adopts it.
			expect(useComposerInputStore.getState().aiValue).toBe('half a thought');
			expect(useComposerInputStore.getState().aiValueTabId).toBe('b1');
		});

		it('does not file text on sessions[0] while activeSessionId runs ahead of the store', () => {
			renderHook(() => useInputHandlers(createMockDeps()));

			// A freshly created agent is active before its session object lands, so
			// selectActiveSession falls back to sessions[0] - a different agent.
			act(() => {
				useSessionStore.setState({ sessions: [agentA()], activeSessionId: 'session-b' } as any);
			});
			act(() => {
				useComposerInputStore.getState().setAiValue('typed for the new agent');
			});
			act(() => {
				useSessionStore.setState({
					sessions: [agentA(), agentB()],
					activeSessionId: 'session-b',
				} as any);
			});

			expect(textWrittenTo('a1')).toEqual([]);
			expect(useComposerInputStore.getState().aiValue).toBe('typed for the new agent');
			expect(useComposerInputStore.getState().aiValueTabId).toBe('b1');
		});

		it('keeps the incoming tab own draft rather than overwriting it with orphan text', () => {
			renderHook(() => useInputHandlers(createMockDeps()));

			act(() => {
				useSessionStore.setState({
					sessions: [agentA(), agentBWithoutAiTabs()],
					activeSessionId: 'session-b',
				} as any);
			});
			act(() => {
				useComposerInputStore.getState().setAiValue('orphan text');
			});
			act(() => {
				useSessionStore.setState({
					sessions: [agentA(), agentB('B already had a draft')],
					activeSessionId: 'session-b',
				} as any);
			});

			expect(useComposerInputStore.getState().aiValue).toBe('B already had a draft');
			expect(useComposerInputStore.getState().aiValueTabId).toBe('b1');
			expect(textWrittenTo('a1')).toEqual([]);
		});

		it('flushes a draft to its owner, not to the tab that happens to be active', () => {
			renderHook(() => useInputHandlers(createMockDeps()));

			act(() => {
				useComposerInputStore.getState().setAiValue('belongs to a1');
			});
			act(() => {
				useSessionStore.setState({
					sessions: [agentA(), agentB()],
					activeSessionId: 'session-b',
				} as any);
			});

			expect(textWrittenTo('a1')).toContain('belongs to a1');
			expect(textWrittenTo('b1')).toEqual([]);
		});
	});
});
describe('useDraftPersistence', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('useDraftPersistence - queueFlush', () => {
		it('writes the queued value back after the delay, without any explicit flush', () => {
			const onPersist = vi.fn();
			const { result } = renderHook(() => useDraftPersistence<string>(onPersist, 300));

			result.current.queueFlush('key-1', 'never blurred');
			expect(onPersist).not.toHaveBeenCalled();

			vi.advanceTimersByTime(300);

			expect(onPersist).toHaveBeenCalledExactlyOnceWith('key-1', 'never blurred');
		});

		it('coalesces a burst of calls for the same key into one write', () => {
			const onPersist = vi.fn();
			const { result } = renderHook(() => useDraftPersistence<string>(onPersist, 300));

			for (const text of ['n', 'ne', 'nev', 'neve', 'never']) {
				result.current.queueFlush('key-1', text);
			}
			vi.advanceTimersByTime(300);

			expect(onPersist).toHaveBeenCalledTimes(1);
			expect(onPersist).toHaveBeenCalledWith('key-1', 'never');
		});

		it('resets the delay on continued typing, writing once after typing actually stops', () => {
			// A burst of calls all fired at t=0 (the test above) can't tell a true
			// trailing-edge debounce from a naive "arm one timer and let it fire on
			// schedule" bug: both write once. Spacing the calls out is what catches
			// it - a timer that isn't reset on every keystroke fires partway through
			// continuous typing instead of once after it stops.
			const onPersist = vi.fn();
			const { result } = renderHook(() => useDraftPersistence<string>(onPersist, 300));

			result.current.queueFlush('key-1', 'n');
			vi.advanceTimersByTime(200);
			expect(onPersist).not.toHaveBeenCalled();

			result.current.queueFlush('key-1', 'ne');
			vi.advanceTimersByTime(200);
			expect(onPersist).not.toHaveBeenCalled();

			result.current.queueFlush('key-1', 'nev');
			vi.advanceTimersByTime(200);
			expect(onPersist).not.toHaveBeenCalled();

			// Typing has now stopped; only after a full 300ms of silence does it write.
			vi.advanceTimersByTime(100);
			expect(onPersist).toHaveBeenCalledExactlyOnceWith('key-1', 'nev');
		});

		it('flushes the previous key immediately when a different key is queued', () => {
			// The guarantee this exists for: switching drafting targets mid-debounce
			// (a tab, a chat) must not drop what was typed for the one being left.
			const onPersist = vi.fn();
			const { result } = renderHook(() => useDraftPersistence<string>(onPersist, 300));

			result.current.queueFlush('key-1', 'first key text');
			result.current.queueFlush('key-2', 'second key text');

			// The first key's write already landed, synchronously, on the switch.
			expect(onPersist).toHaveBeenCalledExactlyOnceWith('key-1', 'first key text');

			vi.advanceTimersByTime(300);

			expect(onPersist).toHaveBeenCalledTimes(2);
			expect(onPersist).toHaveBeenNthCalledWith(2, 'key-2', 'second key text');
		});
	});

	describe('useDraftPersistence - flushNow', () => {
		it('persists immediately and cancels any pending queued write for that key', () => {
			const onPersist = vi.fn();
			const { result } = renderHook(() => useDraftPersistence<string>(onPersist, 300));

			result.current.queueFlush('key-1', 'about to be sent');
			result.current.flushNow('key-1', '');
			vi.advanceTimersByTime(300);

			// Only the explicit, immediate write happened - the stale queued value
			// never lands after it.
			expect(onPersist).toHaveBeenCalledExactlyOnceWith('key-1', '');
		});
	});

	describe('useDraftPersistence - flushPending / cancelPending', () => {
		it('flushPending applies whatever is queued right now', () => {
			const onPersist = vi.fn();
			const { result } = renderHook(() => useDraftPersistence<string>(onPersist, 300));

			result.current.queueFlush('key-1', 'mid sentence');
			result.current.flushPending();

			expect(onPersist).toHaveBeenCalledExactlyOnceWith('key-1', 'mid sentence');

			// The timer that would have fired the same write again must be gone too.
			vi.advanceTimersByTime(300);
			expect(onPersist).toHaveBeenCalledTimes(1);
		});

		it('flushPending is a no-op when nothing is queued', () => {
			const onPersist = vi.fn();
			const { result } = renderHook(() => useDraftPersistence<string>(onPersist, 300));

			result.current.flushPending();

			expect(onPersist).not.toHaveBeenCalled();
		});

		it('cancelPending discards the queued write without persisting it', () => {
			const onPersist = vi.fn();
			const { result } = renderHook(() => useDraftPersistence<string>(onPersist, 300));

			result.current.queueFlush('key-1', 'never mind');
			result.current.cancelPending();
			vi.advanceTimersByTime(300);

			expect(onPersist).not.toHaveBeenCalled();
		});
	});

	describe('useDraftPersistence - unmount', () => {
		it('flushes a pending draft on unmount rather than dropping it', () => {
			const onPersist = vi.fn();
			const { result, unmount } = renderHook(() => useDraftPersistence<string>(onPersist, 300));

			result.current.queueFlush('key-1', 'unsaved at unmount');
			unmount();

			expect(onPersist).toHaveBeenCalledExactlyOnceWith('key-1', 'unsaved at unmount');
		});
	});
});
