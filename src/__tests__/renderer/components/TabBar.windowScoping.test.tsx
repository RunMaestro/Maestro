/**
 * Tests for TabBar multi-window scoping.
 *
 * The main tab bar renders the tab strip of exactly one agent (the active
 * session). In a multi-window world a window must only surface the tab strip of
 * an agent it owns: the primary window is the catch-all owner, while a secondary
 * window owns only its scoped agents and shows an empty tab area for anything
 * else. These tests exercise that scoping through a real WindowProvider.
 *
 * Moving an agent between windows is an agent-level gesture on the Left Bar (the
 * SessionContextMenu "Move to Window" submenu / Cmd+K palette), not a tab-level
 * one - the tab bar no longer participates in cross-window drag-out. The bulk of
 * TabBar behaviour (selection, drag, overlays, unread filter) lives in
 * TabBar.test.tsx; this file is intentionally narrow to the window-ownership gate
 * and keeps real timers so the provider's async hydrate settles cleanly.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { TabBar } from '../../../renderer/components/TabBar';
import { WindowProvider } from '../../../renderer/contexts/WindowContext';
import type { AITab } from '../../../renderer/types';
import type { WindowInfo, WindowState } from '../../../shared/window-types';
import { mockTheme } from '../../helpers/mockTheme';

const windows = () => window.maestro.windows;

function createTab(): AITab {
	return {
		id: 'tab-1',
		agentSessionId: undefined,
		state: 'idle',
		name: 'My Tab',
		starred: false,
		hasUnread: false,
		inputValue: '',
		stagedImages: [],
	};
}

function makeState(partial: Partial<WindowState> & Pick<WindowState, 'id'>): WindowState {
	return {
		x: 0,
		y: 0,
		width: 1200,
		height: 800,
		isMaximized: false,
		isFullScreen: false,
		sessionIds: [],
		activeSessionId: null,
		leftPanelCollapsed: false,
		rightPanelCollapsed: false,
		...partial,
	};
}

function makeInfo(partial: Partial<WindowInfo> & Pick<WindowInfo, 'id'>): WindowInfo {
	return { isMain: false, sessionIds: [], activeSessionId: null, ...partial };
}

function setUrl(search: string): void {
	window.history.replaceState({}, '', search || '/');
}

function renderInWindow(sessionId: string) {
	function wrapper({ children }: { children: ReactNode }) {
		return <WindowProvider>{children}</WindowProvider>;
	}
	return render(
		<TabBar
			tabs={[createTab()]}
			activeTabId="tab-1"
			theme={mockTheme}
			sessionId={sessionId}
			onTabSelect={vi.fn()}
			onTabClose={vi.fn()}
			onNewTab={vi.fn()}
		/>,
		{ wrapper }
	);
}

describe('TabBar - window scoping', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		setUrl('/');
		vi.mocked(windows().getState).mockResolvedValue(null);
		vi.mocked(windows().list).mockResolvedValue([]);
	});

	afterEach(() => {
		setUrl('/');
	});

	it('renders normally without a WindowProvider (single-window fallback)', () => {
		render(
			<TabBar
				tabs={[createTab()]}
				activeTabId="tab-1"
				theme={mockTheme}
				sessionId="agent-A"
				onTabSelect={vi.fn()}
				onTabClose={vi.fn()}
				onNewTab={vi.fn()}
			/>
		);
		expect(screen.getByText('My Tab')).toBeInTheDocument();
	});

	it('primary window surfaces the active agent (catch-all owner)', async () => {
		setUrl('/');
		vi.mocked(windows().getState).mockResolvedValue(makeState({ id: 'primary-1' }));
		vi.mocked(windows().list).mockResolvedValue([makeInfo({ id: 'primary-1', isMain: true })]);

		renderInWindow('agent-A');

		expect(await screen.findByText('My Tab')).toBeInTheDocument();
	});

	it('primary window hides an agent a secondary window has claimed', async () => {
		setUrl('/');
		vi.mocked(windows().getState).mockResolvedValue(makeState({ id: 'primary-1' }));
		vi.mocked(windows().list).mockResolvedValue([
			makeInfo({ id: 'primary-1', isMain: true }),
			makeInfo({ id: 'win-2', sessionIds: ['agent-A'], activeSessionId: 'agent-A' }),
		]);

		renderInWindow('agent-A');

		// Once the registry snapshot hydrates, the claimed agent's strip disappears.
		await waitFor(() => expect(screen.queryByText('My Tab')).not.toBeInTheDocument());
	});

	it('secondary window shows an empty tab area for an agent it does not own', async () => {
		setUrl('/?windowId=win-2');
		vi.mocked(windows().getState).mockResolvedValue(
			makeState({ id: 'win-2', sessionIds: [], activeSessionId: null })
		);

		renderInWindow('agent-A');

		await waitFor(() => expect(windows().getState).toHaveBeenCalled());
		expect(screen.queryByText('My Tab')).not.toBeInTheDocument();
		// The tab-bar chrome (new-tab button) still renders - only the strip is empty.
		expect(screen.getByTitle(/New tab/)).toBeInTheDocument();
	});

	it('secondary window surfaces an agent it does own', async () => {
		setUrl('/?windowId=win-2');
		vi.mocked(windows().getState).mockResolvedValue(
			makeState({ id: 'win-2', sessionIds: ['agent-A'], activeSessionId: 'agent-A' })
		);

		renderInWindow('agent-A');

		expect(await screen.findByText('My Tab')).toBeInTheDocument();
	});
});
