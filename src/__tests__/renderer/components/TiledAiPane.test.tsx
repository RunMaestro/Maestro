/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
import {
	TiledLayout,
	type PaneChatActions,
} from '../../../renderer/components/MainPanel/TiledLayout';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { outputSearchKeyFor } from '../../../renderer/utils/outputSearch';
import type { TabGroup, Theme } from '../../../renderer/types';
import { createMockSession } from '../../helpers/mockSession';

// Capture the props each tiled AI pane hands its chat view. The wiring IS the
// behavior under test (a tiled AI tab used to render a read-only transcript with
// no queue actions at all), so a stub that records props is the whole assertion
// surface - rendering the real TerminalOutput would drag in the markdown stack.
// forwardRef because the pane hands it an output ref; a plain function stub would
// warn and render an extra propless pass.
const chatProps: Record<string, unknown>[] = [];
vi.mock('../../../renderer/components/TerminalOutput', () => ({
	TerminalOutput: React.forwardRef((props: Record<string, unknown>, _ref: unknown) => {
		chatProps.push(props);
		return <div data-testid="pane-chat" />;
	}),
}));

const theme = {
	colors: { accent: '#89b4fa', bgMain: '#1e1e2e', border: '#313244', textDim: '#6c7086' },
} as unknown as Theme;

/** Two AI tabs tiled side by side, with the FIRST pane focused. */
function makeGroup(): TabGroup {
	return {
		id: 'g1',
		name: 'Group',
		layout: {
			kind: 'split',
			id: 'split-1',
			direction: 'row',
			sizes: [0.5, 0.5],
			children: [
				{ kind: 'leaf', id: 'leaf-1', tab: { type: 'ai', id: 'ai-1' } },
				{ kind: 'leaf', id: 'leaf-2', tab: { type: 'ai', id: 'ai-2' } },
			],
		},
		focusedPaneId: 'leaf-1',
		createdAt: 0,
	};
}

function makeSession() {
	const base = createMockSession({ id: 's1' });
	return {
		...base,
		// focusPaneInSession keeps activeTabId on the focused AI pane's tab.
		activeTabId: 'ai-1',
		aiTabs: [
			{ ...base.aiTabs[0], id: 'ai-1', name: 'One' },
			{ ...base.aiTabs[0], id: 'ai-2', name: 'Two' },
		],
	};
}

describe('tiled AI pane chat wiring', () => {
	beforeEach(() => {
		chatProps.length = 0;
		useSessionStore.getState().setSessions([]);
		useUIStore.setState({ outputSearchByKey: {} });
	});

	it('gives every AI pane the same queue actions the single view has', () => {
		const actions: PaneChatActions = {
			onForceSendQueuedItem: vi.fn(),
			forcedParallelEnabled: true,
			getForceSendContext: vi.fn(),
			onRemoveQueuedItem: vi.fn(),
			onTogglePauseQueuedItem: vi.fn(),
			onEditQueuedItem: vi.fn(),
			onReorderQueuedItem: vi.fn(),
			onDeleteLog: vi.fn(),
			onReplayMessage: vi.fn(),
			onForkConversation: vi.fn(),
		};
		const session = makeSession();
		useSessionStore.getState().setSessions([session]);

		render(
			<TiledLayout group={makeGroup()} session={session} theme={theme} paneChatActions={actions} />
		);

		expect(chatProps).toHaveLength(2);
		for (const props of chatProps) {
			expect(props.onForceSendQueuedItem).toBe(actions.onForceSendQueuedItem);
			expect(props.forcedParallelEnabled).toBe(true);
			expect(props.getForceSendContext).toBe(actions.getForceSendContext);
			expect(props.onRemoveQueuedItem).toBe(actions.onRemoveQueuedItem);
			expect(props.onTogglePauseQueuedItem).toBe(actions.onTogglePauseQueuedItem);
			expect(props.onEditQueuedItem).toBe(actions.onEditQueuedItem);
			expect(props.onReorderQueuedItem).toBe(actions.onReorderQueuedItem);
			expect(props.onDeleteLog).toBe(actions.onDeleteLog);
			expect(props.onReplayMessage).toBe(actions.onReplayMessage);
			expect(props.onForkConversation).toBe(actions.onForkConversation);
		}
	});

	it('arms the Force Send shortcut only on the focused pane', () => {
		const session = makeSession();
		useSessionStore.getState().setSessions([session]);

		render(
			<TiledLayout
				group={makeGroup()}
				session={session}
				theme={theme}
				paneChatActions={{ onForceSendQueuedItem: vi.fn(), forcedParallelEnabled: true }}
			/>
		);

		// The shortcut event is global: without this gate BOTH panes would pop their
		// own confirmation dialog on one keypress.
		expect(chatProps[0].forceSendShortcutEnabled).toBe(true);
		expect(chatProps[1].forceSendShortcutEnabled).toBe(false);
	});

	it('falls back to inert setters when no chat actions are wired', () => {
		const session = makeSession();
		useSessionStore.getState().setSessions([session]);

		render(<TiledLayout group={makeGroup()} session={session} theme={theme} />);

		expect(chatProps[0].onForceSendQueuedItem).toBeUndefined();
		expect(typeof chatProps[0].setLightboxImage).toBe('function');
		expect(typeof chatProps[0].setMarkdownEditMode).toBe('function');
	});

	it('gives each pane its own Find slot, scoped to that pane tab', () => {
		const session = makeSession();
		useSessionStore.getState().setSessions([session]);
		// Open Find on the SECOND pane's tab only.
		useUIStore.getState().setOutputSearchOpen(outputSearchKeyFor('s1', 'ai-2'), true);
		useUIStore.getState().setOutputSearchQuery(outputSearchKeyFor('s1', 'ai-2'), 'needle');

		render(<TiledLayout group={makeGroup()} session={session} theme={theme} />);

		// A panel-scoped Find would have opened in both panes with one shared term.
		expect(chatProps[0].outputSearchOpen).toBe(false);
		expect(chatProps[0].outputSearchQuery).toBe('');
		expect(chatProps[1].outputSearchOpen).toBe(true);
		expect(chatProps[1].outputSearchQuery).toBe('needle');
	});

	it('routes a pane Find toggle to that pane tab, not the focused one', () => {
		const session = makeSession();
		useSessionStore.getState().setSessions([session]);

		render(<TiledLayout group={makeGroup()} session={session} theme={theme} />);

		(chatProps[1].setOutputSearchOpen as (v: boolean) => void)(true);

		const byKey = useUIStore.getState().outputSearchByKey;
		expect(byKey[outputSearchKeyFor('s1', 'ai-2')]?.open).toBe(true);
		expect(byKey[outputSearchKeyFor('s1', 'ai-1')]?.open ?? false).toBe(false);
	});

	it('persists scroll position and at-bottom against the pane own tab', () => {
		const session = makeSession();
		useSessionStore.getState().setSessions([session]);
		// The tab-id-keyed store actions scope to the active agent.
		useSessionStore.setState({ activeSessionId: 's1' });

		render(<TiledLayout group={makeGroup()} session={session} theme={theme} />);

		// Scrolling a BACKGROUND pane must not touch the focused pane's tab: a wheel
		// scroll never focuses a pane, so the active-tab handlers would misattribute it.
		(chatProps[1].onScrollPositionChange as (v: number) => void)(420);
		(chatProps[1].onAtBottomChange as (v: boolean) => void)(true);

		const tabs = useSessionStore.getState().sessions[0].aiTabs;
		expect(tabs.find((t) => t.id === 'ai-2')?.scrollTop).toBe(420);
		expect(tabs.find((t) => t.id === 'ai-2')?.isAtBottom).toBe(true);
		expect(tabs.find((t) => t.id === 'ai-2')?.hasUnread).toBe(false);
		expect(tabs.find((t) => t.id === 'ai-1')?.scrollTop).toBeUndefined();
	});

	it('hands the app transcript-end marker to the focused pane only', () => {
		const session = makeSession();
		useSessionStore.getState().setSessions([session]);
		const logsEndRef = { current: null } as React.RefObject<HTMLDivElement>;
		const inputRef = { current: null } as React.RefObject<HTMLTextAreaElement>;

		render(
			<TiledLayout
				group={makeGroup()}
				session={session}
				theme={theme}
				paneChatActions={{ logsEndRef, inputRef }}
			/>
		);

		// "Jump to Bottom" scrolls logsEndRef.current.parentElement, so exactly one
		// pane may claim it. The composer is shared, so every pane gets its ref.
		expect(chatProps[0].logsEndRef).toBe(logsEndRef);
		expect(chatProps[1].logsEndRef).not.toBe(logsEndRef);
		expect(chatProps[0].inputRef).toBe(inputRef);
		expect(chatProps[1].inputRef).toBe(inputRef);
	});
});
