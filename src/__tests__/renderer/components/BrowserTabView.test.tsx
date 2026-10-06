import React from 'react';
import { render, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import {
	BrowserTabView,
	type BrowserTabViewHandle,
} from '../../../renderer/components/MainPanel/BrowserTabView';
import type { BrowserTab } from '../../../renderer/types';
import { mockTheme } from '../../helpers/mockTheme';

// lucide-react icons, ResizeObserver, and window.maestro are all mocked globally
// in src/__tests__/setup.ts, so BrowserTabView mounts under jsdom without extra
// stubbing. The guest <webview> renders as an unknown custom element; its
// methods (getURL/canGoBack/...) are only touched inside webview event handlers,
// which never fire in jsdom, so a plain render/rerender needs no method stubs.

function createBrowserTab(overrides: Partial<BrowserTab> = {}): BrowserTab {
	return {
		id: 'browser-1',
		url: 'https://a.test/',
		title: 'A',
		createdAt: 0,
		canGoBack: false,
		canGoForward: false,
		isLoading: false,
		partition: 'persist:maestro-browser-profile-default',
		...overrides,
	};
}

const noop = () => {};

afterEach(() => {
	cleanup();
});

describe('BrowserTabView <webview> src (reload-loop regression)', () => {
	it('binds src ONCE at mount and never re-drives it when tab.url changes', () => {
		const { container, rerender } = render(
			<BrowserTabView
				tab={createBrowserTab({ url: 'https://a.test/' })}
				theme={mockTheme}
				onUpdateTab={noop}
				isActive
			/>
		);

		const webview = container.querySelector('webview');
		expect(webview).not.toBeNull();
		expect(webview!.getAttribute('src')).toBe('https://a.test/');

		// A did-navigate / did-redirect-navigation event rewrites the store URL, so
		// the parent re-renders this SAME view with a new tab.url. Before the fix
		// the controlled `src={tab.url}` prop re-assigned the <webview> src on every
		// such update, and re-assigning a <webview>'s src RELOADS it - a
		// redirecting/canonicalizing site (google.com -> www.google.com/) then
		// oscillated forever. The fix captures the mount-time url in a ref so React
		// never re-drives src afterward.
		rerender(
			<BrowserTabView
				tab={createBrowserTab({ url: 'https://b.test/' })}
				theme={mockTheme}
				onUpdateTab={noop}
				isActive
			/>
		);

		// Same DOM element (not remounted) and src unchanged: the loop driver is gone.
		expect(container.querySelector('webview')).toBe(webview);
		expect(webview!.getAttribute('src')).toBe('https://a.test/');
	});

	it('imperative navigate() assigns webview.src to the resolved URL', () => {
		const ref = React.createRef<BrowserTabViewHandle>();
		const { container } = render(
			<BrowserTabView
				ref={ref}
				tab={createBrowserTab({ url: 'https://start.test/' })}
				theme={mockTheme}
				onUpdateTab={noop}
				isActive
			/>
		);

		const webview = container.querySelector('webview') as HTMLElement & { src: string };
		expect(webview).not.toBeNull();
		expect(ref.current).not.toBeNull();

		// The forwarded-ref navigate() is the real navigation path (used by the
		// coworking browser_navigate tool). A bare host resolves via
		// resolveBrowserTabNavigationTarget to https://example.com/.
		const resolved = ref.current!.navigate('example.com');

		expect(resolved).toBe('https://example.com/');
		// The contract with teeth: navigate DID drive the guest src imperatively.
		expect(webview.src).toBe('https://example.com/');
	});
});
