/**
 * TabWindowRoot - the reduced root a `?tabWindow=<id>` renderer mounts in place
 * of the full app (Tab Windows, phase 4).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TabWindowRoot } from '../../../../renderer/components/TabWindow/TabWindowRoot';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import {
	updateAiTab,
	updateSessionWith,
	useSessionStore,
} from '../../../../renderer/stores/sessionStore';
import { useTabWindowStore } from '../../../../renderer/stores/tabWindowStore';
import { notifyToast, useNotificationStore } from '../../../../renderer/stores/notificationStore';
import { useComposerInputStore } from '../../../../renderer/stores/composerInputStore';
import { useCenterFlashStore } from '../../../../renderer/stores/centerFlashStore';
import { clearLiveDraft } from '../../../../renderer/utils/liveDraftStore';
import type { AITab } from '../../../../renderer/types';
import { THEMES } from '../../../../renderer/constants/themes';
import type { TabWindowInfo } from '../../../../shared/tabWindowTypes';
import type { WindowSessionMovedPayload } from '../../../../shared/window-types';
import { createMockAITab, createMockFileTab } from '../../../helpers/mockTab';
import { createMockSession } from '../../../helpers/mockSession';

// The per-tab views are the main panel's own (covered by their tests); here
// they only need to say which tab they were handed.
vi.mock('../../../../renderer/components/MainPanel/TiledLayout', () => ({
	TiledAiPane: ({ aiTabId }: { aiTabId: string }) => <div data-testid="ai-pane">{aiTabId}</div>,
	TiledFilePane: ({ fileTabId }: { fileTabId: string }) => (
		<div data-testid="file-pane">{fileTabId}</div>
	),
	PaneMissingTab: ({ message }: { message?: string }) => (
		<div data-testid="pane-notice">{message ?? 'This tab is no longer available'}</div>
	),
}));

async function renderRoot() {
	const view = render(<TabWindowRoot windowId="tw-7" />);
	await act(async () => {});
	return view;
}

const AGENT = 'agent-1';

/** Three AI tabs and a file tab; this window holds a2 and f1. */
function seedAgent(name = 'Maestro Marketing') {
	useSessionStore.setState({
		sessions: [
			createMockSession({
				id: AGENT,
				name,
				aiTabs: [
					createMockAITab({ id: 'a1', name: 'Owner Chat' }),
					createMockAITab({ id: 'a2', name: 'Popped Chat', agentSessionId: 'claude-a2' }),
					createMockAITab({ id: 'a3', name: 'Other Owner Chat' }),
				],
				filePreviewTabs: [createMockFileTab({ id: 'f1', name: 'notes' })],
				unifiedTabOrder: [
					{ type: 'ai', id: 'a1' },
					{ type: 'ai', id: 'a2' },
					{ type: 'file', id: 'f1' },
					{ type: 'ai', id: 'a3' },
				],
				activeTabId: 'a1',
			}),
		],
	});
}

const WINDOW_INFO: TabWindowInfo = {
	windowId: 'tw-7',
	agentId: AGENT,
	tabRefs: [
		{ type: 'ai', id: 'a2' },
		{ type: 'file', id: 'f1' },
	],
	activeTabRef: { type: 'ai', id: 'a2' },
};

let broadcast: ((payload: WindowSessionMovedPayload) => void) | null = null;
// No patch ever arrives here: these tests seed the store the mirror would fill
// (TabWindowRoot.mirror.test.tsx plays a real patch stream).
// The terminal view is covered by its own tests; here it only reports what the
// tab window handed it (D5). Its last props are kept to call its callbacks.
const terminalViewProps: { current: Record<string, unknown> | null } = { current: null };
vi.mock('../../../../renderer/components/TerminalView', () => ({
	TerminalView: (props: {
		session: { terminalTabs: Array<{ id: string }>; activeTerminalTabId: string | null };
		attachOnly?: boolean;
		isVisible?: boolean;
	}) => {
		terminalViewProps.current = props as unknown as Record<string, unknown>;
		return (
			<div
				data-testid="terminal-view"
				data-tabs={props.session.terminalTabs.map((tab) => tab.id).join(',')}
				data-shown={props.session.activeTerminalTabId ?? ''}
				data-attach-only={String(props.attachOnly === true)}
				data-visible={String(props.isVisible === true)}
			/>
		);
	},
}));

const tabWindowsApi = {
	getState: vi.fn(),
	dock: vi.fn(),
	focus: vi.fn(),
	sendIntent: vi.fn(),
	onSessionPatch: vi.fn(),
};

beforeEach(() => {
	useNotificationStore.getState().clearToasts();
	// A draft typed in one test must not read as unsent in the next.
	useComposerInputStore.setState(useComposerInputStore.getInitialState(), true);
	clearLiveDraft('a2');
	useSessionStore.setState({ sessions: [] });
	useTabWindowStore.setState({ windows: [], poppedByAgent: {} });
	broadcast = null;
	tabWindowsApi.getState.mockReset().mockResolvedValue(null);
	tabWindowsApi.dock.mockReset().mockResolvedValue({ docked: true, windowId: 'tw-7' });
	tabWindowsApi.focus.mockReset().mockResolvedValue({ focused: true, windowId: 'tw-7' });
	tabWindowsApi.sendIntent.mockReset();
	tabWindowsApi.onSessionPatch.mockReset().mockReturnValue(() => {});
	(window.maestro as unknown as { tabWindows: typeof tabWindowsApi }).tabWindows = tabWindowsApi;
	vi.mocked(window.maestro.windows.onSessionMoved).mockImplementation((callback) => {
		broadcast = callback;
		return () => {};
	});
});

afterEach(() => {
	delete (window.maestro as unknown as { tabWindows?: unknown }).tabWindows;
	vi.mocked(window.maestro.windows.onSessionMoved).mockImplementation(() => () => {});
});

describe('TabWindowRoot', () => {
	it('renders its own window, tagged with the registry id', async () => {
		await renderRoot();
		expect(screen.getByTestId('tab-window-root')).toHaveAttribute('data-tab-window-id', 'tw-7');
	});

	it('loads the settings itself, since App.tsx never mounts here', async () => {
		vi.mocked(window.maestro.settings.getAll).mockClear();
		await renderRoot();
		expect(window.maestro.settings.getAll).toHaveBeenCalled();
	});

	it('follows the active theme', async () => {
		act(() => useSettingsStore.setState({ activeThemeId: 'nord' }));
		await renderRoot();
		expect(screen.getByTestId('tab-window-root')).toHaveStyle({
			backgroundColor: THEMES.nord.colors.bgMain,
		});
	});

	it('subscribes to no process:* event but its permission prompts, so no one-shot side effect can run here (D1)', async () => {
		// Record every `window.maestro.process.on*` subscription the root makes.
		const subscribed: string[] = [];
		const original = window.maestro.process;
		window.maestro.process = new Proxy(original, {
			get(target, key, receiver) {
				if (typeof key === 'string' && /^on[A-Z]/.test(key)) {
					subscribed.push(key);
					return () => () => {};
				}
				return Reflect.get(target, key, receiver);
			},
		});
		try {
			const view = await renderRoot();
			view.unmount();
		} finally {
			window.maestro.process = original;
		}
		// The permission prompt only: main prompts a popped tab's requests here, and
		// an exited process's requests leave this window's queue. Neither writes a
		// Session or runs a one-shot side effect.
		expect([...new Set(subscribed)].sort()).toEqual(['onExit', 'onPermissionRequest']);
	});

	it('hosts toasts raised in this window', async () => {
		await renderRoot();
		act(() => {
			notifyToast({ color: 'green', title: 'Docked', message: 'Back in the main window' });
		});
		expect(await screen.findByText('Docked')).toBeInTheDocument();
	});
});

describe('TabWindowRoot shell (TW-2, TW-3)', () => {
	beforeEach(() => {
		seedAgent();
		tabWindowsApi.getState.mockResolvedValue(WINDOW_INFO);
	});

	it('shows the agent name and its status dot in the header', async () => {
		await renderRoot();
		expect(screen.getByTestId('tab-window-agent-name')).toHaveTextContent('Maestro Marketing');
		expect(screen.getByTestId('agent-status-dot')).toHaveAttribute('title', 'Ready');
	});

	it('resolves the dot with the Left Bar rule, so it follows the agent state', async () => {
		await renderRoot();
		act(() => {
			useSessionStore.setState((state) => ({
				sessions: state.sessions.map((s) => ({ ...s, state: 'busy' as const })),
			}));
		});
		expect(screen.getByTestId('agent-status-dot')).toHaveAttribute('title', 'Thinking');
		expect(screen.getByTestId('agent-status-dot')).toHaveStyle({
			backgroundColor: THEMES[useSettingsStore.getState().activeThemeId]?.colors.warning,
		});
	});

	it("draws chips for this window's tabs only, never the owner's", async () => {
		await renderRoot();
		expect(screen.getByText('Popped Chat')).toBeInTheDocument();
		expect(screen.getByText('notes')).toBeInTheDocument();
		expect(screen.queryByText('Owner Chat')).not.toBeInTheDocument();
		expect(screen.queryByText('Other Owner Chat')).not.toBeInTheDocument();
	});

	it('offers no new-tab button: a tab window adds no tabs of its own', async () => {
		await renderRoot();
		expect(screen.queryByTitle(/new tab/i)).not.toBeInTheDocument();
	});

	it('renders the active tab with the main panel view for its type', async () => {
		await renderRoot();
		expect(screen.getByTestId('ai-pane')).toHaveTextContent('a2');
	});

	it('follows the registry when the active tab changes', async () => {
		await renderRoot();
		tabWindowsApi.getState.mockResolvedValue({
			...WINDOW_INFO,
			activeTabRef: { type: 'file', id: 'f1' },
		});
		await act(async () => {
			broadcast?.({ type: 'tab-window-changed', windowId: 'tw-7', agentId: AGENT });
		});
		expect(screen.getByTestId('file-pane')).toHaveTextContent('f1');
		expect(screen.queryByTestId('ai-pane')).not.toBeInTheDocument();
	});

	function seedTerminalAgent() {
		const terminal = (id: string) => ({
			id,
			name: null,
			shellType: 'zsh',
			pid: 4321,
			cwd: '/',
			createdAt: 0,
			state: 'idle',
		});
		useSessionStore.setState({
			sessions: [
				createMockSession({
					id: AGENT,
					name: 'Maestro Marketing',
					aiTabs: [createMockAITab({ id: 'a1' })],
					activeTabId: 'a1',
					terminalTabs: [terminal('t1'), terminal('t2'), terminal('t-owner')] as never,
				}),
			],
		});
	}

	it('attaches its own terminal view to the PTY of a popped terminal tab (D5)', async () => {
		seedTerminalAgent();
		tabWindowsApi.getState.mockResolvedValue({
			...WINDOW_INFO,
			tabRefs: [
				{ type: 'terminal', id: 't1' },
				{ type: 'ai', id: 'a1' },
			],
			activeTabRef: { type: 'terminal', id: 't1' },
		});
		await renderRoot();

		const view = screen.getByTestId('terminal-view');
		// Only this strip's terminals: a tab the owner keeps never mounts here.
		expect(view).toHaveAttribute('data-tabs', 't1');
		expect(view).toHaveAttribute('data-shown', 't1');
		expect(view).toHaveAttribute('data-attach-only', 'true');
		expect(view).toHaveAttribute('data-visible', 'true');
		expect(screen.queryByTestId('pane-notice')).not.toBeInTheDocument();
	});

	it('keeps a terminal mounted, hidden, while another tab shows', async () => {
		seedTerminalAgent();
		tabWindowsApi.getState.mockResolvedValue({
			...WINDOW_INFO,
			tabRefs: [
				{ type: 'terminal', id: 't1' },
				{ type: 'ai', id: 'a1' },
			],
			activeTabRef: { type: 'ai', id: 'a1' },
		});
		await renderRoot();

		expect(screen.getByTestId('ai-pane')).toHaveTextContent('a1');
		const view = screen.getByTestId('terminal-view');
		expect(view).toHaveAttribute('data-tabs', 't1');
		expect(view).toHaveAttribute('data-visible', 'false');
		expect(screen.getByTestId('tab-window-terminals')).toHaveStyle({ visibility: 'hidden' });
	});

	it('hands a terminal back only once its tab has left this strip', async () => {
		seedTerminalAgent();
		tabWindowsApi.getState.mockResolvedValue({
			...WINDOW_INFO,
			tabRefs: [
				{ type: 'terminal', id: 't1' },
				{ type: 'terminal', id: 't2' },
			],
			activeTabRef: { type: 'terminal', id: 't1' },
		});
		await renderRoot();
		const release = () =>
			(terminalViewProps.current!.releaseTabOnUnmount as (tabId: string) => boolean)('t2');
		expect(release()).toBe(false);

		tabWindowsApi.getState.mockResolvedValue({
			...WINDOW_INFO,
			tabRefs: [{ type: 'terminal', id: 't1' }],
			activeTabRef: { type: 'terminal', id: 't1' },
		});
		await act(async () => {
			broadcast?.({ type: 'tab-window-changed', windowId: 'tw-7', agentId: AGENT });
		});

		expect(screen.getByTestId('terminal-view')).toHaveAttribute('data-tabs', 't1');
		expect(release()).toBe(true);
	});

	it('renders a browser tab in its own webview host (D5)', async () => {
		useSessionStore.setState({
			sessions: [
				createMockSession({
					id: AGENT,
					name: 'Maestro Marketing',
					browserTabs: [{ id: 'b1', url: 'https://example.com', title: 'Example' }] as never,
				}),
			],
		});
		tabWindowsApi.getState.mockResolvedValue({
			...WINDOW_INFO,
			tabRefs: [{ type: 'browser', id: 'b1' }],
			activeTabRef: { type: 'browser', id: 'b1' },
		});
		await renderRoot();
		expect(screen.getByTestId('browser-tab-host')).toBeInTheDocument();
		expect(screen.queryByTestId('pane-notice')).not.toBeInTheDocument();
	});

	it('docks the active tab through tabWindows:dock', async () => {
		await renderRoot();
		fireEvent.click(screen.getByTestId('tab-window-dock'));
		expect(tabWindowsApi.dock).toHaveBeenCalledWith(AGENT, { type: 'ai', id: 'a2' });
	});

	it('shows a refused dock as a toast', async () => {
		tabWindowsApi.dock.mockResolvedValue({ docked: false, error: 'The agent has no tab window' });
		await renderRoot();
		await act(async () => {
			fireEvent.click(screen.getByTestId('tab-window-dock'));
		});
		expect(await screen.findByText('The agent has no tab window')).toBeInTheDocument();
	});

	it('shows a clicked chip through tabWindows:focus', async () => {
		await renderRoot();
		fireEvent.click(screen.getByText('notes'));
		expect(tabWindowsApi.focus).toHaveBeenCalledWith(AGENT, { type: 'file', id: 'f1' });
	});

	it('asks its owner for a snapshot once on load, so a reloaded window recovers (D2)', async () => {
		useSessionStore.setState({ sessions: [] });
		await renderRoot();
		expect(tabWindowsApi.sendIntent).toHaveBeenCalledTimes(1);
		expect(tabWindowsApi.sendIntent).toHaveBeenCalledWith({
			kind: 'requestSnapshot',
			agentId: AGENT,
			tabRef: { type: 'ai', id: 'a2' },
		});

		// A tab switch re-reads the record; it needs no snapshot.
		tabWindowsApi.getState.mockResolvedValue({
			...WINDOW_INFO,
			activeTabRef: { type: 'file', id: 'f1' },
		});
		await act(async () => {
			broadcast?.({ type: 'tab-window-changed', windowId: 'tw-7', agentId: AGENT });
		});
		expect(tabWindowsApi.sendIntent).toHaveBeenCalledTimes(1);
	});

	it('titles the OS window after the agent and follows a rename', async () => {
		await renderRoot();
		expect(document.title).toBe('Maestro Marketing - Tab Window');
		act(() => {
			useSessionStore.setState((state) => ({
				sessions: state.sessions.map((s) => ({ ...s, name: 'Maestro Docs' })),
			}));
		});
		await waitFor(() => expect(document.title).toBe('Maestro Docs - Tab Window'));
		expect(screen.getByTestId('tab-window-agent-name')).toHaveTextContent('Maestro Docs');
	});

	it('shows only the header until the agent state arrives', async () => {
		useSessionStore.setState({ sessions: [] });
		await renderRoot();
		expect(screen.getByTestId('tab-window-header')).toBeInTheDocument();
		expect(screen.queryByTestId('tab-window-dock')).not.toBeInTheDocument();
		expect(document.title).toBe('Tab Window');
	});
});

describe('TabWindowRoot tab switching (TW-6)', () => {
	/** This window holds a2, f1, a3 in that order; a2 shows. */
	const THREE_TABS: TabWindowInfo = {
		...WINDOW_INFO,
		tabRefs: [
			{ type: 'ai', id: 'a2' },
			{ type: 'file', id: 'f1' },
			{ type: 'ai', id: 'a3' },
		],
	};

	const press = (init: KeyboardEventInit) => {
		act(() => {
			fireEvent.keyDown(window, init);
		});
	};
	const nextTab = () => press({ key: '}', code: 'BracketRight', metaKey: true, shiftKey: true });
	const prevTab = () => press({ key: '{', code: 'BracketLeft', metaKey: true, shiftKey: true });
	/** Open a chip's hover menu the way a pointer does, and pick an item. */
	const chooseFromChipMenu = async (chipLabel: string, item: string | RegExp) => {
		fireEvent.mouseEnter(screen.getByText(chipLabel).closest('[data-tab-id]')!);
		fireEvent.click(await screen.findByText(item, undefined, { timeout: 2000 }));
	};

	beforeEach(() => {
		seedAgent();
		useSettingsStore.setState({ useCmd0AsLastTab: true });
		tabWindowsApi.getState.mockResolvedValue(THREE_TABS);
	});

	it("walks this window's strip with Cmd+Shift+] and Cmd+Shift+[, wrapping", async () => {
		await renderRoot();
		nextTab();
		expect(tabWindowsApi.focus).toHaveBeenLastCalledWith(AGENT, { type: 'file', id: 'f1' });
		await act(async () => {});
		prevTab();
		prevTab();
		// f1 -> a2 -> wraps to a3, never the owner's a1.
		expect(tabWindowsApi.focus).toHaveBeenLastCalledWith(AGENT, { type: 'ai', id: 'a3' });
	});

	it('shows a selection at once, so two quick presses move two tabs', async () => {
		// Main has not confirmed either press yet.
		tabWindowsApi.focus.mockReturnValue(new Promise(() => {}));
		await renderRoot();
		nextTab();
		expect(screen.getByTestId('file-pane')).toHaveTextContent('f1');
		nextTab();
		expect(tabWindowsApi.focus).toHaveBeenLastCalledWith(AGENT, { type: 'ai', id: 'a3' });
		expect(screen.getByTestId('ai-pane')).toHaveTextContent('a3');
	});

	it('goes back to the recorded tab when main refuses the selection', async () => {
		tabWindowsApi.focus.mockResolvedValue({ focused: false, error: 'The tab is gone' });
		await renderRoot();
		await act(async () => {
			nextTab();
		});
		expect(await screen.findByText('The tab is gone')).toBeInTheDocument();
		expect(screen.getByTestId('ai-pane')).toHaveTextContent('a2');
	});

	it('jumps by position in this strip with Cmd+1..9 and Cmd+0', async () => {
		await renderRoot();
		press({ key: '2', code: 'Digit2', metaKey: true });
		expect(tabWindowsApi.focus).toHaveBeenLastCalledWith(AGENT, { type: 'file', id: 'f1' });
		await act(async () => {});
		press({ key: '0', code: 'Digit0', metaKey: true });
		expect(tabWindowsApi.focus).toHaveBeenLastCalledWith(AGENT, { type: 'ai', id: 'a3' });
		tabWindowsApi.focus.mockClear();
		press({ key: '4', code: 'Digit4', metaKey: true });
		expect(tabWindowsApi.focus).not.toHaveBeenCalled();
	});

	it('closes the shown tab with Cmd+W through the close intent', async () => {
		await renderRoot();
		press({ key: 'w', code: 'KeyW', metaKey: true });
		expect(tabWindowsApi.sendIntent).toHaveBeenCalledWith({
			kind: 'closeTab',
			agentId: AGENT,
			tabRef: { type: 'ai', id: 'a2' },
		});
	});

	it('docks a tab from its chip menu, not only the shown one (TW-11)', async () => {
		await renderRoot();
		fireEvent.mouseEnter(screen.getByText('notes').closest('[data-tab-id]')!);
		fireEvent.click(
			await screen.findByTestId('tab-window-menu-item', undefined, { timeout: 2000 })
		);
		expect(tabWindowsApi.dock).toHaveBeenCalledWith(AGENT, { type: 'file', id: 'f1' });
	});

	it('docks the shown tab with the moveTabToTabWindow chord (Opt+Cmd+O)', async () => {
		await renderRoot();
		press({ key: 'ø', code: 'KeyO', metaKey: true, altKey: true });
		expect(tabWindowsApi.dock).toHaveBeenCalledWith(AGENT, { type: 'ai', id: 'a2' });
	});

	it('leaves agent cycling and the sidebar shortcuts inert', async () => {
		await renderRoot();
		// The load-time snapshot request is not a shortcut.
		tabWindowsApi.sendIntent.mockClear();
		press({ key: '[', code: 'BracketLeft', metaKey: true });
		press({ key: ']', code: 'BracketRight', metaKey: true });
		press({ key: 'b', code: 'KeyB', metaKey: true, altKey: true });
		press({ key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true, altKey: true });
		expect(tabWindowsApi.focus).not.toHaveBeenCalled();
		expect(tabWindowsApi.sendIntent).not.toHaveBeenCalled();
		expect(screen.getByTestId('ai-pane')).toHaveTextContent('a2');
	});

	it('sends Close Others for this strip only, never the owner tabs', async () => {
		await renderRoot();
		await chooseFromChipMenu('Popped Chat', 'Close Other Tabs');
		expect(tabWindowsApi.sendIntent).toHaveBeenCalledWith({
			kind: 'closeTabs',
			agentId: AGENT,
			tabRef: { type: 'ai', id: 'a2' },
			tabRefs: [
				{ type: 'file', id: 'f1' },
				{ type: 'ai', id: 'a3' },
			],
		});
	});

	it('sends Move to Last Position as this window order', async () => {
		await renderRoot();
		await chooseFromChipMenu('Popped Chat', 'Move to Last Position');
		expect(tabWindowsApi.sendIntent).toHaveBeenCalledWith({
			kind: 'reorderTabs',
			agentId: AGENT,
			tabRef: { type: 'ai', id: 'a2' },
			tabRefs: [
				{ type: 'file', id: 'f1' },
				{ type: 'ai', id: 'a3' },
				{ type: 'ai', id: 'a2' },
			],
		});
	});

	it('sends Mark as Unread and Star for the chip it was opened on', async () => {
		await renderRoot();
		await chooseFromChipMenu('Popped Chat', 'Mark as Unread');
		expect(tabWindowsApi.sendIntent).toHaveBeenCalledWith({
			kind: 'markUnread',
			agentId: AGENT,
			tabRef: { type: 'ai', id: 'a2' },
		});
		fireEvent.mouseLeave(screen.getByText('Popped Chat').closest('[data-tab-id]')!);
		await chooseFromChipMenu('Popped Chat', /^Star Session$/);
		expect(tabWindowsApi.sendIntent).toHaveBeenCalledWith({
			kind: 'starTab',
			agentId: AGENT,
			tabRef: { type: 'ai', id: 'a2' },
			starred: true,
		});
	});

	it('confirms a close that would lose the typed draft, and sends the close only once confirmed', async () => {
		await renderRoot();
		const composer = screen.getByTestId('tab-window-composer');
		fireEvent.change(within(composer).getByRole('textbox'), {
			target: { value: 'half-written' },
		});
		tabWindowsApi.sendIntent.mockClear();

		press({ key: 'w', code: 'KeyW', metaKey: true });
		expect(
			await screen.findByText('This tab has an unsent draft. Are you sure you want to close it?')
		).toBeInTheDocument();
		// The typed draft may go back to the owner meanwhile; the close may not.
		expect(tabWindowsApi.sendIntent).not.toHaveBeenCalledWith(
			expect.objectContaining({ kind: 'closeTab' })
		);

		fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
		expect(tabWindowsApi.sendIntent).toHaveBeenCalledWith({
			kind: 'closeTab',
			agentId: AGENT,
			tabRef: { type: 'ai', id: 'a2' },
		});
	});

	it('renames the chip through the rename intent, from the same dialog the owner uses', async () => {
		await renderRoot();
		await chooseFromChipMenu('Popped Chat', 'Rename Tab');
		const field = await screen.findByDisplayValue('Popped Chat');
		fireEvent.change(field, { target: { value: 'Release notes' } });
		fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

		expect(tabWindowsApi.sendIntent).toHaveBeenCalledWith({
			kind: 'renameTab',
			agentId: AGENT,
			tabRef: { type: 'ai', id: 'a2' },
			name: 'Release notes',
		});
		expect(screen.queryByDisplayValue('Release notes')).not.toBeInTheDocument();
	});

	it('snoozes the chip through the snooze intent with the chosen wake time', async () => {
		const before = Date.now();
		await renderRoot();
		await chooseFromChipMenu('Popped Chat', 'Snooze Tab');
		fireEvent.change(
			await screen.findByPlaceholderText('1d, 10h, 2 weeks, next month, aug 5, friday 3pm'),
			{ target: { value: '2h' } }
		);
		fireEvent.click(screen.getByRole('button', { name: 'Snooze' }));

		const snooze = tabWindowsApi.sendIntent.mock.calls
			.map(([intent]) => intent)
			.find((intent) => intent.kind === 'snoozeTab');
		expect(snooze).toMatchObject({ agentId: AGENT, tabRef: { type: 'ai', id: 'a2' } });
		// Two hours out, to the minute the parser rounds to.
		expect(snooze.wakeAt).toBeGreaterThan(before + 2 * 60 * 60 * 1000 - 60_000);
		expect(snooze.wakeAt).toBeLessThan(before + 2 * 60 * 60 * 1000 + 60_000);
	});
});

describe('TabWindowRoot composer sends intents to the owner (phase 5)', () => {
	const composer = () => screen.getByTestId('tab-window-composer');
	const draftBox = () => within(composer()).getByRole('textbox');
	const typeDraft = (text: string) => fireEvent.change(draftBox(), { target: { value: text } });
	// Cmd+Enter sends under either Enter-to-send setting.
	const submit = () => fireEvent.keyDown(draftBox(), { key: 'Enter', metaKey: true });

	beforeEach(() => {
		seedAgent();
		useCenterFlashStore.setState({ active: null });
		tabWindowsApi.getState.mockResolvedValue(WINDOW_INFO);
	});

	it('sends the draft as one send intent for the shown tab, and clears it here and in the owner', async () => {
		await renderRoot();
		tabWindowsApi.sendIntent.mockClear();
		typeDraft('Ship it');
		submit();

		expect(tabWindowsApi.sendIntent.mock.calls.map(([intent]) => intent.kind)).toEqual([
			'send',
			'setDraft',
		]);
		expect(tabWindowsApi.sendIntent).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'send',
				agentId: AGENT,
				tabRef: { type: 'ai', id: 'a2' },
				text: 'Ship it',
				images: [],
				commandMode: 'off',
			})
		);
		// The owner's copy of the draft must not keep the sent text.
		expect(tabWindowsApi.sendIntent).toHaveBeenLastCalledWith(
			expect.objectContaining({
				kind: 'setDraft',
				tabRef: { type: 'ai', id: 'a2' },
				inputValue: '',
			})
		);
		expect(draftBox()).toHaveValue('');
	});

	it('keeps the draft and sends nothing while the tab runs the planning wizard, and says why', async () => {
		updateAiTab(AGENT, 'a2', (tab) => ({
			...tab,
			wizardState: { isActive: true } as AITab['wizardState'],
		}));
		await renderRoot();
		tabWindowsApi.sendIntent.mockClear();
		typeDraft('Next step');
		submit();

		expect(tabWindowsApi.sendIntent).not.toHaveBeenCalled();
		expect(useCenterFlashStore.getState().active?.message).toBe(
			'The planning wizard runs in the main window. Dock this tab to continue it.'
		);
		expect(draftBox()).toHaveValue('Next step');
	});

	it('stops the turn of the shown tab through the interrupt intent', async () => {
		const startedAt = Date.now();
		updateSessionWith(AGENT, (session) => ({
			...session,
			state: 'busy',
			busySource: 'ai',
			thinkingStartTime: startedAt,
			aiTabs: session.aiTabs.map((tab) =>
				tab.id === 'a2' ? { ...tab, state: 'busy', thinkingStartTime: startedAt } : tab
			),
		}));
		await renderRoot();
		tabWindowsApi.sendIntent.mockClear();
		fireEvent.click(within(composer()).getByRole('button', { name: 'Stop' }));

		expect(tabWindowsApi.sendIntent).toHaveBeenCalledWith({
			kind: 'interrupt',
			agentId: AGENT,
			tabRef: { type: 'ai', id: 'a2' },
		});
	});
});
