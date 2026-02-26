/**
 * Tests for useInputKeyDown hook (Phase 2F)
 *
 * Tests keyboard handling for the main input area:
 * - Cmd+F output search
 * - Tab completion navigation (terminal mode)
 * - @ mention completion (AI mode)
 * - Slash command autocomplete
 * - Enter-to-send logic
 * - Escape focus management
 * - Command history (ArrowUp in terminal)
 * - Tab completion trigger
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import React from 'react';

// Mock InputContext
const mockInputContext = {
	slashCommandOpen: false,
	setSlashCommandOpen: vi.fn(),
	selectedSlashCommandIndex: 0,
	setSelectedSlashCommandIndex: vi.fn(),
	tabCompletionOpen: false,
	setTabCompletionOpen: vi.fn(),
	selectedTabCompletionIndex: 0,
	setSelectedTabCompletionIndex: vi.fn(),
	tabCompletionFilter: 'all' as string,
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

import { useInputKeyDown } from '../../../renderer/hooks/input/useInputKeyDown';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import type { InputKeyDownDeps } from '../../../renderer/hooks/input/useInputKeyDown';

// ============================================================================
// Test Helpers
// ============================================================================

function createMockDeps(overrides: Partial<InputKeyDownDeps> = {}): InputKeyDownDeps {
	return {
		inputValue: '',
		setInputValue: vi.fn(),
		tabCompletionSuggestions: [],
		atMentionSuggestions: [],
		allSlashCommands: [],
		syncFileTreeToTabCompletion: vi.fn(),
		processInput: vi.fn(),
		getTabCompletionSuggestions: vi.fn().mockReturnValue([]),
		inputRef: { current: { focus: vi.fn(), blur: vi.fn() } } as any,
		terminalOutputRef: { current: { focus: vi.fn() } } as any,
		...overrides,
	};
}

function createKeyEvent(
	key: string,
	modifiers: Partial<React.KeyboardEvent> = {}
): React.KeyboardEvent {
	return {
		key,
		preventDefault: vi.fn(),
		shiftKey: false,
		metaKey: false,
		ctrlKey: false,
		altKey: false,
		...modifiers,
	} as unknown as React.KeyboardEvent;
}

function setActiveSession(overrides: Record<string, unknown> = {}) {
	useSessionStore.setState({
		sessions: [
			{
				id: 'session-1',
				inputMode: 'ai',
				isGitRepo: false,
				toolType: 'claude-code',
				...overrides,
			} as any,
		],
		activeSessionId: 'session-1',
	} as any);
}

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeEach(() => {
	vi.clearAllMocks();

	// Reset InputContext mock state
	Object.assign(mockInputContext, {
		slashCommandOpen: false,
		selectedSlashCommandIndex: 0,
		tabCompletionOpen: false,
		selectedTabCompletionIndex: 0,
		tabCompletionFilter: 'all',
		atMentionOpen: false,
		atMentionFilter: '',
		atMentionStartIndex: -1,
		selectedAtMentionIndex: 0,
		commandHistoryOpen: false,
	});

	useSessionStore.setState({
		sessions: [],
		activeSessionId: '',
	} as any);

	useUIStore.setState({ outputSearchOpen: false });

	useSettingsStore.setState({
		enterToSendAI: true,
		enterToSendTerminal: true,
	} as any);
});

afterEach(() => {
	cleanup();
});

// ============================================================================
// Cmd+F output search
// ============================================================================

describe('Cmd+F output search', () => {
	it('opens output search on Cmd+F', () => {
		const deps = createMockDeps();
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('f', { metaKey: true });

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(e.preventDefault).toHaveBeenCalled();
		expect(useUIStore.getState().outputSearchOpen).toBe(true);
	});

	it('opens output search on Ctrl+F', () => {
		const deps = createMockDeps();
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('f', { ctrlKey: true });

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(e.preventDefault).toHaveBeenCalled();
		expect(useUIStore.getState().outputSearchOpen).toBe(true);
	});
});

// ============================================================================
// Command history passthrough
// ============================================================================

describe('Command history passthrough', () => {
	it('returns early when commandHistoryOpen is true', () => {
		mockInputContext.commandHistoryOpen = true;
		const deps = createMockDeps();
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('ArrowDown');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		// Should not call any setters (early return)
		expect(deps.setInputValue).not.toHaveBeenCalled();
		expect(e.preventDefault).not.toHaveBeenCalled();
	});
});

// ============================================================================
// Tab completion navigation (terminal mode)
// ============================================================================

describe('Tab completion navigation', () => {
	const suggestions = [
		{ value: 'src/', type: 'folder' as const, label: 'src/' },
		{ value: 'package.json', type: 'file' as const, label: 'package.json' },
		{ value: 'README.md', type: 'file' as const, label: 'README.md' },
	] as any;

	beforeEach(() => {
		mockInputContext.tabCompletionOpen = true;
		mockInputContext.selectedTabCompletionIndex = 0;
		setActiveSession({ inputMode: 'terminal' });
	});

	it('navigates down with ArrowDown', () => {
		const deps = createMockDeps({ tabCompletionSuggestions: suggestions });
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('ArrowDown');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(e.preventDefault).toHaveBeenCalled();
		expect(mockInputContext.setSelectedTabCompletionIndex).toHaveBeenCalledWith(1);
		expect(deps.syncFileTreeToTabCompletion).toHaveBeenCalledWith(suggestions[1]);
	});

	it('navigates up with ArrowUp', () => {
		mockInputContext.selectedTabCompletionIndex = 2;
		const deps = createMockDeps({ tabCompletionSuggestions: suggestions });
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('ArrowUp');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(mockInputContext.setSelectedTabCompletionIndex).toHaveBeenCalledWith(1);
	});

	it('clamps at bottom', () => {
		mockInputContext.selectedTabCompletionIndex = 2;
		const deps = createMockDeps({ tabCompletionSuggestions: suggestions });
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('ArrowDown');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(mockInputContext.setSelectedTabCompletionIndex).toHaveBeenCalledWith(2);
	});

	it('clamps at top', () => {
		mockInputContext.selectedTabCompletionIndex = 0;
		const deps = createMockDeps({ tabCompletionSuggestions: suggestions });
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('ArrowUp');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(mockInputContext.setSelectedTabCompletionIndex).toHaveBeenCalledWith(0);
	});

	it('accepts selection on Enter', () => {
		mockInputContext.selectedTabCompletionIndex = 1;
		const deps = createMockDeps({ tabCompletionSuggestions: suggestions });
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Enter');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(deps.setInputValue).toHaveBeenCalledWith('package.json');
		expect(deps.syncFileTreeToTabCompletion).toHaveBeenCalledWith(suggestions[1]);
		expect(mockInputContext.setTabCompletionOpen).toHaveBeenCalledWith(false);
	});

	it('closes on Escape and focuses input', () => {
		const deps = createMockDeps({ tabCompletionSuggestions: suggestions });
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Escape');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(mockInputContext.setTabCompletionOpen).toHaveBeenCalledWith(false);
		expect(deps.inputRef.current!.focus).toHaveBeenCalled();
	});

	it('cycles filter types with Tab in git repos', () => {
		setActiveSession({ inputMode: 'terminal', isGitRepo: true });
		mockInputContext.tabCompletionFilter = 'all';
		const deps = createMockDeps({ tabCompletionSuggestions: suggestions });
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Tab');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(mockInputContext.setTabCompletionFilter).toHaveBeenCalledWith('history');
		expect(mockInputContext.setSelectedTabCompletionIndex).toHaveBeenCalledWith(0);
	});

	it('cycles filter types backwards with Shift+Tab in git repos', () => {
		setActiveSession({ inputMode: 'terminal', isGitRepo: true });
		mockInputContext.tabCompletionFilter = 'history';
		const deps = createMockDeps({ tabCompletionSuggestions: suggestions });
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Tab', { shiftKey: true });

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(mockInputContext.setTabCompletionFilter).toHaveBeenCalledWith('all');
	});

	it('accepts selection on Tab in non-git repos', () => {
		setActiveSession({ inputMode: 'terminal', isGitRepo: false });
		mockInputContext.selectedTabCompletionIndex = 0;
		const deps = createMockDeps({ tabCompletionSuggestions: suggestions });
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Tab');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(deps.setInputValue).toHaveBeenCalledWith('src/');
		expect(mockInputContext.setTabCompletionOpen).toHaveBeenCalledWith(false);
	});

	it('does not activate in AI mode', () => {
		setActiveSession({ inputMode: 'ai' });
		const deps = createMockDeps({ tabCompletionSuggestions: suggestions });
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('ArrowDown');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		// Should not call tab completion setters — falls through
		expect(mockInputContext.setSelectedTabCompletionIndex).not.toHaveBeenCalled();
	});
});

// ============================================================================
// @ mention completion (AI mode)
// ============================================================================

describe('@ mention completion', () => {
	const mentions = [
		{
			value: 'src/app.ts',
			type: 'file' as const,
			displayText: 'app.ts',
			fullPath: 'src/app.ts',
			score: 1,
		},
		{
			value: 'src/index.ts',
			type: 'file' as const,
			displayText: 'index.ts',
			fullPath: 'src/index.ts',
			score: 0.9,
		},
	] as any;

	beforeEach(() => {
		mockInputContext.atMentionOpen = true;
		mockInputContext.selectedAtMentionIndex = 0;
		mockInputContext.atMentionStartIndex = 6; // position of '@' in 'hello @app world'
		mockInputContext.atMentionFilter = 'app';
		setActiveSession({ inputMode: 'ai' });
	});

	it('navigates down with ArrowDown', () => {
		const deps = createMockDeps({ atMentionSuggestions: mentions });
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('ArrowDown');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(e.preventDefault).toHaveBeenCalled();
		expect(mockInputContext.setSelectedAtMentionIndex).toHaveBeenCalled();
	});

	it('navigates up with ArrowUp', () => {
		const deps = createMockDeps({ atMentionSuggestions: mentions });
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('ArrowUp');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(mockInputContext.setSelectedAtMentionIndex).toHaveBeenCalled();
	});

	it('accepts selection on Enter and replaces @filter', () => {
		const deps = createMockDeps({
			inputValue: 'hello @app world',
			atMentionSuggestions: mentions,
		});
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Enter');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(deps.setInputValue).toHaveBeenCalledWith('hello @src/app.ts  world');
		expect(mockInputContext.setAtMentionOpen).toHaveBeenCalledWith(false);
		expect(mockInputContext.setAtMentionFilter).toHaveBeenCalledWith('');
		expect(mockInputContext.setAtMentionStartIndex).toHaveBeenCalledWith(-1);
	});

	it('accepts selection on Tab', () => {
		const deps = createMockDeps({
			inputValue: 'hello @app world',
			atMentionSuggestions: mentions,
		});
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Tab');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(deps.setInputValue).toHaveBeenCalled();
		expect(mockInputContext.setAtMentionOpen).toHaveBeenCalledWith(false);
	});

	it('closes on Escape and clears state', () => {
		const deps = createMockDeps({ atMentionSuggestions: mentions });
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Escape');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(mockInputContext.setAtMentionOpen).toHaveBeenCalledWith(false);
		expect(mockInputContext.setAtMentionFilter).toHaveBeenCalledWith('');
		expect(mockInputContext.setAtMentionStartIndex).toHaveBeenCalledWith(-1);
		expect(deps.inputRef.current!.focus).toHaveBeenCalled();
	});

	it('does not activate in terminal mode', () => {
		setActiveSession({ inputMode: 'terminal' });
		const deps = createMockDeps({ atMentionSuggestions: mentions });
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('ArrowDown');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(mockInputContext.setSelectedAtMentionIndex).not.toHaveBeenCalled();
	});
});

// ============================================================================
// Slash command autocomplete
// ============================================================================

describe('Slash command autocomplete', () => {
	const commands = [
		{ command: '/help', description: 'Show help' },
		{ command: '/clear', description: 'Clear output' },
		{ command: '/run', description: 'Run command', aiOnly: true },
	];

	beforeEach(() => {
		mockInputContext.slashCommandOpen = true;
		mockInputContext.selectedSlashCommandIndex = 0;
	});

	it('navigates down with ArrowDown', () => {
		const deps = createMockDeps({ inputValue: '/', allSlashCommands: commands });
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('ArrowDown');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(mockInputContext.setSelectedSlashCommandIndex).toHaveBeenCalled();
	});

	it('navigates up with ArrowUp', () => {
		const deps = createMockDeps({ inputValue: '/', allSlashCommands: commands });
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('ArrowUp');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(mockInputContext.setSelectedSlashCommandIndex).toHaveBeenCalled();
	});

	it('fills command text on Enter', () => {
		setActiveSession({ inputMode: 'ai' });
		const deps = createMockDeps({ inputValue: '/h', allSlashCommands: commands });
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Enter');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(deps.setInputValue).toHaveBeenCalledWith('/help');
		expect(mockInputContext.setSlashCommandOpen).toHaveBeenCalledWith(false);
	});

	it('fills command text on Tab', () => {
		setActiveSession({ inputMode: 'ai' });
		const deps = createMockDeps({ inputValue: '/h', allSlashCommands: commands });
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Tab');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(deps.setInputValue).toHaveBeenCalledWith('/help');
		expect(deps.inputRef.current!.focus).toHaveBeenCalled();
	});

	it('closes on Escape', () => {
		const deps = createMockDeps({ inputValue: '/', allSlashCommands: commands });
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Escape');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(mockInputContext.setSlashCommandOpen).toHaveBeenCalledWith(false);
	});

	it('filters out aiOnly commands in terminal mode', () => {
		setActiveSession({ inputMode: 'terminal' });
		// Only /run is aiOnly, so it should be filtered out
		// With fuzzy matching, '/r' matches /clear (has 'r') but NOT /run (aiOnly excluded)
		const deps = createMockDeps({ inputValue: '/r', allSlashCommands: commands });
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Enter');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		// /clear fuzzy-matches 'r', so it gets selected (but /run is excluded as aiOnly)
		expect(deps.setInputValue).toHaveBeenCalledWith('/clear');
	});

	it('filters out terminalOnly commands in AI mode', () => {
		setActiveSession({ inputMode: 'ai' });
		const terminalCommand = [{ command: '/shell', description: 'Shell', terminalOnly: true }];
		const deps = createMockDeps({ inputValue: '/s', allSlashCommands: terminalCommand });
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Enter');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(deps.setInputValue).not.toHaveBeenCalled();
	});

	it('returns early after slash command handling (no enter-to-send)', () => {
		setActiveSession({ inputMode: 'ai' });
		const deps = createMockDeps({ inputValue: '/xyz', allSlashCommands: commands });
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('x'); // Regular key that doesn't match any handler

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		// processInput should NOT be called (early return after slash command block)
		expect(deps.processInput).not.toHaveBeenCalled();
	});
});

// ============================================================================
// Enter-to-send logic
// ============================================================================

describe('Enter-to-send', () => {
	beforeEach(() => {
		setActiveSession({ inputMode: 'ai' });
	});

	it('sends on Enter when enterToSendAI is true (AI mode)', () => {
		useSettingsStore.setState({ enterToSendAI: true } as any);
		const deps = createMockDeps();
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Enter');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(e.preventDefault).toHaveBeenCalled();
		expect(deps.processInput).toHaveBeenCalled();
	});

	it('does not send on Enter+Shift when enterToSendAI is true', () => {
		useSettingsStore.setState({ enterToSendAI: true } as any);
		const deps = createMockDeps();
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Enter', { shiftKey: true });

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(deps.processInput).not.toHaveBeenCalled();
	});

	it('sends on Cmd+Enter when enterToSendAI is false', () => {
		useSettingsStore.setState({ enterToSendAI: false } as any);
		const deps = createMockDeps();
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Enter', { metaKey: true });

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(deps.processInput).toHaveBeenCalled();
	});

	it('sends on Ctrl+Enter when enterToSendAI is false', () => {
		useSettingsStore.setState({ enterToSendAI: false } as any);
		const deps = createMockDeps();
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Enter', { ctrlKey: true });

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(deps.processInput).toHaveBeenCalled();
	});

	it('does not send on plain Enter when enterToSendAI is false', () => {
		useSettingsStore.setState({ enterToSendAI: false } as any);
		const deps = createMockDeps();
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Enter');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(deps.processInput).not.toHaveBeenCalled();
	});

	it('uses enterToSendTerminal setting in terminal mode', () => {
		setActiveSession({ inputMode: 'terminal' });
		useSettingsStore.setState({ enterToSendTerminal: true } as any);
		const deps = createMockDeps();
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Enter');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(deps.processInput).toHaveBeenCalled();
	});

	it('does not send on Enter+Meta when enterToSendTerminal is true', () => {
		setActiveSession({ inputMode: 'terminal' });
		useSettingsStore.setState({ enterToSendTerminal: true } as any);
		const deps = createMockDeps();
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Enter', { metaKey: true });

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		// metaKey with enterToSend=true should not match either branch
		expect(deps.processInput).not.toHaveBeenCalled();
	});
});

// ============================================================================
// Escape key
// ============================================================================

describe('Escape key', () => {
	it('blurs input and focuses terminal output', () => {
		setActiveSession({ inputMode: 'ai' });
		const deps = createMockDeps();
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Escape');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(e.preventDefault).toHaveBeenCalled();
		expect(deps.inputRef.current!.blur).toHaveBeenCalled();
		expect(deps.terminalOutputRef.current!.focus).toHaveBeenCalled();
	});
});

// ============================================================================
// Command history (ArrowUp in terminal mode)
// ============================================================================

describe('Command history', () => {
	it('opens command history on ArrowUp in terminal mode', () => {
		setActiveSession({ inputMode: 'terminal' });
		const deps = createMockDeps({ inputValue: 'git st' });
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('ArrowUp');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(e.preventDefault).toHaveBeenCalled();
		expect(mockInputContext.setCommandHistoryOpen).toHaveBeenCalledWith(true);
		expect(mockInputContext.setCommandHistoryFilter).toHaveBeenCalledWith('git st');
		expect(mockInputContext.setCommandHistorySelectedIndex).toHaveBeenCalledWith(0);
	});

	it('does not open command history on ArrowUp in AI mode', () => {
		setActiveSession({ inputMode: 'ai' });
		const deps = createMockDeps();
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('ArrowUp');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(mockInputContext.setCommandHistoryOpen).not.toHaveBeenCalled();
	});
});

// ============================================================================
// Tab completion trigger
// ============================================================================

describe('Tab completion trigger', () => {
	it('prevents default Tab in all modes', () => {
		setActiveSession({ inputMode: 'ai' });
		const deps = createMockDeps();
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Tab');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(e.preventDefault).toHaveBeenCalled();
	});

	it('auto-completes single suggestion in terminal mode', () => {
		setActiveSession({ inputMode: 'terminal' });
		const suggestions = [{ value: 'src/', type: 'folder' as const, label: 'src/' }] as any;
		const deps = createMockDeps({
			inputValue: 'sr',
			getTabCompletionSuggestions: vi.fn().mockReturnValue(suggestions),
		});
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Tab');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(deps.getTabCompletionSuggestions).toHaveBeenCalledWith('sr');
		expect(deps.setInputValue).toHaveBeenCalledWith('src/');
	});

	it('opens dropdown for multiple suggestions', () => {
		setActiveSession({ inputMode: 'terminal' });
		const suggestions = [
			{ value: 'src/', type: 'folder', label: 'src/' },
			{ value: 'scripts/', type: 'folder', label: 'scripts/' },
		] as any;
		const deps = createMockDeps({
			inputValue: 's',
			getTabCompletionSuggestions: vi.fn().mockReturnValue(suggestions),
		});
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Tab');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(mockInputContext.setSelectedTabCompletionIndex).toHaveBeenCalledWith(0);
		expect(mockInputContext.setTabCompletionFilter).toHaveBeenCalledWith('all');
		expect(mockInputContext.setTabCompletionOpen).toHaveBeenCalledWith(true);
	});

	it('does nothing for empty input', () => {
		setActiveSession({ inputMode: 'terminal' });
		const deps = createMockDeps({ inputValue: '' });
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Tab');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(deps.getTabCompletionSuggestions).not.toHaveBeenCalled();
	});

	it('does nothing for whitespace-only input', () => {
		setActiveSession({ inputMode: 'terminal' });
		const deps = createMockDeps({ inputValue: '   ' });
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Tab');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(deps.getTabCompletionSuggestions).not.toHaveBeenCalled();
	});

	it('does nothing when no suggestions', () => {
		setActiveSession({ inputMode: 'terminal' });
		const deps = createMockDeps({
			inputValue: 'zzz',
			getTabCompletionSuggestions: vi.fn().mockReturnValue([]),
		});
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Tab');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(deps.setInputValue).not.toHaveBeenCalled();
		expect(mockInputContext.setTabCompletionOpen).not.toHaveBeenCalled();
	});

	it('does not trigger in AI mode', () => {
		setActiveSession({ inputMode: 'ai' });
		const deps = createMockDeps({
			inputValue: 'src',
			getTabCompletionSuggestions: vi.fn().mockReturnValue([{ value: 'src/' }]),
		});
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Tab');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(deps.getTabCompletionSuggestions).not.toHaveBeenCalled();
	});

	it('does not trigger when slash command open', () => {
		setActiveSession({ inputMode: 'terminal' });
		mockInputContext.slashCommandOpen = true;
		const deps = createMockDeps({
			inputValue: '/he',
			allSlashCommands: [{ command: '/help', description: 'Help' }],
		});
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Tab');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		// Should handle as slash command Tab, not tab completion trigger
		expect(deps.getTabCompletionSuggestions).not.toHaveBeenCalled();
	});
});

// ============================================================================
// Edge cases
// ============================================================================

describe('Edge cases', () => {
	it('handles missing activeSession gracefully', () => {
		// No sessions in store
		useSessionStore.setState({ sessions: [], activeSessionId: '' } as any);
		const deps = createMockDeps();
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Enter');

		// Should not crash
		act(() => {
			result.current.handleInputKeyDown(e);
		});

		// With no active session, enterToSendAI applies (undefined check)
		// enterToSendAI = true, no modifiers → should send
		expect(deps.processInput).toHaveBeenCalled();
	});

	it('handles null inputRef gracefully', () => {
		setActiveSession({ inputMode: 'ai' });
		const deps = createMockDeps({ inputRef: { current: null } as any });
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Escape');

		// Should not crash on null ref
		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(e.preventDefault).toHaveBeenCalled();
	});
});

// ============================================================================
// Additional coverage — Tab completion navigation
// ============================================================================

describe('Tab completion navigation — additional', () => {
	const suggestions = [
		{ value: 'src/', type: 'folder' as const, label: 'src/' },
		{ value: 'package.json', type: 'file' as const, label: 'package.json' },
		{ value: 'README.md', type: 'file' as const, label: 'README.md' },
	] as any;

	beforeEach(() => {
		mockInputContext.tabCompletionOpen = true;
		mockInputContext.selectedTabCompletionIndex = 0;
		setActiveSession({ inputMode: 'terminal' });
	});

	it('Enter with out-of-bounds index closes dropdown without setting input', () => {
		mockInputContext.selectedTabCompletionIndex = 10; // out of bounds
		const deps = createMockDeps({ tabCompletionSuggestions: suggestions });
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Enter');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(deps.setInputValue).not.toHaveBeenCalled();
		expect(mockInputContext.setTabCompletionOpen).toHaveBeenCalledWith(false);
	});

	it('ArrowDown with single suggestion clamps to 0', () => {
		const singleSuggestion = [{ value: 'only/', type: 'folder' as const, label: 'only/' }] as any;
		mockInputContext.selectedTabCompletionIndex = 0;
		const deps = createMockDeps({ tabCompletionSuggestions: singleSuggestion });
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('ArrowDown');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(mockInputContext.setSelectedTabCompletionIndex).toHaveBeenCalledWith(0);
	});

	it('Shift+Tab in git repo wraps backwards from all to file', () => {
		setActiveSession({ inputMode: 'terminal', isGitRepo: true });
		mockInputContext.tabCompletionFilter = 'all';
		const deps = createMockDeps({ tabCompletionSuggestions: suggestions });
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Tab', { shiftKey: true });

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(mockInputContext.setTabCompletionFilter).toHaveBeenCalledWith('file');
		expect(mockInputContext.setSelectedTabCompletionIndex).toHaveBeenCalledWith(0);
	});
});

// ============================================================================
// Additional coverage — @ mention completion
// ============================================================================

describe('@ mention completion — additional', () => {
	const mentions = [
		{
			value: 'src/app.ts',
			type: 'file' as const,
			displayText: 'app.ts',
			fullPath: 'src/app.ts',
			score: 1,
		},
		{
			value: 'src/index.ts',
			type: 'file' as const,
			displayText: 'index.ts',
			fullPath: 'src/index.ts',
			score: 0.9,
		},
	] as any;

	beforeEach(() => {
		mockInputContext.atMentionOpen = true;
		mockInputContext.selectedAtMentionIndex = 0;
		setActiveSession({ inputMode: 'ai' });
	});

	it('Tab/Enter with out-of-bounds index still closes and clears state', () => {
		mockInputContext.selectedAtMentionIndex = 10; // out of bounds
		mockInputContext.atMentionStartIndex = 5;
		mockInputContext.atMentionFilter = 'xyz';
		const deps = createMockDeps({ atMentionSuggestions: mentions, inputValue: 'test @xyz' });
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Enter');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		// Should NOT call setInputValue since selected is undefined
		expect(deps.setInputValue).not.toHaveBeenCalled();
		// But should still close and clear state
		expect(mockInputContext.setAtMentionOpen).toHaveBeenCalledWith(false);
		expect(mockInputContext.setAtMentionFilter).toHaveBeenCalledWith('');
		expect(mockInputContext.setAtMentionStartIndex).toHaveBeenCalledWith(-1);
	});

	it('accept with empty atMentionFilter (just "@" typed)', () => {
		mockInputContext.atMentionFilter = '';
		mockInputContext.atMentionStartIndex = 6;
		const deps = createMockDeps({ atMentionSuggestions: mentions, inputValue: 'hello @ world' });
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Enter');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		// beforeAt = 'hello ', selected.value = 'src/app.ts', afterFilter = ' world'
		expect(deps.setInputValue).toHaveBeenCalledWith('hello @src/app.ts  world');
	});

	it('accept when atMentionStartIndex is at start of input (0)', () => {
		mockInputContext.atMentionFilter = 'app';
		mockInputContext.atMentionStartIndex = 0;
		const deps = createMockDeps({ atMentionSuggestions: mentions, inputValue: '@app rest' });
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Tab');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		// beforeAt = '', afterFilter = ' rest'
		expect(deps.setInputValue).toHaveBeenCalledWith('@src/app.ts  rest');
	});
});

// ============================================================================
// Additional coverage — Slash command autocomplete
// ============================================================================

describe('Slash command autocomplete — additional', () => {
	const commands = [
		{ command: '/help', description: 'Show help' },
		{ command: '/clear', description: 'Clear output' },
		{ command: '/run', description: 'Run command', aiOnly: true },
	];

	beforeEach(() => {
		mockInputContext.slashCommandOpen = true;
		mockInputContext.selectedSlashCommandIndex = 0;
	});

	it('ArrowDown clamps at bottom of filtered command list', () => {
		setActiveSession({ inputMode: 'ai' });
		mockInputContext.selectedSlashCommandIndex = 2; // last index for 3 commands
		const deps = createMockDeps({ inputValue: '/', allSlashCommands: commands });
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('ArrowDown');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		// Should call with a function that clamps: prev + 1 capped at length - 1
		expect(mockInputContext.setSelectedSlashCommandIndex).toHaveBeenCalled();
	});

	it('ArrowUp clamps at top (0)', () => {
		mockInputContext.selectedSlashCommandIndex = 0;
		const deps = createMockDeps({ inputValue: '/', allSlashCommands: commands });
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('ArrowUp');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(mockInputContext.setSelectedSlashCommandIndex).toHaveBeenCalled();
	});

	it('Enter with out-of-bounds selectedSlashCommandIndex does not set input', () => {
		setActiveSession({ inputMode: 'ai' });
		mockInputContext.selectedSlashCommandIndex = 99;
		const deps = createMockDeps({ inputValue: '/xyz', allSlashCommands: commands });
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Enter');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(deps.setInputValue).not.toHaveBeenCalled();
	});

	it('filtering is case-insensitive', () => {
		setActiveSession({ inputMode: 'ai' });
		const deps = createMockDeps({ inputValue: '/HEL', allSlashCommands: commands });
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Enter');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		// '/HEL'.toLowerCase() starts with '/hel' which matches '/help'
		expect(deps.setInputValue).toHaveBeenCalledWith('/help');
	});

	it('regular key during slashCommandOpen returns early without reaching enter-to-send', () => {
		setActiveSession({ inputMode: 'ai' });
		const deps = createMockDeps({ inputValue: '/he', allSlashCommands: commands });
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('l'); // typing a letter

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		// Should return early — no processInput, no setInputValue, no other handlers
		expect(deps.processInput).not.toHaveBeenCalled();
		expect(deps.setInputValue).not.toHaveBeenCalled();
	});
});

// ============================================================================
// Additional coverage — Enter-to-send
// ============================================================================

describe('Enter-to-send — additional', () => {
	it('Enter+Meta when enterToSendAI=true does NOT send', () => {
		setActiveSession({ inputMode: 'ai' });
		useSettingsStore.setState({ enterToSendAI: true } as any);
		const deps = createMockDeps();
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Enter', { metaKey: true });

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(deps.processInput).not.toHaveBeenCalled();
	});

	it('terminal mode with enterToSendTerminal=false requires Cmd+Enter', () => {
		setActiveSession({ inputMode: 'terminal' });
		useSettingsStore.setState({ enterToSendTerminal: false } as any);
		const deps = createMockDeps();
		const { result } = renderHook(() => useInputKeyDown(deps));

		// Plain Enter does not send
		const e1 = createKeyEvent('Enter');
		act(() => {
			result.current.handleInputKeyDown(e1);
		});
		expect(deps.processInput).not.toHaveBeenCalled();

		// Cmd+Enter does send
		const e2 = createKeyEvent('Enter', { metaKey: true });
		act(() => {
			result.current.handleInputKeyDown(e2);
		});
		expect(deps.processInput).toHaveBeenCalled();
	});

	it('no active session uses undefined inputMode, falls to AI enterToSend setting', () => {
		useSessionStore.setState({ sessions: [], activeSessionId: '' } as any);
		useSettingsStore.setState({ enterToSendAI: false } as any);
		const deps = createMockDeps();
		const { result } = renderHook(() => useInputKeyDown(deps));

		// Plain Enter with enterToSendAI=false — does NOT send
		const e1 = createKeyEvent('Enter');
		act(() => {
			result.current.handleInputKeyDown(e1);
		});
		expect(deps.processInput).not.toHaveBeenCalled();

		// Cmd+Enter with enterToSendAI=false — SENDS
		const e2 = createKeyEvent('Enter', { metaKey: true });
		act(() => {
			result.current.handleInputKeyDown(e2);
		});
		expect(deps.processInput).toHaveBeenCalled();
	});
});

// ============================================================================
// Additional coverage — Escape key
// ============================================================================

describe('Escape key — additional', () => {
	it('does not crash when terminalOutputRef is null', () => {
		setActiveSession({ inputMode: 'ai' });
		const deps = createMockDeps({ terminalOutputRef: { current: null } as any });
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Escape');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(e.preventDefault).toHaveBeenCalled();
		expect(deps.inputRef.current!.blur).toHaveBeenCalled();
	});

	it('does not crash when both inputRef and terminalOutputRef are null', () => {
		setActiveSession({ inputMode: 'ai' });
		const deps = createMockDeps({
			inputRef: { current: null } as any,
			terminalOutputRef: { current: null } as any,
		});
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Escape');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(e.preventDefault).toHaveBeenCalled();
	});
});

// ============================================================================
// Additional coverage — Command history
// ============================================================================

describe('Command history — additional', () => {
	it('opens with empty filter when inputValue is empty in terminal mode', () => {
		setActiveSession({ inputMode: 'terminal' });
		const deps = createMockDeps({ inputValue: '' });
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('ArrowUp');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(mockInputContext.setCommandHistoryOpen).toHaveBeenCalledWith(true);
		expect(mockInputContext.setCommandHistoryFilter).toHaveBeenCalledWith('');
		expect(mockInputContext.setCommandHistorySelectedIndex).toHaveBeenCalledWith(0);
	});
});

// ============================================================================
// Additional coverage — General edge cases
// ============================================================================

describe('General edge cases — additional', () => {
	it('ArrowDown with no active session and no dropdowns open is a no-op', () => {
		useSessionStore.setState({ sessions: [], activeSessionId: '' } as any);
		const deps = createMockDeps();
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('ArrowDown');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(e.preventDefault).not.toHaveBeenCalled();
		expect(deps.setInputValue).not.toHaveBeenCalled();
		expect(deps.processInput).not.toHaveBeenCalled();
	});

	it('regular letter key press falls through all handlers without action', () => {
		setActiveSession({ inputMode: 'ai' });
		const deps = createMockDeps();
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('a');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(e.preventDefault).not.toHaveBeenCalled();
		expect(deps.processInput).not.toHaveBeenCalled();
		expect(deps.setInputValue).not.toHaveBeenCalled();
	});

	it('Backspace key falls through without action', () => {
		setActiveSession({ inputMode: 'ai' });
		const deps = createMockDeps();
		const { result } = renderHook(() => useInputKeyDown(deps));
		const e = createKeyEvent('Backspace');

		act(() => {
			result.current.handleInputKeyDown(e);
		});

		expect(e.preventDefault).not.toHaveBeenCalled();
		expect(deps.processInput).not.toHaveBeenCalled();
	});

	it('handleInputKeyDown return value is stable across re-renders', () => {
		const deps = createMockDeps();
		const { result, rerender } = renderHook(() => useInputKeyDown(deps));
		const first = result.current.handleInputKeyDown;
		rerender();
		expect(result.current.handleInputKeyDown).toBe(first);
	});
});
