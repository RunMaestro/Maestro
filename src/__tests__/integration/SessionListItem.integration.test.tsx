import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SessionListItem } from '../../renderer/components/SessionListItem';
import type { ClaudeSession } from '../../renderer/hooks/agent/useSessionViewer';
import { THEMES } from '../../shared/themes';

const theme = THEMES.dracula;

const baseSession: ClaudeSession = {
	sessionId: 'agent-alpha-123',
	projectPath: '/workspace/project',
	timestamp: '2026-01-01T00:00:00.000Z',
	modifiedAt: '2026-01-01T00:00:00.000Z',
	firstMessage: 'Build the settings panel',
	messageCount: 12,
	sizeBytes: 2048,
	costUsd: 1.25,
	inputTokens: 100,
	outputTokens: 200,
	cacheReadTokens: 0,
	cacheCreationTokens: 0,
	durationSeconds: 30,
	origin: 'user',
	sessionName: 'Settings work',
};

function renderSessionListItem(
	overrides: Partial<React.ComponentProps<typeof SessionListItem>> = {}
) {
	const selectedItemRef = React.createRef<HTMLDivElement>();
	const renameInputRef = React.createRef<HTMLInputElement>();
	const props = {
		session: baseSession,
		index: 0,
		selectedIndex: 1,
		isStarred: false,
		activeAgentSessionId: null,
		renamingSessionId: null,
		renameValue: '',
		searchMode: 'title' as const,
		searchResultInfo: null,
		theme,
		selectedItemRef,
		renameInputRef,
		onSessionClick: vi.fn(),
		onToggleStar: vi.fn(),
		onQuickResume: vi.fn(),
		onStartRename: vi.fn(),
		onRenameChange: vi.fn(),
		onSubmitRename: vi.fn(),
		onCancelRename: vi.fn(),
		...overrides,
	};

	const result = render(<SessionListItem {...props} />);

	return { ...result, props };
}

describe('SessionListItem', () => {
	it('renders a named active user session with stats, cost, and selected styling', () => {
		const { container, props } = renderSessionListItem({
			selectedIndex: 0,
			activeAgentSessionId: baseSession.sessionId,
			isStarred: true,
			searchMode: 'all',
			searchResultInfo: { matchCount: 2, matchPreview: 'settings panel requirements' },
		});

		const row = container.firstElementChild as HTMLElement;

		expect(props.selectedItemRef.current).toBe(row);
		expect(row).toHaveStyle({ backgroundColor: `${theme.colors.accent}15` });
		expect(screen.getByText('Settings work')).toBeInTheDocument();
		expect(screen.getByText('Build the settings panel')).toBeInTheDocument();
		expect(screen.getByText('MAESTRO')).toBeInTheDocument();
		expect(screen.getByText('AGENT-ALPHA')).toBeInTheDocument();
		expect(screen.getByText('12')).toBeInTheDocument();
		expect(screen.getByText('2.0 KB')).toBeInTheDocument();
		expect(screen.getByText('1.25')).toBeInTheDocument();
		expect(screen.getByText('2')).toBeInTheDocument();
		expect(screen.getByText('"settings panel requirements"')).toBeInTheDocument();
		expect(screen.getByText('ACTIVE')).toBeInTheDocument();
		expect(screen.getByTitle('Remove from favorites')).toBeInTheDocument();
	});

	it.each([
		{ origin: 'auto' as const, label: 'AUTO' },
		{ origin: undefined, label: 'CLI' },
	])('renders the $label origin pill', ({ origin, label }) => {
		renderSessionListItem({
			session: {
				...baseSession,
				sessionId: 'standalone-session-id',
				origin,
				sessionName: undefined,
				costUsd: 0,
			},
		});

		expect(screen.getByText(label)).toBeInTheDocument();
		expect(screen.getByText('STANDALONE')).toBeInTheDocument();
		expect(screen.getByTitle('Add session name')).toBeInTheDocument();
		expect(screen.queryByText('1.25')).not.toBeInTheDocument();
	});

	it('calls row and action handlers with the selected session', () => {
		const { container, props } = renderSessionListItem();
		const row = container.firstElementChild as HTMLElement;

		fireEvent.click(row);
		fireEvent.click(screen.getByTitle('Add to favorites'));
		fireEvent.click(screen.getByTitle('Resume session in new tab'));
		fireEvent.click(screen.getByTitle('Rename session'));

		expect(props.onSessionClick).toHaveBeenCalledWith(baseSession);
		expect(props.onToggleStar).toHaveBeenCalledWith(baseSession.sessionId, expect.any(Object));
		expect(props.onQuickResume).toHaveBeenCalledWith(baseSession, expect.any(Object));
		expect(props.onStartRename).toHaveBeenCalledWith(baseSession, expect.any(Object));
	});

	it('starts rename from the add-name action for unnamed sessions', () => {
		const unnamedSession = { ...baseSession, sessionName: undefined };
		const { props } = renderSessionListItem({ session: unnamedSession });

		fireEvent.click(screen.getByTitle('Add session name'));

		expect(props.onStartRename).toHaveBeenCalledWith(unnamedSession, expect.any(Object));
	});

	it('renders fallback title, empty agent segment, and no cost for sparse sessions', () => {
		renderSessionListItem({
			session: {
				...baseSession,
				sessionId: 'agent-',
				firstMessage: '',
				sessionName: undefined,
				costUsd: undefined,
			},
		});

		expect(screen.getByText('Session agent-...')).toBeInTheDocument();
		expect(screen.getByText('AGENT-')).toBeInTheDocument();
		expect(screen.queryByText('1.25')).not.toBeInTheDocument();
	});

	it('hides content-search metadata in title search mode', () => {
		renderSessionListItem({
			searchMode: 'title',
			searchResultInfo: { matchCount: 3, matchPreview: 'hidden match' },
		});

		expect(screen.queryByText('3')).not.toBeInTheDocument();
		expect(screen.queryByText('"hidden match"')).not.toBeInTheDocument();
	});

	it('renders rename input and handles change, submit, cancel, click, and blur interactions', () => {
		const { props } = renderSessionListItem({
			renamingSessionId: baseSession.sessionId,
			renameValue: 'Draft name',
		});
		const input = screen.getByPlaceholderText('Enter session name...');

		expect(input).toHaveValue('Draft name');
		fireEvent.change(input, { target: { value: 'Final name' } });
		fireEvent.keyDown(input, { key: 'Enter' });
		fireEvent.keyDown(input, { key: 'Escape' });
		fireEvent.keyDown(input, { key: 'Tab' });
		fireEvent.click(input);
		fireEvent.blur(input);

		expect(props.onRenameChange).toHaveBeenCalledWith('Final name');
		expect(props.onSubmitRename).toHaveBeenCalledTimes(2);
		expect(props.onSubmitRename).toHaveBeenNthCalledWith(1, baseSession.sessionId);
		expect(props.onSubmitRename).toHaveBeenNthCalledWith(2, baseSession.sessionId);
		expect(props.onCancelRename).toHaveBeenCalledTimes(1);
	});
});
