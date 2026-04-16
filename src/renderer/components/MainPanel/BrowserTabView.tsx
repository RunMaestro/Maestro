import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, Globe, RotateCw } from 'lucide-react';
import { Spinner } from '../ui/Spinner';
import type { BrowserTab, Theme } from '../../types';
import {
	DEFAULT_BROWSER_TAB_TITLE,
	DEFAULT_BROWSER_TAB_URL,
	getBrowserTabTitle,
	resolveBrowserTabNavigationTarget,
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
	executeJavaScript: (code: string) => Promise<unknown>;
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
	const isDomReadyRef = useRef(false);
	const latestTabRef = useRef(tab);
	const isAddressFocusedRef = useRef(false);
	// Track whether the user explicitly clicked into the webview host area.
	// Used to distinguish intentional focus (user click) from programmatic
	// focus-stealing (page autofocus, window.focus(), etc.).
	const userClickedRef = useRef(false);
	const [addressValue, setAddressValue] = useState(tab.url);
	const [addressError, setAddressError] = useState<string | null>(null);
	const [addressBarHidden, setAddressBarHidden] = useState(false);

	useEffect(() => {
		latestTabRef.current = tab;
	}, [tab]);

	// Prevent webview from stealing host-page focus when pages auto-focus an
	// element (e.g. search box, login form, window.focus()).  If the webview
	// gains focus without a preceding user click inside the host area, blur
	// it immediately so keyboard shortcuts keep flowing through the window
	// handler.  The user can always click the webview to intentionally focus it.
	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const onPointerDown = () => {
			userClickedRef.current = true;
		};
		const onFocusIn = () => {
			if (!userClickedRef.current) {
				// Focus was not user-initiated — push it back out.
				const active = document.activeElement;
				if (active && host.contains(active)) {
					(active as HTMLElement).blur();
				}
			}
			// Reset after each focus event so the next auto-focus is caught.
			userClickedRef.current = false;
		};
		host.addEventListener('pointerdown', onPointerDown, true);
		host.addEventListener('focusin', onFocusIn);
		return () => {
			host.removeEventListener('pointerdown', onPointerDown, true);
			host.removeEventListener('focusin', onFocusIn);
		};
	}, []);

	useEffect(() => {
		if (!isAddressFocusedRef.current) {
			setAddressValue(tab.url);
		}
	}, [tab.id, tab.url]);

	useEffect(() => {
		const webview = webviewRef.current;
		if (!webview) return;
		isDomReadyRef.current = false;

		const updateTabState = (updates: Partial<BrowserTab>) => {
			onUpdateTab(tab.id, updates);
		};

		const readWebviewState = (): Partial<BrowserTab> | null => {
			if (!isDomReadyRef.current) return null;

			const nextUrl = webview.getURL?.() || latestTabRef.current.url || DEFAULT_BROWSER_TAB_URL;
			return {
				url: nextUrl,
				title: getBrowserTabTitle(nextUrl, webview.getTitle?.() || latestTabRef.current.title),
				canGoBack: webview.canGoBack(),
				canGoForward: webview.canGoForward(),
				isLoading: webview.isLoading(),
				webContentsId: webview.getWebContentsId?.(),
			};
		};

		const updateNavigationState = () => {
			const nextState = readWebviewState();
			if (!nextState) return;

			if (!isAddressFocusedRef.current) {
				setAddressValue(nextState.url || DEFAULT_BROWSER_TAB_URL);
			}
			setAddressError(null);
			updateTabState(nextState);
		};

		const handleStartLoading = () => updateTabState({ isLoading: true });
		const handleStopLoading = () => {
			syncWebviewLayout(webview);
			updateNavigationState();
		};
		const handleNavigate = (event: Event) => {
			const nextUrl =
				(event as Event & { url?: string }).url ||
				webview.getURL?.() ||
				latestTabRef.current.url ||
				DEFAULT_BROWSER_TAB_URL;
			if (!isAddressFocusedRef.current) {
				setAddressValue(nextUrl);
			}
			setAddressError(null);
			updateTabState({
				url: nextUrl,
				title: getBrowserTabTitle(nextUrl, latestTabRef.current.title),
			});
			updateNavigationState();
		};
		const handleNavigationStart = (event: Event) => {
			if ((event as Event & { isMainFrame?: boolean }).isMainFrame === false) return;
			const nextUrl =
				(event as Event & { url?: string }).url ||
				webview.getURL?.() ||
				latestTabRef.current.url ||
				DEFAULT_BROWSER_TAB_URL;
			if (!isAddressFocusedRef.current) {
				setAddressValue(nextUrl);
			}
			setAddressError(null);
			updateTabState({
				url: nextUrl,
				title: getBrowserTabTitle(nextUrl),
				isLoading: true,
				favicon: null,
			});
		};
		const handleTitleUpdated = (event: Event) => {
			const nextTitle = getBrowserTabTitle(
				webview.getURL?.() || latestTabRef.current.url,
				(event as Event & { title?: string }).title || webview.getTitle?.()
			);
			updateTabState({ title: nextTitle });
		};
		const handleFaviconUpdated = (event: Event) => {
			const favicons = (event as Event & { favicons?: string[] }).favicons;
			if (!Array.isArray(favicons)) return;
			updateTabState({ favicon: favicons[0] || null });
		};
		const handleDidFailLoad = (event: Event) => {
			if ((event as Event & { isMainFrame?: boolean }).isMainFrame === false) return;
			const nextUrl =
				(event as Event & { validatedURL?: string; url?: string }).validatedURL ||
				(event as Event & { validatedURL?: string; url?: string }).url ||
				webview.getURL?.() ||
				latestTabRef.current.url ||
				DEFAULT_BROWSER_TAB_URL;
			if (!isAddressFocusedRef.current) {
				setAddressValue(nextUrl);
			}
			setAddressError(null);
			updateTabState({
				url: nextUrl,
				title: getBrowserTabTitle(nextUrl),
				canGoBack: isDomReadyRef.current ? webview.canGoBack() : latestTabRef.current.canGoBack,
				canGoForward: isDomReadyRef.current
					? webview.canGoForward()
					: latestTabRef.current.canGoForward,
				isLoading: false,
				webContentsId: webview.getWebContentsId?.(),
			});
		};
		// Scroll-triggered address bar auto-hide: inject a scroll listener into the
		// guest page that reports scroll direction via console.log. When the user
		// scrolls down the address bar collapses; scrolling up or reaching the top
		// reveals it again.
		const scrollInjection = `(function(){
			if(window.__maestroScrollListenerInstalled)return;
			window.__maestroScrollListenerInstalled=true;
			var lastY=window.scrollY,hidden=false,ticking=false;
			window.addEventListener('scroll',function(){
				if(ticking)return;
				ticking=true;
				requestAnimationFrame(function(){
					var y=window.scrollY;
					if(y<=0&&hidden){hidden=false;console.log('__MAESTRO_SCROLL__0');}
					else if(y-lastY>10&&!hidden){hidden=true;console.log('__MAESTRO_SCROLL__1');}
					else if(lastY-y>10&&hidden){hidden=false;console.log('__MAESTRO_SCROLL__0');}
					lastY=y;ticking=false;
				});
			},{passive:true});
		})();`;
		// Capture-phase keyboard interceptor: intercepts app shortcuts
		// BEFORE the page can handle them, then forwards via console.log.
		// Uses stopImmediatePropagation to prevent any other listener
		// (including the main-process-injected bubble-phase one) from
		// double-firing.
		const keyboardInjection = `(function(){
			if(window.__maestroShortcutCaptureInstalled)return;
			window.__maestroShortcutCaptureInstalled=true;
			document.addEventListener('keydown',function(e){
				var hasMod=e.metaKey||e.ctrlKey;
				var hasAlt=e.altKey;
				if(!hasMod&&!hasAlt)return;
				var k=e.key.toLowerCase();
				var te=hasMod&&!hasAlt&&!e.shiftKey&&'acvxzf'.indexOf(k)!==-1;
				var re=hasMod&&!hasAlt&&e.shiftKey&&k==='z';
				if(te||re)return;
				e.preventDefault();
				e.stopImmediatePropagation();
				console.log('__MAESTRO_KEY__'+JSON.stringify({
					key:e.key,code:e.code,
					meta:e.metaKey,control:e.ctrlKey,
					alt:e.altKey,shift:e.shiftKey
				}));
			},true);
		})();`;
		const injectGuestListeners = () => {
			webview.executeJavaScript(scrollInjection).catch(() => {});
			webview.executeJavaScript(keyboardInjection).catch(() => {});
		};
		const handleConsoleMessage = (event: Event) => {
			const msg = (event as Event & { message?: string }).message;
			if (msg === '__MAESTRO_SCROLL__1') setAddressBarHidden(true);
			else if (msg === '__MAESTRO_SCROLL__0') setAddressBarHidden(false);
			// __MAESTRO_KEY__ shortcuts are forwarded by the main process
			// (via before-input-event and console-message → IPC) and handled
			// by the onBrowserTabShortcutKey listener in useMainKeyboardHandler.
		};

		const handleDomReady = () => {
			isDomReadyRef.current = true;
			syncWebviewLayout(webview);
			updateNavigationState();
			setAddressBarHidden(false);
			injectGuestListeners();
		};
		// Re-inject guest listeners on navigation (page JS state resets)
		const handleDidNavigateForInjection = () => injectGuestListeners();
		webview.addEventListener('console-message', handleConsoleMessage);
		webview.addEventListener('did-start-loading', handleStartLoading);
		webview.addEventListener('did-stop-loading', handleStopLoading);
		webview.addEventListener('did-start-navigation', handleNavigationStart);
		webview.addEventListener('did-redirect-navigation', handleNavigationStart);
		webview.addEventListener('did-navigate', handleNavigate);
		webview.addEventListener('did-navigate', handleDidNavigateForInjection);
		webview.addEventListener('did-navigate-in-page', handleNavigate);
		webview.addEventListener('did-fail-load', handleDidFailLoad);
		webview.addEventListener('did-finish-load', updateNavigationState);
		webview.addEventListener('page-title-updated', handleTitleUpdated);
		webview.addEventListener('page-favicon-updated', handleFaviconUpdated);
		webview.addEventListener('dom-ready', handleDomReady);

		const resizeObserver =
			typeof ResizeObserver === 'undefined'
				? null
				: new ResizeObserver(() => syncWebviewLayout(webview));
		if (resizeObserver && hostRef.current) {
			resizeObserver.observe(hostRef.current);
		}

		syncWebviewLayout(webview);

		return () => {
			isDomReadyRef.current = false;
			resizeObserver?.disconnect();
			webview.removeEventListener('console-message', handleConsoleMessage);
			webview.removeEventListener('did-start-loading', handleStartLoading);
			webview.removeEventListener('did-stop-loading', handleStopLoading);
			webview.removeEventListener('did-start-navigation', handleNavigationStart);
			webview.removeEventListener('did-redirect-navigation', handleNavigationStart);
			webview.removeEventListener('did-navigate', handleNavigate);
			webview.removeEventListener('did-navigate', handleDidNavigateForInjection);
			webview.removeEventListener('did-navigate-in-page', handleNavigate);
			webview.removeEventListener('did-fail-load', handleDidFailLoad);
			webview.removeEventListener('did-finish-load', updateNavigationState);
			webview.removeEventListener('page-title-updated', handleTitleUpdated);
			webview.removeEventListener('page-favicon-updated', handleFaviconUpdated);
			webview.removeEventListener('dom-ready', handleDomReady);
		};
	}, [onUpdateTab, tab.id, tab.title, tab.url]);

	const navigateToAddress = useCallback(
		(rawValue: string) => {
			const result = resolveBrowserTabNavigationTarget(rawValue);
			if (result.kind === 'error') {
				setAddressError(result.message);
				return;
			}

			const nextUrl = result.url;
			setAddressValue(nextUrl);
			setAddressError(null);
			onUpdateTab(tab.id, {
				url: nextUrl,
				title:
					nextUrl === DEFAULT_BROWSER_TAB_URL
						? DEFAULT_BROWSER_TAB_TITLE
						: getBrowserTabTitle(nextUrl),
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

	const handleAddressFocus = useCallback((event: React.FocusEvent<HTMLInputElement>) => {
		isAddressFocusedRef.current = true;
		setAddressBarHidden(false);
		event.currentTarget.select();
	}, []);

	const handleAddressBlur = useCallback(() => {
		isAddressFocusedRef.current = false;
	}, []);

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
				className="shrink-0 overflow-hidden"
				style={{
					maxHeight: addressBarHidden ? 0 : 200,
					opacity: addressBarHidden ? 0 : 1,
					transition: 'max-height 0.2s ease-out, opacity 0.15s ease-out',
				}}
			>
				<div
					className="flex items-center gap-2 px-3 py-2 border-b"
					style={{
						backgroundColor: theme.colors.bgSidebar,
						borderColor: theme.colors.border,
					}}
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
						{tab.isLoading ? <Spinner size={16} /> : <RotateCw className="w-4 h-4" />}
					</button>
					<form className="flex-1 min-w-0" onSubmit={handleSubmit}>
						<label className="sr-only" htmlFor={`browser-tab-address-${tab.id}`}>
							Browser URL
						</label>
						<div className="flex flex-col gap-1">
							<div
								className="flex items-center gap-2 rounded-md border px-3 py-1.5"
								style={{
									backgroundColor: theme.colors.bgMain,
									borderColor: theme.colors.border,
								}}
							>
								{tab.favicon ? (
									<img alt="" className="w-4 h-4 shrink-0" src={tab.favicon} />
								) : (
									<Globe className="w-4 h-4 shrink-0" style={{ color: theme.colors.textDim }} />
								)}
								<input
									id={`browser-tab-address-${tab.id}`}
									aria-label="Browser URL"
									aria-invalid={addressError ? 'true' : 'false'}
									value={addressValue}
									onChange={(event) => {
										setAddressValue(event.target.value);
										if (addressError) setAddressError(null);
									}}
									onFocus={handleAddressFocus}
									onBlur={handleAddressBlur}
									className="w-full bg-transparent outline-none text-sm"
									style={{ color: theme.colors.textMain }}
									placeholder="Enter a URL or search term"
								/>
							</div>
							{addressError ? (
								<p role="alert" className="px-1 text-xs" style={{ color: '#f87171' }}>
									{addressError}
								</p>
							) : null}
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
			</div>

			<div ref={hostRef} className="flex-1 min-h-0 overflow-hidden" data-testid="browser-tab-host">
				<webview
					ref={(element) => {
						webviewRef.current = element as unknown as ElectronWebviewElement | null;
					}}
					className="w-full h-full border-0 bg-white"
					partition={tab.partition}
					src={tab.url || DEFAULT_BROWSER_TAB_URL}
				/>
			</div>
		</div>
	);
});
