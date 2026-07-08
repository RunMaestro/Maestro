import { act, cleanup, renderHook } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const inputSyncMock = vi.hoisted(() => ({
	syncAiInputToSession: vi.fn(),
	syncTerminalInputToSession: vi.fn(),
}));

const completionMock = vi.hoisted(() => ({
	getTabSuggestions: vi.fn(),
	getAtMentionSuggestions: vi.fn(),
}));

const processingMock = vi.hoisted(() => ({
	processInput: vi.fn(),
}));

const keyDownMock = vi.hoisted(() => ({
	handleInputKeyDown: vi.fn(),
}));

vi.mock('../../renderer/hooks/utils', async () => {
	const actual = await vi.importActual<typeof import('../../renderer/hooks/utils')>(
		'../../renderer/hooks/utils'
	);
	return {
		...actual,
		useDebouncedValue: <T,>(value: T) => value,
	};
});

vi.mock('../../renderer/hooks/input/useInputSync', () => ({
	useInputSync: vi.fn(() => ({
		syncAiInputToSession: inputSyncMock.syncAiInputToSession,
		syncTerminalInputToSession: inputSyncMock.syncTerminalInputToSession,
	})),
}));

vi.mock('../../renderer/hooks/input/useTabCompletion', () => ({
	useTabCompletion: vi.fn(() => ({
		getSuggestions: completionMock.getTabSuggestions,
	})),
}));

vi.mock('../../renderer/hooks/input/useAtMentionCompletion', () => ({
	useAtMentionCompletion: vi.fn(() => ({
		getSuggestions: completionMock.getAtMentionSuggestions,
	})),
}));

vi.mock('../../renderer/hooks/input/useInputProcessing', () => ({
	useInputProcessing: vi.fn(() => ({
		processInput: processingMock.processInput,
		processInputRef: { current: processingMock.processInput },
	})),
}));

vi.mock('../../renderer/hooks/input/useInputKeyDown', () => ({
	useInputKeyDown: vi.fn(() => ({
		handleInputKeyDown: keyDownMock.handleInputKeyDown,
	})),
}));

import { InputProvider, useInputContext } from '../../renderer/contexts/InputContext';
import {
	useInputHandlers,
	type UseInputHandlersDeps,
} from '../../renderer/hooks/input/useInputHandlers';
import { useCenterFlashStore } from '../../renderer/stores/centerFlashStore';
import { useFileExplorerStore } from '../../renderer/stores/fileExplorerStore';
import { useGroupChatStore } from '../../renderer/stores/groupChatStore';
import { useSessionStore } from '../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../renderer/stores/settingsStore';
import { useUIStore } from '../../renderer/stores/uiStore';
import type { AITab, BatchRunState, QueuedItem, Session } from '../../renderer/types';

const imageData = 'data:image/png;base64,aW50ZWdyYXRpb24=';

function aiTab(overrides: Partial<AITab> = {}): AITab {
	return {
		id: 'tab-a',
		agentSessionId: null,
		name: 'Tab A',
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: 1000,
		state: 'idle',
		hasUnread: false,
		isAtBottom: true,
		saveToHistory: true,
		showThinking: 'off',
		...overrides,
	};
}

function session(overrides: Partial<Session> = {}): Session {
	const aiTabs = overrides.aiTabs ?? [aiTab()];
	const activeTabId = overrides.activeTabId ?? aiTabs[0]?.id ?? '';
	return {
		id: 'session-a',
		name: 'Input Session',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/repo',
		fullPath: '/repo',
		projectRoot: '/repo',
		createdAt: 1000,
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
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs,
		activeTabId,
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: aiTabs.map((tab) => ({ type: 'ai' as const, id: tab.id })),
		unifiedClosedTabHistory: [],
		shellCommandHistory: [],
		aiCommandHistory: [],
		shellCwd: '/repo',
		...overrides,
	};
}

const defaultBatchState: BatchRunState = {
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
};

class MockFileReader {
	onload: ((event: ProgressEvent<FileReader>) => void) | null = null;

	readAsDataURL(file: Blob) {
		this.onload?.({
			target: { result: `data:${file.type || 'image/png'};base64,aW50ZWdyYXRpb24=` },
		} as ProgressEvent<FileReader>);
	}
}

function setStoreSessions(sessions: Session[], activeSessionId = sessions[0]?.id ?? '') {
	useSessionStore.setState({ sessions, activeSessionId, groups: [] });
}

function createDeps(overrides: Partial<UseInputHandlersDeps> = {}): UseInputHandlersDeps & {
	inputRef: React.RefObject<HTMLTextAreaElement | null>;
	terminalOutputRef: React.RefObject<HTMLDivElement | null>;
	fileTreeKeyboardNavRef: React.MutableRefObject<boolean>;
	dragCounterRef: React.MutableRefObject<number>;
	setIsDraggingFile: ReturnType<typeof vi.fn>;
	sessionsRef: React.MutableRefObject<Session[]>;
	activeSessionIdRef: React.MutableRefObject<string>;
} {
	const inputRef = { current: document.createElement('textarea') };
	const terminalOutputRef = { current: document.createElement('div') };
	const sessionsRef = { current: useSessionStore.getState().sessions };
	const activeSessionIdRef = { current: useSessionStore.getState().activeSessionId };
	return {
		inputRef,
		terminalOutputRef,
		fileTreeKeyboardNavRef: { current: false },
		dragCounterRef: { current: 0 },
		setIsDraggingFile: vi.fn(),
		getBatchState: vi.fn(() => defaultBatchState),
		activeBatchRunState: defaultBatchState,
		processQueuedItemRef: { current: vi.fn(async (_sessionId: string, _item: QueuedItem) => {}) },
		flushBatchedUpdates: vi.fn(),
		handleHistoryCommand: vi.fn(async () => {}),
		handleWizardCommand: vi.fn(),
		sendWizardMessageWithThinking: vi.fn(async () => {}),
		isWizardActiveForCurrentTab: false,
		handleSkillsCommand: vi.fn(async () => {}),
		allSlashCommands: [{ command: '/help', description: 'Help' }],
		allCustomCommands: [],
		sessionsRef,
		activeSessionIdRef,
		...overrides,
	};
}

function renderInputHandlers(
	sessions: Session[],
	activeSessionId = sessions[0]?.id ?? '',
	depOverrides: Partial<UseInputHandlersDeps> = {}
) {
	act(() => setStoreSessions(sessions, activeSessionId));
	const deps = createDeps(depOverrides);
	deps.sessionsRef.current = sessions;
	deps.activeSessionIdRef.current = activeSessionId;

	const wrapper = ({ children }: React.PropsWithChildren) => (
		<InputProvider>{children}</InputProvider>
	);

	const rendered = renderHook(
		() => {
			const context = useInputContext();
			const handlers = useInputHandlers(deps);
			return { handlers, context };
		},
		{ wrapper }
	);

	return { ...rendered, deps };
}

function currentSession(id = useSessionStore.getState().activeSessionId): Session {
	return useSessionStore.getState().sessions.find((item) => item.id === id)!;
}

function pasteEvent({
	items = [],
	text = '',
	target,
}: {
	items?: Array<{ type: string; getAsFile: () => File | null }>;
	text?: string;
	target?: HTMLTextAreaElement;
}) {
	return {
		clipboardData: {
			items,
			getData: vi.fn(() => text),
		},
		target: target ?? document.createElement('textarea'),
		preventDefault: vi.fn(),
	} as unknown as React.ClipboardEvent;
}

function expectDuplicateImageFlash() {
	expect(useCenterFlashStore.getState().active).toMatchObject({
		message: 'Duplicate image ignored',
		color: 'theme',
	});
}

function dropEvent(files: File[]) {
	return {
		dataTransfer: { files, getData: vi.fn(() => '') },
		preventDefault: vi.fn(),
	} as unknown as React.DragEvent;
}

function imageItem() {
	return {
		type: 'image/png',
		getAsFile: () => new File(['image'], 'image.png', { type: 'image/png' }),
	};
}

describe('useInputHandlers integration', () => {
	const originalFileReader = globalThis.FileReader;
	const originalRequestAnimationFrame = globalThis.requestAnimationFrame;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		processingMock.processInput.mockClear();
		completionMock.getTabSuggestions.mockReturnValue([
			{ type: 'file', value: 'src/main.ts', displayText: 'src/main.ts' },
		]);
		completionMock.getAtMentionSuggestions.mockReturnValue([
			{
				type: 'file',
				value: 'docs/guide.md',
				displayText: 'guide.md',
				fullPath: 'docs/guide.md',
				score: 100,
				source: 'project',
			},
		]);
		globalThis.FileReader = MockFileReader as unknown as typeof FileReader;
		globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
			callback(0);
			return 1;
		};
		useSettingsStore.setState({
			conductorProfile: null,
			automaticTabNamingEnabled: true,
		});
		useGroupChatStore.setState({
			activeGroupChatId: null,
			groupChatStagedImages: [],
		});
		useUIStore.setState({
			activeRightTab: 'terminal',
			successFlashNotification: null,
		});
		useCenterFlashStore.setState({ active: null });
		useFileExplorerStore.setState({
			selectedFileIndex: 0,
			flatFileList: [],
		});
		setStoreSessions([], '');
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		globalThis.FileReader = originalFileReader;
		globalThis.requestAnimationFrame = originalRequestAnimationFrame;
		useCenterFlashStore.setState({ active: null });
		setStoreSessions([], '');
	});

	it('routes AI and terminal input setters, staged images, blur sync, and keydown delegation', () => {
		const source = session({
			aiTabs: [aiTab({ id: 'tab-a' }), aiTab({ id: 'tab-b', stagedImages: ['other-tab-image'] })],
			activeTabId: 'tab-a',
		});
		const otherSession = session({
			id: 'other-session',
			aiTabs: [aiTab({ id: 'other-tab', stagedImages: ['other-session-image'] })],
			activeTabId: 'other-tab',
		});
		const rendered = renderInputHandlers([source, otherSession], source.id);

		act(() => rendered.result.current.handlers.setInputValue('AI draft'));
		expect(rendered.result.current.handlers.inputValue).toBe('AI draft');

		act(() => rendered.result.current.handlers.setStagedImages(['image-a']));
		expect(currentSession().aiTabs[0].stagedImages).toEqual(['image-a']);

		act(() => rendered.result.current.handlers.setStagedImages((prev) => [...prev, 'image-b']));
		expect(currentSession().aiTabs[0].stagedImages).toEqual(['image-a', 'image-b']);
		expect(currentSession().aiTabs[1].stagedImages).toEqual(['other-tab-image']);
		expect(currentSession('other-session').aiTabs[0].stagedImages).toEqual(['other-session-image']);

		act(() => rendered.result.current.handlers.handleMainPanelInputBlur());
		expect(inputSyncMock.syncAiInputToSession).toHaveBeenCalledWith('AI draft');

		rendered.result.current.handlers.handleInputKeyDown({ key: 'Enter' } as React.KeyboardEvent);
		expect(keyDownMock.handleInputKeyDown).toHaveBeenCalledWith({ key: 'Enter' });

		cleanup();
		act(() => {
			useGroupChatStore.setState({
				activeGroupChatId: null,
				groupChatStagedImages: [],
			});
		});

		const terminal = session({ id: 'terminal-session', inputMode: 'terminal' });
		const terminalRendered = renderInputHandlers([terminal], terminal.id);
		act(() => terminalRendered.result.current.handlers.setInputValue('npm test'));
		expect(terminalRendered.result.current.handlers.inputValue).toBe('npm test');

		act(() => terminalRendered.result.current.handlers.handleMainPanelInputBlur());
		expect(inputSyncMock.syncTerminalInputToSession).toHaveBeenCalledWith('npm test');

		const emptyRendered = renderInputHandlers([], '');
		act(() => emptyRendered.result.current.handlers.setStagedImages(['ignored']));
		expect(useSessionStore.getState().sessions).toEqual([]);
	});

	it('persists AI and terminal drafts when switching tabs and sessions', () => {
		const source = session({
			aiTabs: [
				aiTab({ id: 'tab-a', inputValue: 'persisted A' }),
				aiTab({ id: 'tab-b', inputValue: 'persisted B', hasUnread: true }),
			],
			activeTabId: 'tab-a',
		});
		const other = session({ id: 'other-session', aiTabs: [aiTab({ id: 'other-tab' })] });
		const rendered = renderInputHandlers([source, other], source.id);
		act(() => rendered.result.current.handlers.setInputValue('draft A'));

		act(() => {
			useSessionStore
				.getState()
				.setSessions((prev) =>
					prev.map((item) => (item.id === source.id ? { ...item, activeTabId: 'tab-b' } : item))
				);
		});

		expect(currentSession().aiTabs.find((tab) => tab.id === 'tab-a')?.inputValue).toBe('draft A');
		expect(currentSession().aiTabs.find((tab) => tab.id === 'tab-b')?.hasUnread).toBe(false);
		expect(currentSession('other-session').aiTabs[0].id).toBe('other-tab');
		expect(rendered.result.current.handlers.inputValue).toBe('persisted B');

		cleanup();

		const firstTerminal = session({
			id: 'terminal-a',
			inputMode: 'terminal',
			terminalDraftInput: 'old terminal',
		});
		const secondTerminal = session({
			id: 'terminal-b',
			inputMode: 'terminal',
			terminalDraftInput: 'saved terminal',
		});
		const terminalRendered = renderInputHandlers([firstTerminal, secondTerminal], firstTerminal.id);
		act(() => terminalRendered.result.current.handlers.setInputValue('draft terminal'));

		act(() => {
			useSessionStore.setState({ activeSessionId: secondTerminal.id });
		});

		expect(currentSession(firstTerminal.id).terminalDraftInput).toBe('draft terminal');
		expect(terminalRendered.result.current.handlers.inputValue).toBe('saved terminal');
	});

	it('computes completion suggestions and syncs file-tree selection from tab completion', () => {
		const terminal = session({ inputMode: 'terminal' });
		const rendered = renderInputHandlers([terminal], terminal.id);

		act(() => {
			rendered.result.current.context.setTabCompletionOpen(true);
			rendered.result.current.context.setTabCompletionFilter('file');
			rendered.result.current.handlers.setInputValue('cat src/');
		});

		expect(rendered.result.current.handlers.tabCompletionSuggestions).toEqual([
			{ type: 'file', value: 'src/main.ts', displayText: 'src/main.ts' },
		]);
		expect(completionMock.getTabSuggestions).toHaveBeenCalledWith('cat src/', 'file');

		act(() => {
			useFileExplorerStore.setState({
				flatFileList: [
					{
						name: 'main.ts',
						type: 'file',
						fullPath: 'src/main.ts',
						isFolder: false,
					} as any,
				],
			});
		});

		act(() =>
			rendered.result.current.handlers.syncFileTreeToTabCompletion({
				type: 'file',
				value: 'cat src/main.ts',
				displayText: 'src/main.ts',
			})
		);
		expect(rendered.deps.fileTreeKeyboardNavRef.current).toBe(true);
		expect(useFileExplorerStore.getState().selectedFileIndex).toBe(0);
		expect(useUIStore.getState().activeRightTab).toBe('files');

		act(() => rendered.result.current.handlers.syncFileTreeToTabCompletion(undefined));
		act(() =>
			rendered.result.current.handlers.syncFileTreeToTabCompletion({
				type: 'history',
				value: 'npm test',
				displayText: 'npm test',
			})
		);

		cleanup();

		const ai = session({ inputMode: 'ai' });
		const aiRendered = renderInputHandlers([ai], ai.id);
		act(() => {
			aiRendered.result.current.context.setAtMentionOpen(true);
			aiRendered.result.current.context.setAtMentionFilter('guide');
		});

		expect(aiRendered.result.current.handlers.atMentionSuggestions).toEqual([
			expect.objectContaining({ value: 'docs/guide.md' }),
		]);
		expect(completionMock.getAtMentionSuggestions).toHaveBeenCalledWith('guide');
	});

	it('replays messages without clobbering the active draft input or staged images', () => {
		const source = session({ aiTabs: [aiTab({ stagedImages: ['draft-image'] })] });
		const rendered = renderInputHandlers([source], source.id);
		act(() => rendered.result.current.handlers.setInputValue('draft text'));

		act(() => {
			rendered.result.current.handlers.handleReplayMessage('previous message', ['replay-image']);
		});
		expect(currentSession().aiTabs[0].stagedImages).toEqual(['replay-image']);

		act(() => vi.runOnlyPendingTimers());
		expect(processingMock.processInput).toHaveBeenCalledWith('previous message');
		expect(rendered.result.current.handlers.inputValue).toBe('draft text');
		expect(currentSession().aiTabs[0].stagedImages).toEqual(['draft-image']);
	});

	it('trims text paste and stages pasted images for direct AI and group-chat input', () => {
		const source = session();
		const rendered = renderInputHandlers([source], source.id);
		const target = document.createElement('textarea');
		target.value = 'Say ';
		target.selectionStart = 4;
		target.selectionEnd = 4;
		const textPaste = pasteEvent({ text: '  hello  ', target });

		act(() => rendered.result.current.handlers.handlePaste(textPaste));
		expect(textPaste.preventDefault).toHaveBeenCalledOnce();
		expect(rendered.result.current.handlers.inputValue).toBe('Say hello');

		const imagePaste = pasteEvent({ items: [imageItem()] });
		act(() => rendered.result.current.handlers.handlePaste(imagePaste));
		expect(imagePaste.preventDefault).toHaveBeenCalledOnce();
		expect(currentSession().aiTabs[0].stagedImages).toEqual([imageData]);

		act(() => rendered.result.current.handlers.handlePaste(pasteEvent({ items: [imageItem()] })));
		expectDuplicateImageFlash();
		act(() => vi.advanceTimersByTime(2000));
		expect(useCenterFlashStore.getState().active).toBeNull();

		act(() => {
			useGroupChatStore.setState({
				activeGroupChatId: 'group-1',
				groupChatStagedImages: [],
			});
		});
		act(() => rendered.result.current.handlers.handlePaste(pasteEvent({ items: [imageItem()] })));
		expect(useGroupChatStore.getState().groupChatStagedImages).toEqual([imageData]);

		act(() => rendered.result.current.handlers.handlePaste(pasteEvent({ items: [imageItem()] })));
		expect(useGroupChatStore.getState().groupChatStagedImages).toEqual([imageData]);
		expectDuplicateImageFlash();
		act(() => vi.advanceTimersByTime(2000));
		expect(useCenterFlashStore.getState().active).toBeNull();
	});

	it('handles image drops for AI and group chat modes while resetting drag state', () => {
		const source = session();
		const rendered = renderInputHandlers([source], source.id);
		rendered.deps.dragCounterRef.current = 3;

		const aiDrop = dropEvent([new File(['image'], 'screen.png', { type: 'image/png' })]);
		act(() => rendered.result.current.handlers.handleDrop(aiDrop));
		expect(aiDrop.preventDefault).toHaveBeenCalledOnce();
		expect(rendered.deps.dragCounterRef.current).toBe(0);
		expect(rendered.deps.setIsDraggingFile).toHaveBeenCalledWith(false);
		expect(currentSession().aiTabs[0].stagedImages).toEqual([imageData]);

		act(() =>
			rendered.result.current.handlers.handleDrop(
				dropEvent([new File(['image'], 'screen.png', { type: 'image/png' })])
			)
		);
		expect(currentSession().aiTabs[0].stagedImages).toEqual([imageData]);
		expectDuplicateImageFlash();
		act(() => vi.advanceTimersByTime(2000));
		expect(useCenterFlashStore.getState().active).toBeNull();

		act(() => {
			useGroupChatStore.setState({
				activeGroupChatId: 'group-1',
				groupChatStagedImages: [],
			});
		});
		act(() =>
			rendered.result.current.handlers.handleDrop(
				dropEvent([new File(['image'], 'group.png', { type: 'image/png' })])
			)
		);
		expect(useGroupChatStore.getState().groupChatStagedImages).toEqual([imageData]);

		act(() =>
			rendered.result.current.handlers.handleDrop(
				dropEvent([new File(['image'], 'group.png', { type: 'image/png' })])
			)
		);
		expect(useGroupChatStore.getState().groupChatStagedImages).toEqual([imageData]);
		expectDuplicateImageFlash();
		act(() => vi.advanceTimersByTime(2000));
		expect(useCenterFlashStore.getState().active).toBeNull();
	});

	it('ignores pasted and dropped images outside AI and group-chat modes', () => {
		const terminal = session({ id: 'terminal-session', inputMode: 'terminal' });
		const terminalRendered = renderInputHandlers([terminal], terminal.id);
		const terminalPaste = pasteEvent({ items: [imageItem()] });
		act(() => terminalRendered.result.current.handlers.handlePaste(terminalPaste));
		expect(terminalPaste.preventDefault).not.toHaveBeenCalled();

		const terminalDrop = dropEvent([new File(['image'], 'ignored.png', { type: 'image/png' })]);
		act(() => terminalRendered.result.current.handlers.handleDrop(terminalDrop));
		expect(terminalDrop.preventDefault).toHaveBeenCalledOnce();
		expect(currentSession(terminal.id).aiTabs[0].stagedImages).toEqual([]);
	});
});
