import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SessionListItem } from '../../../renderer/components/SessionListItem';
import type { ClaudeSession } from '../../../renderer/hooks/agent/useSessionViewer';
import { mockTheme } from '../../helpers/mockTheme';

const baseSession: ClaudeSession = {
	sessionId: 'test-session-1',
	projectPath: '/project',
	timestamp: '2026-10-04T00:00:00Z',
	modifiedAt: '2026-10-04T00:00:00Z',
	firstMessage: 'Hello',
	messageCount: 2,
	sizeBytes: 200,
	inputTokens: 1,
	outputTokens: 1,
	cacheReadTokens: 0,
	cacheCreationTokens: 0,
	durationSeconds: 1,
};

describe('SessionListItem rename IME composition', () => {
	it('submits rename on normal Enter key', () => {
		const onSubmitRename = vi.fn();
		const onCancelRename = vi.fn();

		render(
			<SessionListItem
				session={baseSession}
				isSelected={false}
				isStarred={false}
				activeAgentSessionId={null}
				isRenaming={true}
				renameValue="New Name"
				searchMode="title"
				theme={mockTheme}
				selectedItemRef={React.createRef()}
				renameInputRef={React.createRef()}
				onSessionClick={vi.fn()}
				onToggleStar={vi.fn()}
				onQuickResume={vi.fn()}
				onStartRename={vi.fn()}
				onRenameChange={vi.fn()}
				onSubmitRename={onSubmitRename}
				onCancelRename={onCancelRename}
			/>
		);

		const input = screen.getByPlaceholderText('Enter session name...');
		const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
		const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

		input.dispatchEvent(event);

		expect(onSubmitRename).toHaveBeenCalledWith('test-session-1');
		expect(preventDefaultSpy).toHaveBeenCalled();
	});

	it('does not submit rename on Enter during active IME composition (isComposing: true)', () => {
		const onSubmitRename = vi.fn();
		const onCancelRename = vi.fn();

		render(
			<SessionListItem
				session={baseSession}
				isSelected={false}
				isStarred={false}
				activeAgentSessionId={null}
				isRenaming={true}
				renameValue="New Name"
				searchMode="title"
				theme={mockTheme}
				selectedItemRef={React.createRef()}
				renameInputRef={React.createRef()}
				onSessionClick={vi.fn()}
				onToggleStar={vi.fn()}
				onQuickResume={vi.fn()}
				onStartRename={vi.fn()}
				onRenameChange={vi.fn()}
				onSubmitRename={onSubmitRename}
				onCancelRename={onCancelRename}
			/>
		);

		const input = screen.getByPlaceholderText('Enter session name...');
		const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
		Object.defineProperty(event, 'isComposing', { value: true });
		const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

		input.dispatchEvent(event);

		expect(onSubmitRename).not.toHaveBeenCalled();
		expect(preventDefaultSpy).not.toHaveBeenCalled();
	});

	it('does not submit rename on Enter during Safari IME candidate confirmation (keyCode 229)', () => {
		const onSubmitRename = vi.fn();
		const onCancelRename = vi.fn();

		render(
			<SessionListItem
				session={baseSession}
				isSelected={false}
				isStarred={false}
				activeAgentSessionId={null}
				isRenaming={true}
				renameValue="New Name"
				searchMode="title"
				theme={mockTheme}
				selectedItemRef={React.createRef()}
				renameInputRef={React.createRef()}
				onSessionClick={vi.fn()}
				onToggleStar={vi.fn()}
				onQuickResume={vi.fn()}
				onStartRename={vi.fn()}
				onRenameChange={vi.fn()}
				onSubmitRename={onSubmitRename}
				onCancelRename={onCancelRename}
			/>
		);

		const input = screen.getByPlaceholderText('Enter session name...');
		const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
		Object.defineProperty(event, 'keyCode', { value: 229 });
		const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

		input.dispatchEvent(event);

		expect(onSubmitRename).not.toHaveBeenCalled();
		expect(preventDefaultSpy).not.toHaveBeenCalled();
	});
});
