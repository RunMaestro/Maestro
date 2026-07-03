import React, {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from 'react';
import {
	ArrowLeft,
	ArrowRight,
	ChevronDown,
	ChevronUp,
	ExternalLink,
	Globe,
	RotateCw,
	X,
} from 'lucide-react';
import { Spinner } from '../ui/Spinner';
import type { BrowserTab, Theme } from '../../types';
import {
	DEFAULT_BROWSER_TAB_TITLE,
	DEFAULT_BROWSER_TAB_URL,
	getBrowserTabTitle,
	isHttpBrowserTabUrl,
	resolveBrowserTabNavigationTarget,
} from '../../utils/browserTabPersistence';
import { isWebDesktop } from '../../utils/runtimeContext';

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
	findInPage: (
		text: string,
		options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }
	) => number;
	stopFindInPage: (action: 'clearSelection' | 'keepSelection' | 'activateSelection') => void;
};

interface BrowserTabViewProps {
	tab: BrowserTab;
	theme: Theme;
	onUpdateTab: (tabId: string, updates: Partial<BrowserTab>) => void;
	/**
	 * Whether this browser tab should hold keyboard focus. True only when the tab
	 * is the visible/active view AND no modal/overlay layer is open above it. When
	 * it flips to false the guest <webview> is blurred so the newly-active surface
	 * (file preview, AI input, terminal, or an open modal like the Tab Switcher)
	 * can claim keyboard focus - an Electron <webview> keeps Chromium input focus
	 * on its guest WebContents even after the host element is hidden or covered,
	 * which otherwise strands keystrokes in the webview.
	 */
	isActive?: boolean;
}

export interface BrowserTabViewHandle {
	/**
	 * Extract the rendered text of the currently loaded page.
	 * Waits briefly for dom-ready if the guest is still loading so the value is
	 * non-empty when the caller invokes this immediately after activating a tab.
	 * Returns `""` if the webview cannot be reached or the script throws.
	 */
	getContent(): Promise<string>;
	/** The tabId this view is currently rendering — used for ref-to-tab reconciliation. */
	getTabId(): string;
	/** Open the in-page find bar and focus its input. */
	openFind(): void;
	/** Navigate back in the webview history if possible. No-op otherwise. */
	goBack(): void;
	/** Navigate forward in the webview history if possible. No-op otherwise. */
	goForward(): void;
	/** Move focus into the webview guest content (so arrow keys scroll the page). */
	focusWebview(): void;
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

export const BrowserTabView = React.memo(
	forwardRef<BrowserTabViewHandle, BrowserTabViewProps>(function BrowserTabView(
		{ tab, theme, onUpdateTab, isActive = true },
		ref
	) {
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
		const [findOpen, setFindOpen] = useState(false);
		const [findQuery, setFindQuery] = useState('');
		const [findMatches, setFindMatches] = useState({ active: 0, total: 0 });
		const findInputRef = useRef<HTMLInputElement | null>(null);
		const findRequestIdRef = useRef(0);

		// In the web-desktop browser bundle the Electron <webview> element is inert
		// (no goBack/executeJavaScript host APIs), so it would render a dead pane.
		// Render a placeholder that links out to the page in a real browser tab
		// instead. All the webview-driven effects below no-op because webviewRef
		// stays null when the guest element is never mounted.
		const webDesktop = isWebDesktop();

		useEffect(() => {
			latestTabRef.current = tab;
		}, [tab]);

		// Keep the latest onUpdateTab in a ref so the webview-listener effect below
		// can stay keyed on `tab.id` alone. The parent passes a fresh inline
		// callback every render, and navigation events mutate tab.url/tab.title;
		// if any of those were effect deps, every navigation would tear down and
		// re-register all listeners mid-flight (resetting isDomReadyRef), which
		// stranded the loading spinner and made the tab title oscillate.
		const onUpdateTabRef = useRef(onUpdateTab);
		useEffect(() => {
			onUpdateTabRef.current = onUpdateTab;
		}, [onUpdateTab]);

		useImperativeHandle(
			ref,
			(): BrowserTabViewHandle => ({
				async getContent(): Promise<string> {
					const webview = webviewRef.current;
					if (!webview) return '';
					// Wait up to 2s for dom-ready so extraction works immediately after a
					// tab activation. If the guest is still navigating, we still attempt —
					// Electron's executeJavaScript queues until the page is ready.
					if (!isDomReadyRef.current) {
						const deadline = Date.now() + 2000;
						while (!isDomReadyRef.current && Date.now() < deadline) {
							await new Promise((r) => setTimeout(r, 50));
						}
					}
					try {
						const result = await webview.executeJavaScript(
							'(document.body && document.body.innerText) || ""'
						);
						return typeof result === 'string' ? result : '';
					} catch {
						return '';
					}
				},
				getTabId(): string {
					return latestTabRef.current.id;
				},
				openFind(): void {
					// State flip; the focus call lives in a useEffect keyed on
					// `findOpen` so it runs after React commits the input to the DOM
					// (requestAnimationFrame fired before commit in practice).
					setFindOpen(true);
				},
				goBack(): void {
					const webview = webviewRef.current;
					if (webview?.canGoBack()) webview.goBack();
				},
				goForward(): void {
					const webview = webviewRef.current;
					if (webview?.canGoForward()) webview.goForward();
				},
				focusWebview(): void {
					// Mark the focus as user-initiated so the host's focus-stealing
					// guard does not immediately blur the webview back out.
					userClickedRef.current = true;
					webviewRef.current?.focus();
				},
			}),
			[]
		);

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
					// Focus was not user-initiated — push it back out, but leave the
					// find-bar input alone (Cmd+F intentionally focuses it
					// programmatically, and that is exactly the case this guard
					// would otherwise mistakenly reject).
					const active = document.activeElement;
					const isFindInput = active === findInputRef.current;
					if (active && host.contains(active) && !isFindInput) {
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

		// Release keyboard focus from the guest webview whenever this tab stops
		// being the active view. visibility:hidden on the host overlay is not
		// enough: an Electron <webview> keeps Chromium input focus on its guest
		// WebContents, so without an explicit blur a switch to a file/AI/terminal
		// tab leaves keystrokes routed into the (now hidden) page. Blurring lets
		// the destination view's own focus call land. Reset the user-click guard
		// so a fresh activation is treated as a clean slate.
		useEffect(() => {
			if (isActive) return;
			const host = hostRef.current;
			const active = document.activeElement;
			if (host && active && host.contains(active)) {
				(active as HTMLElement).blur();
			}
			webviewRef.current?.blur();
			userClickedRef.current = false;
		}, [isActive]);

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
				onUpdateTabRef.current(latestTabRef.current.id, updates);
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
			// `f` and `v` are intentionally NOT in the text-editing pass-through
			// list. Cmd+F must reach the app so the in-page find bar can open, and
			// Cmd/Ctrl+V is handled separately via the privileged paste path
			// (guest.paste()) so paste works inside the webview. The remaining
			// letters (a/c/x/z) keep their native text-editing behavior inside
			// page inputs.
			const keyboardInjection = `(function(){
			if(window.__maestroShortcutCaptureInstalled)return;
			window.__maestroShortcutCaptureInstalled=true;
			document.addEventListener('keydown',function(e){
				var hasMod=e.metaKey||e.ctrlKey;
				var hasAlt=e.altKey;
				if(!hasMod&&!hasAlt)return;
				var k=e.key.toLowerCase();
				var te=hasMod&&!hasAlt&&!e.shiftKey&&'acxz'.indexOf(k)!==-1;
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
			// Find-in-page result reporting. Chromium fires `found-in-page` with
			// `requestId`, `activeMatchOrdinal`, and `matches`. Stale results from a
			// prior query can arrive after a newer findInPage() call; we ignore them
			// by comparing against the latest requestId we issued.
			const handleFoundInPage = (event: Event) => {
				const result = (
					event as Event & {
						result?: { requestId?: number; activeMatchOrdinal?: number; matches?: number };
					}
				).result;
				if (!result) return;
				if (typeof result.requestId === 'number' && result.requestId < findRequestIdRef.current)
					return;
				setFindMatches({
					active: result.activeMatchOrdinal ?? 0,
					total: result.matches ?? 0,
				});
			};
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
			webview.addEventListener('found-in-page', handleFoundInPage);

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
				webview.removeEventListener('found-in-page', handleFoundInPage);
			};
		}, [tab.id]);

		// Focus the find-bar input whenever it opens. Runs after React commits
		// the input to the DOM. We focus three times across two animation
		// frames: once synchronously, and once per frame after, to outlast any
		// stray focus-stealing on the same tick (host-level guards, page
		// autofocus that bounces off the recently-blurred webview, etc.).
		useEffect(() => {
			if (!findOpen) return;
			const focusInput = () => {
				const el = findInputRef.current;
				if (!el) return;
				el.focus();
				el.select();
			};
			focusInput();
			let frame2 = 0;
			const frame1 = requestAnimationFrame(() => {
				focusInput();
				frame2 = requestAnimationFrame(focusInput);
			});
			return () => {
				cancelAnimationFrame(frame1);
				if (frame2) cancelAnimationFrame(frame2);
			};
		}, [findOpen]);

		// Drive findInPage / stopFindInPage off the find-bar state.
		// Each query change starts a fresh search; an empty query clears highlights.
		useEffect(() => {
			const webview = webviewRef.current;
			if (!webview) return;
			if (!findOpen || findQuery.length === 0) {
				try {
					webview.stopFindInPage('clearSelection');
				} catch {
					// webview not ready or already stopped
				}
				if (!findOpen) setFindMatches({ active: 0, total: 0 });
				return;
			}
			try {
				findRequestIdRef.current = webview.findInPage(findQuery);
			} catch {
				// webview not ready
			}
		}, [findOpen, findQuery]);

		// Stop find when navigating away (page-level state is gone anyway, but this
		// also prevents leftover match counts from a previous page from being shown).
		useEffect(() => {
			if (!findOpen) return;
			setFindMatches({ active: 0, total: 0 });
		}, [tab.url, findOpen]);

		const handleFindNext = useCallback(
			(forward: boolean) => {
				const webview = webviewRef.current;
				if (!webview || findQuery.length === 0) return;
				try {
					findRequestIdRef.current = webview.findInPage(findQuery, { forward, findNext: true });
				} catch {
					// webview not ready
				}
			},
			[findQuery]
		);

		const closeFind = useCallback(() => {
			setFindOpen(false);
			setFindQuery('');
		}, []);

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
										onKeyDown={(event) => {
											if (event.key === 'Escape') {
												// Revert any edits, then hand focus to the webview so
												// the user can immediately use arrow keys to scroll.
												event.preventDefault();
												event.stopPropagation();
												setAddressValue(latestTabRef.current.url);
												setAddressError(null);
												event.currentTarget.blur();
												userClickedRef.current = true;
												webviewRef.current?.focus();
											}
										}}
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

				<div
					ref={hostRef}
					className="relative flex-1 min-h-0 overflow-hidden"
					data-testid="browser-tab-host"
				>
					{webDesktop ? (
						<div
							className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center"
							data-testid="browser-tab-web-placeholder"
						>
							<Globe className="w-8 h-8" style={{ color: theme.colors.textDim }} />
							{/* Only linkify http(s) URLs. Skipping other schemes keeps a
							    `javascript:`/`data:` href (XSS on click) from ever rendering,
							    and noreferrer avoids leaking the token-bearing app URL. */}
							{isHttpBrowserTabUrl(tab.url) ? (
								<a
									href={tab.url}
									target="_blank"
									rel="noopener noreferrer"
									className="text-sm underline break-all"
									style={{ color: theme.colors.accent }}
								>
									{tab.url}
								</a>
							) : null}
							<p className="text-sm" style={{ color: theme.colors.textDim }}>
								Browser tabs are available in the desktop app
							</p>
						</div>
					) : (
						<webview
							ref={(element) => {
								webviewRef.current = element as unknown as ElectronWebviewElement | null;
							}}
							className="w-full h-full border-0 bg-white"
							partition={tab.partition}
							src={tab.url || DEFAULT_BROWSER_TAB_URL}
						/>
					)}
					{findOpen ? (
						<div
							className="absolute top-2 right-3 z-10 flex items-center gap-1 rounded-md border px-2 py-1 shadow-md"
							style={{
								backgroundColor: theme.colors.bgMain,
								borderColor: theme.colors.border,
							}}
							data-testid="browser-tab-find-bar"
							role="search"
						>
							<input
								ref={findInputRef}
								type="text"
								aria-label="Find in page"
								value={findQuery}
								onChange={(event) => setFindQuery(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === 'Escape') {
										event.preventDefault();
										event.stopPropagation();
										closeFind();
									} else if (event.key === 'Enter') {
										event.preventDefault();
										event.stopPropagation();
										handleFindNext(!event.shiftKey);
									} else if (
										event.key === 'g' &&
										(event.metaKey || event.ctrlKey) &&
										!event.altKey
									) {
										// Cmd+G / Cmd+Shift+G — next/prev match (standard browser shortcut)
										event.preventDefault();
										event.stopPropagation();
										handleFindNext(!event.shiftKey);
									} else if (
										event.key === 'f' &&
										(event.metaKey || event.ctrlKey) &&
										!event.altKey &&
										!event.shiftKey
									) {
										// Cmd+F while find bar is open — re-focus and select the query
										event.preventDefault();
										event.stopPropagation();
										event.currentTarget.select();
									}
								}}
								className="bg-transparent outline-none text-sm min-w-[180px]"
								style={{ color: theme.colors.textMain }}
								placeholder="Find in page"
							/>
							<span
								className="text-xs tabular-nums px-1"
								style={{ color: theme.colors.textDim }}
								aria-live="polite"
							>
								{findQuery.length === 0
									? ''
									: findMatches.total === 0
										? '0/0'
										: `${findMatches.active}/${findMatches.total}`}
							</span>
							<button
								type="button"
								onClick={() => handleFindNext(false)}
								disabled={findMatches.total === 0}
								className="flex items-center justify-center w-6 h-6 rounded transition-colors disabled:opacity-40"
								style={{ color: theme.colors.textMain }}
								title="Previous match (Shift+Enter)"
								aria-label="Previous match"
							>
								<ChevronUp className="w-4 h-4" />
							</button>
							<button
								type="button"
								onClick={() => handleFindNext(true)}
								disabled={findMatches.total === 0}
								className="flex items-center justify-center w-6 h-6 rounded transition-colors disabled:opacity-40"
								style={{ color: theme.colors.textMain }}
								title="Next match (Enter)"
								aria-label="Next match"
							>
								<ChevronDown className="w-4 h-4" />
							</button>
							<button
								type="button"
								onClick={closeFind}
								className="flex items-center justify-center w-6 h-6 rounded transition-colors"
								style={{ color: theme.colors.textMain }}
								title="Close (Esc)"
								aria-label="Close find bar"
							>
								<X className="w-4 h-4" />
							</button>
						</div>
					) : null}
				</div>
			</div>
		);
	})
);
