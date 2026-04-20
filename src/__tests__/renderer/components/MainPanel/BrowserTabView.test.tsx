import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
	BrowserTabView,
	type BrowserTabViewHandle,
} from '../../../../renderer/components/MainPanel/BrowserTabView';
import type { BrowserTab, Theme } from '../../../../renderer/types';
import { DEFAULT_BROWSER_TAB_URL } from '../../../../renderer/utils/browserTabPersistence';

const mockTheme = {
	colors: {
		bgMain: '#101010',
		bgSidebar: '#181818',
		border: '#303030',
		textMain: '#ffffff',
		textDim: '#8a8a8a',
	},
} as Theme;

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
	getURL: ReturnType<typeof vi.fn>;
	getTitle: ReturnType<typeof vi.fn>;
	isLoading: ReturnType<typeof vi.fn>;
	getWebContentsId: ReturnType<typeof vi.fn>;
	executeJavaScript: ReturnType<typeof vi.fn>;
};

describe('BrowserTabView', () => {
	beforeEach(() => {
		vi.clearAllMocks();
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
			expect(onUpdateTab).toHaveBeenCalledWith(
				'browser-1',
				expect.objectContaining({
					url: 'https://example.com/start',
					title: 'example.com',
					isLoading: true,
					favicon: null,
				})
			);
			expect(onUpdateTab).toHaveBeenCalledWith(
				'browser-1',
				expect.objectContaining({
					url: 'https://redirected.example.com/docs',
					title: 'redirected.example.com',
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
});
