import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
	BrowserTabView,
	type BrowserTabViewHandle,
} from '../../../../renderer/components/MainPanel/BrowserTabView';
import type { BrowserTab } from '../../../../shared/browserPage';
import { DEFAULT_BROWSER_TAB_URL } from '../../../../renderer/utils/browserTabPersistence';
import { isWebDesktop } from '../../../../renderer/utils/runtimeContext';

import { mockTheme } from '../../../helpers/mockTheme';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { createMockSession } from '../../../helpers/mockSession';

vi.mock('../../../../renderer/utils/browserPageView', () => ({
	createHostBrowserPageView: (target: { tabId: string }, url: string, background: string) => {
		const page = document.createElement('div');
		page.tabIndex = 0;
		page.dataset.maestroBrowserTab = target.tabId;
		page.style.backgroundColor = background;
		return Object.assign(page, {
			src: url,
			canGoBack: vi.fn(() => false),
			canGoForward: vi.fn(() => false),
			goBack: vi.fn(),
			goForward: vi.fn(),
			reload: vi.fn(),
			stop: vi.fn(),
			getURL: vi.fn(() => url),
			getTitle: vi.fn(() => ''),
			isLoading: vi.fn(() => false),
			getWebContentsId: vi.fn(() => 1),
			executeJavaScript: vi.fn().mockResolvedValue(undefined),
			insertCSS: vi.fn().mockResolvedValue('css-key'),
			findInPage: vi.fn(() => 1),
			stopFindInPage: vi.fn(),
			setActive: vi.fn(),
			dispose: () => page.remove(),
		});
	},
}));

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

describe('BrowserTabView', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(isWebDesktop).mockReturnValue(false);
		vi.stubGlobal('ResizeObserver', MockResizeObserver);
		useSessionStore.setState({
			sessions: [
				createMockSession({ id: 'session-1', browserTabs: [mockTab] }),
				createMockSession({
					id: 'session-2',
					browserTabs: [
						{ ...mockTab, id: 'browser-2', partition: 'persist:maestro-browser-session-session-2' },
					],
				}),
			],
		});
	});

	function getWebview(): MockWebview {
		return document.querySelector('[data-maestro-browser-tab="browser-1"]') as MockWebview;
	}

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
				expect(resolved).toBeUndefined();

				// The guest finishes loading.
				loading = false;

				// Advance through the remaining poll, the 300ms post-load settle, and
				// the second not-loading check. Now the extraction runs and resolves.
				await act(async () => {
					await vi.advanceTimersByTimeAsync(500);
				});
				await read;
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
});
