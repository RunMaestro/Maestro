import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
	BrowserTabView,
	type BrowserTabViewHandle,
} from '../../../../renderer/components/MainPanel/BrowserTabView';
import type { BrowserTab, Theme } from '../../../../renderer/types';
import {
	dismissCenterFlash,
	useCenterFlashStore,
} from '../../../../renderer/stores/centerFlashStore';
import { DEFAULT_BROWSER_TAB_URL } from '../../../../renderer/utils/browserTabPersistence';
import { normalizeBrowserTabUpdates } from '../../../../renderer/hooks/tabs/internal/browserTabHelpers';
import { isWebDesktop } from '../../../../renderer/utils/runtimeContext';
import { formatShortcutKeys } from '../../../../renderer/utils/shortcutFormatter';

import { mockTheme } from '../../../helpers/mockTheme';

// Default to desktop (Electron) behavior; individual tests flip this to true to
// exercise the web-desktop browser bundle branch.
vi.mock('../../../../renderer/utils/runtimeContext', () => ({
	isWebDesktop: vi.fn(() => false),
	isElectronDesktop: vi.fn(() => true),
}));

const mockTab: BrowserTab = {
	id: 'browser-1',
	url: 'https://example.com',
	title: 'Example',
	createdAt: Date.now(),
	partition: 'persist:maestro-browser-session-session-1',
	canGoBack: false,
	canGoForward: false,
	isLoading: false,
};

class MockResizeObserver {
	observe() {}
	disconnect() {}
}

type MockWebview = HTMLElement & {
	canGoBack: ReturnType<typeof vi.fn>;
	canGoForward: ReturnType<typeof vi.fn>;
	goBack?: ReturnType<typeof vi.fn>;
	goForward?: ReturnType<typeof vi.fn>;
	getURL: ReturnType<typeof vi.fn>;
	getTitle: ReturnType<typeof vi.fn>;
	isLoading: ReturnType<typeof vi.fn>;
	getWebContentsId: ReturnType<typeof vi.fn>;
	executeJavaScript: ReturnType<typeof vi.fn>;
	insertCSS?: ReturnType<typeof vi.fn>;
	findInPage?: ReturnType<typeof vi.fn>;
	stopFindInPage?: ReturnType<typeof vi.fn>;
	reload?: ReturnType<typeof vi.fn>;
};

type BrowserTabViewProps = React.ComponentProps<typeof BrowserTabView>;

/**
 * Holds the tab the way the session store does: an onUpdateTab call is merged
 * with the store's own normalizeBrowserTabUpdates and comes back as the `tab`
 * prop. Design Mode lives on the tab (`tab.designMode`), so a toggle only shows
 * through this round trip. `onUpdateTab` still sees every write.
 */
const StatefulBrowserTabView = React.forwardRef<
	BrowserTabViewHandle,
	Omit<BrowserTabViewProps, 'tab' | 'onUpdateTab' | 'ref'> & {
		initialTab: BrowserTab;
		onUpdateTab?: BrowserTabViewProps['onUpdateTab'];
	}
>(function StatefulBrowserTabView({ initialTab, onUpdateTab, ...rest }, ref) {
	const [tab, setTab] = React.useState(initialTab);
	const handleUpdateTab = React.useCallback(
		(tabId: string, updates: Partial<BrowserTab>) => {
			onUpdateTab?.(tabId, updates);
			setTab((current) => normalizeBrowserTabUpdates(current, updates));
		},
		[onUpdateTab]
	);
	return <BrowserTabView ref={ref} tab={tab} onUpdateTab={handleUpdateTab} {...rest} />;
});

describe('BrowserTabView', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(isWebDesktop).mockReturnValue(false);
		vi.stubGlobal('ResizeObserver', MockResizeObserver);
	});

	function getWebview(): MockWebview {
		return screen.getByTestId('browser-tab-host').querySelector('webview') as MockWebview;
	}

	it('waits for dom-ready before reading webview navigation state', async () => {
		const onUpdateTab = vi.fn();

		render(<BrowserTabView tab={mockTab} theme={mockTheme} onUpdateTab={onUpdateTab} />);

		const webview = getWebview();

		expect(webview).toBeTruthy();

		const getterError = new Error('dom-ready not emitted');
		webview.canGoBack = vi.fn(() => {
			throw getterError;
		});
		webview.canGoForward = vi.fn(() => {
			throw getterError;
		});
		webview.getURL = vi.fn(() => {
			throw getterError;
		});
		webview.getTitle = vi.fn(() => {
			throw getterError;
		});
		webview.isLoading = vi.fn(() => {
			throw getterError;
		});
		webview.getWebContentsId = vi.fn(() => 77);
		webview.executeJavaScript = vi.fn().mockResolvedValue(undefined);

		await waitFor(() => {
			expect(onUpdateTab).not.toHaveBeenCalled();
		});

		webview.canGoBack = vi.fn(() => true);
		webview.canGoForward = vi.fn(() => false);
		webview.getURL = vi.fn(() => 'https://example.com/docs');
		webview.getTitle = vi.fn(() => 'Example Docs');
		webview.isLoading = vi.fn(() => false);

		await act(async () => {
			webview.dispatchEvent(new Event('dom-ready'));
		});

		await waitFor(() => {
			expect(onUpdateTab).toHaveBeenCalledWith(
				'browser-1',
				expect.objectContaining({
					url: 'https://example.com/docs',
					title: 'Example Docs',
					canGoBack: true,
					canGoForward: false,
					isLoading: false,
					webContentsId: 77,
				})
			);
		});
	});

	it('updates loading, url, and favicon state across redirects', async () => {
		const onUpdateTab = vi.fn();

		render(<BrowserTabView tab={mockTab} theme={mockTheme} onUpdateTab={onUpdateTab} />);

		const webview = getWebview();
		webview.canGoBack = vi.fn(() => false);
		webview.canGoForward = vi.fn(() => false);
		webview.getURL = vi.fn(() => 'https://redirected.example.com/docs');
		webview.getTitle = vi.fn(() => 'Redirected Docs');
		webview.isLoading = vi.fn(() => false);
		webview.getWebContentsId = vi.fn(() => 91);
		webview.executeJavaScript = vi.fn().mockResolvedValue(undefined);

		await act(async () => {
			webview.dispatchEvent(new Event('dom-ready'));
		});

		onUpdateTab.mockClear();

		await act(async () => {
			webview.dispatchEvent(
				Object.assign(new Event('did-start-navigation'), {
					url: 'https://example.com/start',
					isMainFrame: true,
				})
			);
			webview.dispatchEvent(
				Object.assign(new Event('did-redirect-navigation'), {
					url: 'https://redirected.example.com/docs',
					isMainFrame: true,
				})
			);
			webview.dispatchEvent(
				Object.assign(new Event('page-favicon-updated'), {
					favicons: ['https://redirected.example.com/favicon.ico'],
				})
			);
			webview.dispatchEvent(new Event('did-stop-loading'));
		});

		await waitFor(() => {
			// While a navigation is in flight the URL and loading flag update, but the
			// last known page title is intentionally preserved (mockTab.title === 'Example')
			// rather than clobbered with the bare URL host. Without this, a cold reload of a
			// grouped browser pane would blank the tab label until page-title-updated re-fires.
			expect(onUpdateTab).toHaveBeenCalledWith(
				'browser-1',
				expect.objectContaining({
					url: 'https://example.com/start',
					title: 'Example',
					isLoading: true,
					favicon: null,
				})
			);
			expect(onUpdateTab).toHaveBeenCalledWith(
				'browser-1',
				expect.objectContaining({
					url: 'https://redirected.example.com/docs',
					title: 'Example',
					isLoading: true,
					favicon: null,
				})
			);
			expect(onUpdateTab).toHaveBeenCalledWith('browser-1', {
				favicon: 'https://redirected.example.com/favicon.ico',
			});
			expect(onUpdateTab).toHaveBeenCalledWith(
				'browser-1',
				expect.objectContaining({
					url: 'https://redirected.example.com/docs',
					title: 'Redirected Docs',
					canGoBack: false,
					canGoForward: false,
					isLoading: false,
					webContentsId: 91,
				})
			);
		});
	});

	it('clears loading state after failed navigations', async () => {
		const onUpdateTab = vi.fn();

		render(<BrowserTabView tab={mockTab} theme={mockTheme} onUpdateTab={onUpdateTab} />);

		const webview = getWebview();
		webview.canGoBack = vi.fn(() => true);
		webview.canGoForward = vi.fn(() => false);
		webview.getURL = vi.fn(() => 'https://failed.example.com/');
		webview.getTitle = vi.fn(() => '');
		webview.isLoading = vi.fn(() => false);
		webview.getWebContentsId = vi.fn(() => 103);
		webview.executeJavaScript = vi.fn().mockResolvedValue(undefined);

		await act(async () => {
			webview.dispatchEvent(new Event('dom-ready'));
		});

		onUpdateTab.mockClear();

		await act(async () => {
			webview.dispatchEvent(
				Object.assign(new Event('did-fail-load'), {
					validatedURL: 'https://failed.example.com/',
					isMainFrame: true,
				})
			);
		});

		await waitFor(() => {
			expect(onUpdateTab).toHaveBeenCalledWith(
				'browser-1',
				expect.objectContaining({
					url: 'https://failed.example.com/',
					title: 'failed.example.com',
					canGoBack: true,
					canGoForward: false,
					isLoading: false,
					webContentsId: 103,
				})
			);
		});
	});

	it('keeps webview listeners attached across navigation re-renders so loading clears', async () => {
		// Regression: the listener effect previously depended on tab.url/tab.title
		// and the inline onUpdateTab, so each navigation event re-rendered the
		// parent and tore down/re-registered all listeners mid-flight, resetting
		// isDomReadyRef. did-stop-loading then bailed out of readWebviewState and
		// the spinner stayed spinning while the title oscillated.
		let latestTab: BrowserTab = { ...mockTab, isLoading: false };
		const Wrapper = () => {
			const [tab, setTab] = React.useState<BrowserTab>(latestTab);
			latestTab = tab;
			// Fresh inline callback every render - mirrors MainPanelContent.
			return (
				<BrowserTabView
					tab={tab}
					theme={mockTheme}
					onUpdateTab={(_, updates) => setTab((prev) => ({ ...prev, ...updates }))}
				/>
			);
		};

		render(<Wrapper />);
		const webview = getWebview();
		webview.canGoBack = vi.fn(() => true);
		webview.canGoForward = vi.fn(() => false);
		webview.getURL = vi.fn(() => 'https://example.com/page-b');
		webview.getTitle = vi.fn(() => 'Page B');
		webview.isLoading = vi.fn(() => false);
		webview.getWebContentsId = vi.fn(() => 55);
		webview.executeJavaScript = vi.fn().mockResolvedValue(undefined);

		await act(async () => {
			webview.dispatchEvent(new Event('dom-ready'));
		});

		// Simulate clicking Back: navigation starts (isLoading true; url/title change
		// triggers a re-render with new props + a new inline onUpdateTab)...
		webview.getURL = vi.fn(() => 'https://example.com/page-a');
		webview.getTitle = vi.fn(() => 'Page A');
		await act(async () => {
			webview.dispatchEvent(
				Object.assign(new Event('did-start-navigation'), {
					url: 'https://example.com/page-a',
					isMainFrame: true,
				})
			);
		});
		expect(latestTab.isLoading).toBe(true);

		// ...then finishes. did-stop-loading must still clear isLoading even though
		// the parent re-rendered (and dom-ready does not fire again).
		await act(async () => {
			webview.dispatchEvent(new Event('did-stop-loading'));
		});

		await waitFor(() => {
			expect(latestTab.isLoading).toBe(false);
			expect(latestTab.url).toBe('https://example.com/page-a');
			expect(latestTab.title).toBe('Page A');
		});
	});

	it('selects the full committed URL on focus', () => {
		const onUpdateTab = vi.fn();
		const selectSpy = vi.spyOn(HTMLInputElement.prototype, 'select');

		render(<BrowserTabView tab={mockTab} theme={mockTheme} onUpdateTab={onUpdateTab} />);

		fireEvent.focus(screen.getByLabelText('Browser URL'));

		expect(selectSpy).toHaveBeenCalled();
		selectSpy.mockRestore();
	});

	it('normalizes localhost input on submit', () => {
		const onUpdateTab = vi.fn();

		render(
			<BrowserTabView
				tab={{ ...mockTab, url: DEFAULT_BROWSER_TAB_URL, title: 'New Tab' }}
				theme={mockTheme}
				onUpdateTab={onUpdateTab}
			/>
		);

		const input = screen.getByLabelText('Browser URL');
		fireEvent.change(input, { target: { value: 'localhost:5173/docs' } });
		fireEvent.submit(input.closest('form')!);

		expect(onUpdateTab).toHaveBeenCalledWith(
			'browser-1',
			expect.objectContaining({
				url: 'http://localhost:5173/docs',
				title: 'localhost:5173',
				isLoading: true,
			})
		);
	});

	it('normalizes search-like text into a search URL on submit', () => {
		const onUpdateTab = vi.fn();

		render(<BrowserTabView tab={mockTab} theme={mockTheme} onUpdateTab={onUpdateTab} />);

		const input = screen.getByLabelText('Browser URL');
		fireEvent.change(input, { target: { value: 'maestro browser tabs' } });
		fireEvent.submit(input.closest('form')!);

		expect(onUpdateTab).toHaveBeenCalledWith(
			'browser-1',
			expect.objectContaining({
				url: 'https://www.google.com/search?q=maestro%20browser%20tabs',
				title: 'www.google.com',
				isLoading: true,
			})
		);
	});

	it('shows an inline error for blocked protocols without mutating tab state', async () => {
		const onUpdateTab = vi.fn();

		render(<BrowserTabView tab={mockTab} theme={mockTheme} onUpdateTab={onUpdateTab} />);

		const input = screen.getByLabelText('Browser URL');
		fireEvent.change(input, { target: { value: 'data:text/plain,hello' } });
		fireEvent.submit(input.closest('form')!);

		expect(onUpdateTab).not.toHaveBeenCalled();
		expect(await screen.findByRole('alert')).toHaveTextContent(
			'Protocol not allowed in browser tabs: data:'
		);
		expect(input).toHaveValue('data:text/plain,hello');
	});

	it('ignores guest popup events instead of opening an external browser', async () => {
		const onUpdateTab = vi.fn();

		render(<BrowserTabView tab={mockTab} theme={mockTheme} onUpdateTab={onUpdateTab} />);

		const webview = getWebview();
		const preventDefault = vi.fn();

		await act(async () => {
			webview.dispatchEvent(
				Object.assign(new Event('new-window'), {
					url: 'https://popup.example.com/',
					preventDefault,
				})
			);
		});

		expect(window.maestro.shell.openExternal).not.toHaveBeenCalled();
		expect(preventDefault).not.toHaveBeenCalled();
		expect(onUpdateTab).not.toHaveBeenCalled();
	});

	describe('address bar scroll auto-hide', () => {
		function setupWebview(onUpdateTab: ReturnType<typeof vi.fn>) {
			render(<BrowserTabView tab={mockTab} theme={mockTheme} onUpdateTab={onUpdateTab} />);
			const webview = getWebview();
			webview.canGoBack = vi.fn(() => false);
			webview.canGoForward = vi.fn(() => false);
			webview.getURL = vi.fn(() => 'https://example.com');
			webview.getTitle = vi.fn(() => 'Example');
			webview.isLoading = vi.fn(() => false);
			webview.getWebContentsId = vi.fn(() => 99);
			webview.executeJavaScript = vi.fn().mockResolvedValue(undefined);
			return webview;
		}

		it('injects scroll listener on dom-ready', async () => {
			const onUpdateTab = vi.fn();
			const webview = setupWebview(onUpdateTab);

			await act(async () => {
				webview.dispatchEvent(new Event('dom-ready'));
			});

			expect(webview.executeJavaScript).toHaveBeenCalledWith(
				expect.stringContaining('__maestroScrollListenerInstalled')
			);
		});

		it('hides address bar on scroll-down console message', async () => {
			const onUpdateTab = vi.fn();
			const webview = setupWebview(onUpdateTab);

			await act(async () => {
				webview.dispatchEvent(new Event('dom-ready'));
			});

			const addressBar = screen.getByLabelText('Browser URL').closest('[class*="overflow-hidden"]');
			expect(addressBar).toBeTruthy();

			// Simulate scroll-down message from guest
			await act(async () => {
				webview.dispatchEvent(
					Object.assign(new Event('console-message'), { message: '__MAESTRO_SCROLL__1' })
				);
			});

			expect(addressBar).toHaveStyle({ maxHeight: '0' });
		});

		it('reveals address bar on scroll-up console message', async () => {
			const onUpdateTab = vi.fn();
			const webview = setupWebview(onUpdateTab);

			await act(async () => {
				webview.dispatchEvent(new Event('dom-ready'));
			});

			const addressBar = screen.getByLabelText('Browser URL').closest('[class*="overflow-hidden"]');

			// Hide first
			await act(async () => {
				webview.dispatchEvent(
					Object.assign(new Event('console-message'), { message: '__MAESTRO_SCROLL__1' })
				);
			});
			expect(addressBar).toHaveStyle({ maxHeight: '0' });

			// Scroll up - reveal
			await act(async () => {
				webview.dispatchEvent(
					Object.assign(new Event('console-message'), { message: '__MAESTRO_SCROLL__0' })
				);
			});
			expect(addressBar).toHaveStyle({ maxHeight: '200px' });
		});

		it('reveals address bar when address input is focused', async () => {
			const onUpdateTab = vi.fn();
			const webview = setupWebview(onUpdateTab);

			await act(async () => {
				webview.dispatchEvent(new Event('dom-ready'));
			});

			const addressBar = screen.getByLabelText('Browser URL').closest('[class*="overflow-hidden"]');

			// Hide via scroll
			await act(async () => {
				webview.dispatchEvent(
					Object.assign(new Event('console-message'), { message: '__MAESTRO_SCROLL__1' })
				);
			});
			expect(addressBar).toHaveStyle({ maxHeight: '0' });

			// Focus address input - should reveal
			fireEvent.focus(screen.getByLabelText('Browser URL'));
			expect(addressBar).toHaveStyle({ maxHeight: '200px' });
		});
	});

	// The injected guest listener is the half of the auto-hide that runs inside
	// the page, so run the real injected source here rather than only asserting
	// on the console messages the component reacts to. The script is evaluated
	// against a stand-in window per test - installing it on the real jsdom window
	// would stack one listener per test, since it registers anonymous handlers
	// that cannot be removed.
	describe('injected guest scroll listener', () => {
		let script = '';

		function installListener() {
			const listeners: Record<string, Array<() => void>> = {};
			const guestWindow: Record<string, unknown> = {
				scrollY: 0,
				innerHeight: 800,
				addEventListener(type: string, handler: () => void) {
					(listeners[type] ??= []).push(handler);
				},
			};
			const logs: string[] = [];
			const guestConsole = { log: (message: unknown) => logs.push(String(message)) };
			const runFrame = (cb: FrameRequestCallback) => {
				cb(0);
				return 0;
			};
			new Function('window', 'console', 'requestAnimationFrame', script)(
				guestWindow,
				guestConsole,
				runFrame
			);
			return {
				logs,
				scrollTo(y: number, innerHeight?: number) {
					if (innerHeight !== undefined && innerHeight !== guestWindow.innerHeight) {
						guestWindow.innerHeight = innerHeight;
						guestWindow.scrollY = y;
						(listeners.resize ?? []).forEach((cb) => cb());
					}
					guestWindow.scrollY = y;
					(listeners.scroll ?? []).forEach((cb) => cb());
				},
			};
		}

		beforeEach(async () => {
			const onUpdateTab = vi.fn();
			render(<BrowserTabView tab={mockTab} theme={mockTheme} onUpdateTab={onUpdateTab} />);
			const webview = getWebview();
			webview.canGoBack = vi.fn(() => false);
			webview.canGoForward = vi.fn(() => false);
			webview.getURL = vi.fn(() => 'https://example.com');
			webview.getTitle = vi.fn(() => 'Example');
			webview.isLoading = vi.fn(() => false);
			webview.getWebContentsId = vi.fn(() => 99);
			webview.executeJavaScript = vi.fn().mockResolvedValue(undefined);

			await act(async () => {
				webview.dispatchEvent(new Event('dom-ready'));
			});

			script = webview.executeJavaScript.mock.calls
				.map((call) => String(call[0]))
				.find((src) => src.includes('__maestroScrollListenerInstalled')) as string;
			expect(script).toBeTruthy();
		});

		afterEach(() => {
			vi.restoreAllMocks();
		});

		it('collapses the address bar on a user scroll down', () => {
			const guest = installListener();

			guest.scrollTo(400);

			expect(guest.logs).toEqual(['__MAESTRO_SCROLL__1']);
		});

		it('ignores the clamp scroll caused by its own collapse at page bottom', () => {
			const guest = installListener();

			// User scrolls to the bottom: the bar collapses.
			guest.scrollTo(400);
			expect(guest.logs).toEqual(['__MAESTRO_SCROLL__1']);

			// Collapsing grows the viewport, so Chromium clamps scrollY down. That
			// looks like a scroll up and used to re-reveal the bar, which shrank the
			// viewport again and flickered for as long as the page sat at the bottom.
			guest.scrollTo(356, 844);

			expect(guest.logs).toEqual(['__MAESTRO_SCROLL__1']);
		});

		it('still reveals on a genuine scroll up once the resize has settled', () => {
			const guest = installListener();

			guest.scrollTo(400);
			guest.scrollTo(356, 844);
			expect(guest.logs).toEqual(['__MAESTRO_SCROLL__1']);

			// Past the settle window, a real scroll up reveals the bar again.
			vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000);
			guest.scrollTo(100);

			expect(guest.logs).toEqual(['__MAESTRO_SCROLL__1', '__MAESTRO_SCROLL__0']);
		});
	});

	it('keeps typed input separate from navigation updates until submitted', async () => {
		const onUpdateTab = vi.fn();

		render(<BrowserTabView tab={mockTab} theme={mockTheme} onUpdateTab={onUpdateTab} />);

		const webview = getWebview();
		webview.canGoBack = vi.fn(() => false);
		webview.canGoForward = vi.fn(() => false);
		webview.getURL = vi.fn(() => 'https://example.com');
		webview.getTitle = vi.fn(() => 'Example');
		webview.isLoading = vi.fn(() => false);
		webview.getWebContentsId = vi.fn(() => 88);
		webview.executeJavaScript = vi.fn().mockResolvedValue(undefined);

		await act(async () => {
			webview.dispatchEvent(new Event('dom-ready'));
		});

		const input = screen.getByLabelText('Browser URL');
		fireEvent.focus(input);
		fireEvent.change(input, { target: { value: 'docs.runmaestro.ai' } });

		await act(async () => {
			webview.dispatchEvent(
				Object.assign(new Event('did-navigate'), {
					url: 'https://example.com/redirected',
				})
			);
		});

		expect(input).toHaveValue('docs.runmaestro.ai');

		fireEvent.submit(input.closest('form')!);

		expect(onUpdateTab).toHaveBeenCalledWith(
			'browser-1',
			expect.objectContaining({
				url: 'https://docs.runmaestro.ai/',
				title: 'docs.runmaestro.ai',
				isLoading: true,
			})
		);
	});

	describe('imperative handle: getContent', () => {
		it('returns document.body.innerText via webview.executeJavaScript after dom-ready', async () => {
			const ref = React.createRef<BrowserTabViewHandle>();
			render(<BrowserTabView ref={ref} tab={mockTab} theme={mockTheme} onUpdateTab={vi.fn()} />);

			const webview = getWebview();
			webview.canGoBack = vi.fn(() => false);
			webview.canGoForward = vi.fn(() => false);
			webview.getURL = vi.fn(() => mockTab.url);
			webview.getTitle = vi.fn(() => mockTab.title ?? '');
			webview.isLoading = vi.fn(() => false);
			webview.getWebContentsId = vi.fn(() => 1);
			webview.executeJavaScript = vi.fn().mockResolvedValue('hello world');

			await act(async () => {
				webview.dispatchEvent(new Event('dom-ready'));
			});

			const content = await ref.current!.getContent();
			expect(webview.executeJavaScript).toHaveBeenCalledWith(
				'(document.body && document.body.innerText) || ""'
			);
			expect(content).toBe('hello world');
		});

		it('returns the empty string when executeJavaScript rejects', async () => {
			const ref = React.createRef<BrowserTabViewHandle>();
			render(<BrowserTabView ref={ref} tab={mockTab} theme={mockTheme} onUpdateTab={vi.fn()} />);

			const webview = getWebview();
			webview.canGoBack = vi.fn(() => false);
			webview.canGoForward = vi.fn(() => false);
			webview.getURL = vi.fn(() => mockTab.url);
			webview.getTitle = vi.fn(() => mockTab.title ?? '');
			webview.isLoading = vi.fn(() => false);
			webview.getWebContentsId = vi.fn(() => 1);
			webview.executeJavaScript = vi.fn().mockRejectedValue(new Error('cross-origin'));

			await act(async () => {
				webview.dispatchEvent(new Event('dom-ready'));
			});

			const content = await ref.current!.getContent();
			expect(content).toBe('');
		});

		it('exposes the current tab id via getTabId', async () => {
			const ref = React.createRef<BrowserTabViewHandle>();
			render(<BrowserTabView ref={ref} tab={mockTab} theme={mockTheme} onUpdateTab={vi.fn()} />);

			expect(ref.current!.getTabId()).toBe('browser-1');
		});
	});

	describe('imperative handle: read waits for the page to finish loading', () => {
		it('does not sample the DOM until isLoading() flips false, then resolves with the page text', async () => {
			vi.useFakeTimers();
			try {
				const ref = React.createRef<BrowserTabViewHandle>();
				render(<BrowserTabView ref={ref} tab={mockTab} theme={mockTheme} onUpdateTab={vi.fn()} />);

				const webview = getWebview();
				// The guest reports it is still loading; the read must wait it out.
				let loading = true;
				webview.canGoBack = vi.fn(() => false);
				webview.canGoForward = vi.fn(() => false);
				webview.getURL = vi.fn(() => mockTab.url);
				webview.getTitle = vi.fn(() => mockTab.title ?? '');
				webview.isLoading = vi.fn(() => loading);
				webview.getWebContentsId = vi.fn(() => 1);
				webview.executeJavaScript = vi.fn().mockResolvedValue('PAGE-TEXT-SENTINEL');
				// The exact expression the extractor injects for 'text' format. The
				// component ALSO calls executeJavaScript on dom-ready to install a
				// scroll listener, so match this specific probe rather than call count.
				const EXTRACT_TEXT_EXPR = '(document.body && document.body.innerText) || ""';

				// dom-ready sets isDomReadyRef so the ONLY remaining gate is isLoading.
				await act(async () => {
					webview.dispatchEvent(new Event('dom-ready'));
				});

				// Kick off the read; capture its resolution without awaiting so we can
				// assert it stays pending while the page is still loading.
				let resolved: string | undefined;
				const read = ref.current!.extract('text').then((v) => {
					resolved = v;
				});

				// Advance past the 150ms lead delay and several 50ms not-loading polls
				// while isLoading() is still true. The DOM sample (executeJavaScript)
				// must NOT fire and the read must NOT resolve.
				await act(async () => {
					await vi.advanceTimersByTimeAsync(300);
				});
				expect(webview.isLoading).toHaveBeenCalled();
				expect(webview.executeJavaScript).not.toHaveBeenCalledWith(EXTRACT_TEXT_EXPR);
				expect(resolved).toBeUndefined();

				// The guest finishes loading.
				loading = false;

				// Advance through the remaining poll, the 300ms post-load settle, and
				// the second not-loading check. Now the extraction runs and resolves.
				await act(async () => {
					await vi.advanceTimersByTimeAsync(500);
				});
				await read;
				expect(webview.executeJavaScript).toHaveBeenCalledWith(EXTRACT_TEXT_EXPR);
				expect(resolved).toBe('PAGE-TEXT-SENTINEL');
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe('find in page (Cmd+F)', () => {
		it('mounts the find bar, runs findInPage on query, and stops on Escape', async () => {
			const ref = React.createRef<BrowserTabViewHandle>();
			render(<BrowserTabView ref={ref} tab={mockTab} theme={mockTheme} onUpdateTab={vi.fn()} />);

			const webview = getWebview();
			const findInPage = vi.fn().mockReturnValue(42);
			const stopFindInPage = vi.fn();
			webview.findInPage = findInPage;
			webview.stopFindInPage = stopFindInPage;

			// Bar is hidden by default
			expect(screen.queryByTestId('browser-tab-find-bar')).toBeNull();

			act(() => {
				ref.current!.openFind();
			});

			const bar = await screen.findByTestId('browser-tab-find-bar');
			expect(bar).toBeTruthy();
			const input = bar.querySelector('input') as HTMLInputElement;
			expect(input).toBeTruthy();
			// Cmd+F must focus the input so the user can start typing immediately.
			// The host's focus-stealing-prevention guard must explicitly leave this
			// input alone; without the carve-out it would re-blur on the next tick.
			await waitFor(() => expect(document.activeElement).toBe(input));

			// Typing kicks off findInPage
			await act(async () => {
				fireEvent.change(input, { target: { value: 'hello' } });
			});
			expect(findInPage).toHaveBeenCalledWith('hello');

			// found-in-page result wires up the counter
			await act(async () => {
				const event = new Event('found-in-page') as Event & {
					result?: { requestId: number; activeMatchOrdinal: number; matches: number };
				};
				event.result = { requestId: 42, activeMatchOrdinal: 2, matches: 7 };
				webview.dispatchEvent(event);
			});
			expect(bar.textContent).toContain('2/7');

			// Enter advances to next match
			findInPage.mockClear();
			await act(async () => {
				fireEvent.keyDown(input, { key: 'Enter' });
			});
			expect(findInPage).toHaveBeenCalledWith('hello', { forward: true, findNext: true });

			// Shift+Enter goes back
			findInPage.mockClear();
			await act(async () => {
				fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
			});
			expect(findInPage).toHaveBeenCalledWith('hello', { forward: false, findNext: true });

			// Escape closes and stops the find
			stopFindInPage.mockClear();
			await act(async () => {
				fireEvent.keyDown(input, { key: 'Escape' });
			});
			expect(screen.queryByTestId('browser-tab-find-bar')).toBeNull();
			expect(stopFindInPage).toHaveBeenCalledWith('clearSelection');
		});

		it('goBack and goForward delegate to webview, respecting canGoBack/canGoForward', async () => {
			const ref = React.createRef<BrowserTabViewHandle>();
			render(<BrowserTabView ref={ref} tab={mockTab} theme={mockTheme} onUpdateTab={vi.fn()} />);

			const webview = getWebview();
			const goBack = vi.fn();
			const goForward = vi.fn();
			webview.goBack = goBack;
			webview.goForward = goForward;
			webview.canGoBack = vi.fn(() => false);
			webview.canGoForward = vi.fn(() => false);

			// No-op when history is empty
			act(() => ref.current!.goBack());
			act(() => ref.current!.goForward());
			expect(goBack).not.toHaveBeenCalled();
			expect(goForward).not.toHaveBeenCalled();

			webview.canGoBack = vi.fn(() => true);
			webview.canGoForward = vi.fn(() => true);

			act(() => ref.current!.goBack());
			act(() => ref.current!.goForward());
			expect(goBack).toHaveBeenCalledTimes(1);
			expect(goForward).toHaveBeenCalledTimes(1);
		});

		it('Escape in the address bar restores URL and focuses the webview', async () => {
			render(<BrowserTabView tab={mockTab} theme={mockTheme} onUpdateTab={vi.fn()} />);

			const input = document.getElementById(
				`browser-tab-address-${mockTab.id}`
			) as HTMLInputElement;
			expect(input).toBeTruthy();

			const webview = getWebview();
			const webviewFocus = vi.spyOn(webview, 'focus');

			// Edit the URL, then press Escape
			await act(async () => {
				fireEvent.focus(input);
				fireEvent.change(input, { target: { value: 'edited.com' } });
			});
			expect(input.value).toBe('edited.com');

			await act(async () => {
				fireEvent.keyDown(input, { key: 'Escape' });
			});

			// Reverted to the tab's actual URL, input lost focus, webview gained focus
			expect(input.value).toBe(mockTab.url);
			expect(document.activeElement).not.toBe(input);
			expect(webviewFocus).toHaveBeenCalled();
		});

		it('ignores stale found-in-page results from a prior query', async () => {
			const ref = React.createRef<BrowserTabViewHandle>();
			render(<BrowserTabView ref={ref} tab={mockTab} theme={mockTheme} onUpdateTab={vi.fn()} />);

			const webview = getWebview();
			let nextRequestId = 100;
			webview.findInPage = vi.fn(() => ++nextRequestId);
			webview.stopFindInPage = vi.fn();

			act(() => {
				ref.current!.openFind();
			});
			const bar = await screen.findByTestId('browser-tab-find-bar');
			const input = bar.querySelector('input') as HTMLInputElement;

			// Query 1 (requestId 101)
			await act(async () => {
				fireEvent.change(input, { target: { value: 'first' } });
			});
			// Query 2 (requestId 102)
			await act(async () => {
				fireEvent.change(input, { target: { value: 'second' } });
			});

			// Stale result for query 1 arrives AFTER query 2 fired
			await act(async () => {
				const stale = new Event('found-in-page') as Event & { result?: object };
				stale.result = { requestId: 101, activeMatchOrdinal: 5, matches: 5 };
				webview.dispatchEvent(stale);
			});
			expect(bar.textContent).not.toContain('5/5');

			// Fresh result for query 2 updates the counter
			await act(async () => {
				const fresh = new Event('found-in-page') as Event & { result?: object };
				fresh.result = { requestId: 102, activeMatchOrdinal: 1, matches: 3 };
				webview.dispatchEvent(fresh);
			});
			expect(bar.textContent).toContain('1/3');
		});
	});

	describe('clear browsing data + incognito badge', () => {
		interface BrowserSessionApi {
			clearSessionData: (partition: string) => Promise<{ ok: boolean; error?: string }>;
		}
		// The global window.maestro test mock does not carry browserSession; these
		// tests install/remove it per-case through a mutable view.
		const maestroMutable = window.maestro as unknown as { browserSession?: BrowserSessionApi };

		afterEach(() => {
			delete maestroMutable.browserSession;
		});

		it('shows the incognito badge only for ephemeral tabs', () => {
			const { rerender } = render(
				<BrowserTabView
					tab={{ ...mockTab, ephemeral: true }}
					theme={mockTheme}
					onUpdateTab={vi.fn()}
				/>
			);
			expect(screen.getByTestId('browser-tab-incognito-badge')).toBeInTheDocument();
			rerender(<BrowserTabView tab={mockTab} theme={mockTheme} onUpdateTab={vi.fn()} />);
			expect(screen.queryByTestId('browser-tab-incognito-badge')).toBeNull();
		});

		it('clears browsing data only on the armed second click, then reloads', async () => {
			const clearSessionData = vi.fn(async () => ({ ok: true }));
			maestroMutable.browserSession = { clearSessionData };
			render(<BrowserTabView tab={mockTab} theme={mockTheme} onUpdateTab={vi.fn()} />);
			const webview = getWebview();
			const reload = vi.fn();
			webview.reload = reload;

			const button = screen.getByTestId('browser-tab-clear-session-data');
			// First click only arms: nothing destructive may happen yet.
			fireEvent.click(button);
			expect(clearSessionData).not.toHaveBeenCalled();
			expect(button).toHaveAttribute('aria-pressed', 'true');

			// Second click clears THIS tab's partition and reloads on success.
			fireEvent.click(button);
			await waitFor(() => {
				expect(clearSessionData).toHaveBeenCalledWith('persist:maestro-browser-session-session-1');
			});
			await waitFor(() => expect(reload).toHaveBeenCalled());
			expect(button).toHaveAttribute('aria-pressed', 'false');
		});

		it('disarms after 4s so a late second click re-arms instead of clearing', () => {
			vi.useFakeTimers();
			try {
				const clearSessionData = vi.fn(async () => ({ ok: true }));
				maestroMutable.browserSession = { clearSessionData };
				render(<BrowserTabView tab={mockTab} theme={mockTheme} onUpdateTab={vi.fn()} />);
				const button = screen.getByTestId('browser-tab-clear-session-data');

				fireEvent.click(button);
				expect(button).toHaveAttribute('aria-pressed', 'true');
				act(() => {
					vi.advanceTimersByTime(4001);
				});
				expect(button).toHaveAttribute('aria-pressed', 'false');

				// The stale confirm click must arm again, not clear.
				fireEvent.click(button);
				expect(clearSessionData).not.toHaveBeenCalled();
				expect(button).toHaveAttribute('aria-pressed', 'true');
			} finally {
				vi.useRealTimers();
			}
		});

		it('surfaces a clear failure inline and does not reload', async () => {
			const clearSessionData = vi.fn(async () => ({ ok: false, error: 'nope' }));
			maestroMutable.browserSession = { clearSessionData };
			render(<BrowserTabView tab={mockTab} theme={mockTheme} onUpdateTab={vi.fn()} />);
			const webview = getWebview();
			const reload = vi.fn();
			webview.reload = reload;

			const button = screen.getByTestId('browser-tab-clear-session-data');
			fireEvent.click(button);
			fireEvent.click(button);

			const alert = await screen.findByRole('alert');
			expect(alert.textContent).toContain('Could not clear browsing data');
			expect(alert.textContent).toContain('nope');
			expect(reload).not.toHaveBeenCalled();
		});

		it('degrades to an inline error when the preload lacks browserSession', async () => {
			render(<BrowserTabView tab={mockTab} theme={mockTheme} onUpdateTab={vi.fn()} />);
			const button = screen.getByTestId('browser-tab-clear-session-data');
			fireEvent.click(button);
			fireEvent.click(button);

			const alert = await screen.findByRole('alert');
			expect(alert.textContent).toMatch(/not supported by this build/);
		});

		it('disarms the clear-session confirm when switched to a different tab.id', () => {
			const clearSessionData = vi.fn(async () => ({ ok: true }));
			maestroMutable.browserSession = { clearSessionData };
			const tabB: BrowserTab = {
				...mockTab,
				id: 'browser-2',
				partition: 'persist:maestro-browser-session-session-2',
			};
			const { rerender } = render(
				<BrowserTabView tab={mockTab} theme={mockTheme} onUpdateTab={vi.fn()} />
			);

			// Arm the two-step confirm on tab A.
			const armed = screen.getByTestId('browser-tab-clear-session-data');
			fireEvent.click(armed);
			expect(armed).toHaveAttribute('aria-pressed', 'true');

			// The component instance is reused across tab switches, so switching the
			// tab.id must disarm - otherwise a single stale click would wipe tab B's
			// data with no guard.
			rerender(<BrowserTabView tab={tabB} theme={mockTheme} onUpdateTab={vi.fn()} />);
			const afterSwitch = screen.getByTestId('browser-tab-clear-session-data');
			expect(afterSwitch).toHaveAttribute('aria-pressed', 'false');

			// The first click after the switch only re-arms; it must NOT clear (and
			// certainly not clear tab B's partition off a carried-over arm).
			fireEvent.click(afterSwitch);
			expect(clearSessionData).not.toHaveBeenCalled();
			expect(afterSwitch).toHaveAttribute('aria-pressed', 'true');
		});
	});

	describe('web-desktop placeholder', () => {
		it('renders a link-out placeholder instead of the inert webview', () => {
			vi.mocked(isWebDesktop).mockReturnValue(true);

			render(<BrowserTabView tab={mockTab} theme={mockTheme} onUpdateTab={vi.fn()} />);

			// The Electron <webview> is inert in a real browser and must not render.
			expect(screen.getByTestId('browser-tab-host').querySelector('webview')).toBeNull();

			const placeholder = screen.getByTestId('browser-tab-web-placeholder');
			expect(placeholder).toHaveTextContent('Browser tabs are available in the desktop app');

			const link = screen.getByRole('link', { name: 'https://example.com' });
			expect(link).toHaveAttribute('href', 'https://example.com');
			expect(link).toHaveAttribute('target', '_blank');
			expect(link).toHaveAttribute('rel', 'noopener noreferrer');
		});

		it('does not render an anchor for a non-http (e.g. javascript:) URL', () => {
			vi.mocked(isWebDesktop).mockReturnValue(true);

			render(
				<BrowserTabView
					// eslint-disable-next-line no-script-url
					tab={{ ...mockTab, url: 'javascript:alert(1)' }}
					theme={mockTheme}
					onUpdateTab={vi.fn()}
				/>
			);

			// The placeholder still renders, but the dangerous scheme must not become
			// a clickable href (XSS-on-click guard).
			expect(screen.getByTestId('browser-tab-web-placeholder')).toBeInTheDocument();
			expect(screen.queryByRole('link')).toBeNull();
		});

		it('omits the clickable link for a blank browser tab', () => {
			vi.mocked(isWebDesktop).mockReturnValue(true);

			render(
				<BrowserTabView
					tab={{ ...mockTab, url: DEFAULT_BROWSER_TAB_URL }}
					theme={mockTheme}
					onUpdateTab={vi.fn()}
				/>
			);

			expect(screen.getByTestId('browser-tab-web-placeholder')).toBeInTheDocument();
			expect(screen.queryByRole('link')).toBeNull();
		});

		it('still renders the webview on desktop (non-web)', () => {
			// isWebDesktop defaults to false via beforeEach.
			render(<BrowserTabView tab={mockTab} theme={mockTheme} onUpdateTab={vi.fn()} />);

			expect(screen.getByTestId('browser-tab-host').querySelector('webview')).toBeTruthy();
			expect(screen.queryByTestId('browser-tab-web-placeholder')).toBeNull();
		});
	});

	describe('imperative handle: capturePage (covered capture)', () => {
		// The stub frame the guest's capturePage resolves to. Its length must clear
		// the >=64-char "real frame" gate the component uses to decide a retry.
		interface CapturedImage {
			toDataURL: () => string;
		}

		// jsdom renders <webview> as an unknown element with no capturePage; the
		// component invokes webview.capturePage(), so each test attaches a stub.
		interface CaptureWebview extends HTMLElement {
			capturePage: () => Promise<CapturedImage>;
		}

		const FULL_DATA_URL = `data:image/png;base64,${'A'.repeat(80)}`;

		function getHost(): HTMLElement {
			return screen.getByTestId('browser-tab-host');
		}

		function getCaptureWebview(host: HTMLElement): CaptureWebview {
			// Well-known-element downcast of the raw jsdom node (augmented with the
			// Electron capturePage the component calls), not an inline read-through.
			return host.querySelector('webview') as CaptureWebview;
		}

		// The cover is the opaque <div> the component appends with the max int32
		// z-index; finding it proves the overlay was installed, not just any child.
		function findCover(host: HTMLElement): HTMLDivElement | null {
			for (const child of Array.from(host.children)) {
				if (child instanceof HTMLDivElement && child.style.zIndex === '2147483647') {
					return child;
				}
			}
			return null;
		}

		it('flips a hidden tab visible behind an opaque cover for the capture, then restores', async () => {
			vi.useFakeTimers();
			try {
				const ref = React.createRef<BrowserTabViewHandle>();
				render(<BrowserTabView ref={ref} tab={mockTab} theme={mockTheme} onUpdateTab={vi.fn()} />);

				const host = getHost();
				// Kept-alive-but-hidden mount: host is visibility:hidden, the exact
				// state that makes Electron capturePage throw unless the tab is forced
				// to paint. Confirm the precondition the covered-capture path keys on.
				host.style.visibility = 'hidden';
				expect(getComputedStyle(host).visibility).toBe('hidden');

				let visibilityAtCapture: string | undefined;
				let coverPresentAtCapture = false;
				const wv = getCaptureWebview(host);
				const capturePage = vi.fn(async (): Promise<CapturedImage> => {
					// Record the observable DOM state at the instant the frame is taken.
					visibilityAtCapture = host.style.visibility;
					coverPresentAtCapture = findCover(host) !== null;
					return { toDataURL: () => FULL_DATA_URL };
				});
				wv.capturePage = capturePage;

				const pending = ref.current!.capturePage();
				// Drain the 180ms compositor-settle delay before the capture fires.
				await act(async () => {
					await vi.advanceTimersByTimeAsync(180);
				});
				const dataUrl = await pending;

				// Core contract: at capture time the guest was painting (visible) AND
				// screened by the opaque cover so the user never saw the flash.
				expect(capturePage).toHaveBeenCalledTimes(1);
				expect(visibilityAtCapture).toBe('visible');
				expect(coverPresentAtCapture).toBe(true);
				expect(dataUrl).toBe(FULL_DATA_URL);
				expect(dataUrl.length).toBeGreaterThanOrEqual(64);

				// Cleanup contract: the cover is gone and the host is hidden again.
				expect(findCover(host)).toBeNull();
				expect(host.style.visibility).toBe('hidden');
			} finally {
				vi.useRealTimers();
			}
		});

		it('captures a visible tab directly without a cover or a forced visibility flip', async () => {
			const ref = React.createRef<BrowserTabViewHandle>();
			render(<BrowserTabView ref={ref} tab={mockTab} theme={mockTheme} onUpdateTab={vi.fn()} />);

			const host = getHost();
			// Default host is visible: no cover, no flip, no settle delay.
			expect(getComputedStyle(host).visibility).not.toBe('hidden');

			let visibilityAtCapture: string | undefined;
			let coverPresentAtCapture = false;
			const wv = getCaptureWebview(host);
			const capturePage = vi.fn(async (): Promise<CapturedImage> => {
				visibilityAtCapture = host.style.visibility;
				coverPresentAtCapture = findCover(host) !== null;
				return { toDataURL: () => FULL_DATA_URL };
			});
			wv.capturePage = capturePage;

			const dataUrl = await ref.current!.capturePage();

			expect(capturePage).toHaveBeenCalledTimes(1);
			// No cover was ever appended and the inline visibility was never forced.
			expect(coverPresentAtCapture).toBe(false);
			expect(visibilityAtCapture).toBe('');
			expect(findCover(host)).toBeNull();
			expect(host.style.visibility).toBe('');
			expect(dataUrl).toBe(FULL_DATA_URL);
		});

		it('retries the capture once when the first hidden-tab frame comes back empty', async () => {
			vi.useFakeTimers();
			try {
				const ref = React.createRef<BrowserTabViewHandle>();
				render(<BrowserTabView ref={ref} tab={mockTab} theme={mockTheme} onUpdateTab={vi.fn()} />);

				const host = getHost();
				host.style.visibility = 'hidden';

				const wv = getCaptureWebview(host);
				// First frame is too short (compositor not ready yet); the retry after
				// the extra settle delay returns the real one.
				const capturePage = vi.fn(async (): Promise<CapturedImage> => {
					const attempt = capturePage.mock.calls.length;
					return { toDataURL: () => (attempt === 1 ? 'data:,' : FULL_DATA_URL) };
				});
				wv.capturePage = capturePage;

				const pending = ref.current!.capturePage();
				await act(async () => {
					await vi.advanceTimersByTimeAsync(180); // first attempt
					await vi.advanceTimersByTimeAsync(160); // retry after the short frame
				});
				const dataUrl = await pending;

				expect(capturePage).toHaveBeenCalledTimes(2);
				expect(dataUrl).toBe(FULL_DATA_URL);
			} finally {
				vi.useRealTimers();
			}
		});

		it('removes the cover and restores visibility even when the capture throws', async () => {
			vi.useFakeTimers();
			try {
				const ref = React.createRef<BrowserTabViewHandle>();
				render(<BrowserTabView ref={ref} tab={mockTab} theme={mockTheme} onUpdateTab={vi.fn()} />);

				const host = getHost();
				host.style.visibility = 'hidden';

				const wv = getCaptureWebview(host);
				const captureError = new Error('UnknownVizError');
				const capturePage = vi.fn(async (): Promise<CapturedImage> => {
					throw captureError;
				});
				wv.capturePage = capturePage;

				const pending = ref.current!.capturePage();
				// Attach the rejection handler synchronously so the throw is observed,
				// not reported as an unhandled rejection.
				const settled = pending.then(
					() => ({ ok: true as const }),
					(err: unknown) => ({ ok: false as const, err })
				);
				await act(async () => {
					await vi.advanceTimersByTimeAsync(180);
				});
				const outcome = await settled;

				// The failure propagates to the caller...
				expect(outcome.ok).toBe(false);
				expect(capturePage).toHaveBeenCalledTimes(1);
				// ...and the finally still tore down the cover and restored the host.
				expect(findCover(host)).toBeNull();
				expect(host.style.visibility).toBe('hidden');
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe('themed background', () => {
		function setupBlankWebview(url: string) {
			const rendered = render(
				<BrowserTabView
					tab={{ ...mockTab, url, title: 'New Tab' }}
					theme={mockTheme}
					onUpdateTab={vi.fn()}
				/>
			);
			const webview = getWebview();
			webview.canGoBack = vi.fn(() => false);
			webview.canGoForward = vi.fn(() => false);
			webview.getURL = vi.fn(() => url);
			webview.getTitle = vi.fn(() => '');
			webview.isLoading = vi.fn(() => false);
			webview.getWebContentsId = vi.fn(() => 42);
			webview.executeJavaScript = vi.fn().mockResolvedValue(undefined);
			webview.insertCSS = vi.fn().mockResolvedValue('key');
			return { webview, rendered };
		}

		it('paints the host and the webview element in the theme background', () => {
			render(<BrowserTabView tab={mockTab} theme={mockTheme} onUpdateTab={vi.fn()} />);

			const host = screen.getByTestId('browser-tab-host');
			expect(host.style.backgroundColor).toBe('rgb(40, 42, 54)');
			expect((getWebview() as HTMLElement).style.backgroundColor).toBe('rgb(40, 42, 54)');
		});

		it('recolors a blank guest document on dom-ready', async () => {
			const { webview } = setupBlankWebview(DEFAULT_BROWSER_TAB_URL);

			await act(async () => {
				webview.dispatchEvent(new Event('dom-ready'));
			});

			expect(webview.insertCSS).toHaveBeenCalledWith(
				expect.stringContaining(mockTheme.colors.bgMain)
			);
		});

		it('leaves a real page background alone', async () => {
			const { webview } = setupBlankWebview('https://example.com');

			await act(async () => {
				webview.dispatchEvent(new Event('dom-ready'));
			});

			expect(webview.insertCSS).not.toHaveBeenCalled();
		});

		it('re-applies the blank background when the theme changes', async () => {
			const { webview, rendered } = setupBlankWebview(DEFAULT_BROWSER_TAB_URL);

			await act(async () => {
				webview.dispatchEvent(new Event('dom-ready'));
			});
			(webview.insertCSS as ReturnType<typeof vi.fn>).mockClear();

			const nextTheme: Theme = {
				...mockTheme,
				colors: { ...mockTheme.colors, bgMain: '#101014' },
			};
			await act(async () => {
				rendered.rerender(
					<BrowserTabView
						tab={{ ...mockTab, url: DEFAULT_BROWSER_TAB_URL, title: 'New Tab' }}
						theme={nextTheme}
						onUpdateTab={vi.fn()}
					/>
				);
			});

			expect(webview.insertCSS).toHaveBeenCalledWith(expect.stringContaining('#101014'));
		});
	});

	describe('webview src', () => {
		it('mounts the tab URL as-is when it is parseable', () => {
			render(
				<BrowserTabView
					tab={{ ...mockTab, url: 'https://example.com/docs' }}
					theme={mockTheme}
					onUpdateTab={vi.fn()}
				/>
			);

			expect(getWebview().getAttribute('src')).toBe('https://example.com/docs');
		});

		// A failed navigation writes `did-fail-load`'s validatedURL straight into
		// tab.url, and for ERR_INVALID_URL that is the malformed target itself.
		// Electron resolves the src attribute with `new URL()` while attaching the
		// element, so handing it that value throws "Invalid URL" mid-commit and
		// takes the renderer down (MAESTRO-QX/QY/QZ).
		it.each(['http://', 'https://[bad', 'https://x y'])(
			'falls back to about:blank rather than mounting the unparseable URL %s',
			(url) => {
				expect(() =>
					render(
						<BrowserTabView tab={{ ...mockTab, url }} theme={mockTheme} onUpdateTab={vi.fn()} />
					)
				).not.toThrow();

				expect(getWebview().getAttribute('src')).toBe(DEFAULT_BROWSER_TAB_URL);
			}
		);
	});

	describe('Design Mode', () => {
		const SHOT = `data:image/png;base64,${'A'.repeat(100)}`;
		const pickPayload = {
			url: 'https://example.com',
			tagName: 'button',
			selector: 'button.primary',
			html: '<button class="primary">Save</button>',
			htmlTruncated: false,
			styles: { display: 'inline-flex' },
			rect: { x: 10, y: 20, width: 100, height: 40 },
			viewport: { width: 800, height: 600 },
		};

		/** The request a guest-helper call carries, or null for other scripts. */
		function guestRequest(code: string): Record<string, unknown> | null {
			const match = /\)\((\{[^]*\})\)$/.exec(code);
			if (!match || !code.includes('MAX_HTML')) return null;
			return JSON.parse(match[1]);
		}

		function guestCalls(webview: MockWebview, type: string) {
			return webview.executeJavaScript.mock.calls
				.map(([code]) => guestRequest(String(code)))
				.filter((req) => req?.type === type);
		}

		async function setupReady(
			onDesignPick?: ReturnType<typeof vi.fn>,
			props: {
				isActive?: boolean;
				tab?: BrowserTab;
				onDesignQueue?: ReturnType<typeof vi.fn>;
			} = {}
		) {
			const ref = React.createRef<BrowserTabViewHandle>();
			const onUpdateTab = vi.fn();
			const element = (isActive: boolean | undefined) => (
				<StatefulBrowserTabView
					ref={ref}
					initialTab={props.tab ?? mockTab}
					theme={mockTheme}
					onUpdateTab={onUpdateTab}
					onDesignPick={onDesignPick}
					onDesignQueue={props.onDesignQueue}
					isActive={isActive}
				/>
			);
			const view = render(element(props.isActive));
			/** Hide or show the tab the way MainPanelContent does: through isActive. */
			const setActive = (isActive: boolean) => view.rerender(element(isActive));
			const webview = getWebview() as MockWebview & {
				getZoomFactor: ReturnType<typeof vi.fn>;
				capturePage: ReturnType<typeof vi.fn>;
			};
			webview.canGoBack = vi.fn(() => false);
			webview.canGoForward = vi.fn(() => false);
			// The harness keeps what the webview reports, so report the tab's own
			// page (a blank tab must stay blank after dom-ready).
			webview.getURL = vi.fn(() => (props.tab ?? mockTab).url);
			webview.getTitle = vi.fn(() => 'Example');
			webview.isLoading = vi.fn(() => false);
			webview.getWebContentsId = vi.fn(() => 99);
			webview.getZoomFactor = vi.fn(() => 1.5);
			webview.capturePage = vi.fn().mockResolvedValue({ toDataURL: () => SHOT });
			webview.executeJavaScript = vi.fn(async (code: string) => {
				const req = guestRequest(code);
				if (!req) return undefined;
				if (req.type === 'probe') {
					return {
						rect: pickPayload.rect,
						label: 'button.primary',
						depth: req.depth,
						viewport: pickPayload.viewport,
					};
				}
				if (req.type === 'describe' || req.type === 'describeSelector') return pickPayload;
				return true;
			});
			await act(async () => {
				webview.dispatchEvent(new Event('dom-ready'));
			});
			return { webview, ref, view, onUpdateTab, setActive };
		}

		async function arm() {
			await act(async () => {
				fireEvent.click(screen.getByTestId('browser-tab-design-mode-toggle'));
			});
			return screen.getByTestId('browser-tab-design-mode-layer');
		}

		/** The Design Mode flag writes that reached onUpdateTab, in order. */
		function designModeWrites(onUpdateTab: ReturnType<typeof vi.fn>) {
			return onUpdateTab.mock.calls
				.map(([, updates]) => (updates as Partial<BrowserTab>).designMode)
				.filter((value) => value !== undefined);
		}

		/** The guest finished loading a document, as Electron reports it. */
		async function finishLoad(webview: MockWebview) {
			await act(async () => {
				webview.dispatchEvent(new Event('did-finish-load'));
			});
		}

		it('offers no toggle when nobody receives picks', async () => {
			await setupReady();
			expect(screen.queryByTestId('browser-tab-design-mode-toggle')).toBeNull();
		});

		it('is unavailable on the blank tab', async () => {
			await setupReady(vi.fn(), { tab: { ...mockTab, url: DEFAULT_BROWSER_TAB_URL } });
			expect(
				(screen.getByTestId('browser-tab-design-mode-toggle') as HTMLButtonElement).disabled
			).toBe(true);
		});

		it('covers the page with a focused layer and outlines what the guest reports', async () => {
			// The overlay is 1600 x 1000 here and the guest viewport 800 x 600: the
			// overlay draws 2 px per guest CSS px, whatever the zoom factor says.
			const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1600);
			const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(1000);
			try {
				const { webview } = await setupReady(vi.fn());
				const layer = await arm();
				expect(document.activeElement).toBe(layer);
				expect(screen.getByTestId('browser-tab-design-mode-banner')).toBeTruthy();

				await act(async () => {
					fireEvent.mouseMove(layer, { clientX: 30, clientY: 60 });
				});
				// Points go out in overlay pixels with the overlay's size; the guest
				// scales them by its own viewport (never by the zoom factor).
				await waitFor(() =>
					expect(guestCalls(webview, 'probe')).toContainEqual({
						type: 'probe',
						x: 30,
						y: 60,
						depth: 0,
						frame: { width: 1600, height: 1000 },
					})
				);
				const outline = await screen.findByTestId('browser-tab-design-mode-outline');
				// The guest box (x 10, width 100 CSS px) at 2 overlay px per CSS px,
				// drawn 2 px outside it. The zoom factor (1.5) plays no part.
				expect(outline.style.left).toBe('18px');
				expect(outline.style.width).toBe('204px');
				expect(screen.getByText('button.primary')).toBeTruthy();
				expect(screen.getByText(/100 x 40/)).toBeTruthy();
			} finally {
				width.mockRestore();
				height.mockRestore();
			}
		});

		it('ArrowUp asks the guest for the parent', async () => {
			const { webview } = await setupReady(vi.fn());
			const layer = await arm();
			await act(async () => {
				fireEvent.keyDown(layer, { key: 'ArrowUp' });
			});
			await waitFor(() =>
				expect(guestCalls(webview, 'probe').some((req) => req?.depth === 1)).toBe(true)
			);
		});

		it('a slow reply for an older probe cannot undo an ArrowUp pressed meanwhile', async () => {
			const { webview } = await setupReady(vi.fn());
			// Hold the first probe's reply until we release it.
			let release: (value: unknown) => void = () => {};
			const answered: Array<Record<string, unknown>> = [];
			webview.executeJavaScript = vi.fn((code: string) => {
				const req = guestRequest(code);
				if (!req) return Promise.resolve(undefined);
				answered.push(req);
				const reply = {
					rect: pickPayload.rect,
					label: req.depth === 0 ? 'button.primary' : 'section.parent',
					depth: req.depth,
				};
				if (answered.length === 1) {
					return new Promise((resolve) => {
						release = () => resolve(reply);
					});
				}
				return Promise.resolve(reply);
			});
			const layer = await arm();
			// arm() fired the center probe (depth 0), still pending.
			await act(async () => {
				fireEvent.keyDown(layer, { key: 'ArrowUp' });
			});
			await act(async () => {
				release(undefined);
			});
			await waitFor(() => expect(answered.some((req) => req.depth === 1)).toBe(true));
			expect(await screen.findByText('section.parent')).toBeTruthy();
			expect(screen.queryByText('button.primary')).toBeNull();
		});

		it('Enter on a focused control runs that control, not a pick or a delivery', async () => {
			const onDesignPick = vi.fn().mockResolvedValue(true);
			const onDesignQueue = vi.fn().mockResolvedValue({ tabName: 'Fix header' });
			const { webview } = await setupReady(onDesignPick, { onDesignQueue });
			await arm();
			// The banner's ESC pill: Enter must not pick.
			fireEvent.keyDown(screen.getByTestId('browser-tab-design-mode-cancel'), { key: 'Enter' });
			expect(guestCalls(webview, 'describe')).toHaveLength(0);

			await act(async () => {
				fireEvent.keyDown(screen.getByTestId('browser-tab-design-mode-layer'), { key: 'Enter' });
			});
			await screen.findByTestId('browser-tab-design-mode-card');
			// Card buttons: Enter belongs to the button, never Add to Message.
			for (const id of [
				'browser-tab-design-mode-card-close',
				'browser-tab-design-mode-queue',
				'browser-tab-design-mode-add-another',
			]) {
				await act(async () => {
					fireEvent.keyDown(screen.getByTestId(id), { key: 'Enter' });
				});
			}
			expect(onDesignPick).not.toHaveBeenCalled();
			expect(onDesignQueue).not.toHaveBeenCalled();
			expect(screen.getByTestId('browser-tab-design-mode-card')).toBeTruthy();
		});

		it('a click picks at the click point, crops the guest frame, and opens the card', async () => {
			const onDesignPick = vi.fn().mockResolvedValue(true);
			const { webview, onUpdateTab } = await setupReady(onDesignPick);
			const layer = await arm();

			await act(async () => {
				fireEvent.click(layer, { clientX: 300, clientY: 150, button: 0 });
			});
			await screen.findByTestId('browser-tab-design-mode-card');
			expect(guestCalls(webview, 'describe')).toContainEqual({
				type: 'describe',
				x: 300,
				y: 150,
				depth: 0,
				// jsdom does no layout, so the overlay measures 0 x 0 and the guest
				// falls back to a 1:1 scale.
				frame: { width: 0, height: 0 },
			});
			// Guest DIPs: the CSS box times the 1.5 zoom, not window coordinates.
			expect(webview.capturePage).toHaveBeenCalledWith({ x: 15, y: 30, width: 150, height: 60 });
			expect(onDesignPick).not.toHaveBeenCalled();

			const note = screen.getByTestId('browser-tab-design-mode-note');
			expect(document.activeElement).toBe(note);
			fireEvent.change(note, { target: { value: 'Make it blue' } });
			await act(async () => {
				fireEvent.keyDown(note, { key: 'Enter' });
			});

			expect(onDesignPick).toHaveBeenCalledWith(
				expect.objectContaining({
					pick: expect.objectContaining({ selector: 'button.primary' }),
					screenshot: SHOT,
					note: 'Make it blue',
					reveal: true,
				})
			);
			// Add to Message reveals the chat but does not leave Design Mode: the
			// card closes and the flag stays on (only Escape and the toggle clear
			// it). Here nothing hides the tab, so the picker is still up.
			await waitFor(() => expect(screen.queryByTestId('browser-tab-design-mode-card')).toBeNull());
			expect(screen.getByTestId('browser-tab-design-mode-layer')).toBeTruthy();
			expect(designModeWrites(onUpdateTab)).toEqual([true]);
		});

		it('after Add to Message hides the tab, the picker is back when the tab is shown again', async () => {
			const onDesignPick = vi.fn().mockResolvedValue(true);
			const { setActive } = await setupReady(onDesignPick);
			const layer = await arm();
			await act(async () => {
				fireEvent.keyDown(layer, { key: 'Enter' });
			});
			const note = await screen.findByTestId('browser-tab-design-mode-note');
			await act(async () => {
				fireEvent.keyDown(note, { key: 'Enter' });
			});
			expect(onDesignPick).toHaveBeenCalledWith(expect.objectContaining({ reveal: true }));

			// The reveal switched to the chat (MainPanelContent: isActive false).
			await act(async () => setActive(false));
			expect(screen.queryByTestId('browser-tab-design-mode-layer')).toBeNull();
			await act(async () => setActive(true));

			const rearmed = screen.getByTestId('browser-tab-design-mode-layer');
			expect(document.activeElement).toBe(rearmed);
			expect(screen.queryByTestId('browser-tab-design-mode-card')).toBeNull();
		});

		it('Cmd+Enter adds the pick and keeps picking', async () => {
			const onDesignPick = vi.fn().mockResolvedValue(true);
			await setupReady(onDesignPick);
			const layer = await arm();
			await act(async () => {
				fireEvent.keyDown(layer, { key: 'Enter' });
			});
			const note = await screen.findByTestId('browser-tab-design-mode-note');
			await act(async () => {
				fireEvent.keyDown(note, { key: 'Enter', metaKey: true });
			});
			expect(onDesignPick).toHaveBeenCalledWith(expect.objectContaining({ reveal: false }));
			await waitFor(() => expect(screen.queryByTestId('browser-tab-design-mode-card')).toBeNull());
			expect(screen.getByTestId('browser-tab-design-mode-layer')).toBeTruthy();
		});

		describe('Queue', () => {
			const QUEUED_TO = { tabName: 'Fix header' };
			type QueuedTo = typeof QUEUED_TO | null;

			afterEach(() => {
				dismissCenterFlash();
			});

			/** Arm Design Mode, pick the element under the center, and wait for its card. */
			async function openCard(options: {
				onDesignQueue?: ReturnType<typeof vi.fn>;
				onDesignPick?: ReturnType<typeof vi.fn>;
			}) {
				const onDesignPick = options.onDesignPick ?? vi.fn().mockResolvedValue(true);
				await setupReady(onDesignPick, { onDesignQueue: options.onDesignQueue });
				const layer = await arm();
				await act(async () => {
					fireEvent.keyDown(layer, { key: 'Enter' });
				});
				const note = await screen.findByTestId('browser-tab-design-mode-note');
				return { note, onDesignPick };
			}

			function queueButton() {
				return screen.getByTestId('browser-tab-design-mode-queue') as HTMLButtonElement;
			}

			/** A queue call the test settles by hand, to hold the hand-off in flight. */
			function pendingQueue() {
				let finish: (value: QueuedTo) => void = () => {};
				const onDesignQueue = vi.fn(
					() =>
						new Promise<QueuedTo>((resolve) => {
							finish = resolve;
						})
				);
				return { onDesignQueue, finish: (value: QueuedTo) => finish(value) };
			}

			it('puts a Queue button left of Add and Pick Another and names its shortcut', async () => {
				await openCard({ onDesignQueue: vi.fn() });
				const addAnother = screen.getByTestId('browser-tab-design-mode-add-another');

				expect(queueButton().textContent).toBe('Queue');
				expect(
					queueButton().compareDocumentPosition(addAnother) & Node.DOCUMENT_POSITION_FOLLOWING
				).toBeTruthy();
				expect(queueButton().title).toContain(formatShortcutKeys(['Alt', 'Enter']));
			});

			it('offers no Queue where the host cannot queue, and Alt+Enter then does nothing', async () => {
				const { note, onDesignPick } = await openCard({});

				expect(screen.queryByTestId('browser-tab-design-mode-queue')).toBeNull();
				await act(async () => {
					fireEvent.keyDown(note, { key: 'Enter', altKey: true });
				});

				// The chord is reserved for Queue: it must not fall through to Add.
				expect(onDesignPick).not.toHaveBeenCalled();
				expect(screen.getByTestId('browser-tab-design-mode-card')).toBeTruthy();
			});

			it('the button queues the pick with its note and screenshot, keeps Design Mode on, and names the tab', async () => {
				const onDesignQueue = vi.fn().mockResolvedValue(QUEUED_TO);
				const { note, onDesignPick } = await openCard({ onDesignQueue });
				fireEvent.change(note, { target: { value: 'Make it blue' } });

				await act(async () => {
					fireEvent.click(queueButton());
				});

				expect(onDesignQueue).toHaveBeenCalledTimes(1);
				const [capture] = onDesignQueue.mock.calls[0];
				expect(capture).toMatchObject({
					pick: { selector: 'button.primary' },
					screenshot: SHOT,
					note: 'Make it blue',
				});
				// A queued pick takes no `reveal`, and never goes down the add path.
				expect(capture).not.toHaveProperty('reveal');
				expect(onDesignPick).not.toHaveBeenCalled();
				await waitFor(() =>
					expect(screen.queryByTestId('browser-tab-design-mode-card')).toBeNull()
				);
				expect(screen.getByTestId('browser-tab-design-mode-layer')).toBeTruthy();
				expect(useCenterFlashStore.getState().active).toMatchObject({
					message: 'Queued for Fix header',
					color: 'green',
				});
			});

			it('Alt+Enter from the note queues the same way', async () => {
				const onDesignQueue = vi.fn().mockResolvedValue(QUEUED_TO);
				const { note, onDesignPick } = await openCard({ onDesignQueue });
				fireEvent.change(note, { target: { value: 'Make it blue' } });

				await act(async () => {
					fireEvent.keyDown(note, { key: 'Enter', altKey: true });
				});

				expect(onDesignQueue).toHaveBeenCalledWith(
					expect.objectContaining({ note: 'Make it blue', screenshot: SHOT })
				);
				expect(onDesignPick).not.toHaveBeenCalled();
				await waitFor(() =>
					expect(screen.queryByTestId('browser-tab-design-mode-card')).toBeNull()
				);
				expect(screen.getByTestId('browser-tab-design-mode-layer')).toBeTruthy();
				expect(useCenterFlashStore.getState().active?.message).toBe('Queued for Fix header');
			});

			it('leaves the other Enter chords alone: Shift+Alt+Enter is a newline, Alt+Cmd+Enter keeps picking', async () => {
				const onDesignQueue = vi.fn().mockResolvedValue(QUEUED_TO);
				const { note, onDesignPick } = await openCard({ onDesignQueue });

				await act(async () => {
					fireEvent.keyDown(note, { key: 'Enter', altKey: true, shiftKey: true });
				});
				expect(onDesignQueue).not.toHaveBeenCalled();
				expect(onDesignPick).not.toHaveBeenCalled();

				await act(async () => {
					fireEvent.keyDown(note, { key: 'Enter', altKey: true, metaKey: true });
				});
				expect(onDesignPick).toHaveBeenCalledWith(expect.objectContaining({ reveal: false }));
				expect(onDesignQueue).not.toHaveBeenCalled();
			});

			it('only the note owns Alt+Enter: on a focused card button it queues nothing', async () => {
				const onDesignQueue = vi.fn().mockResolvedValue(QUEUED_TO);
				await openCard({ onDesignQueue });

				for (const id of [
					'browser-tab-design-mode-card-close',
					'browser-tab-design-mode-queue',
					'browser-tab-design-mode-add-another',
				]) {
					await act(async () => {
						fireEvent.keyDown(screen.getByTestId(id), { key: 'Enter', altKey: true });
					});
				}

				expect(onDesignQueue).not.toHaveBeenCalled();
				expect(screen.getByTestId('browser-tab-design-mode-card')).toBeTruthy();
			});

			it('keeps the card, the note and the mode when the host queued nothing', async () => {
				const onDesignQueue = vi.fn().mockResolvedValue(null);
				const { note } = await openCard({ onDesignQueue });
				fireEvent.change(note, { target: { value: 'Keep this note' } });

				await act(async () => {
					fireEvent.click(queueButton());
				});

				expect(onDesignQueue).toHaveBeenCalledTimes(1);
				expect(screen.getByTestId('browser-tab-design-mode-layer')).toBeTruthy();
				expect(
					(screen.getByTestId('browser-tab-design-mode-note') as HTMLTextAreaElement).value
				).toBe('Keep this note');
				expect(useCenterFlashStore.getState().active).toBeNull();
				// Free again, so the user can retry.
				expect(queueButton().disabled).toBe(false);
			});

			it('hands off once: a press in the same tick, or while one is in flight, does nothing', async () => {
				const { onDesignQueue, finish } = pendingQueue();
				const { note, onDesignPick } = await openCard({ onDesignQueue });

				// A click and Alt+Enter in one tick: the second finds the first running
				// before React has re-rendered the disabled button.
				await act(async () => {
					fireEvent.click(queueButton());
					fireEvent.keyDown(note, { key: 'Enter', altKey: true });
				});
				// Add is held back too while the queue call is pending.
				await act(async () => {
					fireEvent.keyDown(note, { key: 'Enter' });
				});

				expect(onDesignQueue).toHaveBeenCalledTimes(1);
				expect(onDesignPick).not.toHaveBeenCalled();
				expect(queueButton().disabled).toBe(true);

				await act(async () => {
					finish(QUEUED_TO);
				});
				await waitFor(() =>
					expect(screen.queryByTestId('browser-tab-design-mode-card')).toBeNull()
				);
				expect(onDesignQueue).toHaveBeenCalledTimes(1);
			});

			it('still says where the pick went when Design Mode was left while it was in flight', async () => {
				const { onDesignQueue, finish } = pendingQueue();
				const { note } = await openCard({ onDesignQueue });
				await act(async () => {
					fireEvent.keyDown(note, { key: 'Enter', altKey: true });
				});

				// Escape closes the card, a second Escape leaves Design Mode.
				fireEvent.keyDown(screen.getByTestId('browser-tab-design-mode-card'), { key: 'Escape' });
				fireEvent.keyDown(screen.getByTestId('browser-tab-design-mode-layer'), { key: 'Escape' });
				expect(screen.queryByTestId('browser-tab-design-mode-layer')).toBeNull();

				await act(async () => {
					finish(QUEUED_TO);
				});

				// The pick is in the queue whether or not the layer is still there.
				expect(useCenterFlashStore.getState().active?.message).toBe('Queued for Fix header');
			});
		});

		it('Escape closes the card first, then turns Design Mode off on the tab', async () => {
			const { onUpdateTab } = await setupReady(vi.fn());
			const layer = await arm();
			await act(async () => {
				fireEvent.keyDown(layer, { key: 'Enter' });
			});
			const card = await screen.findByTestId('browser-tab-design-mode-card');
			fireEvent.keyDown(card, { key: 'Escape' });
			expect(screen.queryByTestId('browser-tab-design-mode-card')).toBeNull();
			expect(designModeWrites(onUpdateTab)).toEqual([true]);
			fireEvent.keyDown(screen.getByTestId('browser-tab-design-mode-layer'), { key: 'Escape' });
			expect(screen.queryByTestId('browser-tab-design-mode-layer')).toBeNull();
			expect(designModeWrites(onUpdateTab)).toEqual([true, false]);
			expect(
				screen.getByTestId('browser-tab-design-mode-toggle').getAttribute('aria-pressed')
			).toBe('false');
		});

		it('Escape closes the card even when focus fell back to the layer', async () => {
			await setupReady(vi.fn());
			const layer = await arm();
			await act(async () => {
				fireEvent.keyDown(layer, { key: 'Enter' });
			});
			await screen.findByTestId('browser-tab-design-mode-card');
			// A click on the card background leaves focus on the layer.
			fireEvent.keyDown(layer, { key: 'Escape' });
			expect(screen.queryByTestId('browser-tab-design-mode-card')).toBeNull();
			expect(screen.getByTestId('browser-tab-design-mode-layer')).toBeTruthy();
		});

		it('the banner ESC pill leaves Design Mode', async () => {
			await setupReady(vi.fn());
			await arm();
			fireEvent.click(screen.getByTestId('browser-tab-design-mode-cancel'));
			expect(screen.queryByTestId('browser-tab-design-mode-layer')).toBeNull();
		});

		it('the page cannot start a pick: a console message is not a channel', async () => {
			const onDesignPick = vi.fn().mockResolvedValue(true);
			const { webview } = await setupReady(onDesignPick);
			await arm();
			await act(async () => {
				webview.dispatchEvent(
					Object.assign(new Event('console-message'), {
						message: '__MAESTRO_DESIGN__' + JSON.stringify({ type: 'pick', pick: pickPayload }),
					})
				);
			});
			expect(screen.queryByTestId('browser-tab-design-mode-card')).toBeNull();
			expect(guestCalls(webview, 'describe')).toHaveLength(0);
			expect(onDesignPick).not.toHaveBeenCalled();
		});

		describe('sticky per tab', () => {
			function toggleButton() {
				return screen.getByTestId('browser-tab-design-mode-toggle') as HTMLButtonElement;
			}

			it('the toolbar toggle writes the flag on the tab, and the layer follows the tab', async () => {
				const { onUpdateTab } = await setupReady(vi.fn());
				await arm();
				expect(onUpdateTab).toHaveBeenCalledWith('browser-1', { designMode: true });
				expect(toggleButton().getAttribute('aria-pressed')).toBe('true');

				await act(async () => {
					fireEvent.click(toggleButton());
				});
				expect(onUpdateTab).toHaveBeenCalledWith('browser-1', { designMode: false });
				expect(screen.queryByTestId('browser-tab-design-mode-layer')).toBeNull();
			});

			it('a hidden or covered tab draws no picker but keeps the flag, and re-arms when shown', async () => {
				const { webview, onUpdateTab, setActive } = await setupReady(vi.fn());
				await arm();
				const probesBefore = guestCalls(webview, 'probe').length;

				await act(async () => setActive(false));
				// Nothing left over the page to swallow a click, and the flag is kept.
				expect(screen.queryByTestId('browser-tab-design-mode-layer')).toBeNull();
				expect(designModeWrites(onUpdateTab)).toEqual([true]);
				expect(toggleButton().getAttribute('aria-pressed')).toBe('true');

				await act(async () => setActive(true));
				// A fresh layer: it takes focus and probes from the center again.
				const layer = screen.getByTestId('browser-tab-design-mode-layer');
				expect(document.activeElement).toBe(layer);
				await waitFor(() =>
					expect(guestCalls(webview, 'probe').length).toBeGreaterThan(probesBefore)
				);
				expect(designModeWrites(onUpdateTab)).toEqual([true]);
			});

			it('a tab saved with Design Mode on comes up armed, and its first page load fills in the outline', async () => {
				const { webview, onUpdateTab } = await setupReady(vi.fn(), {
					tab: { ...mockTab, designMode: true },
				});
				// Armed without a toggle. The probe at mount found no guest to ask yet.
				const layer = screen.getByTestId('browser-tab-design-mode-layer');
				expect(document.activeElement).toBe(layer);
				expect(screen.queryByTestId('browser-tab-design-mode-outline')).toBeNull();

				await finishLoad(webview);

				expect(await screen.findByTestId('browser-tab-design-mode-outline')).toBeTruthy();
				expect(designModeWrites(onUpdateTab)).toEqual([]);
			});

			it('a finished page load re-probes at the same point, from the element itself', async () => {
				const { webview, onUpdateTab } = await setupReady(vi.fn());
				const layer = await arm();
				await act(async () => {
					fireEvent.mouseMove(layer, { clientX: 30, clientY: 60 });
				});
				await act(async () => {
					fireEvent.keyDown(layer, { key: 'ArrowUp' });
				});
				await waitFor(() =>
					expect(guestCalls(webview, 'probe').some((req) => req?.depth === 1)).toBe(true)
				);
				const probesBefore = guestCalls(webview, 'probe').length;

				await finishLoad(webview);

				// Still in Design Mode, asking the new document at the pointer, with
				// the walked depth reset: depth 1 meant a parent on the old page.
				expect(screen.getByTestId('browser-tab-design-mode-layer')).toBeTruthy();
				await waitFor(() =>
					expect(guestCalls(webview, 'probe').length).toBeGreaterThan(probesBefore)
				);
				expect(guestCalls(webview, 'probe').at(-1)).toMatchObject({ x: 30, y: 60, depth: 0 });
				expect(designModeWrites(onUpdateTab)).toEqual([true]);
			});

			it('a page load takes keyboard focus back only when nothing holds it', async () => {
				const { webview } = await setupReady(vi.fn());
				const layer = await arm();

				// A page that focused itself on load was pushed out: focus is nowhere.
				act(() => layer.blur());
				expect(document.activeElement).toBe(document.body);
				await finishLoad(webview);
				expect(document.activeElement).toBe(layer);

				// The user is typing in the address bar: a load must not take it.
				const address = screen.getByLabelText('Browser URL');
				act(() => address.focus());
				await finishLoad(webview);
				expect(document.activeElement).toBe(address);
			});

			it('the blank page hides the picker without turning it off, and the next page re-arms it', async () => {
				const { webview, onUpdateTab } = await setupReady(vi.fn());
				await arm();

				webview.getURL = vi.fn(() => DEFAULT_BROWSER_TAB_URL);
				await act(async () => {
					webview.dispatchEvent(
						Object.assign(new Event('did-navigate'), { url: DEFAULT_BROWSER_TAB_URL })
					);
				});
				expect(screen.queryByTestId('browser-tab-design-mode-layer')).toBeNull();
				expect(toggleButton().getAttribute('aria-pressed')).toBe('true');

				webview.getURL = vi.fn(() => 'https://example.com/next');
				await act(async () => {
					webview.dispatchEvent(
						Object.assign(new Event('did-navigate'), { url: 'https://example.com/next' })
					);
				});
				expect(screen.getByTestId('browser-tab-design-mode-layer')).toBeTruthy();
				expect(designModeWrites(onUpdateTab)).toEqual([true]);
			});

			it('on the blank page the toggle can still turn a sticky Design Mode off, but not on', async () => {
				const { ref, onUpdateTab } = await setupReady(vi.fn(), {
					tab: { ...mockTab, url: DEFAULT_BROWSER_TAB_URL, designMode: true },
				});
				expect(screen.queryByTestId('browser-tab-design-mode-layer')).toBeNull();
				expect(toggleButton().disabled).toBe(false);

				await act(async () => {
					fireEvent.click(toggleButton());
				});
				expect(designModeWrites(onUpdateTab)).toEqual([false]);
				expect(toggleButton().disabled).toBe(true);

				// The shortcut and the palette cannot turn it on here either.
				await act(async () => {
					ref.current!.toggleDesignMode();
				});
				expect(designModeWrites(onUpdateTab)).toEqual([false]);
			});
		});

		describe('hold Space to use the page', () => {
			/**
			 * Answers the page's Space watch: every `passthrough` call stays
			 * pending until the test resolves it (the page heard the release), and
			 * `endPassthrough` closes the open watch and returns its report, as
			 * the guest helper does. Its reply to the first call is left to the
			 * test, so a late one can be sent on purpose.
			 */
			function watchPage(webview: MockWebview) {
				const base = webview.executeJavaScript.getMockImplementation() as (
					code: string
				) => Promise<unknown>;
				const page = {
					/** Where the page last saw the pointer, guest CSS px. */
					pointer: null as { x: number; y: number } | null,
					/** One resolver per watch the host started, oldest first. */
					watches: [] as Array<(report: unknown) => void>,
					open: false,
					report: () => ({ point: page.pointer, viewport: pickPayload.viewport }),
					/** The page heard Space come up: the newest watch ends. */
					release() {
						page.open = false;
						page.watches.at(-1)?.(page.report());
					},
				};
				webview.executeJavaScript.mockImplementation((code: string) => {
					const req = guestRequest(code);
					if (req?.type === 'passthrough') {
						page.open = true;
						return new Promise((resolve) => page.watches.push(resolve));
					}
					if (req?.type === 'endPassthrough') {
						const report = page.open ? page.report() : null;
						page.open = false;
						return Promise.resolve(report);
					}
					return base(code);
				});
				return page;
			}

			/** Space goes down; false when the layer took it (default prevented). */
			async function holdSpace(target: HTMLElement, init: KeyboardEventInit = {}) {
				let passed = true;
				await act(async () => {
					passed = fireEvent.keyDown(target, { key: ' ', code: 'Space', ...init });
				});
				return passed;
			}

			async function releaseSpace(target: HTMLElement) {
				await act(async () => {
					fireEvent.keyUp(target, { key: ' ', code: 'Space' });
				});
			}

			/** Keyboard focus moves into the page, the way a click into it moves it. */
			function focusPage(webview: MockWebview) {
				// jsdom focuses only an element with a tabindex; the pointerdown is
				// what lets the host's focus guard leave a clicked page focused.
				webview.tabIndex = -1;
				fireEvent.pointerDown(webview);
				act(() => webview.focus());
				expect(document.activeElement).toBe(webview);
			}

			const bannerText = () => screen.getByTestId('browser-tab-design-mode-banner').textContent;

			it('lets the page have the pointer while Space is down, then picks again from the same point', async () => {
				const { webview } = await setupReady(vi.fn());
				watchPage(webview);
				const layer = await arm();
				await act(async () => {
					fireEvent.mouseMove(layer, { clientX: 30, clientY: 60 });
				});
				expect(await screen.findByTestId('browser-tab-design-mode-outline')).toBeTruthy();

				// Taken by the layer, so nothing behind it scrolls.
				expect(await holdSpace(layer)).toBe(false);
				expect(layer.style.pointerEvents).toBe('none');
				expect(screen.queryByTestId('browser-tab-design-mode-outline')).toBeNull();
				// The crumbs go with the outline: nothing over the page to click.
				expect(screen.queryByTestId('browser-tab-design-mode-crumbs')).toBeNull();
				expect(bannerText()).toContain('Using the page - release Space to pick');
				// The picking hints do not apply while the page is in use.
				expect(bannerText()).not.toContain('Arrows');
				expect(guestCalls(webview, 'passthrough')).toHaveLength(1);

				// The held key's auto-repeat changes nothing and asks the page once.
				expect(await holdSpace(layer, { repeat: true })).toBe(false);
				expect(guestCalls(webview, 'passthrough')).toHaveLength(1);

				await releaseSpace(layer);
				expect(layer.style.pointerEvents).toBe('');
				expect(bannerText()).toContain('Design Mode: click an element.');
				expect(guestCalls(webview, 'endPassthrough')).toHaveLength(1);
				expect(await screen.findByTestId('browser-tab-design-mode-outline')).toBeTruthy();
				expect(guestCalls(webview, 'probe').at(-1)).toMatchObject({ x: 30, y: 60, depth: 0 });
				expect(document.activeElement).toBe(layer);
			});

			it('Space is an ordinary key on a focused control and in the note', async () => {
				const { webview } = await setupReady(vi.fn());
				watchPage(webview);
				const layer = await arm();
				// The banner's ESC pill keeps Space's own meaning.
				expect(await holdSpace(screen.getByTestId('browser-tab-design-mode-cancel'))).toBe(true);

				await act(async () => {
					fireEvent.keyDown(layer, { key: 'Enter' });
				});
				const note = await screen.findByTestId('browser-tab-design-mode-note');
				expect(await holdSpace(note)).toBe(true);
				await releaseSpace(note);

				expect(guestCalls(webview, 'passthrough')).toHaveLength(0);
				expect(layer.style.pointerEvents).toBe('');
				expect(screen.getByTestId('browser-tab-design-mode-card')).toBeTruthy();
			});

			it('a release the page reports resumes picking where the page saw the pointer, and never picks', async () => {
				const onDesignPick = vi.fn().mockResolvedValue(true);
				const { webview } = await setupReady(onDesignPick);
				const page = watchPage(webview);
				const layer = await arm();
				await holdSpace(layer);
				// The user clicked into the page (it holds the keys now) and moved over it.
				focusPage(webview);
				page.pointer = { x: 120, y: 80 };

				await act(async () => page.release());

				expect(layer.style.pointerEvents).toBe('');
				// jsdom lays nothing out, so the overlay and the page share one scale.
				await waitFor(() =>
					expect(guestCalls(webview, 'probe').at(-1)).toMatchObject({ x: 120, y: 80, depth: 0 })
				);
				// The keys come back to the layer, from the page that held them.
				expect(document.activeElement).toBe(layer);
				// A release can only end it: no pick, no card, nothing delivered.
				expect(guestCalls(webview, 'describe')).toHaveLength(0);
				expect(screen.queryByTestId('browser-tab-design-mode-card')).toBeNull();
				expect(onDesignPick).not.toHaveBeenCalled();
			});

			it('a release heard on the host moves to where the page saw the pointer', async () => {
				const { webview } = await setupReady(vi.fn());
				const page = watchPage(webview);
				const layer = await arm();
				await holdSpace(layer);
				page.pointer = { x: 200, y: 150 };

				await releaseSpace(layer);

				await waitFor(() =>
					expect(guestCalls(webview, 'probe').at(-1)).toMatchObject({ x: 200, y: 150, depth: 0 })
				);
			});

			it('Enter, the arrows, a click and the wheel wait while the page is in use', async () => {
				const { webview } = await setupReady(vi.fn());
				watchPage(webview);
				const layer = await arm();
				await holdSpace(layer);
				const probes = guestCalls(webview, 'probe').length;

				// In the app the click and the wheel go to the page; the layer
				// ignores them even when it hears them.
				await act(async () => {
					fireEvent.keyDown(layer, { key: 'Enter' });
					fireEvent.keyDown(layer, { key: 'ArrowUp' });
					fireEvent.click(layer, { clientX: 5, clientY: 5, button: 0 });
					fireEvent.wheel(layer, { clientX: 5, clientY: 5, deltaY: 100 });
				});

				expect(guestCalls(webview, 'describe')).toHaveLength(0);
				expect(guestCalls(webview, 'scroll')).toHaveLength(0);
				expect(guestCalls(webview, 'probe')).toHaveLength(probes);
				expect(screen.queryByTestId('browser-tab-design-mode-card')).toBeNull();
			});

			it('a release in a host control ends it without taking that control', async () => {
				const { webview } = await setupReady(vi.fn());
				watchPage(webview);
				const layer = await arm();
				await holdSpace(layer);
				const address = screen.getByLabelText('Browser URL');
				act(() => address.focus());

				await releaseSpace(address);

				expect(layer.style.pointerEvents).toBe('');
				expect(document.activeElement).toBe(address);
			});

			it('leaving the app while Space is down ends it; a click into the page does not', async () => {
				const { webview } = await setupReady(vi.fn());
				watchPage(webview);
				const layer = await arm();
				await holdSpace(layer);
				const windowBlur = async () => {
					await act(async () => {
						fireEvent.blur(window);
						await new Promise((resolve) => setTimeout(resolve, 0));
					});
				};

				// A click into the page may blur the host window: the page holds
				// focus, so the release will reach its watch.
				focusPage(webview);
				await windowBlur();
				expect(layer.style.pointerEvents).toBe('none');
				expect(guestCalls(webview, 'endPassthrough')).toHaveLength(0);

				// Focus back on the layer, then the app loses focus (Cmd+Tab): the
				// release will land in another app.
				act(() => layer.focus());
				await windowBlur();
				expect(layer.style.pointerEvents).toBe('');
				expect(guestCalls(webview, 'endPassthrough')).toHaveLength(1);
			});

			it('a page load ends it and takes the keys back, so a Space still held starts it again', async () => {
				const { webview } = await setupReady(vi.fn());
				watchPage(webview);
				const layer = await arm();
				await holdSpace(layer);
				// The user clicked a link: focus is in the page, and the new page loads.
				focusPage(webview);

				await finishLoad(webview);

				expect(layer.style.pointerEvents).toBe('');
				expect(document.activeElement).toBe(layer);
				expect(guestCalls(webview, 'endPassthrough')).toHaveLength(1);
				// The key is still down: its next auto-repeat reaches the layer.
				await holdSpace(layer, { repeat: true });
				expect(layer.style.pointerEvents).toBe('none');
				expect(guestCalls(webview, 'passthrough')).toHaveLength(2);
			});

			it('falls back: once the pointer is seen outside the page, its return resumes picking', async () => {
				const { webview } = await setupReady(vi.fn());
				watchPage(webview);
				const layer = await arm();
				await holdSpace(layer);

				// Over the page the layer does nothing (in the app it hears nothing).
				await act(async () => {
					fireEvent.mouseMove(layer, { clientX: 40, clientY: 40 });
				});
				expect(layer.style.pointerEvents).toBe('none');

				// Seen over the toolbar: the layer takes the pointer back, still in use.
				await act(async () => {
					fireEvent.mouseMove(screen.getByLabelText('Browser URL'), { clientX: 900, clientY: 5 });
				});
				expect(layer.style.pointerEvents).toBe('');
				expect(bannerText()).toContain('Using the page - release Space to pick');

				// Its return resumes picking at that point.
				await act(async () => {
					fireEvent.mouseMove(layer, { clientX: 90, clientY: 45 });
				});
				expect(bannerText()).toContain('Design Mode: click an element.');
				expect(guestCalls(webview, 'endPassthrough')).toHaveLength(1);
				await waitFor(() =>
					expect(guestCalls(webview, 'probe').at(-1)).toMatchObject({ x: 90, y: 45, depth: 0 })
				);
			});

			it('falls back only with Space up: a key the layer still hears repeating keeps the page in use', async () => {
				const { webview } = await setupReady(vi.fn());
				watchPage(webview);
				const layer = await arm();
				const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
				try {
					const leaveAndReturn = async () => {
						await act(async () => {
							fireEvent.mouseMove(screen.getByLabelText('Browser URL'), {
								clientX: 900,
								clientY: 5,
							});
						});
						expect(layer.style.pointerEvents).toBe('');
						await act(async () => {
							fireEvent.mouseMove(layer, { clientX: 90, clientY: 45 });
						});
					};
					await holdSpace(layer);
					await holdSpace(layer, { repeat: true });

					// Back within a repeat of the key: it is down, so the page gets the pointer.
					now.mockReturnValue(10_100);
					await leaveAndReturn();
					expect(layer.style.pointerEvents).toBe('none');
					expect(bannerText()).toContain('Using the page - release Space to pick');
					expect(guestCalls(webview, 'endPassthrough')).toHaveLength(0);

					// No repeat for longer than that: Space is up, so picking resumes.
					now.mockReturnValue(10_700);
					await leaveAndReturn();
					expect(bannerText()).toContain('Design Mode: click an element.');
					expect(guestCalls(webview, 'endPassthrough')).toHaveLength(1);
				} finally {
					now.mockRestore();
				}
			});

			it('a late reply from an earlier watch cannot end a newer one', async () => {
				const { webview } = await setupReady(vi.fn());
				const page = watchPage(webview);
				const layer = await arm();
				await holdSpace(layer);
				await releaseSpace(layer);
				await holdSpace(layer);
				expect(page.watches).toHaveLength(2);

				// The first watch's reply arrives only now.
				await act(async () => page.watches[0](page.report()));
				expect(layer.style.pointerEvents).toBe('none');

				await act(async () => page.watches[1](page.report()));
				expect(layer.style.pointerEvents).toBe('');
			});

			it('leaving the tab or Design Mode while Space is down tells the page to stop watching', async () => {
				const { webview, setActive } = await setupReady(vi.fn());
				watchPage(webview);
				await holdSpace(await arm());

				await act(async () => setActive(false));
				expect(screen.queryByTestId('browser-tab-design-mode-layer')).toBeNull();
				expect(guestCalls(webview, 'endPassthrough')).toHaveLength(1);

				// A fresh layer starts out picking.
				await act(async () => setActive(true));
				const layer = screen.getByTestId('browser-tab-design-mode-layer');
				expect(layer.style.pointerEvents).toBe('');

				// Escape still leaves Design Mode while the page is in use.
				await holdSpace(layer);
				await act(async () => {
					fireEvent.keyDown(layer, { key: 'Escape' });
				});
				expect(screen.queryByTestId('browser-tab-design-mode-layer')).toBeNull();
				expect(guestCalls(webview, 'endPassthrough')).toHaveLength(2);
			});
		});

		describe('ancestor crumbs', () => {
			/** The element under the pointer, then its ancestors, as the guest walks them. */
			const CHAIN = ['span.icon', 'button.primary', 'section.footer', 'main', 'body'];

			/**
			 * Answers every probe from CHAIN, clamped at <body> as the guest clamps
			 * it. Each level has its own box (guest CSS px; jsdom draws them 1:1),
			 * so a test can tell which element is outlined and where its label sits.
			 */
			function walkablePage(webview: MockWebview, { cut = false } = {}) {
				const base = webview.executeJavaScript.getMockImplementation() as (
					code: string
				) => Promise<unknown>;
				webview.executeJavaScript.mockImplementation((code: string) => {
					const req = guestRequest(code);
					if (req?.type !== 'probe') return base(code);
					const depth = Math.min(Number(req.depth), CHAIN.length - 1);
					return Promise.resolve({
						rect: { x: 100 - depth * 20, y: 200 - depth * 40, width: 100, height: 40 },
						label: CHAIN[depth],
						depth,
						ancestors: CHAIN.slice(depth + 1),
						ancestorsTruncated: cut,
						viewport: pickPayload.viewport,
					});
				});
			}

			const crumbRow = () => screen.getByTestId('browser-tab-design-mode-crumbs');
			const crumbLabels = () =>
				within(crumbRow())
					.queryAllByRole('button')
					.map((button) => button.textContent);
			/** The outlined element: the crumb row's last, current entry. */
			const outlined = () => crumbRow().querySelector('[aria-current]')?.textContent;
			const crumb = (label: string) => within(crumbRow()).getByRole('button', { name: label });

			/** Hover the element at (30, 60) and wait for its crumbs. */
			async function hoverIcon() {
				const layer = screen.getByTestId('browser-tab-design-mode-layer');
				await act(async () => {
					fireEvent.mouseMove(layer, { clientX: 30, clientY: 60 });
				});
				await waitFor(() => expect(outlined()).toBe('span.icon'));
				return layer;
			}

			/** Click a crumb and wait for the ancestor it names to be outlined. */
			async function clickCrumb(label: string) {
				await act(async () => {
					fireEvent.click(crumb(label));
				});
				await waitFor(() => expect(outlined()).toBe(label));
			}

			/**
			 * Lays the crumb row out where the label for the hovered element sits:
			 * a 300 x 22 box just above the element's top edge (jsdom does no
			 * layout of its own).
			 */
			function layOutCrumbs() {
				const box = { left: 100, top: 180, right: 400, bottom: 202, width: 300, height: 22 };
				vi.spyOn(crumbRow(), 'getBoundingClientRect').mockReturnValue({
					...box,
					x: box.left,
					y: box.top,
					toJSON: () => box,
				} as DOMRect);
			}

			it('the hover label is the path to the outlined element, farthest first', async () => {
				const { webview } = await setupReady(vi.fn());
				walkablePage(webview);
				await arm();
				await hoverIcon();

				expect(crumbLabels()).toEqual(['body', 'main', 'section.footer', 'button.primary']);
				// The outlined element closes the path, followed by its size.
				expect(crumbRow().textContent).toBe(
					'body>main>section.footer>button.primary>span.icon100 x 40'
				);
				// The banner names the gestures picking offers.
				expect(screen.getByTestId('browser-tab-design-mode-banner').textContent).toContain(
					'Space: use the page. Drag: region. Arrows: parent / child.'
				);
			});

			it('a chain cut at the cap starts with an ellipsis', async () => {
				const { webview } = await setupReady(vi.fn());
				walkablePage(webview, { cut: true });
				await arm();
				await hoverIcon();
				expect(crumbRow().textContent?.startsWith('…>body>')).toBe(true);
			});

			it('a crumb click outlines that ancestor, walked from the same point, and never picks', async () => {
				const onDesignPick = vi.fn().mockResolvedValue(true);
				const { webview } = await setupReady(onDesignPick);
				walkablePage(webview);
				await arm();
				const layer = await hoverIcon();

				// Over the crumbs the outline stays put: nothing asks about the
				// point under them.
				const probes = guestCalls(webview, 'probe').length;
				await act(async () => {
					fireEvent.mouseMove(crumb('section.footer'), { clientX: 120, clientY: 190 });
				});
				expect(guestCalls(webview, 'probe')).toHaveLength(probes);
				// Pressing a crumb leaves the keys with the layer (default prevented,
				// so the button never takes focus), and Enter and the arrows go on working.
				expect(fireEvent.mouseDown(crumb('section.footer'))).toBe(false);
				expect(document.activeElement).toBe(layer);

				await clickCrumb('section.footer');

				// Two levels above the element under the pointer, asked at that point.
				expect(guestCalls(webview, 'probe').at(-1)).toMatchObject({ x: 30, y: 60, depth: 2 });
				expect(crumbLabels()).toEqual(['body', 'main']);
				expect(screen.getByTestId('browser-tab-design-mode-outline').style.left).toBe('58px');
				// Not a pick: nothing described, no card, nothing delivered.
				expect(guestCalls(webview, 'describe')).toHaveLength(0);
				expect(screen.queryByTestId('browser-tab-design-mode-card')).toBeNull();
				expect(onDesignPick).not.toHaveBeenCalled();
			});

			it('holds the ancestor near its crumbs: they stay put, and a click there picks it', async () => {
				const { webview } = await setupReady(vi.fn().mockResolvedValue(true));
				walkablePage(webview);
				await arm();
				const layer = await hoverIcon();
				// The label rests on the hovered element's top edge (y 200), reaching
				// 2 px over it so the pointer can climb onto it.
				const labelTop = () => crumbRow().parentElement!.style.top;
				expect(labelTop()).toBe('202px');

				await clickCrumb('section.footer');
				// The outline moved up to the section; its crumbs did not move with it.
				expect(screen.getByTestId('browser-tab-design-mode-outline').style.top).toBe('118px');
				expect(labelTop()).toBe('202px');

				// Back onto the page beside the crumbs: the outline stays on the ancestor.
				layOutCrumbs();
				const probes = guestCalls(webview, 'probe').length;
				await act(async () => {
					fireEvent.mouseMove(layer, { clientX: 130, clientY: 230 });
				});
				expect(guestCalls(webview, 'probe')).toHaveLength(probes);
				expect(outlined()).toBe('section.footer');

				// A click there picks the outlined ancestor, not the element under it.
				await act(async () => {
					fireEvent.click(layer, { clientX: 130, clientY: 230, button: 0 });
				});
				await screen.findByTestId('browser-tab-design-mode-card');
				expect(guestCalls(webview, 'describe').at(-1)).toMatchObject({ x: 30, y: 60, depth: 2 });
				// The card's frozen outline is labeled by its tag, with no crumbs.
				expect(screen.queryByTestId('browser-tab-design-mode-crumbs')).toBeNull();
			});

			it('Enter and the arrows go on from a held ancestor', async () => {
				const { webview } = await setupReady(vi.fn().mockResolvedValue(true));
				walkablePage(webview);
				await arm();
				const layer = await hoverIcon();
				await clickCrumb('section.footer');

				await act(async () => {
					fireEvent.keyDown(layer, { key: 'ArrowUp' });
				});
				await waitFor(() => expect(outlined()).toBe('main'));
				expect(guestCalls(webview, 'probe').at(-1)).toMatchObject({ x: 30, y: 60, depth: 3 });

				await act(async () => {
					fireEvent.keyDown(layer, { key: 'Enter' });
				});
				await screen.findByTestId('browser-tab-design-mode-card');
				expect(guestCalls(webview, 'describe').at(-1)).toMatchObject({ x: 30, y: 60, depth: 3 });
			});

			it('moving away from the crumbs lets go: the outline follows the pointer again', async () => {
				const { webview } = await setupReady(vi.fn().mockResolvedValue(true));
				walkablePage(webview);
				await arm();
				const layer = await hoverIcon();
				await clickCrumb('main');
				layOutCrumbs();

				// More than 48 px from the crumbs.
				await act(async () => {
					fireEvent.mouseMove(layer, { clientX: 600, clientY: 400 });
				});
				await waitFor(() => expect(outlined()).toBe('span.icon'));
				expect(guestCalls(webview, 'probe').at(-1)).toMatchObject({ x: 600, y: 400, depth: 0 });

				// And a click picks what is under it.
				await act(async () => {
					fireEvent.click(layer, { clientX: 600, clientY: 400, button: 0 });
				});
				await screen.findByTestId('browser-tab-design-mode-card');
				expect(guestCalls(webview, 'describe').at(-1)).toMatchObject({ x: 600, y: 400, depth: 0 });
			});

			it('a page load lets go of a held ancestor', async () => {
				const { webview } = await setupReady(vi.fn());
				walkablePage(webview);
				await arm();
				await hoverIcon();
				await clickCrumb('main');

				await finishLoad(webview);

				await waitFor(() => expect(outlined()).toBe('span.icon'));
				expect(guestCalls(webview, 'probe').at(-1)).toMatchObject({ x: 30, y: 60, depth: 0 });
				// Let go: as the walk moves the outline, its label goes with it again.
				await act(async () => {
					fireEvent.keyDown(screen.getByTestId('browser-tab-design-mode-layer'), {
						key: 'ArrowUp',
					});
				});
				await waitFor(() => expect(outlined()).toBe('button.primary'));
				expect(crumbRow().parentElement!.style.top).toBe('162px');
			});
		});

		describe('drag to select a region', () => {
			afterEach(() => {
				dismissCenterFlash();
			});

			const element = (selector: string, tagName: string, y: number) => ({
				selector,
				tagName,
				rect: { x: 100, y, width: 600, height: 40 },
				text: '',
				html: `<${tagName}></${tagName}>`,
				htmlTruncated: false,
			});

			/** What the page reports for the box dragged from (100, 80) to (740, 300). */
			const REGION = {
				url: 'https://example.com',
				rect: { x: 100, y: 80, width: 640, height: 220 },
				viewport: pickPayload.viewport,
				elements: [
					element('header.top', 'header', 80),
					element('nav.main', 'nav', 120),
					element('h1.title', 'h1', 160),
					element('p.lead', 'p', 200),
					element('button.cta', 'button', 240),
				],
				elementsTruncated: false,
			};

			/** The page answers every `region` request with `reply`. */
			function regionPage(webview: MockWebview, reply: unknown = REGION) {
				const base = webview.executeJavaScript.getMockImplementation() as (
					code: string
				) => Promise<unknown>;
				webview.executeJavaScript.mockImplementation((code: string) =>
					guestRequest(code)?.type === 'region' ? Promise.resolve(reply) : base(code)
				);
			}

			// jsdom lays nothing out, so client pixels are overlay pixels here.

			async function press(target: HTMLElement, x: number, y: number) {
				await act(async () => {
					fireEvent.mouseDown(target, { clientX: x, clientY: y, button: 0, buttons: 1 });
				});
			}

			/** The pointer moves with the button down; `buttons: 0` means it came up elsewhere. */
			async function moveTo(target: HTMLElement, x: number, y: number, buttons = 1) {
				await act(async () => {
					fireEvent.mouseMove(target, { clientX: x, clientY: y, buttons });
				});
			}

			/** The button comes up, and the browser makes a click of the press, as it does. */
			async function release(target: HTMLElement, x: number, y: number) {
				await act(async () => {
					fireEvent.mouseUp(target, { clientX: x, clientY: y, button: 0 });
					fireEvent.click(target, { clientX: x, clientY: y, button: 0 });
				});
			}

			async function drag(layer: HTMLElement, from: [number, number], to: [number, number]) {
				await press(layer, ...from);
				await moveTo(layer, ...to);
				await release(layer, ...to);
			}

			const marquee = () => screen.queryByTestId('browser-tab-design-mode-marquee');
			const boxOf = (box: HTMLElement) => [
				box.style.left,
				box.style.top,
				box.style.width,
				box.style.height,
			];
			const bannerText = () => screen.getByTestId('browser-tab-design-mode-banner').textContent;

			it('a press that moves 4 px or less is a click: it picks the element under the release', async () => {
				const { webview } = await setupReady(vi.fn());
				regionPage(webview);
				const layer = await arm();

				await press(layer, 300, 150);
				await moveTo(layer, 304, 150);
				expect(marquee()).toBeNull();
				await release(layer, 304, 150);

				await screen.findByRole('dialog', { name: 'Picked element' });
				expect(guestCalls(webview, 'region')).toHaveLength(0);
				expect(guestCalls(webview, 'describe').at(-1)).toMatchObject({ x: 304, y: 150, depth: 0 });
			});

			it('a drag past 4 px draws a dashed box from the press point, with its size, in place of the outline', async () => {
				const { webview } = await setupReady(vi.fn());
				regionPage(webview);
				const layer = await arm();
				await act(async () => {
					fireEvent.mouseMove(layer, { clientX: 100, clientY: 80 });
				});
				await screen.findByTestId('browser-tab-design-mode-crumbs');

				await press(layer, 100, 80);
				// 5 px: a drag from here on.
				await moveTo(layer, 105, 80);
				expect(marquee()).toBeTruthy();
				const probes = guestCalls(webview, 'probe').length;
				await moveTo(layer, 740, 300);

				// Anchored where the button went down, not where the drag began to count.
				expect(boxOf(marquee()!)).toEqual(['100px', '80px', '640px', '220px']);
				expect(marquee()!.style.borderStyle).toBe('dashed');
				expect(screen.getByTestId('browser-tab-design-mode-marquee-size').textContent).toBe(
					'640 x 220'
				);
				// The box takes the outline's place, and the pointer asks the page nothing.
				expect(screen.queryByTestId('browser-tab-design-mode-outline')).toBeNull();
				expect(screen.queryByTestId('browser-tab-design-mode-crumbs')).toBeNull();
				expect(guestCalls(webview, 'probe')).toHaveLength(probes);
				expect(bannerText()).toContain('Release to pick the region. Esc: cancel.');
				expect(layer.style.cursor).toBe('crosshair');

				// The wheel, Enter, the arrows and Space wait for the release; Space is
				// still taken, so nothing behind the layer scrolls.
				let spacePassed = true;
				await act(async () => {
					fireEvent.wheel(layer, { clientX: 740, clientY: 300, deltaY: 100 });
					fireEvent.keyDown(layer, { key: 'Enter' });
					fireEvent.keyDown(layer, { key: 'ArrowUp' });
					spacePassed = fireEvent.keyDown(layer, { key: ' ', code: 'Space' });
				});
				expect(spacePassed).toBe(false);
				expect(guestCalls(webview, 'scroll')).toHaveLength(0);
				expect(guestCalls(webview, 'describe')).toHaveLength(0);
				expect(guestCalls(webview, 'passthrough')).toHaveLength(0);
				expect(guestCalls(webview, 'probe')).toHaveLength(probes);
				// Nothing is asked of the page about the region until the release.
				expect(guestCalls(webview, 'region')).toHaveLength(0);
			});

			it('the release asks the page for the region and opens its card', async () => {
				const { webview } = await setupReady(vi.fn(), { onDesignQueue: vi.fn() });
				regionPage(webview);
				const layer = await arm();

				await drag(layer, [100, 80], [740, 300]);

				const card = await screen.findByRole('dialog', { name: 'Picked region' });
				// The box in overlay px with the overlay's size, as a point is sent.
				expect(guestCalls(webview, 'region')).toEqual([
					{
						type: 'region',
						x: 100,
						y: 80,
						width: 640,
						height: 220,
						frame: { width: 0, height: 0 },
					},
				]);
				// The click the release made picks no element.
				expect(guestCalls(webview, 'describe')).toHaveLength(0);
				// The crop is the region the page reported, in guest DIPs at zoom 1.5.
				expect(webview.capturePage).toHaveBeenCalledWith({
					x: 150,
					y: 120,
					width: 960,
					height: 330,
				});

				expect(within(card).getByTestId('browser-tab-design-mode-region-title').textContent).toBe(
					'Region 640 x 220, 5 elements'
				);
				expect(
					within(card)
						.getByRole('img', { name: 'Screenshot of the picked region' })
						.getAttribute('src')
				).toBe(SHOT);
				const listed = within(card).getByRole('list', { name: 'Elements in the region' });
				expect(
					within(listed)
						.getAllByRole('listitem')
						.map((item) => item.textContent)
				).toEqual(['header.top', 'nav.main', 'h1.title', 'p.lead', 'button.cta']);
				// The same note and buttons as an element's card.
				expect(document.activeElement).toBe(
					within(card).getByTestId('browser-tab-design-mode-note')
				);
				for (const id of [
					'browser-tab-design-mode-queue',
					'browser-tab-design-mode-add-another',
					'browser-tab-design-mode-add',
				]) {
					expect(within(card).getByTestId(id)).toBeTruthy();
				}
				// The region stays drawn while its card is open.
				expect(boxOf(marquee()!)).toEqual(['100px', '80px', '640px', '220px']);
				expect(screen.queryByTestId('browser-tab-design-mode-outline')).toBeNull();
			});

			it('dragging up and to the left frames the same box', async () => {
				const { webview } = await setupReady(vi.fn());
				regionPage(webview);
				const layer = await arm();

				await drag(layer, [740, 300], [100, 80]);

				await screen.findByRole('dialog', { name: 'Picked region' });
				expect(guestCalls(webview, 'region')).toEqual([
					expect.objectContaining({ x: 100, y: 80, width: 640, height: 220 }),
				]);
			});

			it('the card draws what the page reported: the part of the box on screen', async () => {
				const { webview } = await setupReady(vi.fn());
				// Dragged past the 800 x 600 viewport; the page clips the box to it.
				regionPage(webview, { ...REGION, rect: { x: 700, y: 500, width: 100, height: 100 } });
				const layer = await arm();

				await drag(layer, [700, 500], [900, 700]);

				const card = await screen.findByRole('dialog', { name: 'Picked region' });
				expect(within(card).getByTestId('browser-tab-design-mode-region-title').textContent).toBe(
					'Region 100 x 100, 5 elements'
				);
				expect(boxOf(marquee()!)).toEqual(['700px', '500px', '100px', '100px']);
				expect(screen.getByTestId('browser-tab-design-mode-marquee-size').textContent).toBe(
					'100 x 100'
				);
			});

			it('a drag that leaves the page stops at its edge, and its size reads in page pixels', async () => {
				// The overlay is 1600 x 1000 and the page 800 x 600: 2 overlay px per CSS px.
				const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1600);
				const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(1000);
				try {
					const { webview } = await setupReady(vi.fn());
					regionPage(webview);
					const layer = await arm();
					// A probe gives the scale the size is read at.
					await act(async () => {
						fireEvent.mouseMove(layer, { clientX: 1000, clientY: 400 });
					});
					await screen.findByTestId('browser-tab-design-mode-outline');

					await press(layer, 1000, 400);
					// Past the right edge and above the top one.
					await moveTo(layer, 2400, -300);

					expect(boxOf(marquee()!)).toEqual(['1000px', '0px', '600px', '400px']);
					expect(screen.getByTestId('browser-tab-design-mode-marquee-size').textContent).toBe(
						'300 x 200'
					);
					await release(layer, 2400, -300);
					await screen.findByRole('dialog', { name: 'Picked region' });
					expect(guestCalls(webview, 'region')).toEqual([
						{
							type: 'region',
							x: 1000,
							y: 0,
							width: 600,
							height: 400,
							frame: { width: 1600, height: 1000 },
						},
					]);
				} finally {
					width.mockRestore();
					height.mockRestore();
				}
			});

			it('Enter in the note adds the region to the message, with its note', async () => {
				const onDesignPick = vi.fn().mockResolvedValue(true);
				const { webview } = await setupReady(onDesignPick);
				regionPage(webview);
				const layer = await arm();
				await drag(layer, [100, 80], [740, 300]);
				const note = await screen.findByTestId('browser-tab-design-mode-note');
				fireEvent.change(note, { target: { value: 'Put these on one row' } });

				await act(async () => {
					fireEvent.keyDown(note, { key: 'Enter' });
				});

				expect(onDesignPick).toHaveBeenCalledWith({
					region: expect.objectContaining({ url: 'https://example.com', rect: REGION.rect }),
					screenshot: SHOT,
					note: 'Put these on one row',
					reveal: true,
				});
			});

			it('each drag is a pick of its own: Add and Pick Another after two drags hands over two regions', async () => {
				const onDesignPick = vi.fn().mockResolvedValue(true);
				const { webview } = await setupReady(onDesignPick);
				regionPage(webview);
				const layer = await arm();

				await drag(layer, [100, 80], [740, 300]);
				const note = await screen.findByTestId('browser-tab-design-mode-note');
				fireEvent.change(note, { target: { value: 'Tighten the spacing' } });
				await act(async () => {
					fireEvent.click(screen.getByTestId('browser-tab-design-mode-add-another'));
				});
				await waitFor(() =>
					expect(screen.queryByTestId('browser-tab-design-mode-card')).toBeNull()
				);
				// Back to picking: the next drag starts a box of its own.
				expect(marquee()).toBeNull();

				const second = {
					...REGION,
					rect: { x: 0, y: 320, width: 400, height: 100 },
					elements: REGION.elements.slice(4),
				};
				regionPage(webview, second);
				await drag(layer, [0, 320], [400, 420]);
				await screen.findByRole('dialog', { name: 'Picked region' });
				await act(async () => {
					fireEvent.keyDown(screen.getByTestId('browser-tab-design-mode-note'), {
						key: 'Enter',
						metaKey: true,
					});
				});

				expect(onDesignPick).toHaveBeenCalledTimes(2);
				const [[first], [next]] = onDesignPick.mock.calls;
				expect(first).toEqual({
					region: expect.objectContaining({ rect: REGION.rect }),
					screenshot: SHOT,
					note: 'Tighten the spacing',
					reveal: false,
				});
				expect(next).toMatchObject({
					region: { rect: second.rect, elements: [{ selector: 'button.cta' }] },
					note: '',
					reveal: false,
				});
				await waitFor(() =>
					expect(screen.queryByTestId('browser-tab-design-mode-card')).toBeNull()
				);
				expect(screen.getByTestId('browser-tab-design-mode-layer')).toBeTruthy();
			});

			it('Queue sends the region as its own message', async () => {
				const onDesignPick = vi.fn().mockResolvedValue(true);
				const onDesignQueue = vi.fn().mockResolvedValue({ tabName: 'Fix header' });
				const { webview } = await setupReady(onDesignPick, { onDesignQueue });
				regionPage(webview);
				const layer = await arm();
				await drag(layer, [100, 80], [740, 300]);
				await screen.findByRole('dialog', { name: 'Picked region' });

				await act(async () => {
					fireEvent.click(screen.getByTestId('browser-tab-design-mode-queue'));
				});

				expect(onDesignQueue).toHaveBeenCalledWith({
					region: expect.objectContaining({ rect: REGION.rect }),
					screenshot: SHOT,
					note: '',
				});
				expect(onDesignPick).not.toHaveBeenCalled();
				expect(useCenterFlashStore.getState().active?.message).toBe('Queued for Fix header');
			});

			it('the card counts what the page listed: one, none, or a list that was cut', async () => {
				const { webview } = await setupReady(vi.fn());
				const layer = await arm();

				async function cardFor(reply: unknown) {
					regionPage(webview, reply);
					await drag(layer, [100, 80], [740, 300]);
					const card = await screen.findByRole('dialog', { name: 'Picked region' });
					const seen = {
						title: within(card).getByTestId('browser-tab-design-mode-region-title').textContent,
						listed: within(card).queryAllByRole('listitem').length,
					};
					// Back to picking for the next drag.
					await act(async () => {
						fireEvent.keyDown(card, { key: 'Escape' });
					});
					return seen;
				}

				expect(await cardFor({ ...REGION, elements: REGION.elements.slice(0, 1) })).toEqual({
					title: 'Region 640 x 220, 1 element',
					listed: 1,
				});
				expect(await cardFor({ ...REGION, elementsTruncated: true })).toEqual({
					title: 'Region 640 x 220, 5+ elements',
					listed: 5,
				});
				expect(await cardFor({ ...REGION, elements: [] })).toEqual({
					title: 'Region 640 x 220, no elements',
					listed: 0,
				});
			});

			it('Escape during a drag drops it: the release picks nothing, and Design Mode stays on', async () => {
				const { webview, onUpdateTab } = await setupReady(vi.fn());
				regionPage(webview);
				const layer = await arm();
				await press(layer, 100, 80);
				await moveTo(layer, 400, 200);
				expect(marquee()).toBeTruthy();

				await act(async () => {
					fireEvent.keyDown(layer, { key: 'Escape' });
				});
				expect(marquee()).toBeNull();
				// The button is still down, but the drag is over.
				await moveTo(layer, 500, 250);
				expect(marquee()).toBeNull();
				await release(layer, 500, 250);

				expect(guestCalls(webview, 'region')).toHaveLength(0);
				// The click the release made is not an element pick either.
				expect(guestCalls(webview, 'describe')).toHaveLength(0);
				expect(screen.queryByTestId('browser-tab-design-mode-card')).toBeNull();
				expect(screen.getByTestId('browser-tab-design-mode-layer')).toBeTruthy();
				expect(designModeWrites(onUpdateTab)).toEqual([true]);
				// Outlining what is under the pointer again, and the next click picks it.
				expect(await screen.findByTestId('browser-tab-design-mode-outline')).toBeTruthy();
				await act(async () => {
					fireEvent.click(layer, { clientX: 300, clientY: 150, button: 0 });
				});
				await screen.findByRole('dialog', { name: 'Picked element' });
			});

			it('a drag that comes back to where it started picks nothing', async () => {
				const { webview } = await setupReady(vi.fn());
				regionPage(webview);
				const layer = await arm();

				await press(layer, 100, 80);
				await moveTo(layer, 200, 160);
				await moveTo(layer, 100, 80);
				await release(layer, 100, 80);

				expect(guestCalls(webview, 'region')).toHaveLength(0);
				expect(guestCalls(webview, 'describe')).toHaveLength(0);
				expect(marquee()).toBeNull();
				expect(screen.queryByTestId('browser-tab-design-mode-card')).toBeNull();
			});

			it('a region the page cannot report picks nothing and says so', async () => {
				const { webview } = await setupReady(vi.fn());
				regionPage(webview, null);
				const layer = await arm();

				await drag(layer, [100, 80], [740, 300]);

				await waitFor(() => expect(bannerText()).toContain('Nothing to pick there.'));
				expect(screen.queryByTestId('browser-tab-design-mode-card')).toBeNull();
				expect(marquee()).toBeNull();
				expect(await screen.findByTestId('browser-tab-design-mode-outline')).toBeTruthy();
			});

			it('drops the box when its release went elsewhere, the app went to the background, or a page loaded', async () => {
				const { webview } = await setupReady(vi.fn());
				regionPage(webview);
				const layer = await arm();

				// A move with the button up: the release landed in another app.
				await press(layer, 100, 80);
				await moveTo(layer, 300, 200);
				expect(marquee()).toBeTruthy();
				await moveTo(layer, 310, 210, 0);
				expect(marquee()).toBeNull();

				await press(layer, 100, 80);
				await moveTo(layer, 300, 200);
				await act(async () => {
					window.dispatchEvent(new Event('blur'));
				});
				expect(marquee()).toBeNull();

				await press(layer, 100, 80);
				await moveTo(layer, 300, 200);
				await finishLoad(webview);
				expect(marquee()).toBeNull();
				// And the release of a dropped press picks nothing.
				await release(layer, 300, 200);

				expect(guestCalls(webview, 'region')).toHaveLength(0);
				expect(guestCalls(webview, 'describe')).toHaveLength(0);
				expect(screen.queryByTestId('browser-tab-design-mode-card')).toBeNull();
			});

			it('a press on the banner never starts a box', async () => {
				const { webview } = await setupReady(vi.fn());
				regionPage(webview);
				const layer = await arm();
				const banner = screen.getByTestId('browser-tab-design-mode-banner');

				await press(banner, 300, 10);
				await moveTo(layer, 600, 300);
				expect(marquee()).toBeNull();
				await release(banner, 600, 300);

				expect(guestCalls(webview, 'region')).toHaveLength(0);
			});
		});

		it('the imperative toggle and inspectElement reach the same path', async () => {
			const { ref, webview } = await setupReady(vi.fn());
			await act(async () => {
				ref.current!.toggleDesignMode();
			});
			expect(screen.getByTestId('browser-tab-design-mode-layer')).toBeTruthy();
			await act(async () => {
				ref.current!.toggleDesignMode();
			});
			expect(screen.queryByTestId('browser-tab-design-mode-layer')).toBeNull();

			let result: Awaited<ReturnType<BrowserTabViewHandle['inspectElement']>> = null;
			await act(async () => {
				result = await ref.current!.inspectElement('button.primary');
			});
			expect(guestCalls(webview, 'describeSelector')).toContainEqual({
				type: 'describeSelector',
				selector: 'button.primary',
			});
			expect(result).toMatchObject({ screenshot: SHOT, pick: { tagName: 'button' } });
		});
	});
});
