import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
	BrowserTabView,
	type BrowserTabViewHandle,
} from '../../../../renderer/components/MainPanel/BrowserTabView';
import type { BrowserTab, Theme } from '../../../../renderer/types';
import { DEFAULT_BROWSER_TAB_URL } from '../../../../renderer/utils/browserTabPersistence';
import { isWebDesktop } from '../../../../renderer/utils/runtimeContext';

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
	findInPage?: ReturnType<typeof vi.fn>;
	stopFindInPage?: ReturnType<typeof vi.fn>;
	reload?: ReturnType<typeof vi.fn>;
};

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
			// Fresh inline callback every render — mirrors MainPanelContent.
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

			// Scroll up — reveal
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

			// Focus address input — should reveal
			fireEvent.focus(screen.getByLabelText('Browser URL'));
			expect(addressBar).toHaveStyle({ maxHeight: '200px' });
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
});
