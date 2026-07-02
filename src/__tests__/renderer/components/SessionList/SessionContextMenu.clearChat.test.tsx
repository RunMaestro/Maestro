/**
 * Pianola "Clear chat" context-menu contract:
 * - shown ONLY for the pinned Pianola session (never for normal agents);
 * - disabled while the session is busy (a running process must not stream
 *   into a freshly cleared chat);
 * - fires onClearChat then dismisses.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { SessionContextMenu } from '../../../../renderer/components/SessionList/SessionContextMenu';
import type { Session, Theme } from '../../../../renderer/types';

const theme = {
	colors: {
		bgSidebar: '#111',
		border: '#333',
		textMain: '#eee',
		textDim: '#999',
		accent: '#4af',
		error: '#f44',
	},
} as unknown as Theme;

function session(overrides: Partial<Session> = {}): Session {
	return {
		id: 's-1',
		name: 'Pianola',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/home',
		fullPath: '/home',
		projectRoot: '/home',
		isPianola: true,
		aiTabs: [],
		activeTabId: 't-1',
		closedTabHistory: [],
		...overrides,
	} as unknown as Session;
}

function renderMenu(s: Session, onClearChat?: () => void) {
	const onDismiss = vi.fn();
	render(
		<SessionContextMenu
			x={0}
			y={0}
			theme={theme}
			session={s}
			groups={[]}
			hasWorktreeChildren={false}
			onRename={vi.fn()}
			onEdit={vi.fn()}
			onDuplicate={vi.fn()}
			onToggleBookmark={vi.fn()}
			onMoveToGroup={vi.fn()}
			onDelete={vi.fn()}
			onDismiss={onDismiss}
			onClearChat={onClearChat}
		/>
	);
	return { onDismiss };
}

afterEach(cleanup);

describe('SessionContextMenu — Pianola Clear chat', () => {
	it('renders for the pinned Pianola session and fires onClearChat + dismiss', () => {
		const onClearChat = vi.fn();
		const { onDismiss } = renderMenu(session(), onClearChat);
		const item = screen.getByText('Clear chat');
		fireEvent.click(item);
		expect(onClearChat).toHaveBeenCalledTimes(1);
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});

	it('is disabled while the session is busy', () => {
		const onClearChat = vi.fn();
		renderMenu(session({ state: 'busy' }), onClearChat);
		const item = screen.getByText('Clear chat').closest('button');
		expect(item).not.toBeNull();
		expect(item!.disabled).toBe(true);
		fireEvent.click(item!);
		expect(onClearChat).not.toHaveBeenCalled();
	});

	it('never renders for a normal (non-Pianola) session', () => {
		renderMenu(session({ isPianola: false }), vi.fn());
		expect(screen.queryByText('Clear chat')).toBeNull();
	});

	it('never renders when no handler is wired', () => {
		renderMenu(session(), undefined);
		expect(screen.queryByText('Clear chat')).toBeNull();
	});
});
