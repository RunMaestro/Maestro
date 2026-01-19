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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GroupChatInput } from '../../../renderer/components/GroupChatInput';
import type { Theme, Session, GroupChatParticipant } from '../../../renderer/types';

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
});
