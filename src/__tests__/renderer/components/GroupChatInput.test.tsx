/**
 * @file GroupChatInput.test.tsx
 * @description Tests for GroupChatInput component, specifically the @mention
 * autocomplete functionality for agent sessions.
 *
 * This test ensures that when a user types '@' in the group chat input,
 * a dropdown appears with available agents (from sessions) that can be
 * selected using Tab/Enter or clicked.
 *
 * Regression test for: Group chat @mention tab completion
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GroupChatInput } from '../../../renderer/components/GroupChatInput';
import type { Theme, Session, Group, GroupChatParticipant } from '../../../renderer/types';

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Creates a minimal mock theme for testing
 */
function createMockTheme(): Theme {
	return {
		id: 'test-theme',
		name: 'Test Theme',
		colors: {
			bgMain: '#1a1a1a',
			bgSidebar: '#252525',
			textMain: '#ffffff',
			textDim: '#888888',
			accent: '#6366f1',
			border: '#333333',
			success: '#22c55e',
			error: '#ef4444',
			warning: '#f59e0b',
			contextFree: '#22c55e',
			contextMedium: '#f59e0b',
			contextHigh: '#ef4444',
		},
	};
}

/**
 * Creates a mock session for testing
 */
function createMockSession(id: string, name: string, toolType: string = 'claude-code'): Session {
	return {
		id,
		name,
		toolType,
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
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [],
		activeTabId: '',
		closedTabHistory: [],
	};
}

/**
 * Creates a mock participant for testing
 */
function createMockParticipant(name: string, agentId: string): GroupChatParticipant {
	return {
		name,
		agentId,
		sessionId: `session-${name}`,
		addedAt: Date.now(),
	};
}

/**
 * Creates a mock group for testing
 */
function createMockGroup(id: string, name: string, emoji: string = '📁'): Group {
	return { id, name, emoji, collapsed: false };
}

/**
 * Default props for GroupChatInput
 */
function createDefaultProps(overrides: Partial<Parameters<typeof GroupChatInput>[0]> = {}) {
	return {
		theme: createMockTheme(),
		state: 'idle' as const,
		onSend: vi.fn(),
		participants: [],
		sessions: [],
		groupChatId: 'test-group-chat',
		...overrides,
	};
}

/**
 * Helper to simulate typing in a textarea
 */
function typeInTextarea(textarea: HTMLTextAreaElement, value: string) {
	fireEvent.change(textarea, { target: { value } });
}

// =============================================================================
// @MENTION AUTOCOMPLETE TESTS
// =============================================================================

describe('GroupChatInput', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	describe('@mention autocomplete', () => {
		it('shows mention dropdown when typing @', () => {
			const sessions = [
				createMockSession('session-1', 'Maestro', 'claude-code'),
				createMockSession('session-2', 'RunMaestro.ai', 'claude-code'),
			];

			render(<GroupChatInput {...createDefaultProps({ sessions })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, '@');

			// Should show dropdown with both sessions
			expect(screen.getByText('@Maestro')).toBeInTheDocument();
			expect(screen.getByText('@RunMaestro.ai')).toBeInTheDocument();
		});

		it('filters mention suggestions as user types', () => {
			const sessions = [
				createMockSession('session-1', 'Maestro', 'claude-code'),
				createMockSession('session-2', 'RunMaestro.ai', 'claude-code'),
				createMockSession('session-3', 'OtherAgent', 'claude-code'),
			];

			render(<GroupChatInput {...createDefaultProps({ sessions })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, '@Mae');

			// Should only show matching sessions (case-insensitive)
			expect(screen.getByText('@Maestro')).toBeInTheDocument();
			expect(screen.queryByText('@OtherAgent')).not.toBeInTheDocument();
		});

		it('inserts mention when clicking suggestion', () => {
			const sessions = [createMockSession('session-1', 'Maestro', 'claude-code')];

			render(<GroupChatInput {...createDefaultProps({ sessions })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, '@');

			// Click on the suggestion
			const suggestion = screen.getByText('@Maestro');
			fireEvent.click(suggestion);

			// Should insert the mention
			expect(textarea.value).toBe('@Maestro ');
		});

		it('inserts mention when pressing Tab', () => {
			const sessions = [createMockSession('session-1', 'Maestro', 'claude-code')];

			render(<GroupChatInput {...createDefaultProps({ sessions })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, '@');

			// Press Tab to select
			fireEvent.keyDown(textarea, { key: 'Tab' });

			// Should insert the mention
			expect(textarea.value).toBe('@Maestro ');
		});

		it('inserts mention when pressing Enter (without modifier)', () => {
			const sessions = [createMockSession('session-1', 'Maestro', 'claude-code')];

			render(<GroupChatInput {...createDefaultProps({ sessions })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, '@');

			// Press Enter to select (without shift)
			fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

			// Should insert the mention
			expect(textarea.value).toBe('@Maestro ');
		});

		it('navigates suggestions with arrow keys', () => {
			const sessions = [
				createMockSession('session-1', 'Agent1', 'claude-code'),
				createMockSession('session-2', 'Agent2', 'claude-code'),
				createMockSession('session-3', 'Agent3', 'claude-code'),
			];

			render(<GroupChatInput {...createDefaultProps({ sessions })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, '@');

			// First item should be selected by default
			// Press ArrowDown to select second item
			fireEvent.keyDown(textarea, { key: 'ArrowDown' });

			// Press Tab to insert
			fireEvent.keyDown(textarea, { key: 'Tab' });

			// Should insert the second agent
			expect(textarea.value).toBe('@Agent2 ');
		});

		it('closes dropdown when pressing Escape', () => {
			const sessions = [createMockSession('session-1', 'Maestro', 'claude-code')];

			render(<GroupChatInput {...createDefaultProps({ sessions })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, '@');

			// Dropdown should be visible
			expect(screen.getByText('@Maestro')).toBeInTheDocument();

			// Press Escape
			fireEvent.keyDown(textarea, { key: 'Escape' });

			// Dropdown should be hidden
			expect(screen.queryByText('@Maestro')).not.toBeInTheDocument();
		});

		it('closes dropdown when typing space after @mention trigger', () => {
			const sessions = [createMockSession('session-1', 'Maestro', 'claude-code')];

			render(<GroupChatInput {...createDefaultProps({ sessions })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, '@');

			// Dropdown should be visible
			expect(screen.getByText('@Maestro')).toBeInTheDocument();

			// Type space to close
			typeInTextarea(textarea, '@ ');

			// Dropdown should be hidden
			expect(screen.queryByText('@Maestro')).not.toBeInTheDocument();
		});

		it('excludes terminal sessions from mention suggestions', () => {
			const sessions = [
				createMockSession('session-1', 'Maestro', 'claude-code'),
				createMockSession('session-2', 'Terminal', 'terminal'),
			];

			render(<GroupChatInput {...createDefaultProps({ sessions })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, '@');

			// Should only show non-terminal sessions
			expect(screen.getByText('@Maestro')).toBeInTheDocument();
			expect(screen.queryByText('@Terminal')).not.toBeInTheDocument();
		});

		it('shows no dropdown when sessions array is empty', () => {
			render(<GroupChatInput {...createDefaultProps({ sessions: [] })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, '@');

			// No dropdown should appear (no agents to suggest)
			// Check that no suggestion buttons exist with @
			const suggestionButtons = screen.queryAllByRole('button');
			const mentionButtons = suggestionButtons.filter((btn) => btn.textContent?.startsWith('@'));
			expect(mentionButtons).toHaveLength(0);
		});

		it('handles sessions with special characters in names', () => {
			const sessions = [
				createMockSession('session-1', 'RunMaestro.ai', 'claude-code'),
				createMockSession('session-2', 'my-agent', 'claude-code'),
				createMockSession('session-3', 'agent_test', 'claude-code'),
			];

			render(<GroupChatInput {...createDefaultProps({ sessions })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, '@');

			// All should be shown
			expect(screen.getByText('@RunMaestro.ai')).toBeInTheDocument();
			expect(screen.getByText('@my-agent')).toBeInTheDocument();
			expect(screen.getByText('@agent_test')).toBeInTheDocument();
		});

		it('shows agent type in parentheses', () => {
			const sessions = [createMockSession('session-1', 'Maestro', 'claude-code')];

			render(<GroupChatInput {...createDefaultProps({ sessions })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, '@');

			// Should show agent type (displayed without parentheses)
			expect(screen.getByText('claude-code')).toBeInTheDocument();
		});

		it('shows the original agent name when it differs from the normalized mention', () => {
			const sessions = [createMockSession('session-1', 'Run Maestro', 'claude-code')];

			render(<GroupChatInput {...createDefaultProps({ sessions })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, '@Run');

			expect(screen.getByText('@Run-Maestro')).toBeInTheDocument();
			expect(screen.getByText('(Run Maestro)')).toBeInTheDocument();
		});

		it('wraps arrow key navigation (down from last goes to first)', () => {
			const sessions = [
				createMockSession('session-1', 'Agent1', 'claude-code'),
				createMockSession('session-2', 'Agent2', 'claude-code'),
			];

			render(<GroupChatInput {...createDefaultProps({ sessions })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, '@');

			// Go to last item
			fireEvent.keyDown(textarea, { key: 'ArrowDown' });

			// Go past last - should wrap to first
			fireEvent.keyDown(textarea, { key: 'ArrowDown' });

			// Insert should get first item
			fireEvent.keyDown(textarea, { key: 'Tab' });
			expect(textarea.value).toBe('@Agent1 ');
		});

		it('wraps arrow key navigation (up from first goes to last)', () => {
			const sessions = [
				createMockSession('session-1', 'Agent1', 'claude-code'),
				createMockSession('session-2', 'Agent2', 'claude-code'),
			];

			render(<GroupChatInput {...createDefaultProps({ sessions })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, '@');

			// Go up from first - should wrap to last
			fireEvent.keyDown(textarea, { key: 'ArrowUp' });

			// Insert should get last item
			fireEvent.keyDown(textarea, { key: 'Tab' });
			expect(textarea.value).toBe('@Agent2 ');
		});

		it('scrolls the selected mention into view and navigates back up from the second item', () => {
			const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
				HTMLElement.prototype,
				'scrollIntoView'
			);
			const scrollIntoView = vi.fn();
			Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
				configurable: true,
				value: scrollIntoView,
			});
			vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
				cb(0);
				return 1;
			});
			const sessions = [
				createMockSession('session-1', 'Agent1', 'claude-code'),
				createMockSession('session-2', 'Agent2', 'claude-code'),
			];

			try {
				render(<GroupChatInput {...createDefaultProps({ sessions })} />);

				const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
				typeInTextarea(textarea, '@');
				fireEvent.keyDown(textarea, { key: 'ArrowDown' });
				fireEvent.keyDown(textarea, { key: 'ArrowUp' });
				fireEvent.keyDown(textarea, { key: 'Tab' });

				expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' });
				expect(textarea.value).toBe('@Agent1 ');
			} finally {
				if (scrollIntoViewDescriptor) {
					Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoViewDescriptor);
				} else {
					delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
				}
			}
		});

		it('leaves the mention dropdown open for unhandled keys', () => {
			const sessions = [createMockSession('session-1', 'Maestro', 'claude-code')];
			render(<GroupChatInput {...createDefaultProps({ sessions })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, '@');
			fireEvent.keyDown(textarea, { key: 'a' });

			expect(screen.getByText('@Maestro')).toBeInTheDocument();
		});
	});

	describe('mention dropdown visibility', () => {
		it('shows dropdown when @ is typed at start of input', () => {
			const sessions = [createMockSession('session-1', 'Maestro', 'claude-code')];
			render(<GroupChatInput {...createDefaultProps({ sessions })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, '@');

			expect(screen.getByText('@Maestro')).toBeInTheDocument();
		});

		it('shows dropdown when @ is typed after text', () => {
			const sessions = [createMockSession('session-1', 'Maestro', 'claude-code')];
			render(<GroupChatInput {...createDefaultProps({ sessions })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, 'Hello @');

			expect(screen.getByText('@Maestro')).toBeInTheDocument();
		});

		it('hides dropdown when all text is deleted', () => {
			const sessions = [createMockSession('session-1', 'Maestro', 'claude-code')];
			render(<GroupChatInput {...createDefaultProps({ sessions })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, '@');

			expect(screen.getByText('@Maestro')).toBeInTheDocument();

			// Clear the input
			typeInTextarea(textarea, '');

			expect(screen.queryByText('@Maestro')).not.toBeInTheDocument();
		});

		it('hides dropdown when no sessions match filter', () => {
			const sessions = [createMockSession('session-1', 'Maestro', 'claude-code')];
			render(<GroupChatInput {...createDefaultProps({ sessions })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, '@xyz');

			// No matches, dropdown should not show
			expect(screen.queryByText('@Maestro')).not.toBeInTheDocument();
		});
	});

	describe('case-insensitive filtering', () => {
		it('filters case-insensitively', () => {
			const sessions = [createMockSession('session-1', 'MyAgent', 'claude-code')];

			render(<GroupChatInput {...createDefaultProps({ sessions })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;

			// Type lowercase
			typeInTextarea(textarea, '@myagent');

			// Should find the PascalCase session
			expect(screen.getByText('@MyAgent')).toBeInTheDocument();
		});
	});

	describe('group @ mentions', () => {
		it('shows groups in mention dropdown', () => {
			const groups = [createMockGroup('group-1', 'PROJECTS', '📁')];
			const sessions = [
				{ ...createMockSession('session-1', 'Agent1', 'claude-code'), groupId: 'group-1' },
				{ ...createMockSession('session-2', 'Agent2', 'claude-code'), groupId: 'group-1' },
			];

			render(<GroupChatInput {...createDefaultProps({ sessions, groups })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, '@');

			// Should show the group in the dropdown
			expect(screen.getByText('@PROJECTS')).toBeInTheDocument();
			expect(screen.getByText(/group · 2/)).toBeInTheDocument();
		});

		it('shows groups before individual agents', () => {
			const groups = [createMockGroup('group-1', 'PROJECTS', '📁')];
			const sessions = [
				{ ...createMockSession('session-1', 'Agent1', 'claude-code'), groupId: 'group-1' },
			];

			render(<GroupChatInput {...createDefaultProps({ sessions, groups })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, '@');

			// Get all buttons in the dropdown
			const buttons = screen.getAllByRole('button');
			const mentionButtons = buttons.filter(
				(btn) => btn.textContent?.includes('@PROJECTS') || btn.textContent?.includes('@Agent1')
			);

			// Group should appear first
			expect(mentionButtons.length).toBeGreaterThanOrEqual(2);
			expect(mentionButtons[0].textContent).toContain('@PROJECTS');
		});

		it('expands group into all member mentions on click', () => {
			const groups = [createMockGroup('group-1', 'PROJECTS', '📁')];
			const sessions = [
				{ ...createMockSession('session-1', 'Agent1', 'claude-code'), groupId: 'group-1' },
				{ ...createMockSession('session-2', 'Agent2', 'claude-code'), groupId: 'group-1' },
			];

			render(<GroupChatInput {...createDefaultProps({ sessions, groups })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, '@');

			// Click the group
			fireEvent.click(screen.getByText('@PROJECTS'));

			// Should expand to all member @mentions
			expect(textarea.value).toBe('@Agent1 @Agent2 ');
		});

		it('expands group via Tab key', () => {
			const groups = [createMockGroup('group-1', 'PROJECTS', '📁')];
			const sessions = [
				{ ...createMockSession('session-1', 'Agent1', 'claude-code'), groupId: 'group-1' },
				{ ...createMockSession('session-2', 'Agent2', 'claude-code'), groupId: 'group-1' },
			];

			render(<GroupChatInput {...createDefaultProps({ sessions, groups })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, '@');

			// Tab to select first item (group)
			fireEvent.keyDown(textarea, { key: 'Tab' });

			expect(textarea.value).toBe('@Agent1 @Agent2 ');
		});

		it('excludes empty groups (no non-terminal members)', () => {
			const groups = [createMockGroup('group-1', 'TERMINALS', '💻')];
			const sessions = [
				{ ...createMockSession('session-1', 'Term1', 'terminal'), groupId: 'group-1' },
			];

			render(<GroupChatInput {...createDefaultProps({ sessions, groups })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, '@');

			// Group should not appear since it has no non-terminal members
			expect(screen.queryByText('@TERMINALS')).not.toBeInTheDocument();
		});

		it('filters groups by name', () => {
			const groups = [
				createMockGroup('group-1', 'PROJECTS', '📁'),
				createMockGroup('group-2', 'TOOLS', '🔧'),
			];
			const sessions = [
				{ ...createMockSession('session-1', 'Agent1', 'claude-code'), groupId: 'group-1' },
				{ ...createMockSession('session-2', 'Agent2', 'claude-code'), groupId: 'group-2' },
			];

			render(<GroupChatInput {...createDefaultProps({ sessions, groups })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, '@proj');

			// Only the matching group should show
			expect(screen.getByText('@PROJECTS')).toBeInTheDocument();
			expect(screen.queryByText('@TOOLS')).not.toBeInTheDocument();
		});

		it('works without groups prop', () => {
			const sessions = [createMockSession('session-1', 'Agent1', 'claude-code')];

			render(<GroupChatInput {...createDefaultProps({ sessions })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, '@');

			// Should still show individual agents
			expect(screen.getByText('@Agent1')).toBeInTheDocument();
		});
	});

	describe('send controls and input behavior', () => {
		it('sends trimmed text with staged images and local read-only mode, then clears draft state', () => {
			const onSend = vi.fn();
			const onDraftChange = vi.fn();
			const setStagedImages = vi.fn();
			render(
				<GroupChatInput
					{...createDefaultProps({
						onSend,
						onDraftChange,
						stagedImages: ['data:image/png;base64,one'],
						setStagedImages,
					})}
				/>
			);
			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;

			typeInTextarea(textarea, '  ship it  ');
			fireEvent.click(screen.getByText('Read-Only'));
			fireEvent.click(screen.getByTitle('Send message'));

			expect(onSend).toHaveBeenCalledWith('ship it', ['data:image/png;base64,one'], true);
			expect(setStagedImages).toHaveBeenCalledWith([]);
			expect(onDraftChange).toHaveBeenLastCalledWith('');
			expect(textarea.value).toBe('');
		});

		it('queues busy messages with the warning send button title', () => {
			const onSend = vi.fn();
			render(<GroupChatInput {...createDefaultProps({ state: 'running', onSend })} />);
			const textarea = screen.getByPlaceholderText(
				'Type to queue message...'
			) as HTMLTextAreaElement;

			typeInTextarea(textarea, 'queue this');
			fireEvent.click(screen.getByTitle('Queue message'));

			expect(onSend).toHaveBeenCalledWith('queue this', undefined, false);
		});

		it('uses Cmd+R, Cmd+Y, Cmd+Enter, and Enter according to the configured send mode', () => {
			const onSend = vi.fn();
			const setReadOnlyMode = vi.fn();
			const onOpenLightbox = vi.fn();
			const { rerender } = render(
				<GroupChatInput
					{...createDefaultProps({
						onSend,
						setReadOnlyMode,
						readOnlyMode: false,
						stagedImages: ['image-a', 'image-b'],
						onOpenLightbox,
					})}
				/>
			);
			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;

			typeInTextarea(textarea, 'from shortcut');
			fireEvent.keyDown(textarea, { key: 'r', metaKey: true });
			fireEvent.keyDown(textarea, { key: 'y', metaKey: true });
			fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });

			expect(setReadOnlyMode).toHaveBeenCalledWith(true);
			expect(onOpenLightbox).toHaveBeenCalledWith(
				['image-a', 'image-b'][0],
				['image-a', 'image-b'],
				'staged'
			);
			expect(onSend).toHaveBeenCalledWith('from shortcut', ['image-a', 'image-b'], false);

			rerender(
				<GroupChatInput
					{...createDefaultProps({
						onSend,
						enterToSendAI: true,
						stagedImages: [],
					})}
				/>
			);
			const enterTextarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(enterTextarea, 'plain enter');
			fireEvent.keyDown(enterTextarea, { key: 'Enter', metaKey: true });
			expect(onSend).toHaveBeenCalledTimes(1);

			fireEvent.keyDown(enterTextarea, { key: 'Enter' });
			expect(onSend).toHaveBeenLastCalledWith('plain enter', undefined, false);
		});

		it('does not intercept unrelated command shortcuts or plain Enter in command-enter mode', () => {
			const onSend = vi.fn();
			render(<GroupChatInput {...createDefaultProps({ onSend })} />);
			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;

			typeInTextarea(textarea, 'draft');
			fireEvent.keyDown(textarea, { key: 'k', metaKey: true });
			fireEvent.keyDown(textarea, { key: 'Enter' });

			expect(onSend).not.toHaveBeenCalled();
			expect(textarea.value).toBe('draft');
		});

		it('does not send blank command-enter submissions', () => {
			const onSend = vi.fn();
			render(<GroupChatInput {...createDefaultProps({ onSend })} />);
			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;

			typeInTextarea(textarea, '   ');
			fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });

			expect(onSend).not.toHaveBeenCalled();
			expect(textarea.value).toBe('   ');
		});

		it('keeps Shift+Enter as a newline gesture when Enter-to-send is enabled', () => {
			const onSend = vi.fn();
			render(<GroupChatInput {...createDefaultProps({ onSend, enterToSendAI: true })} />);
			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;

			typeInTextarea(textarea, 'not yet');
			fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

			expect(onSend).not.toHaveBeenCalled();
		});

		it('opens prompt composer and toggles Enter-to-send from the toolbar', () => {
			const onOpenPromptComposer = vi.fn();
			const setEnterToSendAI = vi.fn();
			render(
				<GroupChatInput
					{...createDefaultProps({
						onOpenPromptComposer,
						setEnterToSendAI,
						enterToSendAI: false,
						shortcuts: {
							openPromptComposer: {
								id: 'openPromptComposer',
								label: 'Prompt composer',
								keys: ['Meta', 'p'],
							},
						},
					})}
				/>
			);

			fireEvent.click(screen.getByTitle(/Open Prompt Composer/));
			fireEvent.click(screen.getByTitle('Switch to Enter to send'));

			expect(onOpenPromptComposer).toHaveBeenCalled();
			expect(setEnterToSendAI).toHaveBeenCalledWith(true);
		});

		it('syncs draft changes from external props and resets when switching group chats', () => {
			const { rerender } = render(
				<GroupChatInput {...createDefaultProps({ draftMessage: 'first draft' })} />
			);
			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			expect(textarea.value).toBe('first draft');

			rerender(<GroupChatInput {...createDefaultProps({ draftMessage: 'external update' })} />);
			expect(textarea.value).toBe('external update');

			rerender(
				<GroupChatInput
					{...createDefaultProps({
						groupChatId: 'next-chat',
						draftMessage: 'next draft',
					})}
				/>
			);
			expect(textarea.value).toBe('next draft');
		});

		it('clears the local draft when switching chats without a saved draft', () => {
			const { rerender } = render(
				<GroupChatInput {...createDefaultProps({ draftMessage: 'saved draft' })} />
			);
			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;

			expect(textarea.value).toBe('saved draft');

			rerender(<GroupChatInput {...createDefaultProps({ groupChatId: 'next-chat' })} />);

			expect(textarea.value).toBe('');
		});

		it('opens the prompt composer without a shortcut hint and forwards the attach button click', () => {
			const onOpenPromptComposer = vi.fn();
			const inputClick = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
			render(<GroupChatInput {...createDefaultProps({ onOpenPromptComposer })} />);

			fireEvent.click(screen.getByTitle('Open Prompt Composer'));
			fireEvent.click(screen.getByTitle('Attach Image'));

			expect(onOpenPromptComposer).toHaveBeenCalled();
			expect(inputClick).toHaveBeenCalled();
		});
	});

	describe('paste, image, and queue behavior', () => {
		it('trims pasted plain text and preserves cursor position', () => {
			const onDraftChange = vi.fn();
			const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
				cb(0);
				return 1;
			});
			render(<GroupChatInput {...createDefaultProps({ onDraftChange })} />);
			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, 'Hello world');
			textarea.selectionStart = 6;
			textarea.selectionEnd = 11;
			const preventDefault = vi.fn();

			fireEvent.paste(textarea, {
				preventDefault,
				clipboardData: {
					items: [],
					getData: () => '  Maestro  ',
				},
			});

			expect(onDraftChange).toHaveBeenLastCalledWith('Hello Maestro');
			expect(textarea.value).toBe('Hello Maestro');
			expect(textarea.selectionStart).toBe(13);
			expect(raf).toHaveBeenCalled();
		});

		it('falls back to the beginning of the draft when paste selection offsets are unavailable', () => {
			const onDraftChange = vi.fn();
			vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
				cb(0);
				return 1;
			});
			render(<GroupChatInput {...createDefaultProps({ onDraftChange })} />);
			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, 'Hello world');
			let selectionStart: number | null = null;
			let selectionEnd: number | null = null;
			Object.defineProperty(textarea, 'selectionStart', {
				configurable: true,
				get: () => selectionStart,
				set: (value) => {
					selectionStart = value;
				},
			});
			Object.defineProperty(textarea, 'selectionEnd', {
				configurable: true,
				get: () => selectionEnd,
				set: (value) => {
					selectionEnd = value;
				},
			});

			fireEvent.paste(textarea, {
				clipboardData: {
					items: [],
					getData: () => '  Maestro  ',
				},
			});

			expect(onDraftChange).toHaveBeenLastCalledWith('MaestroHello world');
			expect(textarea.value).toBe('MaestroHello world');
		});

		it('leaves exact plain text paste and empty clipboard text to the browser', () => {
			const onDraftChange = vi.fn();
			render(<GroupChatInput {...createDefaultProps({ onDraftChange })} />);
			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, 'Hello');
			const preventDefault = vi.fn();

			fireEvent.paste(textarea, {
				preventDefault,
				clipboardData: {
					items: [],
					getData: () => 'Maestro',
				},
			});
			fireEvent.paste(textarea, {
				preventDefault,
				clipboardData: {
					items: [],
					getData: () => '',
				},
			});

			expect(preventDefault).not.toHaveBeenCalled();
			expect(onDraftChange).toHaveBeenLastCalledWith('Hello');
			expect(textarea.value).toBe('Hello');
		});

		it('delegates image paste and drop events to app-level handlers', () => {
			const handlePaste = vi.fn();
			const handleDrop = vi.fn();
			render(<GroupChatInput {...createDefaultProps({ handlePaste, handleDrop })} />);
			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;

			fireEvent.paste(textarea, {
				clipboardData: {
					items: [{ type: 'image/png' }],
					getData: () => '',
				},
			});
			fireEvent.drop(textarea, { dataTransfer: { files: [] } });

			expect(handlePaste).toHaveBeenCalled();
			expect(handleDrop).toHaveBeenCalled();
		});

		it('prevents default browser handling for dragover events', () => {
			render(<GroupChatInput {...createDefaultProps()} />);
			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			const event = new Event('dragover', { bubbles: true, cancelable: true });

			const notCanceled = textarea.dispatchEvent(event);

			expect(notCanceled).toBe(false);
			expect(event.defaultPrevented).toBe(true);
		});

		it('loads selected image files, rejects invalid selections, and clears the file input', async () => {
			const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			class MockFileReader {
				onload: ((event: { target: { result: string } }) => void) | null = null;
				readAsDataURL() {
					this.onload?.({ target: { result: 'data:image/png;base64,loaded' } });
				}
			}
			vi.stubGlobal('FileReader', MockFileReader);
			render(<GroupChatInput {...createDefaultProps()} />);
			const input = document.getElementById('group-chat-image-input') as HTMLInputElement;
			const validFile = new File(['ok'], 'ok.png', { type: 'image/png' });
			const invalidFile = new File(['bad'], 'bad.txt', { type: 'text/plain' });
			const hugeFile = new File(['x'], 'huge.png', { type: 'image/png' });
			Object.defineProperty(hugeFile, 'size', { value: 11 * 1024 * 1024 });

			fireEvent.change(input, {
				target: {
					files: [validFile, invalidFile, hugeFile],
				},
			});

			expect(await screen.findByAltText('Staged image')).toHaveAttribute(
				'src',
				'data:image/png;base64,loaded'
			);
			expect(consoleWarn).toHaveBeenCalledWith(
				'[GroupChatInput] Invalid file type rejected: text/plain'
			);
			expect(consoleWarn).toHaveBeenCalledWith(
				'[GroupChatInput] File too large rejected: 11.00MB (max: 10MB)'
			);
			expect(input.value).toBe('');
		});

		it('ignores duplicate image reads and failed reader results', async () => {
			const showFlashNotification = vi.fn();
			let readCount = 0;
			class MockFileReader {
				onload: ((event: { target?: { result?: string } }) => void) | null = null;
				readAsDataURL() {
					readCount += 1;
					if (readCount <= 2) {
						this.onload?.({ target: { result: 'data:image/png;base64,duplicate' } });
					} else {
						this.onload?.({ target: {} });
					}
				}
			}
			vi.stubGlobal('FileReader', MockFileReader);
			render(<GroupChatInput {...createDefaultProps({ showFlashNotification })} />);
			const input = document.getElementById('group-chat-image-input') as HTMLInputElement;
			const first = new File(['one'], 'one.png', { type: 'image/png' });
			const second = new File(['two'], 'two.png', { type: 'image/png' });
			const failed = new File(['bad'], 'bad.png', { type: 'image/png' });

			fireEvent.change(input, {
				target: {
					files: [first, second, failed],
				},
			});

			const images = await screen.findAllByAltText('Staged image');
			expect(images).toHaveLength(1);
			expect(images[0]).toHaveAttribute('src', 'data:image/png;base64,duplicate');
			expect(showFlashNotification).toHaveBeenCalledWith('Duplicate image ignored');
		});

		it('treats an empty file selection as a no-op', () => {
			const showFlashNotification = vi.fn();
			render(<GroupChatInput {...createDefaultProps({ showFlashNotification })} />);
			const input = document.getElementById('group-chat-image-input') as HTMLInputElement;

			fireEvent.change(input, {
				target: {
					files: null,
				},
			});

			expect(screen.queryByAltText('Staged image')).not.toBeInTheDocument();
			expect(showFlashNotification).not.toHaveBeenCalled();
		});

		it('opens staged images in the lightbox and removes them from staged state', () => {
			const onOpenLightbox = vi.fn();
			const setStagedImages = vi.fn();
			render(
				<GroupChatInput
					{...createDefaultProps({
						stagedImages: ['img-a', 'img-b'],
						setStagedImages,
						onOpenLightbox,
					})}
				/>
			);

			fireEvent.click(screen.getAllByAltText('Staged image')[0]);
			fireEvent.click(screen.getAllByText('×')[0]);

			expect(onOpenLightbox).toHaveBeenCalledWith('img-a', ['img-a', 'img-b'], 'staged');
			const updater = setStagedImages.mock.calls[0][0] as (prev: string[]) => string[];
			expect(updater(['img-a', 'img-b'])).toEqual(['img-b']);
		});

		it('renders queued items and forwards queue removal', () => {
			const onRemoveQueuedItem = vi.fn();
			const onReorderQueuedItems = vi.fn();
			render(
				<GroupChatInput
					{...createDefaultProps({
						executionQueue: [
							{
								id: 'queued-1',
								timestamp: Date.now(),
								tabId: 'tab-1',
								type: 'message',
								text: 'Queued message',
							},
						],
						onRemoveQueuedItem,
						onReorderQueuedItems,
					})}
				/>
			);

			expect(screen.getByText('Queued message')).toBeInTheDocument();
			fireEvent.click(screen.getByTitle('Remove from queue'));
			fireEvent.click(screen.getByText('Remove'));

			expect(onRemoveQueuedItem).toHaveBeenCalledWith('queued-1');
		});
	});
});
