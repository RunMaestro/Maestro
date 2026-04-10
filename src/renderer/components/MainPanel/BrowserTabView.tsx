import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, Globe, Loader2, RotateCw } from 'lucide-react';
import type { BrowserTab, Theme } from '../../types';
import {
	DEFAULT_BROWSER_TAB_TITLE,
	DEFAULT_BROWSER_TAB_URL,
	getBrowserTabTitle,
	normalizeBrowserTabUrl,
} from '../../utils/browserTabPersistence';

type ElectronWebviewElement = HTMLElement & {
	src: string;
	canGoBack: () => boolean;
	canGoForward: () => boolean;
	goBack: () => void;
	goForward: () => void;
	reload: () => void;
	stop: () => void;
	getURL: () => string;
	getTitle: () => string;
	isLoading: () => boolean;
	getWebContentsId?: () => number;
};

interface BrowserTabViewProps {
	tab: BrowserTab;
	theme: Theme;
	onUpdateTab: (tabId: string, updates: Partial<BrowserTab>) => void;
}

function syncWebviewLayout(webview: ElectronWebviewElement | null) {
	if (!webview) return;

	webview.style.display = 'flex';
	webview.style.width = '100%';
	webview.style.height = '100%';
	webview.style.flex = '1 1 auto';

	const shadowHost = (webview as HTMLElement & { shadowRoot?: ShadowRoot | null }).shadowRoot;
	const guestElement = shadowHost?.querySelector<HTMLElement>('object, embed, iframe, webview');
	if (guestElement) {
		guestElement.style.width = '100%';
		guestElement.style.height = '100%';
		guestElement.style.display = 'flex';
	}
}

export const BrowserTabView = React.memo(function BrowserTabView({
	tab,
	theme,
	onUpdateTab,
}: BrowserTabViewProps) {
	const webviewRef = useRef<ElectronWebviewElement | null>(null);
	const hostRef = useRef<HTMLDivElement | null>(null);
	const [addressValue, setAddressValue] = useState(tab.url);

	useEffect(() => {
		setAddressValue(tab.url);
	}, [tab.id, tab.url]);

	useEffect(() => {
		const webview = webviewRef.current;
		if (!webview) return;

		const updateNavigationState = () => {
			const nextUrl = webview.getURL?.() || tab.url || DEFAULT_BROWSER_TAB_URL;
			const nextTitle = getBrowserTabTitle(nextUrl, webview.getTitle?.() || tab.title);

			setAddressValue(nextUrl);
			onUpdateTab(tab.id, {
				url: nextUrl,
				title: nextTitle,
				canGoBack: webview.canGoBack(),
				canGoForward: webview.canGoForward(),
				isLoading: webview.isLoading(),
				webContentsId: webview.getWebContentsId?.(),
			});
		};

		const handleStartLoading = () => onUpdateTab(tab.id, { isLoading: true });
		const handleStopLoading = () => {
			syncWebviewLayout(webview);
			updateNavigationState();
		};
		const handleNavigate = (event: Event) => {
			const nextUrl = (event as Event & { url?: string }).url || webview.getURL?.() || tab.url;
			setAddressValue(nextUrl);
			onUpdateTab(tab.id, { url: nextUrl });
			updateNavigationState();
		};
		const handleTitleUpdated = (event: Event) => {
			const nextTitle = getBrowserTabTitle(
				webview.getURL?.() || tab.url,
				(event as Event & { title?: string }).title || webview.getTitle?.()
			);
			onUpdateTab(tab.id, { title: nextTitle });
		};
		const handleFaviconUpdated = (event: Event) => {
			const favicons = (event as Event & { favicons?: string[] }).favicons;
			onUpdateTab(tab.id, { favicon: favicons?.[0] || null });
		};
		const handleDomReady = () => {
			syncWebviewLayout(webview);
			updateNavigationState();
		};
		const handleNewWindow = (event: Event) => {
			const url = (event as Event & { url?: string }).url;
			if (!url) return;
			event.preventDefault?.();
			void window.maestro.shell.openExternal(url);
		};

		webview.addEventListener('did-start-loading', handleStartLoading);
		webview.addEventListener('did-stop-loading', handleStopLoading);
		webview.addEventListener('did-navigate', handleNavigate);
		webview.addEventListener('did-navigate-in-page', handleNavigate);
		webview.addEventListener('page-title-updated', handleTitleUpdated);
		webview.addEventListener('page-favicon-updated', handleFaviconUpdated);
		webview.addEventListener('dom-ready', handleDomReady);
		webview.addEventListener('new-window', handleNewWindow);

		const resizeObserver =
			typeof ResizeObserver === 'undefined'
				? null
				: new ResizeObserver(() => syncWebviewLayout(webview));
		if (resizeObserver && hostRef.current) {
			resizeObserver.observe(hostRef.current);
		}

		syncWebviewLayout(webview);
		updateNavigationState();

		return () => {
			resizeObserver?.disconnect();
			webview.removeEventListener('did-start-loading', handleStartLoading);
			webview.removeEventListener('did-stop-loading', handleStopLoading);
			webview.removeEventListener('did-navigate', handleNavigate);
			webview.removeEventListener('did-navigate-in-page', handleNavigate);
			webview.removeEventListener('page-title-updated', handleTitleUpdated);
			webview.removeEventListener('page-favicon-updated', handleFaviconUpdated);
			webview.removeEventListener('dom-ready', handleDomReady);
			webview.removeEventListener('new-window', handleNewWindow);
		};
	}, [onUpdateTab, tab.id, tab.title, tab.url]);

	const navigateToAddress = useCallback(
		(rawValue: string) => {
			const nextUrl = normalizeBrowserTabUrl(rawValue);
			setAddressValue(nextUrl);
			onUpdateTab(tab.id, {
				url: nextUrl,
				title: getBrowserTabTitle(
					nextUrl,
					nextUrl === DEFAULT_BROWSER_TAB_URL ? DEFAULT_BROWSER_TAB_TITLE : tab.title
				),
				isLoading: nextUrl !== DEFAULT_BROWSER_TAB_URL,
			});

			const webview = webviewRef.current;
			if (webview && webview.src !== nextUrl) {
				webview.src = nextUrl;
			}
		},
		[onUpdateTab, tab.id, tab.title]
	);

	const handleSubmit = useCallback(
		(event: React.FormEvent<HTMLFormElement>) => {
			event.preventDefault();
			navigateToAddress(addressValue);
		},
		[addressValue, navigateToAddress]
	);

	const handleBack = useCallback(() => {
		const webview = webviewRef.current;
		if (webview?.canGoBack()) {
			webview.goBack();
		}
	}, []);

	const handleForward = useCallback(() => {
		const webview = webviewRef.current;
		if (webview?.canGoForward()) {
			webview.goForward();
		}
	}, []);

	const handleReload = useCallback(() => {
		const webview = webviewRef.current;
		if (!webview) return;
		if (tab.isLoading) {
			webview.stop();
			onUpdateTab(tab.id, { isLoading: false });
			return;
		}
		webview.reload();
	}, [onUpdateTab, tab.id, tab.isLoading]);

	const handleOpenExternal = useCallback(() => {
		if (tab.url === DEFAULT_BROWSER_TAB_URL) return;
		void window.maestro.shell.openExternal(tab.url);
	}, [tab.url]);

	return (
		<div className="flex-1 min-h-0 flex flex-col" data-testid="browser-tab-view">
			<div
				className="shrink-0 flex items-center gap-2 px-3 py-2 border-b"
				style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
			>
				<button
					type="button"
					onClick={handleBack}
					disabled={!tab.canGoBack}
					className="flex items-center justify-center w-8 h-8 rounded transition-colors disabled:opacity-40"
					style={{ color: theme.colors.textMain }}
					title="Back"
				>
					<ArrowLeft className="w-4 h-4" />
				</button>
				<button
					type="button"
					onClick={handleForward}
					disabled={!tab.canGoForward}
					className="flex items-center justify-center w-8 h-8 rounded transition-colors disabled:opacity-40"
					style={{ color: theme.colors.textMain }}
					title="Forward"
				>
					<ArrowRight className="w-4 h-4" />
				</button>
				<button
					type="button"
					onClick={handleReload}
					className="flex items-center justify-center w-8 h-8 rounded transition-colors"
					style={{ color: theme.colors.textMain }}
					title={tab.isLoading ? 'Stop' : 'Reload'}
				>
					{tab.isLoading ? (
						<Loader2 className="w-4 h-4 animate-spin" />
					) : (
						<RotateCw className="w-4 h-4" />
					)}
				</button>
				<form className="flex-1 min-w-0" onSubmit={handleSubmit}>
					<label className="sr-only" htmlFor={`browser-tab-address-${tab.id}`}>
						Address
					</label>
					<div
						className="flex items-center gap-2 rounded-md border px-3 py-1.5"
						style={{ backgroundColor: theme.colors.bgMain, borderColor: theme.colors.border }}
					>
						{tab.favicon ? (
							<img alt="" className="w-4 h-4 shrink-0" src={tab.favicon} />
						) : (
							<Globe className="w-4 h-4 shrink-0" style={{ color: theme.colors.textDim }} />
						)}
						<input
							id={`browser-tab-address-${tab.id}`}
							value={addressValue}
							onChange={(event) => setAddressValue(event.target.value)}
							onBlur={() => setAddressValue(tab.url)}
							className="w-full bg-transparent outline-none text-sm"
							style={{ color: theme.colors.textMain }}
							placeholder="Enter a URL"
						/>
					</div>
				</form>
				<button
					type="button"
					onClick={handleOpenExternal}
					disabled={tab.url === DEFAULT_BROWSER_TAB_URL}
					className="flex items-center justify-center w-8 h-8 rounded transition-colors disabled:opacity-40"
					style={{ color: theme.colors.textMain }}
					title="Open in External Browser"
				>
					<ExternalLink className="w-4 h-4" />
				</button>
			</div>

			<div ref={hostRef} className="flex-1 min-h-0 overflow-hidden" data-testid="browser-tab-host">
				<webview
					ref={(element) => {
						webviewRef.current = element as unknown as ElectronWebviewElement | null;
					}}
					allowpopups={false}
					className="w-full h-full border-0 bg-white"
					partition={tab.partition}
					src={tab.url || DEFAULT_BROWSER_TAB_URL}
				/>
			</div>
		</div>
	);
});
