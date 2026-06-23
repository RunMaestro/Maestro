/**
 * Tests for TabBar multi-window scoping.
 *
 * The main tab bar renders the tab strip of exactly one agent (the active
 * session). In a multi-window world a window must only surface the tab strip of
 * an agent it owns: the primary window is the catch-all owner, while a secondary
 * window owns only its scoped agents and shows an empty tab area for anything
 * else. These tests exercise that scoping through a real WindowProvider.
 *
 * The bulk of TabBar behaviour (selection, drag, overlays, unread filter) lives
 * in TabBar.test.tsx; this file is intentionally narrow to the window-ownership
 * gate and keeps real timers so the provider's async hydrate settles cleanly.
 */

import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
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

	// Drag an agent's tab out of this window and release it: over another Maestro
	// window the agent docks into that window; over empty space it detaches into a
	// brand-new window at the drop point; and a drag that never leaves the window
	// is an in-bar reorder (no cross-window action). The flow threads through the
	// real useTabDragOut hook (bounds snapshot -> drag-exit -> findWindowAtPoint ->
	// drop) and the real WindowContext move helpers, so it exercises the wiring end
	// to end. A microtask flush is needed after dragStart/drag because the bounds
	// and target-window lookups are async IPC.
	describe('cross-window drag-out drop', () => {
		/** Let the hook's async bounds / findWindowAtPoint promises settle. */
		const flush = async () => {
			await act(async () => {
				await Promise.resolve();
			});
		};

		// jsdom's synthetic drag event drops screenX/screenY, so dispatch a real
		// MouseEvent (which carries them) for the continuous drag sample. React's
		// onDrag reads screenX/screenY straight off the native event.
		const fireDragAt = (node: Element, screenX: number, screenY: number) => {
			fireEvent(
				node,
				new MouseEvent('drag', { bubbles: true, cancelable: true, screenX, screenY })
			);
		};

		it('docks the agent into the window under the cursor on drop', async () => {
			setUrl('/');
			vi.mocked(windows().getState).mockResolvedValue(
				makeState({ id: 'primary-1', sessionIds: ['agent-A'], activeSessionId: 'agent-A' })
			);
			vi.mocked(windows().list).mockResolvedValue([
				makeInfo({ id: 'primary-1', isMain: true, sessionIds: ['agent-A'] }),
				makeInfo({ id: 'win-2' }),
			]);
			vi.mocked(windows().getBounds).mockResolvedValue({ x: 0, y: 0, width: 1000, height: 800 });
			vi.mocked(windows().findWindowAtPoint).mockResolvedValue('win-2');

			renderInWindow('agent-A');
			const tab = (await screen.findByText('My Tab')).closest('[data-tab-id]')!;
			// Wait for the provider to adopt the registry id so the move targets it.
			await waitFor(() => expect(windows().list).toHaveBeenCalled());
			await flush();

			fireEvent.dragStart(tab, {
				dataTransfer: { effectAllowed: '', setData: vi.fn() },
			});
			await waitFor(() => expect(windows().getBounds).toHaveBeenCalled());
			await flush();

			// Sample a cursor point well outside the snapshotted window bounds.
			fireDragAt(tab, 2000, 2000);
			await waitFor(() => expect(windows().findWindowAtPoint).toHaveBeenCalledWith(2000, 2000));
			await flush();

			// Hovering win-2 as a dock target lights up its tab bar.
			await waitFor(() => expect(windows().highlightDropZone).toHaveBeenCalledWith('win-2', true));

			fireEvent.dragEnd(tab);

			await waitFor(() =>
				expect(windows().moveSession).toHaveBeenCalledWith('agent-A', 'primary-1', 'win-2')
			);
			// Releasing clears the highlight it lit.
			await waitFor(() => expect(windows().highlightDropZone).toHaveBeenCalledWith('win-2', false));
		});

		it('spawns a new window at the drop point when released over empty space', async () => {
			setUrl('/');
			vi.mocked(windows().getState).mockResolvedValue(
				makeState({ id: 'primary-1', sessionIds: ['agent-A'], activeSessionId: 'agent-A' })
			);
			vi.mocked(windows().list).mockResolvedValue([
				makeInfo({ id: 'primary-1', isMain: true, sessionIds: ['agent-A'] }),
			]);
			vi.mocked(windows().getBounds).mockResolvedValue({ x: 0, y: 0, width: 1000, height: 800 });
			// No Maestro window under the cursor -> empty space -> spawn a new window.
			vi.mocked(windows().findWindowAtPoint).mockResolvedValue(null);
			vi.mocked(windows().create).mockResolvedValue(
				makeInfo({ id: 'win-new', sessionIds: ['agent-A'] })
			);

			renderInWindow('agent-A');
			const tab = (await screen.findByText('My Tab')).closest('[data-tab-id]')!;
			await waitFor(() => expect(windows().list).toHaveBeenCalled());
			await flush();

			fireEvent.dragStart(tab, {
				dataTransfer: { effectAllowed: '', setData: vi.fn() },
			});
			await waitFor(() => expect(windows().getBounds).toHaveBeenCalled());
			await flush();

			fireDragAt(tab, 2000, 2000);
			await waitFor(() => expect(windows().findWindowAtPoint).toHaveBeenCalledWith(2000, 2000));
			await flush();

			fireEvent.dragEnd(tab);

			// Released over empty space at (2000, 2000): a new window spawns offset
			// up/left of the drop point so the released tab lands near the cursor, and
			// the agent transfers into it (leaving the source window).
			await waitFor(() =>
				expect(windows().create).toHaveBeenCalledWith(['agent-A'], { x: 1900, y: 1950 })
			);
			await waitFor(() =>
				expect(windows().moveSession).toHaveBeenCalledWith('agent-A', 'primary-1', 'win-new')
			);
		});

		it('does not spawn or move when the drag never leaves the window (in-bar reorder)', async () => {
			setUrl('/');
			vi.mocked(windows().getState).mockResolvedValue(
				makeState({ id: 'primary-1', sessionIds: ['agent-A'], activeSessionId: 'agent-A' })
			);
			vi.mocked(windows().list).mockResolvedValue([
				makeInfo({ id: 'primary-1', isMain: true, sessionIds: ['agent-A'] }),
			]);
			vi.mocked(windows().getBounds).mockResolvedValue({ x: 0, y: 0, width: 1000, height: 800 });

			renderInWindow('agent-A');
			const tab = (await screen.findByText('My Tab')).closest('[data-tab-id]')!;
			await waitFor(() => expect(windows().list).toHaveBeenCalled());
			await flush();

			fireEvent.dragStart(tab, {
				dataTransfer: { effectAllowed: '', setData: vi.fn() },
			});
			await waitFor(() => expect(windows().getBounds).toHaveBeenCalled());
			await flush();

			// Cursor stays inside the snapshotted bounds for the whole drag, so the tab
			// never "leaves" the window - no hit-test, no spawn, no move.
			fireDragAt(tab, 500, 400);
			await flush();

			fireEvent.dragEnd(tab);
			await flush();

			expect(windows().findWindowAtPoint).not.toHaveBeenCalled();
			expect(windows().create).not.toHaveBeenCalled();
			expect(windows().moveSession).not.toHaveBeenCalled();
		});
	});

	// The receiving side of the cross-window feedback: when the main process pushes
	// a highlightDropZone toggle for THIS window (a tab from elsewhere is hovering
	// it), the tab strip lights up via the `data-drop-target` attribute and clears
	// when the toggle goes false.
	describe('drop-zone highlight (receiving window)', () => {
		it('marks its own tab bar as a drop target on the highlight push', async () => {
			setUrl('/?windowId=win-2');
			vi.mocked(windows().getState).mockResolvedValue(
				makeState({ id: 'win-2', sessionIds: ['agent-A'], activeSessionId: 'agent-A' })
			);

			const { container } = renderInWindow('agent-A');
			await screen.findByText('My Tab');

			const strip = container.querySelector('[data-tour="tab-bar"]')!;
			expect(strip).not.toHaveAttribute('data-drop-target');

			// Fire the push the preload would deliver when another window's tab hovers us.
			const handler = vi.mocked(windows().onHighlightDropZone).mock.calls[0][0];
			act(() => handler({ windowId: 'win-2', active: true }));
			expect(strip).toHaveAttribute('data-drop-target', 'true');

			act(() => handler({ windowId: 'win-2', active: false }));
			expect(strip).not.toHaveAttribute('data-drop-target');
		});
	});
});
