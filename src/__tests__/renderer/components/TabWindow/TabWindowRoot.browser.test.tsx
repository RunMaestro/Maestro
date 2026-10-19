/**
 * Browser tabs in a tab window (Tab Windows, D5). A `<webview>` cannot move
 * between windows, so the tab window opens a new one at the tab's current URL
 * with the main panel's `BrowserTabView`, and the owner mounts none while the
 * tab is popped out. The page the tab window shows returns to the owner with
 * the `setBrowserTabState` intent, so a dock reopens the latest page there.
 *
 * `BrowserTabView` is a stand-in that records its props (jsdom has no guest
 * webview); a test drives it the way the webview's events do. The end-to-end
 * cases run both windows' real code in turn on one page: the owner's patch
 * stream seeds the tab window, and the owner's intent dispatcher applies what
 * the tab window sent.
 */
import { forwardRef, useImperativeHandle } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { TabWindowRoot } from '../../../../renderer/components/TabWindow/TabWindowRoot';
import { dispatchTabWindowIntent } from '../../../../renderer/services/tabWindowIntents';
import { useBrowserTabMounting } from '../../../../renderer/hooks/browser/useBrowserTabMounting';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useComposerInputStore } from '../../../../renderer/stores/composerInputStore';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { useTabWindowStore } from '../../../../renderer/stores/tabWindowStore';
import type { Session } from '../../../../renderer/types';
import type { BrowserTab } from '../../../../shared/browserPage';
import type {
	TabWindowInfo,
	TabWindowIntent,
	TabWindowIntentOf,
	TabWindowTabRef,
} from '../../../../shared/tabWindowTypes';
import { createMockAITab } from '../../../helpers/mockTab';
import { createMockSession } from '../../../helpers/mockSession';
import {
	clearTabWindowStore,
	createOwnerPatchStream,
	createTabWindowOwnerHandlers,
	installTabWindowsApi,
	popOutTabsInStore,
	type OwnerPatchStream,
} from '../../../helpers/tabWindows';

interface ViewProps {
	tab: BrowserTab;
	isActive?: boolean;
	onUpdateTab: (tabId: string, updates: Partial<BrowserTab>) => void;
}

const views: ViewProps[] = [];
const handle = { openFind: vi.fn(), goBack: vi.fn(), goForward: vi.fn() };
vi.mock('../../../../renderer/components/MainPanel/BrowserTabView', () => ({
	BrowserTabView: forwardRef<unknown, ViewProps>(function BrowserTabView(props, ref) {
		views.push(props);
		useImperativeHandle(ref, () => ({ ...handle, getTabId: () => props.tab.id }));
		return <div data-testid="browser-view">{props.tab.url}</div>;
	}),
}));

const AGENT = 'agent-1';
const DOCS: TabWindowTabRef = { type: 'browser', id: 'docs' };
const HOME: TabWindowTabRef = { type: 'ai', id: 'home' };

const INFO: TabWindowInfo = {
	windowId: 'tw-7',
	agentId: AGENT,
	tabRefs: [DOCS],
	activeTabRef: DOCS,
};

/** The agent as its owner holds it: a home AI tab and the popped `docs` browser tab. */
function ownerAgent(docs: Partial<BrowserTab> = {}): Session {
	return createMockSession({
		id: AGENT,
		name: 'Maestro Marketing',
		aiTabs: [createMockAITab({ id: 'home', name: 'Home Chat' })],
		activeTabId: 'home',
		browserTabs: [
			{
				id: 'docs',
				url: 'https://docs.test/start',
				title: 'Start',
				createdAt: 1,
				partition: `persist:maestro-browser-session-${AGENT}`,
				// What the owner's own webview last reported.
				canGoBack: true,
				canGoForward: false,
				isLoading: false,
				favicon: 'https://docs.test/favicon.ico',
				webContentsId: 41,
				...docs,
			},
		],
		unifiedTabOrder: [HOME, DOCS],
	});
}

let api: ReturnType<typeof installTabWindowsApi>;
let shortcutKey: ((input: Record<string, unknown>) => void) | null;

const view = () => views[views.length - 1];
const sentIntents = (): TabWindowIntent[] =>
	api.sendIntent.mock.calls.map(([intent]) => intent as TabWindowIntent);
const browserWrites = () =>
	sentIntents().filter(
		(intent): intent is TabWindowIntentOf<'setBrowserTabState'> =>
			intent.kind === 'setBrowserTabState'
	);
const heldTab = () => useSessionStore.getState().sessions[0].browserTabs?.[0];

function resetStores(): void {
	useSessionStore.setState({ sessions: [], activeSessionId: '' });
	useComposerInputStore.setState(useComposerInputStore.getInitialState(), true);
	useTabWindowStore.setState({ windows: [], poppedByAgent: {} });
}

/** Mount the tab window and play the owner's snapshot of `session` into it. */
async function openTabWindow(
	session: Session
): Promise<{ page: ReturnType<typeof render>; owner: OwnerPatchStream }> {
	const page = render(<TabWindowRoot windowId="tw-7" />);
	await act(async () => {});
	const owner = createOwnerPatchStream(api.emitPatch, AGENT, INFO.tabRefs);
	act(() => owner.snapshot(session));
	return { page, owner };
}

/** A navigation as the webview reports it: the page, then its runtime state. */
function navigate(url: string, title: string): void {
	act(() => view().onUpdateTab('docs', { url, title, isLoading: true, favicon: null }));
	act(() =>
		view().onUpdateTab('docs', {
			url,
			title,
			canGoBack: true,
			canGoForward: false,
			isLoading: false,
			webContentsId: 77,
		})
	);
}

/** The owner window: the page now holds the real agent and runs what the tab window sent. */
function runInOwner(page: ReturnType<typeof render>, session: Session): BrowserTab | undefined {
	page.unmount();
	resetStores();
	useSessionStore.setState({ sessions: [session], activeSessionId: AGENT });
	popOutTabsInStore(AGENT, [DOCS]);
	for (const intent of browserWrites()) {
		expect(dispatchTabWindowIntent(intent, createTabWindowOwnerHandlers())).toEqual({
			handled: true,
		});
	}
	return heldTab();
}

beforeEach(() => {
	views.length = 0;
	vi.clearAllMocks();
	resetStores();
	useSettingsStore.setState({ browserTabKeepAlive: 'off', browserTabKeepAliveLimit: 10 });
	api = installTabWindowsApi();
	api.getState.mockResolvedValue(INFO);
	shortcutKey = null;
	vi.mocked(window.maestro.app.onBrowserTabShortcutKey).mockImplementation((callback) => {
		shortcutKey = callback as typeof shortcutKey;
		return () => {
			shortcutKey = null;
		};
	});
});

afterEach(() => {
	api.restore();
	clearTabWindowStore();
});

describe('TabWindowRoot browser tabs (D5)', () => {
	it('opens a new webview at the tab URL, without the owner webview history or guest', async () => {
		await openTabWindow(ownerAgent({ remotePage: true }));

		expect(screen.getByTestId('browser-view')).toHaveTextContent('https://docs.test/start');
		expect(view().isActive).toBe(true);
		expect(view().tab).toMatchObject({
			url: 'https://docs.test/start',
			title: 'Start',
			partition: `persist:maestro-browser-session-${AGENT}`,
			canGoBack: false,
			canGoForward: false,
			webContentsId: undefined,
			// Always a native webview here, never the owner's streamed page.
			remotePage: undefined,
		});
		// The owner holds that page already, so nothing goes back.
		expect(browserWrites()).toEqual([]);
	});

	it('writes the URL and title back at once, and only what changed', async () => {
		await openTabWindow(ownerAgent());
		navigate('https://docs.test/guide', 'Guide');

		expect(browserWrites()).toEqual([
			{
				kind: 'setBrowserTabState',
				agentId: AGENT,
				tabRef: DOCS,
				fields: { url: 'https://docs.test/guide', title: 'Guide', favicon: null },
			},
		]);
		// The webview's runtime state is this window's own.
		expect(heldTab()).toMatchObject({ canGoBack: true, webContentsId: 77 });

		act(() => view().onUpdateTab('docs', { title: 'Guide - Docs' }));
		act(() => view().onUpdateTab('docs', { isLoading: false }));
		expect(browserWrites().map((write) => write.fields)).toEqual([
			{ url: 'https://docs.test/guide', title: 'Guide', favicon: null },
			{ title: 'Guide - Docs' },
		]);
	});

	it('keeps the page shown here when the owner patches the tab', async () => {
		const { owner } = await openTabWindow(ownerAgent());
		navigate('https://docs.test/guide', 'Guide');
		// The owner renames the tab; its copy still holds the first page.
		act(() => {
			owner.delta(ownerAgent({ customTitle: 'Reference' }));
		});

		expect(heldTab()).toMatchObject({
			url: 'https://docs.test/guide',
			title: 'Guide',
			customTitle: 'Reference',
		});
		expect(screen.getByTestId('browser-view')).toHaveTextContent('https://docs.test/guide');
	});

	it('writes the agent visibility toggle back', async () => {
		await openTabWindow(ownerAgent());
		act(() => view().onUpdateTab('docs', { hiddenFromAgent: true }));

		expect(browserWrites()).toEqual([
			expect.objectContaining({ tabRef: DOCS, fields: { hiddenFromAgent: true } }),
		]);
	});

	it('navigate then dock: the owner holds the latest page before the dock and reopens it', async () => {
		const { page } = await openTabWindow(ownerAgent());
		navigate('https://docs.test/guide', 'Guide');
		await act(async () => {
			fireEvent.click(screen.getByTestId('tab-window-dock'));
		});

		expect(api.dock).toHaveBeenCalledWith(AGENT, DOCS);
		// Main relays this window's messages in order: the page lands before the dock.
		const lastWrite = api.sendIntent.mock.invocationCallOrder.at(-1)!;
		expect(lastWrite).toBeLessThan(api.dock.mock.invocationCallOrder[0]);

		const owned = runInOwner(page, ownerAgent());
		// No guest state of the old webview survives: the owner's next one starts clean.
		expect(owned).toMatchObject({
			url: 'https://docs.test/guide',
			title: 'Guide',
			favicon: null,
			canGoBack: false,
			isLoading: false,
			webContentsId: undefined,
		});

		// While popped the owner mounts no webview for it; docked, it mounts one
		// again, and that one opens at `tab.url`.
		const session = useSessionStore.getState().sessions[0];
		const popped = { ...session, activeBrowserTabId: 'docs' };
		const mounted = renderHook(({ s }) => useBrowserTabMounting(s), {
			initialProps: { s: popped },
		});
		expect(mounted.result.current).toEqual([]);
		act(() => clearTabWindowStore());
		mounted.rerender({ s: popped });
		expect(mounted.result.current).toEqual(['docs']);
	});

	it('runs the tab shortcuts and the page keys pressed inside the page', async () => {
		await openTabWindow(ownerAgent());
		const key = (key: string) =>
			act(() =>
				shortcutKey?.({ key, code: '', meta: true, control: false, alt: false, shift: false })
			);

		key('f');
		expect(handle.openFind).toHaveBeenCalled();
		key('ArrowLeft');
		expect(handle.goBack).toHaveBeenCalled();
		key('ArrowRight');
		expect(handle.goForward).toHaveBeenCalled();

		// Cmd+W reaches this window's tab shortcuts: a close the owner runs.
		key('w');
		expect(sentIntents()).toContainEqual(
			expect.objectContaining({ kind: 'closeTab', agentId: AGENT, tabRef: DOCS })
		);
	});
});
