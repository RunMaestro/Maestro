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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { GroupChatInput } from '../../../renderer/components/GroupChatInput';
import { useImageAnnotatorStore } from '../../../renderer/components/ImageAnnotator/imageAnnotatorStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { Session, Group, GroupChatParticipant } from '../../../renderer/types';
import { createMockSession as baseCreateMockSession } from '../../helpers/mockSession';
import { resetStores } from '../../helpers/resetStores';

import { createMockTheme } from '../../helpers/mockTheme';

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Creates a minimal mock theme for testing
 */

/**
 * Thin wrapper: positional signature preserved. Delegates to shared factory.
 */
function createMockSession(id: string, name: string, toolType: string = 'claude-code'): Session {
	return baseCreateMockSession({ id, name, toolType: toolType as any });
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
 * Default props for GroupChatInput.
 * Pass `sessions` to seed the store (component self-sources mentions).
 */
function createDefaultProps(
	overrides: Partial<Parameters<typeof GroupChatInput>[0]> & { sessions?: Session[] } = {}
) {
	const { sessions = [], ...rest } = overrides;
	useSessionStore.setState({ sessions });
	return {
		theme: createMockTheme(),
		state: 'idle' as const,
		onSend: vi.fn(),
		participants: [],
		groupChatId: 'test-group-chat',
		...rest,
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
	beforeEach(() => {
		resetStores(useSessionStore, useImageAnnotatorStore);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('draft persistence', () => {
		it('keeps typing local and persists only the latest draft after the debounce', () => {
			vi.useFakeTimers();
			const onDraftChange = vi.fn();
			render(<GroupChatInput {...createDefaultProps({ onDraftChange })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, 'a');
			typeInTextarea(textarea, 'ab');
			typeInTextarea(textarea, 'abc');

			expect(textarea.value).toBe('abc');
			expect(onDraftChange).not.toHaveBeenCalled();

			vi.advanceTimersByTime(300);

			expect(onDraftChange).toHaveBeenCalledTimes(1);
			expect(onDraftChange).toHaveBeenCalledWith('abc', 'test-group-chat');
		});

		it('flushes the pending draft to its original chat when switching chats', () => {
			vi.useFakeTimers();
			const onDraftChange = vi.fn();
			const { rerender } = render(
				<GroupChatInput {...createDefaultProps({ groupChatId: 'chat-a', onDraftChange })} />
			);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, 'draft for a');

			rerender(
				<GroupChatInput
					{...createDefaultProps({
						groupChatId: 'chat-b',
						draftMessage: 'draft for b',
						onDraftChange,
					})}
				/>
			);

			expect(onDraftChange).toHaveBeenCalledWith('draft for a', 'chat-a');
			expect(textarea.value).toBe('draft for b');
		});

		it('flushes the pending draft when the input unmounts', () => {
			vi.useFakeTimers();
			const onDraftChange = vi.fn();
			const { unmount } = render(<GroupChatInput {...createDefaultProps({ onDraftChange })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, 'keep this draft');
			unmount();

			expect(onDraftChange).toHaveBeenCalledOnce();
			expect(onDraftChange).toHaveBeenCalledWith('keep this draft', 'test-group-chat');
		});

		it('cancels a pending local draft when an external draft arrives', () => {
			vi.useFakeTimers();
			const onDraftChange = vi.fn();
			const { rerender } = render(
				<GroupChatInput {...createDefaultProps({ draftMessage: '', onDraftChange })} />
			);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, 'stale local draft');
			rerender(
				<GroupChatInput
					{...createDefaultProps({ draftMessage: 'new external draft', onDraftChange })}
				/>
			);
			vi.advanceTimersByTime(300);

			expect(textarea.value).toBe('new external draft');
			expect(onDraftChange).not.toHaveBeenCalled();
		});

		it('publishes fresh text before opening Prompt Composer', () => {
			vi.useFakeTimers();
			const onDraftChange = vi.fn();
			const onOpenPromptComposer = vi.fn();
			render(<GroupChatInput {...createDefaultProps({ onDraftChange, onOpenPromptComposer })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, 'fresh composer text');
			expect(onDraftChange).not.toHaveBeenCalled();
			fireEvent.click(screen.getByTitle('Open Prompt Composer'));

			expect(onDraftChange).toHaveBeenLastCalledWith('fresh composer text', 'test-group-chat');
			expect(onDraftChange.mock.invocationCallOrder.at(-1)).toBeLessThan(
				onOpenPromptComposer.mock.invocationCallOrder[0]
			);
		});

		it('publishes fresh text before delegating an external file drop', () => {
			vi.useFakeTimers();
			const onDraftChange = vi.fn();
			const handleDrop = vi.fn();
			render(<GroupChatInput {...createDefaultProps({ onDraftChange, handleDrop })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, 'fresh drop text');
			expect(onDraftChange).not.toHaveBeenCalled();
			fireEvent.drop(textarea, { dataTransfer: { files: [] } });

			expect(onDraftChange).toHaveBeenLastCalledWith('fresh drop text', 'test-group-chat');
			expect(onDraftChange.mock.invocationCallOrder.at(-1)).toBeLessThan(
				handleDrop.mock.invocationCallOrder[0]
			);
		});

		it('exposes a flush ref for global shortcuts and outer drop zones', () => {
			vi.useFakeTimers();
			const onDraftChange = vi.fn();
			const draftFlushRef = { current: null as (() => void) | null };
			render(<GroupChatInput {...createDefaultProps({ onDraftChange, draftFlushRef })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, 'global path text');
			expect(onDraftChange).not.toHaveBeenCalled();

			draftFlushRef.current?.();

			expect(onDraftChange).toHaveBeenCalledWith('global path text', 'test-group-chat');
		});
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
			expect(screen.getByText('Maestro')).toBeInTheDocument();
			expect(screen.getByText('RunMaestro.ai')).toBeInTheDocument();
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
			expect(screen.getByText('Maestro')).toBeInTheDocument();
			expect(screen.queryByText('OtherAgent')).not.toBeInTheDocument();
		});

		it('inserts mention when clicking suggestion', () => {
			const sessions = [createMockSession('session-1', 'Maestro', 'claude-code')];

			render(<GroupChatInput {...createDefaultProps({ sessions })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, '@');

			// Click on the suggestion
			const suggestion = screen.getByText('Maestro');
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
			expect(screen.getByText('Maestro')).toBeInTheDocument();

			// Press Escape
			fireEvent.keyDown(textarea, { key: 'Escape' });

			// Dropdown should be hidden
			expect(screen.queryByText('Maestro')).not.toBeInTheDocument();
		});

		it('closes the popover on Escape even when the filter matches no agents', () => {
			// Regression test: AtMentionPopover stays mounted and renders a
			// "No agents available" row instead of disappearing when the filter
			// narrows to zero matches, so Escape must not be gated on
			// atMentionItems.length > 0 or it becomes stuck open with no
			// keyboard way to dismiss it.
			const sessions = [createMockSession('session-1', 'Maestro', 'claude-code')];

			render(<GroupChatInput {...createDefaultProps({ sessions })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, '@zzz');

			expect(screen.getByText('No agents available')).toBeInTheDocument();

			fireEvent.keyDown(textarea, { key: 'Escape' });

			expect(screen.queryByText('No agents available')).not.toBeInTheDocument();
		});

		it('closes the empty popover on Enter instead of falling through to Enter-to-send', () => {
			// Regression test: gating Tab/Enter handling on atMentionItems.length
			// > 0 meant an empty-filtered popover let the keypress fall through
			// to the plain-Enter-sends handler, sending the message with the raw
			// "@zzz" text still in it instead of just closing the popover.
			const onSend = vi.fn();
			const sessions = [createMockSession('session-1', 'Maestro', 'claude-code')];

			render(<GroupChatInput {...createDefaultProps({ sessions, onSend, enterToSendAI: true })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, '@zzz');
			expect(screen.getByText('No agents available')).toBeInTheDocument();

			fireEvent.keyDown(textarea, { key: 'Enter' });

			expect(onSend).not.toHaveBeenCalled();
			expect(screen.queryByText('No agents available')).not.toBeInTheDocument();
		});

		it('does not crash when the agent list shrinks out from under a stale selection', () => {
			// Regression test: atMentionItems can shrink for reasons other than an
			// Arrow keypress (here, the session store changing while the popover
			// is open), so selectedAtMentionIndex isn't guaranteed to stay in
			// range. Accepting via Tab/Enter must look the item up rather than
			// index straight into the array - a stale index closes the popover
			// with nothing inserted (matching AI Chat's useInputKeyDown), rather
			// than crashing or silently accepting whatever item that index now
			// happens to point at.
			const sessions = [
				createMockSession('session-1', 'Agent1', 'claude-code'),
				createMockSession('session-2', 'Agent2', 'claude-code'),
				createMockSession('session-3', 'Agent3', 'claude-code'),
			];

			render(<GroupChatInput {...createDefaultProps({ sessions })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, '@');

			// Select the last item (index 2 of 3).
			fireEvent.keyDown(textarea, { key: 'ArrowDown' });
			fireEvent.keyDown(textarea, { key: 'ArrowDown' });

			// The session list shrinks to one entry without any Arrow keypress to
			// re-clamp selectedAtMentionIndex first.
			act(() => {
				useSessionStore.setState({ sessions: [sessions[0]] });
			});

			expect(() => {
				fireEvent.keyDown(textarea, { key: 'Tab' });
			}).not.toThrow();
			// Nothing was inserted (index 2 no longer resolves to a real item) and
			// the popover closed rather than falling through to Enter-to-send.
			expect(textarea.value).toBe('@');
			expect(screen.queryByText('Agent1')).not.toBeInTheDocument();
		});

		it('closes dropdown when typing space after @mention trigger', () => {
			const sessions = [createMockSession('session-1', 'Maestro', 'claude-code')];

			render(<GroupChatInput {...createDefaultProps({ sessions })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, '@');

			// Dropdown should be visible
			expect(screen.getByText('Maestro')).toBeInTheDocument();

			// Type space to close
			typeInTextarea(textarea, '@ ');

			// Dropdown should be hidden
			expect(screen.queryByText('Maestro')).not.toBeInTheDocument();
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
			expect(screen.getByText('Maestro')).toBeInTheDocument();
			expect(screen.queryByText('Terminal')).not.toBeInTheDocument();
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
			expect(screen.getByText('RunMaestro.ai')).toBeInTheDocument();
			expect(screen.getByText('my-agent')).toBeInTheDocument();
			expect(screen.getByText('agent_test')).toBeInTheDocument();
		});

		it("shows the agent's display name", () => {
			const sessions = [createMockSession('session-1', 'Maestro', 'claude-code')];

			render(<GroupChatInput {...createDefaultProps({ sessions })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, '@');

			// The unified picker shows the provider's display name, not the raw id
			expect(screen.getByText('Claude Code')).toBeInTheDocument();
		});

		it('clamps arrow key navigation at the last item (does not wrap)', () => {
			const sessions = [
				createMockSession('session-1', 'Agent1', 'claude-code'),
				createMockSession('session-2', 'Agent2', 'claude-code'),
			];

			render(<GroupChatInput {...createDefaultProps({ sessions })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, '@');

			// Go to last item
			fireEvent.keyDown(textarea, { key: 'ArrowDown' });

			// Go past last - clamps, stays on the last item (matches InputArea's
			// own @ picker, which this now shares code with)
			fireEvent.keyDown(textarea, { key: 'ArrowDown' });

			fireEvent.keyDown(textarea, { key: 'Tab' });
			expect(textarea.value).toBe('@Agent2 ');
		});

		it('clamps arrow key navigation at the first item (does not wrap)', () => {
			const sessions = [
				createMockSession('session-1', 'Agent1', 'claude-code'),
				createMockSession('session-2', 'Agent2', 'claude-code'),
			];

			render(<GroupChatInput {...createDefaultProps({ sessions })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, '@');

			// Go up from first - clamps, stays on the first item
			fireEvent.keyDown(textarea, { key: 'ArrowUp' });

			fireEvent.keyDown(textarea, { key: 'Tab' });
			expect(textarea.value).toBe('@Agent1 ');
		});
	});

	describe('mention dropdown visibility', () => {
		it('shows dropdown when @ is typed at start of input', () => {
			const sessions = [createMockSession('session-1', 'Maestro', 'claude-code')];
			render(<GroupChatInput {...createDefaultProps({ sessions })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, '@');

			expect(screen.getByText('Maestro')).toBeInTheDocument();
		});

		it('shows dropdown when @ is typed after text', () => {
			const sessions = [createMockSession('session-1', 'Maestro', 'claude-code')];
			render(<GroupChatInput {...createDefaultProps({ sessions })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, 'Hello @');

			expect(screen.getByText('Maestro')).toBeInTheDocument();
		});

		it('hides dropdown when all text is deleted', () => {
			const sessions = [createMockSession('session-1', 'Maestro', 'claude-code')];
			render(<GroupChatInput {...createDefaultProps({ sessions })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, '@');

			expect(screen.getByText('Maestro')).toBeInTheDocument();

			// Clear the input
			typeInTextarea(textarea, '');

			expect(screen.queryByText('Maestro')).not.toBeInTheDocument();
		});

		it('hides dropdown when no sessions match filter', () => {
			const sessions = [createMockSession('session-1', 'Maestro', 'claude-code')];
			render(<GroupChatInput {...createDefaultProps({ sessions })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, '@xyz');

			// No matches, dropdown should not show
			expect(screen.queryByText('Maestro')).not.toBeInTheDocument();
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
			expect(screen.getByText('MyAgent')).toBeInTheDocument();
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

			// Should show the group in the dropdown, with a count of the agents
			// accepting it will expand into.
			expect(screen.getByText('PROJECTS')).toBeInTheDocument();
			expect(screen.getByText('2 agents')).toBeInTheDocument();
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
				(btn) => btn.textContent?.includes('PROJECTS') || btn.textContent?.includes('Agent1')
			);

			// Group should appear first
			expect(mentionButtons.length).toBeGreaterThanOrEqual(2);
			expect(mentionButtons[0].textContent).toContain('PROJECTS');
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
			fireEvent.click(screen.getByText('PROJECTS'));

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
			expect(screen.queryByText('TERMINALS')).not.toBeInTheDocument();
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
			expect(screen.getByText('PROJECTS')).toBeInTheDocument();
			expect(screen.queryByText('TOOLS')).not.toBeInTheDocument();
		});

		it('works without groups prop', () => {
			const sessions = [createMockSession('session-1', 'Agent1', 'claude-code')];

			render(<GroupChatInput {...createDefaultProps({ sessions })} />);

			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			typeInTextarea(textarea, '@');

			// Should still show individual agents
			expect(screen.getByText('Agent1')).toBeInTheDocument();
		});
	});

	// =========================================================================
	// STAGED IMAGES
	// =========================================================================
	//
	// GroupChatInput renders staged images through the same StagedImagesStrip/
	// StagedImageTile InputArea uses, rather than its own hand-rolled thumbnail
	// markup. These tests cover the wiring GroupChatInput itself owns (which
	// prop maps to which callback); the strip's own rendering and drag-to-reorder
	// mechanics are covered by StagedImagesStrip.test.tsx.
	describe('staged images', () => {
		it('renders a thumbnail per staged image and opens the lightbox on click', () => {
			const onOpenLightbox = vi.fn();
			const stagedImages = ['data:image/png;base64,a', 'data:image/png;base64,b'];

			render(
				<GroupChatInput
					{...createDefaultProps({ stagedImages, setStagedImages: vi.fn(), onOpenLightbox })}
				/>
			);

			expect(screen.getByRole('button', { name: 'Staged image 1' })).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Staged image 2' })).toBeInTheDocument();

			fireEvent.click(screen.getByRole('button', { name: 'Staged image 1' }));

			expect(onOpenLightbox).toHaveBeenCalledWith(stagedImages[0], stagedImages, 'staged');
		});

		it('removes a staged image by content when its remove button is clicked', () => {
			const setStagedImages = vi.fn();
			const stagedImages = ['data:image/png;base64,a', 'data:image/png;base64,b'];

			render(<GroupChatInput {...createDefaultProps({ stagedImages, setStagedImages })} />);

			fireEvent.click(screen.getByRole('button', { name: 'Remove image 1' }));

			expect(setStagedImages).toHaveBeenCalledOnce();
			const updater = setStagedImages.mock.calls[0][0] as (prev: string[]) => string[];
			expect(updater(stagedImages)).toEqual([stagedImages[1]]);
		});

		it('opens the shared image annotator for a staged image', () => {
			const stagedImages = ['data:image/png;base64,a'];
			render(
				<GroupChatInput {...createDefaultProps({ stagedImages, setStagedImages: vi.fn() })} />
			);

			fireEvent.click(screen.getByRole('button', { name: 'Annotate image' }));

			const annotatorState = useImageAnnotatorStore.getState();
			expect(annotatorState.isOpen).toBe(true);
			expect(annotatorState.imageDataUrl).toBe(stagedImages[0]);
		});
	});

	// =========================================================================
	// QUEUE STATE
	// =========================================================================
	//
	// The queue belongs to main. The composer's job is to render what main says,
	// which means surfacing the two states a mirror cannot infer for itself: a
	// paused queue sends nothing, and an item already in flight cannot be pulled
	// back. Both used to be invisible, so messages sat there with no explanation
	// and no control.
	describe('queue state', () => {
		const queuedItem = (id: string, text: string) => ({ id, timestamp: 1, text });

		it('renders queued messages from the state main broadcasts', () => {
			render(
				<GroupChatInput
					{...createDefaultProps({
						queueState: { items: [queuedItem('q-1', 'waiting message')], paused: false },
					})}
				/>
			);

			expect(screen.getByText('waiting message')).toBeInTheDocument();
		});

		it('says why a paused queue is not sending, and offers the way out', () => {
			const onResumeQueue = vi.fn();
			render(
				<GroupChatInput
					{...createDefaultProps({
						queueState: { items: [queuedItem('q-1', 'waiting')], paused: true },
						onResumeQueue,
					})}
				/>
			);

			expect(screen.getByText(/Queue paused/i)).toBeInTheDocument();
			fireEvent.click(screen.getByRole('button', { name: /Resume/i }));
			expect(onResumeQueue).toHaveBeenCalled();
		});

		// The reason is the useful half. "Queue paused" alone sends the user hunting.
		it('names the failure that paused the queue', () => {
			render(
				<GroupChatInput
					{...createDefaultProps({
						queueState: {
							items: [
								{
									...queuedItem('q-1', 'waiting'),
									failed: true,
									failureReason: 'moderator binary missing',
								},
							],
							paused: true,
						},
						onResumeQueue: vi.fn(),
					})}
				/>
			);

			expect(screen.getByText(/moderator binary missing/i)).toBeInTheDocument();
		});

		// Without a resume handler there is nothing the button could do, so it is
		// not drawn - a dead control is worse than none.
		it('omits Resume when no handler was passed', () => {
			render(
				<GroupChatInput
					{...createDefaultProps({
						queueState: { items: [queuedItem('q-1', 'waiting')], paused: true },
					})}
				/>
			);

			expect(screen.getByText(/Queue paused/i)).toBeInTheDocument();
			expect(screen.queryByRole('button', { name: /Resume/i })).not.toBeInTheDocument();
		});

		it('marks the in-flight item as unremovable', () => {
			render(
				<GroupChatInput
					{...createDefaultProps({
						queueState: {
							items: [{ ...queuedItem('q-1', 'on its way'), sending: true }],
							paused: false,
						},
					})}
				/>
			);

			expect(screen.getByText(/Sending, cannot remove/i)).toBeInTheDocument();
		});

		it('shows no queue chrome at all when nothing is waiting', () => {
			render(
				<GroupChatInput {...createDefaultProps({ queueState: { items: [], paused: false } })} />
			);

			expect(screen.queryByText(/Queue paused/i)).not.toBeInTheDocument();
			expect(screen.queryByText(/Sending, cannot remove/i)).not.toBeInTheDocument();
		});

		// A client that has not heard from main yet has no queue, which is not the
		// same as an empty one - it must not draw a paused banner on a guess.
		it('renders nothing before the queue has loaded', () => {
			render(<GroupChatInput {...createDefaultProps({ queueState: undefined })} />);

			expect(screen.queryByText(/Queue paused/i)).not.toBeInTheDocument();
		});
	});
});
