import { act, cleanup, renderHook } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InputProvider, useInputContext } from '../../renderer/contexts/InputContext';
import { useInputKeyDown, type InputKeyDownDeps } from '../../renderer/hooks/input/useInputKeyDown';
import { useSessionStore } from '../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../renderer/stores/settingsStore';
import { useUIStore } from '../../renderer/stores/uiStore';
import type { Session } from '../../renderer/types';
import { outputSearchKeyFor } from '../../renderer/utils/outputSearch';

function session(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Integration Session',
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
		aiTabs: [],
		activeTabId: '',
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [],
		unifiedClosedTabHistory: [],
		shellCommandHistory: [],
		aiCommandHistory: [],
		shellCwd: '/repo',
		...overrides,
	} as Session;
}

function setActiveSession(nextSession: Session | null) {
	useSessionStore.setState({
		sessions: nextSession ? [nextSession] : [],
		activeSessionId: nextSession?.id ?? '',
		groups: [],
	});
}

function createEvent(
	key: string,
	overrides: Partial<React.KeyboardEvent> = {}
): React.KeyboardEvent {
	return {
		key,
		metaKey: false,
		ctrlKey: false,
		shiftKey: false,
		preventDefault: vi.fn(),
		...overrides,
	} as unknown as React.KeyboardEvent;
}

function createDeps(overrides: Partial<InputKeyDownDeps> = {}): InputKeyDownDeps {
	const input = document.createElement('textarea');
	const output = document.createElement('div');
	input.focus = vi.fn();
	input.blur = vi.fn();
	output.focus = vi.fn();

	return {
		inputValue: '',
		setInputValue: vi.fn(),
		tabCompletionSuggestions: [
			{ type: 'history', value: 'npm test', displayText: 'npm test' },
			{ type: 'branch', value: 'feature/login', displayText: 'feature/login' },
			{ type: 'file', value: 'src/main.ts', displayText: 'src/main.ts' },
		],
		atMentionSuggestions: [
			{
				type: 'file',
				value: 'docs/guide.md',
				displayText: 'guide.md',
				fullPath: '/repo/docs/guide.md',
				score: 100,
				source: 'project',
			},
			{
				type: 'folder',
				value: 'docs/api',
				displayText: 'api',
				fullPath: '/repo/docs/api',
				score: 80,
				source: 'project',
			},
		],
		allSlashCommands: [
			{ command: '/clear', description: 'Clear' },
			{ command: '/cd', description: 'Change directory', terminalOnly: true },
			{ command: '/ask', description: 'Ask AI', aiOnly: true },
		],
		syncFileTreeToTabCompletion: vi.fn(),
		processInput: vi.fn(),
		getTabCompletionSuggestions: vi.fn(() => []),
		inputRef: { current: input },
		terminalOutputRef: { current: output },
		...overrides,
	};
}

function renderKeyDown(deps: InputKeyDownDeps) {
	const wrapper = ({ children }: React.PropsWithChildren) => (
		<InputProvider>{children}</InputProvider>
	);

	return renderHook(
		(props: InputKeyDownDeps) => {
			const context = useInputContext();
			const keyDown = useInputKeyDown(props);
			return { ...keyDown, context };
		},
		{ initialProps: deps, wrapper }
	);
}

function press(
	result: ReturnType<typeof renderKeyDown>['result'],
	key: string,
	overrides: Partial<React.KeyboardEvent> = {}
) {
	const event = createEvent(key, overrides);
	act(() => result.current.handleInputKeyDown(event));
	return event;
}

describe('useInputKeyDown integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		setActiveSession(session());
		useSettingsStore.setState({
			enterToSendAI: false,
			enterToSendTerminal: true,
		});
		useUIStore.setState({
			outputSearchByKey: {},
		});
	});

	afterEach(() => {
		cleanup();
		setActiveSession(null);
	});

	it('opens output search with Cmd/Ctrl+F and lets command history own keystrokes', () => {
		const deps = createDeps();
		const { result } = renderKeyDown(deps);

		const searchEvent = press(result, 'f', { metaKey: true });
		expect(searchEvent.preventDefault).toHaveBeenCalledOnce();
		expect(useUIStore.getState().outputSearchByKey[outputSearchKeyFor('session-1', '')]?.open).toBe(
			true
		);

		act(() => result.current.context.setCommandHistoryOpen(true));

		const historyEvent = press(result, 'Enter');
		expect(historyEvent.preventDefault).not.toHaveBeenCalled();
		expect(deps.processInput).not.toHaveBeenCalled();
	});

	it('navigates terminal tab completion, cycles git filters, accepts suggestions, and closes', () => {
		setActiveSession(session({ inputMode: 'terminal', isGitRepo: true }));
		const deps = createDeps();
		const { result } = renderKeyDown(deps);

		act(() => {
			result.current.context.setTabCompletionOpen(true);
			result.current.context.setSelectedTabCompletionIndex(0);
		});

		const downEvent = press(result, 'ArrowDown');
		expect(downEvent.preventDefault).toHaveBeenCalledOnce();
		expect(result.current.context.selectedTabCompletionIndex).toBe(1);
		expect(deps.syncFileTreeToTabCompletion).toHaveBeenLastCalledWith(
			deps.tabCompletionSuggestions[1]
		);

		press(result, 'ArrowDown');
		expect(result.current.context.selectedTabCompletionIndex).toBe(2);

		const upEvent = press(result, 'ArrowUp');
		expect(upEvent.preventDefault).toHaveBeenCalledOnce();
		expect(result.current.context.selectedTabCompletionIndex).toBe(1);
		expect(deps.syncFileTreeToTabCompletion).toHaveBeenLastCalledWith(
			deps.tabCompletionSuggestions[1]
		);

		act(() => result.current.context.setTabCompletionFilter('all'));
		press(result, 'Tab');
		expect(result.current.context.tabCompletionFilter).toBe('history');
		expect(result.current.context.selectedTabCompletionIndex).toBe(0);

		press(result, 'Tab', { shiftKey: true });
		expect(result.current.context.tabCompletionFilter).toBe('all');

		setActiveSession(session({ inputMode: 'terminal', isGitRepo: false }));
		act(() => {
			result.current.context.setSelectedTabCompletionIndex(1);
			result.current.context.setTabCompletionOpen(true);
		});

		press(result, 'Tab');
		expect(deps.setInputValue).toHaveBeenLastCalledWith('feature/login');
		expect(deps.syncFileTreeToTabCompletion).toHaveBeenLastCalledWith(
			deps.tabCompletionSuggestions[1]
		);
		expect(result.current.context.tabCompletionOpen).toBe(false);

		act(() => {
			result.current.context.setSelectedTabCompletionIndex(2);
			result.current.context.setTabCompletionOpen(true);
		});
		press(result, 'Enter');
		expect(deps.setInputValue).toHaveBeenLastCalledWith('src/main.ts');
		expect(result.current.context.tabCompletionOpen).toBe(false);

		act(() => result.current.context.setTabCompletionOpen(true));
		const escapeEvent = press(result, 'Escape');
		expect(escapeEvent.preventDefault).toHaveBeenCalledOnce();
		expect(result.current.context.tabCompletionOpen).toBe(false);
		expect(deps.inputRef.current?.focus).toHaveBeenCalledOnce();
	});

	it('handles AI at-mention selection, missing selections, and escape cleanup', () => {
		setActiveSession(session({ inputMode: 'ai' }));
		const deps = createDeps({ inputValue: 'Ask @do now' });
		const { result } = renderKeyDown(deps);

		act(() => {
			result.current.context.setAtMentionOpen(true);
			result.current.context.setAtMentionFilter('do');
			result.current.context.setAtMentionStartIndex(4);
			result.current.context.setSelectedAtMentionIndex(0);
		});

		press(result, 'ArrowDown');
		expect(result.current.context.selectedAtMentionIndex).toBe(1);

		press(result, 'ArrowUp');
		expect(result.current.context.selectedAtMentionIndex).toBe(0);

		press(result, 'Enter');
		expect(deps.setInputValue).toHaveBeenCalledWith('Ask @docs/guide.md  now');
		expect(result.current.context.atMentionOpen).toBe(false);
		expect(result.current.context.atMentionFilter).toBe('');
		expect(result.current.context.atMentionStartIndex).toBe(-1);

		act(() => {
			result.current.context.setAtMentionOpen(true);
			result.current.context.setAtMentionFilter('missing');
			result.current.context.setAtMentionStartIndex(4);
			result.current.context.setSelectedAtMentionIndex(99);
		});
		press(result, 'Tab');
		expect(deps.setInputValue).toHaveBeenCalledTimes(1);
		expect(result.current.context.atMentionOpen).toBe(false);

		act(() => {
			result.current.context.setAtMentionOpen(true);
			result.current.context.setAtMentionFilter('do');
			result.current.context.setAtMentionStartIndex(4);
		});
		const escapeEvent = press(result, 'Escape');
		expect(escapeEvent.preventDefault).toHaveBeenCalledOnce();
		expect(result.current.context.atMentionOpen).toBe(false);
		expect(deps.inputRef.current?.focus).toHaveBeenCalledOnce();
	});

	it('covers no-op completion keystrokes and missing selected tab suggestions', () => {
		setActiveSession(session({ inputMode: 'terminal', isGitRepo: false }));
		const deps = createDeps();
		const { result } = renderKeyDown(deps);

		act(() => {
			result.current.context.setTabCompletionOpen(true);
			result.current.context.setSelectedTabCompletionIndex(99);
		});

		press(result, 'Tab');
		expect(deps.setInputValue).not.toHaveBeenCalled();
		expect(result.current.context.tabCompletionOpen).toBe(false);

		act(() => {
			result.current.context.setTabCompletionOpen(true);
			result.current.context.setSelectedTabCompletionIndex(99);
		});

		press(result, 'Enter');
		expect(deps.setInputValue).not.toHaveBeenCalled();
		expect(result.current.context.tabCompletionOpen).toBe(false);

		act(() => result.current.context.setTabCompletionOpen(true));
		const tabNoopEvent = press(result, 'x');
		expect(tabNoopEvent.preventDefault).not.toHaveBeenCalled();

		setActiveSession(session({ inputMode: 'ai' }));
		act(() => result.current.context.setAtMentionOpen(true));
		const mentionNoopEvent = press(result, 'x');
		expect(mentionNoopEvent.preventDefault).not.toHaveBeenCalled();
		expect(result.current.context.atMentionOpen).toBe(true);

		act(() => {
			result.current.context.setAtMentionOpen(false);
			result.current.context.setSlashCommandOpen(true);
		});
		const slashNoopEvent = press(result, 'x');
		expect(slashNoopEvent.preventDefault).not.toHaveBeenCalled();
		expect(result.current.context.slashCommandOpen).toBe(true);
	});

	it('filters slash commands by mode and handles navigation, acceptance, and escape', () => {
		setActiveSession(session({ inputMode: 'terminal' }));
		const deps = createDeps({ inputValue: '/' });
		const { result, rerender } = renderKeyDown(deps);

		act(() => {
			result.current.context.setSlashCommandOpen(true);
			result.current.context.setSelectedSlashCommandIndex(0);
		});

		press(result, 'ArrowDown');
		expect(result.current.context.selectedSlashCommandIndex).toBe(1);

		press(result, 'ArrowUp');
		expect(result.current.context.selectedSlashCommandIndex).toBe(0);

		act(() => result.current.context.setSelectedSlashCommandIndex(1));
		press(result, 'Enter');
		expect(deps.setInputValue).toHaveBeenLastCalledWith('/cd ');
		expect(result.current.context.slashCommandOpen).toBe(false);
		expect(deps.inputRef.current?.focus).toHaveBeenCalledOnce();

		act(() => result.current.context.setSlashCommandOpen(true));
		press(result, 'Escape');
		expect(result.current.context.slashCommandOpen).toBe(false);

		setActiveSession(session({ inputMode: 'ai' }));
		const aiDeps = { ...deps, inputValue: '/' };
		rerender(aiDeps);
		act(() => {
			result.current.context.setSlashCommandOpen(true);
			result.current.context.setSelectedSlashCommandIndex(1);
		});
		press(result, 'Tab');
		expect(aiDeps.setInputValue).toHaveBeenLastCalledWith('/ask ');

		act(() => {
			result.current.context.setSlashCommandOpen(true);
			result.current.context.setSelectedSlashCommandIndex(99);
		});
		press(result, 'Enter');
		expect(result.current.context.slashCommandOpen).toBe(false);
	});

	it('applies enter-to-send settings and focus/history fallback shortcuts', () => {
		const deps = createDeps({
			inputValue: 'npm',
			getTabCompletionSuggestions: vi.fn((input: string) =>
				input === 'npm'
					? [
							{ type: 'history', value: 'npm test', displayText: 'npm test' },
							{ type: 'file', value: 'npm.config.js', displayText: 'npm.config.js' },
						]
					: []
			),
		});
		const { result, rerender } = renderKeyDown(deps);

		useSettingsStore.setState({ enterToSendAI: true });
		const aiEnterEvent = press(result, 'Enter');
		expect(aiEnterEvent.preventDefault).toHaveBeenCalledOnce();
		expect(deps.processInput).toHaveBeenCalledTimes(1);

		const shiftedEnterEvent = press(result, 'Enter', { shiftKey: true });
		expect(shiftedEnterEvent.preventDefault).not.toHaveBeenCalled();
		expect(deps.processInput).toHaveBeenCalledTimes(1);

		useSettingsStore.setState({ enterToSendAI: false });
		const ctrlEnterEvent = press(result, 'Enter', { ctrlKey: true });
		expect(ctrlEnterEvent.preventDefault).toHaveBeenCalledOnce();
		expect(deps.processInput).toHaveBeenCalledTimes(2);

		setActiveSession(session({ inputMode: 'terminal' }));
		const terminalEnterEvent = press(result, 'Enter');
		expect(terminalEnterEvent.preventDefault).not.toHaveBeenCalled();
		expect(deps.processInput).toHaveBeenCalledTimes(2);

		const escapeEvent = press(result, 'Escape');
		expect(escapeEvent.preventDefault).toHaveBeenCalledOnce();
		expect(deps.inputRef.current?.blur).toHaveBeenCalledOnce();
		expect(deps.terminalOutputRef.current?.focus).toHaveBeenCalledOnce();

		const historyEvent = press(result, 'ArrowUp');
		expect(historyEvent.preventDefault).toHaveBeenCalledOnce();
		expect(result.current.context.commandHistoryOpen).toBe(true);
		expect(result.current.context.commandHistoryFilter).toBe('npm');
		expect(result.current.context.commandHistorySelectedIndex).toBe(0);

		act(() => result.current.context.setCommandHistoryOpen(false));

		const multiSuggestionTab = press(result, 'Tab');
		expect(multiSuggestionTab.preventDefault).toHaveBeenCalledOnce();
		expect(result.current.context.tabCompletionOpen).toBe(true);
		expect(result.current.context.tabCompletionFilter).toBe('all');
		expect(result.current.context.selectedTabCompletionIndex).toBe(0);

		const singleSuggestionDeps = createDeps({
			inputValue: 'git',
			getTabCompletionSuggestions: vi.fn(() => [
				{ type: 'history', value: 'git status', displayText: 'git status' },
			]),
		});
		rerender(singleSuggestionDeps);
		act(() => result.current.context.setTabCompletionOpen(false));
		press(result, 'Tab');
		expect(singleSuggestionDeps.setInputValue).toHaveBeenCalledWith('git status');

		const noSuggestionDeps = createDeps({
			inputValue: 'unknown',
			getTabCompletionSuggestions: vi.fn(() => []),
		});
		rerender(noSuggestionDeps);
		press(result, 'Tab');
		expect(noSuggestionDeps.setInputValue).not.toHaveBeenCalled();
	});

	it('covers modifier and fallback branches that intentionally do nothing', () => {
		const deps = createDeps();
		const { result, rerender } = renderKeyDown(deps);

		const ctrlSearchEvent = press(result, 'f', { ctrlKey: true });
		expect(ctrlSearchEvent.preventDefault).toHaveBeenCalledOnce();
		expect(useUIStore.getState().outputSearchByKey[outputSearchKeyFor('session-1', '')]?.open).toBe(
			true
		);

		const aiArrowUpEvent = press(result, 'ArrowUp');
		expect(aiArrowUpEvent.preventDefault).not.toHaveBeenCalled();
		expect(result.current.context.commandHistoryOpen).toBe(false);

		const plainKeyEvent = press(result, 'a');
		expect(plainKeyEvent.preventDefault).not.toHaveBeenCalled();

		const aiTabEvent = press(result, 'Tab');
		expect(aiTabEvent.preventDefault).toHaveBeenCalledOnce();
		expect(result.current.context.tabCompletionOpen).toBe(false);

		setActiveSession(session({ inputMode: 'terminal' }));
		const emptyTabDeps = createDeps({ inputValue: '' });
		rerender(emptyTabDeps);
		const emptyTabEvent = press(result, 'Tab');
		expect(emptyTabEvent.preventDefault).toHaveBeenCalledOnce();
		expect(emptyTabDeps.getTabCompletionSuggestions).not.toHaveBeenCalled();
		expect(result.current.context.tabCompletionOpen).toBe(false);
	});
});
