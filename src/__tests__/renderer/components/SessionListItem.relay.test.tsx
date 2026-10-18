import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SessionListItem } from '../../../renderer/components/SessionListItem';
import type { ClaudeSession } from '../../../renderer/hooks/agent/useSessionViewer';
import { mockTheme } from '../../helpers/mockTheme';

const session: ClaudeSession = {
	sessionId: 'provider-1',
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

describe('SessionListItem origin', () => {
	it('shows Relay for a Relay session and retains CLI for an unattributed provider session', () => {
		const props = {
			isSelected: false,
			isStarred: false,
			activeAgentSessionId: null,
			isRenaming: false,
			renameValue: '',
			searchMode: 'title' as const,
			theme: mockTheme,
			selectedItemRef: React.createRef<HTMLButtonElement | HTMLDivElement>(),
			renameInputRef: React.createRef<HTMLInputElement>(),
			onSessionClick: vi.fn(),
			onToggleStar: vi.fn(),
			onQuickResume: vi.fn(),
			onStartRename: vi.fn(),
			onRenameChange: vi.fn(),
			onSubmitRename: vi.fn(),
			onCancelRename: vi.fn(),
		};
		const view = render(<SessionListItem {...props} session={{ ...session, origin: 'relay' }} />);
		expect(screen.getByText('Relay')).toBeInTheDocument();
		expect(screen.queryByText('CLI')).not.toBeInTheDocument();
		view.rerender(<SessionListItem {...props} session={session} />);
		expect(screen.getByText('CLI')).toBeInTheDocument();
	});
});
